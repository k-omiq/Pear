import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { rustEngine, FIXTURE_FACES } from '../../test/rust-engine.js';
import { createRustGlyphPainter } from './rust-painter.js';
import { paintJob } from '../../../text-engine/js/paint.mjs';
import { createBrowserGlyphPainter } from './browser-painter.js';

// The painter makes its canvases, and text-paint.js its pattern tiles,
// from `document`; the engine lane has none, so it gets Skia's for this file.
const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
let made = 0;
let rust;
beforeAll(async () => {
  globalThis.document = {
    createElement() {
      made++;
      return createCanvas(300, 150);
    },
  };
  for (const [family, , file] of FIXTURE_FACES) {
    GlobalFonts.registerFromPath(fileURLToPath(new URL(`../../test/fonts/${file}`, import.meta.url)), family);
  }
  rust = await rustEngine();
});
afterAll(() => {
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});

const face = (name, size, bold = false) => ({
  key: `${bold ? 'bold ' : ''}${size}px "${name}"`, name, bold, italic: false, size, css: `"${name}"`,
});
const job = (over = {}) => ({
  face: face('Comic Neue', 40),
  curved: false,
  align: 'left',
  letterSpacing: 0,
  bands: [],
  silhouette: null,
  fill: { kind: 'solid', color: '#102030' },
  runs: [{ text: 'WAIT', x: 20, y: 60 }],
  ...over,
});

// Where a canvas has ink: the box of pixels with any alpha, and one pixel's colour.
function ink(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1, solid = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (a === 255 && !solid) solid = [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, solid };
}

function drawn(painter, j, { scale = 2, width = 400, height = 200, prepare } = {}) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  prepare?.(ctx);
  painter.paint(ctx, j);
  return { canvas, ctx };
}

describe('the Rust engine behind the glyph-painter seam', () => {
  it('puts the ink where the canvas painter puts it, through the canvas transform', () => {
    const a = ink(drawn(createBrowserGlyphPainter(), job()).canvas);
    const b = ink(drawn(createRustGlyphPainter(rust), job()).canvas);
    for (const k of ['x0', 'y0', 'x1', 'y1']) expect(Math.abs(a[k] - b[k]), k).toBeLessThanOrEqual(1);
    expect(b.solid).toEqual([0x10, 0x20, 0x30]);
    // Twice the scale, twice the box: the engine drew at the device scale, it was not stretched.
    const big = ink(drawn(createRustGlyphPainter(rust), job(), { scale: 4, width: 800, height: 400 }).canvas);
    expect(Math.abs(big.x1 - big.x0 - 2 * (b.x1 - b.x0))).toBeLessThanOrEqual(2);
  });

  it('leaves the canvas as it found it and draws nothing for a job without ink', () => {
    const painter = createRustGlyphPainter(rust);
    const { canvas, ctx } = drawn(painter, job({ runs: [{ text: '   ', x: 20, y: 60 }] }));
    expect(ink(canvas)).toBe(null);
    const { ctx: after } = drawn(painter, job(), { prepare: (c) => c.translate(7, 3) });
    const m = after.getTransform();
    expect([m.a, m.d, m.e, m.f]).toEqual([2, 2, 14, 6]);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("honours the canvas's own alpha and clip, as drawn text would", () => {
    const painter = createRustGlyphPainter(rust);
    const { canvas } = drawn(painter, job(), {
      prepare: (c) => {
        c.beginPath();
        c.rect(0, 0, 60, 100);
        c.clip();
        c.globalAlpha = 0.5;
      },
    });
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let most = 0, right = -1;
    for (let i = 3; i < data.length; i += 4) {
      if (!data[i]) continue;
      most = Math.max(most, data[i]);
      right = Math.max(right, ((i - 3) / 4) % canvas.width);
    }
    expect(most).toBeGreaterThan(120);
    expect(most).toBeLessThanOrEqual(128);
    expect(right).toBeLessThan(120);
    expect(right).toBeGreaterThan(100);
  });

  it('draws a pattern tile once for every line and job', () => {
    // The tile is the engine's own drawing; its export, counted.
    let tiles = 0;
    const tile = rust.low.exports.mt_paint_pattern_tile;
    const exports = { ...rust.low.exports, mt_paint_pattern_tile: (...a) => (tiles++, tile(...a)) };
    const counted = Object.create(rust, { low: { value: Object.create(rust.low, { exports: { value: exports } }) } });
    const painter = createRustGlyphPainter(counted);
    const style = { size: 40, color: '#000000', pattern: { kind: 'checker', fg: '#ff0000', bg: '#0000ff', scale: 1 } };
    const fill = { kind: 'pattern', style, px: 12, ax: 0, ay: 0 };
    const lines = job({ fill: null, runs: [{ text: 'WAIT', x: 20, y: 40, fill }, { text: 'WHAT', x: 20, y: 85, fill }] });
    made = 0;
    const first = drawn(painter, lines).canvas;
    drawn(painter, lines);
    // A canvas per raster (rust-painter-scratch.engine.test.js), and the
    // tile drawn once for both.
    expect(made).toBe(2);
    expect(tiles).toBe(1);
    const data = first.getContext('2d').getImageData(0, 0, first.width, first.height).data;
    let red = 0, blue = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] !== 255) continue;
      if (data[i] > 200 && data[i + 2] < 50) red++;
      if (data[i + 2] > 200 && data[i] < 50) blue++;
    }
    expect(red).toBeGreaterThan(200);
    expect(blue).toBeGreaterThan(200);
  });

  it('lands pixel for pixel on a canvas that smooths, with nothing of an earlier job beside it', () => {
    // The exporter's canvases set the smoothing quality to high. A wide job
    // with a band first, painted before: nothing of it may show beside the
    // narrow job's raster.
    const wide = job({ bands: [{ color: '#ffffff', opacity: 1, line: 6 }], runs: [{ text: 'WAIT WHAT', x: 20, y: 60 }] });
    // Black survives the canvas's premultiplied storage byte for byte,
    // even at the lowest edge alpha. Compare with the engine, at its origin.
    const narrow = job({ fill: { kind: 'solid', color: '#000000' }, runs: [{ text: 'WAIT', x: 20, y: 60 }] });
    const used = createRustGlyphPainter(rust);
    drawn(used, wide);
    const canvas = createCanvas(400, 200);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(2, 0, 0, 2, 14, 6);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const m = ctx.getTransform();
    const face = rust.handle(narrow.face);
    const raster = paintJob(rust.low, {
      job: narrow, font: face.font, size: face.size, synth: face.flags,
      transform: [m.a, m.b, m.c, m.d, m.e, m.f],
    });
    expect(raster).not.toBe(null);
    used.paint(ctx, narrow);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let inside = 0, outside = 0;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        const rx = x - raster.x, ry = y - raster.y;
        const inRaster = rx >= 0 && ry >= 0 && rx < raster.width && ry < raster.height;
        for (let c = 0; c < 4; c++) {
          const expected = inRaster ? raster.data[(ry * raster.width + rx) * 4 + c] : 0;
          if (pixels[i + c] !== expected) {
            if (inRaster) inside++;
            else outside++;
          }
        }
      }
    }
    expect(inside, 'canvas differs from engine raster at x,y').toBe(0);
    expect(outside, 'pixels outside the engine raster are empty').toBe(0);
    expect(ctx.imageSmoothingEnabled).toBe(true);
    expect(ctx.imageSmoothingQuality).toBe('high');
  });

  it('draws a synthesised bold the way the engine measured it', () => {
    const bold = job({ face: face('Bangers', 40, true), runs: [{ text: 'IIII', x: 20, y: 60 }] });
    const width = (c) => {
      const b = ink(c);
      return b.x1 - b.x0;
    };
    // WebKit's rule is the default: the smear, on advances a step wider.
    const smear = width(drawn(createRustGlyphPainter(rust), bold).canvas);
    const forced = width(drawn(createRustGlyphPainter(rust, { boldDraw: 'outset' }), bold).canvas);
    expect(forced).not.toBe(smear);
    rust.setRules({ boldAdvance: 'unchanged' });
    try {
      const outset = width(drawn(createRustGlyphPainter(rust), bold).canvas);
      // Three more advances of 40/36 px, at 2x, whichever way the bold is drawn.
      expect(smear - outset).toBeGreaterThanOrEqual(5);
      expect(smear - outset).toBeLessThanOrEqual(8);
    } finally {
      rust.setRules({ boldAdvance: 'webkit' });
    }
  });

  it('measures the ink of a synthesised bold for the drawing the rule gives it', () => {
    const bold = job({ face: face('Bangers', 40, true), align: 'left', runs: [{ text: 'IIII', x: 20, y: 60 }] });
    for (const boldAdvance of ['unchanged', 'webkit']) {
      rust.setRules({ boldAdvance });
      try {
        const m = rust.lineInk(bold.face, 'IIII');
        const b = ink(drawn(createRustGlyphPainter(rust), bold).canvas);
        // At 2x: the painted box is the measured one, to a device pixel.
        expect(Math.abs(b.x0 - 2 * (20 - m.left)), `${boldAdvance} left`).toBeLessThanOrEqual(1);
        expect(Math.abs(b.x1 + 1 - 2 * (20 + m.right)), `${boldAdvance} right`).toBeLessThanOrEqual(1);
        expect(Math.abs(b.y0 - 2 * (60 - m.ascent)), `${boldAdvance} top`).toBeLessThanOrEqual(1);
        expect(Math.abs(b.y1 + 1 - 2 * (60 + m.descent)), `${boldAdvance} bottom`).toBeLessThanOrEqual(1);
      } finally {
        rust.setRules({ boldAdvance: 'webkit' });
      }
    }
  });

  it('paints heavier by the weight it is made with, and not at all heavier without one', () => {
    const plain = ink(drawn(createRustGlyphPainter(rust), job()).canvas);
    const zero = ink(drawn(createRustGlyphPainter(rust, { weight: 0 }), job()).canvas);
    const heavy = ink(drawn(createRustGlyphPainter(rust, { weight: 2 }), job()).canvas);
    expect(zero).toEqual(plain);
    // Two device pixels on every side.
    expect([plain.x0 - heavy.x0, plain.y0 - heavy.y0, heavy.x1 - plain.x1, heavy.y1 - plain.y1]).toEqual([2, 2, 2, 2]);
  });

  it('is refused a job buffer no job could need, and paints the next job', () => {
    expect(rust.low.exports.mt_paint_job_reserve(0xffffffff)).toBe(0);
    expect(ink(drawn(createRustGlyphPainter(rust), job()).canvas)).not.toBe(null);
  });

  it('reports the painter run limit and paints the next job', () => {
    const painter = createRustGlyphPainter(rust);
    const tooLong = job({ runs: [{ text: 'I'.repeat(262_145), x: 20, y: 60 }] });
    expect(() => drawn(painter, tooLong)).toThrow(/over the painter's memory or run limit/);
    expect(ink(drawn(painter, job()).canvas)).not.toBe(null);
  });

  it('refuses a job whose font the engine does not have', () => {
    expect(() => drawn(createRustGlyphPainter(rust), job({ face: face('Nobody Sans', 40) }))).toThrow(/not registered/);
  });

  it('paints the glows, an inner shadow and a colour overlay a style asks for', () => {
    const painter = createRustGlyphPainter(rust);
    const box = (effects) => {
      const canvas = createCanvas(400, 200);
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      painter.paintBox(ctx, { job: job(), rect: { x: 0, y: 0, w: 200, h: 100 }, shadows: [], blur: 0, taps: [], clip: null, effects });
      return ink(canvas);
    };
    const plain = box([]);
    // An outer glow reaches past the letters; an overlay recolours them.
    const glow = box([{ kind: 'outerGlow', color: '#ff0000', opacity: 1, blend: 'normal', technique: 'softer', size: 6, spread: 0.5, range: 0.5, noise: 0 }]);
    expect(glow.x0).toBeLessThan(plain.x0 - 4);
    const blue = box([{ kind: 'colorOverlay', color: '#0000ff', opacity: 1, blend: 'normal' }]);
    expect([blue.x0, blue.y0, blue.x1, blue.y1]).toEqual([plain.x0, plain.y0, plain.x1, plain.y1]);
    expect(blue.solid).toEqual([0, 0, 255]);
    // The interior effects stay inside the letters.
    const inner = box([
      { kind: 'innerShadow', color: '#000000', opacity: 0.75, blend: 'multiply', x: 2, y: 2, size: 2, choke: 0, noise: 0 },
      { kind: 'innerGlow', color: '#ffffbe', opacity: 0.75, blend: 'screen', technique: 'precise', size: 3, choke: 0, range: 0.5, noise: 0, source: 'center' },
    ]);
    expect([inner.x0, inner.y0, inner.x1, inner.y1]).toEqual([plain.x0, plain.y0, plain.x1, plain.y1]);
  });

  it('paints the Photoshop strokes, a gradient overlay, a pattern overlay and a gradient glow', () => {
    const painter = createRustGlyphPainter(rust);
    const box = (effects) => {
      const canvas = createCanvas(400, 200);
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      painter.paintBox(ctx, { job: job(), rect: { x: 0, y: 0, w: 200, h: 100 }, shadows: [], blur: 0, taps: [], clip: null, effects });
      return ink(canvas);
    };
    const plain = box([]);
    const g = { style: 'linear', angle: 0, scale: 1, reverse: false, offset: [0, 0], stops: [{ color: '#00ff00', pos: 0, opacity: 1 }, { color: '#00ff00', pos: 1, opacity: 1 }] };
    // An outside stroke reaches past the letters by its size; an inside one does not.
    const out = box([{ kind: 'stroke', size: 4, position: 'outside', opacity: 1, blend: 'normal', paint: { kind: 'color', color: '#ff0000' } }]);
    expect(out.x0).toBeLessThanOrEqual(plain.x0 - 6);
    const inside = box([{ kind: 'stroke', size: 2, position: 'inside', opacity: 1, blend: 'normal', paint: { kind: 'gradient', gradient: g } }]);
    expect([inside.x0, inside.y0, inside.x1, inside.y1]).toEqual([plain.x0, plain.y0, plain.x1, plain.y1]);
    // A gradient overlay of one colour recolours the letters with it.
    const green = box([{ kind: 'gradientOverlay', opacity: 1, blend: 'normal', gradient: g }]);
    expect(green.solid).toEqual([0, 255, 0]);
    // A pattern overlay takes a glyph job's fill record.
    const solid = box([{ kind: 'patternOverlay', opacity: 1, blend: 'normal', fill: { kind: 'solid', color: '#0000ff' } }]);
    expect(solid.solid).toEqual([0, 0, 255]);
    // A glow with a gradient paints as one with a colour reaches.
    const glow = box([{ kind: 'outerGlow', color: '#ff0000', gradient: g, opacity: 1, blend: 'normal', technique: 'softer', size: 6, spread: 0.5, range: 0.5, noise: 0 }]);
    expect(glow.x0).toBeLessThan(plain.x0 - 4);
  });

  it('scatters a gradient glow by its Jitter and leaves a colour glow alone', () => {
    const painter = createRustGlyphPainter(rust);
    const pixels = (effects) => {
      const canvas = createCanvas(400, 200);
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      painter.paintBox(ctx, { job: job(), rect: { x: 0, y: 0, w: 200, h: 100 }, shadows: [], blur: 0, taps: [], clip: null, effects });
      return ctx.getImageData(0, 0, 400, 200).data;
    };
    const ramp = { style: 'linear', angle: 0, scale: 1, reverse: false, offset: [0, 0], stops: [{ color: '#ff0000', pos: 0, opacity: 1 }, { color: '#0000ff', pos: 1, opacity: 1 }] };
    const glow = (over) => ({ kind: 'outerGlow', color: '#ff0000', opacity: 1, blend: 'normal', technique: 'precise', size: 8, spread: 0, range: 1, noise: 0, ...over });
    const same = (a, b) => a.every((v, i) => v === b[i]);
    expect(same(pixels([glow({ jitter: 0 })]), pixels([glow({ jitter: 0.6 })]))).toBe(true);
    const calm = pixels([glow({ gradient: ramp, jitter: 0 })]);
    const rough = pixels([glow({ gradient: ramp, jitter: 0.6 })]);
    expect(same(calm, rough)).toBe(false);
    // The glow's coverage is the same; only its colours move.
    let alpha = 0;
    for (let i = 3; i < calm.length; i += 4) alpha = Math.max(alpha, Math.abs(calm[i] - rough[i]));
    expect(alpha).toBeLessThanOrEqual(1);
  });

  it('paints a satin inside the letters, along its own angle', () => {
    const painter = createRustGlyphPainter(rust);
    const box = (effects) => {
      const canvas = createCanvas(400, 200);
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      painter.paintBox(ctx, { job: job(), rect: { x: 0, y: 0, w: 200, h: 100 }, shadows: [], blur: 0, taps: [], clip: null, effects });
      return ink(canvas);
    };
    const plain = box([]);
    const satin = { kind: 'satin', color: '#ff0000', opacity: 1, blend: 'normal', angle: 90, distance: 2, size: 0, contour: { preset: 'linear' }, invert: false };
    // Thrown up and down: the letters' top edge (the first solid pixel) is red.
    const red = box([satin]);
    expect([red.x0, red.y0, red.x1, red.y1]).toEqual([plain.x0, plain.y0, plain.x1, plain.y1]);
    expect(red.solid).toEqual([255, 0, 0]);
    // Inverted, the edge keeps the letters' own black.
    expect(box([{ ...satin, invert: true }]).solid).toEqual(plain.solid);
  });

  it('paints a bevel: an inner one inside the letters, an outer one round them', () => {
    const painter = createRustGlyphPainter(rust);
    const box = (effects) => {
      const canvas = createCanvas(400, 200);
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      painter.paintBox(ctx, { job: job(), rect: { x: 0, y: 0, w: 200, h: 100 }, shadows: [], blur: 0, taps: [], clip: null, effects });
      return ink(canvas);
    };
    const plain = box([]);
    // Lit from the top in plain white: the letters' top edge (the first solid
    // pixel) takes the highlight, and nothing leaves the letters.
    const bevel = { kind: 'bevel', style: 'inner', technique: 'chisel-hard', size: 3, angle: 90, altitude: 30, highlight: { blend: 'normal', color: '#ffffff', opacity: 1 }, shadow: { blend: 'normal', color: '#0000ff', opacity: 1 } };
    const inner = box([bevel]);
    expect([inner.x0, inner.y0, inner.x1, inner.y1]).toEqual([plain.x0, plain.y0, plain.x1, plain.y1]);
    expect(inner.solid[1]).toBeGreaterThan(100);
    // An outer bevel reaches past the letters: lit above them, in shadow
    // below (their sides face across the light and take little of either).
    const outer = box([{ ...bevel, style: 'outer' }]);
    expect(outer.y0).toBeLessThan(plain.y0 - 2);
    expect(outer.y1).toBeGreaterThan(plain.y1 + 2);
  });

  it('paints a noise gradient the colours the native build bakes, and a Shape Burst', () => {
    const painter = createRustGlyphPainter(rust);
    const box = (effects) => {
      const canvas = createCanvas(400, 200);
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      painter.paintBox(ctx, { job: job(), rect: { x: 0, y: 0, w: 200, h: 100 }, shadows: [], blur: 0, taps: [], clip: null, effects });
      return ink(canvas);
    };
    // A short ramp moved a whole frame off: every letter pixel reads its
    // first colour (offset +1) or its last (offset -1). The colours are the
    // ones `the_ends_match_what_the_wasm_engine_paints` pins natively
    // (text-engine/src/paint/fx/noise_gradient.rs), so the two builds agree.
    const noise = (model, restrict, end) => ({
      style: 'linear', angle: 0, scale: 0.1, reverse: false, offset: [end ? -1 : 1, 0],
      stops: [{ color: '#000000', pos: 0, opacity: 1 }, { color: '#ffffff', pos: 1, opacity: 1 }],
      type: 'noise', noise: { seed: 7, roughness: 0.5, model, min: [0, 0, 0], max: [1, 1, 1], restrict, transparency: false },
    });
    const at = (model, restrict, end) => box([{ kind: 'gradientOverlay', opacity: 1, blend: 'normal', gradient: noise(model, restrict, end) }]).solid;
    expect(at('rgb', false, false)).toEqual([6, 198, 142]);
    expect(at('rgb', false, true)).toEqual([89, 84, 44]);
    expect(at('lab', true, false)).toEqual([79, 0, 0]);
    expect(at('lab', true, true)).toEqual([8, 104, 212]);
    // Shape Burst: black at the letters' edge, so the burst darkens a white
    // overlay's edge and leaves the letters' extent alone.
    const plain = box([]);
    const burst = box([{ kind: 'gradientOverlay', opacity: 1, blend: 'normal', gradient: { ...noise('rgb', false, false), type: 'solid', style: 'shapeburst' } }]);
    expect([burst.x0, burst.y0, burst.x1, burst.y1]).toEqual([plain.x0, plain.y0, plain.x1, plain.y1]);
  });

  // F59: mid-ramp, where the walk's easing and the HSB and Lab conversions
  // show, the wasm build paints the colours `mid_ramp_samples_are_pinned`
  // pins natively (text-engine/src/paint/fx/noise_gradient_gaps.rs), so the
  // two builds are the same between the ends too. An Angle gradient reads
  // t = 0.25 straight below its centre, 0.5 straight left of it and 0.75
  // straight above (Gradient::t in fx/gradient.rs), so a centre moved (by the
  // offset) to 30 device px off one solid letter pixel paints it that sample.
  it('paints a noise gradient mid-ramp the colours the native build pins', () => {
    const painter = createRustGlyphPainter(rust);
    const paint = (effects) => {
      const canvas = createCanvas(400, 200);
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      painter.paintBox(ctx, { job: job(), rect: { x: 0, y: 0, w: 200, h: 100 }, shadows: [], blur: 0, taps: [], clip: null, effects });
      return ctx.getImageData(0, 0, 400, 200).data;
    };
    // The overlay's frame is the letters' covered pixels (`job_frame` in
    // fx/effects.rs: coverage over half a level), device px here.
    const plain = paint([]);
    let [f0, f1, f2, f3] = [400, 200, -1, -1];
    let solid = null;
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 400; x++) {
        const a = plain[(y * 400 + x) * 4 + 3];
        if (!a) continue;
        [f0, f1, f2, f3] = [Math.min(f0, x), Math.min(f1, y), Math.max(f2, x + 1), Math.max(f3, y + 1)];
        if (a === 255 && !solid && x > 40 && y > 40) solid = [x, y];
      }
    }
    expect(solid).not.toBe(null);
    const [sx, sy] = solid;
    const [w, h] = [f2 - f0, f3 - f1];
    // The offset that puts the centre at device point (cx, cy): the centre is
    // the frame's middle moved by a share of its size.
    const offset = (cx, cy) => [(cx - f0 - w / 2) / w, (cy - f1 - h / 2) / h];
    const centres = [[sx + 0.5, sy + 0.5 - 30], [sx + 0.5 + 30, sy + 0.5], [sx + 0.5, sy + 0.5 + 30]];
    const at = (noise) => centres.map(([cx, cy]) => {
      const g = {
        style: 'angle', angle: 0, scale: 1, reverse: false, offset: offset(cx, cy),
        stops: [{ color: '#000000', pos: 0, opacity: 1 }, { color: '#ffffff', pos: 1, opacity: 1 }],
        type: 'noise', noise: { seed: 7, roughness: 0.5, min: [0, 0, 0], max: [1, 1, 1], restrict: false, transparency: false, ...noise },
      };
      const px = paint([{ kind: 'gradientOverlay', opacity: 1, blend: 'normal', gradient: g }]);
      const i = (sy * 400 + sx) * 4;
      return [...px.subarray(i, i + 4)];
    });
    expect(at({ model: 'rgb' })).toEqual([[60, 47, 188, 255], [68, 167, 169, 255], [75, 198, 208, 255]]);
    expect(at({ model: 'lab', restrict: true })).toEqual([[0, 75, 0, 255], [119, 29, 0, 255], [163, 0, 0, 255]]);
    expect(at({ model: 'hsb' })).toEqual([[173, 188, 153, 255], [169, 120, 59, 255], [47, 83, 208, 255]]);
    expect(at({ model: 'hsb', min: [0, 0.5, 0.5], max: [1, 1, 1] })).toEqual([[166, 222, 90, 255], [212, 134, 37, 255], [26, 72, 232, 255]]);
  });

  it('paints a box with as many shadows as its style has', () => {
    // The app counts no shadows, and the canvas passes paint every one: the
    // box job once refused a 17th, and the box was not painted at all.
    const painter = createRustGlyphPainter(rust);
    expect(painter.box).toBe(true);
    const box = (n) => {
      const canvas = createCanvas(400, 200);
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      const shadows = Array.from({ length: n }, (_, i) => ({ x: 2 + (i % 4), y: 2, blur: 1, color: '#ff0000', opacity: 0.5 }));
      painter.paintBox(ctx, { job: job(), rect: { x: 0, y: 0, w: 200, h: 100 }, shadows, blur: 0, taps: [], clip: null });
      return ink(canvas);
    };
    const one = box(1);
    for (const n of [16, 17, 40]) {
      const got = box(n);
      expect(got, `${n}`).not.toBe(null);
      // The glyphs on top, the shadows thrown under them to the right.
      expect(got.x1, `${n}`).toBeGreaterThanOrEqual(one.x1);
    }
  });
  // Box wire v15: the painter tells the engine where the surface's corner is
  // on the page (`grainOrigin`), so a shadow's Noise and a glow's Dissolve
  // stay on the page pixels they fell on when the layout takes more room
  // round the box (its footprint's corner further from the letters).
  it('keeps the grain on the page when the layout round the box takes more room', () => {
    const painter = createRustGlyphPainter(rust);
    const shadows = [{ color: '#2040ff', opacity: 1, x: 3, y: 2, size: 3, spread: 0.2, noise: 0.7, blend: 'normal', seed: 77 }];
    const effects = [{ kind: 'outerGlow', color: '#ff0000', opacity: 0.6, blend: 'dissolve', technique: 'softer', size: 5, spread: 0, range: 0.5, noise: 0.4, seed: 9 }];
    // `room` page px more on the left and top: the letters stand that much
    // further into the job, and the job's corner that much further up the page.
    const box = (room, toPage) => {
      const canvas = createCanvas(500, 300);
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      const j = job({ runs: [{ text: 'WAIT', x: 20 + room[0], y: 60 + room[1] }] });
      painter.paintBox(ctx, { job: j, rect: { x: 0, y: 0, w: 220 + room[0], h: 120 + room[1] }, shadows, blur: 0, taps: [], clip: null, effects, toPage });
      return canvas.getContext('2d').getImageData(0, 0, 500, 300).data;
    };
    const tight = box([0, 0], [1, 0, 0, 1, 100, 50]);
    const roomy = box([10, 6], [1, 0, 0, 1, 90, 44]);
    const off = (other) => {
      let n = 0;
      for (let y = 0; y < 240; y++) {
        for (let x = 0; x < 440; x++) {
          for (let c = 0; c < 4; c++) if (tight[(y * 500 + x) * 4 + c] !== other[((y + 12) * 500 + x + 20) * 4 + c]) n++;
        }
      }
      return n;
    };
    expect(off(roomy)).toBe(0);
    // Anchored to the canvas's own corner instead, the grain moves.
    expect(off(box([10, 6], null))).toBeGreaterThan(500);
  });
});
