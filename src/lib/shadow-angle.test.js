import { afterEach, describe, expect, it } from 'vitest';
import { readPsd } from 'ag-psd';

// F48: a shadow off the Global Light keeps its own angle where its offset
// cannot say it (Distance 0), in the style itself (`angle`), so a save, a
// reload, an undo and a PSD keep it. Photoshop stores Angle and Distance
// (PhotoCraft's `Shadow`, crates/doc/src/effects.rs); a style stores x, y and
// the angle beside them only when it is needed.
import {
  defaultStyle,
  normalizeStyle,
  normalizeShadow,
  normalizeInnerShadow,
  shadowOwnAngle,
  storedShadowAngle,
  fxStored,
  newFx,
  setFxDefaults,
} from './data.js';
import { shadowAngle, setGlobalLight } from './text-paint.js';
import { pagePsdDocument, textLayerFor, writePagePsd } from './psd.js';
import { rescaleStyle } from './store.svelte.js';

afterEach(() => {
  setFxDefaults({});
  setGlobalLight({ angle: 120, altitude: 30 });
});

describe('normalizeShadow keeps an explicit angle only where x, y cannot hold it', () => {
  it('reads an old shadow byte for byte (no angle key)', () => {
    for (const old of [{ x: 4, y: 3, size: 5 }, { x: 0, y: 0 }, { x: -2, y: 7, useGlobalLight: true }, {}]) {
      expect('angle' in normalizeShadow(old)).toBe(false);
      expect(JSON.stringify(normalizeShadow(JSON.parse(JSON.stringify(normalizeShadow(old)))))).toBe(JSON.stringify(normalizeShadow(old)));
    }
  });

  it('keeps the angle at Distance 0 and drops it where the offset gives it', () => {
    expect(normalizeShadow({ x: 0, y: 0, angle: 45 }).angle).toBe(45);
    expect(normalizeInnerShadow({ x: 0, y: 0, angle: -30 }).angle).toBe(-30);
    // 45 at distance 10: x, y say 45 themselves.
    expect('angle' in normalizeShadow({ x: -7.07, y: 7.07, angle: 45 })).toBe(false);
    // Wrapped as Photoshop states it.
    expect(normalizeShadow({ x: 0, y: 0, angle: 225 }).angle).toBe(-135);
  });

  it('keeps an angle finer than the offset says, and the offset wins over a stale one', () => {
    // 30 at distance 1 is (-0.87, 0.5), which reads back as 29.89.
    expect(normalizeShadow({ x: -0.87, y: 0.5, angle: 30 }).angle).toBe(30);
    expect(shadowAngle({ x: -0.87, y: 0.5 })).toBe(29.89);
    expect(shadowAngle({ x: -0.87, y: 0.5, angle: 30 })).toBe(30);
    // An agent moved the shadow without its angle: x, y are what is painted.
    const stale = normalizeShadow({ x: 10, y: 0, angle: 45 });
    expect('angle' in stale).toBe(false);
    expect(shadowAngle({ x: 10, y: 0, angle: 45 })).toBe(180);
  });

  it('has no angle of its own on the Global Light', () => {
    expect('angle' in normalizeShadow({ x: 0, y: 0, angle: 45, useGlobalLight: true })).toBe(false);
    setGlobalLight({ angle: 90 });
    expect(shadowAngle({ x: 0, y: 0, angle: 45, useGlobalLight: true })).toBe(90);
  });

  it('falls back to the light at Distance 0 with no angle', () => {
    setGlobalLight({ angle: 75 });
    expect(shadowOwnAngle({ x: 0, y: 0 })).toBeNull();
    expect(shadowAngle({ x: 0, y: 0 })).toBe(75);
    expect(shadowAngle({ x: 0, y: 0, angle: 10 })).toBe(10);
  });

  it('survives a whole style save and load', () => {
    const st = normalizeStyle({ ...defaultStyle(), shadows: [{ x: 0, y: 0, angle: 45 }], innerShadows: [{ x: 0, y: 0, angle: 12.5 }] });
    const back = normalizeStyle(JSON.parse(JSON.stringify(st)));
    expect(back.shadows[0].angle).toBe(45);
    expect(back.innerShadows[0].angle).toBe(12.5);
  });

  it('storedShadowAngle says what a shadow keeps for a given angle', () => {
    expect(storedShadowAngle({ x: 0, y: 0 }, 60)).toBe(60);
    expect(storedShadowAngle({ x: 0, y: 0, useGlobalLight: true }, 60)).toBeUndefined();
    expect(storedShadowAngle({ x: -5, y: 0 }, 0)).toBeUndefined();
  });
});

describe('a stored default keeps its angle at Distance 0', () => {
  it('fxStored reads the kept angle, newFx throws from it', () => {
    const d = fxStored('dropShadow', normalizeShadow({ x: 0, y: 0, angle: 45, size: 3 }));
    expect(d).toMatchObject({ distance: 0, angle: 45 });
    setFxDefaults({ dropShadow: d });
    expect(newFx('dropShadow', { angle: 120 })).toMatchObject({ x: 0, y: 0, angle: 45 });
  });
});

describe('rescaleStyle turns a kept angle with its axes', () => {
  it('keeps it on an even scale and turns it on an uneven one', () => {
    const st = { shadows: [{ x: 0, y: 0, angle: 45, size: 2 }], innerShadows: [{ x: 0, y: 0, angle: 45, size: 2 }] };
    expect(rescaleStyle(st, 2, 2).shadows[0].angle).toBe(45);
    // (-cos 45, sin 45) scaled by (1, 2): atan2(2, 1).
    expect(rescaleStyle(st, 1, 2).shadows[0].angle).toBe(63.43);
    expect(rescaleStyle(st, 1, 2).innerShadows[0].angle).toBe(63.43);
    expect('angle' in rescaleStyle({ shadows: [{ x: 2, y: 2, size: 2 }] }, 1, 2).shadows[0]).toBe(false);
  });
});

describe('PSD export writes the kept angle', () => {
  const READ = { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true };
  const rendered = { imageData: { width: 10, height: 6, data: new Uint8ClampedArray(10 * 6 * 4) }, left: 3, top: 4, right: 13, bottom: 10, opacity: 1 };
  const layerFor = (style) => textLayerFor({ lines: [] }, { lineN: null, text: 'hi', x: 0, y: 0, w: 40, h: 20, style: normalizeStyle({ ...defaultStyle(), strokeEffects: [], ...style }) }, rendered);
  const roundTrip = (layer) => {
    const psd = readPsd(writePagePsd(pagePsdDocument({ w: 32, h: 32, textLayers: [layer], project: { v: 1 } })), READ);
    return psd.children.find((c) => c.name === 'Text').children[0];
  };

  it('as the Angle of a shadow at Distance 0', () => {
    const layer = layerFor({ shadows: [{ x: 0, y: 0, angle: 45, size: 3 }], innerShadows: [{ x: 0, y: 0, angle: -30, size: 3 }] });
    expect(layer.effects.dropShadow[0].angle).toBe(45);
    expect(layer.effects.innerShadow[0].angle).toBe(-30);
    const back = roundTrip(layer).effects;
    expect(back.dropShadow[0].angle).toBeCloseTo(45, 4);
    expect(back.dropShadow[0].distance.value).toBe(0);
    expect(back.innerShadow[0].angle).toBeCloseTo(-30, 4);
  });

  it('as the Angle of a shadow whose offset rounds it', () => {
    const layer = layerFor({ shadows: [{ x: -0.87, y: 0.5, angle: 30, size: 3 }] });
    expect(layer.effects.dropShadow[0].angle).toBe(30);
  });
});
