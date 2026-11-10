import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture } from './exporter.js';
import { boxCandidate, boxInkRect, placeBlock } from './contain.js';
import { styleReach, wobbleReach } from './paint-reach.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// How far a wobble carries the ink, everywhere that makes room for it: the
// export footprint, the box hull, the per-side reach. Zero when it is not
// painted, and room enough when it is, a far shadow and a curve included.
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
  setTextEngine(rust);
  setGlyphPainter(rustPainter);
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

const WOBBLE = { on: true, amount: 30, tilt: 20, seed: 7 };
const style = (over = {}) => normalizeStyle({ ...defaultStyle(), strokeEffects: [], font: 'Bangers', size: 60, strokes: [], autoHeight: false, shape: 'off', ...over });
const boxOf = (text, over = {}, w = 320, h = 120) => ({ id: 'b', lineN: null, text, x: 50, y: 50, w, h, style: style(over) });
const pageOf = (b) => ({ id: 1, w: 1000, h: 800, lines: [], boxes: [b] });

describe('a wobble that is not painted reaches nowhere', () => {
  it('off, moving nothing, or under a painter that does not move letters', () => {
    expect(wobbleReach(style())).toEqual({ x: 0, y: 0 });
    expect(wobbleReach(style({ wobble: { ...WOBBLE, on: false } }))).toEqual({ x: 0, y: 0 });
    expect(wobbleReach(style({ wobble: { ...WOBBLE, amount: 0, tilt: 0 } }))).toEqual({ x: 0, y: 0 });
    const on = wobbleReach(style({ wobble: WOBBLE }));
    expect(on.x).toBeCloseTo(30 * Math.sin((20 * Math.PI) / 180), 9);
    expect(on.y).toBeCloseTo(on.x + 18, 9);
    setGlyphPainter({ ...rustPainter, wobble: false });
    try {
      expect(wobbleReach(style({ wobble: WOBBLE }))).toEqual({ x: 0, y: 0 });
      // Nor does the box grow for it.
      const b = boxOf('WOBBLY', { wobble: WOBBLE });
      expect(boxInkRect(boxCandidate(b, b.text))).toEqual(boxInkRect(boxCandidate(boxOf('WOBBLY'), 'WOBBLY')));
    } finally {
      setGlyphPainter(rustPainter);
    }
  });

  it('normalizeStyle keeps a wobble in range whatever it is given', () => {
    const bad = normalizeStyle({ ...defaultStyle(), wobble: { on: 'yes', amount: 900, tilt: -4, seed: 12.6 } }).wobble;
    expect(bad).toEqual({ on: false, amount: 40, tilt: 0, seed: 13 });
    expect(normalizeStyle({ ...defaultStyle(), wobble: { on: true, amount: 'x', tilt: NaN, seed: 5000 } }).wobble).toEqual({ on: true, amount: 8, tilt: 0, seed: 999 });
    expect(normalizeStyle({ ...defaultStyle(), wobble: null }).wobble).toEqual({ on: false, amount: 8, tilt: 0, seed: 7 });
  });
});

describe('room for a wobble', () => {
  it('the per-side reach grows the shadow side by the wobble too', () => {
    const shadows = [{ on: true, x: 40, y: 0, blur: 0, opacity: 1, color: '#000000' }];
    const plain = styleReach(style({ shadows }), 320, 120);
    const moved = styleReach(style({ shadows, wobble: WOBBLE }), 320, 120);
    const r = wobbleReach(style({ wobble: WOBBLE }));
    expect(moved.r - plain.r).toBeCloseTo(r.x, 9);
    expect(moved.b - plain.b).toBeCloseTo(r.y, 9);
  });

  it('an export with a far shadow and a strong wobble cuts no ink at its edges', () => {
    const shadows = [{ on: true, x: 60, y: 30, blur: 0, opacity: 1, color: '#000000' }];
    for (const over of [{ shadows, wobble: WOBBLE }, { shadows, wobble: WOBBLE, roughen: { on: true, amount: 6, detail: 0.07, seed: 3 } }]) {
      // One line that fills the box, so the letters sit on its edges.
      const b = boxOf('WOBBLY WORDS', over, 360, 60);
      const t = renderBoxTexture(b, pageOf(b), new Map(), 1);
      const { width: w, height: h } = t.canvas;
      const d = t.canvas.getContext('2d').getImageData(0, 0, w, h).data;
      let edge = 0;
      for (let x = 0; x < w; x++) edge += d[x * 4 + 3] + d[((h - 1) * w + x) * 4 + 3];
      for (let y = 0; y < h; y++) edge += d[y * w * 4 + 3] + d[(y * w + w - 1) * 4 + 3];
      expect(edge, JSON.stringify(Object.keys(over))).toBe(0);
    }
  });

  it('on a curve the hull grows both ways by the larger reach, times the letters\' scale', () => {
    const over = { curve: 40 };
    const plainBox = boxOf('ARCHED', over);
    const movedBox = boxOf('ARCHED', { ...over, wobble: WOBBLE });
    const plain = boxInkRect(boxCandidate(plainBox, plainBox.text));
    const moved = boxInkRect(boxCandidate(movedBox, movedBox.text));
    const r = wobbleReach(movedBox.style);
    const most = Math.max(r.x, r.y);
    expect(placeBlock(boxCandidate(movedBox, movedBox.text)).isCurve).toBe(true);
    // `boxInkRect` answers { x, y, w, h }.
    expect(plain.x - moved.x).toBeCloseTo(most, 6);
    expect(plain.y - moved.y).toBeCloseTo(most, 6);
    expect(moved.w - plain.w).toBeCloseTo(2 * most, 6);
    expect(moved.h - plain.h).toBeCloseTo(2 * most, 6);
    // A letter scaled twice as wide moves twice as far.
    const cand = boxCandidate(movedBox, movedBox.text);
    const place = placeBlock(cand);
    const scaled = { ...place, layout: place.layout.map((g, i) => (i === 0 ? { ...g, sx: 2, sy: 1 } : g)) };
    const plainScaled = { ...scaled, s: plainBox.style };
    const a = boxInkRect(cand, plainScaled);
    const b = boxInkRect(cand, scaled);
    expect(a.x - b.x).toBeCloseTo(2 * most, 6);
  });
});
