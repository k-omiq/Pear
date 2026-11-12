import { describe, expect, it } from 'vitest';
import { readPsd } from 'ag-psd';

// Align with Layer off on a Gradient Overlay and a gradient Stroke: the data,
// the wire, the editor's repaint key and the PSD. The engine's own compare
// against PhotoCraft is text-engine/src/paint/fx/effects_align.rs; the wasm
// end to end is gradient-align.engine.test.js.
import { encodeBox, MAX_PAGE } from '../../text-engine/js/paint.mjs';
import { defaultStyle, normalizeFxGradient, normalizeGlow, normalizeGradientOverlay, normalizeStrokeEffect, normalizeStyle } from './data.js';
import { pageGradients } from './text-paint.js';
import { pageGradientKey, pageSheet, pictureKey } from './editor/box-picture.js';
import { pagePsdDocument, reconstructForeign, textLayerFor, turnedGradientPlacement, writePagePsd, needsGradientFrames, RASTER_MARK } from './psd.js';

const plain = { ...defaultStyle(), strokeEffects: [], shadows: [] };
const off = (o = {}) => normalizeGradientOverlay({ gradient: { angle: 30, scale: 0.8, offset: [0.1, -0.2], align: false, ...o } });
const offStroke = () => normalizeStrokeEffect({ size: 4, position: 'outside', fill: 'gradient', gradient: { angle: 0, align: false } });

describe('the data', () => {
  it('keeps align only when off, so a gradient from before it saves as it was', () => {
    const old = { style: 'radial', angle: 12, scale: 1.2, reverse: true, offset: [0.25, 0], dither: true };
    const g = normalizeFxGradient(old);
    expect('align' in g).toBe(false);
    expect(JSON.stringify(normalizeFxGradient(g))).toBe(JSON.stringify(g));
    expect('align' in normalizeFxGradient({ ...old, align: true })).toBe(false);
    expect(normalizeFxGradient({ ...old, align: false }).align).toBe(false);
    // Anything but false is on.
    expect('align' in normalizeFxGradient({ ...old, align: 'no' })).toBe(false);
    // A whole style from before it is unchanged.
    const st = normalizeStyle({ ...plain, gradientOverlays: [{ gradient: old }], strokeEffects: [{ size: 3, fill: 'gradient', gradient: old }] });
    expect(JSON.stringify(normalizeStyle(st))).toBe(JSON.stringify(st));
    expect(JSON.stringify(st)).not.toContain('"align":false');
  });

  it('leaves it off a glow, whose gradient runs along the glow', () => {
    const glow = normalizeGlow({ on: true, fill: 'gradient', gradient: { align: false, angle: 10 } });
    expect('align' in glow.gradient).toBe(false);
  });

  it('says which boxes paint a gradient over the page', () => {
    expect(pageGradients(normalizeStyle({ ...plain, gradientOverlays: [off()] }))).toBe(true);
    expect(pageGradients(normalizeStyle({ ...plain, strokeEffects: [offStroke()] }))).toBe(true);
    expect(pageGradients(normalizeStyle({ ...plain, gradientOverlays: [off({ align: true })] }))).toBe(false);
    // Switched off, it paints nothing.
    expect(pageGradients(normalizeStyle({ ...plain, gradientOverlays: [{ ...off(), on: false }] }))).toBe(false);
    // A colour stroke has no gradient to lay.
    expect(pageGradients(normalizeStyle({ ...plain, strokeEffects: [{ ...offStroke(), fill: 'color' }] }))).toBe(false);
    // A Shape Burst reads no frame: its kept `align: false` lays nothing over
    // the page, so the box sends no page and needs no page in its key.
    const burst = normalizeStyle({ ...plain, gradientOverlays: [off({ style: 'shapeburst' })] });
    expect(burst.gradientOverlays[0].gradient.align).toBe(false);
    expect(pageGradients(burst)).toBe(false);
    expect(pageSheet({ x: 0, y: 0, w: 10, h: 10, style: burst }, { w: 800, h: 1200 }, null)).toBeNull();
    const burstStroke = normalizeStrokeEffect({ size: 4, position: 'outside', fill: 'gradient', gradient: { style: 'shapeburst', align: false } });
    expect(pageGradients(normalizeStyle({ ...plain, strokeEffects: [burstStroke] }))).toBe(false);
  });
});

describe('the wire (v16)', () => {
  const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const job = { job: { bands: [], runs: [], fill: { kind: 'solid', color: '#000000' } }, font: 0, size: 10, width: 4, height: 4 };
  // The page record comes right after the grain's corner.
  const PAGE_AT = 6 * 4;

  it('sends the page only when given, as the layout onto it and its size', () => {
    expect(dv(encodeBox(job).slice()).getUint32(PAGE_AT, true)).toBe(0);
    const page = { toPage: [0.5, 0.25, -0.25, 0.5, 10.5, 20.25], w: 841, h: 1190 };
    const v = dv(encodeBox({ ...job, page }).slice());
    expect(v.getUint32(PAGE_AT, true)).toBe(1);
    const nums = Array.from({ length: 8 }, (_, i) => v.getFloat64(PAGE_AT + 4 + i * 8, true));
    expect(nums).toEqual([...page.toPage, 841, 1190]);
    // One the engine would refuse is not sent: no size, a flat matrix.
    for (const bad of [{ ...page, w: 0 }, { ...page, toPage: [0, 0, 0, 0, 1, 1] }, { ...page, toPage: [1, 0, 0, 1, NaN, 0] }]) {
      expect(dv(encodeBox({ ...job, page: bad }).slice()).getUint32(PAGE_AT, true)).toBe(0);
    }
  });

  it('sends a page only within the engine\'s MAX_PAGE, a side and every matrix entry', () => {
    const page = { toPage: [0.5, 0.25, -0.25, 0.5, 10.5, 20.25], w: 841, h: 1190 };
    const sent = (p) => dv(encodeBox({ ...job, page: p }).slice()).getUint32(PAGE_AT, true) === 1;
    // The next f64 past 2^20 (its step there is 2^-32).
    const over = MAX_PAGE + 2 ** -32;
    expect(over).toBeGreaterThan(MAX_PAGE);
    for (const k of ['w', 'h']) {
      expect(sent({ ...page, [k]: MAX_PAGE }), k).toBe(true);
      expect(sent({ ...page, [k]: over }), k).toBe(false);
    }
    for (let i = 0; i < 6; i++) {
      for (const sign of [1, -1]) {
        const at = (v) => ({ ...page, toPage: page.toPage.map((x, j) => (j === i ? sign * v : x)) });
        expect(sent(at(MAX_PAGE)), `${sign * i}`).toBe(true);
        expect(sent(at(over)), `${sign * i}`).toBe(false);
      }
    }
  });

  it('sends Align off as gradient flag 2, beside Dither', () => {
    // The flags after the stops and their midpoint counts: a default
    // gradient has 2 colour stops and its opacity stops are all opaque.
    const flagsOf = (gradient) => {
      const v = dv(encodeBox({ ...job, effects: [{ kind: 'gradientOverlay', opacity: 1, blend: 'normal', gradient }] }).slice());
      const head = 4 * 4 + 8 + 4 + 4 + 8 + 4 + 4 + 4 + 4 + 8 + 4 + 4 + 4 + 4 + 4 + 8 + 4 + 4 + 16 + 4; // the fade's u32 (v20) after the mask's, then the pin shift (v23) and the live flag (v24)
      return v.getUint32(head + 4 + 8 + 8 + 4 + 16 + 4 + 2 * 12 + 4 + 4 + 4, true);
    };
    const g = normalizeFxGradient({});
    expect(flagsOf(g)).toBe(0);
    expect(flagsOf({ ...g, dither: true })).toBe(1);
    expect(flagsOf({ ...g, align: false })).toBe(2);
    expect(flagsOf({ ...g, align: false, dither: true })).toBe(3);
  });
});

describe('the editor picture', () => {
  const box = (style, at = {}) => ({ id: 'b', x: 10, y: 20, w: 50, h: 30, ...at, style: normalizeStyle({ ...plain, ...style }) });
  const key = (b, sheet) => pictureKey({ style: b.style, inkKey: '', text: 'hi', w: b.w, h: b.h, lines: null, indents: null, scale: 1, fonts: 0, page: pageGradientKey(b, sheet) });

  it('is keyed by where an Align off box stands, its turn, its mirror and the page', () => {
    const sheet = { w: 800, h: 1200 };
    const b = box({ gradientOverlays: [off()] });
    const k = key(b, sheet);
    expect(key({ ...b, x: 11 }, sheet)).not.toBe(k);
    expect(key(box({ gradientOverlays: [off()], rotation: 10 }), sheet)).not.toBe(k);
    expect(key(box({ gradientOverlays: [off()], rotation: 20 }), sheet)).not.toBe(key(box({ gradientOverlays: [off()], rotation: 10 }), sheet));
    expect(key(box({ gradientOverlays: [off()], flipH: true }), sheet)).not.toBe(k);
    expect(key(box({ gradientOverlays: [off()], flipV: true }), sheet)).not.toBe(k);
    expect(key(b, { w: 800, h: 1100 })).not.toBe(k);
  });

  it('leaves any other box keyed as before: a move or a turn repaints nothing', () => {
    const sheet = { w: 800, h: 1200 };
    const b = box({ gradientOverlays: [off({ align: true })] });
    expect(pageGradientKey(b, sheet)).toBe('');
    expect(key({ ...b, x: 99 }, sheet)).toBe(key(b, sheet));
    expect(key(box({ gradientOverlays: [off({ align: true })], rotation: 10 }), sheet)).toBe(key(b, sheet));
  });

  it('knows the page once it is measured, or from its art, and not before', () => {
    const b = box({ gradientOverlays: [off()] });
    expect(pageSheet(b, { w: 800, h: 1200 })).toEqual({ w: 800, h: 1200 });
    expect(pageSheet(b, { w: 0, h: 0 }, { naturalWidth: 640, naturalHeight: 960 })).toEqual({ w: 640, h: 960 });
    expect(pageSheet(b, { w: 0, h: 0 })).toBe(null);
    expect(pageSheet(b, undefined)).toBe(null);
    expect(pageSheet(box({}), { w: 800, h: 1200 })).toBe(null);
    // No page, no key: the box paints as Align on until the page is known.
    expect(pageGradientKey(b, null)).toBe('');
  });
});

describe('the PSD', () => {
  const READ = { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true };
  const rendered = { imageData: { width: 10, height: 6, data: new Uint8ClampedArray(10 * 6 * 4) }, left: 3, top: 4, right: 13, bottom: 10, opacity: 1 };
  const box = (style) => ({ lineN: null, text: 'hi', x: 100, y: 60, w: 120, h: 40, style: normalizeStyle({ ...plain, ...style }) });

  it('writes Align off with the page angle as it is, on a turned box too, with no re-placement', () => {
    const style = { rotation: 30, gradientOverlays: [off()], strokeEffects: [offStroke()] };
    // An Align off gradient needs no letters' frames, and does not send a
    // turned box to pixels.
    expect(needsGradientFrames(box(style).style)).toBe(false);
    const layer = textLayerFor({ lines: [] }, box(style), rendered);
    expect(layer.text).toBeTruthy();
    expect(layer.effects.gradientOverlay[0]).toMatchObject({ align: false, angle: 30, scale: 0.8, offset: { x: 0.1, y: -0.2 } });
    expect(layer.effects.stroke.at(-1).gradient).toMatchObject({ align: false, angle: 0 });
    // Align on next to it keeps its turn.
    const mixed = textLayerFor({ lines: [] }, box({ rotation: 30, gradientOverlays: [off(), off({ align: true })] }), rendered);
    expect(mixed.effects.gradientOverlay.map((o) => [o.align, o.angle])).toEqual([
      [false, 30],
      [true, 0],
    ]);
  });

  it('places a longstrip neighbour\'s Align off gradient against the document it lands in', () => {
    const style = { gradientOverlays: [off()] };
    // The owner's size comes in `doc` (w, h), the size its pixels were
    // painted over (`pageTextLayers`), not from the page record itself.
    const owner = { lines: [], w: 0, h: 0 };
    const doc = { dx: 0, dy: -600, W: 800, H: 1000, w: 800, h: 600 };
    const layer = textLayerFor(owner, box(style), rendered, doc);
    const g = box(style).style.gradientOverlays[0].gradient;
    const q = turnedGradientPlacement(g, 0, { local: [0, -600, 800, 0], page: [0, 0, 800, 1000], centre: [0, 0] });
    expect(q.fits).toBe(true);
    expect(layer.effects.gradientOverlay[0]).toMatchObject({ align: false, angle: 30, scale: q.scale, offset: q.offset });
    // Its centre lands where it was: 0.1 of the owner page right of its
    // middle, 0.2 up, which is above this document.
    expect(400 + q.offset.x * 800).toBeCloseTo(400 + 0.1 * 800, 6);
    expect(500 + q.offset.y * 1000).toBeCloseTo(-300 - 0.2 * 600, 6);
    // Past Photoshop's scale against a far wider document (10 % of an 800 px
    // page is 1 % of an 8000 px one): the pixels go instead.
    const far = textLayerFor(owner, box({ gradientOverlays: [off({ scale: 0.1 })] }), rendered, { dx: 0, dy: 0, W: 8000, H: 600, w: 800, h: 600 });
    expect('text' in far).toBe(false);
    expect(far.name.endsWith(RASTER_MARK)).toBe(true);
  });

  it('reads Align off back from the overlay and the gradient stroke, and on as on', async () => {
    const b = box({ gradientOverlays: [off(), off({ align: true, angle: 50 })], strokeEffects: [offStroke()] });
    const layer = textLayerFor({ lines: [] }, b, rendered);
    const psd = readPsd(writePagePsd(pagePsdDocument({ w: 400, h: 300, textLayers: [layer], project: { v: 1 } })), READ);
    const back = psd.children.find((c) => c.name === 'Text').children[0];
    expect(back.effects.gradientOverlay.map((o) => o.align)).toEqual([false, true]);
    expect(back.effects.stroke.at(-1).gradient.align).toBe(false);
    const page = await reconstructForeign(psd);
    const st = normalizeStyle({ ...defaultStyle(), ...page.boxes[0].style });
    expect(st.gradientOverlays.map((o) => o.gradient.align)).toEqual([false, undefined]);
    expect(st.gradientOverlays[0].gradient.angle).toBeCloseTo(30, 4);
    expect(st.strokeEffects[0].gradient.align).toBe(false);
  });
});
