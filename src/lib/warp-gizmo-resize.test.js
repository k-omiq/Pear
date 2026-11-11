// The transform gizmo's handles stay on the box's corners after the box
// changes size. The mesh is stored in box-local px, and before `resizeBox`
// carried it to the new size a box scaled up 2.7x kept its handles (and its
// text) in the old rectangle - about 37% of the box's width.
//
// The turn is not in any of this: the gizmo is a child of the box element and
// takes its rotation from CSS, and the mesh is box-local, so a box turned 5
// degrees and an upright one give the same handle positions. One test says so.
import { describe, it, expect, beforeEach } from 'vitest';
import { handlePoints, ghostOutline, beginWarpDrag, dragWarpTo, commitWarpDrag, regridWarp } from './warp-gizmo.js';
import { scaleMesh, warpForSize, meshMap } from './warp.js';
import { defaultStyle, normalizeWarp } from './data.js';
import {
  app,
  loadProjectPages,
  byId,
  pageById,
  resizeBox,
  cloneStyle,
  boxSnap,
  boxEditRecords,
  rescalePageGeometry,
  fitWarpToBox,
  markUnsaved,
} from './store.svelte.js';
import { initHistory, resetHistory, record, undo, redo, peekStack } from './editor/history.svelte.js';

const box = (id, over = {}) => ({
  id,
  lineN: null,
  text: 'Gayyyy',
  x: 100,
  y: 100,
  w: 200,
  h: 90,
  ...over,
  style: {
    ...defaultStyle(),
    autoHeight: false,
    warp: { on: true, cols: 1, rows: 1, pts: [] },
    ...(over.style ?? {}),
  },
});

const doc = () => [
  {
    id: 1,
    w: 1000,
    h: 1400,
    raw: null,
    cleaned: null,
    lines: [],
    boxes: [box('a', { style: { rotation: 5 } }), box('b'), box('plain')],
  },
];

// A corner dragged out, the way the gizmo commits it.
const dragCorner = (b, i, dx, dy) => {
  const before = beginWarpDrag(b);
  const p = b.style.warp.pts[i];
  dragWarpTo(b, i, p[0] + dx, p[1] + dy);
  commitWarpDrag(b, 1, before);
};

// The four handles of a 1x1 mesh, tl tr bl br, as the gizmo draws them.
const corners = (b) => handlePoints(b.style.warp, b.w, b.h).map((p) => [p.x, p.y]);

const close = (got, want) => {
  expect(got).toHaveLength(want.length);
  got.forEach((p, k) => {
    expect(p[0]).toBeCloseTo(want[k][0], 6);
    expect(p[1]).toBeCloseTo(want[k][1], 6);
  });
};

// The box's corners, with the bottom-right one carried out by (dx, dy).
const onCorners = (b, dx = 0, dy = 0) =>
  close(corners(b), [
    [0, 0],
    [b.w, 0],
    [0, b.h],
    [b.w + dx, b.h + dy],
  ]);

// An Inspector W/H edit, recorded the way the Inspector's `touch` records it.
const inspectorResize = (b, geom) => {
  const before = boxSnap(b);
  resizeBox(1, b.id, geom);
  for (const e of boxEditRecords({ pageId: 1, boxId: b.id }, before, boxSnap(b), true)) record(e);
};

// A corner drag, recorded the way TextBox.svelte records one that changed the
// style: one `style` entry carrying the geometry on both sides.
const cornerScale = (b, k) => {
  const o = { x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size };
  const styleStart = cloneStyle(b.style);
  const base = { w: b.w, h: b.h, style: styleStart };
  for (const step of [k * 0.5, k * 0.8, k]) resizeBox(1, b.id, { w: o.w * step, h: o.h * step, scale: step }, base);
  markUnsaved();
  record({
    t: 'style',
    pageId: 1,
    boxId: b.id,
    before: styleStart,
    after: cloneStyle(b.style),
    geomBefore: o,
    geomAfter: { x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size },
  });
};

describe('the gizmo after a box changes size', () => {
  beforeEach(() => {
    initHistory();
    resetHistory();
    loadProjectPages(doc());
    app.selectedId = 'a';
  });

  it('a box scaled up 2.7x by a corner keeps its handles on its corners, and one undo puts it back', () => {
    const b = byId('a');
    dragCorner(b, 3, 12, 6);
    const n = peekStack().undo.length;
    cornerScale(b, 2.7);
    expect(b.w).toBeCloseTo(540, 6);
    expect(b.h).toBeCloseTo(243, 6);
    // The steps of one drag do not compound: the dragged corner is the
    // press's offset times the final factor.
    onCorners(b, 12 * 2.7, 6 * 2.7);
    const g = ghostOutline(b.w, b.h);
    close(corners(b).slice(0, 3), [g[0], g[1], g[3]]);

    expect(peekStack().undo).toHaveLength(n + 1);
    undo();
    expect(b.w).toBe(200);
    onCorners(b, 12, 6);
    redo();
    expect(b.w).toBeCloseTo(540, 6);
    onCorners(b, 12 * 2.7, 6 * 2.7);
  });

  it('the box turned or not, the handles are the same: the mesh is box-local', () => {
    const a = byId('a');
    const b = byId('b');
    expect(a.style.rotation).toBe(5);
    expect(b.style.rotation).toBe(0);
    for (const x of [a, b]) {
      dragCorner(x, 1, 10, -8);
      resizeBox(1, x.id, { w: 540 });
    }
    expect(corners(a)).toEqual(corners(b));
    close(corners(a), [
      [0, 0],
      [540 + 10 * 2.7, -8],
      [0, a.h],
      [540, a.h],
    ]);
  });

  it('an Inspector W edit is one undo step, and the undo puts the mesh back with the width', () => {
    const b = byId('b');
    dragCorner(b, 3, 20, 10);
    const n = peekStack().undo.length;
    inspectorResize(b, { w: 540 });
    onCorners(b, 20 * 2.7, 10);
    expect(peekStack().undo).toHaveLength(n + 1);
    undo();
    expect(b.w).toBe(200);
    onCorners(b, 20, 10);
    redo();
    expect(b.w).toBe(540);
    onCorners(b, 20 * 2.7, 10);
  });

  it('an Inspector H edit and a W edit, each undone in turn', () => {
    const b = byId('b');
    dragCorner(b, 0, -6, -4);
    inspectorResize(b, { w: 100 });
    inspectorResize(b, { h: 180 });
    close(corners(b), [
      [-3, -8],
      [100, 0],
      [0, 180],
      [100, 180],
    ]);
    undo();
    expect(b.h).toBe(90);
    close(corners(b).slice(0, 2), [
      [-3, -4],
      [100, 0],
    ]);
    undo();
    expect(b.w).toBe(200);
    close(corners(b).slice(0, 2), [
      [-6, -4],
      [200, 0],
    ]);
  });

  it('a box with no mesh dragged yet has its handles on the corners at any size', () => {
    const b = byId('plain');
    resizeBox(1, b.id, { w: 480, h: 60 });
    expect(b.style.warp.pts).toEqual([]);
    onCorners(b);
  });

  it('a page rescale carries the mesh and its size with the box', () => {
    const b = byId('a');
    dragCorner(b, 3, 12, 6);
    rescalePageGeometry(pageById(1), 2, 1.5);
    expect(b.w).toBeCloseTo(400, 6);
    expect(b.h).toBeCloseTo(135, 6);
    onCorners(b, 24, 9);
    expect(b.style.warp.w).toBeCloseTo(400, 6);
    expect(b.style.warp.h).toBeCloseTo(135, 6);
  });

  it('a mesh switched off while the box is laid out fits it again when switched on', () => {
    const b = byId('b');
    dragCorner(b, 3, 20, 10);
    b.style.warp.on = false;
    // What auto height, a refit or a shrink do: the rectangle, nothing else.
    b.w = 400;
    b.h = 45;
    b.style.warp.on = true;
    expect(fitWarpToBox(b)).toBe(true);
    onCorners(b, 40, 5);
    // And the gizmo's first press does the same on its own.
    b.w = 200;
    b.h = 90;
    beginWarpDrag(b);
    onCorners(b, 20, 10);
  });

  it('a resize of a box whose mesh was laid out while off scales from the box it fits', () => {
    const b = byId('b');
    dragCorner(b, 3, 20, 10);
    b.style.warp.on = false;
    b.w = 400;
    resizeBox(1, b.id, { w: 800 });
    b.style.warp.on = true;
    onCorners(b, 80, 10);
  });

  it('the painted map is the same picture, scaled', () => {
    const b = byId('a');
    dragCorner(b, 3, 30, 14);
    dragCorner(b, 1, 6, -5);
    const was = meshMap(b.style.warp.pts, 1, 1, b.w, b.h);
    cornerScale(b, 2.5);
    const now = meshMap(b.style.warp.pts, 1, 1, b.w, b.h);
    for (const [u, v] of [[0, 0], [0.5, 0.5], [1, 1], [0.25, 0.8], [0.9, 0.1]]) {
      const p = was.at(u * 200, v * 90);
      const q = now.at(u * 500, v * 225);
      expect(q[0]).toBeCloseTo(p[0] * 2.5, 6);
      expect(q[1]).toBeCloseTo(p[1] * 2.5, 6);
    }
  });

  it('the scaled mesh is one the sanitiser keeps as it is', () => {
    const b = byId('a');
    dragCorner(b, 2, -5, 5);
    resizeBox(1, b.id, { w: 300, h: 135, scale: 1.5 }, { w: 200, h: 90, style: cloneStyle(b.style) });
    const w = cloneStyle(b.style).warp;
    expect(normalizeWarp(w)).toEqual(w);
  });
});

describe('scaleMesh', () => {
  it('scales every point per axis into fresh points', () => {
    const pts = [
      [0, 0],
      [10, 0],
      [0, 5],
      [12, 7],
    ];
    const out = scaleMesh(pts, 2, 3);
    expect(out).toEqual([
      [0, 0],
      [20, 0],
      [0, 15],
      [24, 21],
    ]);
    out[0][0] = 99;
    expect(pts[0][0]).toBe(0);
  });

  it('keeps an empty mesh empty and ignores a factor that is not a size', () => {
    expect(scaleMesh([], 2, 2)).toEqual([]);
    expect(scaleMesh(null, 2, 2)).toEqual([]);
    expect(scaleMesh([[4, 4]], 0, NaN)).toEqual([[4, 4]]);
  });
});

describe('warpForSize', () => {
  const pts = [
    [0, 0],
    [100, 0],
    [0, 50],
    [110, 55],
  ];

  it('reads a mesh from before the stamp exactly as it was, stamped at the box', () => {
    const w = { on: true, cols: 1, rows: 1, pts };
    expect(warpForSize(w, 100, 50)).toEqual({ ...w, w: 100, h: 50 });
    expect(warpForSize(w, 300, 50).pts).toEqual(pts);
  });

  it('scales a stamped mesh to the box, and hands back the same block when it fits', () => {
    const w = { on: true, cols: 1, rows: 1, pts, w: 100, h: 50 };
    expect(warpForSize(w, 100, 50)).toBe(w);
    expect(warpForSize(w, 200, 25)).toEqual({ ...w, pts: scaleMesh(pts, 2, 0.5), w: 200, h: 25 });
  });

  it('an empty mesh carries no stamp', () => {
    expect(warpForSize({ on: false, cols: 1, rows: 1, pts: [], w: 9, h: 9 }, 100, 50)).toEqual({ on: false, cols: 1, rows: 1, pts: [] });
  });

  it('the sanitiser keeps a stamp only beside points', () => {
    expect(normalizeWarp({ on: true, cols: 1, rows: 1, pts, w: 100, h: 50 })).toMatchObject({ w: 100, h: 50 });
    expect(normalizeWarp({ on: true, cols: 1, rows: 1, pts: [], w: 100, h: 50 })).not.toHaveProperty('w');
    expect(normalizeWarp({ on: true, cols: 1, rows: 1, pts, w: -1, h: 50 })).not.toHaveProperty('w');
  });

  it('a regrid reads a mesh stamped at another size at the box', () => {
    const w = { on: true, cols: 1, rows: 1, pts, w: 100, h: 50 };
    const out = regridWarp(w, 1, 1, 200, 100);
    expect(out.pts).toEqual(scaleMesh(pts, 2, 2));
    expect(out).toMatchObject({ w: 200, h: 100 });
  });
});
