import { afterEach, describe, expect, it } from 'vitest';
import { readPsd } from 'ag-psd';

// Photoshop's multi effects (Drop Shadow, Inner Shadow, Color Overlay,
// Gradient Overlay, Stroke): at most FX_INSTANCES_MAX of each, each with its
// own switch, stored only when off. And Advanced Blending's Blend Clipped
// Layers as Group, Transparency Shapes Layer and Vector Mask Hides Effects,
// stored only off their defaults, in the PSD as ag-psd can write them.
import {
  defaultStyle,
  normalizeStyle,
  normalizeShadow,
  normalizeInnerShadow,
  normalizeOverlay,
  normalizeGradientOverlay,
  normalizeStrokeEffect,
  normalizeBlending,
  defaultBlending,
  blendingSwitch,
  fxStored,
  fxReset,
  FX_INSTANCES_MAX,
  BLENDING_SWITCHES,
} from './data.js';
import { boxEffects, boxShadows, usesBackdrop, setGlobalLight } from './text-paint.js';
import { pagePsdDocument, textLayerFor, writePagePsd } from './psd.js';
import { validateStylePatch } from './agent/style-schema.js';

const READ = { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true };
const rendered = { imageData: { width: 10, height: 6, data: new Uint8ClampedArray(10 * 6 * 4) }, left: 3, top: 4, right: 13, bottom: 10, opacity: 1 };
const plain = { ...defaultStyle(), strokeEffects: [], shadows: [] };
const layerFor = (style) => textLayerFor({ lines: [] }, { lineN: null, text: 'hi', x: 0, y: 0, w: 40, h: 20, style: normalizeStyle({ ...plain, ...style }) }, rendered);
function roundTrip(layer) {
  const doc = pagePsdDocument({ w: 32, h: 32, textLayers: [layer], project: { v: 1 } });
  const psd = readPsd(writePagePsd(doc), READ);
  return psd.children.find((c) => c.name === 'Text').children[0];
}

afterEach(() => setGlobalLight({ angle: 120, altitude: 30 }));

const LISTS = [
  ['shadows', normalizeShadow],
  ['innerShadows', normalizeInnerShadow],
  ['colorOverlays', normalizeOverlay],
  ['gradientOverlays', normalizeGradientOverlay],
  ['strokeEffects', normalizeStrokeEffect],
];

describe('the multi effects in the style', () => {
  it('stores an instance switch only when it is off', () => {
    for (const [key, norm] of LISTS) {
      expect('on' in norm({}), key).toBe(false);
      expect('on' in norm({ on: true }), key).toBe(false);
      expect(norm({ on: false }).on, key).toBe(false);
      // Anything but false is on: an old file never says.
      expect('on' in norm({ on: 'no' }), key).toBe(false);
    }
  });

  it('keeps at most ten of each, the first ten', () => {
    for (const [key, norm] of LISTS) {
      const many = Array.from({ length: FX_INSTANCES_MAX + 3 }, (_, i) => ({ ...norm({}), opacity: (i + 1) / 20 }));
      const out = normalizeStyle({ [key]: many })[key];
      expect(out, key).toHaveLength(FX_INSTANCES_MAX);
      expect(out.map((x) => x.opacity), key).toEqual(many.slice(0, FX_INSTANCES_MAX).map((x) => x.opacity));
    }
    expect(FX_INSTANCES_MAX).toBe(10);
  });

  it('loads a style saved before the switches as it was', () => {
    const old = { shadows: [{ x: 2, y: 3, size: 4, color: '#000000', opacity: 0.5 }], colorOverlays: [{ color: '#ff0000', opacity: 1, blend: 'normal' }] };
    const s = normalizeStyle(old);
    expect(s.shadows[0]).not.toHaveProperty('on');
    expect(s.colorOverlays[0]).not.toHaveProperty('on');
    // And saves again exactly as it read.
    expect(normalizeStyle(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('leaves out the instances switched off from what the engine paints', () => {
    const style = normalizeStyle({
      shadows: [normalizeShadow({ color: '#ff0000' }), normalizeShadow({ color: '#00ff00', on: false })],
      innerShadows: [normalizeInnerShadow({ on: false }), normalizeInnerShadow({ color: '#0000ff' })],
      colorOverlays: [normalizeOverlay({ on: false }), normalizeOverlay({ color: '#00ffff' })],
      gradientOverlays: [normalizeGradientOverlay({ on: false })],
      // Inside, so neither is an outline band: both are the Rust engine's.
      strokeEffects: [normalizeStrokeEffect({ size: 3, position: 'inside', on: false }), normalizeStrokeEffect({ size: 2, position: 'inside', color: '#ff00ff' })],
    });
    expect(boxShadows(style).map((sh) => sh.color)).toEqual(['#ff0000']);
    const fx = boxEffects(style);
    expect(fx.map((e) => e.kind)).toEqual(['innerShadow', 'colorOverlay', 'stroke']);
    expect(fx.find((e) => e.kind === 'innerShadow').color).toBe('#0000ff');
    expect(fx.find((e) => e.kind === 'colorOverlay').color).toBe('#00ffff');
    expect(fx.find((e) => e.kind === 'stroke').size).toBe(2);
    // A Screen shadow that is switched off does not read the page.
    expect(usesBackdrop(normalizeStyle({ shadows: [normalizeShadow({ blend: 'screen', color: '#ff0000', on: false })] }))).toBe(false);
    expect(usesBackdrop(normalizeStyle({ shadows: [normalizeShadow({ blend: 'screen', color: '#ff0000' })] }))).toBe(true);
  });

  it('keeps the switch out of a saved default, and an instance keeps its own through a reset', () => {
    expect(fxStored('dropShadow', normalizeShadow({ on: false }))).not.toHaveProperty('on');
    expect(fxStored('colorOverlay', normalizeOverlay({ on: false }))).not.toHaveProperty('on');
    expect(fxReset('colorOverlay', normalizeOverlay({ on: false })).on).toBe(false);
    expect(fxReset('colorOverlay', normalizeOverlay({}))).not.toHaveProperty('on');
  });
});

describe('the Advanced Blending switches', () => {
  it('are stored only off their Photoshop defaults', () => {
    expect(BLENDING_SWITCHES).toEqual({ blendClipped: true, transparencyShapes: true, vectorMaskHidesEffects: false });
    expect(normalizeBlending({ blendClipped: true, transparencyShapes: true, vectorMaskHidesEffects: false })).toEqual(defaultBlending());
    const off = normalizeBlending({ blendClipped: false, transparencyShapes: false, vectorMaskHidesEffects: true });
    expect(off).toMatchObject({ blendClipped: false, transparencyShapes: false, vectorMaskHidesEffects: true });
    // Anything unreadable is the default.
    expect(normalizeBlending({ blendClipped: 0, transparencyShapes: 'off' })).toEqual(defaultBlending());
    expect(blendingSwitch(defaultBlending(), 'transparencyShapes')).toBe(true);
    expect(blendingSwitch(off, 'transparencyShapes')).toBe(false);
    expect(blendingSwitch(undefined, 'vectorMaskHidesEffects')).toBe(false);
  });

  it('take the agent schema, with the instance switch and the cap', () => {
    expect(validateStylePatch({ blending: { blendClipped: false, transparencyShapes: false, vectorMaskHidesEffects: true } })).toEqual([]);
    expect(validateStylePatch({ blending: { transparencyShapes: 'no' } })).not.toEqual([]);
    expect(validateStylePatch({ shadows: [{ on: false }] })).toEqual([]);
    expect(validateStylePatch({ colorOverlays: Array.from({ length: FX_INSTANCES_MAX + 1 }, () => ({})) })).not.toEqual([]);
  });
});

describe('the PSD', () => {
  it('writes an instance switched off unticked, and keeps it in the list', () => {
    const layer = layerFor({
      shadows: [normalizeShadow({}), normalizeShadow({ on: false })],
      innerShadows: [normalizeInnerShadow({ on: false })],
      colorOverlays: [normalizeOverlay({ on: false }), normalizeOverlay({})],
      gradientOverlays: [normalizeGradientOverlay({ on: false })],
      strokeEffects: [normalizeStrokeEffect({ size: 2, position: 'inside', on: false })],
    });
    const fx = layer.effects;
    expect(fx.dropShadow.map((e) => e.enabled)).toEqual([true, false]);
    expect(fx.innerShadow.map((e) => e.enabled)).toEqual([false]);
    expect(fx.solidFill.map((e) => e.enabled)).toEqual([false, true]);
    expect(fx.gradientOverlay.map((e) => e.enabled)).toEqual([false]);
    expect(fx.stroke.map((e) => e.enabled)).toEqual([false]);
    const back = roundTrip(layer).effects;
    expect(back.dropShadow.map((e) => e.enabled)).toEqual([true, false]);
    expect(back.solidFill.map((e) => e.enabled)).toEqual([false, true]);
    expect(back.stroke.map((e) => e.enabled)).toEqual([false]);
  });

  it('writes an Outside outline stroke switched off unticked too, after the outlines', () => {
    // Off, it makes no outline band (`outlineRun`), so the writer takes it
    // as a Photoshop stroke, unticked, rather than drop it.
    const layer = layerFor({
      strokeEffects: [normalizeStrokeEffect({ size: 4, color: '#000000', on: false }), normalizeStrokeEffect({ size: 6, color: '#ffffff' })],
    });
    expect(layer.effects.stroke.map((e) => [e.enabled, e.size.value])).toEqual([[true, 6], [false, 4]]);
    expect(roundTrip(layer).effects.stroke.map((e) => e.enabled)).toEqual([true, false]);
  });

  it('writes Blend Clipped Layers as Group and Transparency Shapes Layer off, and nothing at the defaults', () => {
    const plainLayer = layerFor({});
    expect(plainLayer).not.toHaveProperty('blendClippendElements');
    expect(plainLayer).not.toHaveProperty('transparencyShapesLayer');
    const layer = layerFor({ blending: normalizeBlending({ blendClipped: false, transparencyShapes: false, vectorMaskHidesEffects: true }) });
    expect(layer).toMatchObject({ blendClippendElements: false, transparencyShapesLayer: false });
    const back = roundTrip(layer);
    expect(back.blendClippendElements).toBe(false);
    expect(back.transparencyShapesLayer).toBe(false);
  });
});
