import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxLayer } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { pictureTexture } from './editor/box-picture.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeGradientOverlay, normalizeStyle } from './data.js';

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
});
