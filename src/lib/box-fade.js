// ===== The fade: regional opacity, pinned to the page =====
//
// Or moving with the box: `follow: true` stores the shapes in the box's own
// frame, as the mask's "Moves with box" does (box-mask.js `follows`).
//
// `box.fade = { on, shapes }` takes some of the box's opacity where its shapes
// lie. Like the mask (box-mask.js) the shapes are page px, pinned to the page:
// a move of the box slides the letters under them. A shape is a mask shape
// with no op (a brush stroke, a polygon - a rectangle is stored as one - or an
// ellipse) and two numbers of its own: `strength` 1-100, how much opacity the
// text loses there, and `soft` 0-100, how soft its edge is, in percent of the
// shape's size.
//
// Only the Rust engine paints a fade (box wire v20, the stage after the
// mask): there is no canvas twin, so under the browser engine a fade is kept
// and not shown.
//
// Known limit: the engine lays the fade after the box's mesh, so a warp never
// bends it, except where the box is painted with no mesh and bent on the
// canvas afterwards (the warp gizmo's drag frames, and a perspective corner
// pulled past the horizon). There the fade bends with the letters. Accepted.

import { normalizeMaskShape, shapesInBoxFrame, memoFrame, pinShiftOf, shiftedShapes, follows, modelShapesOnPage, MASK_SHAPES_MAX } from './box-mask.js';

export const FADE_STRENGTH_DEFAULT = 50;
export const FADE_SOFT_DEFAULT = 30;

const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

// One shape as this build reads it, or null for one it cannot draw.
export function normalizeFadeShape(sh) {
  if (sh?.kind !== 'stroke' && sh?.kind !== 'poly' && sh?.kind !== 'ellipse') return null;
  const base = normalizeMaskShape(sh);
  if (!base) return null;
  const { op: _op, ...rest } = base;
  return { ...rest, strength: clamp(sh.strength, 1, 100, FADE_STRENGTH_DEFAULT), soft: clamp(sh.soft, 0, 100, 0) };
}

// The fade as this build reads it, or null for a box that has none.
export function normalizeFade(f) {
  if (!f || typeof f !== 'object') return null;
  const shapes = [];
  for (const sh of Array.isArray(f.shapes) ? f.shapes : []) {
    const n = normalizeFadeShape(sh);
    if (n) shapes.push(n);
    if (shapes.length >= MASK_SHAPES_MAX) break;
  }
  return { on: f.on === true, shapes, ...(f.follow === true ? { follow: true } : {}) };
}

// Whether the fade changes anything: on, with a shape.
export function fadeActive(box) {
  return !!box?.fade?.on && box.fade.shapes.length > 0;
}

// A shape's size, page px: what its soft edge is a percent of. A brush's is
// its width; a polygon's and an ellipse's the shorter side of their bounds,
// so a soft edge of 100 reaches the middle of a long thin shape too.
export function fadeShapeSize(sh) {
  if (sh.kind === 'stroke') return sh.size;
  if (sh.kind === 'ellipse') return 2 * Math.min(sh.rx, sh.ry);
  const xs = sh.pts.map((p) => p[0]);
  const ys = sh.pts.map((p) => p[1]);
  return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

// The blur a shape's soft edge is, page px (a gaussian's sigma): a quarter of
// the size at 100, so the edge runs about half the shape in from each side.
// Rounded to a quarter px so that shapes alike in size share one blur in the
// engine, which blurs each softness once.
export function fadeSigma(sh) {
  const s = (sh.soft / 100) * fadeShapeSize(sh) / 4;
  return Math.round(s * 4) / 4;
}

// The fade's shapes in the box's own frame, ready for the engine: each one
// mapped there as the mask's are, with its strength as a share and its soft
// edge as a sigma. The sigma is worked out on the page, where the shape was
// drawn: the box's frame is the page turned and moved, so lengths are the
// same. Empty for a fade that does nothing. For a held box (`pinMove`) they
// are moved on by its move.
export function fadeInBoxFrame(box) {
  return shiftedShapes(heldFadeInBoxFrame(box), pinShiftOf(box));
}

// `fadeInBoxFrame` as the box stands, whatever its `pinMove`, worked out once
// for each fade and place (`memoFrame`): what the engine takes, with the move
// apart. The list is shared; nobody may change it.
const heldFades = new WeakMap();
export function heldFadeInBoxFrame(box) {
  if (!fadeActive(box)) return [];
  return memoFrame(heldFades, box, box.fade, () => {
    const shapes = box.fade.shapes;
    // "Moves with box" (box-mask.js `follows`): stored in the box's frame
    // already, and moved back by a held move, which carries only the
    // page's shapes. The soft edge is still worked out on the page, as the
    // shape stands there, so the switch never changes it.
    if (follows(box.fade)) {
      const v = pinShiftOf(box);
      const own = v ? shiftedShapes(shapes, [-v[0], -v[1]]) : shapes;
      const onPage = modelShapesOnPage(box, box.fade);
      return own.map((sh, i) => ({ ...sh, strength: shapes[i].strength / 100, soft: fadeSigma(onPage[i]) }));
    }
    return shapesInBoxFrame(box, shapes).map((sh, i) => ({ ...sh, strength: shapes[i].strength / 100, soft: fadeSigma(shapes[i]) }));
  });
}
