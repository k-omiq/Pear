// ===== Paint over the letters =====
//
// `style.paint = { on, marks }`: colour laid on the letters' fill where its
// marks lie. Unlike the mask and the fade (box-mask.js, box-fade.js), which
// are pinned to the page, paint is ink on the letters: its marks are stated
// in the box's own frame (page px from the box's corner, unturned and
// unmirrored) and move, turn and flip with the box, and scale with it on a
// scale (`scalePaint`, through `rescaleStyle`).
//
// A mark is a mask shape with no op (a brush stroke, a polygon - a rectangle
// is stored as one - or an ellipse) and four fields of its own: `color`,
// `opacity` 1-100, `soft` 0-100 (percent of the mark's size, as the fade's
// soft edge is) and `erase`, which takes the paint under it away instead of
// laying colour. The marks lie in the order drawn.
//
// Only the Rust engine paints them (box wire v21, an interior effect laid
// after the overlays and inside the letters only): there is no canvas twin,
// so under the browser engine the paint is kept and not shown.

import { normalizeMaskShape, revOf, MASK_SHAPES_MAX } from './box-mask.js';
import { fadeShapeSize } from './box-fade.js';

export const PAINT_MARKS_MAX = MASK_SHAPES_MAX;
export const PAINT_COLOR_DEFAULT = '#e33b2e';

const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const HEX = /^#[0-9a-f]{6}$/i;

// One mark as this build reads it, or null for one it cannot draw.
export function normalizePaintMark(m) {
  if (m?.kind !== 'stroke' && m?.kind !== 'poly' && m?.kind !== 'ellipse') return null;
  const base = normalizeMaskShape(m);
  if (!base) return null;
  const { op: _op, ...rest } = base;
  return {
    ...rest,
    color: typeof m.color === 'string' && HEX.test(m.color) ? m.color.toLowerCase() : PAINT_COLOR_DEFAULT,
    opacity: clamp(m.opacity, 1, 100, 100),
    soft: clamp(m.soft, 0, 100, 0),
    ...(m.erase === true ? { erase: true } : {}),
  };
}

// The paint as this build reads it: off with no marks for a style that has
// none.
export function normalizePaint(p) {
  const marks = [];
  for (const m of Array.isArray(p?.marks) ? p.marks : []) {
    const n = normalizePaintMark(m);
    if (n) marks.push(n);
    if (marks.length >= PAINT_MARKS_MAX) break;
  }
  return { on: p?.on === true, marks };
}

// Whether the paint lays any colour: on, with a mark that is not an eraser.
export function paintShown(style) {
  const p = style?.paint;
  return !!p?.on && Array.isArray(p.marks) && p.marks.some((m) => !m.erase);
}

// The marks as the engine takes them, in the box's own frame from its corner:
// opacity as a share, the soft edge as a gaussian's sigma (a quarter of the
// mark's size at 100, as the fade's), rounded to a quarter px.
export function paintMarksForEngine(paint) {
  return (paint?.marks ?? []).map((m) => ({
    ...m,
    opacity: m.opacity / 100,
    soft: Math.round((m.soft / 100) * fadeShapeSize(m)) / 4,
  }));
}

// The marks scaled with the box, per axis, as a brush stroke of ink is: the
// points, a brush's width by the mean of the two.
export function scalePaint(paint, sx, sy) {
  if (!paint || !Array.isArray(paint.marks) || (sx === 1 && sy === 1)) return paint;
  const s = Math.sqrt(Math.abs(sx * sy));
  return {
    ...paint,
    marks: paint.marks.map((m) => {
      if (m.kind === 'ellipse') return { ...m, cx: m.cx * sx, cy: m.cy * sy, rx: m.rx * Math.abs(sx), ry: m.ry * Math.abs(sy) };
      const pts = m.pts.map(([x, y]) => [x * sx, y * sy]);
      return m.kind === 'stroke' ? { ...m, pts, size: m.size * s } : { ...m, pts };
    }),
  };
}

// The paint's part of a picture's key: the mark list's revision (box-mask.js
// `revOf`), never its marks - a brush's hundreds of points must not be turned
// to text on every frame. Every writer of `style.paint` puts a new mark list
// there. A box that shows no paint keys as no paint at all, so two copies of
// one unpainted style key alike and an undo or a clone does not repaint it.
export function paintKey(paint) {
  return paintShown({ paint }) ? `${revOf(paint.marks)}` : '';
}
