import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas, Image } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderPageCanvas } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { boxEffects } from './text-paint.js';
import { encodeBox } from '../../text-engine/js/paint.mjs';
import { forgetBackdrops } from './backdrop.js';

// ===========================================================================
// Stroke Overprint: a "does not paint" guard (not a parity render compare)
// ===========================================================================
// Reference: PhotoCraft (dada110) stores `StrokeFx.overprint` and never reads
// it in crates/compose or crates/gpu (docs/file-format-parity.md: "Rendering
// ignores it for now"); Photoshop documents no rule. So the reference look of
// a stroke with Overprint on is the same stroke with it off, and this guard
// holds that ours is too: the same box job on the wire, and the same page
// pixels over page art that is not flat, with a Multiply stroke that does
// blend with that art. Tolerance: worst pixel 0, mean 0 (exact), because
// the flag never reaches the engine; any difference is a bug, not spread.
// So the guard cannot pass for nothing, it also holds that the box with
// Overprint on really carries it after normalizing, and that its stroke
// paints (the page differs from the same box with no stroke).

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
// Page art that is not flat: a ramp left to right and stripes, so a Multiply
// stroke over it shows the art through.
function rampArt() {
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#ff8040');
  g.addColorStop(1, '#2060ff');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  x.fillStyle = 'rgba(255,255,255,0.6)';
  for (let y = 0; y < H; y += 16) x.fillRect(0, y, W, 6);
  return c.toDataURL('image/png');
}
const stroke = (over = {}) => ({ size: 6, position: 'center', blend: 'multiply', opacity: 0.8, color: '#ff00ff', ...over });
const style = (strokeEffects) => normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 72, color: '#40ff40', strokes: [], shadows: [], autoHeight: false, strokeEffects });
const boxOf = (s) => ({ id: 'b', lineN: null, text: 'OVER', x: 120, y: 110, w: 320, h: 120, style: s });

async function pagePixels(s, art) {
  forgetBackdrops();
  clearLayoutMemo();
  const canvas = await renderPageCanvas({ id: 1, w: W, h: H, lines: [], boxes: [boxOf(s)], cleaned: art });
  return canvas.getContext('2d').getImageData(0, 0, W, H).data;
}
function diff(a, b) {
  let worst = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) worst = d;
    sum += d;
  }
  return { worst, mean: sum / a.length };
}

describe('Stroke Overprint does not paint', () => {
  const off = style([stroke()]);
  const on = style([stroke({ overprint: true })]);

  it('is carried by the style it is set on', () => {
    expect(on.strokeEffects[0].overprint).toBe(true);
    expect('overprint' in off.strokeEffects[0]).toBe(false);
  });

  it('sends the engine the same box job', () => {
    expect(boxEffects(on)).toEqual(boxEffects(off));
    expect(boxEffects(on).some((e) => e.kind === 'stroke')).toBe(true);
    const job = { job: { bands: [], runs: [], fill: { kind: 'solid', color: '#000000' } }, font: 0, size: 10, width: 8, height: 8 };
    const a = encodeBox({ ...job, effects: boxEffects(off) }).slice();
    const b = encodeBox({ ...job, effects: boxEffects(on) }).slice();
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  });

  it('paints the page the same, exactly, over art that is not flat', async () => {
    const art = rampArt();
    const pxOff = await pagePixels(off, art);
    const pxOn = await pagePixels(on, art);
    const none = await pagePixels(style([]), art);
    // The stroke paints: the page with it is not the page without it.
    expect(diff(pxOff, none).worst).toBeGreaterThan(50);
    expect(diff(pxOn, none).worst).toBeGreaterThan(50);
    expect(diff(pxOn, pxOff)).toEqual({ worst: 0, mean: 0 });
  });
});
