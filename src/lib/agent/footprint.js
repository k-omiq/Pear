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

import { colorDistance, paletteOf, chromaOf, luminanceOf, hexOf } from './palette.js';

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
// Any #rgb / #rrggbb (an alpha part dropped) as channels, or null.
function rgbOf(s) {
  let h = /^#([0-9a-f]{3,8})$/i.exec(String(s ?? '').trim())?.[1];
  if (!h) return null;
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('');
  return h.length === 6 || h.length === 8 ? [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) : null;
}

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

// How deep each ink pixel lies in the letters: its chamfer (3-4) distance to
// the nearest pixel that is not ink, or to the region's edge, in px. An
// outline is the shallow band round the letters; their fill lies deeper.
export function depthMap(mask, W, H) {
  const d = new Int32Array(mask.length);
  for (let i = 0; i < mask.length; i++) d[i] = mask[i] ? 1 << 20 : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : d[y * W + x]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (d[i]) d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (d[i]) d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  }
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = d[i] / 3;
  return out;
}

// The colour of a set of pixels as the page has it: each channel's median,
// so JPEG grain and the odd stray pixel do not move it.
function medianHex(data, idx) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (const i of idx) for (let c = 0; c < 3; c++) hist[c][data[i * 4 + c]]++;
  const half = idx.length / 2;
  return hexOf(
    hist.map((h) => {
      let acc = 0;
      for (let v = 0; v < 256; v++) if ((acc += h[v]) >= half) return v;
      return 255;
    }),
  );
}

// How far colour `c` is from every mix of `a` and `b`: small for the
// soft edge where letters blend into the art round them, which is no outline.
function offBlend(c, a, b) {
  if (!b) return Infinity;
  let best = Infinity;
  for (let t = 0; t <= 1.0001; t += 0.05) best = Math.min(best, colorDistance(c, a.map((v, i) => v + (b[i] - v) * t)));
  return best;
}

// A part of the letters smaller than this share of the ink is grain or an
// edge, not a colour of the original.
const MIN_PART = 0.08;
// An outline stands this far (redmean) from the fill, and this far from any
// blend of the fill into the art; a second fill colour (a shade) as far.
const OUTLINE_APART = 100;
const OFF_BLEND = 60;
const SHADE_APART = 60;

// Hollow letters - a pale inside drawn round with a dark line, over art as
// pale as the inside - change only their line: the cleaner found the inside
// already the colour it paints. So the changed pixels are a ring with the
// letters' insides as holes in it, and read alone they say "thin dark letters,
// no outline". Letters are taken as hollow when the holes hold at least as
// much as the ring and run along most of its edge (a solid letter's few
// counters do neither), and their colour is not the ring's: the inside is
// then the fill and the ring the outline. Holes are what the region's edge
// cannot reach without crossing the ring. Read small (regionPixels), a ring
// blurs inwards and its holes shrink to a third of it or so, but they still
// line it: on RMS ch1 the hollow sounds run 1.0-1.2 inner edge to outer, the
// solid ones 0.05-0.55.
const HOLLOW_AREA = 0.25;
const HOLLOW_EDGE = 0.8;
function hollowInk(raw, mask, depth, scale) {
  const W = raw.width;
  const H = raw.height;
  const outside = new Uint8Array(mask.length);
  const stack = [];
  const seed = (i) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < W; x++) {
    seed(x);
    seed((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    seed(y * W);
    seed(y * W + W - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % W;
    if (x > 0) seed(i - 1);
    if (x < W - 1) seed(i + 1);
    if (i >= W) seed(i - W);
    if (i < mask.length - W) seed(i + W);
  }
  const holes = [];
  const ring = [];
  let inner = 0;
  let outer = 0;
  let deep = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) {
      if (!outside[i]) holes.push(i);
      continue;
    }
    ring.push(i);
    deep += depth[i];
    const x = i % W;
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W].filter((j) => j >= 0 && j < mask.length && !mask[j]);
    if (nb.some((j) => !outside[j])) inner++;
    if (nb.some((j) => outside[j])) outer++;
  }
  if (!ring.length || holes.length < HOLLOW_AREA * ring.length || inner < HOLLOW_EDGE * outer) return null;
  const fill = medianHex(raw.data, holes);
  // The ring's line from its half farthest from the fill: read small, the
  // rest is the line blurred into the inside and the art.
  const fillRgb = hex(fill);
  const off = ring.map((i) => colorDistance([raw.data[i * 4], raw.data[i * 4 + 1], raw.data[i * 4 + 2]], fillRgb));
  const cut = [...off].sort((a, b) => a - b)[Math.floor(off.length / 2)];
  const outline = medianHex(raw.data, ring.filter((_, k) => off[k] >= cut));
  if (colorDistance(hex(fill), hex(outline)) <= OUTLINE_APART) return null;
  // The ring has a non-ink side both ways, so its depths run 1..w/2..1 and
  // their mean is (w / 2 + 1) / 2.
  const outlineWidth = Math.max(1, Math.round(((4 * (deep / ring.length) - 2) / (scale || 1)) * 2) / 2);
  const colour = [fill, outline].some((c) => chromaOf(hex(c)) >= 0.15);
  return { fill, outline, outlineWidth, colour, accent: null };
}

// The original's colours, by where each lies in its letters: the fill is the
// deepest colour, the outline the colour of the shallow band round it, a
// second deep colour a shade (a gradient, `shade` from top to bottom). Each
// is the median of its own pixels, so it is the colour on the page, not a
// mean of the colours round it. `outlineWidth` is the band's width in page
// px. Null with no ink.
export function inkOf(raw, mask, depth, underRgb = null, scale = 1) {
  const ink = readInk(raw, mask, depth, underRgb, scale);
  if (!ink) return null;
  const { fill, outline, shade } = ink;
  return { ...ink, fill: paper(fill), outline: outline && paper(outline), ...(shade ? { shade: shade.map(paper) } : null) };
}

// A scan's white is paper, a little grey or warm, and its black is ink that
// never quite reaches 0: lettered, both are pure. Greys this close to either
// end are read as the end itself.
const PAPER = 26;
function paper(c) {
  const [r, g, b] = hex(c);
  if (Math.max(r, g, b) - Math.min(r, g, b) > 12) return c;
  if (Math.min(r, g, b) >= 255 - PAPER) return '#ffffff';
  if (Math.max(r, g, b) <= PAPER) return '#000000';
  return c;
}

function readInk(raw, mask, depth, underRgb, scale) {
  const hollow = hollowInk(raw, mask, depth, scale);
  if (hollow) return hollow;
  const pal = paletteOf(masked(raw, mask), { count: 3 });
  if (!pal) return null;
  const cols = pal.palette.map((c) => hex(c.hex));
  const parts = cols.map((rgb) => ({ rgb, idx: [], deep: 0, y: 0 }));
  const W = raw.width;
  const px = [0, 0, 0];
  let total = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    px[0] = raw.data[i * 4];
    px[1] = raw.data[i * 4 + 1];
    px[2] = raw.data[i * 4 + 2];
    let best = 0;
    for (let j = 1; j < cols.length; j++) if (colorDistance(px, cols[j]) < colorDistance(px, cols[best])) best = j;
    const part = parts[best];
    part.idx.push(i);
    part.deep += depth[i];
    part.y += Math.floor(i / W);
    total++;
  }
  const major = parts
    .filter((p) => p.idx.length >= MIN_PART * total)
    .map((p) => ({ ...p, deep: p.deep / p.idx.length, y: p.y / p.idx.length }));
  if (!major.length) return null;
  const fillPart = major.reduce((a, b) => (b.deep > a.deep ? b : a));
  // The fill's colour from its core, clear of the edge it blends at.
  const core = fillPart.idx.filter((i) => depth[i] >= 2);
  const fill = medianHex(raw.data, core.length >= 20 ? core : fillPart.idx);
  const fillRgb = hex(fill);
  const others = major.filter((p) => p !== fillPart && offBlend(p.rgb, fillRgb, underRgb) > OFF_BLEND);
  const outlinePart =
    others
      .filter((p) => p.deep < fillPart.deep * 0.75 && colorDistance(p.rgb, fillRgb) > OUTLINE_APART)
      .sort((a, b) => b.idx.length - a.idx.length)[0] ?? null;
  const shadePart =
    others
      .filter((p) => p !== outlinePart && p.deep >= fillPart.deep * 0.6 && colorDistance(p.rgb, fillRgb) > SHADE_APART)
      .sort((a, b) => b.idx.length - a.idx.length)[0] ?? null;
  const outline = outlinePart ? medianHex(raw.data, outlinePart.idx) : null;
  // A band of width w holds depths 1..w, so its mean depth is (w + 1) / 2.
  const outlineWidth = outlinePart ? Math.max(1, Math.round(((2 * outlinePart.deep - 1) / (scale || 1)) * 2) / 2) : null;
  const shade = shadePart
    ? [fillPart, shadePart].sort((a, b) => a.y - b.y).map((p) => (p === fillPart ? fill : medianHex(raw.data, p.idx)))
    : null;
  const colour = !!(pal.accent || [fill, outline, ...(shade ?? [])].some((c) => c && chromaOf(hex(c)) >= 0.15));
  return { fill, outline, outlineWidth, ...(shade ? { shade } : null), colour, accent: pal.accent ?? null };
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

  // The original's own colours, read from where each sits in the letters
  // (`inkOf`), and the tone of the art left round it once the cleaner took
  // it away.
  const under = paletteOf(masked(clean, mask), { count: 3 });
  const ink = inkOf(raw, mask, depthMap(mask, W, raw.height), under ? hex(under.mean) : null, scale);

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
    ink,
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

// The look an English SFX takes over this original: exactly the original's
// colours - its fill (or its shade, top to bottom, as a gradient) and its
// outline at the original's width, or no outline when it had none - on a
// colour page and on black and white alike (instructions.js rule C). Only
// with no ink to read (never, for a footprint that was found) does the tone
// of the art decide: white on dark, black on light, an outline of the other.
// `outlineWidth` is that fallback's band in page px (about 3 on a 1500 px
// page).
export function lookFor(fp, { outlineWidth = 3 } = {}) {
  if (!fp) return null;
  const ink = fp.ink;
  if (ink?.fill) {
    return {
      color: ink.fill,
      strokes: ink.outline ? [{ color: ink.outline, width: ink.outlineWidth ?? outlineWidth, opacity: 1 }] : [],
      gradient: ink.shade
        ? { on: true, kind: 'linear', angle: 180, scope: 'box', stops: ink.shade.map((color, i) => ({ color, pos: i / (ink.shade.length - 1), opacity: 1 })) }
        : { on: false },
      noFill: false,
    };
  }
  const w = Math.max(1, Math.round(outlineWidth * 10) / 10);
  const tone = fp.under?.tone ?? 'light';
  if (tone === 'dark') return { color: '#ffffff', strokes: fp.weight === 'thin' ? [] : [{ color: '#000000', width: w, opacity: 1 }] };
  return { color: '#000000', strokes: [{ color: '#ffffff', width: w, opacity: 1 }] };
}

// How far (redmean) a box's colour may stand from the original's and still
// be the original's: the same colour read again, not another one.
export const COLOUR_MATCH = 40;

// Where an SFX box's colours stand from its original's: null when they are
// the original's, else { fill?, outline? } each { want, got } (instructions
// rule C, check "sfx_colour"). Hollow letters (noFill) show their fill as
// their first band.
export function colourMismatch(style, ink) {
  if (!style || !ink?.fill) return null;
  const near = (a, b) => {
    const x = rgbOf(a);
    const y = rgbOf(b);
    return !!x && !!y && colorDistance(x, y) <= COLOUR_MATCH;
  };
  const out = {};
  const bands = (style.strokes ?? []).filter((k) => (Number(k?.width) || 0) > 0 && (k.opacity ?? 1) > 0);
  const want = ink.shade ?? [ink.fill];
  if (style.noFill) {
    const got = bands[0]?.color ?? null;
    if (!near(got, ink.fill)) out.fill = { want: ink.fill, got: got ?? 'none (hollow, no band)' };
  } else if (style.pattern?.on) {
    out.fill = { want: want.length > 1 ? want : ink.fill, got: 'a pattern' };
  } else if (style.gradient?.on) {
    const stops = (style.gradient.stops ?? []).map((s) => s.color);
    const fits = want.length > 1 ? near(stops[0], want[0]) && near(stops.at(-1), want.at(-1)) && stops.every((c) => want.some((w) => near(c, w))) : stops.every((c) => near(c, ink.fill));
    if (!fits) out.fill = { want: want.length > 1 ? want : ink.fill, got: stops };
  } else if (want.length > 1 || !near(style.color, ink.fill)) {
    out.fill = { want: want.length > 1 ? want : ink.fill, got: style.color };
  }
  const outer = style.noFill ? bands.slice(1) : bands;
  if (ink.outline) {
    const bad = outer.filter((k) => !near(k.color, ink.outline));
    if (!outer.length || bad.length) out.outline = { want: ink.outline, got: outer.length ? outer.map((k) => k.color) : 'none' };
  } else if (outer.length) {
    out.outline = { want: 'none', got: outer.map((k) => k.color) };
  }
  return out.fill || out.outline ? out : null;
}

// ===== lettering the cleaner left =====
// A detected line's original letters still on the cleaned page: the cleaner
// changed next to nothing in its block, and the block has dark ink - so the
// letters are still there. A cleaned balloon has its letters gone white; a
// cleaned SFX over art has its letters painted over, which changes many
// pixels even where the art round them is dark (white letters on black hair
// keep the hair's dark ink, and that is not lettering left).
export const LEFT_DARK = 110; // luma (0-255) under this is ink
export const UNCLEANED_SHARE = 0.5; // this much of the ink left is lettering left
export const UNCLEANED_CHANGED = 0.02; // with under this share of the block changed
const LEFT_MIN_INK = 0.01; // of the block, for there to be lettering at all

// `raw` and `clean`: the same region, as regionPixels reads it, at the same
// scale. `rect` [x, y, w, h] in page px inside it. { ink, share, changed }
// (share: of the dark ink, unchanged; changed: of the block) or null when
// the rect holds no dark ink worth the name.
export function inkLeftIn(raw, clean, rect, threshold = CHANGED) {
  const [rx, ry] = raw.rect;
  const s = raw.scale;
  const x0 = Math.max(0, Math.floor((rect[0] - rx) * s));
  const y0 = Math.max(0, Math.floor((rect[1] - ry) * s));
  const x1 = Math.min(raw.width, Math.ceil((rect[0] + rect[2] - rx) * s));
  const y1 = Math.min(raw.height, Math.ceil((rect[1] + rect[3] - ry) * s));
  if (x1 <= x0 || y1 <= y0) return null;
  const a = raw.data;
  const b = clean.data;
  let ink = 0;
  let kept = 0;
  let changed = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const k = (y * raw.width + x) * 4;
      const same = colorDistance([a[k], a[k + 1], a[k + 2]], [b[k], b[k + 1], b[k + 2]]) <= threshold;
      if (!same) changed++;
      if (0.299 * a[k] + 0.587 * a[k + 1] + 0.114 * a[k + 2] >= LEFT_DARK) continue;
      ink++;
      if (same) kept++;
    }
  }
  const area = (x1 - x0) * (y1 - y0);
  if (ink < Math.max(MIN_PIXELS, LEFT_MIN_INK * area)) return null;
  return { ink, share: Math.round((kept / ink) * 100) / 100, changed: Math.round((changed / area) * 1000) / 1000 };
}

// Whether `inkLeftIn`'s answer is lettering the cleaner left.
export const isUncleaned = (left) => !!left && left.share >= UNCLEANED_SHARE && left.changed < UNCLEANED_CHANGED;
