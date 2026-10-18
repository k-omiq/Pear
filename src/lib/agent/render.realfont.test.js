// Smoke test with a real canvas (@napi-rs/canvas, set up by the realfont
// lane): the pictures come out as PNGs of the size the layout says, with the
// boxes' text painted by the exporter. MT_RENDER_DUMP=<dir> writes them out to
// look at.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadImage, createCanvas, Image } from '@napi-rs/canvas';
import { normalizeStyle } from '../data.js';
import { setTypesetEnabled, typesetEnabled } from '../measure.js';
import { renderRegion, proofSheet, sheetLayout, MAX_SIDE, COMPARE_GAP } from './render.js';

const DUMP = process.env.MT_RENDER_DUMP;

const pngSize = async (b64) => {
  const buf = Buffer.from(b64, 'base64');
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
  const img = await loadImage(buf);
  return [img.width, img.height];
};

const dump = async (name, b64) => {
  if (!DUMP) return;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${DUMP}/${name}.png`, Buffer.from(b64, 'base64'));
};

const style = normalizeStyle({ font: 'Comic Neue', size: 24, bold: false, align: 'center', color: '#000000' });
const page = () => ({
  id: 901,
  w: 800,
  h: 1200,
  lines: [],
  boxes: [
    {
      id: 'b1', lineN: null, text: 'HELLO THERE', x: 100, y: 100, w: 200, h: 120, style,
      fit: { kind: 'ellipse', cx: 200, cy: 160, rx: 120, ry: 80 }, outline: { source: 'fill', confidence: 0.4, approved: null },
    },
    {
      id: 'b2', lineN: null, text: 'WHAT', x: 400, y: 700, w: 150, h: 90, style,
      outline: { source: 'box', confidence: 0, approved: null, open: true },
    },
  ],
});

let before;
beforeAll(() => {
  before = typesetEnabled();
  setTypesetEnabled(true);
});
afterAll(() => setTypesetEnabled(before));

describe('renderRegion (real canvas)', () => {
  it('returns a PNG of the page fitted to the long side', async () => {
    const r = await renderRegion(page(), null, { marks: { rulers: true } });
    expect(r.mime).toBe('image/png');
    expect(r.png.startsWith('data:')).toBe(false);
    expect([r.width, r.height]).toEqual([Math.round(800 * (MAX_SIDE / 1200)), MAX_SIDE]);
    expect(await pngSize(r.png)).toEqual([r.width, r.height]);
    expect(r.boxes.map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it('crops a region with marks at the given scale', async () => {
    const r = await renderRegion(page(), [50, 50, 300, 200], { scale: 1.5, marks: { ids: true, outlines: true, rulers: true } });
    expect([r.width, r.height, r.scale]).toEqual([450, 300, 1.5]);
    expect(await pngSize(r.png)).toEqual([450, 300]);
    expect(r.boxes.map((b) => b.id)).toEqual(['b1']);
    await dump('region', r.png);
  });

  it('gives a box shown only by its outline a cell inside the image', async () => {
    const r = await renderRegion(page(), [310, 100, 200, 200], { scale: 1, marks: { outlines: true } });
    expect(r.boxes.map((b) => b.id)).toEqual(['b1']);
    const [c] = r.boxes;
    expect(c.w).toBeGreaterThan(0);
    expect(c.h).toBeGreaterThan(0);
    expect(c.x + c.w).toBeLessThanOrEqual(r.width);
    expect(c.y + c.h).toBeLessThanOrEqual(r.height);
  });
});

describe('proofSheet (real canvas)', () => {
  it('draws one cell per box, at the layout size', async () => {
    const p = page();
    const s = await proofSheet(p, p.boxes);
    const L = sheetLayout(2);
    expect([s.width, s.height]).toEqual([L.width, L.height]);
    expect(s.cells.map((c) => c.id)).toEqual(['b1', 'b2']);
    expect(await pngSize(s.png)).toEqual([L.width, L.height]);
    await dump('sheet', s.png);
  });
});

// The raw scan red, the cleaned page white: the original panel shows red and
// ours white (with our text), so each panel is told by its colour.
const solid = (color) => {
  const c = createCanvas(800, 1200);
  const x = c.getContext('2d');
  x.fillStyle = color;
  x.fillRect(0, 0, 800, 1200);
  return `data:image/png;base64,${c.toBuffer('image/png').toString('base64')}`;
};
const pixel = async (b64, x, y) => {
  const img = await loadImage(Buffer.from(b64, 'base64'));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
};
const withImages = async (fn) => {
  const prev = globalThis.Image;
  globalThis.Image = Image;
  try {
    return await fn({ ...page(), raw: solid('#dd2222'), cleaned: solid('#ffffff') });
  } finally {
    globalThis.Image = prev;
  }
};

describe('compare (real canvas)', () => {
  it('puts the raw scan beside ours for a tall region, ours carrying the box cells', async () => {
    await withImages(async (p) => {
      const r = await renderRegion(p, [50, 50, 300, 400], { scale: 1, source: 'compare', marks: { ids: true } });
      expect([r.width, r.height]).toEqual([600 + COMPARE_GAP, 400]);
      expect(r.panels).toEqual({ original: [0, 0, 300, 400], ours: [300 + COMPARE_GAP, 0, 300, 400] });
      expect(r.boxes.every((b) => b.x >= 300 + COMPARE_GAP)).toBe(true);
      // Below the tabs, away from the box: red in the original, white in ours.
      expect(await pixel(r.png, 150, 380)).toEqual([0xdd, 0x22, 0x22]);
      expect(await pixel(r.png, 300 + COMPARE_GAP + 150, 380)).toEqual([255, 255, 255]);
      await dump('compare-tall', r.png);
    });
  });

  it('stacks them for a wide region', async () => {
    await withImages(async (p) => {
      const r = await renderRegion(p, [0, 600, 400, 200], { scale: 1, source: 'compare' });
      expect([r.width, r.height]).toEqual([400, 400 + COMPARE_GAP]);
      expect(await pixel(r.png, 200, 190)).toEqual([0xdd, 0x22, 0x22]);
      expect(await pixel(r.png, 200, 200 + COMPARE_GAP + 190)).toEqual([255, 255, 255]);
    });
  });

  it('gives each box of a proof sheet its original and ours', async () => {
    await withImages(async (p) => {
      const s = await proofSheet(p, [p.boxes[0]], { cell: 360, source: 'compare' });
      const [cell] = s.cells;
      // b1 is wider than tall: the original above, ours below.
      const mid = cell.x + Math.round(cell.w / 2);
      expect(await pixel(s.png, mid, cell.y + 6 + Math.round(cell.h * 0.05) + 40)).toEqual([0xdd, 0x22, 0x22]);
      expect(await pixel(s.png, cell.x + 4, cell.y + cell.h - 6)).not.toEqual([0xdd, 0x22, 0x22]);
      await dump('compare-sheet', s.png);
    });
  });
});
