// ===== What the menu on selected words offers =====
// One list for both menus that show it: the app's own (FaceMenu.svelte, in a
// browser) and the system's popup (face-menu-native.js, in the desktop app).
// Bold, Italic, Typeface… and Clear typeface run through the shortcut
// registry, so a menu item, its key and the Inspector's buttons are one
// command, and each shows its key as the user has it bound.

import { app, byId, boxText, boxRuns } from '../store.svelte.js';
import { runShortcut, hasShortcutHandler, comboFor, formatCombo, normalizeCombo } from '../shortcuts.svelte.js';
import { selectedRange } from '../typing-selection.svelte.js';
import { rangeFace } from '../runs.js';

// The words the menu is about: the selection in the box typed into.
export function faceMenuTarget() {
  const b = app.editingId != null ? byId(app.editingId) : null;
  if (!b) return null;
  const text = boxText(b) ?? '';
  const r = selectedRange(b.id, text);
  return r && r[0] < r[1] ? { b, text, r } : null;
}

// The four face commands for `t`, each `{ id, label, key, combo, ok, run,
// checked?, note? }`: Bold and Italic checked when all of the words have
// them, 'mixed' when some do.
export function faceMenuItems(t) {
  const face = rangeFace(boxRuns(t.b), t.text, t.r[0], t.r[1], t.b.style);
  const keyed = (id, label, extra = {}) => ({ id, label, key: formatCombo(comboFor(id)), combo: comboFor(id), ok: hasShortcutHandler(id), run: () => runShortcut(id), ...extra });
  return [
    keyed('text.bold', 'Bold', { checked: face.bold }),
    keyed('text.italic', 'Italic', { checked: face.italic }),
    keyed('text.typeface', 'Typeface…', { note: face.font === 'mixed' ? 'Mixed' : face.font }),
    keyed('text.clearFace', 'Clear typeface'),
  ];
}

// A key as the system's menus write it ("CmdOrCtrl+Shift+B"), or null for one
// they cannot show: a menu item then shows no key rather than a wrong one.
const KEY_NAMES = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Enter', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Space: 'Space', ' ': 'Space', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
const MOD_NAMES = { Mod: 'CmdOrCtrl', Ctrl: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Meta: 'Super' };
export function comboAccelerator(combo) {
  const c = normalizeCombo(combo);
  if (!c) return null;
  const bits = c.split('+');
  const key = bits.pop();
  const mods = bits.map((m) => MOD_NAMES[m]);
  if (mods.some((m) => !m)) return null;
  const name = key.length === 1 && /[a-z0-9]/i.test(key) ? key.toUpperCase() : /^F\d{1,2}$/.test(key) ? key : KEY_NAMES[key];
  return name ? [...mods, name].join('+') : null;
}
