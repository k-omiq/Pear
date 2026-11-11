import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { normalizeFade } from './box-fade.js';

// ===========================================================================
// The fade as the engine lays it (box wire v20): pinned to the page, the
// letters losing opacity where its shapes lie, and nothing at all under a
// painter that does not paint whole boxes - the fade has no canvas twin.
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

const style = normalizeStyle({ ...defaultStyle(), strokeEffects: [], font: 'Bangers', size: 64, color: '#000000', strokes: [], autoHeight: false, shape: 'off' });
const rect = (x0, y0, x1, y1, strength, soft = 0) => ({ kind: 'poly', strength, soft, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const boxOf = (fade = null, x = 100) => ({ id: 'b', lineN: null, text: 'MMMMMM', x, y: 100, w: 360, h: 100, style, ...(fade ? { fade: normalizeFade(fade) } : {}) });
const pageOf = (b) => ({ id: 1, w: 1000, h: 800, lines: [], boxes: [b] });
const tex = (b) => renderBoxTexture(b, pageOf(b), new Map(), 2);

// The largest alpha of the picture over a band of page x, an upright box.
function most(b, t, x0, x1) {
  const { width: w, height: h } = t.canvas;
  const d = t.canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const ss = w / t.cw;
  let m = 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = b.x - t.ox + (i + 0.5) / ss;
      if (x > x0 && x < x1) m = Math.max(m, d[(j * w + i) * 4 + 3]);
    }
  }
  return m;
}
const bytes = (t) => Buffer.from(t.canvas.getContext('2d').getImageData(0, 0, t.canvas.width, t.canvas.height).data);

describe('the fade', () => {
  it('takes its strength where it lies on the page, and nothing elsewhere', () => {
    setTextEngine(rust);
    setGlyphPainter(rustPainter);
    clearLayoutMemo();
    // The letters run from about page x 159 to 403: the left part faded to
    // 40 %, a stripe of it away entirely.
    const b = boxOf({ on: true, shapes: [rect(0, 0, 260, 800, 60), rect(200, 0, 230, 800, 100)] });
    const t = tex(b);
    const plain = tex(boxOf());
    expect(most(boxOf(), plain, 160, 195)).toBe(255);
    expect(Math.abs(most(b, t, 160, 195) - 102)).toBeLessThanOrEqual(1);
    expect(most(b, t, 201, 229)).toBe(0);
    expect(most(b, t, 270, 400)).toBe(255);
  });

  it('stays on the page when the box moves: a warm paint is a cold one, to the byte', async () => {
    setTextEngine(rust);
    setGlyphPainter(rustPainter);
    clearLayoutMemo();
    const fade = { on: true, shapes: [rect(150, 0, 300, 800, 70, 40)] };
    tex(boxOf(fade, 100));
    const warm = tex(boxOf(fade, 117));
    // A fresh engine: nothing kept.
    const fresh = await rustEngine();
    setTextEngine(fresh);
    setGlyphPainter(createRustGlyphPainter(fresh));
    clearLayoutMemo();
    const cold = tex(boxOf(fade, 117));
    expect(bytes(warm).equals(bytes(cold))).toBe(true);
    // And it moved under the letters: not the picture of the box where it was.
    expect(bytes(warm).equals(bytes(tex(boxOf(fade, 100))))).toBe(false);
  });

  it('under a painter that does not paint whole boxes, the box is painted as it is with none', () => {
    setTextEngine(rust);
    setGlyphPainter({ ...rustPainter, box: false, paintBox: undefined, mesh: false });
    clearLayoutMemo();
    const a = tex(boxOf({ on: true, shapes: [rect(0, 0, 999, 999, 100)] }));
    const p = tex(boxOf());
    expect(bytes(a).equals(bytes(p))).toBe(true);
  });
});
