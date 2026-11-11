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
export const faceAsk = $state({ turn: 0, boxId: null, text: '', a: 0, f: 0 });
export function askFacePick(id, text, a, f) {
  faceAsk.boxId = id;
  faceAsk.text = text;
  faceAsk.a = Math.min(a, f);
  faceAsk.f = Math.max(a, f);
  faceAsk.turn++;
}
