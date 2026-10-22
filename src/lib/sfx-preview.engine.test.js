import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { rustEngine, FIXTURE_FACES } from '../test/rust-engine.js';
import { textEngine, setTextEngine, setGlyphPainter, glyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { sfxKinds, applySfxKind } from './sfx.js';
import { cardSpec, cardKey, cardText, cardStyle, paintCard, paintStage, CARD_W, CARD_H } from './sfx-preview.js';

// ===========================================================================
// The SFX panel's pictures, painted by the real engine
// ===========================================================================
// The panel's own cases (SfxPanel.dom.test.js) stand the painters in. This is
// the painter: a card for every sound type, the variations and the stage,
// through the exporter's texture, on a real canvas, read back as pixels.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const defaultEngine = textEngine();
const defaultPainter = glyphPainter();
let rust;
beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  for (const [family, , file] of FIXTURE_FACES) {
    GlobalFonts.registerFromPath(fileURLToPath(new URL(`../test/fonts/${file}`, import.meta.url)), family);
  }
  rust = await rustEngine();
  setTextEngine(rust);
  setGlyphPainter(createRustGlyphPainter(rust));
  clearLayoutMemo();
});
afterEach(() => clearLayoutMemo());
afterAll(() => {
  setTextEngine(defaultEngine);
  setGlyphPainter(defaultPainter);
  clearLayoutMemo();
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 40, ...over });

// How many pixels of a PNG data URL are inked, and where the ink spans.
async function ink(url) {
  const img = await loadImage(url);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let n = 0;
  let x0 = width;
  let x1 = -1;
  let y0 = height;
  let y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        n++;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  return { n, width, height, x0, x1, y0, y1 };
}

describe('a type card', () => {
  it('is painted for every sound type, inside its tile, with ink in it', async () => {
    const kinds = sfxKinds();
    expect(kinds).toHaveLength(12);
    const spec = cardSpec(style(), 'BOOM');
    for (const k of kinds) {
      const url = paintCard(spec, { kind: k.id, seed: 1 }, 1);
      expect(url, k.id).toMatch(/^data:image\/png;base64,/);
      const r = await ink(url);
      expect([r.width, r.height]).toEqual([CARD_W, CARD_H]);
      expect(r.n, k.id).toBeGreaterThan(20);
      // Cut to its ink and contained: nothing touches the tile's edge.
      expect(r.x0, k.id).toBeGreaterThan(0);
      expect(r.y0, k.id).toBeGreaterThan(0);
      expect(r.x1, k.id).toBeLessThan(CARD_W - 1);
      expect(r.y1, k.id).toBeLessThan(CARD_H - 1);
    }
  });

  it('differs from one type to the next', () => {
    const spec = cardSpec(style(), 'BOOM');
    const urls = new Set(sfxKinds().map((k) => paintCard(spec, { kind: k.id, seed: 1 }, 1)));
    expect(urls.size).toBeGreaterThan(6);
  });

  it('is the type laid over the box: its look, the box seed', () => {
    const st = cardStyle(cardSpec(style({ color: '#ff0000' }), 'BOOM'), { kind: 'explosion', seed: 7 });
    expect(st.sfx.on).toBe(true);
    expect(st.sfx.kind).toBe('explosion');
    expect(st.sfx.seed).toBe(7);
    expect(st.color).not.toBe('#ff0000');
  });

  it('has a key that leaves out the box look, and keeps the text and the font', () => {
    const a = cardSpec(style({ color: '#ff0000' }), 'BOOM');
    const b = cardSpec(style({ color: '#000000' }), 'BOOM');
    const c = cardSpec(style(), 'BAM');
    const d = cardSpec(style({ font: 'Comic Neue' }), 'BOOM');
    const key = (s) => cardKey(s, { kind: 'impact', seed: 1 }, 0, 1);
    expect(key(a)).toBe(key(b));
    expect(key(a)).not.toBe(key(c));
    expect(key(a)).not.toBe(key(d));
    // A variation is the box as it is: its look is in its key.
    const vkey = (s) => cardKey(s, { kind: null, seed: 1 }, 0, 1);
    expect(vkey(a)).not.toBe(vkey(b));
  });

  it('paints at twice the pixels on a dense screen', async () => {
    const r = await ink(paintCard(cardSpec(style(), 'BAM'), { kind: 'impact', seed: 1 }, 2));
    expect([r.width, r.height]).toEqual([CARD_W * 2, CARD_H * 2]);
  });
});

describe('a variation', () => {
  it('is the box sound with another seed', async () => {
    const st = style();
    applySfxKind(st, 'explosion');
    const spec = cardSpec(st, 'BOOM');
    const one = paintCard(spec, { seed: 1 }, 1);
    const two = paintCard(spec, { seed: 2 }, 1);
    expect(one).toMatch(/^data:image\/png;base64,/);
    expect((await ink(one)).n).toBeGreaterThan(20);
    // Explosion jitters: two seeds are two shapes.
    expect(one).not.toBe(two);
  });
});

describe('the card text', () => {
  it('cuts the text to eight code points and falls back to SFX', () => {
    expect(cardText('ABCDEFGHIJ')).toBe('ABCDEFGH');
    // Line breaks count as code points, and a cut that ends on one drops it.
    expect(cardText('GR\nIP!!\nXX')).toBe('GR\nIP!!');
    expect(cardText('ABCDEFG\nHIJ')).toBe('ABCDEFG');
    expect(cardText('')).toBe('SFX');
    expect(cardText('   \n ')).toBe('SFX');
    expect(cardText('😀😀😀😀😀😀😀😀😀')).toBe('😀'.repeat(8));
  });
});

describe('the stage', () => {
  it('paints the box as it is, plain or with a type, cut to its ink', () => {
    const plain = style();
    const sfx = style();
    applySfxKind(sfx, 'impact');
    const grab = (st) => {
      const canvas = createCanvas(300, 132);
      expect(paintStage(canvas, { style: st, text: 'BOOM', w: 240, h: 90 }, 1)).toBe(true);
      const { data } = canvas.getContext('2d').getImageData(0, 0, 300, 132);
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 8) n++;
      return { n, png: canvas.toBuffer('image/png').toString('base64') };
    };
    const a = grab(plain);
    const b = grab(sfx);
    expect(a.n).toBeGreaterThan(100);
    expect(b.n).toBeGreaterThan(100);
    expect(a.png).not.toBe(b.png);
  });

  it('shows the word SFX for a box with no text', () => {
    const canvas = createCanvas(300, 132);
    expect(paintStage(canvas, { style: style(), text: '', w: 240, h: 90 }, 1)).toBe(true);
    const { data } = canvas.getContext('2d').getImageData(0, 0, 300, 132);
    expect(data.some((v, i) => i % 4 === 3 && v > 8)).toBe(true);
  });
});
