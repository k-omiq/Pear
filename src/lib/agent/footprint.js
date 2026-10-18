// ===== The original lettering's footprint =====
// Where the original SFX (or title, or sign) was, measured from the pixels the
// cleaner changed: the raw scan against the cleaned page, over one region.
// What differs is the original's ink - its letters and their outline - and
// from that ink come the numbers a letterer reads off the page by eye before
// drawing an English SFX over it: where it sits and how big it is, the slant
// it runs at, how heavy its strokes are, its colours, and the tone of the art
// it sits on (which decides the English's fill and outline, rule A).
//
// Pure: two RGBA buffers in (`regionPixels` of the same rect at the same
// scale, raw and clean), plain JSON out, so the tests feed it pictures made of
// numbers. tools/footprint.js reads the pixels and edit's "match_original"
// lays a box over what this finds.

import { colorDistance, paletteOf, chromaOf, luminanceOf } from './palette.js';

// A pixel the cleaner moved by more than this (redmean, 0..~765) is ink it
// took away; less is scan noise and resampling.
export const CHANGED = 90;
// Fewer changed pixels than this share of the region is no original at all.
export const MIN_SHARE = 0.002;
const MIN_PIXELS = 12;
// The footprint's extent drops this share of its ink at each end, so a stray
// speck the cleaner touched far away does not stretch it.
const TRIM = 0.02;
// Longer than wide by at least this, the ink runs along an axis worth
// turning to; rounder than this, it has no slant to follow.
export const SLANT_ELONGATION = 1.3;
// Stroke weight against the footprint's breadth: below `thin` a glint or a
// swish, above `heavy` a block-letter thud.
export const WEIGHT = { thin: 0.12, heavy: 0.24 };

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

// The changed pixels of `raw` against `clean` as a 0/1 mask.
export function changedMask(raw, clean, threshold = CHANGED) {
  const n = raw.width * raw.height;
  const mask = new Uint8Array(n);
  const a = raw.data;
  const b = clean.data;
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    if (colorDistance([a[k], a[k + 1], a[k + 2]], [b[k], b[k + 1], b[k + 2]]) > threshold) mask[i] = 1;
  }
  return mask;
}

// The pixels of `px` under the mask, the rest made transparent, for paletteOf.
function masked(px, mask) {
  const data = new Uint8ClampedArray(px.data);
  for (let i = 0; i < mask.length; i++) if (!mask[i]) data[i * 4 + 3] = 0;
  return { data, width: px.width, height: px.height };
}

// The footprint, or null when the cleaner changed (next to) nothing there - an
// uncleaned page, or no original under the region. `rect` and `scale` are the
// region's ([x, y, w, h] in page px) and its pixels per page px, as
// regionPixels returns them, so every number comes back in page px.
export function footprintOf(raw, clean, { rect = [0, 0, raw.width, raw.height], scale = 1, threshold = CHANGED } = {}) {
  if (!raw?.data || !clean?.data || raw.width !== clean.width || raw.height !== clean.height) return null;
  const W = raw.width;
  const mask = changedMask(raw, clean, threshold);
  const xs = [];
  const ys = [];
  let perimeter = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % W;
    const y = (i - x) / W;
    xs.push(x);
    ys.push(y);
    const edge = x === 0 || y === 0 || x === W - 1 || y === raw.height - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W];
    if (edge) perimeter++;
  }
  const area = xs.length;
  if (area < MIN_PIXELS || area < MIN_SHARE * mask.length) return null;

  // The ink's axis: the principal direction of its pixels. y runs down, so a
  // positive angle turns clockwise on screen, as a box's rotation does.
  let mx = 0;
  let my = 0;
  for (let i = 0; i < area; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= area;
  my /= area;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < area; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const tr = (sxx + syy) / area;
  const det = (sxx * syy - sxy * sxy) / (area * area);
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const major = tr / 2 + disc;
  const minor = Math.max(1e-9, tr / 2 - disc);
  const elongation = Math.sqrt(major / minor);

  // Its extent along the axis and across it, trimmed of stray specks, and
  // the centre of that extent (not the ink's mean, which heavy letters pull).
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const along = new Float64Array(area);
  const across = new Float64Array(area);
  for (let i = 0; i < area; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    along[i] = dx * c + dy * s;
    across[i] = -dx * s + dy * c;
  }
  along.sort();
  across.sort();
  const a0 = quantile(along, TRIM);
  const a1 = quantile(along, 1 - TRIM);
  const b0 = quantile(across, TRIM);
  const b1 = quantile(across, 1 - TRIM);
  const am = (a0 + a1) / 2;
  const bm = (b0 + b1) / 2;
  const cx = mx + am * c - bm * s;
  const cy = my + am * s + bm * c;
  const length = a1 - a0 + 1;
  const breadth = b1 - b0 + 1;

  // Stroke weight: ink area over half its edge is the mean stroke width.
  const stroke = perimeter > 0 ? (2 * area) / perimeter : breadth;
  const ratio = stroke / Math.max(1, breadth);
  const weight = ratio < WEIGHT.thin ? 'thin' : ratio > WEIGHT.heavy ? 'heavy' : 'medium';

  // The original's own colours, and the tone of the art left round it once
  // the cleaner took it away.
  const ink = paletteOf(masked(raw, mask), { count: 3 });
  const under = paletteOf(masked(clean, mask), { count: 3 });
  const fill = ink?.palette[0]?.hex ?? null;
  const outline = ink?.palette.find((p) => p.hex !== fill && colorDistance(hex(p.hex), hex(fill)) > 120)?.hex ?? null;
  const colour = !!(ink?.accent || (fill && chromaOf(hex(fill)) >= 0.15));

  const k = 1 / (scale || 1);
  const r1 = (v) => Math.round(v * 10) / 10;
  const deg = (theta * 180) / Math.PI;
  return {
    centre: [r1(rect[0] + cx * k), r1(rect[1] + cy * k)],
    length: r1(length * k),
    breadth: r1(breadth * k),
    angle: Math.round(deg),
    elongation: Math.round(elongation * 100) / 100,
    stroke: r1(stroke * k),
    weight,
    ink: { fill, outline, colour, accent: ink?.accent ?? null },
    under: under ? { tone: under.tone, mean: under.mean } : null,
    share: Math.round((area / mask.length) * 1000) / 1000,
  };
}

// How far English is ever turned, either way, and the turn it takes over an
// upright original. English reads left to right: the human in RMS ch1 never
// turned an SFX past 35 degrees, and lettered every Japanese column across,
// tilted up a little (-8 to -35, most near -10).
export const MAX_TURN = 35;
export const UPRIGHT_TURN = -10;

// The ink's axis kept to a reading direction (-90..90].
function axisOf(fp) {
  let a = fp.angle;
  if (a > 90) a -= 180;
  if (a <= -90) a += 180;
  return a;
}

// Whether the original stands upright (a column, steeper than 45 degrees).
export const isUpright = (fp) => !!fp && fp.elongation >= SLANT_ELONGATION && Math.abs(axisOf(fp)) > 45;

// The slant to turn English along: the ink's axis when it has one, never past
// MAX_TURN; UPRIGHT_TURN over an upright original; 0 for a round or square one.
export function slantOf(fp) {
  if (!fp || fp.elongation < SLANT_ELONGATION) return 0;
  if (isUpright(fp)) return UPRIGHT_TURN;
  return Math.max(-MAX_TURN, Math.min(MAX_TURN, axisOf(fp))) || 0;
}

// The look an English SFX takes over this original (instructions.js rules A
// and B): on a colour page the original's colours, its fill and its outline;
// on black and white, the contrast of the art under it - white on dark, black
// on light, with an outline of the other so it reads over busy art; a thin
// sharp original on dark art gets no outline. `outlineWidth` is the band in
// page px (about 3 on a 1500 px page).
export function lookFor(fp, { outlineWidth = 3 } = {}) {
  if (!fp) return null;
  const w = Math.max(1, Math.round(outlineWidth * 10) / 10);
  if (fp.ink.colour && fp.ink.fill) {
    const back = fp.ink.outline ?? (luminanceOf(hex(fp.ink.fill)) > 0.3 ? '#000000' : '#ffffff');
    return { color: fp.ink.fill, strokes: [{ color: back, width: w, opacity: 1 }] };
  }
  const tone = fp.under?.tone ?? 'light';
  if (tone === 'dark') return { color: '#ffffff', strokes: fp.weight === 'thin' ? [] : [{ color: '#000000', width: w, opacity: 1 }] };
  return { color: '#000000', strokes: [{ color: '#ffffff', width: w, opacity: 1 }] };
}

