import { describe, it, expect } from 'vitest';
import { inkCrop } from './draw-read.svelte.js';

function pad(w, h, inked = []) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const [x, y] of inked) data.set([0, 0, 0, 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

describe('inkCrop', () => {
  it('is null on an empty pad', () => {
    expect(inkCrop(pad(10, 10))).toBe(null);
  });

  it('boxes the ink and pads it by a share of its longer side', () => {
    const c = inkCrop(pad(100, 100, [[20, 30], [39, 30], [30, 49]]), 0.1);
    expect(c).toEqual({ x: 18, y: 28, w: 24, h: 24 });
  });

  it('ignores light grey and transparent pixels', () => {
    const p = pad(10, 10);
    p.data.set([230, 230, 230, 255], (5 * 10 + 5) * 4);
    p.data.set([0, 0, 0, 0], (2 * 10 + 2) * 4);
    expect(inkCrop(p)).toBe(null);
  });
});
