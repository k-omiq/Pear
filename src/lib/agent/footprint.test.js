// The original lettering's footprint, on pictures made of numbers: a page
// whose "raw" has ink the "clean" does not.
import { describe, expect, it } from 'vitest';
import { footprintOf, slantOf, lookFor, isUpright, MAX_TURN, UPRIGHT_TURN } from './footprint.js';

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
    // Black ink on light paper: black English with a white outline.
    expect(fp.ink.colour).toBe(false);
    expect(fp.under.tone).toBe('light');
    expect(lookFor(fp, { outlineWidth: 3 })).toEqual({ color: '#000000', strokes: [{ color: '#ffffff', width: 3, opacity: 1 }] });
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
    expect(lookFor(fp)).toEqual({ color: '#ffffff', strokes: [] });
  });

  it('takes a colour original\'s own colours', () => {
    const clean = picture([240, 230, 220]);
    const raw = bar(picture([240, 230, 220]), { cx: 100, cy: 60, len: 140, thick: 34, deg: 0, ink: [60, 0, 0] });
    bar(raw, { cx: 100, cy: 60, len: 130, thick: 24, deg: 0, ink: [220, 30, 30] });
    const fp = footprintOf(raw, clean);
    expect(fp.ink.colour).toBe(true);
    const look = lookFor(fp);
    expect(look.color).toMatch(/^#d|^#e/);
    expect(look.strokes[0].color).toMatch(/^#[0-5]/);
  });

  it('a round original has no slant; an uncleaned region has no footprint', () => {
    const clean = picture([250, 250, 250]);
    const raw = bar(picture([250, 250, 250]), { cx: 100, cy: 60, len: 40, thick: 40, deg: 30, ink: [0, 0, 0] });
    expect(slantOf(footprintOf(raw, clean))).toBe(0);
    expect(footprintOf(clean, clean)).toBeNull();
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
