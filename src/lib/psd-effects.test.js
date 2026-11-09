import { afterEach, describe, expect, it } from 'vitest';
import { readPsd } from 'ag-psd';

// Phase 7b: every layer effect written by psd.js, read back with ag-psd, field
// by field, through a real page document (`pagePsdDocument` -> `writePagePsd`).
import { pagePsdDocument, textLayerFor, writePagePsd, isRasterOnly } from './psd.js';
import {
  defaultStyle,
  normalizeStyle,
  normalizeShadow,
  normalizeInnerShadow,
  normalizeGlow,
  normalizeSatin,
  normalizeBevel,
  normalizeOverlay,
  normalizeGradientOverlay,
  normalizeStrokeEffect,
  normalizeBlending,
} from './data.js';
import { CONTOUR_PRESET_POINTS, PSD_CONTOUR_POINTS } from './contour-presets.js';
import { setGlobalLight } from './text-paint.js';
import { sampleRamp } from './gradient-ramp.js';

const READ = { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true };
const rendered = { imageData: { width: 10, height: 6, data: new Uint8ClampedArray(10 * 6 * 4) }, left: 3, top: 4, right: 13, bottom: 10, opacity: 1 };
const plain = { ...defaultStyle(), strokes: [], shadows: [] };
const layerFor = (style) => textLayerFor({ lines: [] }, { lineN: null, text: 'hi', x: 0, y: 0, w: 40, h: 20, style: normalizeStyle({ ...plain, ...style }) }, rendered);

// The layer as Photoshop (ag-psd) reads it back from a written page.
function roundTrip(layer) {
  const doc = pagePsdDocument({ w: 32, h: 32, textLayers: [layer], project: { v: 1 } });
  const psd = readPsd(writePagePsd(doc), READ);
  return { psd, layer: psd.children.find((c) => c.name === 'Text').children[0] };
}

// Every field written is read back with the same value: numbers to within
// the file's rounding (percent and unit values are stored as doubles).
function expectSame(back, written, path = 'effect') {
  if (Array.isArray(written)) {
    expect(back, path).toHaveLength(written.length);
    written.forEach((w, i) => expectSame(back[i], w, `${path}[${i}]`));
  } else if (written && typeof written === 'object') {
    expect(back, path).toBeTypeOf('object');
    for (const [k, v] of Object.entries(written)) expectSame(back[k], v, `${path}.${k}`);
  } else if (typeof written === 'number') {
    expect(back, path).toBeCloseTo(written, 4);
  } else {
    expect(back, path).toBe(written);
  }
}

const curve = (n) => Array.from({ length: n }, (_, i) => [(i * 255) / (n - 1), i % 2 ? 200 : 40, false]);

afterEach(() => setGlobalLight({ angle: 120, altitude: 30 }));

describe('the PSD effects, written and read back', () => {
  it('a Drop Shadow, with its Noise, a named preset contour and the Global Light', () => {
    setGlobalLight({ angle: 60, altitude: 30 });
    const sh = normalizeShadow({ x: 3, y: 4, size: 7, color: '#336699', opacity: 0.6, spread: 0.25, noise: 0.35, blend: 'multiply', contour: { preset: 'cone', aa: true }, knockout: true, useGlobalLight: true });
    const fx = layerFor({ shadows: [sh] }).effects.dropShadow;
    expect(fx[0]).toMatchObject({ present: true, showInDialog: true, noise: 0.35, angle: 60, useGlobalLight: true, layerConceals: true });
    expect(fx[0].contour.name).toBe('Cone');
    // Spread 0.25 is written as a 25 percent Choke (psd.js), not read back from ag-psd.
    expect(fx[0].choke).toEqual({ units: 'Pixels', value: 25 });
    expect(fx[0].size).toMatchObject({ value: 7 });
    expect(fx[0].contour.curve.length).toBeLessThanOrEqual(PSD_CONTOUR_POINTS);
    const { layer, psd } = roundTrip(layerFor({ shadows: [sh] }));
    expectSame(layer.effects.dropShadow, fx, 'dropShadow');
    expect(layer.effects.dropShadow[0].noise).toBeCloseTo(0.35, 4);
    // The document carries the chapter's light, the angle effects on it read.
    expect(psd.imageResources.globalAngle).toBe(60);
    expect(psd.imageResources.globalAltitude).toBe(30);
  });

  it('an Inner Shadow, off the light, with its Choke and Noise', () => {
    const sh = normalizeInnerShadow({ x: -5, y: 0, size: 3, color: '#000000', opacity: 0.5, choke: 0.4, noise: 0.2, blend: 'screen', contour: { preset: 'gaussian' } });
    const layer = layerFor({ innerShadows: [sh] });
    expect(layer.effects.innerShadow[0]).toMatchObject({ noise: 0.2, useGlobalLight: false, choke: { value: 40 } });
    expectSame(roundTrip(layer).layer.effects.innerShadow, layer.effects.innerShadow, 'innerShadow');
  });

  it('an Outer Glow in a colour and an Inner Glow in a gradient', () => {
    const outer = normalizeGlow({ on: true, blend: 'screen', opacity: 0.8, noise: 0.1, color: '#ffee00', technique: 'precise', spread: 0.3, size: 12, contour: { preset: 'ring-double', aa: true }, range: 0.6 });
    const inner = normalizeGlow({ on: true, fill: 'gradient', gradient: { style: 'radial', reverse: true, stops: [{ color: '#ff0000', pos: 0, opacity: 1 }, { color: '#0000ff', pos: 1, opacity: 0.25 }] }, source: 'center', size: 6, jitter: 0.604 }, true);
    const layer = layerFor({ outerGlow: outer, innerGlow: inner });
    const fx = layer.effects;
    expect(fx.outerGlow).toMatchObject({ color: { r: 255, g: 238, b: 0 }, jitter: 0, present: true });
    expect(fx.outerGlow.gradient).toBeUndefined();
    expect(fx.outerGlow.choke).toEqual({ units: 'Pixels', value: 30 });
    expect(fx.outerGlow.contour).toMatchObject({ name: 'Ring - Double' });
    expect(fx.outerGlow.contour.curve).toHaveLength(PSD_CONTOUR_POINTS);
    // The gradient glow: Grad, Rvrs, Type, and no colour, as PhotoCraft writes it.
    expect(fx.innerGlow.color).toBeUndefined();
    expect(fx.innerGlow).toMatchObject({ reverse: true, type: 'radial', source: 'center', jitter: 0.6 });
    // Its two stops, baked into the linear ramp between them (`psdSolidStops`).
    expect(fx.innerGlow.gradient.colorStops[0]).toMatchObject({ location: 0, color: { r: 255, g: 0, b: 0 } });
    expect(fx.innerGlow.gradient.colorStops.at(-1)).toMatchObject({ location: 1, color: { r: 0, g: 0, b: 255 } });
    expect(fx.innerGlow.gradient.opacityStops.at(-1)).toMatchObject({ location: 1, opacity: 0.25 });
    const back = roundTrip(layer).layer.effects;
    expectSame(back.outerGlow, fx.outerGlow, 'outerGlow');
    expectSame(back.innerGlow, fx.innerGlow, 'innerGlow');
  });

  it('a Satin, its preset contour thinned and named', () => {
    const satin = normalizeSatin({ on: true, contour: { preset: 'ring', aa: true }, angle: -45, distance: 9, size: 4 });
    const layer = layerFor({ satin });
    expect(CONTOUR_PRESET_POINTS.ring.length).toBeGreaterThan(PSD_CONTOUR_POINTS);
    expect(layer.effects.satin.contour).toMatchObject({ name: 'Ring' });
    expect(layer.effects.satin.contour.curve).toHaveLength(PSD_CONTOUR_POINTS);
    expectSame(roundTrip(layer).layer.effects.satin, layer.effects.satin, 'satin');
  });

  it('a Bevel & Emboss on the Global Light, its Gloss Contour a preset', () => {
    setGlobalLight({ angle: 135, altitude: 40 });
    // The Contour element Linear: a curved one ships the box's pixels (F34).
    const bevel = normalizeBevel({ on: true, style: 'outer', technique: 'chisel-hard', depth: 3, size: 8, soften: 2, gloss: { preset: 'half-round', aa: true }, contour: { on: true, curve: { preset: 'linear' }, range: 0.4 } });
    const layer = layerFor({ bevel });
    expect(layer.effects.bevel).toMatchObject({ angle: 135, altitude: 40, useGlobalLight: true, useShape: true, range: 0.4, present: true });
    expect(layer.effects.bevel.contour.name).toBe('Half Round');
    const { layer: back, psd } = roundTrip(layer);
    expectSame(back.effects.bevel, layer.effects.bevel, 'bevel');
    expect(psd.imageResources).toMatchObject({ globalAngle: 135, globalAltitude: 40 });
  });

  it('a Colour Overlay and a Gradient Overlay', () => {
    const layer = layerFor({
      colorOverlays: [normalizeOverlay({ color: '#00aa55', opacity: 0.4, blend: 'hard-light' })],
      gradientOverlays: [normalizeGradientOverlay({ blend: 'overlay', opacity: 0.7, gradient: { style: 'angle', angle: 30, scale: 0.5, reverse: true, offset: [0.25, -0.5] } })],
    });
    const back = roundTrip(layer).layer.effects;
    expectSame(back.solidFill, layer.effects.solidFill, 'solidFill');
    expectSame(back.gradientOverlay, layer.effects.gradientOverlay, 'gradientOverlay');
  });

  it('the outlines and the Photoshop strokes, in colour and in a gradient', () => {
    const layer = layerFor({
      strokes: [{ color: '#ffffff', width: 3, opacity: 1 }],
      strokeEffects: [
        normalizeStrokeEffect({ size: 4, position: 'center', blend: 'multiply', opacity: 0.5, color: '#112233' }),
        normalizeStrokeEffect({ size: 2, position: 'outside', fill: 'gradient', gradient: { style: 'reflected' } }),
      ],
    });
    expect(layer.effects.stroke).toHaveLength(3);
    expect(layer.effects.stroke[1]).toMatchObject({ overprint: false, present: true });
    const back = roundTrip(layer).layer.effects;
    // ag-psd reads a stroke gradient's placement back onto the gradient itself.
    const written = layer.effects.stroke.map(({ gradient, ...k }) => k);
    expectSame(back.stroke, written, 'stroke');
    expect(back.stroke[2].gradient).toMatchObject({ style: 'reflected', type: 'solid' });
  });

  it('the Blending options on a layer with effects', () => {
    const layer = layerFor({ blendMode: 'multiply', fillOpacity: 0.5, blending: normalizeBlending({ interior: true, knockout: 'shallow' }), shadows: [normalizeShadow({})] });
    const { layer: back } = roundTrip(layer);
    expect(back).toMatchObject({ blendMode: 'multiply', blendInteriorElements: true, knockout: true });
    expect(back.fillOpacity).toBeCloseTo(0.5, 2);
  });

  it('writes the chapter light in whole degrees', () => {
    setGlobalLight({ angle: 120.7, altitude: 29.6 });
    const { psd } = roundTrip(layerFor({}));
    expect(psd.imageResources).toMatchObject({ globalAngle: 121, globalAltitude: 30 });
  });

  it('thins every contour it writes to 16 points, and keeps a short one whole', () => {
    const long = { preset: 'custom', pts: curve(40) };
    const layer = layerFor({ shadows: [normalizeShadow({ contour: long })], satin: normalizeSatin({ on: true, contour: { preset: 'custom', pts: curve(5) } }) });
    const ds = layer.effects.dropShadow[0].contour;
    expect(ds.name).toBe('Custom');
    expect(ds.curve).toHaveLength(PSD_CONTOUR_POINTS);
    expect(ds.curve[0]).toEqual({ x: 0, y: 40 });
    expect(ds.curve.at(-1)).toEqual({ x: 255, y: 200 });
    expect(layer.effects.satin.contour.curve).toHaveLength(5);
    const back = roundTrip(layer).layer.effects;
    expect(back.dropShadow[0].contour.curve).toHaveLength(PSD_CONTOUR_POINTS);
    // Linear is written as Photoshop writes it: its name and its two points.
    const lin = layerFor({ shadows: [normalizeShadow({})] }).effects.dropShadow[0].contour;
    expect(lin).toEqual({ name: 'Linear', curve: [{ x: 0, y: 0 }, { x: 255, y: 255 }] });
  });

  it('still sends what ag-psd cannot write down the raster branch', () => {
    expect(isRasterOnly(normalizeStyle({ ...plain, patternOverlay: { on: true } }))).toBe(true);
    expect(isRasterOnly(normalizeStyle({ ...plain, bevel: { on: true, texture: { on: true } } }))).toBe(true);
    expect(isRasterOnly(normalizeStyle({ ...plain, gradientOverlays: [{ gradient: { style: 'shapeburst' } }] }))).toBe(true);
  });
});

// The raw bytes of a written page: what Photoshop reads, where ag-psd's own
// reader would hide a scaling (it divides back what it multiplied).
function pageBytes(layer) {
  return new Uint8Array(writePagePsd(pagePsdDocument({ w: 32, h: 32, textLayers: [layer], project: { v: 1 } })));
}
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
function findAll(bytes, pattern) {
  const at = [];
  outer: for (let i = 0; i + pattern.length <= bytes.length; i++) {
    for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
    at.push(i + pattern.length);
  }
  return at;
}
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
// Every `key` stored as a `long`, and as a `doub`.
const longs = (bytes, key) => findAll(bytes, ascii(key + 'long')).map((i) => view(bytes).getInt32(i, false));
const doubles = (bytes, key) => findAll(bytes, ascii(key + 'doub')).map((i) => view(bytes).getFloat64(i, false));
// A list of longs (`VlLs`), as the noise gradient's Limits are written.
const longLists = (bytes, key) =>
  findAll(bytes, ascii(key + 'VlLs')).map((i) => {
    const v = view(bytes);
    const n = v.getInt32(i, false);
    return Array.from({ length: n }, (_, k) => v.getInt32(i + 4 + k * 8 + 4, false));
  });

// Photoshop's gradient at Smoothness 100 % (Classic): each segment a
// Hermite curve whose tangents are Catmull-Rom's, the end stops' at half
// slope, held inside the segment's own range. The model is PhotoCraft's,
// fitted on Photoshop (crates/io/src/gradient_bake.rs `eval`).
function photoshopSmooth(stops, t) {
  const n = stops.length;
  if (t <= stops[0][0]) return stops[0][1];
  if (t >= stops[n - 1][0]) return stops[n - 1][1];
  let i = 0;
  while (i < n - 2 && t > stops[i + 1][0]) i++;
  const [t0, p0] = stops[i];
  const [t1, p1] = stops[i + 1];
  const h = Math.max(1e-6, t1 - t0);
  const u = (t - t0) / h;
  const tangent = (k) => {
    const [a, b] = k === 0 ? [0, 1] : k === n - 1 ? [n - 2, n - 1] : [k - 1, k + 1];
    const half = k === 0 || k === n - 1 ? 0.5 : 1;
    return ((stops[b][1] - stops[a][1]) / Math.max(1e-6, stops[b][0] - stops[a][0])) * half;
  };
  const [m0, m1] = [tangent(i), tangent(i + 1)];
  const v = (2 * u ** 3 - 3 * u ** 2 + 1) * p0 + (u ** 3 - 2 * u ** 2 + u) * h * m0 + (-2 * u ** 3 + 3 * u ** 2) * p1 + (u ** 3 - u ** 2) * h * m1;
  return Math.min(Math.max(p0, p1), Math.max(Math.min(p0, p1), v));
}
const linearRamp = (stops, t) => {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, a] = stops[i];
    const [t1, b] = stops[i + 1];
    if (t <= t1) return t1 > t0 ? a + ((b - a) * (t - t0)) / (t1 - t0) : b;
  }
  return stops.at(-1)[1];
};

describe('the PSD export review fixes', () => {
  it('F30: writes every gradient midpoint as Photoshop\'s 50 %', () => {
    const layer = layerFor({
      gradient: { on: true, angle: 90, stops: [{ color: '#000000', pos: 0, opacity: 1 }, { color: '#ffffff', pos: 1, opacity: 1 }] },
      gradientOverlays: [normalizeGradientOverlay({})],
    });
    const mids = longs(pageBytes(layer), 'Mdpn');
    expect(mids.length).toBeGreaterThan(4);
    expect(new Set(mids)).toEqual(new Set([50]));
  });

  it('F35: bakes the linear ramp into stops Photoshop draws straight at Smoothness 100 %', () => {
    const black = { color: '#000000', opacity: 1 };
    const white = { color: '#ffffff', opacity: 0 };
    for (const stops of [
      [{ ...black, pos: 0 }, { ...white, pos: 1 }],
      [{ ...black, pos: 0.1 }, { ...white, pos: 0.4 }, { ...black, pos: 0.9 }],
    ]) {
      const layer = layerFor({ gradientOverlays: [normalizeGradientOverlay({ gradient: { stops } })] });
      const g = layer.effects.gradientOverlay[0].gradient;
      const bytes = pageBytes(layer);
      // Smoothness stays 100 % (ag-psd scales Lctn by it), and every location
      // is on its 4096 grid.
      expect(doubles(bytes, 'Intr')).toEqual([4096]);
      expect(longs(bytes, 'Lctn').every((l) => l >= 0 && l <= 4096)).toBe(true);
      const want = stops.map((st) => [st.pos, st.color === '#000000' ? 0 : 255]);
      const wantA = stops.map((st) => [st.pos, st.opacity]);
      const got = g.colorStops.map((c) => [c.location, c.color.r]);
      const gotA = g.opacityStops.map((c) => [c.location, c.opacity]);
      for (let k = 0; k <= 400; k++) {
        const t = k / 400;
        expect(Math.abs(photoshopSmooth(got, t) - linearRamp(want, t)), `colour at ${t}`).toBeLessThan(1.5);
        expect(Math.abs(photoshopSmooth(gotA, t) - linearRamp(wantA, t)), `opacity at ${t}`).toBeLessThan(0.01);
      }
      // The stops as written, without the bake, would not be: Photoshop eases them.
      const eased = Math.max(...Array.from({ length: 101 }, (_, k) => Math.abs(photoshopSmooth(want, k / 100) - linearRamp(want, k / 100))));
      expect(eased).toBeGreaterThan(5);
    }
  });

  it('F36: writes noise limits that survive ag-psd\'s truncation', () => {
    const gradient = { type: 'noise', noise: { min: [0.29, 0.57, 0.58], max: [0.83, 1, 0.07] } };
    const layer = layerFor({ gradientOverlays: [normalizeGradientOverlay({ gradient })] });
    const bytes = pageBytes(layer);
    expect(longLists(bytes, 'Mnm ')).toEqual([[29, 57, 58, 0]]);
    expect(longLists(bytes, 'Mxm ')).toEqual([[83, 100, 58, 100]]);
  });

  it('F29: turns every effect angle back by the box rotation, off the Global Light', () => {
    setGlobalLight({ angle: 120, altitude: 30 });
    const style = {
      rotation: 30,
      // Straight down in the box's frame (light at 90), and one on the light.
      shadows: [normalizeShadow({ x: 0, y: 5, useGlobalLight: false }), normalizeShadow({ x: 0, y: 5, useGlobalLight: true })],
      innerShadows: [normalizeInnerShadow({ x: -5, y: 0 })],
      satin: normalizeSatin({ on: true, angle: 19 }),
      bevel: normalizeBevel({ on: true, useGlobalLight: true }),
      gradientOverlays: [normalizeGradientOverlay({ gradient: { angle: 90 } })],
      strokeEffects: [normalizeStrokeEffect({ size: 2, fill: 'gradient', gradient: { angle: -170 } })],
      gradient: { on: true, angle: 180, stops: [{ color: '#000000', pos: 0, opacity: 1 }, { color: '#ffffff', pos: 1, opacity: 1 }] },
    };
    const fx = layerFor(style).effects;
    // The box turns clockwise on the page: a shadow thrown straight down in
    // its frame lands down and to the left, Photoshop's light at 60.
    expect(fx.dropShadow.map((d) => [d.angle, d.useGlobalLight])).toEqual([[60, false], [90, false]]);
    expect(fx.innerShadow[0]).toMatchObject({ angle: -30, useGlobalLight: false });
    expect(fx.satin.angle).toBe(-11);
    expect(fx.bevel).toMatchObject({ angle: 90, altitude: 30, useGlobalLight: false });
    expect(fx.gradientOverlay.map((g) => g.angle)).toEqual([60, -120]);
    // -170 less 30 is -200, written as Photoshop's 160.
    expect(fx.stroke[0].gradient.angle).toBe(160);
    const back = roundTrip(layerFor(style)).layer.effects;
    expect(back.dropShadow.map((d) => [d.angle, d.useGlobalLight])).toEqual([[60, false], [90, false]]);
    expect(back.bevel).toMatchObject({ angle: 90, useGlobalLight: false });
    // Not turned: the angles and the Global Light as they were.
    const flat = layerFor({ ...style, rotation: 0 }).effects;
    expect(flat.dropShadow.map((d) => [d.angle, d.useGlobalLight])).toEqual([[90, false], [120, true]]);
    expect(flat.bevel).toMatchObject({ angle: 120, useGlobalLight: true });
    expect(flat.gradientOverlay.map((g) => g.angle)).toEqual([90, -90]);
    expect(layerFor({ ...style, rotation: 360 }).effects.satin.angle).toBe(19);
  });

  it('F31: a raster-only layer keeps its blend mode, Blend If, Channels and Knockout', () => {
    const blending = normalizeBlending({ interior: true, knockout: 'deep', channels: { g: false }, blendIf: { gray: { under: [10, 40, 255, 255] } } });
    const layer = layerFor({ curve: 30, blendMode: 'color-burn', blending });
    expect('text' in layer).toBe(false);
    expect(layer).toMatchObject({ blendMode: 'color burn', blendInteriorElements: true, knockout: true, channelBlendingRestrictions: [1] });
    const { layer: back } = roundTrip(layer);
    expect(back).toMatchObject({ blendMode: 'color burn', blendInteriorElements: true, knockout: true });
    expect(back.blendingRanges.compositeGraphBlendDestinationRange).toEqual([10, 40, 255, 255]);
    // Channels from the `brst` block's bytes: ag-psd 31's reader stops one
    // index short, so it reads a lone channel back as none.
    const bytes = pageBytes(layer);
    const [at] = findAll(bytes, ascii('8BIMbrst'));
    expect(at).toBeGreaterThan(0);
    const dv = view(bytes);
    expect(dv.getUint32(at, false)).toBe(4);
    expect(dv.getInt32(at + 4, false)).toBe(1);
    // A plain raster-only box stays Normal with nothing more.
    const plainRaster = layerFor({ curve: 30 });
    expect(plainRaster.blendMode).toBe('normal');
    expect(plainRaster.knockout).toBeUndefined();
    expect(plainRaster.blendingRanges).toBeUndefined();
  });

  it('F32: a fill gradient under Fill Opacity with Blend Interior off ships pixels', () => {
    const gradient = { on: true, angle: 90, stops: [{ color: '#ff0000', pos: 0, opacity: 1 }, { color: '#0000ff', pos: 1, opacity: 1 }] };
    expect(isRasterOnly(normalizeStyle({ ...plain, gradient, fillOpacity: 0.5 }))).toBe(true);
    // Photoshop fades the overlay by Fill when Blend Interior Effects is on.
    expect(isRasterOnly(normalizeStyle({ ...plain, gradient, fillOpacity: 0.5, blending: { interior: true } }))).toBe(false);
    expect(isRasterOnly(normalizeStyle({ ...plain, gradient, fillOpacity: 1 }))).toBe(false);
    // Fill without a gradient fill is the type layer's own Fill: live.
    expect(isRasterOnly(normalizeStyle({ ...plain, fillOpacity: 0.5 }))).toBe(false);
  });

  it('F33: a Stroke Emboss with no Photoshop stroke is left out', () => {
    const bevel = normalizeBevel({ on: true, style: 'stroke' });
    const strokes = [{ color: '#ffffff', width: 3, opacity: 1 }];
    const bare = layerFor({ strokes, bevel }).effects;
    expect(bare.stroke).toHaveLength(1);
    expect(bare.bevel).toBeUndefined();
    const stroked = layerFor({ strokes, bevel, strokeEffects: [normalizeStrokeEffect({ size: 2 })] }).effects;
    expect(stroked.bevel.style).toBe('stroke emboss');
    // A stroke that paints nothing is neither written nor embossed.
    const clear = layerFor({ strokes, bevel, strokeEffects: [normalizeStrokeEffect({ size: 2, opacity: 0 })] }).effects;
    expect(clear.stroke).toHaveLength(1);
    expect(clear.bevel).toBeUndefined();
    // Another style keeps its bevel with no stroke at all.
    expect(layerFor({ strokes, bevel: { ...bevel, style: 'inner' } }).effects.bevel.style).toBe('inner bevel');
  });

  it('F34: a bevel with a curved Contour ships pixels', () => {
    const bevel = (contour) => normalizeStyle({ ...plain, bevel: normalizeBevel({ on: true, contour }) });
    expect(isRasterOnly(bevel({ on: true, curve: { preset: 'ring' } }))).toBe(true);
    expect(isRasterOnly(bevel({ on: true, curve: { preset: 'custom', pts: [[0, 0], [128, 200], [255, 255]] } }))).toBe(true);
    expect(isRasterOnly(bevel({ on: true, curve: { preset: 'linear' } }))).toBe(false);
    expect(isRasterOnly(bevel({ on: true, curve: { preset: 'custom', pts: [[0, 0], [128, 128], [255, 255]] } }))).toBe(false);
    // The Contour element off: its curve is not used.
    expect(isRasterOnly(bevel({ on: false, curve: { preset: 'ring' } }))).toBe(false);
  });

  it('F37: a pattern effect that paints nothing keeps the box live', () => {
    const k = { size: 3, fill: 'pattern' };
    expect(isRasterOnly(normalizeStyle({ ...plain, strokeEffects: [normalizeStrokeEffect(k)] }))).toBe(true);
    expect(isRasterOnly(normalizeStyle({ ...plain, strokeEffects: [normalizeStrokeEffect({ ...k, opacity: 0 })] }))).toBe(false);
    expect(isRasterOnly(normalizeStyle({ ...plain, strokeEffects: [normalizeStrokeEffect({ ...k, size: 0 })] }))).toBe(false);
    expect(isRasterOnly(normalizeStyle({ ...plain, patternOverlay: { on: true, opacity: 0 } }))).toBe(false);
    expect(isRasterOnly(normalizeStyle({ ...plain, patternOverlay: { on: true, opacity: 0.5 } }))).toBe(true);
    // The stroke that paints nothing is not written either.
    expect(layerFor({ strokeEffects: [normalizeStrokeEffect({ size: 2, opacity: 0 })] }).effects).toBeUndefined();
  });
});

// Gradient midpoints, separate opacity stops, Dither and the Interpolation
// Method (review Gaps table, F87).
describe('an effect gradient\'s midpoints, opacity stops, Dither and Method', () => {
  const stops = [{ color: '#000000', pos: 0 }, { color: '#ffffff', pos: 0.6, mid: 0.25 }, { color: '#ff0000', pos: 1, mid: 0.7 }];
  const opacityStops = [{ opacity: 1, pos: 0 }, { opacity: 0.2, pos: 0.3, mid: 0.8 }, { opacity: 0.9, pos: 1 }];

  it('at Smoothness 100 % writes the stops, their midpoints and the method as they are', () => {
    const gradient = { stops, opacityStops, smoothness: 1, method: 'perceptual', dither: true };
    const layer = layerFor({
      gradientOverlays: [normalizeGradientOverlay({ gradient })],
      strokeEffects: [normalizeStrokeEffect({ size: 2, fill: 'gradient', gradient: { ...gradient, method: 'linear', dither: false } })],
    });
    const bytes = pageBytes(layer);
    // Photoshop's percent, on the stop that ends each segment (F30's 50 on
    // the first stops).
    expect(longs(bytes, 'Mdpn')).toEqual([50, 25, 70, 50, 80, 50, 50, 25, 70, 50, 80, 50]);
    expect(doubles(bytes, 'Intr')).toEqual([4096, 4096]);
    const { layer: back } = roundTrip(layer);
    const o = back.effects.gradientOverlay[0];
    expect(o.dither).toBe(true);
    expect(o.interpolationMethod).toBe('perceptual');
    const r3 = (v) => Math.round(v * 1000) / 1000;
    expect(o.gradient.colorStops.map((c) => [r3(c.location), c.midpoint])).toEqual([[0, 0.5], [0.6, 0.25], [1, 0.7]]);
    expect(o.gradient.opacityStops.map((c) => [r3(c.location), r3(c.opacity), c.midpoint])).toEqual([[0, 1, 0.5], [0.3, 0.2, 0.8], [1, 0.9, 0.5]]);
    const k = back.effects.stroke.find((s) => s.fillType === 'gradient');
    expect(k.gradient.interpolationMethod).toBe('linear');
    expect(k.gradient.dither).toBe(false);
  });

  it('at any other Smoothness bakes the ramp the engine paints, Classic, so Photoshop draws it the same', () => {
    for (const [method, smoothness] of [['classic', 0], ['linear', 0], ['perceptual', 0.5], ['smooth', 0]]) {
      const gradient = normalizeGradientOverlay({ gradient: { stops, opacityStops, smoothness, method } }).gradient;
      const layer = layerFor({ gradientOverlays: [{ blend: 'normal', opacity: 1, gradient }] });
      const o = layer.effects.gradientOverlay[0];
      expect(o.interpolationMethod, method).toBe('classic');
      expect(new Set(o.gradient.colorStops.map((c) => c.midpoint))).toEqual(new Set([0.5]));
      const want = sampleRamp(gradient, 400);
      const red = o.gradient.colorStops.map((c) => [c.location, c.color.r]);
      const green = o.gradient.colorStops.map((c) => [c.location, c.color.g]);
      const alpha = o.gradient.opacityStops.map((c) => [c.location, c.opacity]);
      const worst = [0, 0, 0];
      for (const p of want) {
        worst[0] = Math.max(worst[0], Math.abs(photoshopSmooth(red, p.pos) - p.rgb[0] * 255));
        worst[1] = Math.max(worst[1], Math.abs(photoshopSmooth(green, p.pos) - p.rgb[1] * 255));
        worst[2] = Math.max(worst[2], Math.abs(photoshopSmooth(alpha, p.pos) - p.opacity));
      }
      // Within a level or so of the engine's ramp (most where Linear's
      // light curve is steepest, next to black); the alpha within 1.5 %.
      expect(worst[0], `${method} red`).toBeLessThan(3.5);
      expect(worst[1], `${method} green`).toBeLessThan(3.5);
      expect(worst[2], `${method} alpha`).toBeLessThan(0.015);
      if (method === 'linear') {
        // The stops written as they are would be far off it.
        const raw = stops.map((st) => [st.pos, st.color === '#000000' ? 0 : 255]);
        expect(Math.max(...want.map((p) => Math.abs(photoshopSmooth(raw, p.pos) - p.rgb[0] * 255)))).toBeGreaterThan(20);
      }
    }
  });

  it('a midpoint moves the half-way colour where the engine puts it', () => {
    const g = normalizeGradientOverlay({ gradient: { stops: [{ color: '#000000', pos: 0 }, { color: '#ffffff', pos: 1, mid: 0.25 }] } }).gradient;
    const at = (t) => sampleRamp(g, 4).find((p) => p.pos === t);
    expect(at(0.25).rgb[0]).toBeCloseTo(0.5, 6);
    const o = layerFor({ gradientOverlays: [{ blend: 'normal', opacity: 1, gradient: g }] }).effects.gradientOverlay[0];
    const red = o.gradient.colorStops.map((c) => [c.location, c.color.r]);
    expect(Math.abs(photoshopSmooth(red, 0.25) - 127.5)).toBeLessThan(1.5);
  });

  it('a glow, which ag-psd gives no method, bakes any method but Classic', () => {
    const gradient = { stops, opacityStops, smoothness: 1, method: 'perceptual' };
    const glow = layerFor({ outerGlow: normalizeGlow({ on: true, fill: 'gradient', gradient }) }).effects.outerGlow;
    expect(glow.gradient.colorStops.length).toBeGreaterThan(10);
    const classic = layerFor({ outerGlow: normalizeGlow({ on: true, fill: 'gradient', gradient: { ...gradient, method: 'classic' } }) }).effects.outerGlow;
    expect(classic.gradient.colorStops.map((c) => c.midpoint)).toEqual([0.5, 0.25, 0.7]);
    expect(glow.dither).toBeUndefined();
  });
});
