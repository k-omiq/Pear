import { describe, expect, it } from 'vitest';
import {
  paletteOf, medianCut, mergeNear, colorDistance, hexOf, luminanceOf, chromaOf, toneOf,
  ACCENT_MIN_SHARE, TONE_DARK, TONE_LIGHT, MERGE_DISTANCE,
} from './palette.js';

// A picture made of numbers: `parts` is [[r, g, b, share], ...] laid down in
// order, pixel after pixel, with a deterministic jitter of +-`noise` on every
// channel (a scan's grain).
function picture(parts, { w = 100, h = 100, noise = 0, alpha = 255 } = {}) {
  const n = w * h;
  const data = new Uint8ClampedArray(n * 4);
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let p = 0;
  for (const [r, g, b, share] of parts) {
    const end = Math.min(n, p + Math.round(share * n));
    for (; p < end; p++) {
      const j = () => (noise ? Math.round((rand() * 2 - 1) * noise) : 0);
      data.set([r + j(), g + j(), b + j(), alpha], p * 4);
    }
  }
  // Anything left over is the first colour.
  for (; p < n; p++) data.set([parts[0][0], parts[0][1], parts[0][2], alpha], p * 4);
  return { data, width: w, height: h };
}

const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const near = (hex, rgb, d = 30) => colorDistance(rgbOf(hex), rgb) < d;
const find = (r, rgb) => r.palette.find((c) => near(c.hex, rgb));

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const RED = [220, 30, 30];
const SKY = [110, 170, 230];

describe('colour helpers', () => {
  it('writes hex, reads luminance and chroma', () => {
    expect(hexOf([255, 0, 128.4])).toBe('#ff0080');
    expect(hexOf([-3, 300, 15])).toBe('#00ff0f');
    expect(luminanceOf(WHITE)).toBeCloseTo(1, 5);
    expect(luminanceOf(BLACK)).toBe(0);
    expect(luminanceOf([119, 119, 119])).toBeCloseTo(0.184, 2);
    expect(chromaOf([128, 128, 128])).toBe(0);
    expect(chromaOf([255, 0, 0])).toBe(1);
  });

  it('bands tone where neither black nor white text clearly wins', () => {
    expect(toneOf(0.05)).toBe('dark');
    expect(toneOf(0.18)).toBe('mid');
    expect(toneOf(0.6)).toBe('light');
    expect(TONE_DARK).toBeLessThan(0.179);
    expect(TONE_LIGHT).toBeGreaterThan(0.179);
  });

  it('merges near colours into the larger, weighted', () => {
    const out = mergeNear([{ color: [250, 250, 250], count: 30 }, { color: [255, 255, 255], count: 70 }, { color: [0, 0, 0], count: 5 }]);
    expect(out).toHaveLength(2);
    expect(out[0].count).toBe(100);
    expect(out[0].color[0]).toBeCloseTo(253.5, 5);
    expect(colorDistance([255, 255, 255], [240, 240, 240])).toBeLessThan(MERGE_DISTANCE);
    expect(colorDistance(WHITE, RED)).toBeGreaterThan(MERGE_DISTANCE);
  });

  it('median cut never cuts a flat colour in two', () => {
    const { data } = picture([[...WHITE, 1]], { w: 10, h: 10 });
    const rgb = new Uint8Array(300);
    for (let k = 0; k < 100; k++) rgb.set(data.subarray(k * 4, k * 4 + 3), k * 3);
    expect(medianCut(rgb, 100, 6)).toEqual([{ color: WHITE, count: 100 }]);
  });
});

describe('paletteOf', () => {
  it('finds the colours and their shares, largest first, with the red ink as the accent', () => {
    const r = paletteOf(picture([[...WHITE, 0.7], [...BLACK, 0.2], [...RED, 0.1]], { noise: 6 }));
    expect(r.palette).toHaveLength(3);
    expect(near(r.palette[0].hex, WHITE)).toBe(true);
    expect(r.palette.map((c) => c.share)).toEqual([0.7, 0.2, 0.1]);
    expect(find(r, BLACK)).toBeTruthy();
    expect(near(r.accent, RED)).toBe(true);
    expect(r.tone).toBe('light');
    expect(r.palette.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 2);
  });

  it('picks the SFX ink on a coloured background, not the background', () => {
    const r = paletteOf(picture([[...SKY, 0.75], [...RED, 0.15], [...BLACK, 0.1]], { noise: 8 }));
    expect(near(r.palette[0].hex, SKY)).toBe(true);
    expect(near(r.accent, RED)).toBe(true);
  });

  it('has no accent on a black and white page, nor when the only colour is the background', () => {
    const bw = paletteOf(picture([[...WHITE, 0.6], [...BLACK, 0.3], [128, 128, 128, 0.1]], { noise: 10 }));
    expect(bw.accent).toBeNull();
    const sky = paletteOf(picture([[...SKY, 0.8], [...BLACK, 0.2]], { noise: 5 }));
    expect(sky.accent).toBeNull();
    // Yellowed paper is not an accent either.
    const paper = paletteOf(picture([[...WHITE, 0.6], [245, 235, 210, 0.3], [...BLACK, 0.1]]));
    expect(paper.accent).toBeNull();
  });

  it(`ignores a colour under ${ACCENT_MIN_SHARE * 100}% for the accent`, () => {
    const r = paletteOf(picture([[...WHITE, 0.78], [...BLACK, 0.2], [...RED, 0.02]]));
    expect(r.accent).toBeNull();
  });

  it('prefers the more colourful of two accents', () => {
    const r = paletteOf(picture([[...WHITE, 0.6], [200, 120, 120, 0.2], [20, 200, 40, 0.2]]));
    expect(near(r.accent, [20, 200, 40])).toBe(true);
  });

  it('merges a grainy background into one colour', () => {
    const r = paletteOf(picture([[250, 250, 250, 0.5], [240, 241, 239, 0.4], [...BLACK, 0.1]], { noise: 4 }));
    expect(r.palette).toHaveLength(2);
    expect(r.palette[0].share).toBeCloseTo(0.9, 2);
  });

  it('averages light as the eye does: a 50% halftone is a light grey, not #808080', () => {
    const w = 40;
    const data = new Uint8ClampedArray(w * w * 4);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) data.set((x + y) % 2 ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * w + x) * 4);
    const r = paletteOf({ data, width: w, height: w });
    expect(r.luminance).toBeCloseTo(0.5, 2);
    expect(r.mean).toBe('#bcbcbc');
    expect(r.tone).toBe('light');
    expect(r.palette.map((c) => c.share)).toEqual([0.5, 0.5]);
  });

  it('calls a dark balloon dark and a mid grey mid', () => {
    expect(paletteOf(picture([[20, 20, 30, 0.9], [...WHITE, 0.1]])).tone).toBe('dark');
    expect(paletteOf(picture([[119, 119, 119, 1]])).tone).toBe('mid');
  });

  it('keeps to the colours asked for, 2 to 8', () => {
    const many = [[...WHITE, 0.3], [...BLACK, 0.1], [...RED, 0.1], [...SKY, 0.1], [20, 200, 40, 0.1], [240, 220, 20, 0.1], [140, 40, 200, 0.1], [250, 140, 20, 0.05], [90, 60, 30, 0.05]];
    expect(paletteOf(picture(many), { count: 2 }).palette.length).toBeLessThanOrEqual(2);
    expect(paletteOf(picture(many), { count: 8 }).palette.length).toBe(8);
    expect(paletteOf(picture(many), { count: 40 }).palette.length).toBeLessThanOrEqual(8);
    expect(paletteOf(picture(many)).palette.length).toBeLessThanOrEqual(5);
  });

  it('gives the same answer for the same pixels', () => {
    const img = picture([[...SKY, 0.5], [...RED, 0.3], [...BLACK, 0.2]], { noise: 20 });
    expect(paletteOf(img)).toEqual(paletteOf(img));
  });

  it('skips transparent pixels, and is null when nothing is opaque', () => {
    const img = picture([[...RED, 1]], { w: 10, h: 10 });
    for (let k = 0; k < 50; k++) img.data[k * 4 + 3] = 0;
    const r = paletteOf(img);
    expect(r.palette).toEqual([{ hex: '#dc1e1e', share: 1 }]);
    expect(paletteOf(picture([[...RED, 1]], { alpha: 0 }))).toBeNull();
    expect(paletteOf({ data: new Uint8ClampedArray(0) })).toBeNull();
    expect(paletteOf(null)).toBeNull();
  });

  it('reads a 400 x 400 grainy region quickly', () => {
    const img = picture([[...SKY, 0.6], [...RED, 0.25], [...BLACK, 0.15]], { w: 400, h: 400, noise: 25 });
    const t = performance.now();
    const r = paletteOf(img, { count: 8 });
    expect(performance.now() - t).toBeLessThan(2000);
    expect(near(r.accent, RED, 60)).toBe(true);
  });
});
