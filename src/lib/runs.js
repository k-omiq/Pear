// ===== typefaces inside one text =====
//
// A box's words are one plain string, and every reader of them - the agent, the
// text rules, the checks, the JSON export, the counts - keeps reading that one
// string. Which of the box family's four faces a stretch of it is set in is
// said beside the string, not inside it: a list of runs,
//
//   [{ start, end, bold, italic, font? }, ...]
//
// `font`, when there, is a family the run's letters are set in instead of the
// box's (any family the app has, the user's own included); without it they
// are in the box's family, in the run's weight and slant.
//
// Each of `bold`, `italic` and `font` is optional: one a run does not name is
// the box's, so a word made bold in a regular box still turns italic with the
// box. A command leaves a run naming only what differs from the box's face
// when it is given (`pruneRuns`); what a run names it keeps after that, so a
// word un-bolded inside a bold box stays regular when the box changes.
//
// in UTF-16 offsets of the string they sit beside (`box.runs` beside
// `box.text`, `line.runs` beside `line.en`). A letter outside every run is in
// the box's own face, and a letter inside one is in the box's face with what
// the run names put over it. The list is sorted, no two runs overlap or touch
// naming the same, and none is empty or names nothing. No runs at all is no list: the field is absent, which is what every
// text saved before runs existed already is, so such a document loads and saves
// byte for byte as it did.
//
// Everything here is pure. The store keeps the rule that every write of a text
// goes through `putText`, which shifts the runs with it.

const HOLDER_KEY = 'runs';

const isBool = (v) => v === true || v === false;
// A family name as a run may hold one: a name, not too long to be one.
const isFamily = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= 256;
// Two runs naming the same: an attribute one names and the other does not is
// a difference, since the other one follows the box.
const sameFace = (a, b) => a.bold === b.bold && a.italic === b.italic && (a.font ?? null) === (b.font ?? null);

// What a run names, as plain data: each of bold, italic and family only when
// it names it. Every copy of a run goes through here, so none drops one or
// makes one up.
const attrsOf = (r) => ({ ...(isBool(r.bold) ? { bold: r.bold } : null), ...(isBool(r.italic) ? { italic: r.italic } : null), ...(isFamily(r.font) ? { font: r.font } : null) });
const namesAny = (r) => isBool(r.bold) || isBool(r.italic) || isFamily(r.font);

// The face a run's letters are set in, in a box whose own face is `face`:
// what the run names, the box's for the rest. The family only when the run
// names one (none is the box's).
export const faceOf = (r, face) => ({ bold: isBool(r.bold) ? r.bold : !!face?.bold, italic: isBool(r.italic) ? r.italic : !!face?.italic, ...(isFamily(r.font) ? { font: r.font } : null) });

// Whether offset `k` of `t` falls between the two halves of a surrogate pair,
// where no edge may sit: the engine cannot cut a letter in two, and refuses
// spans that try.
const splitsPair = (t, k) => k > 0 && k < t.length && (t.charCodeAt(k) & 0xfc00) === 0xdc00 && (t.charCodeAt(k - 1) & 0xfc00) === 0xd800;
// `k` moved back to the code point it falls inside, when it falls inside one.
const snap = (t, k) => (splitsPair(t, k) ? k - 1 : k);

// Runs in their one shape, or null for none. `runs` may come off disk or out of
// an edit, so anything that is not a run is dropped rather than trusted: offsets
// are cut to the text's length and moved off the middle of a letter written as
// two UTF-16 units, a run with no letters goes, overlapping runs are cut so the
// later one wins its letters, a run naming nothing goes, and runs that touch
// naming the same become one. Nothing is compared with the box's own face here
// (that is `pruneRuns`, for a command), so a document loads as it was saved.
export function normalizeRuns(runs, text) {
  if (!Array.isArray(runs) || !runs.length) return null;
  const t = typeof text === 'string' ? text : '';
  const len = t.length;
  const list = [];
  for (const r of runs) {
    if (!r || typeof r !== 'object') continue;
    const s = snap(t, Math.max(0, Math.min(len, Math.trunc(Number(r.start)))));
    const e = snap(t, Math.max(0, Math.min(len, Math.trunc(Number(r.end)))));
    if (!(e > s)) continue;
    if (!namesAny(r)) continue;
    list.push({ start: s, end: e, ...attrsOf(r) });
  }
  if (!list.length) return null;
  let out = list;
  // A list already in order with no overlaps - every list this module writes -
  // is taken as it is. Anything else is cut at every edge and each piece takes
  // the face of the last run in the list that covers it, so a later run wins
  // the letters it shares with an earlier one.
  if (list.some((r, i) => i && r.start < list[i - 1].end)) {
    const edges = [...new Set(list.flatMap((r) => [r.start, r.end]))].sort((x, y) => x - y);
    out = [];
    for (let i = 1; i < edges.length; i++) {
      const s = edges[i - 1];
      const e = edges[i];
      let top = null;
      for (const r of list) if (r.start <= s && r.end >= e) top = r;
      if (top) out.push({ start: s, end: e, ...attrsOf(top) });
    }
  }
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && last.end === r.start && sameFace(last, r)) last.end = r.end;
    else merged.push(r);
  }
  return merged.length ? merged : null;
}

// The face of the letter at `offset`: the run's it sits in, else `face`.
export function faceAt(runs, offset, face) {
  if (runs) {
    for (const r of runs) {
      if (r.start > offset) break;
      if (offset < r.end) return faceOf(r, face);
    }
  }
  return { bold: !!face?.bold, italic: !!face?.italic };
}

// The text cut where its face changes, in order and end to end:
// `[{ start, end, bold, italic }]`, the box's own face included. One piece for
// a text with no runs.
export function faceSpans(runs, len, face) {
  const own = { bold: !!face?.bold, italic: !!face?.italic };
  const out = [];
  let at = 0;
  for (const r of runs ?? []) {
    if (r.start >= len) break;
    if (r.start > at) out.push({ start: at, end: r.start, ...own });
    const end = Math.min(len, r.end);
    out.push({ start: r.start, end, ...faceOf(r, face) });
    at = end;
  }
  if (at < len || !out.length) out.push({ start: at, end: len, ...own });
  return out;
}

// Bold or italic (`key`) switched on `[start, end)`: off when every letter
// there already has it, else on, the way a word processor's button works. The
// other half of each letter's face is kept. `face` is the box's own, the face
// of the letters outside every run; what the range becomes is written as runs
// even where it equals that face, since a run is a face outright.
export function toggleRuns(runs, text, start, end, key, face) {
  face = { bold: !!face?.bold, italic: !!face?.italic };
  if (key !== 'bold' && key !== 'italic') return normalizeRuns(runs, text);
  const len = text.length;
  const a = Math.max(0, Math.min(len, start));
  const b = Math.max(a, Math.min(len, end));
  if (a === b) return normalizeRuns(runs, text);
  const pieces = faceSpans(runs, len, face).filter((p) => p.end > a && p.start < b);
  const on = !pieces.every((p) => p[key]);
  const changed = pieces.map((p) => ({ ...p, start: Math.max(a, p.start), end: Math.min(b, p.end), [key]: on }));
  // The untouched runs first, then the range written over them: `normalizeRuns`
  // gives the later run the letters both claim.
  return normalizeRuns([...(runs ?? []), ...changed], text);
}

// ----- a face set on a range, as the editor's commands set it -----

// `[a, b)` of `text` widened to whole letters as a reader sees them
// (graphemes): an emoji sequence, a flag, a letter and its combining marks are
// never split between two faces. Asked when a command is given, never while
// typing.
let graphemes = null;
export function wholeLetters(text, a, b) {
  const t = typeof text === 'string' ? text : '';
  let lo = Math.max(0, Math.min(t.length, Math.min(a, b)));
  let hi = Math.max(0, Math.min(t.length, Math.max(a, b)));
  // A caret is no range of letters to widen.
  if (lo === hi) return [lo, hi];
  // With no segmenter, whole code points at least.
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return [snap(t, lo), splitsPair(t, hi) ? hi + 1 : hi];
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const g of graphemes.segment(t)) {
    const end = g.index + g.segment.length;
    if (g.index < lo && end > lo) lo = g.index;
    if (g.index < hi && end > hi) hi = end;
    if (g.index >= hi) break;
  }
  return [lo, hi];
}

// What `[a, b)` is set in, read for a toggle and for the Inspector: each of
// bold and italic true, false or 'mixed', and the family - a run's own, null
// for the box's, or 'mixed'. `face` is the box's own (bold, italic).
export function rangeFace(runs, text, a, b, face) {
  const pieces = faceSpans(runs, text.length, face).filter((p) => p.end > a && p.start < b && b > a);
  if (!pieces.length) {
    const at = faceAt(runs, Math.max(0, a - 1), face);
    return { bold: at.bold, italic: at.italic, font: at.font ?? null };
  }
  const one = (get) => {
    const v = get(pieces[0]);
    return pieces.every((p) => get(p) === v) ? v : 'mixed';
  };
  return { bold: one((p) => !!p.bold), italic: one((p) => !!p.italic), font: one((p) => p.font ?? null) };
}

// Runs with `[a, b)` changed by `patch`: `bold` or `italic` set as given, and
// `font` set to a family (or null, the box's). What a letter had and the patch
// does not name it keeps. `face` is the box's own, the face of the letters
// outside every run.
export function patchRuns(runs, text, a, b, patch, face) {
  const len = text.length;
  const lo = Math.max(0, Math.min(len, a));
  const hi = Math.max(lo, Math.min(len, b));
  if (lo === hi) return normalizeRuns(runs, text);
  const changed = faceSpans(runs, len, face)
    .filter((p) => p.end > lo && p.start < hi)
    .map((p) => {
      const out = { start: Math.max(lo, p.start), end: Math.min(hi, p.end), bold: 'bold' in patch ? !!patch.bold : !!p.bold, italic: 'italic' in patch ? !!patch.italic : !!p.italic };
      const font = 'font' in patch ? patch.font : p.font;
      return font ? { ...out, font } : out;
    });
  return normalizeRuns([...(runs ?? []), ...changed], text);
}

// Runs left naming only what differs from the box's face `face` (bold,
// italic, font) as it is now: what equals it is dropped, so the letters follow
// the box again, and a run left naming nothing goes. For a command, when it is
// given - never on save, load or typing - so bold put on and taken off again
// leaves no run, and a word un-bolded in a bold box keeps its `bold: false`.
export function pruneRuns(runs, text, face) {
  const out = (runs ?? []).map((r) => {
    const k = { start: r.start, end: r.end, ...attrsOf(r) };
    if (k.bold === !!face?.bold) delete k.bold;
    if (k.italic === !!face?.italic) delete k.italic;
    if (k.font && k.font === face?.font) delete k.font;
    return k;
  });
  return normalizeRuns(out, text);
}

// Runs with every one taken off `[a, b)`: its letters back in the box's face.
export function clearRuns(runs, text, a, b) {
  const out = [];
  for (const r of runs ?? []) {
    if (r.end <= a || r.start >= b) out.push(r);
    else {
      if (r.start < a) out.push({ ...r, end: a });
      if (r.end > b) out.push({ ...r, start: b });
    }
  }
  return normalizeRuns(out, text);
}

// Where two strings differ: the replaced range `[a, b]` of `before`, from the
// common prefix and the common suffix, widened to whole code points - two
// emoji that share their first UTF-16 unit differ in the whole letter, not in
// its second half. Null when they are equal.
export function changedSpan(before, after) {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let a = 0;
  while (a < max && before.charCodeAt(a) === after.charCodeAt(a)) a++;
  if (splitsPair(before, a) || splitsPair(after, a)) a--;
  let k = 0;
  while (k < max - a && before.charCodeAt(before.length - 1 - k) === after.charCodeAt(after.length - 1 - k)) k++;
  if (k > 0 && (splitsPair(before, before.length - k) || splitsPair(after, after.length - k))) k--;
  return [a, before.length - k];
}

// The range of `before` an edit replaced, when the field's selection before
// it (`[selA, selB]`, as `beforeinput` saw it) says: the selection itself when
// it was a range, else the letters typed at the caret or deleted on either
// side of it. Checked against the text the edit left, so a selection that does
// not explain it - an input that moved the caret first, an IME - gives null,
// and the caller falls back to `changedSpan`'s guess.
//
// `inputType`, the edit's own, says which side of the caret a delete took:
// both may explain the text left ("aa" less one "a"), and a forward delete
// took the letter after the caret. Without it the letter before is tried
// first, as Backspace is the delete typed most.
export function editedSpan(before, after, selA, selB, inputType = '') {
  if (typeof before !== 'string' || typeof after !== 'string' || before === after) return null;
  const lo = Math.min(selA, selB);
  const hi = Math.max(selA, selB);
  if (!(lo >= 0) || !(hi <= before.length)) return null;
  const fits = (a, b) =>
    a >= 0 && b <= before.length && a <= b && !splitsPair(before, a) && !splitsPair(before, b) && after.length - (before.length - b) >= a &&
    after.startsWith(before.slice(0, a)) && after.endsWith(before.slice(b));
  if (lo < hi) return fits(lo, hi) ? [lo, hi] : null;
  const delta = after.length - before.length;
  const forward = /^delete\w*Forward$/.test(inputType);
  const back = [lo + delta, lo];
  const ahead = [lo, lo - delta];
  for (const [a, b] of delta >= 0 ? [[lo, lo]] : forward ? [ahead, back] : [back, ahead]) if (fits(a, b)) return [a, b];
  return null;
}

// What each edit of a plain text field (a textarea, an input) replaced, for
// the faces of its words to move with it: the field's text, selection and
// input type as `beforeinput` saw them (`before`), read once the edit has
// landed (`span`). A textarea gives no target ranges, so its selection is
// all there is - except while an IME composes, when the range the
// composition holds is followed from its start (`start`) through each edit
// it makes, as the composed letters are not selected. What the selection does
// not explain - an autocorrect or dictation replacing a word the caret is
// next to, a drop - is null, and the writer guesses from the text.
export function fieldSpans() {
  let was = null;
  let held = null;
  return {
    before(e) {
      const el = e.currentTarget;
      was = { v: el.value, a: held ? held.a : el.selectionStart, b: held ? held.b : el.selectionEnd, t: e.inputType ?? '' };
    },
    start(e) {
      const el = e.currentTarget;
      held = { a: el.selectionStart, b: el.selectionEnd };
    },
    // WebKit ends a composition before its last input lands.
    end() {
      setTimeout(() => {
        held = null;
      });
    },
    // The span of the field's text before this edit that became `v`, when
    // that text was `model`'s (the store's words the field shows).
    span(v, model) {
      const w = was;
      was = null;
      const sp = w && w.v === model ? editedSpan(w.v, v, w.a, w.b, w.t) : null;
      if (held) held = sp ? { a: sp[0], b: sp[1] + v.length - w.v.length } : null;
      return sp;
    },
  };
}

// The runs of `[start, end)` of a text, as runs of that slice alone.
export function sliceRuns(runs, start, end) {
  if (!runs?.length) return null;
  const out = [];
  for (const r of runs) {
    const s = Math.max(start, r.start);
    const e = Math.min(end, r.end);
    if (e > s) out.push({ start: s - start, end: e - start, ...attrsOf(r) });
  }
  return out.length ? out : null;
}

// The runs of `before` carried onto `after`. `span` is the range `[a, b]` of
// `before` that was replaced, when the caller knows it exactly (typing does);
// without it the range is found by the common prefix and suffix, which is right
// for every write that changes one stretch of the text - and for any other
// write it is still a range that covers every change.
//
// Text outside the range keeps its faces and moves with its letters. Letters
// typed in with nothing removed take the face of the letter before them (at the
// very start, of the letter after them), as typing in a word processor does.
// Letters that replace others keep a face only when every letter they replace
// was in it: a run reaching across the whole range covers what replaced it, and
// a run the range cut is trimmed back to its edge. A run left with no letters
// goes.
export function shiftRuns(runs, before, after, span) {
  if (!runs?.length) return null;
  const old = typeof before === 'string' ? before : '';
  const now = typeof after === 'string' ? after : '';
  const cut = span ?? changedSpan(old, now);
  if (!cut) return normalizeRuns(runs, now);
  const a = Math.max(0, Math.min(old.length, cut[0]));
  const b = Math.max(a, Math.min(old.length, cut[1]));
  const delta = now.length - old.length;
  const ins = b - a + delta;
  const out = [];
  for (const r of runs) {
    let s;
    let e;
    if (a === b) {
      // Pure insertion: a run ending where the letters go in takes them, one
      // starting there lets them in front of it - except at the very start,
      // where there is no letter before to take a face from.
      s = r.start < a || r.start === 0 ? r.start : r.start + ins;
      e = r.end < a ? r.end : r.end + ins;
    } else {
      s = r.start <= a ? r.start : r.start >= b ? r.start + delta : a + ins;
      e = r.end <= a ? r.end : r.end >= b ? r.end + delta : a;
    }
    if (e > s) out.push({ start: s, end: e, ...attrsOf(r) });
  }
  return normalizeRuns(out, now);
}

// Two run lists the same, for a caller deciding whether anything changed.
// An attribute named false is not one left to the box: `!b` against nothing.
const named = (v, k) => (v === true ? k : v === false ? `!${k}` : '');
export const runsKey = (runs) => (runs?.length ? runs.map((r) => `${r.start}-${r.end}${named(r.bold, 'b')}${named(r.italic, 'i')}${r.font ? `@${r.font}` : ''}`).join(',') : '');

// THE writer of a text that runs index. `holder[key] = v`, with `holder.runs`
// brought along: shifted from what the text was (`from`, default the holder's
// own text and runs) to `v`, through the edit's exact `span` when the caller
// has one - or set to `runs` outright, for a caller putting back a recorded
// state (the history). The field is deleted rather than left empty, so a text
// with no runs is saved without the key, as before runs existed.
//
// `from` is for a write that moves the text to another field than the one it
// was read from: a queue-placed box overriding its line's words reads the
// line's text and runs and writes its own.
export function putText(holder, key, v, opts = {}) {
  if (!holder) return;
  const from = opts.from ?? { text: holder[key], runs: holder[HOLDER_KEY] };
  const text = v ?? '';
  const next =
    opts.runs !== undefined
      ? normalizeRuns(opts.runs, text)
      : from.runs?.length
        ? shiftRuns(from.runs, from.text ?? '', text, opts.span)
        : null;
  holder[key] = v;
  if (next) holder[HOLDER_KEY] = next;
  else if (HOLDER_KEY in holder) delete holder[HOLDER_KEY];
}

// `runs` for a record or a copy: plain data, or null for none.
export const copyRuns = (runs) => (runs?.length ? runs.map((r) => ({ start: r.start, end: r.end, ...attrsOf(r) })) : null);

// The families runs set letters in, besides the box's: what a chapter's
// fonts must hold for them (the package, the wait for fonts before an export).
export const runFamilies = (runs) => [...new Set((runs ?? []).map((r) => r.font).filter(Boolean))];

// ----- on disk -----
//
// Runs are saved with a check of the text they index (`runsCheck`, a 32-bit
// FNV-1a of the string). An app from before runs keeps a line's unknown fields
// as they are while it edits the words, so a chapter it saved can hold runs
// that no longer sit on the letters they were made for; on load, runs whose
// check does not match their text are dropped rather than put on the wrong
// letters. Worked out on save and load only, never while typing.
const CHECK_KEY = 'runsCheck';
export function textCheck(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// The `{ runs }` field of an object read off disk beside `text`: normalised,
// and only when its `runsCheck` is that text's; nothing at all otherwise, so a
// live object never holds the check and one with no runs has no key.
export function runsField(runs, text, check) {
  if (typeof text !== 'string' || check !== textCheck(text)) return null;
  const out = normalizeRuns(runs, text);
  return out ? { runs: out } : null;
}

// A page's lines (`key` 'en') or boxes (`key` 'text') as they are about to be
// saved: runs normalised against the text beside them, with that text's check,
// and dropped where there is none. `list` is plain data the caller owns (a
// snapshot); only an item that has runs is touched, so a page with none is
// written exactly as before runs existed.
export function saveRuns(list, key) {
  for (const item of list ?? []) {
    if (!item || !('runs' in item || CHECK_KEY in item)) continue;
    const text = item[key];
    const runs = typeof text === 'string' ? normalizeRuns(item.runs, text) : null;
    delete item.runs;
    delete item[CHECK_KEY];
    if (runs) Object.assign(item, { runs, [CHECK_KEY]: textCheck(text) });
  }
  return list;
}
