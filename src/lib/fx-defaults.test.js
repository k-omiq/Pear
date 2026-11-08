import { afterEach, describe, expect, it } from 'vitest';

// Make Default / Reset to Default (LAYER_STYLES_PLAN.md item 12, phase 7a):
// the person's default per effect, held in data.js through `setFxDefaults`.
import {
  FX_KINDS,
  fxDefault,
  fxReset,
  fxStored,
  fxUntouched,
  newFx,
  newShadow,
  newInnerShadow,
  newOverlay,
  newGradientOverlay,
  newStrokeEffect,
  normalizeFxDefaults,
  normalizeShadow,
  normalizeGlow,
  normalizeSatin,
  normalizeBevel,
  normalizePatternOverlay,
  setFxDefaults,
} from './data.js';

afterEach(() => setFxDefaults({}));

// One edited instance of every kind, as the Inspector would hold it.
const edited = {
  dropShadow: normalizeShadow({ x: 6, y: 8, size: 12, color: '#123456', opacity: 0.4, spread: 0.2, noise: 0.3, blend: 'overlay', contour: { preset: 'cone', aa: true }, knockout: false, useGlobalLight: false }),
  innerShadow: { x: -3, y: 4, size: 7, color: '#ff0000', opacity: 0.5, choke: 0.4, noise: 0.1, blend: 'screen', useGlobalLight: true },
  outerGlow: { on: true, blend: 'normal', opacity: 0.5, noise: 0.2, color: '#00ff00', fill: 'gradient', gradient: { type: 'noise', noise: { seed: 777, roughness: 0.9 } }, technique: 'precise', spread: 0.3, size: 20, range: 0.7 },
  innerGlow: { on: true, color: '#0000ff', size: 9, source: 'center' },
  colorOverlay: { color: '#abcdef', opacity: 0.3, blend: 'multiply' },
  gradientOverlay: { blend: 'screen', opacity: 0.6, gradient: { style: 'radial', angle: 45, type: 'noise', noise: { seed: 31337 } } },
  patternOverlay: { on: true, blend: 'overlay', opacity: 0.5, pattern: { kind: 'picked', src: 'tile-1', cell: [[0, 0, 4, 4]], seed: 42, scale: 2 } },
  strokeEffect: { size: 4, position: 'outside', blend: 'normal', opacity: 0.8, fill: 'gradient', color: '#222222', gradient: { type: 'noise', noise: { seed: 99 } }, pattern: { kind: 'dots', seed: 7 } },
  satin: { on: true, blend: 'screen', color: '#ffffff', opacity: 0.25, angle: 60, distance: 20, size: 3, invert: false },
  bevel: { on: true, style: 'emboss', technique: 'chisel-hard', depth: 2, size: 9, useGlobalLight: false, angle: 33, altitude: 50, texture: { on: true, pattern: { kind: 'dots', seed: 5 }, depth: -2 } },
  blending: { interior: true, knockout: 'deep', channels: { r: false } },
};

describe('the effect defaults', () => {
  it('start from the factory for every kind, and each new effect function says so', () => {
    for (const k of FX_KINDS) expect(fxDefault(k)).toBeNull();
    expect(newShadow({ angle: 120 })).toMatchObject({ size: 5, opacity: 0.75, blend: 'multiply', knockout: true, useGlobalLight: true });
    expect(newOverlay()).toEqual({ color: '#ff0000', opacity: 1, blend: 'normal' });
    expect(newGradientOverlay().gradient.style).toBe('linear');
    expect(newStrokeEffect()).toMatchObject({ size: 1, position: 'inside' });
  });

  it('round-trip a stored default of every kind, normalised, whatever was handed in', () => {
    const stored = normalizeFxDefaults(edited);
    expect(Object.keys(stored).sort()).toEqual([...FX_KINDS].sort());
    // What a relaunch reads (JSON) is what was written, and normalises to itself.
    const again = normalizeFxDefaults(JSON.parse(JSON.stringify(stored)));
    expect(again).toEqual(stored);
    setFxDefaults(again);
    for (const k of FX_KINDS) expect(fxStored(k, fxDefault(k, { angle: 120 }))).toEqual(stored[k]);
    // The new effect functions start from it.
    expect(newOverlay()).toEqual({ color: '#abcdef', opacity: 0.3, blend: 'multiply' });
    expect(newStrokeEffect()).toMatchObject({ size: 4, position: 'outside', fill: 'gradient' });
    expect(newGradientOverlay().gradient).toMatchObject({ style: 'radial', angle: 45, type: 'noise' });
    expect(newInnerShadow({ angle: 120 })).toMatchObject({ size: 7, choke: 0.4, blend: 'screen' });
  });

  it("strip what is one instance's own: the switch, the seeds, a picked tile, a shadow's x and y", () => {
    const st = normalizeFxDefaults(edited);
    for (const k of ['outerGlow', 'innerGlow', 'patternOverlay', 'satin', 'bevel']) expect(st[k]).not.toHaveProperty('on');
    expect(st.outerGlow.gradient.noise).not.toHaveProperty('seed');
    expect(st.gradientOverlay.gradient.noise).not.toHaveProperty('seed');
    expect(st.strokeEffect.gradient.noise).not.toHaveProperty('seed');
    expect(st.strokeEffect.pattern).not.toHaveProperty('seed');
    expect(st.bevel.texture.pattern).not.toHaveProperty('seed');
    expect(st.patternOverlay.pattern.kind).not.toBe('picked');
    expect(st.patternOverlay.pattern).not.toHaveProperty('src');
    expect(st.patternOverlay.pattern).not.toHaveProperty('cell');
    expect(st.dropShadow).not.toHaveProperty('x');
    expect(st.dropShadow).not.toHaveProperty('y');
    expect(st.dropShadow).toMatchObject({ distance: 10, useGlobalLight: false, angle: expect.any(Number) });
    // On the light only the distance is the shadow's: no angle is kept.
    expect(st.innerShadow).toMatchObject({ distance: 5, useGlobalLight: true });
    expect(st.innerShadow).not.toHaveProperty('angle');
  });

  it('fall back to the factory for a corrupted default, kind by kind', () => {
    setFxDefaults({
      dropShadow: 'not an effect',
      innerShadow: [1, 2, 3],
      outerGlow: null,
      satin: { size: 'big', opacity: 'x', angle: 'up', blend: 'nonsense', distance: -40 },
      colorOverlay: { color: '#ab' },
      nonsense: { size: 3 },
    });
    expect(fxDefault('dropShadow')).toBeNull();
    expect(fxDefault('innerShadow')).toBeNull();
    expect(fxDefault('outerGlow')).toBeNull();
    expect(newShadow({ angle: 120 })).toEqual(newFx('dropShadow', { angle: 120 }));
    expect(newShadow({ angle: 120 })).toMatchObject({ size: 5, opacity: 0.75 });
    // Each unreadable field is the factory's; the readable ones stand.
    const factory = normalizeSatin({});
    expect(fxDefault('satin')).toEqual({ ...factory, distance: 0 });
    expect(newOverlay().color).toBe('#ff0000');
    expect(normalizeFxDefaults('garbage')).toEqual({});
    expect(normalizeFxDefaults({ nonsense: {} })).toEqual({});
  });

  it("keep a Global Light shadow's default following a changed chapter light", () => {
    setFxDefaults({ dropShadow: { ...newShadow({ angle: 120 }), x: 0, y: 9, size: 4 } });
    // Distance 9, on the light: thrown from whatever the light is when added.
    const at = (angle) => {
      const sh = newShadow({ angle });
      return [Math.round(Math.atan2(sh.y, -sh.x) * 180 / Math.PI), Math.round(Math.hypot(sh.x, sh.y) * 10) / 10];
    };
    expect(at(120)).toEqual([120, 9]);
    expect(at(45)).toEqual([45, 9]);
    expect(at(-90)).toEqual([-90, 9]);
    expect(newShadow({ angle: 45 }).useGlobalLight).toBe(true);
    // Off the light, the default keeps its own angle whatever the chapter's.
    setFxDefaults({ dropShadow: { ...edited.dropShadow } });
    expect(at(45)).toEqual([at(120)[0], 10]);
    expect(at(120)[0]).toBe(Math.round(Math.atan2(8, -6) * 180 / Math.PI));
  });

  it('reset an instance to the default or the factory, keeping its switch and its seeds', () => {
    setFxDefaults({ outerGlow: edited.outerGlow, bevel: edited.bevel });
    const glow = normalizeGlow({ on: true, size: 50, gradient: { noise: { seed: 1234 } } });
    const back = fxReset('outerGlow', glow);
    expect(back).toMatchObject({ on: true, size: 20, technique: 'precise', fill: 'gradient' });
    expect(back.gradient.noise.seed).toBe(1234);
    const off = fxReset('outerGlow', { ...glow, on: false }, undefined, true);
    expect(off).toEqual({ ...normalizeGlow({}), gradient: { ...normalizeGlow({}).gradient, noise: { ...normalizeGlow({}).gradient.noise, seed: 1234 } } });
    const bv = fxReset('bevel', normalizeBevel({ on: false, texture: { pattern: { seed: 77 } } }));
    expect(bv).toMatchObject({ on: false, style: 'emboss', angle: 33 });
    expect(bv.texture.pattern.seed).toBe(77);
    // A shadow reset to its default is thrown from the light it is given.
    setFxDefaults({ dropShadow: newShadow({ angle: 120 }) });
    const sh = fxReset('dropShadow', edited.dropShadow, { angle: 90 });
    expect(sh.x).toBeCloseTo(0, 5);
    expect(sh.y).toBe(5);
  });

  it('know an effect never edited from one that was', () => {
    expect(fxUntouched('satin', normalizeSatin({}))).toBe(true);
    expect(fxUntouched('satin', normalizeSatin({ on: true }))).toBe(true);
    expect(fxUntouched('satin', normalizeSatin({ size: 3 }))).toBe(false);
    expect(fxUntouched('patternOverlay', normalizePatternOverlay({ pattern: { seed: 9 } }))).toBe(true);
    expect(fxUntouched('glow', {})).toBe(false);
  });
});
