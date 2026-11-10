import { afterEach, describe, expect, it } from 'vitest';
import { readPsd } from 'ag-psd';

// A foreign PSD's type layers bring their layer style in (`styleFromPsdLayer`):
// written by this app, read back by ag-psd as Photoshop would hand it over
// with the embedded project gone, and imported, a style comes back as it was.
import { pagePsdDocument, textLayerFor, writePagePsd, reconstructForeign, styleFromPsdLayer, FILL_GRADIENT_NAME } from './psd.js';
import { defaultStyle, normalizeStyle, strokesFromBands, outlineBands } from './data.js';
import { setGlobalLight, resolveShadow } from './text-paint.js';

const READ = { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true };
const rendered = { imageData: { width: 10, height: 6, data: new Uint8ClampedArray(10 * 6 * 4) }, left: 3, top: 4, right: 13, bottom: 10, opacity: 1 };

afterEach(() => setGlobalLight({ angle: 120, altitude: 30 }));

// Our export, read as a foreign file: no embedded project, the layers only.
async function throughPsd(style) {
  const box = { lineN: null, text: 'hi', x: 0, y: 0, w: 120, h: 60, style: normalizeStyle({ ...defaultStyle(), ...style }) };
  const layer = textLayerFor({ lines: [] }, box, rendered);
  expect(layer.text).toBeTruthy();
  const doc = pagePsdDocument({ w: 200, h: 200, textLayers: [layer], project: { v: 1 } });
  const psd = readPsd(writePagePsd(doc), READ);
  const page = await reconstructForeign(psd);
  return { before: box.style, after: normalizeStyle({ ...defaultStyle(), ...page.boxes[0].style }) };
}

// Equal, numbers to within the file's rounding.
function expectSame(back, want, path = 'style') {
  if (Array.isArray(want)) {
    expect(back, path).toHaveLength(want.length);
    want.forEach((w, i) => expectSame(back[i], w, `${path}[${i}]`));
  } else if (want && typeof want === 'object') {
    for (const k of Object.keys(want)) expectSame(back?.[k], want[k], `${path}.${k}`);
  } else if (typeof want === 'number') {
    expect(back, path).toBeCloseTo(want, 4);
  } else {
    expect(back, path).toEqual(want);
  }
}

const stops = [
  { color: '#ff0000', pos: 0, opacity: 1 },
  { color: '#00ff00', pos: 0.4, opacity: 0.6 },
  { color: '#0000ff', pos: 1, opacity: 0.2 },
];

describe('a PSD layer style comes back through a foreign import', () => {
  it('shadows, inner shadows, glows, satin and colour overlays', async () => {
    setGlobalLight({ angle: 135, altitude: 40 });
    const style = {
      shadows: [
        { x: 3, y: 4, size: 7, spread: 0.2, color: '#123456', opacity: 0.6, noise: 0.1, blend: 'multiply', contour: { preset: 'cone', aa: true }, knockout: true },
        { x: 0, y: 6, size: 3, opacity: 0.5, useGlobalLight: true, contour: { preset: 'custom', pts: [[0, 0, false], [90, 200, false], [255, 40, false]] } },
      ],
      innerShadows: [{ x: -2, y: 0, size: 4, choke: 0.3, color: '#ff00ff', opacity: 0.4, blend: 'screen' }],
      outerGlow: { on: true, blend: 'linear-dodge', opacity: 0.7, noise: 0.05, color: '#00ffff', technique: 'precise', spread: 0.1, size: 9, contour: { preset: 'gaussian' }, range: 0.6, jitter: 0.3 },
      innerGlow: { on: true, fill: 'gradient', gradient: { style: 'radial', reverse: true, stops }, source: 'center', size: 6 },
      satin: { on: true, blend: 'overlay', color: '#336699', opacity: 0.4, angle: 45, distance: 7, size: 9, contour: { preset: 'ring', aa: true }, invert: false },
      colorOverlays: [{ color: '#aa5500', opacity: 0.3, blend: 'color-burn' }],
    };
    const { before, after } = await throughPsd(style);
    expectSame(after.shadows, before.shadows.map(resolveShadow));
    expect(after.shadows[1].useGlobalLight).toBe(true);
    expectSame(after.innerShadows, before.innerShadows);
    expectSame(after.outerGlow, before.outerGlow);
    expectSame(after.innerGlow, before.innerGlow);
    expectSame(after.satin, before.satin);
    expectSame(after.colorOverlays, before.colorOverlays);
  });

  it('gradient overlays, the fill gradient, Photoshop strokes and the outlines', async () => {
    const style = {
      gradient: { on: true, angle: 180, stops: [{ color: '#000000', pos: 0, opacity: 1 }, { color: '#ffffff', pos: 1, opacity: 1 }] },
      gradientOverlays: [
        { blend: 'multiply', opacity: 0.5, gradient: { style: 'reflected', angle: 30, scale: 0.7, offset: [0.1, -0.2], reverse: true, stops } },
        { gradient: { style: 'linear', angle: -60, type: 'noise', noise: { seed: 42, roughness: 0.8, model: 'hsb', min: [0.1, 0.2, 0.3], max: [0.9, 0.8, 0.7], restrict: false, transparency: true } } },
      ],
      strokeEffects: [
        // The outlines: two bands at the head of the list.
        ...strokesFromBands([{ color: '#ffffff', width: 3, opacity: 1 }, { color: '#000000', width: 2, opacity: 0.5 }]),
        // The review's case: a 1 px Inside stroke, which used to vanish.
        { size: 1, position: 'inside', color: '#00ff00' },
        { size: 4, position: 'center', blend: 'multiply', opacity: 0.5, fill: 'gradient', gradient: { style: 'angle', angle: 10, scale: 1.2, stops } },
        // Outside, a colour, Normal: what an outline is, and still a Photoshop stroke.
        { size: 2, position: 'outside', color: '#ff0000' },
      ],
    };
    const { before, after } = await throughPsd(style);
    expect(outlineBands(before)).toHaveLength(2);
    expectSame(outlineBands(after), outlineBands(before));
    expectSame(after.gradient, { on: true, kind: 'linear', angle: 180, stops: before.gradient.stops });
    expectSame(after.gradientOverlays, before.gradientOverlays);
    expectSame(after.strokeEffects.map(({ pattern, ...k }) => k), before.strokeEffects.map(({ pattern, ...k }) => k));
  });

  it('the bevel and the blending options', async () => {
    setGlobalLight({ angle: 100, altitude: 50 });
    const style = {
      bevel: {
        on: true, style: 'emboss', technique: 'chisel-soft', depth: 2.5, direction: 'down', size: 8, soften: 3, useGlobalLight: true,
        gloss: { preset: 'cove-deep', aa: true }, highlight: { blend: 'color-dodge', color: '#ffeedd', opacity: 0.6 }, shadow: { blend: 'darken', color: '#001122', opacity: 0.3 },
        contour: { on: true, curve: { preset: 'linear', aa: true }, range: 0.4 },
      },
      blendMode: 'hard-light',
      opacity: 0.8,
      fillOpacity: 0.5,
      blending: { interior: true, knockout: 'shallow', blendIf: { gray: { this: [0, 20, 230, 255] }, blue: { under: [10, 40, 255, 255] } } },
    };
    const { before, after } = await throughPsd(style);
    // Channels: ag-psd's reader drops the last channel left out (its `brst`
    // loop stops while 4 bytes are left), so the layer record is read here.
    expect(styleFromPsdLayer({ channelBlendingRestrictions: [1] }).blending.channels).toEqual({ r: true, g: false, b: true });
    expectSame(after.bevel, { ...before.bevel, angle: 100, altitude: 50 });
    expect(after.blendMode).toBe('hard-light');
    expect(after.opacity).toBe(0.8);
    expect(after.fillOpacity).toBe(0.5);
    expectSame(after.blending, before.blending);
  });

  it('a switched-off shadow or overlay comes back switched off, not dropped', async () => {
    const { after } = await throughPsd({
      shadows: [{ on: false, x: 3, y: 3, size: 4, color: '#000000', opacity: 0.5 }, { x: -2, y: 2, size: 1, color: '#ff0000', opacity: 1 }],
      colorOverlays: [{ on: false, color: '#00ff00', opacity: 1, blend: 'normal' }],
    });
    expect(after.shadows.map((sh) => sh.on !== false)).toEqual([false, true]);
    expect(after.colorOverlays.map((o) => [o.on !== false, o.color])).toEqual([[false, '#00ff00']]);
  });

  it('a layer with no effects comes back with none, not the defaults', async () => {
    const { after } = await throughPsd({ strokeEffects: [], shadows: [] });
    expect(outlineBands(after)).toEqual([]);
    expect(after.shadows).toEqual([]);
    expect(after.strokeEffects).toEqual([]);
    expect(after.outerGlow.on).toBe(false);
    expect(after.bevel.on).toBe(false);
  });
});

describe('a Photoshop file', () => {
  it('reads every stroke Photoshop saved (Overprint on each) as a Photoshop stroke, and skips what is not present', () => {
    const stroke = (o) => ({ enabled: true, present: true, position: 'outside', fillType: 'color', blendMode: 'normal', opacity: 1, size: { units: 'Pixels', value: 3 }, color: { r: 0, g: 0, b: 0 }, overprint: false, ...o });
    const style = styleFromPsdLayer({
      effects: {
        stroke: [stroke({}), stroke({ position: 'inside', size: { units: 'Pixels', value: 1 } }), stroke({ present: false })],
        dropShadow: [{ enabled: false, size: { value: 5 } }],
      },
    });
    expect('strokes' in style).toBe(false);
    expect(style.strokeEffects.map((k) => [k.position, k.size])).toEqual([['outside', 3], ['inside', 1]]);
    // An unticked shadow comes in switched off, not dropped (`instanceOn`).
    expect(style.shadows.map((sh) => [sh.on, sh.size])).toEqual([[false, 5]]);
    // With no Overprint flag (an older writer), an Outside colour stroke is an outline.
    expect(styleFromPsdLayer({ effects: { stroke: [stroke({ overprint: undefined })] } })).toEqual(
      expect.objectContaining({ strokeEffects: strokesFromBands([{ color: '#000000', width: 3, opacity: 1 }]) }),
    );
  });

  // A foreign overlay that leaves out its mode, scale and offset, as the
  // writer's fill gradient does, is still an overlay: only the writer's mark
  // makes it the fill.
  it('keeps a foreign overlay with no mode, scale or offset an overlay', () => {
    const ramp = { type: 'solid', colorStops: [{ color: { r: 255, g: 0, b: 0 }, location: 0 }, { color: { r: 0, g: 0, b: 255 }, location: 1 }], opacityStops: [{ opacity: 1, location: 0 }, { opacity: 1, location: 1 }] };
    const overlay = (name) => ({ enabled: true, opacity: 1, angle: 30, type: 'linear', gradient: { ...ramp, name } });
    for (const name of ['Custom', 'Foreground to Background', undefined]) {
      const style = styleFromPsdLayer({ effects: { gradientOverlay: [overlay(name)] } });
      expect(style.gradient, String(name)).toBeUndefined();
      expect(style.gradientOverlays).toHaveLength(1);
      expect(style.gradientOverlays[0].gradient).toMatchObject({ angle: 30, stops: [{ color: '#ff0000' }, { color: '#0000ff' }] });
    }
    // The writer's own, by its name: the fill, at 90 less the angle.
    const fill = styleFromPsdLayer({ effects: { gradientOverlay: [overlay(FILL_GRADIENT_NAME)] } });
    expect(fill.gradientOverlays).toEqual([]);
    expect(fill.gradient).toMatchObject({ on: true, angle: 60 });
    // Its name with a mode of its own is not the writer's either.
    expect(styleFromPsdLayer({ effects: { gradientOverlay: [{ ...overlay(FILL_GRADIENT_NAME), blendMode: 'multiply' }] } }).gradient).toBeUndefined();
  });
});
