// Smoke test with a real canvas (@napi-rs/canvas, set up by the realfont
// lane): the pictures come out as PNGs of the size the layout says, with the
// boxes' text painted by the exporter. MT_RENDER_DUMP=<dir> writes them out to
// look at.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadImage } from '@napi-rs/canvas';
import { normalizeStyle } from '../data.js';
import { setTypesetEnabled, typesetEnabled } from '../measure.js';
import { renderRegion, proofSheet, sheetLayout, MAX_SIDE } from './render.js';

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
