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

import { normalizeMaskShape, revOf, pageToBox, boxToPage, shapesInBoxFrame, shapesOnPage, shiftedShapes, bendShape, bendStrokeRuns, MASK_SHAPES_MAX } from './box-mask.js';
import { fadeShapeSize } from './box-fade.js';
import { meshMap, unwarpWith } from './warp.js';

// The most colour marks a box holds. Erasers do not count against it: a box
// full of marks can always have one taken off. They have a ceiling of their
// own, as many again, so a file cannot hand the engine a list without end.
export const PAINT_MARKS_MAX = MASK_SHAPES_MAX;
export const PAINT_ERASERS_MAX = MASK_SHAPES_MAX;
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
  const room = { colour: PAINT_MARKS_MAX, erase: PAINT_ERASERS_MAX };
  for (const m of Array.isArray(p?.marks) ? p.marks : []) {
    const n = normalizePaintMark(m);
    const k = n?.erase ? 'erase' : 'colour';
    if (n && room[k] > 0) {
      marks.push(n);
      room[k]--;
    }
    if (!room.colour && !room.erase) break;
  }
  return { on: p?.on === true, marks };
}

// Whether one more mark of this kind fits (`erase` for an eraser), and the
// words to say when it does not.
export function paintRoomFor(paint, erase) {
  const n = (paint?.marks ?? []).filter((m) => !!m.erase === !!erase).length;
  if (erase) return n < PAINT_ERASERS_MAX ? null : `The paint holds ${PAINT_ERASERS_MAX} eraser strokes at most`;
  return n < PAINT_MARKS_MAX ? null : `The paint holds ${PAINT_MARKS_MAX} marks at most`;
}

// ---- the frame the marks are stored in ----
//
// The paint is laid in the box's texture: its own frame before the warp mesh
// (a perspective is a mesh of one cell), which the mesh then bends with the
// letters. So a page point reaches a mark's frame through the box's turn and
// flips (`pageToBox`) and then back through the mesh (`unwarpWith`, exact to
// a hair for every mesh kind), and a mark is shown on the page the other way.
// A box with no mesh maps straight, and an ellipse stays one unless it turns.

function meshOf(box) {
  const w = box?.style?.warp;
  return w?.on && Array.isArray(w.pts) ? meshMap(w.pts, w.cols, w.rows, box.w, box.h) : null;
}

// Shapes drawn on the page (page px), as marks in the paint's frame, in
// their order. Through a mesh, a point the mesh does not carry anywhere
// (`unwarpWith`: past a perspective's vanishing line, past a fold) is dropped,
// and a shape left with nothing to draw is left out.
export function marksFromPage(box, shapes) {
  const m = meshOf(box);
  if (!m) return shapesInBoxFrame(box, shapes);
  const at = (p) => unwarpWith(m, box.w, box.h, ...pageToBox(box, p));
  // A stroke drawn partly where the mesh does not reach is cut there, never
  // joined across the gap; any other shape with such a point is dropped.
  return shapes.flatMap((sh) => bendStrokeRuns(sh, at));
}

// The marks on the page as the box stands, one for each and in their order:
// what the tool shows and picks from. Kept with the mark list until it, the
// mesh or where the box stands changes: the tool asks whenever the box does,
// and a bent mark is cut into 4 px steps and carried point by point. The list
// is shared; nobody may change it.
const onPage = new WeakMap();
export function marksOnPage(box, marks) {
  const s = box.style;
  const w = s?.warp;
  const mesh = w?.on && Array.isArray(w.pts) ? `${w.cols}x${w.rows}:${w.pts.flat().join(',')}` : '';
  const key = `${box.x},${box.y},${box.w},${box.h},${Number(s?.rotation) || 0},${s?.flipH ? 1 : 0}${s?.flipV ? 1 : 0}|${mesh}`;
  const hit = onPage.get(marks);
  if (hit?.key === key) return hit.out;
  const m = meshOf(box);
  // The forward map carries every point: one shape for each mark.
  const out = m ? marks.map((sh) => bendShape(sh, (p) => boxToPage(box, m.at(p[0], p[1])))) : shapesOnPage(box, marks);
  onPage.set(marks, { key, out });
  return out;
}

// The marks with mark `idx` (every mark for null) moved (dx, dy) page px as
// the pointer moved it. The others stay as stored; on a box with no mesh the
// moved one is the same shape moved in the box's frame, an ellipse still one.
export function moveMarks(box, marks, idx, dx, dy) {
  const pick = (i) => idx === null || idx === i;
  const m = meshOf(box);
  if (!m) {
    const o = pageToBox(box, [0, 0]);
    const q = pageToBox(box, [dx, dy]);
    const v = [q[0] - o[0], q[1] - o[1]];
    return marks.map((mk, i) => (pick(i) ? shiftedShapes([mk], v)[0] : mk));
  }
  const at = (p) => {
    const [x, y] = boxToPage(box, m.at(p[0], p[1]));
    return unwarpWith(m, box.w, box.h, ...pageToBox(box, [x + dx, y + dy]));
  };
  // A mark moved even partly where the mesh does not reach stays where it
  // was, whole (`bendShape` is null unless every point is carried).
  return marks.map((mk, i) => (pick(i) ? (bendShape(mk, at) ?? mk) : mk));
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
