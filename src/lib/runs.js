// ===== typefaces inside one text =====
//
// A box's words are one plain string, and every reader of them - the agent, the
// text rules, the checks, the JSON export, the counts - keeps reading that one
// string. Which of the box family's four faces a stretch of it is set in is
// said beside the string, not inside it: a list of runs,
//
//   [{ start, end, bold, italic }, ...]
//
// in UTF-16 offsets of the string they sit beside (`box.runs` beside
// `box.text`, `line.runs` beside `line.en`). A run names the face its letters
// are set in outright, not a change to the box's face, so a letter outside
// every run is in the box's own face and a letter inside one is in that run's.
// The list is sorted, no two runs overlap or touch with the same face, and none
// is empty. No runs at all is no list: the field is absent, which is what every
// text saved before runs existed already is, so such a document loads and saves
// byte for byte as it did.
//
// Everything here is pure. The store keeps the rule that every write of a text
// goes through `putText`, which shifts the runs with it.

const HOLDER_KEY = 'runs';

const isBool = (v) => v === true || v === false;
const sameFace = (a, b) => !!a.bold === !!b.bold && !!a.italic === !!b.italic;

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
// later one wins its letters, and runs that touch with the same face become
// one. A run names a face outright, so it is never compared with the box's own:
// a bold run in a box made bold stays when the box is made regular again.
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
    list.push({ start: s, end: e, bold: isBool(r.bold) ? r.bold : false, italic: isBool(r.italic) ? r.italic : false });
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
      if (top) out.push({ start: s, end: e, bold: top.bold, italic: top.italic });
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
      if (offset < r.end) return { bold: r.bold, italic: r.italic };
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
    out.push({ start: r.start, end, bold: r.bold, italic: r.italic });
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
export function editedSpan(before, after, selA, selB) {
  if (typeof before !== 'string' || typeof after !== 'string' || before === after) return null;
  const lo = Math.min(selA, selB);
  const hi = Math.max(selA, selB);
  if (!(lo >= 0) || !(hi <= before.length)) return null;
  const fits = (a, b) =>
    a >= 0 && b <= before.length && a <= b && !splitsPair(before, a) && !splitsPair(before, b) && after.length - (before.length - b) >= a &&
    after.startsWith(before.slice(0, a)) && after.endsWith(before.slice(b));
  if (lo < hi) return fits(lo, hi) ? [lo, hi] : null;
  const delta = after.length - before.length;
  for (const [a, b] of delta >= 0 ? [[lo, lo]] : [[lo + delta, lo], [lo, lo - delta]]) if (fits(a, b)) return [a, b];
  return null;
}

// The runs of `[start, end)` of a text, as runs of that slice alone.
export function sliceRuns(runs, start, end) {
  if (!runs?.length) return null;
  const out = [];
  for (const r of runs) {
    const s = Math.max(start, r.start);
    const e = Math.min(end, r.end);
    if (e > s) out.push({ start: s - start, end: e - start, bold: r.bold, italic: r.italic });
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
    if (e > s) out.push({ start: s, end: e, bold: r.bold, italic: r.italic });
  }
  return normalizeRuns(out, now);
}

// Two run lists the same, for a caller deciding whether anything changed.
export const runsKey = (runs) => (runs?.length ? runs.map((r) => `${r.start}-${r.end}${r.bold ? 'b' : ''}${r.italic ? 'i' : ''}`).join(',') : '');

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
export const copyRuns = (runs) => (runs?.length ? runs.map((r) => ({ start: r.start, end: r.end, bold: r.bold, italic: r.italic })) : null);

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
