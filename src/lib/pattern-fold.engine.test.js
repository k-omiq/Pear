import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle, patternFillFolds } from './data.js';

// ===========================================================================
// The pattern fill moves to the Pattern Overlay (`foldPatternFill`)
// ===========================================================================
// The panel's one pattern tool is the overlay, and a box saved with the old
// pattern fill is moved there on load only where the overlay paints the very
// same pixels. Held here against the engine: the old fill and the folded
// overlay, painted whole, side by side.

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

const base = (over) => ({
  ...defaultStyle(),
  font: 'Bangers',
  size: 64,
  color: '#ff0000',
  strokes: [{ color: '#0000ff', width: 4, opacity: 1 }],
  autoHeight: false,
  ...over,
});
const boxOf = (style, over = {}) => ({ id: 'b', lineN: null, text: 'TONE', x: 120, y: 110, w: 300, h: 110, style, ...over });

function pixels(box) {
  const r = renderBoxTexture(box, { id: 1, w: 600, h: 400, lines: [], boxes: [box] }, null, 2);
  const { width, height } = r.canvas;
  return { width, height, data: r.canvas.getContext('2d').getImageData(0, 0, width, height).data };
}

// The old fill, as it was saved: normalised by hand around the fold.
function oldFill(over) {
  const folded = normalizeStyle(base(over));
  const { on: _on, ...pattern } = folded.patternOverlay.pattern;
  return { ...folded, pattern: { ...pattern, on: true }, patternOverlay: { ...folded.patternOverlay, on: false }, gradient: { ...folded.gradient, on: !!over.gradient?.on } };
}

describe('the pattern fill folded into the Pattern Overlay', () => {
  it.each([
    ['dots', { kind: 'dots', fg: '#000000', bg: '#ffffff' }, {}],
    ['turned stripes, faded', { kind: 'stripes', angle: 30, fade: { on: true, angle: 90, from: 0.2, to: 0.9 } }, {}],
    ['page-anchored sparkles', { kind: 'sparkles', anchor: 'page', scale: 1.5 }, {}],
    ['over a gradient it hid', { kind: 'seigaiha' }, { gradient: { ...defaultStyle().gradient, on: true } }],
    ['with satin and an inner glow on it', { kind: 'halftone' }, { satin: { on: true, color: '#00ff00', opacity: 0.8 }, innerGlow: { on: true, color: '#ffff00', opacity: 0.7, size: 6 } }],
    ['in a multiply box', { kind: 'crosshatch' }, { blendMode: 'multiply' }],
  ])('paints the same: %s', (_name, pattern, over) => {
    const style = { ...over, pattern: { ...defaultStyle().pattern, ...pattern, on: true } };
    const folded = normalizeStyle(base(style));
    expect(folded.pattern.on).toBe(false);
    expect(folded.patternOverlay).toMatchObject({ on: true, blend: 'normal', opacity: 1 });
    expect(folded.patternOverlay.pattern.kind).toBe(pattern.kind);
    const a = pixels(boxOf(oldFill(style)));
    const b = pixels(boxOf(folded));
    expect([b.width, b.height]).toEqual([a.width, a.height]);
    let worst = 0;
    let inked = 0;
    for (let i = 0; i < a.data.length; i++) {
      worst = Math.max(worst, Math.abs(a.data[i] - b.data[i]));
      if (i % 4 === 3 && a.data[i]) inked++;
    }
    expect(inked).toBeGreaterThan(1000);
    expect(worst).toBeLessThanOrEqual(1);
  });

  // An inner effect paints the fill on its own, and the outlines cut to
  // outside it: the two are one piece (`add_pieces`, boxjob.rs), with no
  // see-through seam on the letters' edge where the box painted in one job
  // had none.
  it.each([
    ['a colour overlay of the fill colour', { colorOverlays: [{ on: true, color: '#ff0000', opacity: 1, blend: 'normal' }] }],
    ['a satin at no strength', { satin: { on: true, opacity: 0.0001, color: '#000000' } }],
    ['an inner glow at no strength', { innerGlow: { on: true, opacity: 0.0001, color: '#ffffff', size: 2 } }],
  ])('%s leaves the letters as they were', (_name, over) => {
    const a = pixels(boxOf(normalizeStyle(base({}))));
    const b = pixels(boxOf(normalizeStyle(base(over))));
    let worst = 0;
    for (let i = 0; i < a.data.length; i++) worst = Math.max(worst, Math.abs(a.data[i] - b.data[i]));
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('leaves a pattern fill that would not paint the same', () => {
    const pat = { ...defaultStyle().pattern, on: true };
    expect(patternFillFolds(normalizeStyle(base({})))).toBe(false);
    for (const over of [
      { pattern: { ...pat, bgOpacity: 0.5 } },
      { pattern: pat, fillOpacity: 0.5 },
      { pattern: pat, noFill: true },
      { pattern: pat, patternOverlay: { on: true, pattern: { kind: 'grid' } } },
    ]) {
      const s = normalizeStyle(base(over));
      expect(s.pattern.on).toBe(true);
      expect(s.patternOverlay.pattern.kind).toBe(over.patternOverlay ? 'grid' : 'dots');
    }
  });
});
