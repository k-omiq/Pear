// The original lettering's footprint, on pictures made of numbers: a page
// whose "raw" has ink the "clean" does not.
import { describe, expect, it } from 'vitest';
import { footprintOf, slantOf, lookFor, isUpright, colourMismatch, inkLeftIn, isUncleaned, MAX_TURN, UPRIGHT_TURN } from './footprint.js';

const W = 200;
const H = 120;

function picture(fill) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([...fill, 255], i * 4);
  return { data, width: W, height: H };
}

// A bar of ink `len` long and `thick` across, centred on (cx, cy), turned by
// `deg` (clockwise on screen), painted on `px`.
function bar(px, { cx, cy, len, thick, deg, ink }) {
  const t = (deg * Math.PI) / 180;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const a = dx * Math.cos(t) + dy * Math.sin(t);
      const b = -dx * Math.sin(t) + dy * Math.cos(t);
      if (Math.abs(a) <= len / 2 && Math.abs(b) <= thick / 2) px.data.set([...ink, 255], (y * W + x) * 4);
    }
  }
  return px;
}

describe('footprintOf', () => {
  it('finds where the cleaner took ink away, its slant, size and weight', () => {
    const clean = picture([250, 250, 250]);
    const raw = bar(picture([250, 250, 250]), { cx: 100, cy: 60, len: 120, thick: 30, deg: -20, ink: [10, 10, 10] });
    const fp = footprintOf(raw, clean, { rect: [1000, 500, W, H], scale: 1 });
    expect(fp).not.toBeNull();
    expect(fp.centre[0]).toBeCloseTo(1100, -1);
    expect(fp.centre[1]).toBeCloseTo(560, -1);
    expect(fp.angle).toBeGreaterThanOrEqual(-22);
    expect(fp.angle).toBeLessThanOrEqual(-18);
    expect(fp.length).toBeGreaterThan(105);
    expect(fp.length).toBeLessThan(125);
    expect(fp.breadth).toBeGreaterThan(24);
    expect(fp.breadth).toBeLessThan(34);
    expect(fp.weight).toBe('heavy');
    expect(slantOf(fp)).toBe(fp.angle);
    // Black ink on light paper, no outline: exactly that.
    expect(fp.ink.colour).toBe(false);
    expect(fp.under.tone).toBe('light');
    expect(lookFor(fp, { outlineWidth: 3 })).toEqual({ color: '#000000', strokeEffects: [], gradient: { on: false }, noFill: false });
  });

  it('gives page px from a region drawn smaller than the page', () => {
    const clean = picture([250, 250, 250]);
    const raw = bar(picture([250, 250, 250]), { cx: 100, cy: 60, len: 100, thick: 20, deg: 0, ink: [0, 0, 0] });
    const fp = footprintOf(raw, clean, { rect: [0, 0, 400, 240], scale: 0.5 });
    expect(fp.length).toBeGreaterThan(190);
    expect(fp.centre[0]).toBeCloseTo(200, -1);
  });

  it('reads a thin original on dark art as white with no outline', () => {
    const clean = picture([20, 20, 30]);
    // Six tall letters drawn in hairlines: strokes 3 px, letters 40 px tall.
    const raw = picture([20, 20, 30]);
    for (let i = 0; i < 6; i++) {
      bar(raw, { cx: 40 + i * 24, cy: 60, len: 40, thick: 3, deg: 90, ink: [245, 245, 245] });
      bar(raw, { cx: 40 + i * 24 + 6, cy: 42, len: 12, thick: 3, deg: 0, ink: [245, 245, 245] });
    }
    const fp = footprintOf(raw, clean);
    expect(fp.weight).toBe('thin');
    expect(fp.under.tone).toBe('dark');
    expect(lookFor(fp)).toMatchObject({ color: '#ffffff', strokeEffects: [] });
  });

  it('takes a colour original\'s own colours', () => {
    const clean = picture([240, 230, 220]);
    const raw = bar(picture([240, 230, 220]), { cx: 100, cy: 60, len: 140, thick: 34, deg: 0, ink: [60, 0, 0] });
    bar(raw, { cx: 100, cy: 60, len: 130, thick: 24, deg: 0, ink: [220, 30, 30] });
    const fp = footprintOf(raw, clean);
    expect(fp.ink.colour).toBe(true);
    const look = lookFor(fp);
    expect(look.color).toBe('#dc1e1e');
    expect(look.strokeEffects).toEqual([{ color: '#3c0000', size: 5, opacity: 1 }]);
  });

  it('reads white letters in a black outline on grey art as exactly that', () => {
    const clean = picture([120, 120, 120]);
    const raw = bar(picture([120, 120, 120]), { cx: 100, cy: 60, len: 150, thick: 40, deg: 0, ink: [5, 5, 5] });
    bar(raw, { cx: 100, cy: 60, len: 136, thick: 26, deg: 0, ink: [252, 252, 252] });
    const fp = footprintOf(raw, clean);
    expect(fp.ink).toMatchObject({ fill: '#ffffff', outline: '#000000', colour: false });
    expect(fp.ink.outlineWidth).toBeGreaterThanOrEqual(6);
    expect(fp.ink.outlineWidth).toBeLessThanOrEqual(8);
    expect(lookFor(fp).strokeEffects[0].color).toBe('#000000');
  });

  it('reads hollow letters over art as pale as their inside as a fill in an outline', () => {
    // White letters drawn round in black, on a white page: only the black
    // ring changed when the page was cleaned.
    const clean = picture([250, 250, 250]);
    const raw = bar(picture([250, 250, 250]), { cx: 100, cy: 60, len: 150, thick: 40, deg: 0, ink: [5, 5, 5] });
    bar(raw, { cx: 100, cy: 60, len: 136, thick: 26, deg: 0, ink: [250, 250, 250] });
    const fp = footprintOf(raw, clean);
    expect(fp.ink).toMatchObject({ fill: '#ffffff', outline: '#000000', colour: false });
    expect(fp.ink.outlineWidth).toBeGreaterThanOrEqual(6);
    expect(fp.ink.outlineWidth).toBeLessThanOrEqual(8);
  });

  it('keeps a solid letter with a small counter solid', () => {
    const clean = picture([250, 250, 250]);
    const raw = bar(picture([250, 250, 250]), { cx: 100, cy: 60, len: 150, thick: 40, deg: 0, ink: [5, 5, 5] });
    bar(raw, { cx: 100, cy: 60, len: 30, thick: 10, deg: 0, ink: [250, 250, 250] });
    const fp = footprintOf(raw, clean);
    expect(fp.ink).toMatchObject({ fill: '#000000', outline: null });
  });

  it('takes no blend of the letters into the art for an outline', () => {
    const clean = picture([250, 250, 250]);
    const raw = bar(picture([250, 250, 250]), { cx: 100, cy: 60, len: 140, thick: 36, deg: 0, ink: [128, 128, 128] });
    bar(raw, { cx: 100, cy: 60, len: 136, thick: 32, deg: 0, ink: [0, 0, 0] });
    const fp = footprintOf(raw, clean);
    expect(fp.ink.fill).toBe('#000000');
    expect(fp.ink.outline).toBeNull();
  });

  it('reads a shaded fill as a gradient from top to bottom', () => {
    const clean = picture([240, 240, 240]);
    const raw = bar(picture([240, 240, 240]), { cx: 100, cy: 60, len: 150, thick: 50, deg: 0, ink: [0, 0, 0] });
    bar(raw, { cx: 100, cy: 50, len: 140, thick: 20, deg: 0, ink: [230, 30, 30] });
    bar(raw, { cx: 100, cy: 70, len: 140, thick: 20, deg: 0, ink: [250, 220, 20] });
    const fp = footprintOf(raw, clean);
    expect(fp.ink.shade).toEqual(['#e61e1e', '#fadc14']);
    expect(fp.ink.outline).toBe('#000000');
    const look = lookFor(fp);
    expect(look.gradient).toMatchObject({ on: true, angle: 180, stops: [{ color: '#e61e1e', pos: 0 }, { color: '#fadc14', pos: 1 }] });
  });

  it('a round original has no slant; an uncleaned region has no footprint', () => {
    const clean = picture([250, 250, 250]);
    const raw = bar(picture([250, 250, 250]), { cx: 100, cy: 60, len: 40, thick: 40, deg: 30, ink: [0, 0, 0] });
    expect(slantOf(footprintOf(raw, clean))).toBe(0);
    expect(footprintOf(clean, clean)).toBeNull();
  });
});

describe('colourMismatch', () => {
  // An outline stroke: Outside, a colour, reaching `size` past the letters.
  const out = (color, size) => ({ size, position: 'outside', color });
  const ink = { fill: '#dc1e1e', outline: '#3c0000' };
  it('passes the original\'s colours, read again', () => {
    expect(colourMismatch({ color: '#da1f1d', strokeEffects: [out('#3a0101', 4)] }, ink)).toBeNull();
  });
  it('names a fill and an outline that are not the original\'s', () => {
    expect(colourMismatch({ color: '#ffffff', strokeEffects: [out('#000000', 3)] }, ink)).toEqual({
      fill: { want: '#dc1e1e', got: '#ffffff' },
      outline: { want: '#3c0000', got: ['#000000'] },
    });
  });
  it('wants no outline where the original had none, and one where it had', () => {
    expect(colourMismatch({ color: '#000', strokeEffects: [out('#ffffff', 3)] }, { fill: '#000000', outline: null })).toEqual({ outline: { want: 'none', got: ['#ffffff'] } });
    expect(colourMismatch({ color: '#dc1e1e', strokeEffects: [] }, ink)).toEqual({ outline: { want: '#3c0000', got: 'none' } });
  });
  it('reads hollow letters by their band, and a shade by its stops', () => {
    expect(colourMismatch({ noFill: true, color: '#fff', strokeEffects: [out('#dc1e1e', 6), out('#3c0000', 8)] }, ink)).toBeNull();
    const shade = { fill: '#e61e1e', outline: null, shade: ['#e61e1e', '#fadc14'] };
    const grad = (stops) => ({ color: '#e61e1e', strokeEffects: [], gradient: { on: true, stops: stops.map((color) => ({ color })) } });
    expect(colourMismatch(grad(['#e61e1e', '#fadc14']), shade)).toBeNull();
    expect(colourMismatch(grad(['#ffffff', '#fadc14']), shade)?.fill).toBeTruthy();
    expect(colourMismatch({ color: '#e61e1e', strokeEffects: [] }, shade)?.fill).toBeTruthy();
  });
});

describe('English is never stood on end', () => {
  const fp = (angle, elongation = 3) => ({ angle, elongation });
  it('follows a slant up to 35 degrees either way', () => {
    expect(slantOf(fp(-20))).toBe(-20);
    expect(slantOf(fp(160))).toBe(-20);
    expect(slantOf(fp(40))).toBe(MAX_TURN);
    expect(slantOf(fp(-44))).toBe(-MAX_TURN);
  });
  it('runs across an upright original, tilted up a little, as the human did', () => {
    for (const a of [90, -90, 80, -60, 100]) {
      expect(isUpright(fp(a))).toBe(true);
      expect(slantOf(fp(a))).toBe(UPRIGHT_TURN);
    }
    expect(isUpright(fp(90, 1.1))).toBe(false);
    expect(slantOf(fp(90, 1.1))).toBe(0);
  });
});

describe('lettering the cleaner left', () => {
  const at = (px) => ({ ...px, rect: [0, 0, W, H], scale: 1 });
  const block = [40, 30, 120, 60];
  const letters = (px, ink) => bar(bar(px, { cx: 80, cy: 60, len: 80, thick: 8, deg: 0, ink }), { cx: 120, cy: 60, len: 50, thick: 8, deg: 90, ink });

  it('names black letters still on the cleaned page', () => {
    const raw = letters(picture([255, 255, 255]), [0, 0, 0]);
    const left = inkLeftIn(at(raw), at(letters(picture([255, 255, 255]), [0, 0, 0])), block);
    expect(left.share).toBe(1);
    expect(isUncleaned(left)).toBe(true);
  });

  it('passes a balloon whose letters went white', () => {
    const raw = letters(picture([255, 255, 255]), [0, 0, 0]);
    const left = inkLeftIn(at(raw), at(picture([255, 255, 255])), block);
    expect(left.share).toBe(0);
    expect(isUncleaned(left)).toBe(false);
  });

  it('passes white letters painted over on dark art, whose dark ink is the art', () => {
    const raw = letters(picture([20, 20, 20]), [255, 255, 255]);
    const left = inkLeftIn(at(raw), at(picture([20, 20, 20])), block);
    expect(left.share).toBe(1);
    expect(left.changed).toBeGreaterThan(0.02);
    expect(isUncleaned(left)).toBe(false);
  });

  it('has nothing to say of a block with no dark ink', () => {
    expect(inkLeftIn(at(picture([255, 255, 255])), at(picture([255, 255, 255])), block)).toBeNull();
  });
});
