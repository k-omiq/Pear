import { describe, expect, it } from 'vitest';
import { readPsd } from 'ag-psd';

// ===========================================================================
// Photoshop's Stroke > Overprint (`strokeEffects[i].overprint`)
// ===========================================================================
// Reference: PhotoCraft (external/photocraft, dada110), its own test cases
// ported:
//   - crates/io/src/effects_map/tests.rs `stroke_overprint_is_read_and_written`:
//     Overprint off and on both come back from the PSD as written, and a
//     stroke with no `overprint` key (another writer) reads as off.
//   - crates/engine/src/layer_style/tests.rs `stroke_overprint_is_a_param`:
//     the setting is a plain on/off a stroke keeps.
// PhotoCraft stores Overprint and never paints it (no reader in
// crates/compose or crates/gpu; docs/file-format-parity.md: "Rendering
// ignores it for now"), and Photoshop documents no rule for it, so ours is
// stored and written to the PSD, not painted. The "does not paint" guard is
// stroke-overprint.engine.test.js.
import { pagePsdDocument, textLayerFor, writePagePsd, styleFromPsdLayer } from './psd.js';
import { defaultStyle, normalizeStyle, normalizeStrokeEffect, newStrokeEffect } from './data.js';
import { validateStylePatch } from './agent/style-schema.js';

const READ = { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true };
const rendered = { imageData: { width: 10, height: 6, data: new Uint8ClampedArray(10 * 6 * 4) }, left: 3, top: 4, right: 13, bottom: 10, opacity: 1 };
const styleWith = (strokeEffects) => normalizeStyle({ ...defaultStyle(), strokes: [], shadows: [], strokeEffects });
const layerFor = (style) => textLayerFor({ lines: [] }, { lineN: null, text: 'hi', x: 0, y: 0, w: 40, h: 20, style }, rendered);
function readBack(layer) {
  const psd = readPsd(writePagePsd(pagePsdDocument({ w: 32, h: 32, textLayers: [layer], project: { v: 1 } })), READ);
  return psd.children.find((c) => c.name === 'Text').children[0];
}
// A stroke as ag-psd hands one over from a file.
const psdStroke = (o) => ({ enabled: true, present: true, position: 'outside', fillType: 'color', blendMode: 'normal', opacity: 1, size: { units: 'Pixels', value: 3 }, color: { r: 0, g: 0, b: 0 }, ...o });

describe('Stroke Overprint in the PSD (PhotoCraft stroke_overprint_is_read_and_written)', () => {
  it.each([false, true])('writes Overprint %s and reads it back', (overprint) => {
    const style = styleWith([normalizeStrokeEffect({ size: 4, position: 'center', blend: 'multiply', color: '#112233', overprint })]);
    const layer = layerFor(style);
    // The outline (none here) is not in the list; the one Photoshop stroke is.
    expect(layer.effects.stroke).toHaveLength(1);
    expect(layer.effects.stroke[0].overprint).toBe(overprint);
    const back = readBack(layer);
    expect(back.effects.stroke[0].overprint).toBe(overprint);
    const [k] = styleFromPsdLayer(back).strokeEffects;
    expect(k).toMatchObject({ size: 4, position: 'center', blend: 'multiply' });
    expect('overprint' in k).toBe(overprint);
    if (overprint) expect(k.overprint).toBe(true);
  });

  it('reads a stroke with no Overprint key as off', () => {
    const { strokes, strokeEffects } = styleFromPsdLayer({ effects: { stroke: [psdStroke({ position: 'inside' })] } });
    expect(strokes).toEqual([]);
    expect(strokeEffects).toHaveLength(1);
    expect('overprint' in strokeEffects[0]).toBe(false);
  });

  it('keeps an outline-shaped stroke with Overprint on a Photoshop stroke, not an outline', () => {
    // Outside, a colour, Normal, the head of the list: with no key this is
    // one of our outlines; the key (on or off) marks Photoshop's strokes.
    const noKey = styleFromPsdLayer({ effects: { stroke: [psdStroke({})] } });
    expect(noKey.strokes).toEqual([{ color: '#000000', width: 3, opacity: 1 }]);
    expect(noKey.strokeEffects).toEqual([]);
    for (const overprint of [true, false]) {
      const style = styleFromPsdLayer({ effects: { stroke: [psdStroke({ overprint })] } });
      expect(style.strokes, String(overprint)).toEqual([]);
      expect(style.strokeEffects, String(overprint)).toHaveLength(1);
      expect(style.strokeEffects[0].position).toBe('outside');
      expect('overprint' in style.strokeEffects[0]).toBe(overprint);
    }
  });

  it('leaves our own outlines without the key, so they still split as outlines', () => {
    const style = normalizeStyle({ ...defaultStyle(), strokes: [{ color: '#ffffff', width: 3, opacity: 1 }], shadows: [], strokeEffects: [normalizeStrokeEffect({ size: 2, overprint: true })] });
    const back = readBack(layerFor(style));
    expect(back.effects.stroke.map((e) => e.overprint)).toEqual([undefined, true]);
    const got = styleFromPsdLayer(back);
    expect(got.strokes).toHaveLength(1);
    expect(got.strokeEffects).toHaveLength(1);
    expect(got.strokeEffects[0].overprint).toBe(true);
  });
});

describe('Stroke Overprint in the style (PhotoCraft stroke_overprint_is_a_param)', () => {
  it('is kept only when on', () => {
    expect(normalizeStrokeEffect({ overprint: true }).overprint).toBe(true);
    for (const v of [false, undefined, 1, 'yes', null]) expect('overprint' in normalizeStrokeEffect({ overprint: v }), String(v)).toBe(false);
    expect('overprint' in newStrokeEffect()).toBe(false);
  });

  it('leaves a style saved before it byte-identical', () => {
    const old = { ...defaultStyle(), strokeEffects: [{ size: 3, position: 'outside', blend: 'multiply', opacity: 0.5, fill: 'color', color: '#123456' }] };
    const once = JSON.stringify(normalizeStyle(old));
    expect(once).not.toContain('overprint');
    expect(JSON.stringify(normalizeStyle(JSON.parse(once)))).toBe(once);
    const on = normalizeStyle({ ...old, strokeEffects: [{ ...old.strokeEffects[0], overprint: true }] });
    expect(on.strokeEffects[0].overprint).toBe(true);
    expect(JSON.stringify(normalizeStyle(JSON.parse(JSON.stringify(on))))).toBe(JSON.stringify(on));
  });

  it('is an on/off the agent may set', () => {
    const stored = styleWith([newStrokeEffect()]);
    expect(validateStylePatch({ strokeEffects: { 0: { overprint: true } } }, stored)).toEqual([]);
    expect(validateStylePatch({ strokeEffects: { 0: { overprint: 3 } } }, stored)).not.toEqual([]);
  });
});
