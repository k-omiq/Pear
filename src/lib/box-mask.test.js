import { describe, expect, it } from 'vitest';
import {
  normalizeMask,
  maskActive,
  maskInBoxFrame,
  maskOnPage,
  maskFromClip,
  translateMask,
  scaleMask,
  insetPolygon,
  pageToBox,
  boxToPage,
  bubbleOutline,
  bubbleClip,
  linkClip,
  crossesItself,
  frameKey,
  MASK_SHAPES_MAX,
} from './box-mask.js';

// ===========================================================================
// The mask is pinned to the page (`box.mask`, page px): whatever is done to
// the box, a shape stays where it was drawn, and the painters' frame
// (`maskInBoxFrame`) is the page carried into the box.
// ===========================================================================

const style = (over = {}) => ({ rotation: 0, flipH: false, flipV: false, warp: { on: false, cols: 2, rows: 2, pts: [] }, ...over });
const boxOf = (over = {}) => ({ id: 'b', x: 100, y: 80, w: 200, h: 120, text: 'HI', style: style(over.style), ...over, style: style(over.style) });

const MASK = {
  on: true,
  shapes: [
    { kind: 'poly', op: 'keep', pts: [[90, 70], [260, 75], [250, 210], [95, 190]] },
    { kind: 'stroke', op: 'hide', size: 12, pts: [[120, 100], [180, 140]] },
    { kind: 'ellipse', op: 'hide', cx: 200, cy: 130, rx: 20, ry: 10 },
  ],
};

// A shape's points on the page, as drawn: the frame's points carried back.
const back = (box) =>
  maskInBoxFrame(box).map((sh) => {
    if (sh.kind === 'ellipse') return { c: boxToPage(box, [sh.cx, sh.cy]) };
    return { pts: sh.pts.map((p) => boxToPage(box, p)) };
  });
const close = (a, b) => {
  expect(a.length).toBe(b.length);
  a.forEach((p, i) => {
    expect(p[0]).toBeCloseTo(b[i][0], 6);
    expect(p[1]).toBeCloseTo(b[i][1], 6);
  });
};

describe('a mask shape keeps its page position', () => {
  const states = {
    plain: {},
    moved: { x: 37, y: 241 },
    turned: { style: { rotation: 33 } },
    flipped: { style: { flipH: true, flipV: true, rotation: -12 } },
    resized: { w: 340, h: 60 },
    warped: { style: { warp: { on: true, cols: 2, rows: 2, pts: [[0, 0], [100, 30], [200, 0], [0, 60], [120, 70], [200, 60], [0, 120], [100, 90], [200, 120]] } } },
    reflowed: { text: 'A MUCH LONGER LINE OF TEXT\nOVER TWO' },
  };
  for (const [name, over] of Object.entries(states)) {
    it(`after the box is ${name}`, () => {
      const box = { ...boxOf(over), mask: normalizeMask(MASK) };
      // The stored shapes are the page's, untouched by anything done to the box.
      expect(maskOnPage(box)).toEqual(normalizeMask(MASK).shapes);
      // And the frame the painters cut in carries them to the same page px.
      const got = back(box);
      close(got[0].pts, MASK.shapes[0].pts);
      close(got[1].pts, MASK.shapes[1].pts);
      // An ellipse stays one on a straight box and becomes a polygon on a
      // turned one; either way its centre is where it was drawn.
      const e = maskInBoxFrame(box)[2];
      if ((box.style.rotation || 0) % 360 === 0) {
        expect(e.kind).toBe('ellipse');
        close([got[2].c], [[200, 130]]);
      } else {
        expect(e.kind).toBe('poly');
        const xs = got[2].pts.map((p) => p[0]);
        const ys = got[2].pts.map((p) => p[1]);
        expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(200, 6);
        expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(130, 6);
      }
      // The ops go with the shapes.
      expect(maskInBoxFrame(box).map((sh) => sh.op)).toEqual(['keep', 'hide', 'hide']);
    });
  }

  it('the frame is the page less the box corner, turned back and mirrored', () => {
    const box = boxOf({ style: { rotation: 90, flipH: true } });
    for (const p of [[0, 0], [100, 80], [300, 200], [-40, 512]]) close([boxToPage(box, pageToBox(box, p))], [p]);
    // The box's centre is the frame's centre.
    close([pageToBox(box, [200, 140])], [[100, 60]]);
  });
});

describe('carrying a mask with the page', () => {
  it('a translate and a page rescale move and scale every shape; a brush keeps a round end', () => {
    const m = normalizeMask(MASK);
    const t = translateMask(m, 5, -3);
    expect(t.shapes[0].pts[0]).toEqual([95, 67]);
    expect(t.shapes[2]).toMatchObject({ cx: 205, cy: 127, rx: 20, ry: 10 });
    const s = scaleMask(m, 2, 0.5);
    expect(s.shapes[0].pts[1]).toEqual([520, 37.5]);
    expect(s.shapes[1].size).toBeCloseTo(12, 9);
    expect(s.shapes[2]).toMatchObject({ cx: 400, cy: 65, rx: 40, ry: 5 });
  });

  it('normalizeMask keeps one bubble link, drops what it cannot draw, and caps the count', () => {
    const m = normalizeMask({
      on: true,
      shapes: [
        { kind: 'bubble', inset: 99 },
        { kind: 'bubble', inset: 3 },
        { kind: 'ellipse', cx: 1, cy: 1, rx: 0, ry: 3 },
        { kind: 'stroke', size: 900, pts: [[1, 2]] },
        { kind: 'what' },
      ],
    });
    expect(m.shapes).toEqual([
      { kind: 'bubble', op: 'keep', inset: 20 },
      { kind: 'stroke', op: 'hide', size: 200, pts: [[1, 2]] },
    ]);
    expect(normalizeMask(null)).toBe(null);
    const many = normalizeMask({ on: true, shapes: Array.from({ length: MASK_SHAPES_MAX + 9 }, () => ({ kind: 'stroke', size: 2, pts: [[0, 0]] })) });
    expect(many.shapes.length).toBe(MASK_SHAPES_MAX);
  });

  it('a mask that is off, or a link with no outline, changes nothing', () => {
    expect(maskActive({ mask: { on: false, shapes: MASK.shapes } })).toBe(false);
    expect(maskActive({ mask: { on: true, shapes: [] } })).toBe(false);
    expect(maskActive({ mask: { on: true, shapes: [{ kind: 'bubble', op: 'keep', inset: 2 }] }, fit: null })).toBe(false);
    expect(maskInBoxFrame({ ...boxOf(), mask: { ...normalizeMask(MASK), on: false } })).toEqual([]);
  });
});

describe('the old mask, in the style, comes to the page', () => {
  const clip = (mode, shapes) => ({ on: true, mode, brushSize: 20, shapes });
  it('a plain box: its corner added', () => {
    const box = boxOf({ style: { clip: clip('include', [{ kind: 'ellipse', cx: 50, cy: 40, rx: 10, ry: 5 }, { kind: 'poly', pts: [[0, 0], [10, 0], [0, 10]] }]) } });
    const m = maskFromClip(box);
    expect(m.on).toBe(true);
    expect(m.shapes[0]).toEqual({ kind: 'ellipse', op: 'keep', cx: 150, cy: 120, rx: 10, ry: 5 });
    expect(m.shapes[1]).toEqual({ kind: 'poly', op: 'keep', pts: [[100, 80], [110, 80], [100, 90]] });
  });

  it('a turned and mirrored box: through the flip and the turn, an ellipse becoming a polygon', () => {
    const box = boxOf({ style: { rotation: 90, flipH: true, clip: clip('exclude', [{ kind: 'stroke', size: 6, pts: [[0, 0], [100, 60]] }, { kind: 'ellipse', cx: 100, cy: 60, rx: 10, ry: 5 }]) } });
    const m = maskFromClip(box);
    // The box's centre stays its centre; its corner (0, 0), flipped to the
    // far side and turned a quarter, lands where the box's own picture puts it.
    close(m.shapes[0].pts, [boxToPage(box, [0, 0]), [200, 140]]);
    expect(m.shapes[0].op).toBe('hide');
    expect(m.shapes[1].kind).toBe('poly');
    expect(m.shapes[1].op).toBe('hide');
    const xs = m.shapes[1].pts.map((p) => p[0]);
    // Turned a quarter: its x radius is up and down now.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 6);
  });

  it('a warped box: through its mesh, as the old engine bent the shapes', () => {
    // A mesh that slides the whole box 20 px right and 10 down.
    const pts = [];
    for (let r = 0; r <= 2; r++) for (let c = 0; c <= 2; c++) pts.push([c * 100 + 20, r * 60 + 10]);
    const box = boxOf({ style: { warp: { on: true, cols: 2, rows: 2, pts }, clip: clip('include', [{ kind: 'poly', pts: [[10, 10], [50, 10], [50, 50]] }, { kind: 'ellipse', cx: 100, cy: 60, rx: 10, ry: 10 }]) } });
    const m = maskFromClip(box);
    // Its edges cut into steps of 4 px or less before they were carried.
    const poly = m.shapes[0].pts;
    expect(poly.length).toBeGreaterThan(3);
    close([poly[0]], [[130, 100]]);
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      expect(Math.hypot(bx - ax, by - ay)).toBeLessThanOrEqual(4 + 1e-9);
    }
    expect(m.shapes[1].kind).toBe('poly');
    const xs = m.shapes[1].pts.map((p) => p[0]);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(220, 6);
  });

  it('a warped box: an edge follows the bend, and a brush keeps the width the mesh gave it', () => {
    // A mesh that stretches the box's left half twice as wide and leaves the
    // right half as it was (the middle column moved right).
    const pts = [];
    for (let r = 0; r <= 2; r++) for (let c = 0; c <= 2; c++) pts.push([[0, 200, 300][c], r * 60]);
    const box = boxOf({ x: 0, y: 0, style: { warp: { on: true, cols: 2, rows: 2, pts }, clip: clip('exclude', [
      { kind: 'stroke', size: 6, pts: [[50, 10], [50, 110]] },
      { kind: 'stroke', size: 6, pts: [[10, 60], [190, 60]] },
    ]) } });
    const m = maskFromClip(box);
    // The upright line in the stretched half comes out about twice as wide;
    // the level one, stretched along its length only, keeps about its width
    // where it runs through that half.
    const upright = (sh) => Math.abs(sh.pts[0][0] - sh.pts[sh.pts.length - 1][0]) < 1;
    const up = m.shapes.find((sh) => upright(sh) && sh.pts[0][0] < 150);
    expect(up.size).toBeGreaterThan(6 * 1.8);
    expect(up.size).toBeLessThan(6 * 2.2);
    const level = m.shapes.filter((sh) => Math.abs(sh.pts[0][1] - sh.pts[sh.pts.length - 1][1]) < 1 && sh.pts[0][0] < 150);
    expect(level.length).toBeGreaterThan(0);
    for (const sh of level) expect(sh.size).toBeLessThan(6 * 1.2);
  });

  it('a warped box: a wide ellipse keeps steps of 4 px or less', () => {
    // The sliding mesh of the test above; an ellipse of radius 2000 needs
    // over 3000 points, past the old cap of 1024.
    const pts = [];
    for (let r = 0; r <= 2; r++) for (let c = 0; c <= 2; c++) pts.push([c * 100 + 20, r * 60 + 10]);
    const box = boxOf({ style: { warp: { on: true, cols: 2, rows: 2, pts }, clip: clip('include', [{ kind: 'ellipse', cx: 100, cy: 60, rx: 2000, ry: 1500 }]) } });
    const ring = maskFromClip(box).shapes[0].pts;
    expect(ring.length).toBeGreaterThan(3000);
    let worst = 0;
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % ring.length];
      worst = Math.max(worst, Math.hypot(bx - ax, by - ay));
    }
    expect(worst).toBeLessThanOrEqual(4 + 1e-9);
  });

  it('a stray huge ellipse is capped: a few thousand points, not millions', () => {
    const pts = [];
    for (let r = 0; r <= 2; r++) for (let c = 0; c <= 2; c++) pts.push([c * 100 + 20, r * 60 + 10]);
    const box = boxOf({ style: { warp: { on: true, cols: 2, rows: 2, pts }, clip: clip('include', [{ kind: 'ellipse', cx: 100, cy: 60, rx: 4e6, ry: 3e6 }]) } });
    const ring = maskFromClip(box).shapes[0].pts;
    expect(ring.length).toBeGreaterThan(3000);
    expect(ring.length).toBeLessThanOrEqual(8192 + 4096);
  });

  it('a stray huge polygon is cut at a capped count: the densify step grows past the cap', () => {
    const pts = [];
    for (let r = 0; r <= 2; r++) for (let c = 0; c <= 2; c++) pts.push([c * 100 + 20, r * 60 + 10]);
    // 4e6 px around: cut every 4 px, a million points.
    const huge = [[-1e6, -1e6], [0, -1e6], [0, 1e6], [-1e6, 1e6]];
    const box = boxOf({ style: { warp: { on: true, cols: 2, rows: 2, pts }, clip: clip('include', [{ kind: 'poly', pts: huge }]) } });
    const cut = maskFromClip(box).shapes[0].pts;
    expect(cut.length).toBeGreaterThan(8000);
    expect(cut.length).toBeLessThanOrEqual(8192 + huge.length);
    // A page-size one is still cut every 4 px, at most.
    const page = [[0, 0], [800, 0], [800, 1200], [0, 1200]];
    const small = boxOf({ style: { warp: { on: true, cols: 2, rows: 2, pts }, clip: clip('include', [{ kind: 'poly', pts: page }]) } });
    expect(maskFromClip(small).shapes[0].pts.length).toBe(1000);
  });

  it('a style with no mask has none, and an empty switched-on one keeps its switch', () => {
    expect(maskFromClip(boxOf())).toBe(null);
    expect(maskFromClip(boxOf({ style: { clip: { on: true, mode: 'exclude', shapes: [] } } }))).toEqual({ on: true, shapes: [] });
  });
});

const signed = (pts) => pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2;

describe('the bubble link', () => {
  const square = (x0, y0, s) => ({ kind: 'poly', pts: [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]] });
  it('follows the outline when it is refit, inset by its px', () => {
    const box = { ...boxOf(), fit: square(100, 100, 50), mask: normalizeMask({ on: true, shapes: [{ kind: 'bubble', inset: 5 }] }) };
    expect(maskActive(box)).toBe(true);
    close(maskOnPage(box)[0].pts, [[105, 105], [145, 105], [145, 145], [105, 145]]);
    // A refit outline takes the clip with it: nothing of the mask changed.
    box.fit = square(300, 40, 80);
    close(maskOnPage(box)[0].pts, [[305, 45], [375, 45], [375, 115], [305, 115]]);
    expect(maskInBoxFrame(box)[0].op).toBe('keep');
  });

  it('is worked out once for a fit and an inset, and again when either changes', () => {
    const box = { ...boxOf(), fit: square(100, 100, 50), mask: normalizeMask({ on: true, shapes: [{ kind: 'bubble', inset: 5 }] }) };
    const a = linkClip(box, 5);
    expect(linkClip(box, 5)).toBe(a);
    expect(maskActive(box)).toBe(true);
    expect(maskOnPage(box)[0].pts).toBe(a);
    const b = linkClip(box, 3);
    expect(b).not.toBe(a);
    close(b, [[103, 103], [147, 103], [147, 147], [103, 147]]);
    box.fit = square(100, 100, 50);
    expect(linkClip(box, 3)).not.toBe(b);
    expect(linkClip({ ...box, fit: null }, 3)).toBe(null);
  });

  it('a narrow bubble keeps a band of itself, and an outline with no area hides nothing', () => {
    const thin = square(0, 0, 10).pts.map(([x, y]) => [x * 10, y]); // 100 x 10
    const box = { ...boxOf(), fit: { kind: 'poly', pts: thin }, mask: normalizeMask({ on: true, shapes: [{ kind: 'bubble', inset: 20 }] }) };
    // The inset is capped at a quarter of the short side: 2.5 px, not 20.
    const kept = maskOnPage(box)[0].pts;
    close([kept[0]], [[2.5, 2.5]]);
    expect(bubbleClip(thin, 20)).toEqual(kept);
    // A line of an outline: no link drawn, so nothing is cut.
    const flat = { ...box, fit: { kind: 'poly', pts: [[0, 0], [50, 0], [100, 0]] } };
    expect(maskActive(flat)).toBe(false);
    expect(maskInBoxFrame(flat)).toEqual([]);
  });

  it('an inset that folds over itself is not used, though its total area kept its sign', () => {
    // A square with a 4 px tab: inset 5 px, the tab's sides swap and run
    // back along the base. A square with a pointed spike: its sides pass
    // each other. The square keeps the total area positive both times.
    const tab = [[0, 0], [100, 0], [100, 100], [52, 100], [52, 160], [48, 160], [48, 100], [0, 100]];
    const spike = [[0, 0], [100, 0], [100, 100], [53, 100], [50, 170], [47, 100], [0, 100]];
    for (const pts of [tab, spike]) {
      const inner = insetPolygon(pts, 5);
      expect(crossesItself(inner)).toBe(true);
      expect(Math.sign(signed(inner))).toBe(1);
      expect(bubbleClip(pts, 5)).toEqual(pts);
    }
    // A plain square insets as before, and a point said twice is no fold.
    const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
    expect(crossesItself(sq)).toBe(false);
    expect(crossesItself([[0, 0], [100, 0], [100, 0], [100, 100], [0, 100]])).toBe(false);
    close(bubbleClip(sq, 5), [[5, 5], [95, 5], [95, 95], [5, 95]]);
  });

  it('a page rescale scales the inset with the outline', () => {
    const m = scaleMask(normalizeMask({ on: true, shapes: [{ kind: 'bubble', inset: 4 }] }), 2, 2);
    expect(m.shapes[0].inset).toBeCloseTo(8, 9);
  });

  it('an inset runs inside either way round, and a fit stated as an ellipse or a rectangle is walked round', () => {
    const cw = [[0, 0], [10, 0], [10, 10], [0, 10]];
    close(insetPolygon(cw, 1), [[1, 1], [9, 1], [9, 9], [1, 9]]);
    close(insetPolygon([...cw].reverse(), 1), [[1, 9], [9, 9], [9, 1], [1, 1]]);
    expect(bubbleOutline({ fit: { kind: 'rect', x: 1, y: 2, w: 3, h: 4 } })).toEqual([[1, 2], [4, 2], [4, 6], [1, 6]]);
    expect(bubbleOutline({ fit: { kind: 'ellipse', cx: 0, cy: 0, rx: 5, ry: 3 } }).length).toBeGreaterThan(8);
    expect(bubbleOutline({ fit: null })).toBe(null);
  });
});

describe('the key a masked picture is painted under', () => {
  it('changes with the shapes, where the box stands, its turn, flips and followed outline, and with nothing else', () => {
    const mask = { on: true, shapes: [{ kind: 'stroke', op: 'hide', size: 4, pts: [[1, 2], [3, 4]] }] };
    const box = { x: 10, y: 20, w: 100, h: 50, style: { rotation: 0 }, mask, fit: { kind: 'ellipse', cx: 60, cy: 45, rx: 50, ry: 25 } };
    const k = frameKey(box, box.mask);
    expect(frameKey(box, box.mask)).toBe(k);
    expect(frameKey({ ...box }, box.mask)).toBe(k);
    // A new list or a new mask is a new revision; so is the switch.
    expect(frameKey(box, { ...mask })).not.toBe(k);
    mask.shapes = [...mask.shapes];
    const k2 = frameKey(box, mask);
    expect(k2).not.toBe(k);
    expect(frameKey(box, { ...mask, shapes: mask.shapes, on: false })).not.toBe(frameKey(box, { ...mask, shapes: mask.shapes, on: true }));
    for (const moved of [{ x: 11 }, { y: 21 }, { w: 99 }, { h: 51 }, { style: { rotation: 5 } }, { style: { flipH: true } }, { style: { flipV: true } }]) {
      expect(frameKey({ ...box, ...moved }, mask)).not.toBe(k2);
    }
    // The outline counts only for a mask that follows it.
    expect(frameKey({ ...box, fit: { ...box.fit } }, mask)).toBe(k2);
    const linked = { on: true, shapes: [{ kind: 'bubble', op: 'keep', inset: 4 }] };
    expect(frameKey({ ...box, fit: { ...box.fit } }, linked)).not.toBe(frameKey(box, linked));
  });
});
