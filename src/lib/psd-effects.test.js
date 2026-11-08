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
    expect(fx.outerGlow.contour).toMatchObject({ name: 'Ring - Double' });
    expect(fx.outerGlow.contour.curve).toHaveLength(PSD_CONTOUR_POINTS);
    // The gradient glow: Grad, Rvrs, Type, and no colour, as PhotoCraft writes it.
    expect(fx.innerGlow.color).toBeUndefined();
    expect(fx.innerGlow).toMatchObject({ reverse: true, type: 'radial', source: 'center', jitter: 0.6 });
    expect(fx.innerGlow.gradient.colorStops).toHaveLength(2);
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
    const bevel = normalizeBevel({ on: true, style: 'outer', technique: 'chisel-hard', depth: 3, size: 8, soften: 2, gloss: { preset: 'half-round', aa: true }, contour: { on: true, curve: { preset: 'cone' }, range: 0.4 } });
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
