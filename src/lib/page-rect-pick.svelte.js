// ===== A rectangle dragged on the page, once =====
//
// Some gestures need one box drawn on the page and nothing else: a pattern
// taken from the tone under it (pattern-pick.svelte.js), a box drawn for a
// line in the typing pane. `start` lays a layer over the canvas
// (Canvas.svelte) that takes the next drag, and that drag ends it either way:
//
//   onDone(rect, page)  the drag, as `[x1, y1, x2, y2]` in the page px of the
//                       page under its first point, corners sorted.
//   onCancel(why)       'escape' (App.svelte's Escape ladder), 'small' (a drag
//                       under PICK_MIN px on a side, which is a click and not
//                       a box), or 'replaced' (another pick started).
//
// One pick at a time: a second `start` cancels the first, so a layer is never
// left answering to a caller that has moved on.

// Smaller than this, a side in page px, is a click, not a region.
export const PICK_MIN = 8;

// What the layer reads: whether a pick is waiting, and the hint it shows.
const shown = $state({ active: false, hint: '' });
// The waiting caller's two callbacks. Not state: nothing draws them.
let current = null;

function end() {
  const was = current;
  current = null;
  shown.active = false;
  shown.hint = '';
  return was;
}

export const pageRectPick = {
  get active() {
    return shown.active;
  },
  get hint() {
    return shown.hint;
  },
  start({ hint = '', onDone, onCancel } = {}) {
    if (current) end()?.onCancel?.('replaced');
    current = { onDone, onCancel };
    shown.hint = hint;
    shown.active = true;
  },
  // False when no pick was waiting, so the Escape ladder can carry on down.
  cancel(why = 'escape') {
    if (!current) return false;
    end()?.onCancel?.(why);
    return true;
  },
  // The layer's drag has ended: corners in page px on `page`.
  finish(page, x0, y0, x1, y1) {
    if (!current) return;
    const rect = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    const was = end();
    if (rect[2] - rect[0] < PICK_MIN || rect[3] - rect[1] < PICK_MIN) was.onCancel?.('small');
    else was.onDone?.(rect, page);
  },
};
