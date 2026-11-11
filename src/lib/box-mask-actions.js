// ===== edits to a box's mask =====
//
// Every change to `box.mask` the panels, the box menu, the palette and the
// agent make, each one undo step (`mask` in the history) and each followed
// by the box's check, since a keep shape cuts the ink the check counts. The
// drawing gestures themselves are TextBox's; they record the same kind.

import { app, page, toast, markUnsaved, reviewBox, refitBalloon } from './store.svelte.js';
import { record } from './editor/history.svelte.js';
import { isComics } from './prefs.svelte.js';
import { normalizeMask, bubbleLink, bubbleOutline, BUBBLE_INSET_DEFAULT, BUBBLE_INSET_MAX } from './box-mask.js';

const plain = (m) => (m ? JSON.parse(JSON.stringify(m)) : null);
const boxIn = (p, id) => (p?.boxes ?? []).find((x) => x.id === id) ?? null;

// The mask set to `next` (normalized, null for none), as one record. False
// when nothing changed.
export function setBoxMask(b, p, next) {
  const before = plain(b.mask);
  const after = next ? normalizeMask(next) : null;
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  b.mask = after;
  markUnsaved();
  reviewBox(b, p);
  record({ t: 'mask', pageId: p.id, boxId: b.id, before, after: plain(after) });
  return true;
}

// The Mask switch.
export function setMaskOn(b, p, on) {
  return setBoxMask(b, p, { shapes: [], ...(b.mask ?? {}), on: !!on });
}

// Every shape gone, the switch as it was.
export function clearMaskShapes(b, p) {
  if (!b.mask?.shapes?.length) return false;
  return setBoxMask(b, p, { ...b.mask, shapes: [] });
}

// How far inside its outline the bubble link draws, page px.
export function setBubbleInset(b, p, inset) {
  if (!bubbleLink(b)) return false;
  const v = Math.min(BUBBLE_INSET_MAX, Math.max(0, Number(inset) || 0));
  return setBoxMask(b, p, { ...b.mask, shapes: b.mask.shapes.map((sh) => (sh.kind === 'bubble' ? { ...sh, inset: v } : sh)) });
}

// Clip to bubble: the box's mask keeps the letters inside its bubble outline,
// a live link that follows a refit, or, pressed on a box that has the link,
// the link goes. A box with no outline has one found first (Find outline);
// where none is found the box is left as it was. The mask is switched on with
// the link, which is what the button asks for. Comics only. True when the box
// changed.
export function clipToBubble(boxId = app.selectedId, p = page()) {
  if (!isComics()) return false;
  const b = boxIn(p, boxId);
  if (!b) return false;
  const link = bubbleLink(b);
  if (link) return setBoxMask(b, p, { ...b.mask, shapes: b.mask.shapes.filter((sh) => sh !== link) });
  if (!bubbleOutline(b)) {
    refitBalloon(b.id, p, { quiet: true });
    if (!bubbleOutline(b)) {
      toast('No bubble outline here');
      return false;
    }
  }
  const shapes = [...(b.mask?.shapes ?? []), { kind: 'bubble', op: 'keep', inset: BUBBLE_INSET_DEFAULT }];
  return setBoxMask(b, p, { on: true, shapes });
}

// The Inset slider: the link drawn live as it slides, one record when it
// rests (400 ms after the last move, or when another box's slide starts).
let held = null;
export function slideBubbleInset(b, p, inset) {
  if (!bubbleLink(b)) return false;
  if (held && held.b !== b) flushBubbleInset();
  if (!held) held = { b, p, before: plain(b.mask), t: 0 };
  const v = Math.min(BUBBLE_INSET_MAX, Math.max(0, Number(inset) || 0));
  b.mask = { ...b.mask, shapes: b.mask.shapes.map((sh) => (sh.kind === 'bubble' ? { ...sh, inset: v } : sh)) };
  markUnsaved();
  clearTimeout(held.t);
  held.t = setTimeout(flushBubbleInset, 400);
  return true;
}
export function flushBubbleInset() {
  if (!held) return;
  const h = held;
  held = null;
  clearTimeout(h.t);
  reviewBox(h.b, h.p);
  const after = plain(h.b.mask);
  if (JSON.stringify(after) !== JSON.stringify(h.before)) record({ t: 'mask', pageId: h.p.id, boxId: h.b.id, before: h.before, after });
}
