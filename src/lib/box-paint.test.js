import { describe, expect, it } from 'vitest';
import { marksFromPage, marksOnPage, moveMarks, normalizePaint, paintRoomFor, PAINT_MARKS_MAX, PAINT_ERASERS_MAX } from './box-paint.js';
import { boxToPage, pageToBox } from './box-mask.js';
import { identityMesh, meshMap, warpPoint } from './warp.js';

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

describe('a warped box, where the mesh does not reach', () => {
  // Top wide, foot narrow: page points past the vanishing line come from no
  // point of the box's plane.
  const NARROW = { on: true, cols: 1, rows: 1, pts: [[0, 0], [200, 0], [80, 120], [120, 120]] };
  it('drops the points it cannot carry, and a mark left with none', () => {
    const box = boxOf({ style: { warp: NARROW } });
    // The sides meet at box (100, 150): page (200, 230) and below is past it.
    expect(marksFromPage(box, [{ kind: 'ellipse', cx: 200, cy: 400, rx: 10, ry: 10, color: '#ff0000', opacity: 100, soft: 0 }])).toEqual([]);
    const [m] = marksFromPage(box, [stroke([[190, 120], [200, 140], [200, 400]])]);
    // The points past the line are gone; the rest land under the pointer.
    for (const p of m.pts) expect(boxToPage(box, warpPoint(NARROW.pts, 1, 1, 200, 120, p[0], p[1]))[1]).toBeLessThan(230);
    near(boxToPage(box, warpPoint(NARROW.pts, 1, 1, 200, 120, ...m.pts[0])), [190, 120]);
  });

  it('a mark moved past the line stays where it was', () => {
    const box = boxOf({ style: { warp: NARROW } });
    const [m] = marksFromPage(box, [{ kind: 'ellipse', cx: 200, cy: 130, rx: 5, ry: 5, color: '#ff0000', opacity: 100, soft: 0 }]);
    const [moved] = moveMarks(box, [m], 0, 0, 400);
    expect(moved).toBe(m);
  });

  it('a mark moved partly past the line stays whole where it was', () => {
    const box = boxOf({ style: { warp: NARROW } });
    // A stroke near the line: moved down, its lower end crosses it and its
    // upper end does not.
    const [m] = marksFromPage(box, [stroke([[195, 150], [205, 215]])]);
    const [moved] = moveMarks(box, [m], 0, 0, 40);
    expect(moved).toBe(m);
  });

  it('a stroke drawn across the gap is cut there, never joined by a straight line', () => {
    const box = boxOf({ style: { warp: NARROW } });
    // In, out past the line, and back in: two strokes, each wholly carried.
    const runs = marksFromPage(box, [stroke([[185, 120], [200, 300], [215, 120]])]);
    expect(runs.length).toBe(2);
    for (const r of runs) {
      for (const p of r.pts) expect(boxToPage(box, warpPoint(NARROW.pts, 1, 1, 200, 120, p[0], p[1]))[1]).toBeLessThan(230);
    }
    // A closed shape with a point past the line is not drawn at all.
    expect(marksFromPage(box, [{ kind: 'poly', pts: [[190, 120], [210, 120], [200, 300]], color: '#ff0000', opacity: 100, soft: 0 }])).toEqual([]);
  });

  it('shows the marks from one carry until the marks, the mesh or the box change', () => {
    const box = boxOf({ style: { warp: BENT } });
    const marks = marksFromPage(box, [stroke([[150, 100], [200, 120]])]);
    const a = marksOnPage(box, marks);
    expect(marksOnPage(box, marks)).toBe(a);
    expect(marksOnPage({ ...box, x: 101 }, marks)).not.toBe(a);
    const b = marksOnPage(box, marks);
    const pts = BENT.pts.map((p, i) => (i === 4 ? [121, 75] : p));
    expect(marksOnPage({ ...box, style: style({ warp: { ...BENT, pts } }) }, marks)).not.toBe(b);
    expect(marksOnPage(box, [...marks])).not.toBe(marksOnPage(box, marks));
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

// A folded mesh carries more than one box point onto some page points: a
// mark keeps to one sheet and to the box, never joining two sheets with a
// long segment or jumping a point to a sheet nobody sees.
describe('a folded mesh', () => {
  // The middle dot dragged right and down: the right half folds back over
  // itself.
  const FOLD = { on: true, cols: 2, rows: 2, pts: [[0, 0], [50, 0], [100, 0], [0, 50], [110, 68], [100, 50], [0, 100], [50, 100], [100, 100]] };
  const folded = () => ({ id: 'b', x: 0, y: 0, w: 100, h: 100, style: { ...style({ warp: FOLD }), size: 20 } });
  const longest = (pts) => Math.max(0, ...pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1])));

  it('a stroke across the fold keeps to one sheet: no segment longer than two page steps', () => {
    const box = folded();
    const runs = marksFromPage(box, [stroke([[0, 60], [120, 60]])]);
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      // The page step is 4 px; on the box a step is no longer than 8.
      expect(longest(r.pts)).toBeLessThanOrEqual(8);
      for (const q of r.pts) {
        // Inside the box and its margin (half the font size here), and on the line drawn.
        expect(q[0] >= -10 && q[0] <= 110 && q[1] >= -10 && q[1] <= 110).toBe(true);
        expect(Math.abs(shown(box, q)[1] - 60)).toBeLessThan(1e-3);
      }
    }
  });

  it('a mark moved 1 px moves about 1 px, never onto another sheet', () => {
    const box = folded();
    for (const y of [5, 7, 10, 20]) {
      const pts = Array.from({ length: 26 }, (_, i) => [40 + i * 2, y]);
      const mark = stroke(pts);
      const [out] = moveMarks(box, [mark], 0, 1, 0);
      if (out === mark) continue; // stayed, whole: allowed
      expect(out.pts).toHaveLength(pts.length);
      // Each point is still within a few px of where it stood.
      out.pts.forEach((q, i) => expect(Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1])).toBeLessThan(5));
      expect(longest(out.pts)).toBeLessThan(8);
    }
  });
});

describe('a mark moved on a folded mesh', () => {
  it('a mark pushed past the edge of its sheet stays where it was', () => {
    // The middle dot dragged right and down: the right half folds back over itself.
    const FOLD = { on: true, cols: 2, rows: 2, pts: [[0, 0], [50, 0], [100, 0], [0, 50], [110, 68], [100, 50], [0, 100], [50, 100], [100, 100]] };
    const box = { id: 'b', x: 0, y: 0, w: 100, h: 100, style: { ...style({ warp: FOLD }), size: 20 } };
    const mark = stroke([[56, 68], [57, 68]]);
    // A 1 px move takes it off its sheet; the nearest other answer is some
    // 50 px away, on the other sheet.
    const [out] = moveMarks(box, [mark], 0, 1, 0);
    expect(out).toBe(mark);
  });

  it('a mark whose straight step crosses a turned-over strip and comes back stays where it was', () => {
    const FOLD = { on: true, cols: 2, rows: 2, pts: [[0, 0], [50, 0], [100, 0], [0, 50], [110, 68], [100, 50], [0, 100], [50, 100], [100, 100]] };
    const box = { id: 'b', x: 0, y: 0, w: 100, h: 100, style: { ...style({ warp: FOLD }), size: 20 } };
    const mark = stroke([[84, 84], [85, 84]]);
    // Both ends turn one way, but the step between them is turned over
    // twice, near where the crease ends: once some 30 px off, now kept.
    const [out] = moveMarks(box, [mark], 0, 0, -1);
    expect(out).toBe(mark);
  });

  it('a mark on a fine mesh folded by one node never moves onto the other sheet', () => {
    const n = 24;
    const cell = 100 / n;
    const pts = identityMesh(n, n, 100, 100).map(([x, y], i) => (i === (n / 2) * (n + 1) + n / 2 ? [x + 1.5 * cell, y + 0.45 * cell] : [x, y]));
    const box = { id: 'b', x: 0, y: 0, w: 100, h: 100, style: { ...style({ warp: { on: true, cols: n, rows: n, pts } }), size: 20 } };
    const m = meshMap(pts, n, n, 100, 100);
    const turn = (p) => {
      const f = m.at(p[0], p[1]);
      const fx = m.at(p[0] + 1e-3, p[1]);
      const fy = m.at(p[0], p[1] + 1e-3);
      return Math.sign((fx[0] - f[0]) * (fy[1] - f[1]) - (fy[0] - f[0]) * (fx[1] - f[1]));
    };
    let flips = 0;
    // Before the point grid was asked, 7 of these landed turned over.
    for (let y = 40; y <= 64; y += 1) {
      for (let x = 40; x <= 64; x += 1) {
        const mark = stroke([[x, y], [x + 0.5, y]]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const [out] = moveMarks(box, [mark], 0, dx, dy);
          if (out !== mark && turn(out.pts[0]) !== turn(mark.pts[0])) flips++;
        }
      }
    }
    expect(flips).toBe(0);
  });

  // The sheet tests are for meshes that may fold. On meshes that cannot, a
  // mark inside the box moved 1 or 20 px in any direction (and so still
  // inside the box) lands under the pointer.
  const ID = identityMesh(2, 2, 100, 100);
  const UNFOLDED = {
    identity: { on: true, cols: 2, rows: 2, pts: ID.map(([x, y], i) => (i === 4 ? [x + 1e-9, y] : [x, y])) },
    perspective: { on: true, cols: 1, rows: 1, pts: [[0, 0], [100, 10], [-5, 100], [115, 90]] },
    'smooth perspective': { on: true, cols: 2, rows: 2, pts: [[0, 0], [50, 5], [100, 10], [-3, 50], [52, 50], [108, 50], [-5, 100], [55, 95], [115, 90]] },
    bulge: { on: true, cols: 2, rows: 2, pts: ID.map(([x, y]) => (x === 50 || y === 50 ? [x + (x - 50) * 0.2, y + (y - 50) * 0.2] : [x, y])) },
    wave: { on: true, cols: 4, rows: 2, pts: identityMesh(4, 2, 100, 100).map(([x, y], i) => [x, y + (i % 5 === 1 ? 12 : i % 5 === 3 ? -12 : 0)]) },
  };
  for (const [name, warp] of Object.entries(UNFOLDED)) {
    it(`on a ${name} mesh every move inside the box is taken`, () => {
      const box = { id: 'b', x: 0, y: 0, w: 100, h: 100, style: { ...style({ warp }), size: 20 } };
      for (let y = 25; y <= 75; y += 10) {
        for (let x = 25; x <= 75; x += 10) {
          const mark = stroke([[x, y], [x + 1, y]]);
          for (const d of [1, 20]) {
            for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
              const [out] = moveMarks(box, [mark], 0, dx, dy);
              expect(out).not.toBe(mark);
              const was = shown(box, mark.pts[0]);
              near(shown(box, out.pts[0]), [was[0] + dx, was[1] + dy], 1e-2);
            }
          }
        }
      }
    });
  }
});
