import { describe, it, expect } from 'vitest';
import { smoothPath, splitPath, nearestOnPath, toggleSmooth, wavePath } from './bezier-path.js';
import { pathLayout } from './measure.js';

const corner = (x, y, h = {}) => ({ x, y, ix: 0, iy: 0, ox: 0, oy: 0, ...h });

describe('smoothPath', () => {
  it('leaves a path with no smooth anchors untouched (old saved paths)', () => {
    const pts = [corner(0, 0, { ox: 30 }), corner(100, 0, { ix: -30 })];
    expect(smoothPath(pts)).toBe(pts);
  });

  it('gives a smooth interior anchor a tangent parallel to its neighbours chord', () => {
    const pts = smoothPath([corner(0, 0), { ...corner(50, -40), auto: true }, corner(100, 0)]);
    expect(pts[1].iy).toBeCloseTo(0);
    expect(pts[1].oy).toBeCloseTo(0);
    expect(pts[1].ix).toBeLessThan(0);
    expect(pts[1].ox).toBeGreaterThan(0);
    // Corners keep their handles.
    expect(pts[0]).toEqual(corner(0, 0));
  });
});

describe('splitPath', () => {
  it('adds an anchor on the curve without moving it', () => {
    const pts = [corner(0, 0, { ox: 40, oy: -60 }), corner(120, 0, { ix: -40, iy: -60 })];
    const before = pathLayout('ABCDEFGH', { size: 20, path: { pts } }, 20, 120, 60);
    const { pts: next, index } = splitPath(pts, 0, 0.3);
    expect(next).toHaveLength(3);
    expect(index).toBe(1);
    const after = pathLayout('ABCDEFGH', { size: 20, path: { pts: next } }, 20, 120, 60);
    after.forEach((g, i) => {
      expect(g.x).toBeCloseTo(before[i].x, 0);
      expect(g.y).toBeCloseTo(before[i].y, 0);
    });
  });

  it('makes the new anchor smooth when both ends of its segment are', () => {
    const { pts } = splitPath(wavePath(200, 100, 0), 0, 0.5);
    expect(pts[1].auto).toBe(true);
  });
});

describe('nearestOnPath', () => {
  it('finds the segment and parameter under a point', () => {
    const pts = wavePath(300, 100, 0);
    const hit = nearestOnPath(pts, 225, 52);
    expect(hit.seg).toBe(1);
    expect(hit.d).toBeLessThan(3);
  });
});

describe('toggleSmooth', () => {
  it('turns a smooth anchor into a sharp corner and back', () => {
    const pts = wavePath(300, 100, 1);
    const sharp = toggleSmooth(pts, 1);
    expect(sharp[1].auto).toBeUndefined();
    expect([sharp[1].ix, sharp[1].iy, sharp[1].ox, sharp[1].oy]).toEqual([0, 0, 0, 0]);
    const back = toggleSmooth(sharp, 1);
    expect(back[1].auto).toBe(true);
    expect(back[1].ox).toBeGreaterThan(0);
  });
});

describe('wavePath', () => {
  it('builds a three-bump wave that the text follows up and down', () => {
    const pts = wavePath(300, 100, 3);
    expect(pts.map((p) => Math.round(p.y))).toEqual([50, 20, 80, 20, 50]);
    const glyphs = pathLayout("WAVE".repeat(12), { size: 14, path: { pts } }, 14, 300, 100);
    const ys = glyphs.map((g) => g.y);
    // Letters reach both the crests and the troughs.
    expect(Math.min(...ys)).toBeLessThan(-20);
    expect(Math.max(...ys)).toBeGreaterThan(20);
  });
});
