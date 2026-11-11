import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas, Image } from '@napi-rs/canvas';
import { readPsd, initializeCanvas } from 'ag-psd';
import { resolveObjectURL } from 'node:buffer';
import { rustEngine } from '../test/rust-engine.js';
import { renderBox, renderPageCanvas, renderStripSliceCanvas } from './exporter.js';
import { buildPagePsd, parsePagePsd, psdPageScale, chapterPagesFromPsdFiles, pagePsdDocument, writePagePsd } from './psd.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle, normalizeStrokeEffect } from './data.js';
import { stripOffsets } from './editor/strip.js';

// ===========================================================================
// Export at Size 2x (NEXT_FEATURES_PLAN.md 9E), painted
// ===========================================================================
// At 2x the page is twice its size each way, a box's picture (painted at 2
// texture px per page px) is laid on it pixel for pixel, the art is enlarged
// once, and a turned box is painted at its angle into the larger page. The
// real engine paints; the canvas is Skia's (@napi-rs/canvas). WebKit's own
// pixels are checked by hand in the app (see the unit's report).

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const hadImage = 'Image' in globalThis;
const oldImage = globalThis.Image;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let whole;

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150), fonts: { ready: Promise.resolve() } };
  globalThis.Image = Image;
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
  clearLayoutMemo();
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
  if (hadImage) globalThis.Image = oldImage;
  else delete globalThis.Image;
});
beforeEach(() => setGlyphPainter(whole));

// The export's page at Size 2x (`renderPageBlob`).
const X2 = { enlarged: true };

// Odd sizes, so a doubling that rounds somewhere shows.
const W = 601;
const H = 403;
const style = (over = {}) => normalizeStyle({ ...defaultStyle(), strokeEffects: [], font: 'Bangers', size: 40, color: '#202020', strokes: [], shadows: [], autoHeight: false, ...over });
// Off whole pixels, as a dragged box is.
const boxOf = (over = {}, at = {}) => ({ id: 'b', lineN: null, text: 'SHARP AT TWICE', x: 120.4, y: 110.6, w: 300, h: 110, style: style(over), ...at });
const pageOf = (boxes, extra = {}) => ({ id: 1, w: W, h: H, lines: [], boxes, ...extra });
const pixels = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;

// Page art with detail at every pixel: a checker of one-pixel squares.
function checkerArt() {
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  const id = x.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const v = ((i % W) + Math.floor(i / W)) % 2 ? 230 : 40;
    id.data.set([v, v, v, 255], i * 4);
  }
  x.putImageData(id, 0, 0);
  return c.toDataURL('image/png');
}

// The 1x page enlarged 2x with the canvas's smooth resize: what a user would
// get by enlarging the Original export.
function enlarged(c) {
  const up = createCanvas(2 * c.width, 2 * c.height);
  const x = up.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(c, 0, 0, up.width, up.height);
  return up;
}

// Of the pixels a box inks, how many are an edge (neither paper nor the ink
// at its darkest, which a translucent box lays lighter than its colour): the
// softness a resample adds.
function edgeShare(c) {
  const d = pixels(c);
  let dark = 255;
  for (let i = 0; i < d.length; i += 4) dark = Math.min(dark, d[i]);
  let edge = 0;
  let inked = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i];
    if (v < 250) inked++;
    if (v < 250 && v > dark + 8) edge++;
  }
  return { edge, inked, share: edge / inked };
}

describe('a page at 2x', () => {
  it('is exactly twice the page each way, with its art enlarged under it', async () => {
    const one = await renderPageCanvas(pageOf([], { cleaned: checkerArt() }));
    const two = await renderPageCanvas(pageOf([], { cleaned: checkerArt() }), 2, X2);
    expect([one.width, one.height]).toEqual([W, H]);
    expect([two.width, two.height]).toEqual([2 * W, 2 * H]);
    // The art is there at 2x, a resize of the 1x art and not a blank: its
    // mean grey is the art's.
    const mean = (c) => {
      const d = pixels(c);
      let t = 0;
      for (let i = 0; i < d.length; i += 4) t += d[i];
      return t / (d.length / 4);
    };
    expect(Math.abs(mean(two) - mean(one))).toBeLessThan(3);
  });

  it('lays an upright box’s picture on the page pixel for pixel, with no resample', async () => {
    const box = boxOf();
    const p = pageOf([box]);
    const page = await renderPageCanvas(p, 2, X2);
    // The box's picture as the composite paints it, and laid by hand with no
    // transform at the corner the composite snaps it to.
    const r = renderBox(box, p, null, null, { w: W, h: H, snap: true });
    // Painted at 2 texture px per page px, uncapped.
    expect(r.canvas.width).toBe(2 * r.cw);
    expect(r.canvas.height).toBe(2 * r.ch);
    const want = createCanvas(2 * W, 2 * H);
    const ctx = want.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, want.width, want.height);
    ctx.drawImage(r.canvas, 2 * Math.round(box.x - r.ox), 2 * Math.round(box.y - r.oy));
    const got = pixels(page);
    const exp = pixels(want);
    let differ = 0;
    for (let i = 0; i < got.length; i++) if (got[i] !== exp[i]) differ++;
    expect(differ).toBe(0);
    // And the letters are there.
    expect(edgeShare(page).inked).toBeGreaterThan(2000);
  });

  it('mirrors an upright box’s picture onto the page pixel for pixel, with no resample', async () => {
    // A painter that does not paint whole boxes: a mirrored upright box is
    // painted straight and mirrored by the canvas (`paintBoxOnPage`).
    setGlyphPainter({ ...whole, box: false });
    const box = boxOf({ flipH: true });
    const p = pageOf([box]);
    const page = await renderPageCanvas(p, 2, X2);
    const r = renderBox(box, p, null, null, { w: W, h: H, snap: true });
    const bc = r.canvas;
    const originX = Math.round(box.x - r.ox);
    const originY = Math.round(box.y - r.oy);
    // The mirror's centre, on the nearest half device pixel.
    const cx = Math.round(4 * (box.x + box.w / 2)) / 4;
    const left = 2 * (2 * cx - originX) - bc.width;
    expect(Number.isInteger(left)).toBe(true);
    // The picture mirrored by hand, a copy with no filter, on white.
    const want = createCanvas(2 * W, 2 * H);
    const ctx = want.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, want.width, want.height);
    ctx.imageSmoothingEnabled = false;
    ctx.translate(left + bc.width, 2 * originY);
    ctx.scale(-1, 1);
    ctx.drawImage(bc, 0, 0);
    const got = pixels(page);
    const exp = pixels(want);
    let differ = 0;
    for (let i = 0; i < got.length; i++) if (got[i] !== exp[i]) differ++;
    expect(differ).toBe(0);
    expect(edgeShare(page).inked).toBeGreaterThan(2000);
  });

  it('paints a turned box at its angle into the larger page: its edges are no softer than at 1x', async () => {
    // At 1x and 2x the turned box is painted at the angle (`boxInJob`), so
    // each edge is one exact coverage pass at either size. Twice the size is
    // four times the ink and twice the edge: the edge's share halves. A
    // picture resampled on the way (painted, scaled down, scaled up) would
    // keep its share or grow it.
    const box = boxOf({ rotation: 17 });
    const one = edgeShare(await renderPageCanvas(pageOf([box])));
    const two = edgeShare(await renderPageCanvas(pageOf([box]), 2, X2));
    expect(two.inked / one.inked).toBeGreaterThan(3.5);
    expect(two.share).toBeLessThan(one.share * 0.7);
  });

  it('resamples a turned box the canvas turns once, as at 1x', async () => {
    // A painter that does not paint whole boxes: a translucent turned box is
    // painted straight and turned by the canvas (`paintBoxOnPage`'s raster
    // route), one resample at either size.
    setGlyphPainter({ ...whole, box: false });
    const box = boxOf({ rotation: 17, opacity: 0.6 });
    const one = await renderPageCanvas(pageOf([box]));
    const two = edgeShare(await renderPageCanvas(pageOf([box]), 2, X2));
    // Its 2x picture is turned once into the 2x page, not into the 1x page
    // and enlarged after: sharper than the Original export enlarged.
    const up = edgeShare(enlarged(one));
    expect(two.inked / edgeShare(one).inked).toBeGreaterThan(3.5);
    expect(two.share).toBeLessThan(up.share * 0.85);
  });

  it('cuts a strip slice at twice its size', async () => {
    const pages = [pageOf([boxOf()], { id: 1 }), pageOf([], { id: 2 })];
    const { tops } = stripOffsets(pages);
    const c = await renderStripSliceCanvas(pages, tops, 100, 700, 2);
    expect([c.width, c.height]).toEqual([2 * W, 1200]);
    expect(edgeShare(c).inked).toBeGreaterThan(2000);
  });
});

describe('a PSD at 2x', () => {
  const shadow = { x: 3, y: 4, size: 5, spread: 0.2, color: '#000000', opacity: 0.5 };
  const read = (bytes) => readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  const layers = (psd, group) => psd.children.find((c) => c.name === group).children;

  it('is a document twice the page, its type twice the size, set twice as far, over art twice as big', async () => {
    const live = boxOf({ shadows: [shadow] }, { id: 'live' });
    const turned = boxOf({ rotation: 12 }, { id: 'turned', x: 200.25, y: 260.5 });
    const p = () => pageOf([live, turned], { raw: checkerArt() });
    const one = read(await buildPagePsd(p(), { chapter: null, column: null }));
    const two = read(await buildPagePsd(p(), { chapter: null, column: null, scale: 2 }));
    expect([one.width, one.height]).toEqual([W, H]);
    expect([two.width, two.height]).toEqual([2 * W, 2 * H]);
    const raw = layers(two, 'Base').find((l) => l.name === 'Raw');
    expect([raw.right - raw.left, raw.bottom - raw.top]).toEqual([2 * W, 2 * H]);
    const [a1, b1] = layers(one, 'Text');
    const [a2, b2] = layers(two, 'Text');
    for (const [l1, l2] of [[a1, a2], [b1, b2]]) {
      expect(l2.text.text).toBe(l1.text.text);
      expect(l2.text.style.fontSize).toBeCloseTo(2 * l1.text.style.fontSize, 6);
      expect(l2.text.style.leading).toBeCloseTo(2 * l1.text.style.leading, 6);
      // The turn stays a turn; the place doubles.
      for (const i of [0, 1, 2, 3]) expect(l2.text.transform[i]).toBeCloseTo(l1.text.transform[i], 6);
      expect(l2.text.transform[4]).toBeCloseTo(2 * l1.text.transform[4], 4);
      expect(l2.text.transform[5]).toBeCloseTo(2 * l1.text.transform[5], 4);
      expect(l2.text.boxBounds.map((v) => v / 2)).toEqual(l1.text.boxBounds);
      // The cached pixels are the 2x picture: about twice each way, on the
      // place the 1x layer is, doubled (the raster is cut to its ink).
      expect(Math.abs((l2.right - l2.left) - 2 * (l1.right - l1.left))).toBeLessThanOrEqual(3);
      expect(Math.abs((l2.bottom - l2.top) - 2 * (l1.bottom - l1.top))).toBeLessThanOrEqual(3);
      expect(Math.abs(l2.left - 2 * l1.left)).toBeLessThanOrEqual(2);
      expect(Math.abs(l2.top - 2 * l1.top)).toBeLessThanOrEqual(2);
    }
    // Pixel lengths double; Spread, a percent, does not.
    const s1 = a1.effects.dropShadow[0];
    const s2 = a2.effects.dropShadow[0];
    expect(s2.size.value).toBeCloseTo(2 * s1.size.value, 6);
    expect(s2.distance.value).toBeCloseTo(2 * s1.distance.value, 6);
    expect(s2.choke.value).toBe(s1.choke.value);
    // Two documents with their art and their layers: past the default five
    // seconds on a loaded machine.
  }, 30000);

  it('places a turned box’s gradient stroke on its letters as at Original', async () => {
    // The stroke's frame grows by its outside width (`placedGradients`),
    // page px; the letters' frames read off the 2x raster are stated in page
    // px too, so the placement is the same at both sizes.
    // Short letters and a wide stroke, so the growth is a large part of the
    // frame and a growth stated in the wrong unit would show.
    const stroke = normalizeStrokeEffect({ size: 40, position: 'outside', fill: 'gradient', gradient: { angle: 30 } });
    const box = boxOf({ rotation: 35, strokeEffects: [stroke] }, { id: 'grad', text: 'HI', w: 90, h: 60 });
    const one = read(await buildPagePsd(pageOf([box]), { chapter: null, column: null }));
    const two = read(await buildPagePsd(pageOf([box]), { chapter: null, column: null, scale: 2 }));
    const [l1] = layers(one, 'Text');
    const [l2] = layers(two, 'Text');
    expect('text' in l1 && 'text' in l2).toBe(true);
    const g1 = l1.effects.stroke.at(-1).gradient;
    const g2 = l2.effects.stroke.at(-1).gradient;
    expect(g2.angle).toBe(g1.angle);
    // The file keeps whole percents: the two may round a percent apart.
    expect(Math.abs(g2.scale - g1.scale)).toBeLessThanOrEqual(0.0101);
    expect(Math.abs(g2.offset.x - g1.offset.x)).toBeLessThanOrEqual(0.0101);
    expect(Math.abs(g2.offset.y - g1.offset.y)).toBeLessThanOrEqual(0.0101);
  }, 30000);
});

// Read back by the PSD import (`chapterPagesFromPsdFiles`): ag-psd lays each
// layer on a canvas, and the import re-encodes the art to PNG bytes.
describe('a PSD that is not its page’s size, read back', () => {
  beforeAll(() => initializeCanvas((w, h) => createCanvas(w, h)));
  const file = (name, bytes) => {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return { name, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  };
  const page = () => pageOf([boxOf({}, { id: 'live' })], { raw: checkerArt() });

  it('says it was exported at 2x; a file at Original says nothing', async () => {
    const one = parsePagePsd(await buildPagePsd(page(), { chapter: null, column: null }));
    const two = parsePagePsd(await buildPagePsd(page(), { chapter: null, column: null, scale: 2 }));
    expect('docScale' in one.project).toBe(false);
    expect(one.project.page.w).toBe(W);
    expect(psdPageScale(one.project, one.psd)).toEqual({ sx: 1, sy: 1 });
    expect(two.project.docScale).toBe(2);
    // The page is stated at its own size; the document is twice it.
    expect([two.project.page.w, two.psd.width]).toEqual([W, 2 * W]);
    expect(psdPageScale(two.project, two.psd)).toEqual({ sx: 2, sy: 2 });
  }, 30000);

  it('refuses a 2x file by default, and brings in an Original one as it was', async () => {
    const one = await buildPagePsd(page(), { chapter: null, column: null });
    const two = await buildPagePsd(page(), { chapter: null, column: null, scale: 2 });
    const r = await chapterPagesFromPsdFiles([file('a.psd', one), file('b.psd', two)]);
    expect(r.pages.length).toBe(1);
    expect([r.pages[0].w, r.pages[0].h]).toEqual([W, H]);
    expect(r.pages[0].boxes[0].x).toBeCloseTo(120.4, 6);
    expect(r.enlarged).toBe(0);
    expect(r.problems).toEqual(['b.psd - exported at 2x: its pages and its art are enlarged']);
  }, 30000);

  it('brings a 2x file in at its document’s size when the user has said yes, its boxes scaled with it', async () => {
    const two = await buildPagePsd(page(), { chapter: null, column: null, scale: 2 });
    const r = await chapterPagesFromPsdFiles([file('b.psd', two)], { enlarged: true });
    expect(r.problems).toEqual([]);
    expect(r.enlarged).toBe(1);
    const [pg] = r.pages;
    expect([pg.w, pg.h]).toEqual([2 * W, 2 * H]);
    const b = pg.boxes[0];
    expect([b.x, b.y, b.w, b.h].map((v) => Math.round(v * 10) / 10)).toEqual([240.8, 221.2, 600, 220]);
    expect(b.style.size).toBeCloseTo(80, 6);
    // The art is the document's: 2x its pixels.
    const art = new Image();
    art.src = Buffer.from(pg.rawBytes);
    expect([art.width, art.height]).toEqual([2 * W, 2 * H]);
  }, 30000);

  it('treats a file whose document is not its page’s size, saying nothing why, the same way', async () => {
    const data = new Uint8ClampedArray(4 * W * H * 4).fill(255);
    const doc = pagePsdDocument({
      w: 2 * W,
      h: 2 * H,
      baseLayers: [{ name: 'Raw', left: 0, top: 0, right: 2 * W, bottom: 2 * H, imageData: { width: 2 * W, height: 2 * H, data } }],
      project: { key: 'mt:project', schema: 1, page: { id: 1, w: W, h: H, hasRaw: true, lines: [], boxes: [{ ...boxOf(), style: style() }] } },
    });
    const bytes = new Uint8Array(writePagePsd(doc));
    const r = await chapterPagesFromPsdFiles([file('c.psd', bytes)]);
    expect(r.pages).toEqual([]);
    expect(r.problems).toEqual(['c.psd - its document is not the size of its page, and its art is resized']);
    const yes = await chapterPagesFromPsdFiles([file('c.psd', bytes)], { enlarged: true });
    expect([yes.pages[0].w, yes.pages[0].h]).toEqual([2 * W, 2 * H]);
    expect(yes.pages[0].boxes[0].w).toBeCloseTo(600, 6);
  }, 30000);
});
