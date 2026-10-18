// ===== the bubble outline as a polygon =====
//
// The outline is the truth a letterer works to: the inside edge of the
// balloon's ink, as the finder traced it (bubble-outline.js) or the user drew
// it. Layout used to read it only through the shape that explains it
// (`layoutShape` in balloon.js: an ellipse, a rectangle, or bands of rows), and
// that shape can sit a few px off the real outline. The outline fit
// (outline-fit.js) and the fit report (fit-report.js) read the polygon itself,
// through the few questions below. Pure, page px, y down.

import { normalizeFit } from './data.js';

const ELLIPSE_STEPS = 64;

// Any fit as a closed polygon, or null. A `poly` is its own points; an
// ellipse is sampled; a rectangle is its corners; `rows` are the bands' edges,
// down the left side and up the right.
export function fitPolygon(fit) {
  const f = normalizeFit(fit);
  if (!f) return null;
  if (f.kind === 'poly') return f.pts.length >= 3 ? f.pts.map(([x, y]) => [x, y]) : null;
  if (f.kind === 'ellipse') {
    return Array.from({ length: ELLIPSE_STEPS }, (_, i) => {
      const t = (2 * Math.PI * i) / ELLIPSE_STEPS;
      return [f.cx + f.rx * Math.cos(t), f.cy + f.ry * Math.sin(t)];
    });
  }
  if (f.kind === 'rect') return [[f.x, f.y], [f.x + f.w, f.y], [f.x + f.w, f.y + f.h], [f.x, f.y + f.h]];
  if (f.kind === 'rows') {
    const left = [];
    const right = [];
    f.spans.forEach((sp, i) => {
      if (!sp) return;
      const a = f.y0 + i * f.step;
      left.push([sp[0], a], [sp[0], a + f.step]);
      right.push([sp[1], a], [sp[1], a + f.step]);
    });
    return left.length ? [...left, ...right.reverse()] : null;
  }
  return null;
}

// The interior on the horizontal line at `y`, as sorted [l, r] pairs
// (even-odd rule).
export function intervalsAt(pts, y) {
  const xs = [];
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const yi = pts[i][1];
    const yj = pts[j][1];
    if (yi > y !== yj > y) xs.push(pts[i][0] + ((y - yi) * (pts[j][0] - pts[i][0])) / (yj - yi));
  }
  xs.sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] > xs[k]) out.push([xs[k], xs[k + 1]]);
  return out;
}

// The same down the vertical line at `x`.
export function intervalsDown(pts, x) {
  return intervalsAt(pts.map(([px, py]) => [py, px]), x);
}

const EPS = 1e-6;

// The room the outline has across the whole band [y0, y1]: the narrowest of
// its intervals at the band's top, its bottom and every vertex between, each
// time the piece that overlaps the room so far the most - seeded with the piece
// at the band's middle that holds `near` (or the widest). A line set in the
// band never crosses the outline anywhere along it. Null when some height of
// the band has no interior there (the band is past the top or the bottom).
export function roomOver(pts, y0, y1, near = null) {
  const mid = intervalsAt(pts, (y0 + y1) / 2);
  if (!mid.length) return null;
  let cut = (near != null && mid.find(([l, r]) => near >= l && near <= r)) || mid.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  let [l, r] = cut;
  const ys = [y0 + EPS, y1 - EPS];
  for (const p of pts) if (p[1] > y0 && p[1] < y1) ys.push(p[1]);
  for (const y of ys) {
    let pick = null;
    let over = 0;
    for (const iv of intervalsAt(pts, y)) {
      const o = Math.min(r, iv[1]) - Math.max(l, iv[0]);
      if (o > over) {
        over = o;
        pick = iv;
      }
    }
    if (!pick) return null;
    l = Math.max(l, pick[0]);
    r = Math.min(r, pick[1]);
  }
  return r > l ? [l, r] : null;
}

export function polyBounds(pts) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(a / 2);
}

// Whether an outline is a rectangle - a caption frame, a box drawn as its own
// outline - rather than a balloon: it fills nearly all of its bounds, square
// or rounded corners alike, where an oval fills a quarter of pi (0.79) of
// them. Text in one is set as a rectangular block, not an oval.
export const RECT_FILL = 0.9;
export function isRectOutline(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return false;
  const b = polyBounds(pts);
  return b.w > 0 && b.h > 0 && polyArea(pts) / (b.w * b.h) >= RECT_FILL;
}

// Where a reader sees the middle of the balloon: the interior's centroid. The
// finder has already opened the tail off the outline, so what is left is the
// body the text belongs in.
export function visualCentre(pts) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [x0, y0] = pts[j];
    const [x1, y1] = pts[i];
    const k = x0 * y1 - x1 * y0;
    a += k;
    cx += (x0 + x1) * k;
    cy += (y0 + y1) * k;
  }
  if (Math.abs(a) < EPS) {
    const b = polyBounds(pts);
    return [b.x + b.w / 2, b.y + b.h / 2];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

// The polygon turned by `deg` degrees about (cx, cy) - clockwise on screen for
// a positive angle, as a box's rotation is.
export function turnPolygon(pts, deg, cx, cy) {
  if (!deg) return pts;
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
}
