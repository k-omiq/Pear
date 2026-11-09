import { describe, expect, it } from 'vitest';
import { encodeBox } from '../../text-engine/js/paint.mjs';
import { normalizeFxGradient, normalizeGradientOverlay, normalizeGlow, normalizeStrokeEffect, normalizeStyle, FX_GRADIENT_METHODS } from './data.js';
import { sampleRamp, bakeRamp, midpointRemap, rampCss } from './gradient-ramp.js';

// Gradient midpoints, separate opacity stops, Dither and the Interpolation
// Method (review Gaps table, F87).

describe('an effect gradient\'s stops, apart', () => {
  it('loads a gradient from before opacity stops as colour stops and opacity stops at the same places', () => {
    const old = { stops: [{ color: '#ff0000', pos: 1, opacity: 0.25 }, { color: '#000000', pos: 0, opacity: 1 }, { color: '#00ff00', pos: 0.5 }] };
    const g = normalizeFxGradient(old);
    expect(g.stops).toEqual([{ color: '#000000', pos: 0 }, { color: '#00ff00', pos: 0.5 }, { color: '#ff0000', pos: 1 }]);
    expect(g.opacityStops).toEqual([{ opacity: 1, pos: 0 }, { opacity: 1, pos: 0.5 }, { opacity: 0.25, pos: 1 }]);
    // Classic at 0 %, undithered: what it painted with.
    expect([g.smoothness, g.method, g.dither]).toEqual([0, 'classic', false]);
    // And it goes on the wire as it went before: the same stops, the same
    // opacities at the same places.
    const wire = (gradient) => encodeBox({ job: { bands: [], runs: [], fill: { kind: 'solid', color: '#000000' } }, font: 0, size: 10, width: 4, height: 4, effects: [{ kind: 'gradientOverlay', opacity: 1, blend: 'normal', gradient }] }).slice();
    expect(wire(g)).toEqual(wire(old));
  });

  it('keeps midpoints to Photoshop\'s 5 to 95 % and leaves an even one out', () => {
    const g = normalizeFxGradient({
      stops: [{ color: '#000000', pos: 0 }, { color: '#ffffff', pos: 1, mid: 0.01 }],
      opacityStops: [{ opacity: 1, pos: 0 }, { opacity: 0.5, pos: 0.4, mid: 0.5 }, { opacity: 0, pos: 1, mid: 2 }],
    });
    expect(g.stops[1].mid).toBe(0.05);
    expect('mid' in g.opacityStops[1]).toBe(false);
    expect(g.opacityStops[2].mid).toBe(0.95);
    // A midpoint stays with its stop when the stops are sorted.
    const s = normalizeFxGradient({ stops: [{ color: '#ffffff', pos: 1, mid: 0.3 }, { color: '#000000', pos: 0 }] });
    expect(s.stops).toEqual([{ color: '#000000', pos: 0 }, { color: '#ffffff', pos: 1, mid: 0.3 }]);
  });

  it('keeps Smoothness, the Method and Dither in range, and a glow without Dither', () => {
    const g = normalizeFxGradient({ smoothness: 3, method: 'stripes', dither: 'yes' });
    expect([g.smoothness, g.method, g.dither]).toEqual([1, 'classic', false]);
    expect(normalizeFxGradient({ smoothness: 0.4, method: 'perceptual', dither: true })).toMatchObject({ smoothness: 0.4, method: 'perceptual', dither: true });
    expect(FX_GRADIENT_METHODS).toEqual(['classic', 'perceptual', 'linear', 'smooth']);
    expect(normalizeGlow({ fill: 'gradient', gradient: { dither: true } }).gradient.dither).toBe(false);
    expect(normalizeStrokeEffect({ fill: 'gradient', gradient: { dither: true } }).gradient.dither).toBe(true);
    // A glow's gradient fades its colour out on the opacity stops.
    expect(normalizeGlow({}).gradient.opacityStops).toEqual([{ opacity: 1, pos: 0 }, { opacity: 0, pos: 1 }]);
    // A new overlay is opaque black to white.
    expect(normalizeGradientOverlay({}).gradient.opacityStops).toEqual([{ opacity: 1, pos: 0 }, { opacity: 1, pos: 1 }]);
    // Through the whole style.
    const st = normalizeStyle({ gradientOverlays: [{ gradient: { method: 'linear', smoothness: 0.5 } }] });
    expect(st.gradientOverlays[0].gradient).toMatchObject({ method: 'linear', smoothness: 0.5 });
  });
});

describe('the gradient on the wire (v14)', () => {
  const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const job = { job: { bands: [], runs: [], fill: { kind: 'solid', color: '#000000' } }, font: 0, size: 10, width: 4, height: 4 };
  // The overlay's gradient record starts after the box header, the blending
  // options and the effect's kind, opacity, blend and paint kind.
  const head = 4 * 4 + 4 + 8 + 4 + 4 + 4 + 8 + 4 + 4 + 4 + 4 + 4 + 8 + 4 + 4;
  const send = (gradient) => dv(encodeBox({ ...job, effects: [{ kind: 'gradientOverlay', opacity: 1, blend: 'normal', gradient }] }).slice());

  it('sends one midpoint per segment, from the stop that ends it, then Dither, the Method and Smoothness', () => {
    const g = normalizeFxGradient({
      stops: [{ color: '#000000', pos: 0 }, { color: '#808080', pos: 0.5, mid: 0.25 }, { color: '#ffffff', pos: 1 }],
      opacityStops: [{ opacity: 1, pos: 0 }, { opacity: 0, pos: 1, mid: 0.75 }],
      dither: true,
      method: 'linear',
      smoothness: 0.375,
    });
    const v = send(g);
    // style, angle, scale, reverse, offset, then 3 colour stops, 2 opacity.
    let at = head + 4 + 8 + 8 + 4 + 16;
    expect(v.getUint32(at, true)).toBe(3);
    at += 4 + 3 * 12;
    expect(v.getUint32(at, true)).toBe(2);
    at += 4 + 2 * 16;
    expect(v.getUint32(at, true)).toBe(2);
    expect([v.getFloat64(at + 4, true), v.getFloat64(at + 12, true)]).toEqual([0.25, 0.5]);
    at += 4 + 16;
    expect(v.getUint32(at, true)).toBe(1);
    expect(v.getFloat64(at + 4, true)).toBe(0.75);
    at += 12;
    expect([v.getUint32(at, true), v.getUint32(at + 4, true), v.getFloat64(at + 8, true)]).toEqual([1, 2, 0.375]);
    expect(v.getUint32(at + 16, true)).toBe(0); // solid
  });

  it('sends no midpoints when every one is even, and refuses a method it does not know', () => {
    const v = send(normalizeFxGradient({}));
    const at = head + 4 + 8 + 8 + 4 + 16 + 4 + 2 * 12 + 4;
    expect([v.getUint32(at, true), v.getUint32(at + 4, true), v.getUint32(at + 8, true), v.getUint32(at + 12, true), v.getFloat64(at + 16, true)]).toEqual([0, 0, 0, 0, 0]);
    expect(() => send({ ...normalizeFxGradient({}), method: 'stripes' })).toThrow(/method/);
  });
});

describe('the ramp the engine paints (gradient-ramp.js)', () => {
  const bw = (extra) => normalizeFxGradient({ stops: [{ color: '#000000', pos: 0 }, { color: '#ffffff', pos: 1 }], ...extra });
  const at = (g, t) => sampleRamp(g, 8).find((p) => Math.abs(p.pos - t) < 1e-9);

  it('runs straight between the stops at Classic 0 %, bent by a midpoint', () => {
    expect(at(bw(), 0.5).rgb[0]).toBeCloseTo(0.5, 9);
    expect(midpointRemap(0.3, 0.5)).toBe(0.3);
    const g = bw({ stops: [{ color: '#000000', pos: 0 }, { color: '#ffffff', pos: 1, mid: 0.25 }] });
    expect(at(g, 0.25).rgb[0]).toBeCloseTo(0.5, 6);
    expect(at(g, 0.125).rgb[0]).toBeCloseTo(0.25, 6);
    const o = bw({ opacityStops: [{ opacity: 1, pos: 0 }, { opacity: 0, pos: 1, mid: 0.75 }] });
    expect(at(o, 0.75).opacity).toBeCloseTo(0.5, 6);
  });

  it('matches the engine\'s Methods and Smoothness (PhotoCraft\'s Photoshop samples)', () => {
    // Linear light: half-way is sRGB 0.735.
    expect(at(bw({ method: 'linear' }), 0.5).rgb[0]).toBeCloseTo(0.7354, 2);
    // 100 %: t + (smoothstep(t) - t) / 2 between two stops.
    const s = sampleRamp(bw({ smoothness: 1 }), 4).find((p) => p.pos === 0.25);
    expect(Math.abs(s.rgb[0] - (0.25 + 0.5 * (0.25 * 0.25 * 2.5 - 0.25)))).toBeLessThan(2e-3);
    // Perceptual, orange to blue at 100 %: Photoshop's (0.592, 0.612, 0.596) near the middle.
    const p = normalizeFxGradient({ stops: [{ color: '#e19a33', pos: 0 }, { color: '#2a91d9', pos: 1 }], smoothness: 1, method: 'perceptual' });
    const mid = sampleRamp(p, 1000).find((q) => Math.abs(q.pos - 0.491) < 1e-9);
    mid.rgb.forEach((v, i) => expect(Math.abs(v - [0.592, 0.612, 0.596][i])).toBeLessThan(0.012));
    // Linear opacity: 63 % half-way (Photoshop, measured by PhotoCraft).
    const fade = bw({ method: 'linear', opacityStops: [{ opacity: 1, pos: 0 }, { opacity: 0, pos: 1 }] });
    expect(Math.abs(sampleRamp(fade, 512).find((q) => Math.abs(q.pos - 257 / 512) < 1e-9).opacity - 0.631)).toBeLessThan(0.015);
  });

  it('keeps a hard edge in its bake, and shows the ramp as CSS', () => {
    const g = bw({ stops: [{ color: '#000000', pos: 0 }, { color: '#ffffff', pos: 0.5 }, { color: '#ff0000', pos: 0.5 }, { color: '#000000', pos: 1 }], method: 'perceptual', smoothness: 1 });
    const edge = bakeRamp(g).color.filter((c) => c.pos === 0.5);
    expect(edge.map((c) => c.rgb.map((v) => Math.round(v * 255)))).toEqual([[255, 255, 255], [255, 0, 0]]);
    expect(rampCss(bw())).toMatch(/^linear-gradient\(90deg, rgba\(0, 0, 0, 1\) 0%, .*rgba\(255, 255, 255, 1\) 100%\)$/);
  });
});
