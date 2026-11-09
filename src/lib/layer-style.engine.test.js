import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture, boxInJob } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { setGlobalLight } from './text-paint.js';
import { defaultStyle, normalizeStyle, LIGHT_DEF } from './data.js';

// ===========================================================================
// The layer style, painted by the engine
// ===========================================================================
// Phase 1 of LAYER_STYLES_PLAN.md: a drop shadow with Photoshop's fields
// (Size, Spread, Noise, Contour, a blend mode, Use Global Light) and the
// box's Fill Opacity, carried from the style through `paintBoxJob` and the
// wire (text-engine/js/paint.mjs) into the box job (paint/boxjob.rs). The Rust
// tests hold the pixel maths; these hold that what the style says arrives.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let whole;

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  const rust = await rustEngine();
  setTextEngine(rust);
  whole = createRustGlyphPainter(rust);
  setTypesetEnabled(true);
  clearLayoutMemo();
});
afterAll(() => {
  setTextEngine(before.engine);
  setGlyphPainter(before.painter);
  setTypesetEnabled(before.typeset);
  setGlobalLight(LIGHT_DEF);
  clearLayoutMemo();
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});
beforeEach(() => {
  setGlyphPainter(whole);
  setGlobalLight(LIGHT_DEF);
});

const RED = '#ff0000';
const BLUE = '#0000ff';
const GREEN = '#00ff00';
const SCALE = 2;
const style = (over = {}) =>
  normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 64, color: RED, strokes: [], shadows: [], autoHeight: false, ...over });
const boxOf = (over = {}) => ({ id: 'b', lineN: null, text: 'LAYER', x: 120, y: 110, w: 300, h: 110, style: style(over) });
const pageOf = (box) => ({ id: 1, w: 600, h: 400, lines: [], boxes: [box] });
const shadow = (over = {}) => ({ x: 8, y: 0, size: 0, color: GREEN, opacity: 1, ...over });

function texture(box) {
  const r = renderBoxTexture(box, pageOf(box), null, SCALE);
  const { width, height } = r.canvas;
  return { width, height, data: r.canvas.getContext('2d').getImageData(0, 0, width, height).data };
}
// Every pixel that `pick` takes, as [x, alpha].
function pixels(img, pick) {
  const out = [];
  for (let i = 0; i < img.data.length; i += 4) {
    const [r, g, b, a] = [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
    if (pick(r, g, b, a)) out.push([(i / 4) % img.width, a]);
  }
  return out;
}
const green = (r, g, b, a) => a > 0 && g > 200 && r < 60 && b < 60;
const red = (r, g, b, a) => a > 0 && r > 200 && g < 60 && b < 60;
const meanX = (px) => px.reduce((t, [x]) => t + x, 0) / px.length;

describe('a shadow with the Photoshop fields', () => {
  it('is painted whole by the engine', () => {
    expect(boxInJob(boxOf({ shadows: [shadow({ spread: 0.5, noise: 0.3, blend: 'multiply' })] }))).toBe(true);
  });

  it('follows the chapter light when it uses the global light, and its own x and y when not', () => {
    const lit = boxOf({ shadows: [shadow({ useGlobalLight: true })] });
    // A light from the right (0 degrees) throws it left; from the left, right.
    setGlobalLight({ angle: 0, altitude: 30 });
    const fromRight = texture(lit);
    setGlobalLight({ angle: 180, altitude: 30 });
    const fromLeft = texture(lit);
    const shift = (img) => meanX(pixels(img, green)) - meanX(pixels(img, red));
    expect(shift(fromRight)).toBeLessThan(-2);
    expect(shift(fromLeft)).toBeGreaterThan(2);
    // A shadow with its own angle stays where its x and y put it.
    const own = boxOf({ shadows: [shadow()] });
    setGlobalLight({ angle: 0, altitude: 30 });
    const a = texture(own);
    setGlobalLight({ angle: 180, altitude: 30 });
    expect(texture(own).data).toEqual(a.data);
  });

  it('is harder with more spread', () => {
    const solid = (s) => pixels(texture(boxOf({ shadows: [shadow({ x: 0, y: 30, size: 10, spread: s })] })), (r, g, b, a) => green(r, g, b, a) && a === 255).length;
    expect(solid(1)).toBeGreaterThan(solid(0) * 1.2);
  });

  it('takes its noise and its contour', () => {
    const plain = texture(boxOf({ shadows: [shadow({ x: 0, y: 30, size: 10 })] }));
    const grainy = texture(boxOf({ shadows: [shadow({ x: 0, y: 30, size: 10, noise: 0.8 })] }));
    const ringed = texture(boxOf({ shadows: [shadow({ x: 0, y: 30, size: 10, contour: { preset: 'ring', aa: true } })] }));
    expect(grainy.data).not.toEqual(plain.data);
    expect(ringed.data).not.toEqual(plain.data);
  });

  // Known values, not just "different": the Ring preset is the curve in
  // text-engine/src/paint/fx/contour.rs, so a custom contour through the same
  // points (0..255) must paint the same shadow, and the identity curve must
  // paint the plain one.
  it('paints the Ring preset as the curve it names, and a straight custom curve as none', () => {
    const RING = [[0, 0], [0.031, 0.078], [0.039, 0.117], [0.117, 0.383], [0.172, 0.609], [0.195, 0.734], [0.266, 0.953], [0.305, 1], [0.344, 0.992], [0.383, 0.922], [0.43, 0.805], [0.477, 0.641], [0.57, 0.281], [0.617, 0.141], [0.664, 0.055], [0.703, 0.016], [0.742, 0.016], [0.773, 0.062], [0.836, 0.234], [0.859, 0.344], [0.891, 0.445], [0.914, 0.547], [0.945, 0.734], [0.977, 0.875], [1, 1]];
    const pts = RING.map(([x, y], i) => [x * 255, y * 255, i > 0 && i < RING.length - 1]);
    const of = (contour) => texture(boxOf({ shadows: [shadow({ x: 0, y: 30, size: 10, contour })] }));
    const maxDiff = (a, b) => a.data.reduce((m, v, i) => Math.max(m, Math.abs(v - b.data[i])), 0);
    const plain = of({ preset: 'linear', aa: true });
    const ring = of({ preset: 'ring', aa: true });
    expect(maxDiff(ring, of({ preset: 'custom', aa: true, pts }))).toBe(0);
    expect(maxDiff(of({ preset: 'custom', aa: true, pts: [[0, 0, false], [255, 255, false]] }), plain)).toBe(0);
    // And the ring really is a different shadow from the plain one.
    expect(maxDiff(ring, plain)).toBeGreaterThan(20);
  });

  it('dissolves to whole pixels or none at all', () => {
    const img = texture(boxOf({ shadows: [shadow({ x: 0, y: 30, opacity: 0.5, blend: 'dissolve' })] }));
    const shade = pixels(img, green);
    expect(shade.length).toBeGreaterThan(100);
    for (const [, a] of shade) expect(a).toBe(255);
  });
});

describe('Fill Opacity', () => {
  it('fades the letters’ fill and leaves the strokes as they were', () => {
    const strokes = [{ color: BLUE, width: 4, opacity: 1 }];
    const full = texture(boxOf({ strokes }));
    const faded = texture(boxOf({ strokes, fillOpacity: 0.5 }));
    expect([faded.width, faded.height]).toEqual([full.width, full.height]);
    // No fill pixel is whole any more; inside the letters it is half there.
    expect(pixels(full, (r, g, b, a) => red(r, g, b, a) && a === 255).length).toBeGreaterThan(500);
    expect(pixels(faded, (r, g, b, a) => red(r, g, b, a) && a === 255)).toEqual([]);
    expect(pixels(faded, (r, g, b, a) => red(r, g, b, a) && Math.abs(a - 128) <= 3).length).toBeGreaterThan(500);
    // The outer half of each band is the band it was.
    const blue = (img) => pixels(img, (r, g, b, a) => b > 200 && r < 60 && g < 60 && a === 255).length;
    expect(blue(faded)).toBeGreaterThan(blue(full) * 0.9);
  });

  it('at full is the box it always was', () => {
    expect(texture(boxOf({ fillOpacity: 1 })).data).toEqual(texture(boxOf()).data);
  });
});
