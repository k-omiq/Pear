// ===== Keyboard shortcut registry =====
// One list of every shortcut the editor answers to, one way of writing a key
// combination down, one place that turns a KeyboardEvent into the action it
// means. Before this, the combos lived as a ladder of `if (e.key === 'v')`
// inside App.svelte's keydown handler: nothing could list them, nothing could
// rebind them, and two of them could collide without anybody noticing.
//
// A combo is a canonical string - modifiers in a fixed order, then the key:
//
//   'Mod+1'          'Mod+Shift+c'      'Mod+Alt+3'      'Delete'
//
// `Mod` is the platform's command modifier: ⌘ on a Mac, Ctrl everywhere else.
// That is the whole reason the token exists - a shortcut is written once and
// means the key a user of that platform expects. `Ctrl` (on a Mac) and `Meta`
// (off one) name the *other* one, for a user who rebinds onto it deliberately.
//
// The key half comes from `event.code` where the code names a physical key, so
// Alt combos survive macOS turning Alt+A into 'å', and Shift+1 stays '1'
// rather than becoming '!'. Named keys (Escape, Delete, ArrowLeft) keep their
// `event.key` spelling. The keypad is spelled as the keys it is - 'Numpad3',
// not the top-row '3' its legend happens to emit - so a rebind onto one never
// fires from the other.
//
// What is NOT here: Escape, Tab, and the arrow keys. All three are contextual
// rather than nominal - Escape closes whatever is topmost, Tab walks the
// selection only when focus is on the canvas, and an arrow nudges the selected
// box or turns the page depending on whether anything is selected. They are not
// actions with a combo, they are one key with several meanings, and a rebind
// screen that offered them would be lying about what it could change.
// The one exception is a key heard in one place only - the typing pane's
// Enter, Tab and Escape (`ctx` below): there the key has one meaning, so it
// rebinds like any other.
import { prefs, setPref, isComics } from './prefs.svelte.js';

// ---------- platform ----------
function detectMac() {
  if (typeof navigator === 'undefined') return false;
  const s = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  return /Mac|iPhone|iPad|iPod/i.test(s);
}
let MAC = detectMac();
export const isMacKeyboard = () => MAC;
// Tests run under node, where there is no navigator to ask; a build running in
// a webview that misreports itself can be corrected the same way.
export function setMacKeyboard(v) {
  MAC = !!v;
}

// ---------- combo parsing ----------
// Punctuation and space, by the physical key that carries them on a US layout.
// Anything not in here falls back to `event.key`, which is right for every
// named key and acceptable for the rest.
const CODE_KEYS = {
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
};
// The keypad's operator keys have no punctuation spelling worth borrowing -
// their `event.key` varies by layout - so they are named by their codes.
const NUMPAD_KEYS = {
  NumpadAdd: 'NumpadAdd',
  NumpadSubtract: 'NumpadSubtract',
  NumpadMultiply: 'NumpadMultiply',
  NumpadDivide: 'NumpadDivide',
  NumpadDecimal: 'NumpadDecimal',
};
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

// The key half of a combo, as this module spells it. Null for a press that is
// only a modifier - the rebind capture uses that to keep waiting.
export function eventKeyName(e) {
  const code = e?.code ?? '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  // The physical keypad, distinct from the digit row it sits beside.
  if (/^Numpad\d$/.test(code)) return code;
  const k = e?.key;
  // A dead key is waiting for its base letter; it produces no character yet,
  // and must be checked before the code table or a dead Backquote would read
  // as '`'.
  if (k === 'Dead') return null;
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  if (NUMPAD_KEYS[code]) return NUMPAD_KEYS[code];
  if (!k) return null;
  if (MODIFIER_KEYS.has(k)) return null;
  if (k === ' ') return 'Space';
  return k.length === 1 ? k.toLowerCase() : k;
}

// A modifier set, in the one order every combo string is written in.
function join(mods, key) {
  const parts = [];
  if (mods.mod) parts.push('Mod');
  if (mods.other) parts.push(MAC ? 'Ctrl' : 'Meta');
  if (mods.alt) parts.push('Alt');
  if (mods.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

// AltGr (the right-hand Alt on Windows/Linux) reports itself as Ctrl+Alt.
// Typing one of its characters - é, µ, @ on a German layout - must never be
// read as Mod+Alt+key, or the shortcut system would eat characters people are
// typing. Only asked off a Mac, where AltGr does not exist.
export const isAltGrEvent = (e) =>
  !MAC && typeof e?.getModifierState === 'function' && e.getModifierState('AltGraph');

// The combo a keypress spells. Null when the press is only a modifier.
export function eventCombo(e) {
  const key = eventKeyName(e);
  if (key == null) return null;
  // An AltGr press drops the Mod half: it reads as plain Alt+key, which no
  // default shortcut holds, so the character reaches the page untouched.
  const altgr = isAltGrEvent(e);
  return join(
    {
      mod: altgr ? false : MAC ? !!e.metaKey : !!e.ctrlKey,
      other: MAC ? !!e.ctrlKey : !!e.metaKey,
      alt: !!e.altKey,
      shift: !!e.shiftKey,
    },
    key,
  );
}

// Every multi-character name eventKeyName can produce, spelled exactly as it
// spells them: `event.key` names for the non-printing keys, the keypad by its
// codes. Hand-written combos are matched against this case-insensitively;
// anything else is rejected rather than stored as an override that persists
// but can never fire.
const NAMED_KEYS = [
  'Escape', 'Tab', 'Enter', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'PrintScreen', 'ScrollLock', 'Pause', 'NumLock', 'ContextMenu',
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide',
  'NumpadDecimal', // keypad Enter reads as Enter, so it needs no name of its own
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  'Space',
];
const NAMED_KEY_SPELLINGS = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));

function canonKeyName(key) {
  if (key.length === 1) return key.toLowerCase();
  return NAMED_KEY_SPELLINGS.get(key.toLowerCase()) ?? null;
}

// Put a hand-written combo into canonical form so two spellings of the same
// keypress compare equal. Unknown modifier names are dropped rather than
// guessed at; an empty key half means the string was not a combo at all, and
// so is a key half no keypress can produce.
export function normalizeCombo(combo) {
  if (typeof combo !== 'string') return null;
  const raw = combo.trim();
  if (!raw) return null;
  // Split on '+' but keep a literal '+' key ('Mod++' is Mod plus the plus key).
  const bits = raw.split('+');
  if (raw.endsWith('+') && bits[bits.length - 1] === '') {
    bits.pop();
    bits[bits.length - 1] = '+';
  }
  const mods = { mod: false, other: false, alt: false, shift: false };
  let key = null;
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i].trim();
    if (!b) continue;
    const low = b.toLowerCase();
    const last = i === bits.length - 1;
    if (!last || bits.length === 1) {
      if (low === 'mod' || low === 'cmdorctrl') { mods.mod = true; continue; }
      if (low === 'ctrl' || low === 'control') { MAC ? (mods.other = true) : (mods.mod = true); continue; }
      if (low === 'meta' || low === 'cmd' || low === 'command') { MAC ? (mods.mod = true) : (mods.other = true); continue; }
      if (low === 'alt' || low === 'option' || low === 'opt') { mods.alt = true; continue; }
      if (low === 'shift') { mods.shift = true; continue; }
      if (!last) return null; // an unknown modifier is not a combo we can honour
    }
    key = b.length === 1 ? b.toLowerCase() : b === ' ' ? 'Space' : b;
  }
  if (!key) return null;
  const canon = canonKeyName(key);
  if (!canon) return null;
  return join(mods, canon);
}

export const combosEqual = (a, b) => {
  const x = normalizeCombo(a);
  return !!x && x === normalizeCombo(b);
};

export const matchesCombo = (e, combo) => {
  const c = eventCombo(e);
  return !!c && c === normalizeCombo(combo);
};

// What a keypress means while a row on the settings screen waits to be
// rebound. 'pass' hands the press to the rest of the app untouched - an IME
// mid-composition, an AltGr character; swallowing those would eat text.
// 'wait' keeps waiting without swallowing (a lone modifier is the first half
// of a combo, not one). 'cancel' and 'bind' are the press doing its job and
// are stopped where they stand.
export function captureAction(e) {
  if (e.isComposing || e.keyCode === 229) return { act: 'pass' };
  const withModifier = !!e.metaKey || !!e.ctrlKey || !!e.altKey || !!e.shiftKey;
  if (!withModifier && e.key === 'Escape') return { act: 'cancel' };
  if (isAltGrEvent(e)) return { act: 'pass' };
  const combo = eventCombo(e);
  if (!combo) return { act: 'wait' };
  return { act: 'bind', combo };
}

// ---------- display ----------
const KEY_LABELS = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  Backspace: '⌫',
  Delete: 'Del',
  Enter: '↵',
  Space: 'Space',
  Tab: 'Tab',
  NumpadAdd: 'Num+',
  NumpadSubtract: 'Num−',
  NumpadMultiply: 'Num×',
  NumpadDivide: 'Num÷',
  NumpadDecimal: 'Num.',
};
for (let i = 0; i <= 9; i++) KEY_LABELS[`Numpad${i}`] = `Num${i}`;
const MOD_LABELS_MAC = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
// Off a Mac, `Mod` is Ctrl and `Meta` is the key with the vendor's logo on it.
// Both are spelled out: there is no glyph convention to lean on.
const MOD_LABELS = { Mod: 'Ctrl', Meta: 'Meta', Alt: 'Alt', Shift: 'Shift' };

// How the combo is shown to a person: ⌘⇧C on a Mac, Ctrl+Shift+C elsewhere.
export function formatCombo(combo) {
  const c = normalizeCombo(combo);
  if (!c) return '';
  const bits = c.split('+');
  const key = bits.pop();
  const label = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (MAC) return bits.map((m) => MOD_LABELS_MAC[m] ?? m).join('') + label;
  return [...bits.map((m) => MOD_LABELS[m] ?? m), label].join('+');
}

// ---------- the registry ----------
// Every action the editor can run by name, keyed or not. Most have no default
// key (`combo: null`): the Shortcuts screen lists them all, and the user binds
// the ones they want. Ids are stored in the user's overrides, so an id never
// changes once shipped; the label is free to.
//
// Fields:
//   group       the Shortcuts tab it is listed under.
//   keywords    words someone might search for that the label does not hold.
//   whenTyping  still fires while the caret is in a text field. A bound combo
//               that would type there (`comboTypes`) is given back to the
//               field anyway. Undo is not one - a field runs its own undo -
//               and neither is Delete, which would eat the box being typed in.
//   altOf       a second key for another action: drawn on that action's row.
//   ctx         where a key is heard, for keys a component listens for itself
//               (the typing pane): 'field' is the caret in a line's field,
//               'row' is focus on a row or the page. Only keys heard in the
//               same place can clash; a key with no ctx clashes with all.
//   inField     the pane takes the key before the field types it, so it may
//               not be a bare letter.
//   yields      a key heard everywhere that gives way where it is named
//               ('row'): that component hears the press first and takes it,
//               so its own key of the same combo is no clash. Delete is the
//               box's on the page and the line's on a focused row.
const T = { whenTyping: true };
const DEFS = [
  // Tools. The digits count down the tool rail in the order it draws them.
  // There is no hand to pick: it is held (Space, or the middle button).
  { id: 'tool.place', label: 'Place tool', group: 'Tools', combo: 'Mod+1', keywords: 'paste queued line', ...T },
  { id: 'tool.text', label: 'Text tool', group: 'Tools', combo: 'Mod+2', keywords: 'new box add', ...T },
  { id: 'tool.brush', label: 'Brush tool', group: 'Tools', combo: 'Mod+3', keywords: 'hand letter draw', ...T },

  // Edit. Copy and paste box are not live while typing: in a field, Mod+C and
  // Mod+V are the field's own.
  { id: 'edit.undo', label: 'Undo', group: 'Edit', combo: 'Mod+z', keywords: 'back history' },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', combo: 'Mod+Shift+z', keywords: 'history' },
  { id: 'edit.redoAlt', label: 'Redo', group: 'Edit', combo: 'Mod+y', altOf: 'edit.redo' },
  { id: 'box.copy', label: 'Copy box', group: 'Edit', combo: 'Mod+c' },
  { id: 'box.paste', label: 'Paste box', group: 'Edit', combo: 'Mod+v' },
  { id: 'box.duplicate', label: 'Duplicate box', group: 'Edit', combo: 'Mod+d', keywords: 'clone copy', ...T },
  { id: 'box.delete', label: 'Delete box', group: 'Edit', combo: 'Delete', keywords: 'remove', yields: 'row' },
  { id: 'box.deleteAlt', label: 'Delete box', group: 'Edit', combo: 'Backspace', altOf: 'box.delete', yields: 'row' },

  // Text: the selected box's type. Bigger and smaller are Photoshop's keys;
  // in Fit to box they step the most the fit may grow to.
  { id: 'box.sizeUp', label: 'Bigger text', group: 'Text', combo: 'Mod+Shift+.', keywords: 'size font larger increase', ...T },
  { id: 'box.sizeDown', label: 'Smaller text', group: 'Text', combo: 'Mod+Shift+,', keywords: 'size font reduce decrease', ...T },
  { id: 'text.bold', label: 'Bold', group: 'Text', combo: 'Mod+b', keywords: 'weight selected words', ...T },
  { id: 'text.italic', label: 'Italic', group: 'Text', combo: 'Mod+i', keywords: 'slant oblique selected words', ...T },
  { id: 'text.typeface', label: 'Typeface…', group: 'Text', combo: null, keywords: 'font family selected words', ...T },
  { id: 'text.clearFace', label: 'Clear typeface', group: 'Text', combo: null, keywords: 'regular plain reset font selected words', ...T },
  { id: 'text.uppercase', label: 'All caps', group: 'Text', combo: null, keywords: 'uppercase capitals', ...T },
  { id: 'text.alignLeft', label: 'Align left', group: 'Text', combo: null, keywords: 'justify', ...T },
  { id: 'text.alignCenter', label: 'Align centre', group: 'Text', combo: null, keywords: 'justify center middle', ...T },
  { id: 'text.alignRight', label: 'Align right', group: 'Text', combo: null, keywords: 'justify', ...T },
  { id: 'text.alignTop', label: 'Align top', group: 'Text', combo: null, keywords: 'vertical', ...T },
  { id: 'text.alignMiddle', label: 'Align middle', group: 'Text', combo: null, keywords: 'vertical centre center', ...T },
  { id: 'text.alignBottom', label: 'Align bottom', group: 'Text', combo: null, keywords: 'vertical', ...T },

  // Box: the selected box as a whole.
  { id: 'box.layoutLock', label: 'Lock or unlock box', group: 'Box', combo: 'Mod+Alt+l', keywords: 'freeze padlock', ...T },
  { id: 'box.resetRotation', label: 'Straighten', group: 'Box', combo: 'Mod+0', keywords: 'rotation reset angle 0', ...T },
  { id: 'box.rotateLeft', label: 'Rotate 90° left', group: 'Box', combo: null, keywords: 'turn angle anticlockwise', ...T },
  { id: 'box.rotateRight', label: 'Rotate 90° right', group: 'Box', combo: null, keywords: 'turn angle clockwise', ...T },
  { id: 'box.flipH', label: 'Flip horizontal', group: 'Box', combo: null, keywords: 'mirror', ...T },
  { id: 'box.flipV', label: 'Flip vertical', group: 'Box', combo: null, keywords: 'mirror upside down', ...T },
  { id: 'style.copy', label: 'Copy style', group: 'Box', combo: 'Mod+Shift+c', keywords: 'format look', ...T },
  { id: 'style.paste', label: 'Paste style', group: 'Box', combo: 'Mod+Shift+v', keywords: 'format look apply', ...T },
  { id: 'tag.reset', label: 'Reset to tag style', group: 'Box', combo: null, keywords: 'tag default revert', ...T },
  { id: 'tag.save', label: 'Save as tag style', group: 'Box', combo: null, keywords: 'tag default remember', ...T },
  { id: 'tag.applyChapter', label: 'Apply tag style to chapter', group: 'Box', combo: null, keywords: 'tag restyle all boxes', ...T },
  { id: 'pattern.pick', label: 'Pick pattern from page', group: 'Box', combo: null, keywords: 'tone screentone texture fill sample', ...T },
  { id: 'fx.warp', label: 'Warp on or off', group: 'Box', combo: null, keywords: 'effect bend arc', ...T },
  { id: 'fx.motionBlur', label: 'Motion blur on or off', group: 'Box', combo: null, keywords: 'effect speed', ...T },
  { id: 'fx.roughen', label: 'Rough edges on or off', group: 'Box', combo: null, keywords: 'effect roughen grit', ...T },
  { id: 'fx.wobble', label: 'Wobble', group: 'Box', combo: null, keywords: 'shake shaky bounce jitter letters', ...T },
  { id: 'fx.fade', label: 'Fade on or off', group: 'Box', combo: null, keywords: 'opacity transparent regional', ...T },
  { id: 'box.snugWidth', label: 'Shrink box to text', group: 'Box', combo: 'Mod+Alt+w', keywords: 'narrow tighten width fit hug empty space', ...T },
  { id: 'page.snugWidths', label: 'Shrink all boxes on page to text', group: 'Box', combo: 'Mod+Alt+Shift+w', keywords: 'narrow tighten width fit hug empty space every', ...T },
  { id: 'box.showInQueue', label: 'Show in text queue', group: 'Box', combo: null, keywords: 'line find', ...T },
  { id: 'bulk.open', label: 'Bulk style', group: 'Box', combo: null, keywords: 'many boxes batch', ...T },

  // Bubble: the outline a box is fitted to. Refit is beside the fit switch -
  // one turns bubble layout on and off, the other finds the bubble again.
  { id: 'box.fitBalloon', label: 'Fit to bubble on or off', group: 'Bubble', combo: 'Mod+Shift+f', keywords: 'balloon auto', ...T },
  { id: 'box.retypeset', label: 'Redetect bubble and refit', group: 'Bubble', combo: 'Mod+Alt+f', keywords: 'balloon outline find again typeset', ...T },
  { id: 'bubble.centre', label: 'Centre in bubble', group: 'Bubble', combo: null, keywords: 'center middle outline move', ...T },
  { id: 'mask.clipToBubble', label: 'Clip to bubble', group: 'Bubble', combo: null, keywords: 'mask keep inside outline cut', ...T },
  { id: 'bubble.outlineToBox', label: 'Use box as outline', group: 'Bubble', combo: null, keywords: 'outline rectangle free text', ...T },
  { id: 'box.approveOutline', label: 'Approve outline', group: 'Bubble', combo: 'Mod+Alt+a', keywords: 'ok check', ...T },
  { id: 'bubble.approvePage', label: 'Approve all outlines on page', group: 'Bubble', combo: null, keywords: 'ok check every', ...T },
  { id: 'view.regions', label: 'Show or hide regions', group: 'Bubble', combo: 'Mod+Alt+r', keywords: 'outlines detected text line numbers', ...T },

  // Pages and view. Plain arrows turn the page too (see Fixed keys).
  { id: 'page.next', label: 'Next page', group: 'View', combo: null, keywords: 'turn forward', ...T },
  { id: 'page.prev', label: 'Previous page', group: 'View', combo: null, keywords: 'turn back', ...T },
  { id: 'page.nextWork', label: 'Next page with work', group: 'View', combo: null, keywords: 'todo unfinished unplaced', ...T },
  { id: 'review.next', label: 'Next to check', group: 'View', combo: 'Mod+j', keywords: 'review overflow problems flagged', ...T },
  { id: 'view.zoomIn', label: 'Zoom in', group: 'View', combo: null, keywords: 'bigger magnify', ...T },
  { id: 'view.zoomOut', label: 'Zoom out', group: 'View', combo: null, keywords: 'smaller', ...T },
  { id: 'view.zoomActual', label: 'Zoom to 100%', group: 'View', combo: null, keywords: 'actual size reset', ...T },
  { id: 'view.fit', label: 'Fit page to window', group: 'View', combo: null, keywords: 'zoom whole', ...T },
  { id: 'view.raw', label: 'Show or hide raw page', group: 'View', combo: null, keywords: 'compare original reference sidebar japanese', ...T },

  // Panels, and the Inspector's tabs.
  { id: 'panel.options', label: 'Show or hide box options', group: 'Panels', combo: null, keywords: 'inspector window', ...T },
  { id: 'panel.queue', label: 'Show or hide text queue', group: 'Panels', combo: null, keywords: 'lines window', ...T },
  { id: 'panel.ai', label: 'Show or hide AI panel', group: 'Panels', combo: null, keywords: 'claude chat agent assistant', ...T },
  { id: 'inspector.tabNext', label: 'Next options tab', group: 'Panels', combo: 'Mod+]', keywords: 'inspector', ...T },
  { id: 'inspector.tabPrev', label: 'Previous options tab', group: 'Panels', combo: 'Mod+[', keywords: 'inspector', ...T },
  { id: 'inspector.tabText', label: 'Text tab', group: 'Panels', combo: 'Mod+Alt+1', keywords: 'inspector options', ...T },
  { id: 'inspector.tabFill', label: 'Fill tab', group: 'Panels', combo: 'Mod+Alt+2', keywords: 'inspector options colour color', ...T },
  { id: 'inspector.tabEffects', label: 'Effects tab', group: 'Panels', combo: 'Mod+Alt+3', keywords: 'inspector options stroke shadow', ...T },
  { id: 'inspector.tabLayout', label: 'Layout tab', group: 'Panels', combo: 'Mod+Alt+4', keywords: 'inspector options', ...T },

  // Detect and place. Placing on the whole chapter has no default key: it
  // writes boxes onto pages the user is not looking at.
  { id: 'detect.page', label: 'Detect text on this page', group: 'Detect', combo: null, keywords: 'ocr scan read find', ...T },
  { id: 'detect.chapter', label: 'Detect text in chapter', group: 'Detect', combo: null, keywords: 'ocr scan read find all pages', ...T },
  { id: 'queue.placeDetected', label: 'Place bubbles on this page', group: 'Detect', combo: 'Mod+Shift+p', keywords: 'detected queue', ...T },
  { id: 'queue.placeChapter', label: 'Place bubbles in chapter', group: 'Detect', combo: null, keywords: 'detected queue all pages', ...T },
  { id: 'jobs.retry', label: 'Retry failed pages', group: 'Detect', combo: null, keywords: 'again errors jobs', ...T },
  { id: 'ocr.draw', label: 'Draw a character to read it', group: 'Detect', combo: null, keywords: 'kanji handwriting look up unknown', ...T },

  // A translate chapter. Alt rather than Mod for the field keys: Mod+letter
  // there is the field's own (select all, undo). On a Mac Option+letter would
  // type a character, so the pane takes the press first. Not Option+N/E/U/I:
  // those are dead keys.
  { id: 'translate.typesetTools', label: 'Show or hide typesetting tools', group: 'Translate', combo: 'Mod+Shift+t', ...T },
  { id: 'translate.cleaned', label: 'Show cleaned or raw page', group: 'Translate', combo: null, keywords: 'original', ...T },
  { id: 'translate.next', label: 'Next line', group: 'Translate', combo: 'Enter', ctx: 'field', inField: true },
  { id: 'translate.nextAlt', label: 'Next line', group: 'Translate', combo: 'Tab', ctx: 'field', inField: true, altOf: 'translate.next' },
  { id: 'translate.prev', label: 'Previous line', group: 'Translate', combo: 'Shift+Tab', ctx: 'field', inField: true },
  { id: 'translate.leave', label: 'Leave the field', group: 'Translate', combo: 'Escape', ctx: 'field', inField: true },
  { id: 'translate.lineDown', label: 'Next line', group: 'Translate', combo: 'ArrowDown', ctx: 'row' },
  { id: 'translate.lineUp', label: 'Previous line', group: 'Translate', combo: 'ArrowUp', ctx: 'row' },
  { id: 'translate.edit', label: 'Type in the line', group: 'Translate', combo: 'Enter', ctx: 'row' },
  { id: 'translate.pageNext', label: 'Next page', group: 'Translate', combo: 'ArrowRight', ctx: 'row' },
  { id: 'translate.pagePrev', label: 'Previous page', group: 'Translate', combo: 'ArrowLeft', ctx: 'row' },
  // A row of the typing pane with focus on the row itself, never in a field:
  // in a field these keys edit the text.
  { id: 'line.delete', label: 'Delete line', group: 'Translate', combo: 'Delete', ctx: 'row', keywords: 'remove row' },
  { id: 'line.deleteAlt', label: 'Delete line', group: 'Translate', combo: 'Backspace', ctx: 'row', altOf: 'line.delete' },
  { id: 'line.drawBox', label: 'Draw line’s box on page', group: 'Translate', combo: null, keywords: 'place mark rectangle redraw', ...T },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `translate.tag${i + 1}`,
    label: `Tag ${i + 1} on or off`,
    group: 'Translate',
    combo: `Alt+${i + 1}`,
    inField: true,
  })),
  { id: 'translate.tagPicker', label: 'Find or add a tag', group: 'Translate', combo: 'Alt+t', inField: true },
  { id: 'translate.clearTags', label: 'Clear the line’s tags', group: 'Translate', combo: 'Alt+0', inField: true },
  { id: 'translate.speaker', label: 'Choose the speaker', group: 'Translate', combo: 'Alt+s', inField: true },
  { id: 'translate.source', label: 'Edit the source text', group: 'Translate', combo: 'Alt+r', inField: true },
  { id: 'translate.note', label: 'Page note', group: 'Translate', combo: 'Alt+p', inField: true },

  // App. The palette is live while typing: the caret is nearly always in a
  // field, and the palette is how a key nobody remembers gets found.
  { id: 'palette.open', label: 'Command palette', group: 'App', combo: 'Mod+k', keywords: 'search run find action', ...T },
  { id: 'chapter.export', label: 'Export', group: 'App', combo: null, keywords: 'save png psd zip pages images', ...T },
  { id: 'chapter.saveJson', label: 'Save text as JSON', group: 'App', combo: null, keywords: 'export translation', ...T },
  { id: 'fonts.open', label: 'Font library', group: 'App', combo: null, keywords: 'fonts typeface add load', ...T },
  { id: 'app.back', label: 'Back to the project', group: 'App', combo: null, keywords: 'home library close chapter leave', ...T },
  ...[
    ['general', 'General', 'theme appearance library folder panels'],
    ['typesetting', 'Typesetting', 'auto height line breaking hyphen defaults engine rust'],
    ['detection', 'Detection', 'ocr reader detector models cache gpu engine'],
    ['ai', 'AI agents', 'agent mcp claude codex token door port'],
    ['shortcuts', 'Shortcuts', 'keys keyboard rebind hotkeys'],
    ['about', 'About', 'version updates memory'],
    ['series', 'Series', 'project source language layout'],
    ['styles', 'Text styles', 'fonts tags kinds voices characters lettering'],
    ['guide', 'Guide', 'glossary terms characters notes'],
  ].map(([tab, name, keywords]) => ({
    id: `settings.${tab}`,
    label: `Settings: ${name}`,
    group: 'App',
    combo: null,
    keywords: `preferences options ${keywords}`,
    ...T,
  })),
];

// Defaults are canonicalised once, here, so nothing downstream has to wonder
// whether 'Mod+Shift+C' and 'Mod+Shift+c' are the same shortcut.
export const SHORTCUTS = DEFS.map((d) => ({ ...d, combo: d.combo == null ? null : normalizeCombo(d.combo) }));
const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

export const shortcutById = (id) => BY_ID.get(id) ?? null;
export function defaultCombo(id) {
  return BY_ID.get(id)?.combo ?? null;
}

// The comic tools general use does not have (plan 2.1): detection and OCR,
// the bubble outlines and their fit, the check list, and the Settings tabs
// that only serve them. Hidden, not dimmed: for that person the tool set does
// not exist, rather than being unable to act right now. The text list stays
// (plan 2.1), so its placing keys stay with it.
const COMICS_ONLY = new Set([
  'box.fitBalloon', 'box.retypeset', 'bubble.centre', 'bubble.outlineToBox', 'box.approveOutline', 'bubble.approvePage',
  'mask.clipToBubble',
  'view.regions', 'review.next',
  'detect.page', 'detect.chapter', 'jobs.retry', 'ocr.draw',
  'settings.detection', 'settings.guide',
]);
// A tool switched off in Settings, or one the usage does not have, has no key
// and no row, and its key does nothing.
export const actionOff = (id) =>
  (id === 'tool.brush' && !prefs.brushTool) ||
  (!isComics() && COMICS_ONLY.has(id));
const activeShortcuts = () => SHORTCUTS.filter((s) => !actionOff(s.id));

// The groups, in registry order, for the settings screen. A second key
// (`altOf`) is not a row of its own: it rides on its action's row, in `alts`.
export function shortcutGroups() {
  const out = [];
  const active = activeShortcuts();
  for (const s of active) {
    if (s.altOf) continue;
    let g = out.find((x) => x.name === s.group);
    if (!g) out.push((g = { name: s.group, items: [] }));
    g.items.push({ ...s, alts: active.filter((a) => a.altOf === s.id).map((a) => a.id) });
  }
  return out;
}

// Where a key is heard, for the two that share a label across places (Next
// line in a field, Next line on the page).
const PLACE_NOTES = { field: 'in a text field', row: 'on the page' };
export const placeNote = (s) => PLACE_NOTES[s?.ctx] ?? '';

// Every word of `query` appears somewhere in `hay`. The palette and the
// Shortcuts screen search the same way.
export function matchesWords(hay, query) {
  const words = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const h = String(hay ?? '').toLowerCase();
  return words.every((w) => h.includes(w));
}

// A row of the Shortcuts screen against a search: its label, group, keywords,
// where it is heard, and the keys it is bound to as the screen shows them.
export function shortcutMatches(item, query) {
  const keys = [item.id, ...(item.alts ?? [])].map((id) => formatCombo(comboFor(id))).join(' ');
  return matchesWords(`${item.label} ${item.group} ${item.keywords ?? ''} ${placeNote(item)} ${keys}`, query);
}

// The key an action is bound to, as a person reads it; '' when none.
export const keyLabel = (id) => formatCombo(comboFor(id));

// ---------- user overrides ----------
// Stored in the same preferences blob as everything else that belongs to the
// person rather than the document - see prefs.svelte.js. Only ids this build
// knows are honoured, so a preference written by a newer build (or by hand)
// cannot bind a key to nothing.
// An empty string is a key the user took away: the action has none.
export function comboFor(id) {
  if (actionOff(id)) return null;
  const over = prefs.shortcuts?.[id];
  if (over === '') return null;
  if (typeof over === 'string') {
    const c = normalizeCombo(over);
    if (c) return c;
  }
  return defaultCombo(id);
}

export const isCustomCombo = (id) => comboFor(id) !== defaultCombo(id);

// Two keys clash only when both can be heard at once: either is heard
// everywhere, or both in the same place (see `ctx` above).
// A key heard everywhere that yields to a place (`yields`) is not heard there.
const yieldsTo = (a, b) => !a?.ctx && !!b?.ctx && a?.yields === b.ctx;
const sharePlace = (a, b) => (!a?.ctx || !b?.ctx || a.ctx === b.ctx) && !yieldsTo(a, b) && !yieldsTo(b, a);

// The shortcut a combo is already taken by, ignoring one id (the one being
// rebound, whose place decides what it can clash with). Null when it is free.
export function conflictFor(combo, exceptId = null) {
  const c = normalizeCombo(combo);
  if (!c) return null;
  const self = BY_ID.get(exceptId);
  for (const s of activeShortcuts()) {
    if (s.id === exceptId) continue;
    if (self && !sharePlace(self, s)) continue;
    if (comboFor(s.id) === c) return s;
  }
  return null;
}

// Did this press mean this action? For the keys a component listens for
// itself (the typing pane's), rather than the window's dispatch.
export function pressed(e, id) {
  const c = comboFor(id);
  return !!c && matchesCombo(e, c);
}

// A combo a text field would take as typing or editing: a character, Space,
// or an editing key, with no modifier but Shift. Enter and Tab are not on the
// list - the pane's own defaults are those two.
const FIELD_EDIT_KEYS = new Set(['Space', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown']);
function fieldTypes(c) {
  const bits = c.split('+');
  const key = bits.pop();
  if (bits.some((b) => b !== 'Shift')) return false;
  return key.length === 1 || FIELD_EDIT_KEYS.has(key);
}

function writeOverrides(next) {
  setPref('shortcuts', next);
}

// Keys whose meaning depends on what is selected or focused. The registry
// dispatch runs before the contextual handlers in App.svelte's keydown
// ladder, so a rebind onto one of these would steal it everywhere; they are
// refused as rebind targets rather than quietly broken. A key heard in one
// place only (`ctx`) is never dispatched from the window, so it may take one.
const CONTEXTUAL_KEYS = new Set(['Escape', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

// Returns { ok } or { ok: false, reason, conflict } - the settings screen shows
// the conflict rather than silently stealing a key from another action.
export function setCombo(id, combo) {
  if (!BY_ID.has(id)) return { ok: false, reason: 'unknown' };
  const c = normalizeCombo(combo);
  if (!c) return { ok: false, reason: 'invalid' };
  const def = BY_ID.get(id);
  if (!def.ctx && CONTEXTUAL_KEYS.has(c.split('+').pop())) return { ok: false, reason: 'contextual' };
  if (def.inField && fieldTypes(c)) return { ok: false, reason: 'types' };
  const clash = conflictFor(c, id);
  if (clash) return { ok: false, reason: 'conflict', conflict: clash };
  const next = { ...($state.snapshot(prefs.shortcuts) ?? {}) };
  // Back to the default is an absence, not an entry that happens to match: it
  // keeps the stored blob small and lets a later build move a default without
  // every user being pinned to the old one.
  if (c === defaultCombo(id)) delete next[id];
  else next[id] = c;
  writeOverrides(next);
  return { ok: true, combo: c };
}

export function resetCombo(id) {
  if (!BY_ID.has(id)) return false;
  const cur = $state.snapshot(prefs.shortcuts) ?? {};
  if (!(id in cur)) return false;
  const next = { ...cur };
  delete next[id];
  writeOverrides(next);
  return true;
}

// Take an action's key away. An action with no default key just loses its
// override; one with a default stores the absence, so the default stays off.
export function clearCombo(id) {
  if (!BY_ID.has(id) || comboFor(id) == null) return false;
  const next = { ...($state.snapshot(prefs.shortcuts) ?? {}) };
  if (defaultCombo(id) == null) delete next[id];
  else next[id] = '';
  writeOverrides(next);
  return true;
}

export function resetAllCombos() {
  writeOverrides({});
}

// Overrides read out of storage are pruned once against the registry this
// build actually has: an id it does not know, or a combo its spelling rules
// cannot produce, would otherwise sit in the map forever doing nothing.
// Runs on a microtask rather than at module-eval time because prefs loads
// before this module's tables exist (it is this module's own dependency), so
// any earlier call would reach into half-built bindings.
function pruneLoadedOverrides() {
  const cur = $state.snapshot(prefs.shortcuts) ?? {};
  const next = {};
  for (const [id, combo] of Object.entries(cur)) {
    if (BY_ID.has(id) && typeof combo === 'string' && (combo === '' || normalizeCombo(combo))) next[id] = combo;
  }
  if (Object.keys(next).length !== Object.keys(cur).length) setPref('shortcuts', next);
}
queueMicrotask(pruneLoadedOverrides);

// ---------- dispatch ----------
// Handlers are registered rather than imported, for the reason the store's
// recorder is: this module must not know what a tool or a box is, and a test
// must be able to watch a keypress arrive without a document underneath it.
const handlers = new Map();
export function registerShortcutHandlers(map) {
  const ids = Object.keys(map);
  for (const id of ids) {
    // A silent overwrite looks exactly like a shortcut that has stopped
    // working, so say so. Two components claiming one id is always a bug.
    if (import.meta.env?.DEV && handlers.has(id)) {
      console.warn(`[shortcuts] handler for "${id}" registered twice - the new one replaces the old`);
    }
    handlers.set(id, map[id]);
  }
  return () => {
    for (const id of ids) if (handlers.get(id) === map[id]) handlers.delete(id);
  };
}
export const clearShortcutHandlers = () => handlers.clear();

// Would this combo, pressed in a text field, be typing? `whenTyping` vouches
// for the DEFAULT combo of an action, and every default it vouches for holds
// Mod; a rebind can swap that for a bare `t` and keep the flag. So the combo
// actually bound is asked too. Typing is a character key (Shift is still a
// character: 'T'), or one of the keys a field edits or moves its caret with,
// pressed without the command modifier or the other one (Ctrl on a Mac, Meta
// elsewhere). Alt holds characters back only off a Mac: on one, Option+E is
// the accent and Option+T is '†'. AltGr never gets here as Mod+Alt
// (`eventCombo`).
const FIELD_KEYS = new Set(['Space', 'Enter', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown']);
export function comboTypes(combo) {
  const c = normalizeCombo(combo);
  if (!c) return false;
  const bits = c.split('+');
  const key = bits.pop();
  if (bits.includes('Mod') || bits.includes(MAC ? 'Ctrl' : 'Meta')) return false;
  if (bits.includes('Alt') && !MAC) return false;
  return key.length === 1 || /^Numpad/.test(key) || FIELD_KEYS.has(key);
}

// The shortcut a keypress means, or null.
// Keys heard in one place only (`ctx`) are their component's, never the
// window's.
export function lookupShortcut(e) {
  const c = eventCombo(e);
  if (!c) return null;
  return activeShortcuts().find((s) => !s.ctx && comboFor(s.id) === c) ?? null;
}

// The one entry point the keydown handler uses. `typing` is the caller's answer
// to "is the caret in a text field right now" - the registry decides what that
// means per shortcut rather than the handler refusing everything, which is what
// made the old bare-letter tool keys unreachable in practice: a letterer's
// caret is almost always in the Inspector's text field or a queue row, and
// every printable key there is typing before it is anything else.
//
// Returns the id it ran, or null if the press was not ours.
export function dispatchShortcut(e, { typing = false } = {}) {
  const def = lookupShortcut(e);
  if (!def) return null;
  // The binding the press matched, not the action's default, is what decides:
  // a rebind onto a character key gives that character back to the field.
  if (typing && (!def.whenTyping || comboTypes(comboFor(def.id)))) return null;
  const fn = handlers.get(def.id);
  if (!fn) return null;
  // A handler returning exactly false declines the press - the action did not
  // apply (no selection, wrong chapter mode) and the key should fall through.
  if (fn(e) === false) return null;
  e.preventDefault?.();
  return def.id;
}

// Run an action by id, as its key would: what the command palette and the
// box's right-click menu do, so a menu item and its key can never disagree.
// The handler gets no event. False when there is no handler or it declined.
export function runShortcut(id) {
  if (actionOff(id)) return false;
  const fn = handlers.get(id);
  if (!fn) return false;
  return fn(null) !== false;
}

// Whether an action has a handler right now (the palette hides the rest).
export const hasShortcutHandler = (id) => handlers.has(id);
