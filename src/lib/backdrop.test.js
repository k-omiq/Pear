import { describe, it, expect } from 'vitest';
import { defaultStyle, normalizeStyle, normalizeBlending } from './data.js';
import { usesBackdrop } from './text-paint.js';
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
  it('fills the defaults and refuses what is not an option', () => {
    expect(normalizeBlending(undefined)).toEqual({ interior: false, knockout: 'none' });
    expect(normalizeBlending({ interior: 1, knockout: 'full' })).toEqual({ interior: false, knockout: 'none' });
    expect(normalizeBlending({ interior: true, knockout: 'shallow' })).toEqual({ interior: true, knockout: 'shallow' });
    expect(style().blending).toEqual({ interior: false, knockout: 'none' });
  });
});
