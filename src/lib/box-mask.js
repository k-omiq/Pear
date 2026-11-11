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
  return m.shapes.some((sh) => sh.kind !== 'bubble' || linkClip(box, sh.inset) != null);
}

// `bubbleClip` of the box's outline, kept with the fit until it or the inset
// changes: every writer of `box.fit` puts a new object there (`frameKey`
// keys on it so), and the exporter, the containment check and the store ask
// several times a box. The polygon is shared; nobody may change it.
const linkClips = new WeakMap();
export function linkClip(box, inset) {
  const f = box?.fit;
  if (!f || typeof f !== 'object') return bubbleClip(bubblePts(box), inset);
  const hit = linkClips.get(f);
  if (hit && Object.is(hit.inset, inset)) return hit.out;
  const out = bubbleClip(bubblePts(box), inset);
  linkClips.set(f, { inset, out });
  return out;
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

const signedArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    a += ax * by - bx * ay;
  }
  return a / 2;
};

// The polygon a bubble link keeps, page px: the outline inset by its px, the
// inset capped at a quarter of the outline's shorter side, so a narrow bubble
// keeps a band of itself. Where the inset outline still turns inside out (a
// sharp waist), the outline with no inset. Null for an outline with no area:
// a link never hides the whole box, it shows it whole instead.
export function bubbleClip(pts, inset) {
  if (!pts || pts.length < 3) return null;
  const area = signedArea(pts);
  if (Math.abs(area) < 1) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const short = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const d = Math.min(inset, short / 4);
  const inner = insetPolygon(pts, d);
  const a = signedArea(inner);
  const kept = Math.sign(a) === Math.sign(area) && Math.abs(a) < Math.abs(area) && Math.abs(a) >= 1;
  // The total area alone misses a narrow spike or waist whose sides passed
  // each other: the loop turned inside out there while the rest kept the
  // sign. Any crossing means the inset is not a band of the bubble.
  return kept && !crossesItself(inner) ? inner : pts.map((p) => [p[0], p[1]]);
}

// Whether two edges of a closed polygon cross or run over each other (edges
// that share a corner do not count). An inset spike folds back on itself
// either way: its sides pass each other, or they swap and lie along the
// base. Outlines are a few hundred points, so the plain pairwise check is
// cheap next to the raster.
export function crossesItself(pts) {
  const n = pts.length;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (ab < 1e-9) continue;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = pts[j];
      const d = pts[(j + 1) % n];
      if (Math.max(c[0], d[0]) < Math.min(a[0], b[0]) || Math.min(c[0], d[0]) > Math.max(a[0], b[0])) continue;
      if (Math.max(c[1], d[1]) < Math.min(a[1], b[1]) || Math.min(c[1], d[1]) > Math.max(a[1], b[1])) continue;
      const cd = Math.hypot(d[0] - c[0], d[1] - c[1]);
      if (cd < 1e-9) continue;
      // Within a hair of the line counts as on it: the inset's sums leave
      // the last bits of a straight edge's points unequal.
      const eps = 1e-9 * ab * cd;
      const side = (v) => (v > eps ? 1 : v < -eps ? -1 : 0);
      const d1 = side(cross(c, d, a));
      const d2 = side(cross(c, d, b));
      const d3 = side(cross(a, b, c));
      const d4 = side(cross(a, b, d));
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
      if (d1 === 0 && d2 === 0) {
        // On one line: they run over each other where their spans along it
        // overlap by more than a point.
        const ux = (b[0] - a[0]) / ab;
        const uy = (b[1] - a[1]) / ab;
        const t = (p) => (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
        const lo = Math.max(0, Math.min(t(c), t(d)));
        const hi = Math.min(ab, Math.max(t(c), t(d)));
        if (hi - lo > 1e-6) return true;
      }
    }
  }
  return false;
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

// An ellipse as a polygon whose steps are 4 px or less up to a page-size
// one (a radius of about 2500 px), so a wide ellipse never shows its corners;
// past that the count stays at the cap, and a stray huge radius costs no
// more than that.
const ELLIPSE_RING_MAX = 4096;
function ellipseRing(sh) {
  const n = Math.min(ELLIPSE_RING_MAX, Math.max(ELLIPSE_STEPS, Math.ceil((Math.PI * 2 * Math.max(sh.rx, sh.ry)) / 4) || ELLIPSE_STEPS));
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
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
    // Whatever else the shape carries (a mask's op, a fade's strength and
    // soft edge) goes with it.
    const { cx: _cx, cy: _cy, rx: _rx, ry: _ry, ...rest } = sh;
    return { ...rest, kind: 'poly', pts: ellipsePolygon(sh).map(map) };
  }
  if (Array.isArray(sh.pts)) return { ...sh, pts: sh.pts.map(map) };
  return sh;
}

const turned = (box) => (Number(box.style?.rotation) || 0) % 360 !== 0;

// The mask's shapes in the box's own frame, ready to paint: each one mapped
// there (`pageToBox`), the bubble link made the outline's polygon inset by
// its px. Shapes that draw nothing are left out. Empty for a mask that is off.
// For a held box (`pinMove`) they are moved on by its move.
export function maskInBoxFrame(box) {
  return shiftedShapes(heldMaskInBoxFrame(box), pinShiftOf(box));
}

// `maskInBoxFrame` as the box stands, whatever its `pinMove`: what the
// engine takes, with the move apart (`pinShiftOf`). Worked out once for each
// mask and place: a brush mask holds up to 400 strokes, and a move frame
// must not map them all again. The list is shared; nobody may change it.
const heldMasks = new WeakMap();
export function heldMaskInBoxFrame(box) {
  if (!box?.mask?.on) return [];
  return memoFrame(heldMasks, box, box.mask, () => {
    const map = (p) => pageToBox(box, p);
    const straight = !turned(box);
    const out = [];
    for (const sh of box.mask.shapes) {
      if (sh.kind === 'bubble') {
        const clip = linkClip(box, sh.inset);
        if (clip) out.push({ kind: 'poly', op: 'keep', pts: clip.map(map) });
      } else out.push(carried(sh, map, straight));
    }
    return out;
  });
}

// What `make` gives for the shapes of `o` (a mask or a fade) as `box` stands,
// kept with the shape list until the list or the place changes
// (`frameKey`).
export function memoFrame(memo, box, o, make) {
  const shapes = o?.shapes;
  if (!shapes || typeof shapes !== 'object') return make();
  const key = frameKey(box, o);
  const hit = memo.get(shapes);
  if (hit?.key === key) return hit.out;
  const out = make();
  memo.set(shapes, { key, out });
  return out;
}

// ---- a held box's move ----

// A box with a mask or a fade is painted where it stood while it is moved
// (TextBox's `paintedBox`), and `box.pinMove` (page px) says how far its
// page-pinned shapes have moved against it since. This is that move in the
// box's own frame, which is the engine's job units; null for none.
export function pinShiftOf(box) {
  const m = box?.pinMove;
  if (!Array.isArray(m) || (!m[0] && !m[1])) return null;
  const o = pageToBox(box, [0, 0]);
  const p = pageToBox(box, m);
  return [p[0] - o[0], p[1] - o[1]];
}

// Shapes in the box's frame moved by `v` (a `pinShiftOf`); the same list for
// none.
export function shiftedShapes(shapes, v) {
  if (!v) return shapes;
  return shapes.map((sh) => carried(sh, ([x, y]) => [x + v[0], y + v[1]], true));
}

// ---- what a picture keys on ----

// The revision of a mask, a fade, its shape list or a fit: a number that is
// new whenever the object is. Every writer of `box.mask` and `box.fade` (the
// panels, the draw tool, undo, a page rescale, loading) puts a new object or
// a new shape list there and none edits a shape in place, so the objects
// themselves are the revision, and a key never has to read the shapes - a
// brush mask holds up to 400 strokes, and a move frame must not walk them.
const revs = new WeakMap();
let lastRev = 0;
export function revOf(o) {
  if (!o || typeof o !== 'object') return 0;
  let r = revs.get(o);
  if (!r) revs.set(o, (r = ++lastRev));
  return r;
}

// A short key for page-pinned shapes (`o`, a mask or a fade) in the box's own
// frame: what `maskInBoxFrame` and `shapesInBoxFrame` read besides the shapes
// - where the box stands, its size, turn and flips, and for a bubble link the
// outline it follows.
export function frameKey(box, o) {
  const s = box.style;
  const link = o?.shapes?.some?.((sh) => sh.kind === 'bubble') ? `:${revOf(box.fit)}` : '';
  return `${revOf(o)}.${revOf(o?.shapes)}.${o?.on ? 1 : 0}:${box.x},${box.y},${box.w},${box.h},${Number(s?.rotation) || 0},${s?.flipH ? 1 : 0}${s?.flipV ? 1 : 0}${link}`;
}

// Any page-pinned shapes (the fade's, box-fade.js) in the box's own frame,
// one for each and in their order, as the mask's are carried there.
export function shapesInBoxFrame(box, shapes) {
  const map = (p) => pageToBox(box, p);
  const straight = !turned(box);
  return shapes.map((sh) => carried(sh, map, straight));
}

// Shapes stated in the box's own frame (the paint's marks, box-paint.js)
// carried onto the page as the box stands there, one for each and in their
// order: the other way from `shapesInBoxFrame`.
export function shapesOnPage(box, shapes) {
  const map = (p) => boxToPage(box, p);
  const straight = !turned(box);
  return shapes.map((sh) => carried(sh, map, straight));
}

// The page px the mask's shapes are drawn on, as they stand (`maskInBoxFrame`
// in page px): the bubble link resolved to its inset outline.
export function maskOnPage(box) {
  if (!box?.mask) return [];
  const out = [];
  for (const sh of box.mask.shapes) {
    if (sh.kind === 'bubble') {
      const clip = linkClip(box, sh.inset);
      if (clip) out.push({ kind: 'poly', op: 'keep', pts: clip });
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
      // A bubble link's outline is scaled with the page's fit; its inset, a
      // length, by the mean of the two, as a brush's width.
      if (sh.kind === 'bubble') return { ...sh, inset: Math.min(BUBBLE_INSET_MAX, sh.inset * Math.sqrt(Math.abs(sx * sy))) };
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
// `pts` with every edge cut into steps of at most `step` px, the last point
// kept (closed: the closing edge cut too, its end not repeated). A straight
// edge in the box's frame is a curve once a mesh has carried it, so it is cut
// before it is carried, as the old outline drawer did.
// At most about DENSIFY_MAX points come out: past that the step grows, so a
// stray huge shape costs no more than a page-size one.
const DENSIFY_MAX = 8192;
function densify(pts, closed, step = 4) {
  const out = [];
  const n = closed ? pts.length : pts.length - 1;
  let length = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    length += Math.hypot(bx - ax, by - ay);
  }
  if (length / step > DENSIFY_MAX) step = length / DENSIFY_MAX;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let j = 0; j < k; j++) out.push([ax + ((bx - ax) * j) / k, ay + ((by - ay) * j) / k]);
  }
  if (!closed && pts.length) out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  return out;
}

// How much wider a line running along `t` (a unit vector) at `m` comes out of
// the mesh: the area it stretches by over the length it stretches the line
// by, read off the mesh by differences half a px either side. Exact where the
// mesh is locally affine.
function widthScale(mesh, m, t) {
  const e = 0.5;
  const [x1, y1] = mesh.at(m[0] + e, m[1]);
  const [x0, y0] = mesh.at(m[0] - e, m[1]);
  const [x3, y3] = mesh.at(m[0], m[1] + e);
  const [x2, y2] = mesh.at(m[0], m[1] - e);
  const a = (x1 - x0) / (2 * e);
  const b = (y1 - y0) / (2 * e);
  const c = (x3 - x2) / (2 * e);
  const d = (y3 - y2) / (2 * e);
  const det = Math.abs(a * d - b * c);
  if (!t) return Math.sqrt(det);
  const along = Math.hypot(a * t[0] + c * t[1], b * t[0] + d * t[1]);
  return along > 1e-9 ? det / along : Math.sqrt(det);
}

// A brush stroke carried through a mesh, as strokes of one width each: the
// line cut into steps of 4 px and carried point by point, its width scaled
// by how much the mesh widens a line there (`widthScale`). A run of steps
// whose widths lie within 5 % of each other is one stroke at their mean, so
// a width is at most 2.5 % off the mesh's own, plus what the mesh bends
// inside one 4 px step.
function strokeThroughMesh(sh, mesh, map) {
  const pts = densify(sh.pts, false);
  if (pts.length < 2) return [{ ...sh, size: sh.size * widthScale(mesh, pts[0] ?? sh.pts[0], null), pts: pts.map(map) }];
  const out = [];
  let run = [pts[0]];
  let ks = [];
  const flush = () => {
    const k = ks.reduce((s, v) => s + v, 0) / ks.length;
    out.push({ ...sh, size: sh.size * k, pts: run.map(map) });
  };
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const len = Math.hypot(bx - ax, by - ay);
    const k = widthScale(mesh, [(ax + bx) / 2, (ay + by) / 2], len > 1e-9 ? [(bx - ax) / len, (by - ay) / len] : null);
    const lo = Math.min(k, ...ks);
    const hi = Math.max(k, ...ks);
    if (ks.length && hi > lo * 1.05) {
      flush();
      run = [pts[i - 1]];
      ks = [];
    }
    run.push(pts[i]);
    ks.push(k);
  }
  flush();
  return out;
}

// One shape carried by `at` (a page or box point to a point) where the map
// bends, as one shape: its edges cut into steps of 4 px first so they follow
// the bend, an ellipse as the polygon of its ring, a brush's points the same
// and its width scaled by how much the map widens a line at its middle
// (`widthScale`). Whatever else the shape carries goes with it.
//
// `at` may answer null for a point it cannot carry (`unwarpWith` where the
// mesh does not reach): then the shape is null, never a shorter one joined
// across the gap. `bendStrokeRuns` cuts a brush stroke at its gaps instead.
// The width is read at the point nearest the middle that it carries.
//
// Once a stroke is enough for its width: a mark is stored on the box's
// surface and the mesh bends it with the letters, so along a perspective it
// narrows and widens as they do. The factor only sets the width the user
// drew at the stroke's middle; a width per point would need the engine to
// take one (its stroke has a single size), or one stroke cut into many
// marks, which a pick, a move and an undo would then see as many.
//
// `at(p, prev)` is handed the point before it in the run, `{ p, q }` (where
// it was and where `at` put it), or null at a run's start: a map with more
// than one answer for a point takes the one near `prev.q`. `joins(prev, p,
// q)`, when given, says whether q follows prev in one piece of the shape;
// where it does not (the next point is on another sheet of a folded mesh),
// the shape is cut there as at a gap.
export function bendShape(sh, at, joins = null) {
  const runs = bendRuns(sh, at, joins);
  return runs && runs.length === 1 && runs[0].whole ? runs[0].shape : null;
}

// A brush stroke carried by `at` as `bendShape` does, cut where `at` cannot
// carry a point: one stroke for each stretch it carries, never a straight
// segment across a gap. Any other shape is `bendShape`'s, or nothing.
export function bendStrokeRuns(sh, at, joins = null) {
  if (sh.kind !== 'stroke') {
    const one = bendShape(sh, at, joins);
    return one ? [one] : [];
  }
  return (bendRuns(sh, at, joins) ?? []).map((r) => r.shape);
}

function bendRuns(sh, at, joins) {
  // Each stretch of points `at` carries in one piece; `whole` when nothing
  // was dropped or cut. `qs[i]` is where pts[i] went, null where it did not.
  const carry = (pts, closedShape = false) => {
    const runs = [[]];
    const qs = [];
    let whole = true;
    let prev = null;
    for (const p of pts) {
      const raw = at(p, prev);
      const q = raw && Number.isFinite(raw[0]) && Number.isFinite(raw[1]) ? raw : null;
      qs.push(q);
      if (q && prev && joins && !joins(prev, p, q)) {
        whole = false;
        runs.push([]);
      }
      if (q) {
        runs[runs.length - 1].push(q);
        prev = { p, q };
      } else {
        whole = false;
        prev = null;
        if (runs[runs.length - 1].length) runs.push([]);
      }
    }
    // A closed shape's closing edge is one piece too.
    if (closedShape && whole && joins && prev && qs[0] && !joins(prev, pts[0], qs[0])) whole = false;
    return { runs: runs.filter((r) => r.length), qs, whole };
  };
  if (sh.kind === 'stroke') {
    const pts = densify(sh.pts, false);
    const { runs, qs, whole } = carry(pts);
    if (!runs.length) return null;
    let k = NaN;
    const mid = pts.length >> 1;
    for (let d = 0; d <= mid + 1 && !Number.isFinite(k); d++) {
      for (const i of [mid - d, mid + d]) {
        if (i < 0 || i >= pts.length || Number.isFinite(k) || !qs[i]) continue;
        const near = { p: pts[i], q: qs[i] };
        const safe = { at: (x, y) => at([x, y], near) ?? [NaN, NaN] };
        const v = widthScale(safe, pts[i], null);
        if (Number.isFinite(v) && v > 0) k = v;
      }
    }
    const size = sh.size * (Number.isFinite(k) ? k : 1);
    return runs.map((moved) => ({ shape: { ...sh, size, pts: moved }, whole }));
  }
  // A closed shape with a point it cannot carry is not drawn at all.
  const closed = (pts, make) => {
    const { runs, whole } = carry(pts, true);
    return whole && runs.length === 1 && runs[0].length >= 3 ? [{ shape: make(runs[0]), whole }] : null;
  };
  if (sh.kind === 'ellipse') {
    const { cx: _cx, cy: _cy, rx: _rx, ry: _ry, ...rest } = sh;
    return closed(densify(ellipseRing(sh), true), (pts) => ({ ...rest, kind: 'poly', pts }));
  }
  if (sh.kind === 'poly') return closed(densify(sh.pts, true), (pts) => ({ ...sh, pts }));
  return [{ shape: sh, whole: true }];
}

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
    if (!sh || sh.kind === 'bubble') continue;
    if (!mesh) shapes.push(carried(sh, map, straight));
    // Through a mesh an edge bends and a line widens: the edges are cut
    // before they are carried, and a brush keeps the width the mesh gave it.
    else if (sh.kind === 'stroke') shapes.push(...strokeThroughMesh(sh, mesh, map));
    else {
      const ring = sh.kind === 'ellipse' ? ellipseRing(sh) : sh.pts;
      shapes.push({ kind: 'poly', op, pts: densify(ring, true).map(map) });
    }
  }
  if (!shapes.length && !clip.on) return null;
  return { on: clip.on === true, shapes };
}
