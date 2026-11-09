import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas, Image } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBox, renderBoxTexture, renderPageCanvas, renderBoxLayer } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { backdropPixels, boxToPage, forgetBackdrops, BACKDROP_MAX_PX } from './backdrop.js';

// ===========================================================================
// The page backdrop, painted (LAYER_STYLES_PLAN.md phase 6a)
// ===========================================================================
// A box in a blend mode is painted by the engine over the page art under it
// (`backdrop.js`): these hold that the art arrives, through the box's whole
// transform, on the export's routes and not on the PSD's, and that what comes
// back laid on the art shows the blend. The blend maths is the Rust tests'.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const hadImage = 'Image' in globalThis;
const oldImage = globalThis.Image;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let whole;
// What the painter was asked for: each box's backdrop and what it gave.
let asked = [];

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  globalThis.Image = Image;
  const rust = await rustEngine();
  setTextEngine(rust);
  const painter = createRustGlyphPainter(rust);
  whole = {
    ...painter,
    paintBox(ctx, spec) {
      const entry = { blend: spec.blend, given: typeof spec.backdrop, bytes: null };
      asked.push(entry);
      const backdrop = typeof spec.backdrop === 'function' ? (rect) => (entry.bytes = spec.backdrop(rect)) : spec.backdrop;
      return painter.paintBox(ctx, { ...spec, backdrop });
    },
  };
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
beforeEach(() => {
  setGlyphPainter(whole);
  asked = [];
  forgetBackdrops();
});

const W = 600;
const H = 400;
const SCALE = 2;
const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 72, color: '#808080', strokes: [], shadows: [], autoHeight: false, ...over });
const boxOf = (over = {}, at = {}) => ({ id: 'b', lineN: null, text: 'BLEND', x: 120, y: 110, w: 320, h: 110, style: style(over), ...at });
const pageOf = (boxes, extra = {}) => ({ id: 1, w: W, h: H, lines: [], boxes, ...extra });

// Page art of one colour.
function flatArt(color) {
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  x.fillStyle = color;
  x.fillRect(0, 0, W, H);
  return c;
}

// What a texture shows laid on a page of one colour `art`: the colour of
// every pixel the letters cover whole.
function shownInside(box, art, rgb) {
  const under = { image: flatArt(art), W, H, src: art };
  const r = renderBoxTexture(box, pageOf([box]), null, SCALE, Infinity, Infinity, false, false, null, under);
  const { width, height } = r.canvas;
  const d = r.canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const out = [];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] !== 255) continue;
    out.push([d[i], d[i + 1], d[i + 2]]);
  }
  expect(out.length).toBeGreaterThan(500);
  // A pixel the letters cover whole shows the box's own colour.
  const mean = [0, 1, 2].map((k) => out.reduce((t, p) => t + p[k], 0) / out.length);
  rgb.forEach((v, k) => expect(Math.abs(mean[k] - v)).toBeLessThanOrEqual(2));
}

describe('a box over the page art', () => {
  it('in Normal is its own colour, with or without the art', () => {
    shownInside(boxOf(), '#202020', [128, 128, 128]);
    // Normal reads nothing of the page: the painter is not even asked.
    expect(asked.at(-1)).toMatchObject({ blend: 'normal', given: 'object' });
  });

  it('in Screen lightens dark art: white to white, grey past grey', () => {
    // 1 - (1 - 128/255)(1 - 32/255) of 255.
    shownInside(boxOf({ blendMode: 'screen' }), '#202020', [144, 144, 144]);
    expect(asked.at(-1)).toMatchObject({ blend: 'screen', given: 'function' });
    expect(asked.at(-1).bytes?.length).toBeGreaterThan(0);
    shownInside(boxOf({ blendMode: 'screen', color: '#ffffff' }), '#202020', [255, 255, 255]);
  });

  it('in Multiply of a colour darkens the art by it', () => {
    shownInside(boxOf({ blendMode: 'multiply', color: '#ff0000' }), '#8080c0', [128, 0, 0]);
  });

  it('turned and mirrored, is handed the page pixels it is shown over', () => {
    // A page whose red is its x and green its y (over 256 px), and a box
    // turned 30 degrees and mirrored, painted at 2 into a surface.
    const art = createCanvas(256, 256);
    const ax = art.getContext('2d');
    const img = ax.createImageData(256, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        img.data.set([x, y, 0, 255], i);
      }
    }
    ax.putImageData(img, 0, 0);
    const box = { x: 60, y: 70, w: 120, h: 60, style: { rotation: 30, flipH: true } };
    const L = { ox: 10, oy: 6 };
    const A = boxToPage(box, L);
    const m = [2, 0, 0, 2, 3, -5];
    const rect = { x0: 4, y0: 7, width: 300, height: 180, m };
    const bytes = backdropPixels({ image: art, W: 256, H: 256 }, A, rect);
    expect(bytes.length).toBe(300 * 180 * 4);
    // Pixel (i, j) is device (x0 + i, y0 + j): layout m^-1 of it, then A.
    for (const [i, j] of [
      [60, 50],
      [150, 90],
      [230, 140],
    ]) {
      const dx = rect.x0 + i + 0.5;
      const dy = rect.y0 + j + 0.5;
      const q = [(dx - m[4]) / m[0], (dy - m[5]) / m[3]];
      const px = A[0] * q[0] + A[2] * q[1] + A[4];
      const py = A[1] * q[0] + A[3] * q[1] + A[5];
      const k = (j * 300 + i) * 4;
      expect(Math.abs(bytes[k] - px)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(bytes[k + 1] - py)).toBeLessThanOrEqual(1.5);
    }
    // Past the page's edge the page is white.
    const far = backdropPixels({ image: art, W: 256, H: 256 }, [1, 0, 0, 1, 0, 0], { x0: 300, y0: 300, width: 2, height: 2, m: [1, 0, 0, 1, 0, 0] });
    expect([...far.slice(0, 4)]).toEqual([255, 255, 255, 255]);
  });

  it('is cropped once for repaints of the same place', () => {
    const image = flatArt('#336699');
    const key = {};
    const rect = { x0: 0, y0: 0, width: 40, height: 30, m: [2, 0, 0, 2, 0, 0] };
    const a = backdropPixels({ image, W, H, src: 's', key }, [1, 0, 0, 1, 5, 5], rect);
    expect(backdropPixels({ image, W, H, src: 's', key }, [1, 0, 0, 1, 5, 5], rect)).toBe(a);
    // Moved, it is cropped again.
    expect(backdropPixels({ image, W, H, src: 's', key }, [1, 0, 0, 1, 6, 5], rect)).not.toBe(a);
  });

  it('with Blend Interior Effects as Group fades a colour overlay with the fill', () => {
    const ov = [{ color: '#0000ff', opacity: 1, blend: 'normal' }];
    const tex = (blending) => {
      const box = boxOf({ fillOpacity: 0, colorOverlays: ov, blending });
      const r = renderBoxTexture(box, pageOf([box]), null, SCALE);
      const { width, height } = r.canvas;
      const d = r.canvas.getContext('2d').getImageData(0, 0, width, height).data;
      let blue = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i + 3] === 255) blue++;
      return blue;
    };
    expect(tex({ interior: false })).toBeGreaterThan(500);
    expect(tex({ interior: true })).toBe(0);
  });
});

// ===========================================================================
// Channels and Blend If (phase 6b), painted over the art
// ===========================================================================

// A box's texture over flat art, and its pixels.
function texture(box, art) {
  const under = art ? { image: flatArt(art), W, H, src: art } : null;
  const r = renderBoxTexture(box, pageOf([box]), null, SCALE, Infinity, Infinity, false, false, null, under);
  const { width, height } = r.canvas;
  return { width, height, data: r.canvas.getContext('2d').getImageData(0, 0, width, height).data };
}
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
// The mean colour the texture shows laid on `art` over the pixels `where`
// says (indices into the texture), and their mean alpha.
function shownAt(tex, art, where) {
  const a = rgbOf(art);
  const sum = [0, 0, 0, 0];
  for (const i of where) {
    const al = tex.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) sum[k] += tex.data[i + k] * al + a[k] * (1 - al);
    sum[3] += tex.data[i + 3];
  }
  return sum.map((v) => v / where.length);
}
// The pixels of a texture that `keep` says yes to.
function pixelsWhere(tex, keep) {
  const out = [];
  for (let i = 0; i < tex.data.length; i += 4) if (keep(tex.data.subarray(i, i + 4))) out.push(i);
  return out;
}
const near = (got, want, tol = 2) => want.forEach((v, k) => expect(Math.abs(got[k] - v), `${got} vs ${want}`).toBeLessThanOrEqual(tol));
const range = (b0, b1, w0, w1) => [b0, b1, w0, w1];

describe('Blend If and Channels over the page art', () => {
  // Red letters; where they cover a pixel whole over the art.
  const red = (blending) => boxOf({ color: '#ff0000', blending });
  const letters = (art) => pixelsWhere(texture(red(undefined), art), (p) => p[3] === 255);

  it('Underlying, black at 128: hides the letters over art darker than 128, shows them over 128', () => {
    const gate = { blendIf: { gray: { under: range(128, 128, 255, 255) } } };
    const at = letters('#808080');
    expect(at.length).toBeGreaterThan(500);
    near(shownAt(texture(red(gate), '#7f7f7f'), '#7f7f7f', at), [127, 127, 127, 0]);
    near(shownAt(texture(red(gate), '#808080'), '#808080', at), [255, 0, 0, 255]);
    // The painter was handed the page.
    expect(asked.at(-1)).toMatchObject({ given: 'function' });
  });

  it('Underlying, split 64/192: half of the letters over 128, as at 50 % opacity', () => {
    const gate = { blendIf: { gray: { under: range(64, 192, 255, 255) } } };
    const at = letters('#808080');
    near(shownAt(texture(red(gate), '#808080'), '#808080', at), [191.5, 64, 64, 127.5], 2);
    near(shownAt(texture(red(gate), '#404040'), '#404040', at), [64, 64, 64, 0]);
    near(shownAt(texture(red(gate), '#c0c0c0'), '#c0c0c0', at), [255, 0, 0, 255]);
  });

  it('This Layer, black at 50: hides the letters own black and keeps their white outline', () => {
    const black = (blending) => boxOf({ color: '#000000', strokes: [{ color: '#ffffff', width: 4, opacity: 1 }], blending });
    const plain = texture(black(undefined), '#808080');
    const fill = pixelsWhere(plain, (p) => p[3] === 255 && p[0] === 0);
    const outline = pixelsWhere(plain, (p) => p[3] === 255 && p[0] === 255);
    expect(fill.length).toBeGreaterThan(300);
    expect(outline.length).toBeGreaterThan(300);
    const gate = { blendIf: { gray: { this: range(50, 50, 255, 255) } } };
    const tex = texture(black(gate), '#808080');
    near(shownAt(tex, '#808080', fill), [128, 128, 128, 0]);
    near(shownAt(tex, '#808080', outline), [255, 255, 255, 255]);
  });

  it('a channel off keeps the page art channel where the box is', () => {
    const at = letters('#40a0ff');
    const tex = texture(red({ channels: { r: false } }), '#40a0ff');
    // R from the art (64), G and B the letters' (0).
    near(shownAt(tex, '#40a0ff', at), [64, 0, 0, 255]);
    const g = texture(red({ channels: { g: false } }), '#40a0ff');
    near(shownAt(g, '#40a0ff', at), [255, 160, 0, 255]);
  });

  it('at their defaults change nothing: the box paints what a 6a style (no Channels, no Blend If) did', () => {
    const now = texture(boxOf({ color: '#ff0000', shadows: [{ x: 4, y: 4, size: 2, color: '#000000', opacity: 0.75, blend: 'multiply' }] }), '#808080');
    expect(asked.at(-1)).toMatchObject({ given: 'object' });
    const old = boxOf({ color: '#ff0000', shadows: [{ x: 4, y: 4, size: 2, color: '#000000', opacity: 0.75, blend: 'multiply' }] });
    old.style.blending = { interior: false, knockout: 'none' };
    const then = texture(old, '#808080');
    expect([then.width, then.height]).toEqual([now.width, now.height]);
    expect(Buffer.from(then.data).equals(Buffer.from(now.data))).toBe(true);
  });

  it('are left to Photoshop on a PSD layer: no page, nothing hidden', () => {
    const box = red({ blendIf: { gray: { under: range(255, 255, 255, 255), this: range(0, 0, 10, 10) } }, channels: { r: false } });
    const p = pageOf([box], { cleaned: flatArt('#000000').toDataURL('image/png') });
    const layer = renderBoxLayer(box, W, H, null, p);
    for (const a of asked) expect(a.given).toBe('object');
    const d = layer.imageData.data;
    let shown = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 3] === 255) shown++;
    expect(shown).toBeGreaterThan(200);
  });
});

describe('the export', () => {
  const pageArt = () => flatArt('#40a0ff').toDataURL('image/png');

  it('hands each route of the flat page its backdrop, and none to a Normal box', async () => {
    const upright = boxOf({ blendMode: 'multiply', color: '#ff0000' }, { id: 'u' });
    const turned = boxOf({ blendMode: 'overlay', rotation: 25 }, { id: 't', y: 230 });
    const plain = boxOf({}, { id: 'n', y: 20 });
    const p = pageOf([plain, upright, turned], { cleaned: pageArt() });
    const canvas = await renderPageCanvas(p);
    expect([canvas.width, canvas.height]).toEqual([W, H]);
    const by = Object.fromEntries(asked.map((a) => [a.blend, a]));
    expect(by.normal.given).toBe('object');
    expect(by.multiply.given).toBe('function');
    expect(by.overlay.given).toBe('function');
    expect(by.multiply.bytes?.length).toBeGreaterThan(0);
    expect(by.overlay.bytes?.length).toBeGreaterThan(0);
    // The upright box: a red Multiply over the blue art is the art's
    // red channel times red: (64, 0, 0) where the letters cover it whole.
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(upright.x, upright.y, upright.w, upright.h).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 64) <= 3 && d[i + 1] <= 3 && d[i + 2] <= 3) dark++;
    expect(dark).toBeGreaterThan(200);
  });

  it('gives a PSD layer no backdrop: its pixels are the box un-blended', () => {
    const box = boxOf({ blendMode: 'multiply', color: '#ff0000' });
    const p = pageOf([box], { cleaned: pageArt() });
    const layer = renderBoxLayer(box, W, H, null, p);
    expect(asked.length).toBeGreaterThan(0);
    for (const a of asked) expect(a.given).toBe('object');
    // The letters are their own red, not the art's red times red.
    const d = layer.imageData.data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 0 && d[i + 3] === 255) red++;
    expect(red).toBeGreaterThan(200);
  });
});

describe('a box as large as a page', () => {
  it('still gets its backdrop: the surface is held inside the guard (review F15)', () => {
    const box = { id: 'big', lineN: null, text: 'W', x: 0, y: 0, w: 2150, h: 2150, style: style({ blendMode: 'multiply', color: '#ff0000', size: 1800 }) };
    const big = createCanvas(2150, 2150);
    const x = big.getContext('2d');
    x.fillStyle = '#808080';
    x.fillRect(0, 0, 2150, 2150);
    const p = { id: 1, w: 2150, h: 2150, lines: [], boxes: [box] };
    const under = { image: big, W: 2150, H: 2150, src: 'big' };
    renderBox(box, p, null, under);
    const a = asked.find((e) => e.blend === 'multiply');
    expect(a.bytes?.length).toBeGreaterThan(0);
    expect(a.bytes.length / 4).toBeLessThanOrEqual(BACKDROP_MAX_PX);
    // Red over mid grey, Multiply: about (128, 0, 0) where the letter is whole.
    let hit = 0;
    for (let i = 0; i < a.bytes.length; i += 4) if (a.bytes[i] === 128) hit++;
    expect(hit).toBeGreaterThan(1000);
  }, 120_000);
});
