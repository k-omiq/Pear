import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { boxFootprint } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';

// A shadow is padded on the sides it is thrown to, not by its full throw on every side.
const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  const rust = await rustEngine();
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

const box = (shadows) => ({
  id: 'b1',
  lineN: null,
  text: 'HI',
  x: 100,
  y: 100,
  w: 120,
  h: 60,
  style: normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 24, strokes: [], shadows }),
});
const page = (b) => ({ id: 1, w: 800, h: 800, lines: [], boxes: [b] });

describe('the footprint and a drop shadow', () => {
  it('pads the throw side by the offset and the far side by no more than a plain box', () => {
    const b = box([{ x: 40, y: 0, size: 0, color: '#000000', opacity: 1, blend: 'normal' }]);
    const plain = box([]);
    const f = boxFootprint(b, page(b));
    const f0 = boxFootprint(plain, page(plain));
    expect(f.cw - f.ox - b.w - (f0.cw - f0.ox - b.w)).toBeGreaterThanOrEqual(36);
    expect(f.ox).toBe(f0.ox);
    expect(f.ch).toBe(f0.ch);
  });
});
