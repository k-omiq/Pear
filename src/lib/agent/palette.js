// ===== The colours of a region, for the agent =====
// What the `colors` tool says about a patch of a page (tools/colors.js): the
// few colours it is made of and how much of it each covers, its average, how
// light it is, and the one vivid colour that is not its background - on a
// colour page, the ink of the original SFX the agent is asked to match.
//
// Pure: RGBA pixels in (an ImageData's `{ data, width, height }`), plain JSON
// out, no canvas, so the tests feed it pictures made of numbers.
//
// The palette is median cut, then refined. Median cut splits the colour cube
// box by box at the median of the box's widest channel, always splitting the
// box that most needs it (the most pixels times the widest spread), until
// there are a few more boxes than colours asked for; boxes too tight to tell
// apart by eye are never split. Each box's mean is a candidate; candidates
// within MERGE_DISTANCE of each other are one colour; the largest `count`
// survive, and three rounds of k-means over every pixel settle them where
// the pixels really are and give each its true share. No randomness anywhere,
// so the same pixels always give the same answer.
//
// Light is measured the way the eye adds it up: `mean` is averaged in linear
// light (a 50% halftone of black dots on white reads as #bcbcbc, which is
// what it looks like from reading distance, not #808080), and `luminance` is
// WCAG relative luminance of that mean, 0 black to 1 white.

// Colours closer than this (redmean distance, 0..~765) are one colour: two
// paper whites 15 apart on every channel are about 45.
export const MERGE_DISTANCE = 48;
// A box whose widest channel spans less than this is one colour already.
const MIN_SPLIT_RANGE = 24;
// Median cut makes this many more candidates than asked for, so that a small
// accent is cut out even when a few splits go to the background's grain.
const EXTRA_BOXES = 4;
const KMEANS_ROUNDS = 3;
// More pixels than this are sampled at an even stride.
const MAX_SAMPLES = 200_000;
// Below half-transparent a pixel is not part of the picture.
const MIN_ALPHA = 128;
// The accent: at least this share of the region, and at least this chroma
// ((max - min) / 255 of its channels), so a grey or a yellowed paper is never
// called an accent. 0.15 is a pale pink; scanned paper is about 0.1.
export const ACCENT_MIN_SHARE = 0.03;
export const ACCENT_MIN_CHROMA = 0.15;
// Tone bands by luminance. Between them, neither black nor white text clearly
// wins: at 0.12 white text has a contrast of 6.2 and black 3.4, at 0.26 the
// other way round; the two are equal at 0.179.
export const TONE_DARK = 0.12;
export const TONE_LIGHT = 0.26;

// sRGB 0..255 to linear light 0..1, as a table, and back.
const LINEAR = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toSrgb = (l) => {
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

const hex2 = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
export const hexOf = ([r, g, b]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

// WCAG relative luminance of an sRGB colour, 0..1.
export const luminanceOf = ([r, g, b]) =>
  0.2126 * LINEAR[Math.round(r)] + 0.7152 * LINEAR[Math.round(g)] + 0.0722 * LINEAR[Math.round(b)];

// How colourful, 0 (grey) to 1 (a pure primary), whatever the lightness.
export const chromaOf = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;

// "Redmean" distance: plain RGB distance weighted the way the eye weighs the
// channels, cheap enough to run on every pixel.
export function colorDistance(a, b) {
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

export const toneOf = (luminance) => (luminance < TONE_DARK ? 'dark' : luminance > TONE_LIGHT ? 'light' : 'mid');

// The opaque pixels of an RGBA buffer as packed RGB, sampled down to
// MAX_SAMPLES at an even stride.
function samplesOf(data) {
  const total = Math.floor((data?.length ?? 0) / 4);
  const step = Math.max(1, Math.ceil(total / MAX_SAMPLES));
  const out = new Uint8Array(Math.ceil(total / step) * 3);
  let n = 0;
  for (let p = 0; p < total; p += step) {
    const i = p * 4;
    if (data[i + 3] < MIN_ALPHA) continue;
    out[n * 3] = data[i];
    out[n * 3 + 1] = data[i + 1];
    out[n * 3 + 2] = data[i + 2];
    n++;
  }
  return { rgb: out, n };
}

// One median-cut box: the sample indexes it holds and their spread.
function boxOf(rgb, idx) {
  const lo = [255, 255, 255];
  const hi = [0, 0, 0];
  for (const k of idx) {
    for (let c = 0; c < 3; c++) {
      const v = rgb[k * 3 + c];
      if (v < lo[c]) lo[c] = v;
      if (v > hi[c]) hi[c] = v;
    }
  }
  const ranges = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const channel = ranges.indexOf(Math.max(...ranges));
  return { idx, channel, range: ranges[channel] };
}

// Split a box at the median of its widest channel, keeping equal values on
// one side (a flat colour is never cut in two). Null when it cannot split.
function split(rgb, box) {
  const hist = new Uint32Array(256);
  for (const k of box.idx) hist[rgb[k * 3 + box.channel]]++;
  const half = box.idx.length / 2;
  let cut = 0;
  for (let acc = 0; cut < 256; cut++) {
    acc += hist[cut];
    if (acc >= half) break;
  }
  const take = (test) => box.idx.filter((k) => test(rgb[k * 3 + box.channel]));
  let left = take((v) => v <= cut);
  let right = take((v) => v > cut);
  if (!right.length) {
    left = take((v) => v < cut);
    right = take((v) => v >= cut);
  }
  if (!left.length || !right.length) return null;
  return [boxOf(rgb, left), boxOf(rgb, right)];
}

const meanOf = (rgb, idx) => {
  const s = [0, 0, 0];
  for (const k of idx) for (let c = 0; c < 3; c++) s[c] += rgb[k * 3 + c];
  return s.map((v) => v / idx.length);
};

// Median cut: up to `n` boxes, as `{ color, count }`.
export function medianCut(rgb, total, n) {
  if (!total) return [];
  const all = new Uint32Array(total);
  for (let k = 0; k < total; k++) all[k] = k;
  const boxes = [boxOf(rgb, all)];
  while (boxes.length < n) {
    let best = -1;
    let score = 0;
    boxes.forEach((b, i) => {
      if (b.range < MIN_SPLIT_RANGE) return;
      const s = b.idx.length * b.range;
      if (s > score) {
        score = s;
        best = i;
      }
    });
    if (best < 0) break;
    const parts = split(rgb, boxes[best]);
    if (!parts) {
      boxes[best].range = 0; // nothing to cut; never asked again
      continue;
    }
    boxes.splice(best, 1, ...parts);
  }
  return boxes.map((b) => ({ color: meanOf(rgb, b.idx), count: b.idx.length }));
}

// Candidates closer than MERGE_DISTANCE folded into the larger, weighted by
// count; largest first.
export function mergeNear(colors, distance = MERGE_DISTANCE) {
  const out = [];
  for (const c of [...colors].sort((a, b) => b.count - a.count)) {
    const near = out.find((o) => colorDistance(o.color, c.color) < distance);
    if (!near) {
      out.push({ color: [...c.color], count: c.count });
      continue;
    }
    const t = near.count + c.count;
    near.color = near.color.map((v, i) => (v * near.count + c.color[i] * c.count) / t);
    near.count = t;
  }
  return out.sort((a, b) => b.count - a.count);
}

// Rounds of k-means from `centres`: every sample to its nearest centre, each
// centre to its samples' mean. Centres no sample chose are dropped.
function refine(rgb, total, centres) {
  let cs = centres.map((c) => [...c]);
  let counts = [];
  for (let round = 0; round < KMEANS_ROUNDS; round++) {
    const sums = cs.map(() => [0, 0, 0]);
    counts = cs.map(() => 0);
    const px = [0, 0, 0];
    for (let k = 0; k < total; k++) {
      px[0] = rgb[k * 3];
      px[1] = rgb[k * 3 + 1];
      px[2] = rgb[k * 3 + 2];
      let best = 0;
      let bestD = Infinity;
      for (let j = 0; j < cs.length; j++) {
        const d = colorDistance(px, cs[j]);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      counts[best]++;
      for (let c = 0; c < 3; c++) sums[best][c] += px[c];
    }
    const keep = counts.map((n) => n > 0);
    cs = cs.flatMap((c, j) => (keep[j] ? [sums[j].map((v) => v / counts[j])] : []));
    counts = counts.filter((n) => n > 0);
  }
  return cs.map((color, j) => ({ color, count: counts[j] }));
}

// The region's colours. `pixels` is `{ data }` (RGBA, as ImageData has it);
// `count` how many colours at most (2..8). Returns
//   { palette: [{ hex, share }], mean, luminance, tone, accent }
// with the palette largest share first (the shares of every opaque pixel, so
// they add up to 1 give or take rounding), or null when no pixel is opaque.
export function paletteOf(pixels, { count = 5 } = {}) {
  const want = Math.min(8, Math.max(2, Math.round(Number(count) || 5)));
  const { rgb, n } = samplesOf(pixels?.data);
  if (!n) return null;

  // The mean, in linear light.
  const lin = [0, 0, 0];
  for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) lin[c] += LINEAR[rgb[k * 3 + c]];
  const meanLin = lin.map((v) => v / n);
  const mean = meanLin.map(toSrgb);
  const luminance = 0.2126 * meanLin[0] + 0.7152 * meanLin[1] + 0.0722 * meanLin[2];

  const candidates = mergeNear(medianCut(rgb, n, want + EXTRA_BOXES)).slice(0, want);
  const colors = mergeNear(refine(rgb, n, candidates.map((c) => c.color)));
  // A colour too small to show at a tenth of a percent is grain, not a colour.
  const palette = colors
    .map((c) => ({ hex: hexOf(c.color), share: Math.round((c.count / n) * 1000) / 1000, rgb: c.color }))
    .filter((c) => c.share > 0);

  // The accent: the most colourful colour that is not the background (the
  // first, largest); on a tie the larger share.
  let accent = null;
  let best = -1;
  for (const c of palette.slice(1)) {
    const ch = chromaOf(c.rgb);
    if (c.share < ACCENT_MIN_SHARE || ch < ACCENT_MIN_CHROMA || ch <= best) continue;
    best = ch;
    accent = c.hex;
  }

  return {
    palette: palette.map(({ hex, share }) => ({ hex, share })),
    mean: hexOf(mean),
    luminance: Math.round(luminance * 1000) / 1000,
    tone: toneOf(luminance),
    accent,
  };
}
