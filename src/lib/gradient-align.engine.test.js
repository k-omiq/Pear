import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { readPsd, initializeCanvas } from 'ag-psd';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxLayer, renderPageCanvas, renderStripSliceCanvas } from './exporter.js';
import { buildPagePsd } from './psd.js';
import { app, loadProjectPages } from './store.svelte.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { pictureTexture } from './editor/box-picture.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeGradientOverlay, normalizeStyle } from './data.js';
import { MAX_PAGE } from '../../text-engine/js/paint.mjs';

// Align with Layer off, end to end through the wasm: every route that paints
// a box lays its page-wide gradient where the page has it. The reference is
// the gradient itself (fx/gradient.rs `Gradient::t`, PhotoCraft's
// `gradient_t`, checked against PhotoCraft's renders in
// text-engine/src/paint/fx/effects_align.rs): a Linear 0 degree black to
// white ramp at 10 % over a 200 x 100 page runs from x = 90 to 110, so the
// colour at a page point x is 255 * ((x - 100 - px / 2) / 20 + 1/2), held to
// 0..255, wherever the box is and however it is turned or mirrored (px is a
// device pixel in page px: Linear samples half a pixel before the centre).
// The ramp is steep, 12.75 levels a page px, so a page off by the export's
// half-pixel snap shows (fix 3 of the design review).
//
// The export paints an upright, unmirrored box at 2 device px a page px and
// lays the bitmap down at half size (`renderBox`): its device pixel is half a
// page px, and its letters' edges are resampled, so only pixels whose eight
// neighbours are opaque too are read. A turned or mirrored box is painted
// straight onto the page at 1 (`paintBoxOnPage`).
//
// Limit: one level either way, the 8-bit rounding of the ramp (measured: at
// most 0.56 off over the interior, every route).

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled(), layout: app.projectLayout };

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150), fonts: { ready: Promise.resolve() } };
  initializeCanvas((w, h) => createCanvas(w, h));
  const rust = await rustEngine();
  setTextEngine(rust);
  setGlyphPainter(createRustGlyphPainter(rust));
  setTypesetEnabled(true);
  clearLayoutMemo();
});
afterEach(() => {
  app.projectLayout = before.layout;
  loadProjectPages([]);
});
afterAll(() => {
  setTextEngine(before.engine);
  setGlyphPainter(before.painter);
  setTypesetEnabled(before.typeset);
  clearLayoutMemo();
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});

const W = 200;
const H = 100;
const ramp = (align) => normalizeGradientOverlay({ gradient: { style: 'linear', angle: 0, scale: 0.1, align, stops: [{ color: '#000000', pos: 0 }, { color: '#ffffff', pos: 1 }] } });
const boxOf = (over = {}, align = false) => ({
  id: 'b',
  lineN: null,
  text: 'MMM',
  x: 60.4,
  y: 20.3,
  w: 80,
  h: 60,
  style: normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 56, color: '#ff0000', strokes: [], autoHeight: false, gradientOverlays: [ramp(align)], ...over }),
});
const pageOf = (box) => ({ id: 1, w: W, h: H, lines: [], boxes: [box] });
const want = (x, px) => 255 * Math.min(1, Math.max(0, (x - 100 - px / 2) / 20 + 0.5));

// The export's layer: its pixels on the page, page px (scale 1).
function exported(box) {
  const r = renderBoxLayer(box, W, H, null, pageOf(box), 1, null);
  const s = box.style;
  const px = s.rotation || s.flipH || s.flipV ? 1 : 0.5;
  const out = [];
  const im = r.imageData;
  const opaque = (x, y) => im.data[(y * im.width + x) * 4 + 3] === 255;
  for (let y = 1; y < im.height - 1; y++) {
    for (let x = 1; x < im.width - 1; x++) {
      if (![-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) => opaque(x + dx, y + dy)))) continue;
      out.push({ x: r.left + x + 0.5, y: r.top + y + 0.5, v: im.data[(y * im.width + x) * 4], px });
    }
  }
  return out;
}

// The editor's picture at `ss`: painted upright in the box's own frame and
// set on the page by CSS, turned and mirrored about the box's centre.
function editor(box, ss = 2) {
  const t = pictureTexture(box, pageOf(box), null, ss, undefined, false, null, null, { w: W, h: H });
  const im = t.canvas.getContext('2d').getImageData(0, 0, t.canvas.width, t.canvas.height);
  const s = box.style;
  const r = ((s.rotation || 0) * Math.PI) / 180;
  const [cx, cy] = [box.x + box.w / 2, box.y + box.h / 2];
  const out = [];
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      const i = (y * im.width + x) * 4;
      if (im.data[i + 3] !== 255) continue;
      // The texel's centre in the box's frame, then mirrored and turned.
      let lx = (x + 0.5) / t.ss - t.ox - box.w / 2;
      let ly = (y + 0.5) / t.ss - t.oy - box.h / 2;
      if (s.flipH) lx = -lx;
      if (s.flipV) ly = -ly;
      out.push({ x: cx + lx * Math.cos(r) - ly * Math.sin(r), y: cy + lx * Math.sin(r) + ly * Math.cos(r), v: im.data[i], px: 1 / t.ss });
    }
  }
  return out;
}

// The pixels on the ramp's slope, and the worst miss there.
function miss(px) {
  const slope = px.filter((p) => p.x > 91 && p.x < 109);
  expect(slope.length).toBeGreaterThan(30);
  return Math.max(...slope.map((p) => Math.abs(p.v - want(p.x, p.px))));
}

describe('a gradient with Align with Layer off', () => {
  it('is laid over the page in the export, upright at a fraction of a pixel', () => {
    expect(miss(exported(boxOf()))).toBeLessThanOrEqual(1);
  });

  it('stays put on the page when the box moves', () => {
    for (const at of [{ x: 52.7, y: 31.1 }, { x: 70, y: 10 }]) {
      expect(miss(exported({ ...boxOf(), ...at }))).toBeLessThanOrEqual(1);
    }
  });

  it('does not turn or mirror with the box, in the export or the editor', () => {
    for (const over of [{ rotation: 30 }, { rotation: -75 }, { flipH: true }, { flipV: true, rotation: 12 }]) {
      expect(miss(exported(boxOf(over))), JSON.stringify(over)).toBeLessThanOrEqual(1);
      expect(miss(editor(boxOf(over))), JSON.stringify(over)).toBeLessThanOrEqual(1);
    }
  });

  it('paints in the editor what the export paints', () => {
    expect(miss(editor(boxOf()))).toBeLessThanOrEqual(1);
    expect(miss(editor(boxOf(), 3))).toBeLessThanOrEqual(1);
  });

  it('is the letters\' own ramp with Align on, which moves with the box', () => {
    // With Align on the ramp is centred on the letters, not on the page.
    expect(miss(exported(boxOf({}, true)))).toBeGreaterThan(40);
  });

  // A long-strip page can be taller than 65536 px. The engine takes a page up
  // to MAX_PAGE (2^20 px) a side, and the encoder sends none past it, so a
  // box on a taller page paints as Align on instead of being refused. A
  // Linear 90 degree ramp over the whole page height is one flat colour on a
  // box at its top; with Align on it spans the letters.
  it('takes a page up to MAX_PAGE tall and paints Align on past it', () => {
    const tall = (align) => ({ ...boxOf({ gradientOverlays: [normalizeGradientOverlay({ gradient: { style: 'linear', angle: 90, scale: 1, align, stops: [{ color: '#000000', pos: 0 }, { color: '#ffffff', pos: 1 }] } })] }, align) });
    const values = (box, h) => {
      const t = pictureTexture(box, { ...pageOf(box), h }, null, 1, undefined, false, null, null, { w: W, h });
      const im = t.canvas.getContext('2d').getImageData(0, 0, t.canvas.width, t.canvas.height);
      const v = [];
      for (let i = 0; i < im.data.length; i += 4) if (im.data[i + 3] === 255) v.push(im.data[i]);
      expect(v.length).toBeGreaterThan(100);
      return v;
    };
    const spread = (v) => Math.max(...v) - Math.min(...v);
    const on = values(tall(true), MAX_PAGE + 1);
    expect(spread(on)).toBeGreaterThan(100);
    // Just under (at) the bound: laid over the page, one flat colour.
    expect(spread(values(tall(false), MAX_PAGE))).toBeLessThanOrEqual(1);
    expect(spread(values(tall(false), 70000))).toBeLessThanOrEqual(1);
    // Just over: no page sent, painted as Align on, not refused.
    expect(values(tall(false), MAX_PAGE + 1)).toEqual(on);
  });
});

// Each export route hands the painter the page the box's Align off gradient
// is laid over: the flat page export its page, the strip export each box's
// own page, and a strip page's PSD a neighbour's box its own page (not the
// document it lands in). The pixels read are the letters' interior, found
// from the box's own layer (`exported`), so the page's white does not count.
describe('every export route lays it over the box\'s own page', () => {
  // The interior pixels of `box` on its page, page px, moved by (ox, oy).
  const inside = (box, ox = 0, oy = 0) => exported(box).map((q) => ({ ...q, x: q.x + ox, y: q.y + oy }));
  const read = (canvas, pts, ox = 0, oy = 0) => {
    const ctx = canvas.getContext('2d');
    return pts.map((q) => ({ x: q.x - ox, v: ctx.getImageData(Math.floor(q.x), Math.floor(q.y), 1, 1).data[0], px: q.px }));
  };

  it('the flat page export', async () => {
    const box = boxOf();
    const canvas = await renderPageCanvas(pageOf(box));
    expect(miss(read(canvas, inside(box)))).toBeLessThanOrEqual(1);
  });

  it('the strip export, a box on either page', async () => {
    const top = { ...boxOf(), id: 't' };
    const low = { ...boxOf(), id: 'l', y: 25.6 };
    const pages = [{ ...pageOf(top), id: 1 }, { ...pageOf(low), id: 2 }];
    const canvas = await renderStripSliceCanvas(pages, [0, H], 0, 2 * H);
    expect(miss(read(canvas, inside(top)))).toBeLessThanOrEqual(1);
    expect(miss(read(canvas, inside(low, 0, H), 0, H))).toBeLessThanOrEqual(1);
  });

  it('a strip page\'s PSD, for the box of the page above that reaches into it', async () => {
    // A Linear 90 degree ramp at 150 % over the owner page (200 x 100) is
    // still climbing past its foot, where the box crosses into the page
    // below (200 x 300); laid over that page's document it would be some
    // other colour there.
    const down = normalizeGradientOverlay({ gradient: { style: 'linear', angle: 90, scale: 1.5, align: false, stops: [{ color: '#000000', pos: 0 }, { color: '#ffffff', pos: 1 }] } });
    const box = { ...boxOf({ gradientOverlays: [down] }), y: 60, h: 100 };
    app.projectLayout = 'longstrip';
    loadProjectPages([
      { id: 1, w: W, h: H, lines: [], boxes: [box] },
      { id: 2, w: W, h: 300, lines: [], boxes: [] },
    ]);
    // The whole box over its own page, on a canvas tall enough to hold it.
    const whole = renderBoxLayer(box, W, 400, null, app.pages[0], 1, null, 0, 0, { w: W, h: H });
    const overDoc = renderBoxLayer(box, W, 400, null, app.pages[0], 1, null, 0, 0, { w: W, h: 300 });
    const psd = readPsd(await buildPagePsd(app.pages[1]), { useImageData: true, skipThumbnail: true });
    const layer = (psd.children ?? []).find((c) => c.name === 'Text')?.children?.[0];
    expect(layer?.imageData).toBeTruthy();
    const at = (r, x, y) => {
      const ix = x - r.left;
      const iy = y - r.top;
      if (ix < 0 || iy < 0 || ix >= r.imageData.width || iy >= r.imageData.height) return null;
      const i = (iy * r.imageData.width + ix) * 4;
      return r.imageData.data[i + 3] === 255 ? r.imageData.data[i] : null;
    };
    let n = 0;
    let worst = 0;
    let apart = 0;
    for (let y = 0; y < layer.imageData.height; y++) {
      for (let x = 0; x < layer.imageData.width; x++) {
        const v = at(layer, layer.left + x, layer.top + y);
        // The same pixel in the owner's space: the page below starts at 100.
        const want = at(whole, layer.left + x, layer.top + y + H);
        if (v == null || want == null) continue;
        n++;
        worst = Math.max(worst, Math.abs(v - want));
        apart = Math.max(apart, Math.abs(want - (at(overDoc, layer.left + x, layer.top + y + H) ?? want)));
      }
    }
    expect(n).toBeGreaterThan(100);
    expect(apart).toBeGreaterThan(40);
    expect(worst).toBeLessThanOrEqual(1);
  });
});

