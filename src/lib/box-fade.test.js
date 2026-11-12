import { describe, expect, it } from 'vitest';
import { normalizeFade, fadeActive, fadeInBoxFrame, fadeSigma, fadeShapeSize } from './box-fade.js';
import { boxToPage } from './box-mask.js';

// ===========================================================================
// The fade is pinned to the page like the mask: its shapes stay where they
// were drawn whatever is done to the box, and the engine gets them in the
// box's frame with a strength as a share and a soft edge as a blur.
// ===========================================================================

const style = (over = {}) => ({ rotation: 0, flipH: false, flipV: false, warp: { on: false, cols: 2, rows: 2, pts: [] }, ...over });
const boxOf = (over = {}) => ({ id: 'b', x: 100, y: 80, w: 200, h: 120, text: 'HI', ...over, style: style(over.style) });
const FADE = {
  on: true,
  shapes: [
    { kind: 'poly', strength: 40, soft: 50, pts: [[120, 90], [220, 90], [220, 130], [120, 130]] },
    { kind: 'stroke', strength: 100, soft: 0, size: 24, pts: [[150, 150], [250, 170]] },
    { kind: 'ellipse', strength: 70, soft: 100, cx: 200, cy: 140, rx: 30, ry: 10 },
  ],
};

describe('the fade', () => {
  it('reads what it can and clamps its numbers', () => {
    const f = normalizeFade({
      on: true,
      shapes: [
        { kind: 'poly', strength: 400, soft: -5, pts: [[0, 0], [1, 0], [0, 1]] },
        { kind: 'bubble', inset: 2 },
        { kind: 'stroke', size: 8, pts: [[1, 2]] },
        { kind: 'ellipse', cx: 0, cy: 0, rx: 0, ry: 2 },
      ],
    });
    expect(f.shapes).toEqual([
      { kind: 'poly', strength: 100, soft: 0, pts: [[0, 0], [1, 0], [0, 1]] },
      { kind: 'stroke', strength: 50, soft: 0, size: 8, pts: [[1, 2]] },
    ]);
    expect(normalizeFade(null)).toBe(null);
    expect(fadeActive({ fade: { on: true, shapes: [] } })).toBe(false);
    expect(fadeActive({ fade: { on: false, shapes: f.shapes } })).toBe(false);
    expect(fadeActive({ fade: f })).toBe(true);
  });

  it('a soft edge is a share of the shape: its width, or the short side of its bounds', () => {
    const [rect, stroke, ellipse] = normalizeFade(FADE).shapes;
    expect(fadeShapeSize(rect)).toBe(40);
    expect(fadeShapeSize(stroke)).toBe(24);
    expect(fadeShapeSize(ellipse)).toBe(20);
    // A quarter of the size at 100, on quarter px.
    expect(fadeSigma(rect)).toBe(5);
    expect(fadeSigma(stroke)).toBe(0);
    expect(fadeSigma(ellipse)).toBe(5);
  });

  for (const [name, over] of Object.entries({ plain: {}, moved: { x: 9, y: 300 }, turned: { style: { rotation: 30 } }, flipped: { style: { flipH: true } } })) {
    it(`keeps its page position when the box is ${name}`, () => {
      const box = { ...boxOf(over), fade: normalizeFade(FADE) };
      const frame = fadeInBoxFrame(box);
      // The rectangle's corners come back to where they were drawn.
      frame[0].pts.forEach((p, i) => {
        const q = boxToPage(box, p);
        expect(q[0]).toBeCloseTo(FADE.shapes[0].pts[i][0], 6);
        expect(q[1]).toBeCloseTo(FADE.shapes[0].pts[i][1], 6);
      });
      // Strength as a share, soft as a sigma, whatever the box's frame.
      expect(frame.map((sh) => [sh.strength, sh.soft])).toEqual([[0.4, 5], [1, 0], [0.7, 5]]);
      // No op: the fade is not a mask.
      expect(frame.every((sh) => !('op' in sh))).toBe(true);
    });
  }

  it('does nothing while it is off', () => {
    expect(fadeInBoxFrame({ ...boxOf(), fade: { ...normalizeFade(FADE), on: false } })).toEqual([]);
  });
});
