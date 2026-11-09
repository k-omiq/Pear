// A contour's curve, read as the engine reads it: for the contour editor's
// preview, so the line drawn is the one the shadow, glow or bevel falls off
// along.
//
// A port of the engine's `points`, `through` and `spline` in
// text-engine/src/paint/fx/contour.rs, which are PhotoCraft's reading of a
// curve (`contour_curve_lut`, crates/compose/src/adjust/tone.rs, Copyright (c)
// 2026 ArtCraft Team and the PhotoCraft contributors, MIT licence, see
// text-engine/THIRD_PARTY.md): straight before the first point and after the
// last, a natural cubic spline through each run of points between corners, a
// smooth point at a repeated x dropped. contour-curve.test.js holds it to the
// engine's table.
import { CONTOUR_PRESET_POINTS } from './contour-presets.js';

/**
 * A contour's points from 0 to 255 as `[x, y, corner]`, a preset's read from
 * its table, a custom one's with the smooth points at a repeated x taken out
 * (as `normalizeContour` and the engine's `points` do).
 */
export function contourPoints(c) {
  if (c?.preset === 'custom' && Array.isArray(c.pts) && c.pts.length >= 2) {
    const pts = c.pts.map((q) => [+q[0], +q[1], q[2] === true]);
    return pts.filter((q, i) => {
      let lo = i;
      let hi = i;
      while (lo > 0 && pts[lo - 1][0] === q[0]) lo--;
      while (hi + 1 < pts.length && pts[hi + 1][0] === q[0]) hi++;
      return pts.slice(lo, hi + 1).some((p) => p[2]) ? q[2] : i === lo;
    });
  }
  const preset = CONTOUR_PRESET_POINTS[c?.preset] ?? CONTOUR_PRESET_POINTS.linear;
  return preset.map(([x, y, corner]) => [x * 255, y * 255, corner]);
}

// A natural cubic spline through `pts` (0..255) at `x`, which is within them.
function spline(pts, x) {
  const n = pts.length;
  if (n === 2) {
    const [a, b] = pts;
    const w = b[0] - a[0];
    return w > 0 ? a[1] + ((b[1] - a[1]) * (x - a[0])) / w : b[1];
  }
  // Second derivatives by the tridiagonal system, zero at both ends.
  const m = new Array(n).fill(0);
  const c = new Array(n).fill(0);
  const d = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const h0 = Math.max(pts[i][0] - pts[i - 1][0], 1e-9);
    const h1 = Math.max(pts[i + 1][0] - pts[i][0], 1e-9);
    const rhs = 6 * ((pts[i + 1][1] - pts[i][1]) / h1 - (pts[i][1] - pts[i - 1][1]) / h0);
    const diag = 2 * (h0 + h1) - h0 * c[i - 1];
    c[i] = h1 / diag;
    d[i] = (rhs - h0 * d[i - 1]) / diag;
  }
  for (let i = n - 2; i >= 1; i--) m[i] = d[i] - c[i] * m[i + 1];
  let i = pts.findIndex((p, k) => k > 0 && x <= p[0]) - 1;
  if (i < 0) i = n - 2;
  const [a, b] = [pts[i], pts[i + 1]];
  const h = Math.max(b[0] - a[0], 1e-9);
  const u = (b[0] - x) / h;
  const v = (x - a[0]) / h;
  return u * a[1] + v * b[1] + (((u * u * u - u) * m[i] + (v * v * v - v) * m[i + 1]) * h * h) / 6;
}

/** The curve through `pts` (from `contourPoints`) at `t`, both 0 to 1. */
export function contourAt(pts, t) {
  const x = t * 255;
  if (!pts.length) return t;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length === 1 || x <= first[0]) return first[1] / 255;
  if (x >= last[0]) return last[1] / 255;
  // The run of points between corners that holds `x`.
  let seg = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    if (x >= pts[k][0] && x <= pts[k + 1][0]) {
      seg = k;
      break;
    }
  }
  let lo = seg;
  while (lo > 0 && !pts[lo][2]) lo--;
  let hi = seg + 1;
  while (hi < pts.length - 1 && !pts[hi][2]) hi++;
  return spline(pts.slice(lo, hi + 1), x) / 255;
}

/** The contour baked to 256 levels, as the engine's `Lut::new`. */
export function contourLut(c) {
  const pts = contourPoints(c);
  return Array.from({ length: 256 }, (_, i) => Math.round(Math.min(1, Math.max(0, contourAt(pts, i / 255))) * 255));
}
