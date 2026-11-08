import { describe, expect, it } from 'vitest';
import { BLEND_MODE_IDS, CONTOUR_IDS, BOX_WIRE_VERSION, encodeBox } from '../../text-engine/js/paint.mjs';
import {
  LAYER_BLEND_MODES,
  CONTOUR_PRESETS,
  LIGHT_DEF,
  normalizeLight,
  normalizeShadow,
  normalizeTypesetting,
  normalizeFxGradient,
  normalizeNoiseGradient,
  FX_GRADIENT_STYLES,
  NOISE_MODELS,
  newShadow,
  newTypesetting,
  normalizeSatin,
  normalizeStyle,
} from './data.js';
import { shadowSigma, shadowOffset, resolveShadow, setGlobalLight, boxEffects } from './text-paint.js';
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
    expect(BOX_WIRE_VERSION).toBe(7);
    // The noise record: seed, roughness, model, six limits, flags.
    expect(noisy.length - solid.length).toBe(4 + 8 + 4 + 6 * 8 + 4);
    // The gradient record starts after the box header, the blending options
    // and the effect's kind, opacity and blend: its style is Shape Burst.
    const head = 4 * 4 + 4 + 8 + 4 + 4 + 4 + 8 + 4;
    expect(dv(solid).getUint32(head + 4 + 8 + 4 + 4, true)).toBe(5);
    const typeAt = head + 4 + 8 + 4 + 4 + 4 + 8 + 8 + 4 + 8 + 8 + 4 + 2 * 12 + 4;
    expect(dv(solid).getUint32(typeAt, true)).toBe(0);
    expect(dv(noisy).getUint32(typeAt, true)).toBe(1);
    expect(dv(noisy).getUint32(typeAt + 4, true)).toBe(42);
    expect(dv(noisy).getUint32(typeAt + 16, true)).toBe(2);
    expect(dv(noisy).getUint32(typeAt + 20 + 48, true)).toBe(3);
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
    const head = 4 * 4 + 4 + 8 + 4 + 4 + 4 + 8 + 4;
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
