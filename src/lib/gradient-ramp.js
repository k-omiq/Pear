// An effect gradient's ramp as the Rust engine paints it: colour and opacity
// stops apart, each segment's midpoint, Photoshop's Smoothness and its
// Interpolation Method. The PSD writer bakes it into stops Photoshop draws
// the same (`psdFxSolidStops` in psd.js), and the Inspector's strip shows it.
//
// The maths is the engine's (`text-engine/src/paint/fx/gradient.rs` and
// `gradient_bake.rs`), which ports PhotoCraft's
// `crates/io/src/gradient_bake.rs` (`eval`, `bake`, `bake_opacity`,
// `SMOOTH_EASE`, `OPACITY_RESPONSE`) and `crates/compose/src/gradient_fill.rs`
// (`midpoint_remap`), Copyright (c) 2026 ArtCraft Team and the PhotoCraft
// contributors, MIT licence (see text-engine/THIRD_PARTY.md). Keep the two in
// step.

// A data gradient's stops as the engine reads them: sorted, each segment's
// midpoint (stored on the stop that ends it), and the opacity stops (one per
// colour stop at its place for a gradient from before they were their own).
function parts(g) {
  const stops = [...(g?.stops ?? [])].sort((a, b) => a.pos - b.pos);
  const ops = Array.isArray(g?.opacityStops)
    ? [...g.opacityStops].sort((a, b) => a.pos - b.pos)
    : stops.map((st) => ({ pos: st.pos, opacity: st.opacity ?? 1 }));
  const mids = (list) => list.slice(1).map((st) => (Number.isFinite(st?.mid) ? st.mid : 0.5));
  return {
    color: stops.map((st) => [st.pos, hexRgb(st.color)]),
    colorMids: mids(stops),
    opacity: ops.map((st) => [st.pos, Math.min(1, Math.max(0, Number.isFinite(+st.opacity) ? +st.opacity : 1))]),
    opacityMids: mids(ops),
    method: g?.method ?? 'classic',
    smoothness: Math.min(1, Math.max(0, Number(g?.smoothness) || 0)),
  };
}

function hexRgb(h) {
  const s = typeof h === 'string' ? h.replace('#', '') : '';
  const v = parseInt(s.length === 3 ? [...s].map((c) => c + c).join('') : s.slice(0, 6), 16);
  if (!Number.isFinite(v)) return [0, 0, 0];
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => c / 255);
}

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const enc = (c) => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};
function toOklab(rgb) {
  const [r, g, b] = rgb.map(lin);
  const l = Math.cbrt(0.41222146 * r + 0.53633255 * g + 0.051445995 * b);
  const m = Math.cbrt(0.2119035 * r + 0.6806995 * g + 0.10739696 * b);
  const s = Math.cbrt(0.08830246 * r + 0.28171885 * g + 0.6299787 * b);
  return [0.21045426 * l + 0.7936178 * m - 0.004072047 * s, 1.9779985 * l - 2.4285922 * m + 0.4505937 * s, 0.025904037 * l + 0.78277177 * m - 0.80867577 * s];
}
function fromOklab(p) {
  const l = (p[0] + 0.39633778 * p[1] + 0.21580376 * p[2]) ** 3;
  const m = (p[0] - 0.105561346 * p[1] - 0.06385417 * p[2]) ** 3;
  const s = (p[0] - 0.08948418 * p[1] - 1.2914855 * p[2]) ** 3;
  return [4.0767417 * l - 3.3077116 * m + 0.23096994 * s, -1.268438 * l + 2.6097574 * m - 0.34131938 * s, -0.0041960863 * l - 0.7034186 * m + 1.7076147 * s].map(enc);
}
const intoSpace = (m, rgb) => (m === 'linear' ? rgb.map(lin) : m === 'perceptual' || m === 'smooth' ? toOklab(rgb) : rgb);
const outOfSpace = (m, p) => (m === 'linear' ? p.map(enc) : m === 'perceptual' || m === 'smooth' ? fromOklab(p) : p.map((v) => Math.min(1, Math.max(0, v))));

// Smooth's progress across a segment at u = 0, 1/16, ..., 1 (Photoshop
// 27.11, measured by PhotoCraft).
const SMOOTH_EASE = [0.0, 0.0438, 0.099, 0.1644, 0.2303, 0.2988, 0.3667, 0.433, 0.4974, 0.5642, 0.6302, 0.6985, 0.7656, 0.8333, 0.8945, 0.9517, 1.0];
function smoothEase(u) {
  const x = Math.min(1, Math.max(0, u)) * 16;
  const i = Math.min(15, Math.floor(x));
  return SMOOTH_EASE[i] + (SMOOTH_EASE[i + 1] - SMOOTH_EASE[i]) * (x - i);
}

/** Where a segment's position `u` lands with midpoint `m` (0.5 leaves it), held to 5..95 %. */
export function midpointRemap(u, m) {
  const k = Math.min(0.95, Math.max(0.05, Number.isFinite(m) ? m : 0.5));
  if (Math.abs(k - 0.5) < 1e-6) return u;
  return u <= k ? (0.5 * u) / k : 0.5 + (0.5 * (u - k)) / (1 - k);
}

// Segment `i` of sorted `pts` ([pos, [3]] in the method's space) at `u`.
function segment(pts, mids, smooth, i, u0, method) {
  const n = pts.length;
  const [t0, p0] = pts[i];
  const [t1, p1] = pts[i + 1];
  const h = Math.max(1e-6, t1 - t0);
  const u = midpointRemap(u0, mids[i] ?? 0.5);
  if (method === 'smooth') {
    const e = smoothEase(u);
    return p0.map((v, c) => v + (p1[c] - v) * e);
  }
  const tangent = (k) => {
    const [a, b] = k === 0 ? [0, 1] : k === n - 1 ? [n - 2, n - 1] : [k - 1, k + 1];
    const d = Math.max(1e-6, pts[b][0] - pts[a][0]);
    const half = k === 0 || k === n - 1 ? 0.5 : 1;
    return pts[b][1].map((v, c) => ((v - pts[a][1][c]) / d) * half);
  };
  const m0 = tangent(i);
  const m1 = tangent(i + 1);
  const u2 = u * u;
  const u3 = u2 * u;
  const [h00, h10, h01, h11] = [2 * u3 - 3 * u2 + 1, u3 - 2 * u2 + u, -2 * u3 + 3 * u2, u3 - u2];
  return p0.map((v, c) => {
    const linear = v + (p1[c] - v) * u;
    const spline = h00 * v + h10 * h * m0[c] + h01 * p1[c] + h11 * h * m1[c];
    const value = linear + (spline - linear) * smooth;
    return Math.min(Math.max(v, p1[c]), Math.max(Math.min(v, p1[c]), value));
  });
}

const STEPS = 96;
// The dense run of sorted `pts`: every stop's place (both sides of a hard
// edge) and the even steps between (the engine's `run`).
function run(pts, f) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const t0 = pts[i][0];
    const t1 = pts[i + 1][0];
    if (!(t1 > t0)) continue;
    const steps = Math.ceil((t1 - t0) * STEPS);
    for (let k = 0; k <= steps; k++) out.push([t0 + (t1 - t0) * (k / steps), f(i, k / steps)]);
  }
  return out;
}

const OPACITY_RESPONSE = 0.65;
// The ramp's colour and opacity runs, each a dense list of [pos, value]
// between which it is a straight line, as the engine paints it. Classic at
// 0 % is the stops themselves (their midpoints still bend each segment).
function runs(g) {
  const p = parts(g);
  const plain = p.smoothness <= 0;
  let color;
  if (p.color.length < 2) color = p.color.map(([t, c]) => [t, c, undefined]);
  else if (plain && p.method === 'classic') color = p.color.map(([t, c], i) => [t, c, p.colorMids[i - 1]]);
  else {
    const pts = p.color.map(([t, c]) => [t, intoSpace(p.method, c)]);
    color = run(pts, (i, u) => outOfSpace(p.method, segment(pts, p.colorMids, p.smoothness, i, u, p.method)));
  }
  const om = p.method === 'smooth' ? 'classic' : p.method;
  let opacity;
  if (p.opacity.length < 2 || (plain && om === 'classic')) opacity = p.opacity.map(([t, o], i) => [t, o, p.opacityMids[i - 1]]);
  else {
    const into = (o) => (om === 'linear' ? lin(o) : om === 'perceptual' ? Math.cbrt(lin(o)) : o);
    const out = (v) => {
      if (om === 'classic') return Math.min(1, Math.max(0, v));
      const y = om === 'linear' ? v : Math.max(0, v) ** 3;
      return Math.min(1, Math.max(0, y)) ** OPACITY_RESPONSE;
    };
    const pts = p.opacity.map(([t, o]) => [t, [into(o), into(o), into(o)]]);
    opacity = run(pts, (i, u) => out(segment(pts, p.opacityMids, p.smoothness, i, u, 'classic')[0]));
  }
  return { color, opacity, bakedColor: !(p.color.length < 2 || (plain && p.method === 'classic')), bakedOpacity: !(p.opacity.length < 2 || (plain && om === 'classic')) };
}

// The value at `t` on a run: before its first stop the first, past its last
// the last, else the straight line (bent by the segment's midpoint, which a
// run's third field carries on the stop that ends the segment).
function at(list, t, mix) {
  if (!list.length) return undefined;
  let j = list.findIndex((s) => !(s[0] < t));
  if (j === 0) return list[0][1];
  if (j < 0) return list[list.length - 1][1];
  const a = list[j - 1];
  const b = list[j];
  const k = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
  return mix(a[1], b[1], midpointRemap(k, b[2] ?? 0.5));
}

/**
 * Samples of an effect gradient at `count` + 1 even places: `{pos, rgb: [r, g, b] 0..1,
 * opacity}`, plus each stop's own place, as the engine paints them (no noise gradient,
 * no Dither).
 */
export function sampleRamp(g, count = 64) {
  const { color, opacity } = runs(g);
  const places = new Set();
  for (let k = 0; k <= count; k++) places.add(k / count);
  for (const [t] of color) places.add(t);
  for (const [t] of opacity) places.add(t);
  return [...places]
    .filter((t) => t >= 0 && t <= 1)
    .sort((a, b) => a - b)
    .map((pos) => ({
      pos,
      rgb: at(color, pos, (a, b, k) => a.map((v, c) => v + (b[c] - v) * k)) ?? [0, 0, 0],
      opacity: at(opacity, pos, (a, b, k) => a + (b - a) * k) ?? 1,
    }));
}

/**
 * The ramp as Photoshop-ready stop lists that a straight line between them draws
 * as the engine paints it: `{color: [{pos, rgb}], opacity: [{pos, opacity}]}`,
 * with both sides of a hard edge kept and `steps` even places a whole run
 * between the stops.
 */
export function bakeRamp(g, steps = 64) {
  const { color, opacity, bakedColor, bakedOpacity } = runs(g);
  // A run baked from Smoothness or a Method is dense already; the stops
  // themselves get `steps` even places between them.
  const dense = (list, mix, baked) => {
    const out = [];
    list.forEach((s, i) => {
      out.push({ pos: s[0], v: s[1] });
      const q = list[i + 1];
      if (baked || !q || !(q[0] > s[0])) return;
      if (JSON.stringify(s[1]) === JSON.stringify(q[1])) return;
      for (let k = Math.floor(s[0] * steps) + 1; k / steps < q[0]; k++) {
        const t = k / steps;
        out.push({ pos: t, v: mix(s[1], q[1], midpointRemap((t - s[0]) / (q[0] - s[0]), q[2] ?? 0.5)) });
      }
    });
    return out;
  };
  return {
    color: dense(color, (a, b, k) => a.map((v, c) => v + (b[c] - v) * k), bakedColor).map(({ pos, v }) => ({ pos, rgb: v })),
    opacity: dense(opacity, (a, b, k) => a + (b - a) * k, bakedOpacity).map(({ pos, v }) => ({ pos, opacity: v })),
  };
}

/** The ramp as a CSS linear-gradient (left to right), for the Inspector's strip. */
export function rampCss(g, count = 32) {
  const pts = sampleRamp(g, count);
  const css = pts.map((p) => `rgba(${p.rgb.map((v) => Math.round(v * 255)).join(', ')}, ${Math.round(p.opacity * 1000) / 1000}) ${Math.round(p.pos * 10000) / 100}%`);
  return `linear-gradient(90deg, ${css.join(', ')})`;
}
