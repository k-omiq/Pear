import { describe, expect, it } from 'vitest';
import { marksFromPage, marksOnPage, moveMarks, normalizePaint, paintRoomFor, PAINT_MARKS_MAX, PAINT_ERASERS_MAX } from './box-paint.js';
import { boxToPage, pageToBox } from './box-mask.js';
import { warpPoint } from './warp.js';

// ===========================================================================
// The paint's marks are stored in the box's texture: its own frame before
// the warp mesh. A mark drawn on the page lands under the pointer whatever
// the box's turn, flips or mesh, and a gesture carries back only the mark it
// made or moved.
// ===========================================================================

const style = (over = {}) => ({ rotation: 0, flipH: false, flipV: false, warp: { on: false, cols: 2, rows: 2, pts: [] }, ...over });
const boxOf = (over = {}) => ({ id: 'b', x: 100, y: 80, w: 200, h: 120, style: style(over.style), ...over, style: style(over.style) });
// A perspective (one cell, its corners not a parallelogram) and a bent 2 x 2
// mesh.
const PERSPECTIVE = { on: true, cols: 1, rows: 1, pts: [[0, 0], [200, 20], [-10, 120], [230, 100]] };
const BENT = { on: true, cols: 2, rows: 2, pts: [[0, 0], [100, 30], [200, 0], [0, 60], [120, 75], [200, 60], [0, 120], [100, 90], [200, 120]] };
const shown = (box, p) => {
  const w = box.style.warp;
  return boxToPage(box, w.on ? warpPoint(w.pts, w.cols, w.rows, box.w, box.h, p[0], p[1]) : p);
};
const near = (a, b, tol = 1e-4) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(tol);
const stroke = (pts, more = {}) => ({ kind: 'stroke', size: 6, pts, color: '#ff0000', opacity: 100, soft: 0, ...more });

describe('a mark lands under the pointer', () => {
  for (const [name, warp, rotation] of [['a perspective', PERSPECTIVE, 0], ['a bent mesh', BENT, 0], ['a bent mesh, turned and flipped', BENT, 25]]) {
    it(`on ${name}`, () => {
      const box = boxOf({ style: { warp, rotation, flipH: rotation !== 0 } });
      const drawn = [[150, 110], [190, 150], [260, 130]];
      const [mark] = marksFromPage(box, [stroke(drawn)]);
      // Every point of the line, cut into steps, is shown where the pointer
      // drew it once the mesh has carried it.
      expect(mark.pts.length).toBeGreaterThan(drawn.length);
      for (const p of drawn) expect(mark.pts.some((q) => Math.hypot(...[0, 1].map((k) => shown(box, q)[k] - p[k])) < 1e-4)).toBe(true);
      for (const q of mark.pts) {
        const [x, y] = shown(box, q);
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      }
      // And the tool shows it there again.
      const [back] = marksOnPage(box, [mark]);
      near(back.pts[0], drawn[0]);
      near(back.pts[back.pts.length - 1], drawn[2]);
    });
  }

  it('on a plain box the texture is the box frame: the old mapping, an ellipse kept', () => {
    const box = boxOf();
    const [m] = marksFromPage(box, [{ kind: 'ellipse', cx: 150, cy: 120, rx: 10, ry: 5, color: '#ff0000', opacity: 100, soft: 0 }]);
    expect(m).toMatchObject({ kind: 'ellipse', cx: 50, cy: 40, rx: 10, ry: 5 });
  });
});

describe('a gesture carries back only its own mark', () => {
  const ELLIPSE = { kind: 'ellipse', cx: 50, cy: 40, rx: 10, ry: 5, color: '#00ff00', opacity: 100, soft: 0 };

  it('moving one mark on a turned box leaves the others as stored, and an ellipse an ellipse', () => {
    const box = boxOf({ style: { rotation: 30 } });
    const marks = [ELLIPSE, stroke([[10, 10], [60, 30]]), { ...ELLIPSE, cx: 120 }];
    const out = moveMarks(box, marks, 2, 12, -5);
    expect(out[0]).toBe(marks[0]);
    expect(out[1]).toBe(marks[1]);
    expect(out[2].kind).toBe('ellipse');
    // Moved as the pointer moved it on the page.
    near(boxToPage(box, [out[2].cx, out[2].cy]), [boxToPage(box, [120, 40])[0] + 12, boxToPage(box, [120, 40])[1] - 5]);
    expect([out[2].rx, out[2].ry]).toEqual([10, 5]);
  });

  it('moving every mark on a warped box keeps each under the pointer', () => {
    const box = boxOf({ style: { warp: BENT } });
    const marks = [stroke([[40, 40], [80, 60]])];
    const [moved] = moveMarks(box, marks, null, 7, 3);
    const a = shown(box, marks[0].pts[0]);
    near(shown(box, moved.pts[0]), [a[0] + 7, a[1] + 3]);
  });

  it('a pick is reached the same way back: page to box and box to page agree', () => {
    const box = boxOf({ style: { rotation: -40, flipV: true } });
    near(pageToBox(box, boxToPage(box, [33, 21])), [33, 21], 1e-9);
  });
});

describe('a full box can still be erased', () => {
  const full = () => normalizePaint({ on: true, marks: Array.from({ length: PAINT_MARKS_MAX + 5 }, (_, i) => stroke([[i, 0], [i, 10]])) });

  it('colour marks stop at the ceiling, an eraser still fits', () => {
    const p = full();
    expect(p.marks).toHaveLength(PAINT_MARKS_MAX);
    expect(paintRoomFor(p, false)).toMatch(/at most/);
    expect(paintRoomFor(p, true)).toBe(null);
    const erased = normalizePaint({ ...p, marks: [...p.marks, stroke([[0, 0], [9, 9]], { erase: true })] });
    expect(erased.marks).toHaveLength(PAINT_MARKS_MAX + 1);
    expect(erased.marks.at(-1).erase).toBe(true);
  });

  it('erasers have a ceiling of their own', () => {
    const many = Array.from({ length: PAINT_ERASERS_MAX + 3 }, (_, i) => stroke([[i, 0], [i, 10]], { erase: true }));
    const p = normalizePaint({ on: true, marks: many });
    expect(p.marks).toHaveLength(PAINT_ERASERS_MAX);
    expect(paintRoomFor(p, true)).toMatch(/eraser/);
    expect(paintRoomFor(p, false)).toBe(null);
  });
});
