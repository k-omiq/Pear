// The colour and font pictures with a real canvas (@napi-rs/canvas, set up by
// the realfont lane): a region read back as pixels gives the colours that
// were painted there, and a font sheet comes out the size its layout says,
// with every sample inked in its own face. MT_RENDER_DUMP=<dir> writes the
// sheets out to look at.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas, loadImage, Image } from '@napi-rs/canvas';
import { normalizeStyle } from '../data.js';
import { setTypesetEnabled, typesetEnabled } from '../measure.js';
import { regionPixels, renderFontSheet, fontSheetLayout, PIXELS_MAX_SIDE } from './render.js';
import { paletteOf, colorDistance } from './palette.js';

const DUMP = process.env.MT_RENDER_DUMP;
const dump = async (name, b64) => {
  if (!DUMP) return;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${DUMP}/${name}.png`, Buffer.from(b64, 'base64'));
};
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Decoded RGBA of a base64 PNG.
async function decode(b64) {
  const img = await loadImage(Buffer.from(b64, 'base64'));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { ...ctx.getImageData(0, 0, img.width, img.height), width: img.width, height: img.height };
}
const inkIn = ({ data, width }, [x, y, w, h]) => {
  let n = 0;
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (data[(j * width + i) * 4] < 100) n++;
  return n;
};

let before;
beforeAll(() => {
  before = typesetEnabled();
  setTypesetEnabled(true);
});
afterAll(() => setTypesetEnabled(before));

describe('regionPixels (real canvas)', () => {
  const red = normalizeStyle({ font: 'Bangers', size: 90, bold: false, align: 'center', color: '#dd2222' });
  const page = () => ({
    id: 902, w: 800, h: 1200, lines: [],
    boxes: [{ id: 'sfx', lineN: null, text: 'BOOM', x: 200, y: 300, w: 300, h: 140, style: red }],
  });

  it('reads the typeset ink of a box back as its colour', async () => {
    const px = await regionPixels(page(), [200, 300, 300, 140], { source: 'typeset' });
    expect([px.width, px.height, px.scale]).toEqual([300, 140, 1]);
    expect(px.data).toHaveLength(300 * 140 * 4);
    const r = paletteOf(px);
    expect(r.palette[0].hex).toBe('#ffffff');
    expect(colorDistance(rgbOf(r.accent), [0xdd, 0x22, 0x22])).toBeLessThan(40);
  });

  it('reads a whole page small: the long side at most 400 px', async () => {
    const px = await regionPixels(page(), null, { source: 'typeset' });
    expect(Math.max(px.width, px.height)).toBe(PIXELS_MAX_SIDE);
    expect(px.rect).toEqual([0, 0, 800, 1200]);
    expect(paletteOf(px).tone).toBe('light');
  });

  it('reads the raw art, not our text', async () => {
    // A raw page: dark blue sky with a yellow SFX blot.
    const art = createCanvas(800, 1200);
    const a = art.getContext('2d');
    a.fillStyle = '#1b2a6b';
    a.fillRect(0, 0, 800, 1200);
    a.fillStyle = '#f2c81e';
    a.fillRect(220, 320, 60, 40); // about 6% of the rect read
    const prev = globalThis.Image;
    globalThis.Image = Image;
    try {
      const p = { ...page(), raw: `data:image/png;base64,${art.toBuffer('image/png').toString('base64')}` };
      const r = paletteOf(await regionPixels(p, [200, 300, 300, 140], { source: 'raw' }));
      expect(r.tone).toBe('dark');
      expect(colorDistance(rgbOf(r.palette[0].hex), [0x1b, 0x2a, 0x6b])).toBeLessThan(20);
      expect(colorDistance(rgbOf(r.accent), [0xf2, 0xc8, 0x1e])).toBeLessThan(20);
    } finally {
      globalThis.Image = prev;
    }
  });
});

describe('renderFontSheet (real canvas)', () => {
  const entries = [
    { n: 1, name: 'Comic Neue', css: "'Comic Neue', cursive", missing: false },
    { n: 2, name: 'Bangers', css: "'Bangers', cursive", missing: false },
    { n: 3, name: 'DejaVu Sans', css: "'DejaVu Sans', sans-serif", missing: false },
    { n: 4, name: 'Ghost', css: "'Ghost', sans-serif", missing: true },
  ];

  it('draws a sheet of the layout size with every sample inked, each face its own', async () => {
    const text = 'WHAT IS THIS?! Sorcery... BOOM';
    const s = await renderFontSheet(entries, { text });
    const L = fontSheetLayout(entries.length);
    expect([s.width, s.height]).toEqual([L.width, L.height]);
    expect(s.mime).toBe('image/png');
    expect(s.cells.map((c) => [c.n, c.name, c.row, c.col])).toEqual([[1, 'Comic Neue', 1, 1], [2, 'Bangers', 2, 1], [3, 'DejaVu Sans', 3, 1], [4, 'Ghost', 4, 1]]);
    const img = await decode(s.png);
    expect([img.width, img.height]).toEqual([L.width, L.height]);
    // The sample band of each cell, under its label.
    const band = (k) => [k.x + 8, k.y + L.label + 8, k.w - 16, k.h - L.label - 10];
    const ink = L.cells.map((k) => inkIn(img, band(k)));
    for (const n of ink) expect(n).toBeGreaterThan(500);
    // Different faces ink differently: Bangers is condensed and heavy.
    expect(Math.abs(ink[0] - ink[1])).toBeGreaterThan(ink[0] * 0.05);
    await dump('font-sheet', s.png);
  });

  it('shrinks a sample that is wider than its cell', async () => {
    const long = 'M'.repeat(60);
    const s = await renderFontSheet(entries.slice(0, 2), { text: long });
    const L = fontSheetLayout(2);
    for (const c of s.cells) expect(c.size).toBeLessThan(L.sample);
  });

  it('lays out forty fonts on one sheet within the long side', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...entries[i % 3], n: i + 1 }));
    const s = await renderFontSheet(many, { text: 'Sorcery?!' });
    expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(1568);
    expect(s.cells).toHaveLength(40);
    expect(s.cells.at(-1)).toMatchObject({ row: 20, col: 2 });
    await dump('font-sheet-40', s.png);
  });
});
