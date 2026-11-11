import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { pictureKey } from './editor/box-picture.js';
import { isRasterOnly } from './psd.js';

// ===========================================================================
// Paint over the letters as the engine lays it (box wire v21): colour on the
// fill where the marks lie, in the box's own frame so it moves with the box,
// nothing outside the letters, and nothing at all under a painter that does
// not paint whole boxes.
// ===========================================================================

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let rust;
let rustPainter;

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  rust = await rustEngine();
  rustPainter = createRustGlyphPainter(rust);
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

const rect = (x0, y0, x1, y1, more = {}) => ({ kind: 'poly', color: '#ff0000', opacity: 100, soft: 0, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], ...more });
const styleOf = (paint = null, over = {}) =>
  normalizeStyle({ ...defaultStyle(), strokeEffects: [], font: 'Bangers', size: 64, color: '#000000', strokes: [], autoHeight: false, shape: 'off', ...(paint ? { paint } : {}), ...over });
const boxOf = (style, x = 100) => ({ id: 'b', lineN: null, text: 'MMMMMM', x, y: 100, w: 360, h: 100, style });
const pageOf = (b) => ({ id: 1, w: 1000, h: 800, lines: [], boxes: [b] });
const tex = (b) => renderBoxTexture(b, pageOf(b), new Map(), 2);
const bytes = (t) => Buffer.from(t.canvas.getContext('2d').getImageData(0, 0, t.canvas.width, t.canvas.height).data);

// The pixels of the picture over a band of box-local x, as [r, g, b, a].
function band(b, t, x0, x1) {
  const { width: w, height: h } = t.canvas;
  const d = t.canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const ss = w / t.cw;
  const out = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = -t.ox + (i + 0.5) / ss;
      if (x > x0 && x < x1 && d[(j * w + i) * 4 + 3] === 255) out.push([d[(j * w + i) * 4], d[(j * w + i) * 4 + 1], d[(j * w + i) * 4 + 2]]);
    }
  }
  return out;
}
const rust_ = () => {
  setTextEngine(rust);
  setGlyphPainter(rustPainter);
  clearLayoutMemo();
};

describe('paint over the letters', () => {
  it('colours the letters where its marks lie, in the box\'s own frame, and nothing else', () => {
    rust_();
    // The left half of the box red.
    const b = boxOf(styleOf({ on: true, marks: [rect(-50, -50, 180, 200)] }));
    const t = tex(b);
    const left = band(b, t, 70, 170);
    const right = band(b, t, 190, 290);
    expect(left.length).toBeGreaterThan(50);
    expect(left.every(([r, g, bl]) => r === 255 && g === 0 && bl === 0)).toBe(true);
    expect(right.every(([r, g, bl]) => r === 0 && g === 0 && bl === 0)).toBe(true);
    // The letters' shape is the plain box's: alpha for alpha.
    const plain = tex(boxOf(styleOf()));
    const alpha = (x) => bytes(x).filter((_, i) => i % 4 === 3);
    expect(Buffer.compare(alpha(t), alpha(plain))).toBe(0);
  });

  it('moves with the box: the same picture wherever it stands', () => {
    rust_();
    const st = styleOf({ on: true, marks: [rect(-50, -50, 180, 200)] });
    expect(bytes(tex(boxOf(st, 100))).equals(bytes(tex(boxOf(st, 263))))).toBe(true);
  });

  it('an eraser takes paint away, and paint that is off or all eraser is the plain box', () => {
    rust_();
    const plain = bytes(tex(boxOf(styleOf())));
    const erased = styleOf({ on: true, marks: [rect(-50, -50, 400, 200), rect(-50, -50, 400, 200, { kind: 'stroke', size: 900, pts: [[0, 50], [360, 50]], erase: true })] });
    expect(bytes(tex(boxOf(erased))).equals(plain)).toBe(true);
    expect(bytes(tex(boxOf(styleOf({ on: false, marks: [rect(-50, -50, 400, 200)] })))).equals(plain)).toBe(true);
  });

  it('under a painter that does not paint whole boxes, the box is painted as it is with none', () => {
    setTextEngine(rust);
    setGlyphPainter({ ...rustPainter, box: false, paintBox: undefined, mesh: false });
    clearLayoutMemo();
    const a = tex(boxOf(styleOf({ on: true, marks: [rect(-50, -50, 400, 200)] })));
    const p = tex(boxOf(styleOf()));
    expect(bytes(a).equals(bytes(p))).toBe(true);
  });

  it('keys the picture by the paint\'s revision, not its marks, and ships as pixels in a PSD', () => {
    const marks = Array.from({ length: 400 }, (_, i) => ({ kind: 'stroke', color: '#00ff00', opacity: 100, soft: 0, size: 4, pts: [[i, 1], [i + 2, 3]] }));
    const st = styleOf({ on: true, marks });
    const k = (style) => pictureKey({ style, inkKey: '', text: 'M', w: 1, h: 1, lines: null, indents: null, scale: 1, fonts: 0 });
    const key = k(st);
    expect(key.length).toBeLessThan(k(styleOf()).length + 64);
    expect(k(st)).toBe(key);
    expect(k({ ...st, paint: { ...st.paint, marks: [...st.paint.marks] } })).not.toBe(key);
    expect(isRasterOnly(st)).toBe(true);
    expect(isRasterOnly(styleOf())).toBe(false);
  });
});
