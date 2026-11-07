import { describe, expect, it } from 'vitest';
import { BLEND_MODE_IDS, CONTOUR_IDS, encodeBox } from '../../text-engine/js/paint.mjs';
import {
  LAYER_BLEND_MODES,
  CONTOUR_PRESETS,
  LIGHT_DEF,
  normalizeLight,
  normalizeShadow,
  normalizeTypesetting,
  newShadow,
  newTypesetting,
} from './data.js';
import { shadowSigma, shadowOffset, resolveShadow, setGlobalLight } from './text-paint.js';

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
