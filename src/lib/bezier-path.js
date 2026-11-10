// Editing maths for the bezier text path (`style.path.pts`).
//
// An anchor is `{ x, y, ix, iy, ox, oy }` in box-local page px: the point and
// its in/out handles as offsets from it. Segment A->B is the cubic A, A+out,
// B+in, B. Every renderer (measure.js `pathLayout`, the export through
// contain.js) reads only those six numbers.
//
// `auto: true` marks a SMOOTH anchor: its handles are not the user's, they are
// worked out from its neighbours (`smoothPath`) every time the path is edited
// and written back as ordinary numbers. So the flag is editing state only - a
// renderer that has never heard of it draws the curve the editor shows, and a
// path saved before the flag existed has none and keeps its handles exactly.
//
// Everything here is pure and returns new arrays; nothing mutates its input.

// How far a smooth anchor's handle reaches, as a share of the distance to the
// neighbour on that side. A third is the classic choice: a run of evenly spaced
// smooth anchors then bends like a natural spline, without overshoot.
const SMOOTH_REACH = 1 / 3;

const copy = (p) => ({ ...p });

// Recompute the handles of every smooth anchor. Corner and hand-set anchors
// (no `auto`) keep theirs. Interior anchors take a tangent parallel to the
// chord between their neighbours; an end anchor aims its one handle at the
// neighbour's near control point, so a path's ends leave as smoothly as its
// middle bends. Returns the input itself when no anchor is smooth.
export function smoothPath(pts) {
  if (!Array.isArray(pts) || pts.length < 2 || !pts.some((p) => p?.auto)) return pts;
  const out = pts.map(copy);
  const n = out.length;
  for (let i = 1; i < n - 1; i++) {
    const p = out[i];
    if (!p.auto) continue;
    const a = out[i - 1];
    const b = out[i + 1];
    const tx = b.x - a.x;
    const ty = b.y - a.y;
    const tl = Math.hypot(tx, ty);
    if (!(tl > 0)) {
      p.ix = p.iy = p.ox = p.oy = 0;
      continue;
    }
    const ux = tx / tl;
    const uy = ty / tl;
    const d1 = Math.hypot(p.x - a.x, p.y - a.y) * SMOOTH_REACH;
    const d2 = Math.hypot(b.x - p.x, b.y - p.y) * SMOOTH_REACH;
    // `|| 0` folds -0 into 0, so a level handle saves as 0.
    p.ix = -ux * d1 || 0;
    p.iy = -uy * d1 || 0;
    p.ox = ux * d2 || 0;
    p.oy = uy * d2 || 0;
  }
  // The ends after the middle: each aims at a control point just worked out.
  const end = (i, j, inSide) => {
    const p = out[i];
    if (!p.auto) return;
    const q = out[j];
    // The neighbour's control point facing this end, or (for a two-anchor
    // path, where the neighbour is an end too) the neighbour itself.
    const cx = n === 2 ? q.x : q.x + (inSide ? q.ox : q.ix);
    const cy = n === 2 ? q.y : q.y + (inSide ? q.oy : q.iy);
    const f = n === 2 ? SMOOTH_REACH : 0.5;
    const hx = (cx - p.x) * f || 0;
    const hy = (cy - p.y) * f || 0;
    if (inSide) {
      p.ix = hx;
      p.iy = hy;
      p.ox = p.oy = 0;
    } else {
      p.ox = hx;
      p.oy = hy;
      p.ix = p.iy = 0;
    }
  };
  end(0, 1, false);
  end(n - 1, n - 2, true);
  return out;
}

// Split segment `seg` (anchors seg and seg+1) at `t` in (0, 1). De Casteljau,
// so the curve through the new anchor is exactly the curve that was there. The
// new anchor is smooth when both ends of its segment are; then the whole path
// is re-smoothed, which is what a smooth path would have done anyway.
// Returns `{ pts, index }` - the new array and where the new anchor sits.
export function splitPath(pts, seg, t) {
  if (!Array.isArray(pts) || pts.length < 2 || !(seg >= 0 && seg < pts.length - 1)) return { pts, index: -1 };
  const tt = Math.min(0.999, Math.max(0.001, Number(t) || 0.5));
  const a = pts[seg];
  const b = pts[seg + 1];
  const lerp = (u, v) => [u[0] + (v[0] - u[0]) * tt, u[1] + (v[1] - u[1]) * tt];
  const p0 = [a.x, a.y];
  const c1 = [a.x + a.ox, a.y + a.oy];
  const c2 = [b.x + b.ix, b.y + b.iy];
  const p3 = [b.x, b.y];
  const q0 = lerp(p0, c1);
  const q1 = lerp(c1, c2);
  const q2 = lerp(c2, p3);
  const r0 = lerp(q0, q1);
  const r1 = lerp(q1, q2);
  const m = lerp(r0, r1);
  const out = pts.map(copy);
  out[seg].ox = q0[0] - a.x;
  out[seg].oy = q0[1] - a.y;
  out[seg + 1].ix = q2[0] - b.x;
  out[seg + 1].iy = q2[1] - b.y;
  const mid = { x: m[0], y: m[1], ix: r0[0] - m[0], iy: r0[1] - m[1], ox: r1[0] - m[0], oy: r1[1] - m[1] };
  if (a.auto && b.auto) mid.auto = true;
  out.splice(seg + 1, 0, mid);
  return { pts: mid.auto ? smoothPath(out) : out, index: seg + 1 };
}

function bezAt(a, b, t) {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return [
    w0 * a.x + w1 * (a.x + a.ox) + w2 * (b.x + b.ix) + w3 * b.x,
    w0 * a.y + w1 * (a.y + a.oy) + w2 * (b.y + b.iy) + w3 * b.y,
  ];
}

// The point of the path nearest (x, y): `{ seg, t, d }`, `d` its distance.
// A coarse pass over every segment, then a fine one around the best sample -
// a few hundred evaluations, cheap enough for a pointer press.
export function nearestOnPath(pts, x, y) {
  let best = { seg: -1, t: 0, d: Infinity };
  if (!Array.isArray(pts) || pts.length < 2) return best;
  const COARSE = 32;
  const dist = (s, t) => {
    const [px, py] = bezAt(pts[s], pts[s + 1], t);
    return Math.hypot(px - x, py - y);
  };
  for (let s = 0; s < pts.length - 1; s++) {
    for (let k = 0; k <= COARSE; k++) {
      const t = k / COARSE;
      const d = dist(s, t);
      if (d < best.d) best = { seg: s, t, d };
    }
  }
  const FINE = 16;
  const lo = Math.max(0, best.t - 1 / COARSE);
  const hi = Math.min(1, best.t + 1 / COARSE);
  for (let k = 0; k <= FINE; k++) {
    const t = lo + ((hi - lo) * k) / FINE;
    const d = dist(best.seg, t);
    if (d < best.d) best = { seg: best.seg, t, d };
  }
  return best;
}

// Flip one anchor between smooth and corner. A smooth anchor becomes a sharp
// corner (handles gone); any other anchor - a corner or one whose handles the
// user dragged - becomes smooth again.
export function toggleSmooth(pts, i) {
  if (!Array.isArray(pts) || !pts[i]) return pts;
  const out = pts.map(copy);
  const p = out[i];
  if (p.auto) {
    delete p.auto;
    p.ix = p.iy = p.ox = p.oy = 0;
    return out;
  }
  p.auto = true;
  return smoothPath(out);
}

// A ready-made path across a box `w` by `h`, every anchor smooth:
//   bumps 0 - a straight line through the middle (the path a box starts with)
//   bumps 1 - one arch; 2 - an S; 3+ - a wave with that many bumps.
// The bumps alternate up and down, starting up, and sit evenly across the
// box with an anchor at each end on the middle line.
export function wavePath(w, h, bumps = 0) {
  const W = Number(w) || 0;
  const mid = (Number(h) || 0) / 2;
  const n = Math.max(0, Math.min(12, Math.round(Number(bumps) || 0)));
  const pts = [{ x: 0, y: mid, auto: true }];
  if (n === 0) pts.push({ x: W / 2, y: mid, auto: true });
  // Tall enough to read as a curve, low enough that the letters stay near
  // the box: about a third of the height, capped by how wide each bump is.
  const amp = Math.max(6, Math.min(((Number(h) || 0) * 0.35), (W / Math.max(1, n)) * 0.3));
  for (let k = 0; k < n; k++) {
    pts.push({ x: (W * (k + 0.5)) / n, y: k % 2 === 0 ? mid - amp : mid + amp, auto: true });
  }
  pts.push({ x: W, y: mid, auto: true });
  return smoothPath(pts.map((p) => ({ ix: 0, iy: 0, ox: 0, oy: 0, ...p })));
}
