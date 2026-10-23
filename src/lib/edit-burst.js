// ===== A panel's edits to the selected box, as undo steps =====
//
// A panel that edits the selected box (the Inspector, the SFX window) records
// a burst of changes as one history step: a slider dragged for a second is one
// undo, not sixty. Every handler mutates first and calls `touch` after, so the
// "before" cannot be taken inside `touch` - by then it is already the after,
// and a one-click edit would diff as nothing. So it is taken where the change
// has provably not happened yet: `arm`, from a capture-phase pointerdown or
// keydown on the panel itself, which runs before any control's own handler.
// `arm` refreshes it only while no burst is open - two edits inside one settle
// window are one burst, and the burst diffs against its own start.
//
// The burst closes SETTLE_MS after its last touch, when the box changes, on
// `settle` (navigation, undo: `settleEdits` reaches every open burst through
// the store's hook) and on `dispose`.
import { boxSnap, boxEdited, boxEditRecords, page, pageById, setEditSettleHook } from './store.svelte.js';
import { record } from './editor/history.svelte.js';

export const SETTLE_MS = 400;

/** `getBox()` is the box the panel is showing, or null. */
export function editBurst(getBox) {
  let pending = null;
  let preSnap = null;
  let settleT;

  function arm() {
    const box = getBox();
    if (!box) return;
    if (pending && pending.boxId === box.id) return;
    preSnap = { boxId: box.id, snap: boxSnap(box) };
  }

  function settle() {
    clearTimeout(settleT);
    const pend = pending;
    pending = null;
    // The armed snapshot served the burst that just closed. Cleared so a later
    // mutation that arrives without its own pointerdown/keydown (a scripted
    // write, a test) falls back to a fresh snapshot instead of blaming this
    // burst's start for changes it never saw.
    preSnap = null;
    if (!pend) return;
    // Ignore pending edits for previous pages.
    if (pend.pageId !== page().id) return;
    const b = pageById(pend.pageId)?.boxes.find((x) => x.id === pend.boxId);
    if (!b) return;
    // The box as the history sees it, and the entries the burst makes, are the
    // store's: one per kind of edit, each with everything its fit moved.
    const key = { pageId: pend.pageId, boxId: b.id };
    for (const e of boxEditRecords(key, pend.before, boxSnap(b), pend.geom)) record(e);
  }

  // `opts.geom`: the edit moved or sized the box (a resize history step).
  function touch(opts) {
    const box = getBox();
    if (pending && pending.boxId !== box?.id) settle();
    if (box && !pending) {
      pending = {
        pageId: page().id,
        boxId: box.id,
        before: preSnap?.boxId === box.id ? preSnap.snap : boxSnap(box),
      };
    }
    if (pending && opts?.geom) pending.geom = true;
    boxEdited(box);
    clearTimeout(settleT);
    settleT = setTimeout(settle, SETTLE_MS);
  }

  const release = setEditSettleHook(settle);
  // Settle on the way out, then let go of the hook so a later settle cannot
  // record against whatever document is open by then.
  function dispose() {
    settle();
    release();
    clearTimeout(settleT);
    pending = null;
  }

  return { arm, touch, settle, dispose };
}
