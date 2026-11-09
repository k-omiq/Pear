import { describe, expect, it } from 'vitest';
import { BLEND_MODE_IDS, CONTOUR_IDS, BOX_WIRE_VERSION, BEVEL_STYLE_IDS, BEVEL_TECHNIQUE_IDS, encodeBox } from '../../text-engine/js/paint.mjs';
import {
  LAYER_BLEND_MODES,
  CONTOUR_PRESETS,
  LIGHT_DEF,
  normalizeLight,
  normalizeShadow,
  normalizeContour,
  normalizeTypesetting,
  normalizeFxGradient,
  normalizeNoiseGradient,
  FX_GRADIENT_STYLES,
  NOISE_MODELS,
  newShadow,
  newTypesetting,
  normalizeSatin,
  normalizeBevel,
  normalizeGlow,
  normalizeStyle,
} from './data.js';
import { shadowSigma, shadowOffset, resolveShadow, setGlobalLight, boxEffects, bevelReach, reachShadows } from './text-paint.js';
import { rescaleStyle } from './store.svelte.js';

// ===========================================================================
// The layer style's data: what a shadow, a mode and the light are
// ===========================================================================

describe('the lists the style and the wire share', () => {
  // The engine reads a mode and a contour by number, in Photoshop's menu
  // order (fx/blend.rs, fx/contour.rs); the style names them.
  it('names every blend mode the wire numbers, in its order', () => {
    expect(LAYER_BLEND_MODES).toEqual(Object.keys(BLEND_MODE_IDS));
    expect(LAYER_BLEND_MODES.map((m) => BLEND_MODE_IDS[m])).toEqual(LAYER_BLEND_MODES.map((_, i) => i));
    expect(LAYER_BLEND_MODES).toHaveLength(27);
  });

  it('names every contour preset the wire numbers, in its order', () => {
    expect(CONTOUR_PRESETS).toEqual(Object.keys(CONTOUR_IDS));
    expect(CONTOUR_PRESETS.map((c) => CONTOUR_IDS[c])).toEqual(CONTOUR_PRESETS.map((_, i) => i));
  });

  it('refuses a mode the engine has no number for', () => {
    expect(() => encodeBox({ width: 4, height: 4, blend: 'glow' })).toThrow(/blend mode/);
    expect(() => encodeBox({ width: 4, height: 4, shadows: [{ ...normalizeShadow({}), blend: 'glow' }] })).toThrow(/blend mode/);
  });
});

describe('a shadow', () => {
  it('reads a blur saved before Size as the Size that blurs as much', () => {
    for (const blur of [1, 2, 3, 4, 5, 6, 10]) {
      expect(shadowSigma(normalizeShadow({ blur }).size)).toBeCloseTo(blur / 2, 1);
    }
    expect(normalizeShadow({ blur: 0 }).size).toBe(0);
    // A Size wins over a stale blur.
    expect(normalizeShadow({ blur: 9, size: 2 }).size).toBe(2);
  });

  it('keeps every field in range', () => {
    const s = normalizeShadow({ size: 900, spread: 3, noise: -1, blend: 'nope', contour: { preset: 'nope' }, knockout: 'yes' });
    expect(s).toMatchObject({ size: 250, spread: 1, noise: 0, blend: 'normal', contour: { preset: 'linear', aa: false }, knockout: false });
  });

  it('is added as Photoshop adds one: Multiply, 75%, thrown 5 from the light, knocked out', () => {
    const s = newShadow({ angle: 120 });
    expect(s).toMatchObject({ size: 5, opacity: 0.75, blend: 'multiply', knockout: true, useGlobalLight: true });
    expect(Math.hypot(s.x, s.y)).toBeCloseTo(5, 1);
    // From the upper left, so down and to the right.
    expect(s.x).toBeGreaterThan(0);
    expect(s.y).toBeGreaterThan(0);
  });

  it('is thrown away from the light, as far as its own x and y say', () => {
    expect(shadowOffset(0, 10)).toEqual({ x: -10, y: expect.closeTo(0, 9) });
    expect(shadowOffset(90, 10)).toEqual({ x: expect.closeTo(0, 9), y: 10 });
    setGlobalLight({ angle: 180, altitude: 30 });
    const lit = resolveShadow(normalizeShadow({ x: 0, y: 6, useGlobalLight: true }));
    expect(lit.x).toBeCloseTo(6, 9);
    expect(lit.y).toBeCloseTo(0, 9);
    const own = normalizeShadow({ x: 0, y: 6 });
    expect(resolveShadow(own)).toBe(own);
    setGlobalLight(LIGHT_DEF);
  });
});

describe('the chapter’s light', () => {
  it('wraps its angle and holds its altitude in 0 to 90', () => {
    expect(normalizeLight({ angle: 270, altitude: 120 })).toEqual({ angle: -90, altitude: 90 });
    expect(normalizeLight(null)).toEqual(LIGHT_DEF);
  });

  it('is written only when it is not Photoshop’s default', () => {
    expect(newTypesetting()).not.toHaveProperty('light');
    expect(normalizeTypesetting({ mode: 'smart', light: { ...LIGHT_DEF } })).not.toHaveProperty('light');
    expect(normalizeTypesetting({ mode: 'smart', light: { angle: 45, altitude: 30 } }).light).toEqual({ angle: 45, altitude: 30 });
  });
});

// ===========================================================================
// Noise gradients and Shape Burst (phase 3b)
// ===========================================================================

describe('an effect gradient of Gradient Type Noise', () => {
  it('starts as Photoshop\'s dialog: solid, with the noise settings at 50 %, RGB, full limits, Restrict on', () => {
    const g = normalizeFxGradient({});
    expect(g.type).toBe('solid');
    expect(g.noise).toEqual({ seed: 1, roughness: 0.5, model: 'rgb', min: [0, 0, 0], max: [1, 1, 1], restrict: true, transparency: false });
    expect(FX_GRADIENT_STYLES).toContain('shapeburst');
    expect(NOISE_MODELS).toEqual(['rgb', 'hsb', 'lab']);
  });

  it('keeps every noise field in range, a low limit never past its high', () => {
    const n = normalizeNoiseGradient({ seed: -1, roughness: 3, model: 'cmyk', min: [0.5, -1, 2], max: [0.2, 0.5], restrict: false, transparency: 'yes' });
    expect(n).toEqual({ seed: 4294967295, roughness: 1, model: 'rgb', min: [0.5, 0, 1], max: [0.5, 0.5, 1], restrict: false, transparency: false });
    expect(normalizeFxGradient({ type: 'noise', noise: { seed: 9.7 } })).toMatchObject({ type: 'noise', noise: { seed: 9 } });
    expect(normalizeFxGradient({ type: 'other' }).type).toBe('solid');
  });

  // Wire v6: the gradient record ends in its type, and a noise record after
  // it (`decode_box` in text-engine/src/paint/boxjob.rs).
  it('goes on the wire after the stops, and a solid one as a single 0', () => {
    const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
    const g = normalizeFxGradient({ style: 'shapeburst' });
    const fx = (gradient) => [{ kind: 'gradientOverlay', opacity: 1, blend: 'normal', gradient }];
    const job = { job: { bands: [], runs: [], fill: { kind: 'solid', color: '#000000' } }, font: 0, size: 10 };
    const solid = encodeBox({ ...job, width: 4, height: 4, effects: fx(g) }).slice();
    const noisy = encodeBox({ ...job, width: 4, height: 4, effects: fx({ ...g, type: 'noise', noise: { ...g.noise, seed: 42, model: 'lab', transparency: true } }) }).slice();
    expect(dv(solid).getUint32(4, true)).toBe(BOX_WIRE_VERSION);
    expect(BOX_WIRE_VERSION).toBe(15);
    // The noise record: seed, roughness, model, six limits, flags.
    expect(noisy.length - solid.length).toBe(4 + 8 + 4 + 6 * 8 + 4);
    // The gradient record starts after the box header (the grain's corner
    // in it since v15), the blending options
    // and the effect's kind, opacity and blend: its style is Shape Burst.
    const head = 4 * 4 + 2 * 4 + 4 + 8 + 4 + 4 + 4 + 8 + 4 + 4 + 4 + 4;
    expect(dv(solid).getUint32(head + 4 + 8 + 4 + 4, true)).toBe(5);
    // v14: the two midpoint counts, Dither, the Method and Smoothness come
    // between the stops and the type.
    const typeAt = head + 4 + 8 + 4 + 4 + 4 + 8 + 8 + 4 + 8 + 8 + 4 + 2 * 12 + 4 + 4 + 4 + 4 + 4 + 8;
    expect(dv(solid).getUint32(typeAt, true)).toBe(0);
    expect(dv(noisy).getUint32(typeAt, true)).toBe(1);
    expect(dv(noisy).getUint32(typeAt + 4, true)).toBe(42);
    expect(dv(noisy).getUint32(typeAt + 16, true)).toBe(2);
    expect(dv(noisy).getUint32(typeAt + 20 + 48, true)).toBe(3);
  });
});

describe('a shadow on the wire', () => {
  it('says an SFX copy is exact (flag 4, v11); a Photoshop shadow is rounded by the engine', () => {
    const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
    const job = { job: { bands: [], runs: [], fill: { kind: 'solid', color: '#000000' } }, font: 0, size: 10 };
    const sh = { color: '#000000', opacity: 1, x: 2.4, y: 1.5, size: 0, knockout: true };
    // Magic, version, size, the grain's corner (v15), the count, then colour,
    // seven numbers and the mode.
    const flagsAt = 4 * 4 + 2 * 4 + 4 + 4 + 7 * 8 + 4;
    const flags = (s) => dv(encodeBox({ ...job, width: 4, height: 4, shadows: [s] }).slice()).getUint32(flagsAt, true);
    expect(flags(sh)).toBe(1);
    expect(flags({ ...sh, exact: true })).toBe(5);
  });
});

describe('a glow\'s Jitter', () => {
  it('starts at 0 and stays in 0 to 1, on both glows', () => {
    expect(normalizeGlow({}).jitter).toBe(0);
    expect(normalizeGlow({}, true).jitter).toBe(0);
    expect(normalizeGlow({ jitter: 0.6 }).jitter).toBe(0.6);
    expect(normalizeGlow({ jitter: 7 }, true).jitter).toBe(1);
    expect(normalizeGlow({ jitter: -1 }).jitter).toBe(0);
    expect(normalizeGlow({ jitter: 'x' }).jitter).toBe(0);
  });

  it('is sent with each glow and goes on the wire after its gradient (v11)', () => {
    const style = normalizeStyle({ outerGlow: { on: true, fill: 'gradient', jitter: 0.6 }, innerGlow: { on: true, jitter: 0.25 } });
    const fx = boxEffects(style);
    expect(fx.find((e) => e.kind === 'outerGlow').jitter).toBe(0.6);
    expect(fx.find((e) => e.kind === 'innerGlow').jitter).toBe(0.25);
    const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
    const job = { job: { bands: [], runs: [], fill: { kind: 'solid', color: '#000000' } }, font: 0, size: 10 };
    const glow = { kind: 'outerGlow', color: '#ffffbe', opacity: 0.75, blend: 'screen', technique: 'softer', size: 5, spread: 0, range: 0.5, noise: 0, jitter: 0.6 };
    const b = dv(encodeBox({ ...job, width: 4, height: 4, effects: [glow] }).slice());
    const head = 4 * 4 + 2 * 4 + 4 + 8 + 4 + 4 + 4 + 8 + 4 + 4 + 4 + 4;
    expect(b.getUint32(head, true)).toBe(1);
    // Past the colour, opacity, mode, technique, four numbers, seed, contour
    // and the gradient flag (0: its colour).
    expect(b.getUint32(head + 64, true)).toBe(0);
    expect(b.getFloat64(head + 68, true)).toBe(0.6);
    const none = dv(encodeBox({ ...job, width: 4, height: 4, effects: [{ ...glow, jitter: undefined }] }).slice());
    expect(none.getFloat64(head + 68, true)).toBe(0);
  });
});

describe('a satin', () => {
  it('starts as Photoshop adds one, and keeps every field in range', () => {
    expect(normalizeSatin(undefined)).toEqual({ on: false, blend: 'multiply', color: '#000000', opacity: 0.5, angle: 19, distance: 11, size: 14, contour: { preset: 'linear', aa: true }, invert: true });
    const s = normalizeSatin({ on: true, blend: 'glow', color: 'red', opacity: 2, angle: 200, distance: -3, size: 900, contour: { preset: 'cone' }, invert: false });
    expect(s).toEqual({ on: true, blend: 'multiply', color: '#000000', opacity: 1, angle: -160, distance: 0, size: 250, contour: { preset: 'cone', aa: false }, invert: false });
    expect(normalizeSatin({ distance: 400 }).distance).toBe(250);
    // A saved style keeps it.
    expect(normalizeStyle({ satin: { on: true, angle: 45 } }).satin).toMatchObject({ on: true, angle: 45, invert: true });
  });

  it('is painted by its own angle, never the chapter light, and only when on', () => {
    setGlobalLight({ angle: 90 });
    const satin = normalizeSatin({ on: true, angle: 30 });
    expect(boxEffects({ satin })).toEqual([{ kind: 'satin', color: '#000000', opacity: 0.5, blend: 'multiply', angle: 30, distance: 11, size: 14, contour: { preset: 'linear', aa: true }, invert: true }]);
    expect(boxEffects({ satin: { ...satin, on: false } })).toEqual([]);
    expect(boxEffects({ satin: { ...satin, opacity: 0 } })).toEqual([]);
    setGlobalLight({ angle: 120 });
  });

  it('rescales its Distance and Size with the page, not its angle', () => {
    const out = rescaleStyle({ satin: normalizeSatin({ on: true, angle: 30, distance: 10, size: 4 }) }, 2, 2);
    expect(out.satin).toMatchObject({ angle: 30, distance: 20, size: 8 });
  });

  // Wire v7: kind 8, then colour, opacity, mode, angle, distance, size,
  // flags (1 invert, 2 anti-aliased) and the contour (`decode_box`).
  it('goes on the wire as kind 8', () => {
    const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
    const job = { job: { bands: [], runs: [], fill: { kind: 'solid', color: '#000000' } }, font: 0, size: 10 };
    const fx = { kind: 'satin', color: '#ff0000', opacity: 0.5, blend: 'multiply', angle: 19, distance: 11, size: 14, contour: { preset: 'gaussian', aa: true }, invert: true };
    const b = dv(encodeBox({ ...job, width: 4, height: 4, effects: [fx] }).slice());
    const head = 4 * 4 + 2 * 4 + 4 + 8 + 4 + 4 + 4 + 8 + 4 + 4 + 4 + 4;
    expect(b.getUint32(head, true)).toBe(8);
    expect([0, 1, 2, 3].map((k) => b.getUint8(head + 4 + k))).toEqual([255, 0, 0, 255]);
    expect(b.getFloat64(head + 8, true)).toBe(0.5);
    expect(b.getUint32(head + 16, true)).toBe(BLEND_MODE_IDS.multiply);
    expect([b.getFloat64(head + 20, true), b.getFloat64(head + 28, true), b.getFloat64(head + 36, true)]).toEqual([19, 11, 14]);
    expect(b.getUint32(head + 44, true)).toBe(3);
    expect(b.getUint32(head + 48, true)).toBe(CONTOUR_IDS.gaussian);
    const plain = dv(encodeBox({ ...job, width: 4, height: 4, effects: [{ ...fx, invert: false, contour: { preset: 'linear' } }] }).slice());
    expect(plain.getUint32(head + 44, true)).toBe(0);
  });
});

describe('a bevel', () => {
  const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const job = { job: { bands: [], runs: [], fill: { kind: 'solid', color: '#000000' } }, font: 0, size: 10 };
  const head = 4 * 4 + 2 * 4 + 4 + 8 + 4 + 4 + 4 + 8 + 4 + 4 + 4 + 4;
  const encoded = (fx) => dv(encodeBox({ ...job, width: 4, height: 4, effects: [fx] }).slice());

  // Wire v8: kind 9, then style, technique, depth, size, soften, angle,
  // altitude, the highlight and the shadow, flags, the gloss contour, then
  // the Contour and the Texture when they are on (`decode_box`).
  it('goes on the wire as kind 9, with Photoshop\'s defaults for what it leaves out', () => {
    const b = encoded({ kind: 'bevel' });
    expect(b.getUint32(head, true)).toBe(9);
    expect([b.getUint32(head + 4, true), b.getUint32(head + 8, true)]).toEqual([BEVEL_STYLE_IDS.inner, BEVEL_TECHNIQUE_IDS.smooth]);
    expect([12, 20, 28, 36, 44].map((o) => b.getFloat64(head + o, true))).toEqual([1, 5, 0, 120, 30]);
    expect([0, 1, 2, 3].map((k) => b.getUint8(head + 52 + k))).toEqual([255, 255, 255, 255]);
    expect(b.getFloat64(head + 56, true)).toBe(0.75);
    expect(b.getUint32(head + 64, true)).toBe(BLEND_MODE_IDS.screen);
    expect([0, 1, 2, 3].map((k) => b.getUint8(head + 68 + k))).toEqual([0, 0, 0, 255]);
    expect(b.getUint32(head + 80, true)).toBe(BLEND_MODE_IDS.multiply);
    // Up, and nothing else on.
    expect(b.getUint32(head + 84, true)).toBe(1);
    expect(b.getUint32(head + 88, true)).toBe(CONTOUR_IDS.linear);
    // Then the backdrop flag.
    expect(b.getUint32(head + 92, true)).toBe(0);
  });

  it('writes every field it is given, the Contour with its Range and the Texture with its fill', () => {
    const b = encoded({
      kind: 'bevel', style: 'pillow', technique: 'chisel-soft', depth: 1.5, direction: 'down', size: 6, soften: 2, angle: 45, altitude: 60,
      gloss: { preset: 'gaussian', aa: true },
      highlight: { blend: 'normal', color: '#ffff00', opacity: 0.5 }, shadow: { blend: 'overlay', color: '#0000ff', opacity: 0.25 },
      contour: { preset: 'cone', aa: true, range: 0.7 },
      texture: { depth: -2, invert: true, fill: { kind: 'solid', color: '#0000ff' } },
    });
    expect([b.getUint32(head + 4, true), b.getUint32(head + 8, true)]).toEqual([3, 2]);
    expect([12, 20, 28, 36, 44].map((o) => b.getFloat64(head + o, true))).toEqual([1.5, 6, 2, 45, 60]);
    expect(b.getUint32(head + 64, true)).toBe(BLEND_MODE_IDS.normal);
    expect(b.getFloat64(head + 72, true)).toBe(0.25);
    expect(b.getUint32(head + 80, true)).toBe(BLEND_MODE_IDS.overlay);
    // Down; gloss and contour anti-aliased, contour on, texture on and inverted.
    expect(b.getUint32(head + 84, true)).toBe(2 | 4 | 8 | 16 | 32);
    expect(b.getUint32(head + 88, true)).toBe(CONTOUR_IDS.gaussian);
    expect(b.getUint32(head + 92, true)).toBe(CONTOUR_IDS.cone);
    expect(b.getFloat64(head + 96, true)).toBe(0.7);
    expect(b.getFloat64(head + 104, true)).toBe(-2);
    // A paint record that is a fill: a solid one.
    expect([b.getUint32(head + 112, true), b.getUint32(head + 116, true)]).toEqual([2, 1]);
    // A texture with no fill yet (a pattern the exporter has not made one of) is off.
    expect(encoded({ kind: 'bevel', texture: { depth: 1, invert: true, pattern: {} } }).getUint32(head + 84, true)).toBe(1);
  });

  it('refuses a style or a technique the engine has no number for', () => {
    expect(() => encoded({ kind: 'bevel', style: 'chrome' })).toThrow(/bevel style/);
    expect(() => encoded({ kind: 'bevel', technique: 'rough' })).toThrow(/bevel technique/);
  });

  // `bevel::outward` in text-engine/src/paint/fx/bevel.rs, in job units.
  it('reaches past the letters as the engine paints it', () => {
    expect(bevelReach({ kind: 'bevel', style: 'inner', size: 40 })).toBe(0);
    expect(bevelReach({ kind: 'bevel', style: 'stroke', size: 40 })).toBe(0);
    expect(bevelReach({ kind: 'bevel', style: 'outer', size: 10, soften: 3 })).toBe(17);
    expect(bevelReach({ kind: 'bevel', style: 'outer', size: 0 })).toBe(5);
    expect(bevelReach({ kind: 'bevel', style: 'emboss', size: 9, soften: 0.5 })).toBe(9);
    expect(bevelReach({ kind: 'bevel', style: 'pillow', technique: 'chisel-soft', size: 20 })).toBe(10 + 6 + 4);
  });
});

describe('a bevel in the style', () => {
  const lit = { blend: 'screen', color: '#ffffff', opacity: 0.75 };
  const dark = { blend: 'multiply', color: '#000000', opacity: 0.75 };

  it('starts as Photoshop adds one, switched off, and keeps every field in range', () => {
    const d = normalizeBevel(undefined);
    expect(d).toMatchObject({
      on: false, style: 'inner', technique: 'smooth', depth: 1, direction: 'up', size: 5, soften: 0,
      useGlobalLight: true, angle: 120, altitude: 30, gloss: { preset: 'linear', aa: false }, highlight: lit, shadow: dark,
      contour: { on: false, curve: { preset: 'linear', aa: false }, range: 0.5 },
    });
    expect(d.texture).toMatchObject({ on: false, scale: 1, depth: 1, invert: false, link: true });
    expect(d.texture.pattern.on).toBe(true);
    // A style saved before the bevel existed has the default one.
    expect(normalizeStyle({}).bevel).toEqual(d);
    const s = normalizeBevel({
      on: true, style: 'bevel', technique: 'chisel', depth: 40, direction: 'left', size: 900, soften: 20,
      useGlobalLight: 'yes', angle: 200, altitude: 120,
      gloss: { preset: 'cone' }, highlight: { blend: 'glow', color: 'red', opacity: 3 }, shadow: { opacity: -1 },
      contour: { on: true, curve: { preset: 'gaussian', aa: true }, range: 4 },
      texture: { on: true, pattern: { kind: 'stripes' }, scale: 50, depth: -30, invert: true, link: false },
    });
    expect(s).toMatchObject({
      on: true, style: 'inner', technique: 'smooth', depth: 10, direction: 'up', size: 250, soften: 16,
      useGlobalLight: true, angle: -160, altitude: 90, gloss: { preset: 'cone', aa: false },
      highlight: { ...lit, opacity: 1 }, shadow: { ...dark, opacity: 0 },
      contour: { on: true, curve: { preset: 'gaussian', aa: true }, range: 1 },
      texture: { on: true, scale: 10, depth: -10, invert: true, link: false },
    });
    expect(s.texture.pattern).toMatchObject({ kind: 'stripes', on: true });
    expect(normalizeBevel({ depth: -1, size: -4, soften: -1, altitude: -5, texture: { scale: 0 } })).toMatchObject({ depth: 0, size: 0, soften: 0, altitude: 0, texture: { scale: 0.01 } });
    expect(normalizeBevel({ style: 'stroke', technique: 'chisel-soft', direction: 'down' })).toMatchObject({ style: 'stroke', technique: 'chisel-soft', direction: 'down' });
  });

  it('is sent resolved: the chapter light when it follows it, its own angle when not', () => {
    setGlobalLight({ angle: 90, altitude: 15 });
    try {
      const bevel = normalizeBevel({ on: true });
      expect(boxEffects({ bevel })).toEqual([{
        kind: 'bevel', style: 'inner', technique: 'smooth', depth: 1, direction: 'up', size: 5, soften: 0,
        angle: 90, altitude: 15, gloss: { preset: 'linear', aa: false }, highlight: lit, shadow: dark,
      }]);
      const own = boxEffects({ bevel: { ...bevel, useGlobalLight: false, angle: 45, altitude: 60 } })[0];
      expect([own.angle, own.altitude]).toEqual([45, 60]);
      expect(boxEffects({ bevel: { ...bevel, on: false } })).toEqual([]);
      expect(boxEffects({ bevel: { ...bevel, highlight: { ...lit, opacity: 0 }, shadow: { ...dark, opacity: 0 } } })).toEqual([]);
    } finally {
      setGlobalLight({ angle: 120, altitude: 30 });
    }
  });

  it('sends the Contour and the Texture only when their elements are on', () => {
    const bevel = normalizeBevel({
      on: true,
      contour: { on: false, curve: { preset: 'cone', aa: true }, range: 0.25 },
      texture: { on: false, pattern: { kind: 'stripes', scale: 2 }, scale: 0.5, depth: -2, invert: true, link: false },
    });
    const off = boxEffects({ bevel })[0];
    expect(off.contour).toBeUndefined();
    expect(off.texture).toBeUndefined();
    const on = boxEffects({ bevel: { ...bevel, contour: { ...bevel.contour, on: true }, texture: { ...bevel.texture, on: true } } })[0];
    expect(on.contour).toEqual({ preset: 'cone', aa: true, range: 0.25 });
    // The Texture's Scale is laid over the pattern's own; unlinked, it is
    // fixed to the page. The exporter makes the pattern a fill.
    expect(on.texture).toMatchObject({ depth: -2, invert: true, pattern: { kind: 'stripes', scale: 1, anchor: 'page' } });
    // Depth 0 shapes nothing.
    expect(boxEffects({ bevel: { ...bevel, texture: { ...bevel.texture, on: true, depth: 0 } } })[0].texture).toBeUndefined();
    // Last in the list: the top of Photoshop's stack.
    const many = boxEffects({ bevel, satin: normalizeSatin({ on: true }), strokeEffects: [{ size: 2, position: 'outside', opacity: 1, blend: 'normal', fill: 'color', color: '#000000' }] });
    expect(many.map((fx) => fx.kind)).toEqual(['satin', 'stroke', 'bevel']);
  });

  it('reaches past the letters as far as its style does', () => {
    expect(reachShadows({ bevel: normalizeBevel({ on: true, style: 'outer', size: 10 }) }).at(-1)).toMatchObject({ grow: 14 });
    expect(reachShadows({ bevel: normalizeBevel({ on: true, size: 10 }) })).toEqual([]);
  });

  it('rescales its Size and Soften with the page, not its depth, angle or texture scale', () => {
    const bevel = normalizeBevel({ on: true, size: 10, soften: 2, depth: 3, angle: 45, altitude: 20, texture: { on: true, scale: 2 } });
    expect(rescaleStyle({ bevel }, 2, 2).bevel).toMatchObject({ size: 20, soften: 4, depth: 3, angle: 45, altitude: 20, texture: { scale: 2 } });
  });
});

describe('a shadow saved before Size', () => {
  it('rescales its blur with the page', () => {
    const out = rescaleStyle({ shadows: [{ x: 2, y: 2, blur: 4 }] }, 2, 2);
    expect(out.shadows[0]).toMatchObject({ x: 4, y: 4, blur: 8 });
    expect(normalizeShadow(out.shadows[0]).size).toBe(10);
  });
});

describe('a custom contour', () => {
  it('drops a smooth point at the x of the one before, and keeps a corner step', () => {
    const smooth = normalizeContour({ preset: 'custom', pts: [[0, 0], [100, 50], [128, 60], [128, 200], [255, 255]] });
    expect(smooth.pts.map((q) => q[0])).toEqual([0, 100, 128, 255]);
    const step = normalizeContour({ preset: 'custom', pts: [[0, 0], [128, 60, true], [128, 200, true], [255, 255]] });
    expect(step.pts).toHaveLength(4);
  });
  it('drops a smooth point that shares its x with a corner, before or after it', () => {
    const after = normalizeContour({ preset: 'custom', pts: [[0, 0], [100, 50], [128, 60], [128, 200, true], [255, 255]] });
    expect(after.pts).toEqual([[0, 0, false], [100, 50, false], [128, 200, true], [255, 255, false]]);
    const before = normalizeContour({ preset: 'custom', pts: [[0, 0], [100, 50], [128, 200, true], [128, 60], [255, 255]] });
    expect(before.pts).toEqual(after.pts);
  });
});


describe('what the box job decoder will take', () => {
  // The Rust decoder (MAX_NOISE_GRADIENTS in boxjob.rs) refuses a box with more
  // than 64 noise gradients, so boxEffects sends no more than that.
  const noisy = { opacity: 1, blend: 'normal', gradient: { type: 'noise', noise: { seed: 1 } } };
  it('sends at most 64 noise gradients, counting glows, overlays and strokes', () => {
    const style = {
      outerGlow: { on: true, opacity: 1, fill: 'gradient', gradient: noisy.gradient, size: 4 },
      gradientOverlays: Array.from({ length: 40 }, () => noisy),
      strokeEffects: Array.from({ length: 40 }, () => ({ size: 2, position: 'outside', opacity: 1, blend: 'normal', fill: 'gradient', gradient: noisy.gradient })),
    };
    const fx = boxEffects(style);
    const count = fx.filter((e) => e.gradient?.type === 'noise').length + fx.filter((e) => e.paint?.gradient?.type === 'noise').length;
    expect(count).toBe(64);
    expect(fx.filter((e) => e.kind === 'outerGlow')).toHaveLength(1);
    expect(fx.filter((e) => e.kind === 'gradientOverlay')).toHaveLength(40);
    expect(fx.filter((e) => e.kind === 'stroke')).toHaveLength(23);
  });
  it('keeps solid gradients and a box within the cap whole', () => {
    const solid = { opacity: 1, blend: 'normal', gradient: { type: 'solid' } };
    const fx = boxEffects({ gradientOverlays: [...Array.from({ length: 64 }, () => noisy), ...Array.from({ length: 5 }, () => solid)] });
    expect(fx).toHaveLength(69);
  });
});
