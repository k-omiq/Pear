// ===== The words a face command acts on =====
//
// The commands that set a face on part of a box's words (Bold, Italic,
// Typeface, Clear typeface: `setRangeFace` in the store) act on the words
// selected in that box. The selection is the box's while it is typed into
// (TextBox.svelte's own, `edSel`), and it outlasts the edit while nothing else
// is selected and the words are as they were: a press on the Inspector or a
// picker that ends the edit still finds it. Raw offsets into the box's words
// (`boxText`), anchor and focus.
//
// `pending` is a face asked for at a bare caret: the letters typed there next
// are set in it, as a word processor does, and it goes when the caret moves.
export const typingSel = $state({ boxId: null, text: '', a: 0, f: 0, pending: null });

export function setTypingSel(boxId, text, a, f) {
  const caretMoved = typingSel.boxId !== boxId || typingSel.text !== text || Math.min(a, f) !== typingSel.pending?.at || a !== f;
  typingSel.boxId = boxId;
  typingSel.text = text;
  typingSel.a = a;
  typingSel.f = f;
  if (typingSel.pending && caretMoved) typingSel.pending = null;
}

export function clearTypingSel() {
  typingSel.boxId = null;
  typingSel.text = '';
  typingSel.a = typingSel.f = 0;
  typingSel.pending = null;
}

// The selected range of box `id`, lowest first, while its words are `text`:
// null when there is none there, or the words have changed under it.
export function selectedRange(id, text) {
  if (id == null || typingSel.boxId !== id || typingSel.text !== text) return null;
  return [Math.min(typingSel.a, typingSel.f), Math.max(typingSel.a, typingSel.f)];
}

// A face for the letters typed next at the caret `at` of box `id`: `patch`
// merged into what was asked there already (Bold twice is no change).
export function askPending(id, text, at, patch) {
  const was = typingSel.pending?.boxId === id && typingSel.pending.at === at ? typingSel.pending.patch : {};
  typingSel.pending = { boxId: id, text, at, patch: { ...was, ...patch } };
}

// "Typeface…": the family picker asked for, for `[a, f)` of box `id` while its
// words are `text`. The Inspector holds the one picker and opens it on its
// Text tab (`turn` makes each ask a new one); the range is kept here, as the
// picker taking the focus ends the edit the selection belonged to.
//
// `open` until an Inspector takes the ask (`takeFaceAsk`), exactly once: the
// panel may be hidden when it is asked (the command shows it), and the
// Inspector drawn after it still finds the ask; one drawn again later finds
// none.
export const faceAsk = $state({ turn: 0, open: false, boxId: null, text: '', a: 0, f: 0 });
export function askFacePick(id, text, a, f) {
  faceAsk.boxId = id;
  faceAsk.text = text;
  faceAsk.a = Math.min(a, f);
  faceAsk.f = Math.max(a, f);
  faceAsk.open = true;
  faceAsk.turn++;
}
// The ask, for box `id` while its words are `text`, taken: the range, or null
// when there is none for it. An ask for other words is dropped.
export function takeFaceAsk(id, text) {
  if (!faceAsk.open) return null;
  faceAsk.open = false;
  return faceAsk.boxId === id && faceAsk.text === text ? { a: faceAsk.a, f: faceAsk.f } : null;
}

// ----- the edit while a control that sets faces has the focus -----
// A box typed into keeps its edit (and its selection) while the focus is on a
// control that sets the faces of its words: the faces menu, the Inspector's
// B, I and family, the family list. Those carry `data-keeps-edit`. Once the
// focus is in neither the box nor such a control, the edit ends as a blur
// would have ended it. The box typed into says how (`onEditAway`); anyone
// closing such a control without handing the focus back asks
// (`endEditIfAway`).
let away = null;
export function onEditAway(fn) {
  away = fn;
  return () => {
    if (away === fn) away = null;
  };
}
export const keepsEdit = (el) => !!el?.closest?.('.txt.editable, [data-keeps-edit]');
// Once per edit: two closes in the same moment (a press away that also blurs
// the menu) both ask, and the edit has ended after the first.
export function endEditIfAway() {
  if (!away || keepsEdit(globalThis.document?.activeElement)) return;
  const fn = away;
  away = null;
  fn();
}

// ----- words selected in a queue line's English field -----
// The queue writes a line's words, not a box's, so its selection is kept apart:
// line `n` of page `pageId` while its English is `text`. Only while the field
// has the focus (cleared on its blur), so a face command finds it only then.
export const lineSel = $state({ pageId: null, n: null, text: '', a: 0, f: 0 });
export function setLineSel(pageId, n, text, a, f) {
  lineSel.pageId = pageId;
  lineSel.n = n;
  lineSel.text = text;
  lineSel.a = Math.min(a, f);
  lineSel.f = Math.max(a, f);
}
export function clearLineSel() {
  lineSel.pageId = null;
  lineSel.n = null;
  lineSel.text = '';
  lineSel.a = lineSel.f = 0;
}
