import { describe, it, expect } from 'vitest';
import { defaultStyle, normalizeStyle, normalizeBlending, normalizeBlendRange, defaultBlending, blendIfActive } from './data.js';
import { usesBackdrop, blendingRestricts } from './text-paint.js';
import { BOX_WIRE_VERSION, encodeBox } from '../../text-engine/js/paint.mjs';
import { boxToPage } from './backdrop.js';
import { pageArtSrc } from './page-art.svelte.js';
import { pictureKey, pageUnderKey } from './editor/box-picture.js';

// ===========================================================================
// The page backdrop (LAYER_STYLES_PLAN.md phase 6a): which boxes blend with
// the page art, what their picture is keyed by, and where they stand on it.
// ===========================================================================

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), ...over });
const shadow = (over = {}) => ({ x: 4, y: 4, size: 2, color: '#000000', opacity: 0.75, blend: 'multiply', ...over });

describe('usesBackdrop', () => {
  it('is false for a plain box and for every default effect', () => {
    expect(usesBackdrop(style())).toBe(false);
    // The default drop shadow is black Multiply: exactly Normal.
    expect(usesBackdrop(style({ shadows: [shadow()] }))).toBe(false);
    expect(usesBackdrop(style({ shadows: [shadow({ blend: 'darken' })] }))).toBe(false);
    expect(usesBackdrop(style({ shadows: [shadow({ blend: 'linear-burn' })] }))).toBe(false);
    // White under Screen is Normal white.
    expect(usesBackdrop(style({ shadows: [shadow({ color: '#ffffff', blend: 'screen' })] }))).toBe(false);
    // The default bevel: Screen white and Multiply black.
    expect(usesBackdrop(style({ bevel: { on: true, style: 'emboss' } }))).toBe(false);
    // Dissolve reads nothing of the page.
    expect(usesBackdrop(style({ blendMode: 'dissolve' }))).toBe(false);
    // Effects that blend with the letters alone.
    expect(usesBackdrop(style({ colorOverlays: [{ color: '#ff0000', opacity: 1, blend: 'overlay' }] }))).toBe(false);
    expect(usesBackdrop(style({ innerGlow: { on: true, blend: 'color-dodge', color: '#ff0000' } }))).toBe(false);
    expect(usesBackdrop(style({ bevel: { on: true, style: 'inner', highlight: { blend: 'overlay', color: '#ff0000', opacity: 1 } } }))).toBe(false);
  });

  it('is true for a box mode, and for an outside effect in a mode that reads the page', () => {
    for (const m of ['multiply', 'screen', 'overlay', 'difference', 'color-dodge', 'luminosity']) expect(usesBackdrop(style({ blendMode: m }))).toBe(true);
    // A coloured Multiply shadow, a black Screen one.
    expect(usesBackdrop(style({ shadows: [shadow({ color: '#ff0000' })] }))).toBe(true);
    expect(usesBackdrop(style({ shadows: [shadow({ blend: 'screen' })] }))).toBe(true);
    // A faded-out one reads nothing.
    expect(usesBackdrop(style({ shadows: [shadow({ color: '#ff0000', opacity: 0 })] }))).toBe(false);
    expect(usesBackdrop(style({ outerGlow: { on: true, blend: 'screen', color: '#ffff00', opacity: 0.8 } }))).toBe(true);
    expect(usesBackdrop(style({ outerGlow: { on: false, blend: 'screen', color: '#ffff00', opacity: 0.8 } }))).toBe(false);
    expect(usesBackdrop(style({ bevel: { on: true, style: 'outer', highlight: { blend: 'overlay', color: '#ffffff', opacity: 1 } } }))).toBe(true);
  });

  it('is true for an outside or center stroke whose mode reads the page, and not for an inside one', () => {
    const stroke = (over = {}) => ({ size: 4, position: 'outside', blend: 'multiply', color: '#ff0000', opacity: 1, ...over });
    // Its outside part lies on the page in its own mode (review F5).
    expect(usesBackdrop(style({ strokeEffects: [stroke()] }))).toBe(true);
    expect(usesBackdrop(style({ strokeEffects: [stroke({ position: 'center', blend: 'screen' })] }))).toBe(true);
    // An inside stroke blends with the letters alone.
    expect(usesBackdrop(style({ strokeEffects: [stroke({ position: 'inside' })] }))).toBe(false);
    // Normal, a mode's no-op colour, or nothing of it shown: no page read.
    expect(usesBackdrop(style({ strokeEffects: [stroke({ blend: 'normal' })] }))).toBe(false);
    expect(usesBackdrop(style({ strokeEffects: [stroke({ color: '#000000' })] }))).toBe(false);
    expect(usesBackdrop(style({ strokeEffects: [stroke({ opacity: 0 })] }))).toBe(false);
    // A gradient's colours are its stops': never a no-op.
    expect(usesBackdrop(style({ strokeEffects: [stroke({ color: '#000000', fill: 'gradient' })] }))).toBe(true);
  });
});

describe('the picture key of a box', () => {
  const pg = { w: 800, h: 1200 };
  const boxOf = (s, over = {}) => ({ x: 100, y: 200, w: 300, h: 100, style: s, ...over });
  const key = (box, src = 'blob:a', ready = true) =>
    pictureKey({ style: box.style, inkKey: '', text: 'HI', w: box.w, h: box.h, lines: ['HI'], indents: [0], scale: 2, fonts: 1, under: pageUnderKey(box, pg, src, ready) });

  it('of an ordinary box does not change on a move, a turn or other art', () => {
    const s = style({ shadows: [shadow()] });
    const at = key(boxOf(s));
    expect(key(boxOf(s, { x: 150 }))).toBe(at);
    expect(key(boxOf({ ...s, rotation: 30 }))).toBe(at);
    expect(key(boxOf({ ...s, flipH: true }))).toBe(at);
    expect(key(boxOf(s), 'blob:b')).toBe(at);
  });

  it('of a box that blends with the page changes on a move, a turn, a mirror, other art and the art loading', () => {
    const s = style({ blendMode: 'multiply' });
    const at = key(boxOf(s));
    expect(key(boxOf(s, { x: 150 }))).not.toBe(at);
    expect(key(boxOf(s, { y: 201 }))).not.toBe(at);
    expect(key(boxOf({ ...s, rotation: 30 }))).not.toBe(at);
    expect(key(boxOf({ ...s, flipV: true }))).not.toBe(at);
    expect(key(boxOf(s), 'blob:b')).not.toBe(at);
    expect(key(boxOf(s), 'blob:a', false)).not.toBe(at);
    expect(key(boxOf(s))).toBe(at);
  });
});

describe('boxToPage', () => {
  const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const L = { ox: 12, oy: 8 };
  const box = (over = {}) => ({ x: 100, y: 50, w: 200, h: 80, style: { rotation: 0, ...over } });

  it('puts the box corner of the layout on the box corner of the page', () => {
    const p = apply(boxToPage(box(), L), [L.ox, L.oy]);
    expect(p[0]).toBeCloseTo(100);
    expect(p[1]).toBeCloseTo(50);
  });

  it('turns about the box centre, and mirrors inside the turn', () => {
    const centre = [L.ox + 100, L.oy + 40];
    for (const over of [{ rotation: 37 }, { rotation: -90, flipH: true }, { flipV: true }]) {
      const c = apply(boxToPage(box(over), L), centre);
      expect(c[0]).toBeCloseTo(200);
      expect(c[1]).toBeCloseTo(90);
    }
    // A quarter turn clockwise carries the corner's offset from the centre
    // (-100, -40) to (40, -100).
    const q = apply(boxToPage(box({ rotation: 90 }), L), [L.ox, L.oy]);
    expect(q[0]).toBeCloseTo(240);
    expect(q[1]).toBeCloseTo(-10);
    // Mirrored, the left corner goes right.
    const m = apply(boxToPage(box({ flipH: true }), L), [L.ox, L.oy]);
    expect(m[0]).toBeCloseTo(300);
    expect(m[1]).toBeCloseTo(50);
    // Moved elsewhere by `at`.
    const a = apply(boxToPage(box(), L, { x: 101, y: 49 }), [L.ox, L.oy]);
    expect(a).toEqual([101, 49]);
  });
});

describe('pageArtSrc', () => {
  const pg = { raw: 'raw', cleaned: 'clean' };
  it('is what the frame shows', () => {
    expect(pageArtSrc(pg, {})).toBe('clean');
    expect(pageArtSrc({ raw: 'raw' }, {})).toBe('raw');
    expect(pageArtSrc(pg, { peekRaw: true })).toBe('raw');
    expect(pageArtSrc(pg, { chapterMode: 'translate' })).toBe('raw');
    expect(pageArtSrc(pg, { chapterMode: 'translate', translateTypeset: true, viewCleaned: true })).toBe('clean');
    expect(pageArtSrc(null, {})).toBe(null);
  });
});

describe('normalizeBlending', () => {
  const plain = defaultBlending();
  it('fills the defaults and refuses what is not an option', () => {
    expect(normalizeBlending(undefined)).toEqual(plain);
    expect(plain).toMatchObject({ interior: false, knockout: 'none', channels: { r: true, g: true, b: true } });
    expect(Object.keys(plain.blendIf)).toEqual(['gray', 'red', 'green', 'blue']);
    for (const c of Object.values(plain.blendIf)) expect(c).toEqual({ this: [0, 0, 255, 255], under: [0, 0, 255, 255] });
    expect(normalizeBlending({ interior: 1, knockout: 'full' })).toEqual(plain);
    expect(normalizeBlending({ interior: true, knockout: 'shallow' })).toMatchObject({ interior: true, knockout: 'shallow' });
    expect(style().blending).toEqual(plain);
    // A saved 6a style (no channels, no Blend If) reads as the defaults.
    expect(style({ blending: { interior: true, knockout: 'deep' } }).blending).toEqual({ ...plain, interior: true, knockout: 'deep' });
  });

  it('keeps a channel off only when it says false', () => {
    expect(normalizeBlending({ channels: { r: false, g: 0, b: null } }).channels).toEqual({ r: false, g: true, b: true });
  });

  it('clamps a Blend If slider to whole levels that rise, black before white', () => {
    expect(normalizeBlendRange([0, 0, 255, 255])).toEqual([0, 0, 255, 255]);
    expect(normalizeBlendRange([64.4, 191.6, 255, 255])).toEqual([64, 192, 255, 255]);
    expect(normalizeBlendRange([-5, 300, 400, 9])).toEqual([0, 255, 255, 255]);
    // A handle past the next one pushes it along.
    expect(normalizeBlendRange([200, 100, 50, 255])).toEqual([200, 200, 200, 255]);
    expect(normalizeBlendRange([0, 0, 'x', 128])).toEqual([0, 0, 255, 255]);
    expect(normalizeBlendRange([1, 2, 3])).toEqual([0, 0, 255, 255]);
    expect(normalizeBlendRange(null)).toEqual([0, 0, 255, 255]);
    const b = normalizeBlending({ blendIf: { gray: { under: [128, 128, 255, 255] }, red: { this: [10, 5, 250, 240] }, cyan: { this: [1, 1, 1, 1] } } });
    expect(b.blendIf.gray).toEqual({ this: [0, 0, 255, 255], under: [128, 128, 255, 255] });
    expect(b.blendIf.red.this).toEqual([10, 10, 250, 250]);
    expect(b.blendIf.cyan).toBeUndefined();
  });
});

describe('Channels and Blend If', () => {
  it('blend with the page: a box with one set uses the backdrop, and the defaults do not', () => {
    expect(blendingRestricts(defaultBlending())).toBe(false);
    expect(blendIfActive(defaultBlending().blendIf)).toBe(false);
    const under = style({ blending: { blendIf: { gray: { under: [128, 128, 255, 255] } } } });
    expect(usesBackdrop(under)).toBe(true);
    // This Layer alone is painted over the art too (a PSD layer, with no art,
    // leaves it to Photoshop).
    expect(usesBackdrop(style({ blending: { blendIf: { blue: { this: [0, 0, 200, 200] } } } }))).toBe(true);
    expect(usesBackdrop(style({ blending: { channels: { r: false } } }))).toBe(true);
    expect(usesBackdrop(style({ blending: { channels: { r: true, g: true, b: true } } }))).toBe(false);
    // Its picture is keyed by where it stands on the art.
    const pg = { w: 800, h: 1200 };
    const boxOf = (x) => ({ x, y: 200, w: 300, h: 100, style: under });
    expect(pageUnderKey(boxOf(100), pg, 'blob:a', true)).not.toBe(pageUnderKey(boxOf(150), pg, 'blob:a', true));
  });

  it('go on the wire after the blending flags (v10): a mask of channels left out, then the 32 range bytes', () => {
    const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
    const job = { job: { bands: [], runs: [], fill: { kind: 'solid', color: '#000000' } }, font: 0, size: 10 };
    // Magic, version, size, the grain's corner (v15), no page (v16), no
    // shadows, blur, no taps, no clip, no fade (v20), the pin shift (v23),
    // the live flag (v24), mode, fill.
    const flagsAt = 4 * 4 + 2 * 4 + 4 + 4 + 8 + 4 + 4 + 4 + 16 + 4 + 4 + 8;
    const plainBytes = encodeBox({ ...job, width: 4, height: 4 }).slice();
    expect(BOX_WIRE_VERSION).toBe(24);
    expect(dv(plainBytes).getUint32(4, true)).toBe(BOX_WIRE_VERSION);
    expect([0, 4, 8].map((k) => dv(plainBytes).getUint32(flagsAt + k, true))).toEqual([0, 0, 0]);
    // Transparency Shapes Layer off is blending flag 2 (v13), with interior 1.
    const shapeless = encodeBox({ ...job, width: 4, height: 4, blendInterior: true, transparencyShapes: false }).slice();
    expect(dv(shapeless).getUint32(flagsAt, true)).toBe(3);
    // The defaults write the same bytes as no options at all.
    const d = defaultBlending();
    const same = encodeBox({ ...job, width: 4, height: 4, channels: d.channels, blendIf: d.blendIf }).slice();
    expect(same).toEqual(plainBytes);
    const b = normalizeBlending({ channels: { g: false, b: false }, blendIf: { gray: { under: [64, 192, 255, 255] }, blue: { this: [0, 0, 200, 230] } } });
    const set = dv(encodeBox({ ...job, width: 4, height: 4, channels: b.channels, blendIf: b.blendIf }).slice());
    expect(set.byteLength).toBe(plainBytes.length + 32);
    expect(set.getUint32(flagsAt + 4, true)).toBe(2 | 4);
    expect(set.getUint32(flagsAt + 8, true)).toBe(1);
    const quads = Array.from({ length: 8 }, (_, q) => [0, 1, 2, 3].map((k) => set.getUint8(flagsAt + 12 + q * 4 + k)));
    expect(quads).toEqual([
      [0, 0, 255, 255], [64, 192, 255, 255],
      [0, 0, 255, 255], [0, 0, 255, 255],
      [0, 0, 255, 255], [0, 0, 255, 255],
      [0, 0, 200, 230], [0, 0, 255, 255],
    ]);
  });
});
