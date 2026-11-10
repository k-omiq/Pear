import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas, Image } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderPageCanvas } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle, outlineRun, outlineBands, normalizeStroke } from './data.js';
import { boxEffects } from './text-paint.js';
import { forgetBackdrops } from './backdrop.js';

// ===========================================================================
// What the layer effects paint, proven on a real page (2026-11-10)
// ===========================================================================
// Three questions the Effects tab rework had to answer before its controls
// could be trusted:
//   1. Does the Satin paint? (It does: here on light letters; and why it shows
//      nothing on the default black letters.)
//   2. Does the box's blend mode change anything? (It does: a black box in
//      Screen on a white page is gone; a red box in Multiply over coloured
//      art darkens it. On white paper black letters look the same in Normal,
//      Multiply and Darken: that is the maths, not a bug.)
//   3. Do the old outline bands paint the same as the one stroke type they
//      became? (Exactly: they are the outline run and go to the band painter
//      as the same bands. And the Rust stroke effect laying the same strokes
//      matches them to the edge pixels.)

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const hadImage = 'Image' in globalThis;
const oldImage = globalThis.Image;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  globalThis.Image = Image;
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
  if (hadImage) globalThis.Image = oldImage;
  else delete globalThis.Image;
});

const W = 600;
const H = 400;
function flat(color) {
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  x.fillStyle = color;
  x.fillRect(0, 0, W, H);
  return c.toDataURL('image/png');
}
function rampArt() {
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#ff8040');
  g.addColorStop(1, '#2060ff');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  return c.toDataURL('image/png');
}
const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 90, color: '#000000', strokeEffects: [], shadows: [], autoHeight: false, ...over });
const boxOf = (s) => ({ id: 'b', lineN: null, text: 'SATIN', x: 80, y: 110, w: 440, h: 160, style: s });

async function pagePixels(s, art) {
  forgetBackdrops();
  clearLayoutMemo();
  const boxes = s ? [boxOf(s)] : [];
  const canvas = await renderPageCanvas({ id: 1, w: W, h: H, lines: [], boxes, cleaned: art });
  return canvas.getContext('2d').getImageData(0, 0, W, H).data;
}
function diff(a, b) {
  let worst = 0;
  let sum = 0;
  let n = 0;
  let strong = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) worst = d;
    if (d > 8) n++;
    if (d > 32) strong++;
    sum += d;
  }
  return { worst, mean: sum / a.length, count: n, strong };
}

describe('Satin paints', () => {
  const white = flat('#ffffff');
  it('lays its shading inside light letters', async () => {
    const plain = await pagePixels(style({ color: '#ffd23c' }), white);
    const satin = await pagePixels(style({ color: '#ffd23c', satin: { on: true } }), white);
    // The Rust engine is sent it, and it darkens part of the letters.
    expect(boxEffects(style({ satin: { on: true } })).some((fx) => fx.kind === 'satin')).toBe(true);
    const d = diff(satin, plain);
    expect(d.worst).toBeGreaterThan(60);
    expect(d.count).toBeGreaterThan(500);
  });
  it('shows nothing at its default (black, Multiply) on the default black letters', async () => {
    const plain = await pagePixels(style(), white);
    const satin = await pagePixels(style({ satin: { on: true } }), white);
    expect(diff(satin, plain).worst).toBeLessThanOrEqual(1);
  });
});

describe("The box's blend mode paints", () => {
  it('a black box in Screen on a white page vanishes', async () => {
    const white = flat('#ffffff');
    const page = await pagePixels(null, white);
    const normal = await pagePixels(style(), white);
    const screen = await pagePixels(style({ blendMode: 'screen' }), white);
    expect(diff(normal, page).worst).toBeGreaterThan(200);
    expect(diff(screen, page).worst).toBeLessThanOrEqual(1);
  });
  it('black letters on white paper are the same in Normal, Multiply and Darken (the maths, not a bug)', async () => {
    const white = flat('#ffffff');
    const normal = await pagePixels(style(), white);
    for (const mode of ['multiply', 'darken']) {
      expect(diff(await pagePixels(style({ blendMode: mode }), white), normal).worst).toBeLessThanOrEqual(1);
    }
  });
  it('a red box in Multiply over coloured art mixes with it', async () => {
    const art = rampArt();
    const normal = await pagePixels(style({ color: '#ff2020' }), art);
    const multiply = await pagePixels(style({ color: '#ff2020', blendMode: 'multiply' }), art);
    expect(diff(multiply, normal).worst).toBeGreaterThan(60);
  });
  it("an overlay's mode mixes it with the letters' fill", async () => {
    const white = flat('#ffffff');
    const over = (blend) => style({ colorOverlays: [{ color: '#ff0000', opacity: 1, blend }] });
    const normal = await pagePixels(over('normal'), white);
    const multiply = await pagePixels(over('multiply'), white);
    const screen = await pagePixels(over('screen'), white);
    const black = await pagePixels(style(), white);
    // Red over black: Normal and Screen are red, Multiply keeps it black.
    expect(diff(normal, black).worst).toBeGreaterThan(200);
    expect(diff(screen, normal).worst).toBeLessThanOrEqual(1);
    expect(diff(multiply, black).worst).toBeLessThanOrEqual(1);
  });
});

describe('The old outline bands are strokes now', () => {
  const bands = [
    { color: '#ffffff', width: 4, opacity: 1 },
    { color: '#000000', width: 3, opacity: 1 },
    { color: '#ff3060', width: 2, opacity: 0.6 },
  ];
  // A style as saved before 2026-11-10: its outlines in `strokes`, its
  // Photoshop strokes (none) in `strokeEffects`.
  const old = normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 90, color: '#2040ff', shadows: [], autoHeight: false, strokes: bands, strokeEffects: [] });

  it('become Outside strokes as wide as the bands up to them, the innermost on top', () => {
    expect('strokes' in old).toBe(false);
    expect(old.strokeEffects.map((k) => [k.size, k.position, k.blend, k.fill, k.color, k.opacity])).toEqual([
      [4, 'outside', 'normal', 'color', '#ffffff', 1],
      [7, 'outside', 'normal', 'color', '#000000', 1],
      [9, 'outside', 'normal', 'color', '#ff3060', 0.6],
    ]);
  });
  it('are laid by the band painter as the very bands they were', () => {
    expect(outlineRun(old).n).toBe(3);
    expect(outlineBands(old)).toEqual(bands.map(normalizeStroke));
    expect(boxEffects(old).some((fx) => fx.kind === 'stroke')).toBe(false);
  });
  it("paint like the Rust engine's own strokes of the same sizes, but at the edges", async () => {
    const art = flat('#d8e4f0');
    const asBands = await pagePixels(old, art);
    // Overprint is not painted (stroke-overprint.engine.test.js) and keeps a
    // stroke out of the outline run: the same strokes, laid as effects.
    const asEffects = { ...old, strokeEffects: old.strokeEffects.map((k) => ({ ...k, overprint: true })) };
    expect(outlineRun(asEffects).n).toBe(0);
    expect(boxEffects(asEffects).filter((fx) => fx.kind === 'stroke')).toHaveLength(3);
    const viaEffects = await pagePixels(asEffects, art);
    const none = await pagePixels(null, art);
    const d = diff(viaEffects, asBands);
    const inked = diff(asBands, none).count;
    // The same rings and the same round joins: what differs is a one-pixel
    // line of edge anti-aliasing along each ring (measured 2026-11-10: 271
    // channel values off by more than 32 of 14592 inked, worst 100, all on
    // ring edges), never a ring's place or its corners.
    expect(d.strong).toBeLessThan(inked * 0.03);
    expect(d.mean).toBeLessThan(1);
  });
});
