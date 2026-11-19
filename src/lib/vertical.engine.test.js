import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { clearLayoutMemo, verticalLayout, measureMemoHeld, setTypesetEnabled, typesetEnabled } from './measure.js';
import { renderBoxTexture, glyphJob } from './exporter.js';
import { boxCandidate, boxInkRect, placeBlock } from './contain.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// Vertical text under the Rust engine: the columns are a glyph layout like
// the curves, measured in the engine's advances and painted letter by letter
// where the footprint (`boxInkRect`) has them.
// ===========================================================================

const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
let rust;
beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  rust = await rustEngine();
  setTextEngine(rust);
  setGlyphPainter(createRustGlyphPainter(rust));
  setTypesetEnabled(true);
  clearLayoutMemo();
});
afterAll(() => {
  setTextEngine(before.engine);
  setGlyphPainter(before.painter);
  setTypesetEnabled(before.typeset);
  clearLayoutMemo();
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});

const styleOf = (over = {}) =>
  normalizeStyle({ ...defaultStyle(), font: 'DejaVu Sans', size: 48, lineHeight: 1.4, strokeEffects: [], autoHeight: false, color: '#000000', vertical: true, align: 'left', ...over });

// The painted texture's ink, in box px.
function paintedInk(box, page) {
  const t = renderBoxTexture(box, page, null, 2);
  const { width: w, height: h } = t.canvas;
  const px = t.canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (px[(j * w + i) * 4 + 3] > 0) {
    x0 = Math.min(x0, i);
    x1 = Math.max(x1, i + 1);
    y0 = Math.min(y0, j);
    y1 = Math.max(y1, j + 1);
  }
  const ss = w / t.cw;
  return { x0: x0 / ss - t.ox, x1: x1 / ss - t.ox, y0: y0 / ss - t.oy, y1: y1 / ss - t.oy };
}

describe('vertical text under the Rust engine', () => {
  it('runs a sideways word down the column in the engine\'s own advances', () => {
    const s = styleOf({ verticalLatin: 'sideways' });
    const g = verticalLayout('AVA', s, 48, 400, 600);
    const adv = (ch) => rust.advance({ key: `400 48px x`, name: 'DejaVu Sans', bold: false, italic: false, size: 48, css: 'x' }, ch);
    expect(g[1].y - g[0].y).toBeCloseTo((adv('A') + adv('V')) / 2, 6);
    for (const x of g) expect(x.rot).toBeCloseTo(Math.PI / 2, 9);
  });

  it('keeps a layout it made, and counts what it keeps', () => {
    clearLayoutMemo();
    const s = styleOf();
    const a = verticalLayout('ABC\nDE', s, 48, 400, 600);
    expect(verticalLayout('ABC\nDE', s, 48, 400, 600)).toBe(a);
    expect(measureMemoHeld()).toBeGreaterThanOrEqual(6);
  });

  for (const latin of ['upright', 'sideways']) {
    it(`paints ${latin} Latin where the footprint has it`, () => {
      const s = styleOf({ verticalLatin: latin });
      const box = { id: 'b', lineN: null, text: 'ABC\nDEF', x: 100, y: 100, w: 300, h: 400, style: s };
      const page = { id: 1, w: 700, h: 800, lines: [], boxes: [box] };
      clearLayoutMemo();
      const place = placeBlock(boxCandidate(box, box.text));
      expect(place.vertical).toBe(true);
      // Placed a letter at a time, so shaped a letter at a time.
      const job = glyphJob(box, { s, isCurve: true, vertical: true, layout: place.layout, ox: 0, oy: 0 });
      expect(job.line).toBeUndefined();
      expect(job.runs.map((r) => r.text)).toEqual([...'ABCDEF']);
      const ink = paintedInk(box, page);
      const r = boxInkRect(boxCandidate(box, box.text));
      expect(Math.abs(r.x - ink.x0)).toBeLessThan(0.75);
      expect(Math.abs(r.x + r.w - ink.x1)).toBeLessThan(0.75);
      expect(Math.abs(r.y - ink.y0)).toBeLessThan(0.75);
      expect(Math.abs(r.y + r.h - ink.y1)).toBeLessThan(0.75);
      // Two columns, the first on the right: the ink is wider than one.
      expect(ink.x1 - ink.x0).toBeGreaterThan(48 * 1.4);
    });
  }
});
