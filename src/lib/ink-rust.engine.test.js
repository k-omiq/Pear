import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture, renderBoxLayer, boxInJob } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter, forgetPainterTips } from './text-engine/index.js';
import { inkTipBytes, putInkTip, hasInkTip } from '../../text-engine/js/paint.mjs';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { inkBox as boxOf, inkPage as pageOf, wave, zigzag, ink, against, makeTips } from '../test/ink-fixtures.js';

// ===========================================================================
// Brush ink painted by the engine, in the box job (layer styles phase 8a)
// ===========================================================================
// A box's hand-drawn ink of round dabs goes into the box job where the
// painter paints it (`ink`, a wasm of box wire v12; `boxInJob`): the engine
// lays the strokes (text-engine/src/paint/ink/) and every layer effect takes
// its shape from the letters and the ink together. Held here: the engine's
// ink is the picture `drawInk` paints on the canvas, case by case, at three
// scales and turned; and the effects reach the ink.
//
// The reference is the same Rust painter with `ink: false`, which sends an
// inked box down the canvas passes: the letters are the engine's either way,
// the ink is @napi-rs/canvas's (Skia's).
//
//   MT_INK_COMPARE=dir npx vitest run --project engine ink-rust
//
// also writes each case's two pictures, `name.js.png` and `name.rust.png`.

const OUT = process.env.MT_INK_COMPARE;
const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let whole;
let canvasInk;
let rust;

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  rust = await rustEngine();
  setTextEngine(rust);
  whole = createRustGlyphPainter(rust);
  canvasInk = { ...whole, ink: false };
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
beforeEach(() => setGlyphPainter(whole));

function texture(box, painter, scale, tips = null) {
  setGlyphPainter(painter);
  const r = renderBoxTexture(box, pageOf(box), tips, scale);
  setGlyphPainter(whole);
  return { ...r, img: r.canvas.getContext('2d').getImageData(0, 0, r.canvas.width, r.canvas.height) };
}

function png(name, img) {
  if (!OUT) return;
  const dir = resolve(OUT);
  mkdirSync(dir, { recursive: true });
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, img.width, img.height);
  const top = createCanvas(img.width, img.height);
  top.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(top, 0, 0);
  writeFileSync(resolve(dir, name), c.toBuffer('image/png'));
}

const pixel = (img, x, y) => {
  const i = (Math.round(y) * img.width + Math.round(x)) * 4;
  return [...img.data.slice(i, i + 4)];
};
const inkOf = (img) => {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) n += img.data[i];
  return n;
};

describe('the gate', () => {
  it('lets a box of ink into the job where the painter paints ink, and nothing else', () => {
    const round = ink({});
    expect(whole.ink).toBe(true);
    expect(boxInJob(boxOf({ ink: round }))).toBe(true);
    expect(boxInJob(boxOf({ ink: round }, ''))).toBe(true);
    // An imported tip and a tip cycle are the engine's (phase 8b), and so
    // are ink under a mesh and a roughening (8c).
    expect(boxInJob(boxOf({ ink: ink({ brush: 'tip-1' }) }))).toBe(true);
    expect(boxInJob(boxOf({ ink: ink({ tips: ['a', 'b'] }) }))).toBe(true);
    expect(boxInJob(boxOf({ ink: round, roughen: { on: true, amount: 4, detail: 0.1, seed: 2 } }))).toBe(true);
    const box = boxOf({ ink: round });
    box.style.warp = { on: true, cols: 1, rows: 1, pts: [[0, 0], [260, 10], [0, 130], [260, 130]] };
    expect(boxInJob(box)).toBe(true);
    setGlyphPainter(canvasInk);
    expect(boxInJob(boxOf({ ink: round }))).toBe(false);
    expect(boxInJob(boxOf())).toBe(true);
  });
});


// Each case: the style over the defaults, then the most the two pictures may
// differ by, mean and worst, of 255, set from the first measured run (the
// largest of the three scales, with and without letters, and a third more for
// the mean). The ink's total is held within 1 % under and 1.5 % over.
//
// What the numbers are made of. Skia covers a round dab with four rows of
// samples a pixel: one dab's area comes out 2.6 % under the circle's, and an
// edge pixel up to 55 levels off its true share. The engine covers each dab
// by its exact area. A stroke's edge is that pixel under ten dabs or more, so
// the worst pixel along any hard edge is 60 to 100 levels off and the mean a
// level or two; a soft dab, whose edge is the ramp, differs by a few levels.
// Anti-aliasing None and Middle cut the alpha at a threshold, so an edge pixel
// either side of it flips whole (the worst, up to 241); an outline is a
// threshold of the distance to the ink at half its alpha, so it moves by a
// pixel where the ink's edge pixel crosses that half.
const CASES = {
  'round hard': [{ ink: ink({}) }, 3.3, 96],
  'soft red at hardness 30': [{ ink: ink({ color: '#dc2626', hardness: 30, size: 24 }) }, 1.1, 20],
  'flat and turned': [{ ink: ink({ flatness: 0.3, angle: 40, size: 22 }) }, 3.2, 85],
  'flat, following the line': [{ ink: ink({ flatness: 0.35, followDir: true, size: 20 }) }, 3.7, 96],
  'flipped and jittered': [{ ink: ink({ flatness: 0.4, flipX: 'random', flipY: 'on', angleJitter: 40, size: 20 }) }, 3.5, 97],
  'translucent, overlapping itself': [{ ink: ink({ opacity: 0.5, pts: [...zigzag, [40, 60, 1], [220, 60, 1]] }) }, 2.3, 48],
  'two translucent strokes': [{ ink: ink({ opacity: 0.6, color: '#2563eb' }, { opacity: 0.6, color: '#dc2626', pts: zigzag }) }, 3.7, 58],
  'faded by its dynamics': [{ ink: ink({ pts: wave(24, (t) => [0.2 + 0.8 * t, 1]) }) }, 3.9, 67],
  'faded and soft': [{ ink: ink({ hardness: 50, size: 20, opacity: 0.8, pts: wave(24, (t) => [1 - 0.7 * t, 1]) }) }, 1.1, 22],
  'squashed by its dynamics': [{ ink: ink({ flatness: 0.8, pts: wave(24, (t) => [1, 0.3 + 0.7 * t]) }) }, 3.6, 110],
  'tapered and thinned': [{ ink: ink({ size: 18, taperIn: { on: true, len: 40, ratio: 60 }, taperOut: { on: true, len: 30, ratio: 0, mode: 'pct' }, pts: wave(24).map((p, i) => [p[0], p[1], 0.4 + 0.6 * Math.sin((i / 23) * Math.PI)]) }) }, 3.3, 100],
  'anti-aliasing none': [{ ink: ink({ antialias: 0 }) }, 8.3, 256],
  'anti-aliasing weak': [{ ink: ink({ antialias: 1, hardness: 60 }) }, 6, 54],
  'anti-aliasing middle': [{ ink: ink({ antialias: 2 }) }, 6.9, 129],
  'grain': [{ ink: ink({ size: 26, texture: { on: true, density: 0.6, scale: 300 } }) }, 4.7, 94],
  'grain, emphasised': [{ ink: ink({ size: 26, texture: { on: true, density: 0.8, scale: 200, stress: true } }) }, 6.3, 103],
  'watercolour edge': [{ ink: ink({ size: 20, color: '#16a34a', waterEdge: true, waterEdgeWidth: 4, waterEdgePower: 0.7 }) }, 4, 75],
  'watercolour edge, dark and blurred': [{ ink: ink({ size: 20, color: '#16a34a', opacity: 0.8, waterEdge: true, waterEdgeWidth: 5, waterEdgePower: 0.9, waterEdgeDark: 0.6, waterEdgeBlur: 3 }) }, 2, 51],
  'watercolour edge, no anti-aliasing': [{ ink: ink({ size: 20, waterEdge: true, waterEdgeWidth: 3, waterEdgePower: 0.5, antialias: 0 }) }, 5, 256],
  'compare density': [{ ink: ink({ opacity: 0.7, color: '#7c3aed' }, { opacity: 0.7, color: '#7c3aed', blend: 'density', pts: zigzag }) }, 4.2, 65],
  'pointed corners': [{ ink: ink({ size: 16, corners: 40, pts: zigzag }) }, 2.9, 89],
  'a round ribbon': [{ ink: ink({ size: 16, ribbon: true, flatness: 0.5 }) }, 2.8, 112],
  'outlined, two bands': [{ ink: ink({ size: 12, color: '#000000' }), strokes: [{ color: '#ffffff', width: 3, opacity: 1 }, { color: '#1d4ed8', width: 2, opacity: 0.8 }] }, 10, 174],
  'outlined, translucent ink': [{ ink: ink({ size: 16, opacity: 0.5, color: '#b91c1c' }), strokes: [{ color: '#fde047', width: 4, opacity: 1 }] }, 5.5, 176],
};
const SCALES = [1, 2, 2.74];
const MEASURE = process.env.MT_INK_MEASURE === '1';
const fileOf = (name) => name.replace(/[^a-z0-9]+/gi, '-');

describe('the engine paints the ink the canvas painted', () => {
  for (const [name, [over, mean, worst]] of Object.entries(CASES)) {
    it(name, () => {
      for (const scale of SCALES) {
        for (const text of ['INK', '']) {
          const box = boxOf(over, text);
          const a = texture(box, whole, scale);
          const b = texture(box, canvasInk, scale);
          expect([a.ox, a.oy, a.cw, a.ch]).toEqual([b.ox, b.oy, b.cw, b.ch]);
          const d = against(a.img, b.img);
          if (MEASURE) console.log(`MEASURE ${name} | ${scale} | ${text || 'empty'} | mean ${d.mean.toFixed(3)} worst ${d.worst.toFixed(1)} ink ${d.ink.toFixed(4)} n ${d.n}`);
          if (scale === 2 && text === 'INK') {
            png(`${fileOf(name)}.js.png`, b.img);
            png(`${fileOf(name)}.rust.png`, a.img);
          }
          const at = `scale ${scale}, ${text ? 'over letters' : 'alone'}`;
          expect(d.n, at).toBeGreaterThan(1000);
          expect(d.mean, `${at}: mean`).toBeLessThan(mean);
          expect(d.worst, `${at}: worst`).toBeLessThan(worst);
          expect(d.ink, `${at}: ink`).toBeGreaterThan(0.99);
          expect(d.ink, `${at}: ink`).toBeLessThan(1.015);
        }
      }
    });
  }
});

describe('a turned box', () => {
  const layer = (box, painter, scale) => {
    setGlyphPainter(painter);
    const p = pageOf(box);
    const r = renderBoxLayer(box, p.w, p.h, null, p, scale, null);
    setGlyphPainter(whole);
    return r;
  };
  const onPage = (l, w, h) => {
    const c = createCanvas(w, h);
    c.getContext('2d').putImageData(l.imageData, l.left, l.top);
    return c.getContext('2d').getImageData(0, 0, w, h);
  };
  // The canvas paints the box straight and turns the bitmap, a resample of
  // every edge; the engine paints it at its angle. Set from the first
  // measured run.
  const TURNED = {
    'turned, round ink': [{ rotation: 17, ink: ink({}) }, 5],
    'turned and mirrored, soft ink in an outline': [{ rotation: -30, flipH: true, ink: ink({ hardness: 40, size: 20, color: '#dc2626' }), strokes: [{ color: '#ffffff', width: 3, opacity: 1 }] }, 8],
  };
  for (const [name, [over, mean]] of Object.entries(TURNED)) {
    it(`${name}: lands where the turned bitmap landed`, () => {
      for (const scale of [1, 2]) {
        const box = boxOf(over);
        const a = layer(box, whole, scale);
        const b = layer(box, canvasInk, scale);
        for (const k of ['left', 'top', 'right', 'bottom']) expect(Math.abs(a[k] - b[k]), `${k} at ${scale}`).toBeLessThanOrEqual(3 * scale);
        const d = against(onPage(a, 600 * scale, 400 * scale), onPage(b, 600 * scale, 400 * scale));
        if (MEASURE) console.log(`MEASURE ${name} | ${scale} | mean ${d.mean.toFixed(3)} worst ${d.worst.toFixed(1)} ink ${d.ink.toFixed(4)}`);
        if (scale === 2) {
          png(`${fileOf(name)}.js.png`, b.imageData);
          png(`${fileOf(name)}.rust.png`, a.imageData);
        }
        expect(d.ink, `ink at ${scale}`).toBeGreaterThan(0.98);
        expect(d.ink, `ink at ${scale}`).toBeLessThan(1.02);
        expect(d.mean, `mean at ${scale}`).toBeLessThan(mean);
      }
    });
  }
});

// The layer effects take their shape from the ink: what this phase is for.
describe('the effects reach the ink', () => {
  const RED = '#ff0000';
  const BLACK_INK = ink({ color: '#000000', size: 16 });
  const plain = (over = {}, text = 'INK') => texture(boxOf({ ink: BLACK_INK, ...over }, text), whole, 2);
  // A point of the box in the texture's pixels.
  const at = (r, x, y) => pixel(r.img, (r.ox + x) * r.ss, (r.oy + y) * r.ss);
  // The middle of the stroke where the wave tops out, away from the letters
  // (the wave is at its highest, y 30, at x 185).
  const onStroke = (r) => at(r, 185, 30);
  // Clear of the stroke and the letters: 14 below that.
  const under = (r) => at(r, 185, 44);

  it('a colour overlay recolours the ink', () => {
    expect(onStroke(plain())).toEqual([0, 0, 0, 255]);
    const r = plain({ colorOverlays: [{ color: RED, opacity: 1, blend: 'normal' }] });
    expect(onStroke(r)).toEqual([255, 0, 0, 255]);
  });

  it('an outer glow and a drop shadow are thrown round an ink box with no letters', () => {
    expect(under(plain({}, ''))[3]).toBe(0);
    const glow = plain({ outerGlow: { on: true, color: RED, opacity: 1, size: 12, spread: 0.5, blend: 'normal' } }, '');
    expect(under(glow)[3]).toBeGreaterThan(100);
    expect(under(glow)[0]).toBeGreaterThan(200);
    const shadow = plain({ shadows: [{ x: 0, y: 12, size: 0, color: RED, opacity: 1 }] }, '');
    expect(under(shadow)).toEqual([255, 0, 0, 255]);
  });

  it('Fill Opacity 0 hides the ink and keeps a stroke effect round it', () => {
    const r = plain({ fillOpacity: 0, strokeEffects: [{ size: 3, position: 'outside', color: RED, opacity: 1, blend: 'normal' }] }, '');
    expect(onStroke(r)[3]).toBe(0);
    let red = 0;
    for (let i = 0; i < r.img.data.length; i += 4) if (r.img.data[i] > 200 && r.img.data[i + 1] < 60 && r.img.data[i + 3] > 200) red++;
    expect(red).toBeGreaterThan(500);
  });

  it('No Fill keeps the ink drawn, under the effects laid on it', () => {
    const outline = [{ color: '#2563eb', width: 2, opacity: 1 }];
    expect(onStroke(plain({ noFill: true, strokes: outline }))).toEqual([0, 0, 0, 255]);
    // With an overlay too, which takes the interior route.
    const o = plain({ noFill: true, strokes: outline, colorOverlays: [{ color: RED, opacity: 1, blend: 'normal' }] });
    expect(onStroke(o)).toEqual([255, 0, 0, 255]);
  });

  it('an ink box with no text paints, and the same box twice is the same bytes', () => {
    const a = plain({}, '');
    expect(inkOf(a.img)).toBeGreaterThan(255 * 2000);
    expect(against(a.img, plain({}, '').img).worst).toBe(0);
  });
});

// ===========================================================================
// Imported tips (layer styles phase 8b)
// ===========================================================================
// A stroke drawn with an imported tip goes into the box job too: the page
// reads each tip's coverage once and puts it in the engine (`tipCoverage`,
// `putInkTip`), and the engine stamps it (text-engine/src/paint/ink/tips.rs).
// The tips here are made on @napi-rs/canvas as the library hands them on
// (`makeTips`, src/test/ink-fixtures.js).

// Each case: the style, then the most the two pictures may differ by, mean
// and worst, of 255, set from the first measured run as the round cases
// were (the largest over the scales, with and without letters, a third more
// for the mean). The total is held within 3 % either way.
//
// Past what the round dab's edge costs (above), a tip is read by the canvas
// through Skia's 'high' sampling and its own halvings, and by the engine
// bilinear from 2 x 2 box halvings: a smooth tip is within a level or two
// (worst 10 to 25), a noisy one a little more, as every grain is read a
// little differently. Darken keeps the densest of many such reads, and
// Skia's sharper read reaches denser grains: the canvas's ink is up to 2 %
// more. A ribbon's slices meet seamless in the engine (`Pen::image`); the
// canvas's meet nearly so, so where they fan out round a bend a pixel is
// in one picture and not the other (worst 255, mean a few levels).
// Anti-aliasing None and an outline cut at a threshold, as for round ink.
const TIPPED = {
  'a soft disc tip': [{ ink: ink({ brush: 'disc', size: 26 }) }, 1.1, 13],
  'a tall strip, following the line': [{ ink: ink({ brush: 'strip', size: 28, followDir: true }) }, 0.2, 28],
  'a tall strip, flat and turned': [{ ink: ink({ brush: 'strip', size: 30, flatness: 0.5, angle: 35 }) }, 0.4, 17],
  'a noisy tip, flipped and jittered': [{ ink: ink({ brush: 'noise', size: 30, spacing: 25, flipX: 'random', flipY: 'on', angleJitter: 50 }) }, 2.8, 30],
  'a noisy tip, translucent': [{ ink: ink({ brush: 'noise', size: 30, spacing: 20, opacity: 0.6, color: '#2563eb' }) }, 3, 30],
  'a disc tip faded by its dynamics': [{ ink: ink({ brush: 'disc', size: 26, pts: wave(24, (t) => [0.2 + 0.8 * t, 1]) }) }, 0.3, 6],
  'a disc tip, no anti-aliasing': [{ ink: ink({ brush: 'disc', size: 26, antialias: 0 }) }, 4.8, 256],
  'a noisy tip with grain': [{ ink: ink({ brush: 'noise', size: 30, texture: { on: true, density: 0.6, scale: 300 } }) }, 3, 30],
  'a ribbon of bars, wrapping': [{ ink: ink({ brush: 'bars', size: 24, ribbon: true }) }, 7.2, 256],
  'a ribbon of bars, translucent and flipped': [{ ink: ink({ brush: 'bars', size: 24, ribbon: true, opacity: 0.7, flipX: 'on' }) }, 9.6, 199],
  'a tip cycle, repeat': [{ ink: ink({ brush: 'disc', tips: ['disc', 'strip', 'noise'], tipOrder: 'repeat', size: 28, spacing: 30 }) }, 1.5, 23],
  'a tip cycle, reverse': [{ ink: ink({ brush: 'disc', tips: ['disc', 'strip', 'noise'], tipOrder: 'reverse', size: 28, spacing: 30 }) }, 1.7, 35],
  'a tip cycle, once': [{ ink: ink({ brush: 'disc', tips: ['disc', 'strip', 'noise'], tipOrder: 'once', size: 28, spacing: 30 }) }, 3, 29],
  'a tip cycle, random': [{ ink: ink({ brush: 'disc', tips: ['disc', 'strip', 'noise'], tipOrder: 'random', size: 28, spacing: 30 }) }, 1.5, 32],
  'darken tips': [{ ink: ink({ brush: 'noise', size: 30, spacing: 15, darkenTips: true }) }, 7.7, 60],
  'darken tips, translucent, in a cycle': [{ ink: ink({ brush: 'disc', tips: ['disc', 'noise'], size: 30, spacing: 15, darkenTips: true, opacity: 0.7, color: '#16a34a' }) }, 1.9, 42],
  'a tip bigger than a tint': [{ ink: ink({ brush: 'big', size: 60, spacing: 8 }) }, 1.3, 7],
  'a tip not in hand paints round': [{ ink: ink({ brush: 'nope' }) }, 3.3, 92],
  "a cycle entry not in hand is the stroke's own tip": [{ ink: ink({ brush: 'strip', tips: ['strip', 'nope', 'disc'], size: 28, spacing: 30 }) }, 0.7, 18],
  'a tip in an outline': [{ ink: ink({ brush: 'noise', size: 26, color: '#000000' }), strokes: [{ color: '#fde047', width: 4, opacity: 1 }] }, 3.5, 256],
};

describe('imported tips: the engine paints the ink the canvas painted', () => {
  let tips;
  beforeAll(() => {
    tips = makeTips();
  });
  for (const [name, [over, mean, worst]] of Object.entries(TIPPED)) {
    it(name, () => {
      for (const scale of SCALES) {
        for (const text of ['INK', '']) {
          const box = boxOf(over, text);
          // The engine's picture against the canvas's, not the canvas's twice.
          expect(boxInJob(box), 'in the box job').toBe(true);
          const a = texture(box, whole, scale, tips);
          const b = texture(box, canvasInk, scale, tips);
          expect([a.ox, a.oy, a.cw, a.ch]).toEqual([b.ox, b.oy, b.cw, b.ch]);
          const d = against(a.img, b.img);
          if (MEASURE) console.log(`MEASURE tip ${name} | ${scale} | ${text || 'empty'} | mean ${d.mean.toFixed(3)} worst ${d.worst.toFixed(1)} ink ${d.ink.toFixed(4)} n ${d.n}`);
          if (scale === 2 && text === 'INK') {
            png(`tip-${fileOf(name)}.js.png`, b.img);
            png(`tip-${fileOf(name)}.rust.png`, a.img);
          }
          const at = `scale ${scale}, ${text ? 'over letters' : 'alone'}`;
          expect(d.n, at).toBeGreaterThan(1000);
          expect(d.mean, `${at}: mean`).toBeLessThan(mean);
          expect(d.worst, `${at}: worst`).toBeLessThan(worst);
          expect(d.ink, `${at}: ink`).toBeGreaterThan(0.97);
          expect(d.ink, `${at}: ink`).toBeLessThan(1.03);
        }
      }
    });
  }

  it('a tip not in hand paints the round dab, byte for byte', () => {
    const box = boxOf({ ink: ink({ brush: 'nope' }) });
    const round = boxOf({ ink: ink({}) });
    expect(against(texture(box, whole, 2, tips).img, texture(round, whole, 2, tips).img).worst).toBe(0);
  });

  it('a turned box of tipped ink lands where the turned bitmap landed', () => {
    for (const scale of [1, 2]) {
      const box = boxOf({ rotation: 21, ink: ink({ brush: 'noise', size: 28, spacing: 20 }) });
      setGlyphPainter(whole);
      const p = pageOf(box);
      const a = renderBoxLayer(box, p.w, p.h, null, p, scale, tips);
      setGlyphPainter(canvasInk);
      const b = renderBoxLayer(box, p.w, p.h, null, p, scale, tips);
      setGlyphPainter(whole);
      for (const k of ['left', 'top', 'right', 'bottom']) expect(Math.abs(a[k] - b[k]), `${k} at ${scale}`).toBeLessThanOrEqual(3 * scale);
      const onPage = (l) => {
        const c = createCanvas(600 * scale, 400 * scale);
        c.getContext('2d').putImageData(l.imageData, l.left, l.top);
        return c.getContext('2d').getImageData(0, 0, 600 * scale, 400 * scale);
      };
      const d = against(onPage(a), onPage(b));
      if (MEASURE) console.log(`MEASURE tip turned | ${scale} | mean ${d.mean.toFixed(3)} worst ${d.worst.toFixed(1)} ink ${d.ink.toFixed(4)}`);
      if (scale === 2) {
        png('tip-turned.js.png', b.imageData);
        png('tip-turned.rust.png', a.imageData);
      }
      expect(d.ink, `ink at ${scale}`).toBeGreaterThan(0.97);
      expect(d.ink, `ink at ${scale}`).toBeLessThan(1.03);
      expect(d.mean, `mean at ${scale}`).toBeLessThan(13.5);
    }
  });

  it('puts a tip once, keeps it while its wrapper is the one put, and lets it go on forget', () => {
    forgetPainterTips();
    expect(inkTipBytes(rust.low)).toBe(0);
    const own = makeTips();
    const disc = own.get('disc');
    const box = boxOf({ ink: ink({ brush: 'disc', size: 26 }) }, '');
    const first = texture(box, whole, 2, own).img;
    expect(disc.rust).toBeTruthy();
    expect(inkTipBytes(rust.low)).toBeGreaterThan(128 * 128);
    // The wrapper's pixels drawn over: the engine still holds what was put,
    // and paints it, until the wrapper is no longer the one marked.
    const ctx = disc.image.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 128, 128);
    expect(against(texture(box, whole, 2, own).img, first).worst).toBe(0);
    disc.rust = undefined;
    expect(against(texture(box, whole, 2, own).img, first).worst).toBeGreaterThan(50);
    // The library letting go of its tips lets go of the engine's.
    forgetPainterTips();
    expect(inkTipBytes(rust.low)).toBe(0);
    expect(hasInkTip(rust.low, 'disc|128x128')).toBe(false);
    // And the next paint puts it again.
    texture(box, whole, 2, own);
    expect(hasInkTip(rust.low, 'disc|128x128')).toBe(true);
  });
});

describe("the engine's tips", () => {
  it('never take wasm memory past their ceiling, however many are put', () => {
    const CEILING = 64 * 1024 * 1024;
    forgetPainterTips();
    const memory = () => rust.low.exports.memory.buffer.byteLength;
    const side = 2048;
    const data = new Uint8Array(side * side).fill(200);
    const tip = { width: side, height: side, natural: [side, side], data };
    // A few in first, so the job buffer and the allocator have their size.
    for (let i = 0; i < 4; i++) expect(putInkTip(rust.low, `warm-${i}`, tip)).toBe(true);
    const before = memory();
    for (let i = 0; i < 60; i++) {
      // A box job between puts, as the page sends them (this one refused:
      // no bytes): each job's tips may go once it is painted.
      expect(putInkTip(rust.low, `many-${i}`, tip)).toBe(true);
      rust.low.exports.mt_paint_box(0);
      expect(inkTipBytes(rust.low)).toBeLessThanOrEqual(CEILING);
    }
    const grown = memory() - before;
    if (MEASURE) console.log(`MEASURE tip memory | before ${before} after ${memory()} grown ${grown} held ${inkTipBytes(rust.low)}`);
    // What the cache can hold past what the first four took: not sixty
    // tips' worth (336 MB).
    expect(grown).toBeLessThan(CEILING);
    forgetPainterTips();
    expect(inkTipBytes(rust.low)).toBe(0);
  });
});
