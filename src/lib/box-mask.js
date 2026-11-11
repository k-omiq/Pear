// ===== a box's mask, pinned to the page =====
//
// The mask belongs to its box but does not follow it. `box.mask` is
// `{ on, shapes }` with every shape in page px, so a shape stays exactly where
// it was drawn for any later move, turn, flip, resize, warp or reflow of the
// box: the text slides under it. It is page geometry, like `box.fit`, so it is
// not in the style: copy style, presets, tag styles and bulk style never carry
// it.
//
// Each shape says what it does (`op`): the text shows inside the union of the
// `keep` shapes (everywhere, when there are none), less the union of the `hide`
// shapes. A shape of kind `bubble` stores no points: it is a live link to the
// box's bubble outline (`box.fit`, `bubbleOutline`), drawn `inset` px inside
// it, so a refit outline takes the clip with it. A box has at most one.
//
// The painters work in the box's own frame (`maskInBoxFrame`): the frame its
// picture is painted in, before its turn and its flip, after its warp. So the
// mask is cut from the finished picture and is never bent by the box's mesh.

import { meshMap } from './warp.js';

export const MASK_OPS = ['hide', 'keep'];
export const MASK_SHAPES_MAX = 400;
export const BUBBLE_INSET_DEFAULT = 2;
export const BUBBLE_INSET_MAX = 20;
export const MASK_BRUSH_MIN = 2;
export const MASK_BRUSH_MAX = 200;

const finite = (v) => Number.isFinite(v);
const pair = (q) => Array.isArray(q) && finite(+q[0]) && finite(+q[1]);
const points = (pts) => (Array.isArray(pts) ? pts : []).filter(pair).map((q) => [+q[0], +q[1]]);

// One shape as this build reads it, or null for one it cannot draw (a kind it
// does not know, numbers that are not finite): such a shape is dropped rather
// than repaired, as the style's mask always did.
export function normalizeMaskShape(sh) {
  const op = sh?.op === 'keep' ? 'keep' : 'hide';
  if (sh?.kind === 'ellipse') {
    const e = { kind: 'ellipse', op, cx: +sh.cx, cy: +sh.cy, rx: +sh.rx, ry: +sh.ry };
    return finite(e.cx) && finite(e.cy) && e.rx > 0 && e.ry > 0 ? e : null;
  }
  if (sh?.kind === 'poly') {
    const pts = points(sh.pts);
    return pts.length >= 3 ? { kind: 'poly', op, pts } : null;
  }
  if (sh?.kind === 'stroke') {
    const pts = points(sh.pts);
    const size = +sh.size;
    return pts.length >= 1 && size > 0 ? { kind: 'stroke', op, size: Math.min(MASK_BRUSH_MAX, size), pts } : null;
  }
  if (sh?.kind === 'bubble') {
    const inset = +sh.inset;
    return { kind: 'bubble', op: 'keep', inset: finite(inset) ? Math.min(BUBBLE_INSET_MAX, Math.max(0, inset)) : BUBBLE_INSET_DEFAULT };
  }
  return null;
}

// The mask as this build reads it, or null for a box that has none. At most
// one bubble link survives, the first.
export function normalizeMask(m) {
  if (!m || typeof m !== 'object') return null;
  const shapes = [];
  let bubble = false;
  for (const sh of Array.isArray(m.shapes) ? m.shapes : []) {
    const n = normalizeMaskShape(sh);
    if (!n || (n.kind === 'bubble' && bubble)) continue;
    if (n.kind === 'bubble') bubble = true;
    shapes.push(n);
    if (shapes.length >= MASK_SHAPES_MAX) break;
  }
  return { on: m.on === true, shapes };
}

// Whether the mask changes anything: on, with a shape it can draw. A bubble
// link on a box with no outline draws nothing.
export function maskActive(box) {
  const m = box?.mask;
  if (!m?.on) return false;
  return m.shapes.some((sh) => sh.kind !== 'bubble' || bubblePts(box) != null);
}

// The bubble link on the box's mask, or null.
export const bubbleLink = (box) => box?.mask?.shapes?.find((sh) => sh.kind === 'bubble') ?? null;

// The outline the bubble link follows (`box.fit`), as a polygon in page px,
// or null with none. The finder's traced outline is one already; a fit the
// finder stated as an ellipse, a rectangle or a stack of rows is walked round
// as one, so every balloon a box is fitted to can clip it.
export function bubbleOutline(box) {
  const f = box?.fit;
  if (f?.kind === 'poly') return Array.isArray(f.pts) && f.pts.length >= 3 ? f.pts : null;
  if (f?.kind === 'ellipse') return ellipsePolygon(f);
  if (f?.kind === 'rect') return [[f.x, f.y], [f.x + f.w, f.y], [f.x + f.w, f.y + f.h], [f.x, f.y + f.h]];
  if (f?.kind === 'rows' && Array.isArray(f.spans)) {
    // Down the left ends, then up the right: each row's span at its middle.
    const left = [];
    const right = [];
    f.spans.forEach((sp, i) => {
      if (!sp) return;
      const y = f.y0 + (i + 0.5) * f.step;
      left.push([sp[0], y]);
      right.push([sp[1], y]);
    });
    return left.length >= 2 ? [...left, ...right.reverse()] : null;
  }
  return null;
}
const bubblePts = bubbleOutline;

// `pts`, a closed polygon, moved `d` px inside itself: each corner along the
// bisector of its two edges, as far as keeps both edges `d` from where they
// were. A sharp corner would be carried far past its neighbours, so the move
// is capped at four times `d`; on a bubble's smooth outline that cap is never
// met. Fine for the few px an inset is; not a general polygon offset.
export function insetPolygon(pts, d) {
  const n = pts.length;
  if (!(d > 0) || n < 3) return pts.map((p) => [p[0], p[1]]);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % n];
    area += ax * by - bx * ay;
  }
  // The inward side of an edge: left of it for a clockwise run in y-down
  // page px (positive area), right of it otherwise.
  const side = area > 0 ? 1 : -1;
  const normal = (a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [(-dy / len) * side, (dx / len) * side];
  };
  return pts.map((p, i) => {
    const n0 = normal(pts[(i - 1 + n) % n], p);
    const n1 = normal(p, pts[(i + 1) % n]);
    let bx = n0[0] + n1[0];
    let by = n0[1] + n1[1];
    const len = Math.hypot(bx, by);
    if (len < 1e-9) return [p[0] + n0[0] * d, p[1] + n0[1] * d];
    bx /= len;
    by /= len;
    // How far along the bisector keeps an edge `d` away: d / cos(half turn).
    const cos = bx * n0[0] + by * n0[1];
    const k = Math.min(4 * d, d / Math.max(cos, 1e-6));
    return [p[0] + bx * k, p[1] + by * k];
  });
}

// ---- the box's frames ----

// The box's own frame: box-local page px, before its turn and its flip. A
// page point is taken there by moving it to the box's corner, turning it back
// about the box's centre, and mirroring it about the centre on each flipped
// axis (the flip is its own inverse).
export function pageToBox(box, [x, y]) {
  const cx = box.w / 2;
  const cy = box.h / 2;
  let dx = x - box.x - cx;
  let dy = y - box.y - cy;
  const rad = (-(Number(box.style?.rotation) || 0) * Math.PI) / 180;
  if (rad) {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    [dx, dy] = [dx * c - dy * s, dx * s + dy * c];
  }
  if (box.style?.flipH) dx = -dx;
  if (box.style?.flipV) dy = -dy;
  return [cx + dx, cy + dy];
}

// The other way: a point of the box's own frame on the page.
export function boxToPage(box, [x, y]) {
  const cx = box.w / 2;
  const cy = box.h / 2;
  let dx = x - cx;
  let dy = y - cy;
  if (box.style?.flipH) dx = -dx;
  if (box.style?.flipV) dy = -dy;
  const rad = ((Number(box.style?.rotation) || 0) * Math.PI) / 180;
  if (rad) {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    [dx, dy] = [dx * c - dy * s, dx * s + dy * c];
  }
  return [box.x + cx + dx, box.y + cy + dy];
}

// An ellipse as a polygon, for a frame change that would turn it.
const ELLIPSE_STEPS = 48;
function ellipsePolygon(sh) {
  return Array.from({ length: ELLIPSE_STEPS }, (_, i) => {
    const a = (i / ELLIPSE_STEPS) * Math.PI * 2;
    return [sh.cx + sh.rx * Math.cos(a), sh.cy + sh.ry * Math.sin(a)];
  });
}

// `sh` with every point carried by `map`. An ellipse stays one where the map
// is a plain move or mirror (`straight`), and becomes a polygon where it
// turns or bends.
function carried(sh, map, straight) {
  if (sh.kind === 'ellipse') {
    if (straight) {
      const [cx, cy] = map([sh.cx, sh.cy]);
      return { ...sh, cx, cy };
    }
    return { kind: 'poly', op: sh.op, pts: ellipsePolygon(sh).map(map) };
  }
  if (Array.isArray(sh.pts)) return { ...sh, pts: sh.pts.map(map) };
  return sh;
}

const turned = (box) => (Number(box.style?.rotation) || 0) % 360 !== 0;

// The mask's shapes in the box's own frame, ready to paint: each one mapped
// there (`pageToBox`), the bubble link made the outline's polygon inset by
// its px. Shapes that draw nothing are left out. Empty for a mask that is off.
export function maskInBoxFrame(box) {
  if (!box?.mask?.on) return [];
  const map = (p) => pageToBox(box, p);
  const straight = !turned(box);
  const out = [];
  for (const sh of box.mask.shapes) {
    if (sh.kind === 'bubble') {
      const pts = bubblePts(box);
      if (pts) out.push({ kind: 'poly', op: 'keep', pts: insetPolygon(pts, sh.inset).map(map) });
    } else out.push(carried(sh, map, straight));
  }
  return out;
}

// The page px the mask's shapes are drawn on, as they stand (`maskInBoxFrame`
// in page px): the bubble link resolved to its inset outline.
export function maskOnPage(box) {
  if (!box?.mask) return [];
  const out = [];
  for (const sh of box.mask.shapes) {
    if (sh.kind === 'bubble') {
      const pts = bubblePts(box);
      if (pts) out.push({ kind: 'poly', op: 'keep', pts: insetPolygon(pts, sh.inset) });
    } else out.push(sh);
  }
  return out;
}

// ---- carrying a mask with the page ----

// Every shape moved by (dx, dy) page px.
export function translateMask(mask, dx, dy) {
  if (!mask) return mask;
  return { ...mask, shapes: mask.shapes.map((sh) => carried(sh, ([x, y]) => [x + dx, y + dy], true)) };
}

// Every shape scaled by (sx, sy) about the page's corner, as a page rescale
// scales `fit`. A brush keeps its round end at the mean of the two.
export function scaleMask(mask, sx, sy) {
  if (!mask) return mask;
  return {
    ...mask,
    shapes: mask.shapes.map((sh) => {
      if (sh.kind === 'ellipse') return { ...sh, cx: sh.cx * sx, cy: sh.cy * sy, rx: sh.rx * sx, ry: sh.ry * sy };
      if (sh.kind === 'bubble') return sh;
      const out = { ...sh, pts: sh.pts.map(([x, y]) => [x * sx, y * sy]) };
      if (sh.kind === 'stroke') out.size = sh.size * Math.sqrt(Math.abs(sx * sy));
      return out;
    }),
  };
}

// ---- the old mask ----

// The mask an old box kept in its style (`style.clip`, shapes in its own
// frame before its warp, one mode for all), carried to the page through the
// box as it stood: its warp, its flip, its turn and its corner. An ellipse on
// a turned or warped box becomes a polygon. Null when the style has none.
export function maskFromClip(box) {
  const clip = box?.style?.clip;
  if (!clip || typeof clip !== 'object') return null;
  const op = clip.mode === 'include' ? 'keep' : 'hide';
  const s = box.style;
  const w = s.warp;
  const mesh = w?.on && Array.isArray(w.pts) ? meshMap(w.pts, w.cols, w.rows, box.w, box.h) : null;
  const map = (p) => boxToPage(box, mesh ? mesh.at(p[0], p[1]) : p);
  const straight = !mesh && !turned(box);
  const shapes = [];
  for (const raw of Array.isArray(clip.shapes) ? clip.shapes : []) {
    const sh = normalizeMaskShape({ ...raw, op });
    if (sh && sh.kind !== 'bubble') shapes.push(carried(sh, map, straight));
  }
  if (!shapes.length && !clip.on) return null;
  return { on: clip.on === true, shapes };
}
