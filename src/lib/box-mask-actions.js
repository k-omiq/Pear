// ===== edits to a box's mask and its fade =====
//
// Every change to `box.mask` the panels, the box menu, the palette and the
// agent make, each one undo step (`mask` in the history) and each followed
// by the box's check, since a keep shape cuts the ink the check counts. The
// drawing gestures themselves are TextBox's; they record the same kind.

import { app, page, toast, markUnsaved, reviewBox, findBoxOutline } from './store.svelte.js';
import { record } from './editor/history.svelte.js';
import { isComics } from './prefs.svelte.js';
import { normalizeMask, bubbleLink, bubbleOutline, BUBBLE_INSET_DEFAULT, BUBBLE_INSET_MAX } from './box-mask.js';
import { normalizeFade } from './box-fade.js';

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

// The boxes an action on "the selection" acts on: the Bulk panel's picked
// boxes while it is open, else the selected box.
const pickedIds = () => (app.bulk.active && app.bulk.targets.length ? [...app.bulk.targets] : [app.selectedId]);

// Clip to bubble: each box's mask keeps the letters inside its bubble
// outline, a live link that follows a refit; or, when every box has the link
// already, the links go. A box with no outline has the finder's set first,
// with no typesetting again; where none is found the box is left as it was.
// The mask is switched on with the link, which is what the button asks for.
// Comics only. One undo step for all of it. True when anything changed.
export function clipToBubble(ids = pickedIds(), p = page()) {
  if (!isComics()) return false;
  const boxes = [ids].flat().map((id) => boxIn(p, id)).filter(Boolean);
  if (!boxes.length) return false;
  const unlink = boxes.every((b) => bubbleLink(b));
  const items = [];
  let missing = 0;
  for (const b of boxes) {
    let next;
    if (unlink) {
      const link = bubbleLink(b);
      next = { ...b.mask, shapes: b.mask.shapes.filter((sh) => sh !== link) };
    } else {
      if (bubbleLink(b)) continue;
      if (!bubbleOutline(b)) {
        const found = findBoxOutline(b, p);
        if (found) items.push(found);
        if (!bubbleOutline(b)) {
          missing++;
          continue;
        }
      }
      next = { on: true, shapes: [...(b.mask?.shapes ?? []), { kind: 'bubble', op: 'keep', inset: BUBBLE_INSET_DEFAULT }] };
    }
    const before = plain(b.mask);
    b.mask = normalizeMask(next);
    reviewBox(b, p);
    items.push({ t: 'mask', pageId: p.id, boxId: b.id, before, after: plain(b.mask) });
  }
  if (missing) toast(missing === boxes.length ? 'No bubble outline here' : `No bubble outline under ${missing} of those boxes`);
  if (!items.length) return false;
  markUnsaved();
  record(items.length === 1 ? items[0] : { t: 'group', pageId: p.id, items });
  return true;
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

// The fade set to `next` (normalized, null for none), as one record. The
// fade changes no verdict, so no check follows. False when nothing changed.
export function setBoxFade(b, p, next) {
  const before = plain(b.fade);
  const after = next ? normalizeFade(next) : null;
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  b.fade = after;
  markUnsaved();
  record({ t: 'fade', pageId: p.id, boxId: b.id, before, after: plain(after) });
  return true;
}

// The Fade switch.
export function setFadeOn(b, p, on) {
  return setBoxFade(b, p, { shapes: [], ...(b.fade ?? {}), on: !!on });
}

// The palette's Fade on or off, on the selected box.
export function toggleFade(boxId = app.selectedId, p = page()) {
  const b = boxIn(p, boxId);
  return b ? setFadeOn(b, p, !b.fade?.on) : false;
}

// Every fade shape gone, the switch as it was.
export function clearFadeShapes(b, p) {
  if (!b.fade?.shapes?.length) return false;
  return setBoxFade(b, p, { ...b.fade, shapes: [] });
}
