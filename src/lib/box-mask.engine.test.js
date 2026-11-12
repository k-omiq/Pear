import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBox, renderBoxTexture } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { normalizeMask } from './box-mask.js';

// ===========================================================================
// The mask as both painters cut it: keep and hide shapes in one mask, pinned
// to the page and cut after the warp, by the engine (stage 12) and by its
// canvas twin (`cutMask`) alike.
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

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), strokeEffects: [], font: 'Bangers', size: 64, color: '#000000', strokes: [], autoHeight: false, shape: 'off', ...over });
const rect = (x0, y0, x1, y1, op) => ({ kind: 'poly', op, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const boxOf = (over = {}, mask = null) => ({ id: 'b', lineN: null, text: 'MMMMMM', x: 100, y: 100, w: 360, h: 100, style: style(over), mask: mask ? normalizeMask(mask) : null });
const pageOf = (b) => ({ id: 1, w: 1000, h: 800, lines: [], boxes: [b] });

// The alpha of every pixel of a picture, by the page px its centre is on
// (an upright box: a picture's corner is (ox, oy) page px off the box's).
function inkByPage(box, tex) {
  const { width: w, height: h } = tex.canvas;
  const d = tex.canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const ss = w / tex.cw;
  const out = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const a = d[(j * w + i) * 4 + 3];
      if (a) out.push([box.x - tex.ox + (i + 0.5) / ss, box.y - tex.oy + (j + 0.5) / ss, a]);
    }
  }
  return out;
}

const engines = {
  rust: () => {
    setTextEngine(rust);
    setGlyphPainter(rustPainter);
  },
  // The browser painter: the box's passes on the canvas, the mask by
  // `cutMask`.
  canvas: () => {
    setTextEngine(rust);
    setGlyphPainter({ ...rustPainter, box: false, paintBox: undefined, mesh: false });
  },
};

describe('keep and hide in one mask', () => {
  for (const [name, use] of Object.entries(engines)) {
    it(`${name}: the letters show inside the keep shapes, less the hide ones`, () => {
      use();
      clearLayoutMemo();
      // The plain box's letters run from about x 159 to 403.
      const mask = { on: true, shapes: [rect(200, 0, 380, 800, 'keep'), rect(270, 0, 310, 800, 'hide')] };
      const plain = inkByPage(boxOf(), renderBoxTexture(boxOf(), pageOf(boxOf()), new Map(), 2));
      const b = boxOf({}, mask);
      const ink = inkByPage(b, renderBoxTexture(b, pageOf(b), new Map(), 2));
      const cut = ([x]) => x < 199.5 || (x > 270.5 && x < 309.5) || x > 380.5;
      // Ink where the mask lets it through, and none where it does not (half
      // a page px of antialiasing at each cut).
      expect(ink.some(([x]) => x > 210 && x < 260)).toBe(true);
      expect(ink.some(([x]) => x > 320 && x < 370)).toBe(true);
      expect(ink.filter(cut)).toEqual([]);
      // And the plain box had ink in each of the three parts cut.
      expect(plain.some(([x]) => x < 199.5)).toBe(true);
      expect(plain.some(([x]) => x > 270.5 && x < 309.5)).toBe(true);
      expect(plain.some(([x]) => x > 380.5)).toBe(true);
    });
  }

  it('a mask with only hide shapes shows the rest of the box whole', () => {
    engines.rust();
    clearLayoutMemo();
    const b = boxOf({}, { on: true, shapes: [rect(0, 0, 5, 5, 'hide')] });
    const plain = boxOf();
    const a = renderBoxTexture(b, pageOf(b), new Map(), 2);
    const p = renderBoxTexture(plain, pageOf(plain), new Map(), 2);
    expect(a.canvas.width).toBe(p.canvas.width);
    const da = a.canvas.getContext('2d').getImageData(0, 0, a.canvas.width, a.canvas.height).data;
    const dp = p.canvas.getContext('2d').getImageData(0, 0, p.canvas.width, p.canvas.height).data;
    expect(Buffer.from(da).equals(Buffer.from(dp))).toBe(true);
  });
});

describe('the mask is cut after the warp, never bent', () => {
  // A mesh that slides the letters 40 px right: the mask stays where it is
  // on the page, so it cuts the slid letters.
  const pts = [];
  for (let r = 0; r <= 2; r++) for (let c = 0; c <= 2; c++) pts.push([c * 180 + 40, r * 50]);
  const warp = { on: true, cols: 2, rows: 2, pts };
  for (const [name, use] of Object.entries(engines)) {
    it(name, () => {
      use();
      clearLayoutMemo();
      const b = boxOf({ warp }, { on: true, shapes: [rect(220, 0, 360, 800, 'keep')] });
      const tex = renderBox(b, pageOf(b), new Map());
      const ink = inkByPage(b, { ...tex, canvas: tex.canvas });
      expect(ink.length).toBeGreaterThan(0);
      expect(ink.filter(([x]) => x < 219.5 || x > 360.5)).toEqual([]);
      // The slid letters reach past the mask on the right: there was ink to cut.
      const free = inkByPage(boxOf({ warp }), renderBox(boxOf({ warp }), pageOf(boxOf({ warp })), new Map()));
      expect(free.some(([x]) => x > 400)).toBe(true);
    });
  }
});
