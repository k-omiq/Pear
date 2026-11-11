// The transform gizmo's handles stay on the box's corners after the box
// changes size. The mesh is stored in box-local px, and before `resizeBox`
// carried it to the new size a box scaled up 2.7x kept its handles (and its
// text) in the old rectangle - about 37% of the box's width.
import { describe, it, expect, beforeEach } from 'vitest';
import { handlePoints, ghostOutline, beginWarpDrag, dragWarpTo, commitWarpDrag } from './warp-gizmo.js';
import { scaleMesh } from './warp.js';
import { defaultStyle, normalizeWarp } from './data.js';
import { app, loadProjectPages, byId, resizeBox, cloneStyle } from './store.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';

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
    boxes: [box('turned', { style: { rotation: 5 } }), box('upright'), box('plain')],
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

describe('the gizmo after a box changes size', () => {
  beforeEach(() => {
    initHistory();
    resetHistory();
    loadProjectPages(doc());
    app.selectedId = 'turned';
  });

  it('a turned box scaled up wide by a corner keeps its handles on its corners', () => {
    const b = byId('turned');
    dragCorner(b, 3, 12, 6);
    // The corner drag's own call: the box and the style as the press found
    // them, every step scaled from those.
    const base = { w: b.w, h: b.h, style: cloneStyle(b.style) };
    const k = 2.7;
    resizeBox(1, b.id, { w: 200 * k * 0.6, h: 90 * k * 0.6, scale: k * 0.6 }, base);
    resizeBox(1, b.id, { w: 200 * k, h: 90 * k, scale: k }, base);
    expect(b.w).toBeCloseTo(540, 6);
    expect(b.h).toBeCloseTo(243, 6);
    expect(b.style.rotation).toBe(5);
    // Steps of one drag do not compound: the dragged corner is the press's
    // offset times the final factor.
    close(corners(b), [
      [0, 0],
      [b.w, 0],
      [0, b.h],
      [b.w + 12 * k, b.h + 6 * k],
    ]);
    // The ghost is the box rect, and the three untouched handles sit on it.
    const g = ghostOutline(b.w, b.h);
    close(corners(b).slice(0, 3), [g[0], g[1], g[3]]);
  });

  it('a turned box made wider by a side keeps its handles on its corners', () => {
    const b = byId('turned');
    dragCorner(b, 1, 10, -8);
    resizeBox(1, b.id, { w: 540 });
    close(corners(b), [
      [0, 0],
      [540 + 10 * 2.7, -8],
      [0, b.h],
      [540, b.h],
    ]);
  });

  it('an upright box resized from the Inspector keeps its handles on its corners', () => {
    const b = byId('upright');
    dragCorner(b, 0, -6, -4);
    resizeBox(1, b.id, { w: 100 });
    resizeBox(1, b.id, { h: 180 });
    close(corners(b), [
      [-3, -8],
      [100, 0],
      [0, 180],
      [100, 180],
    ]);
  });

  it('a box with no mesh dragged yet has its handles on the corners at any size', () => {
    const b = byId('plain');
    resizeBox(1, b.id, { w: 480, h: 60 });
    expect(b.style.warp.pts).toEqual([]);
    close(corners(b), [
      [0, 0],
      [480, 0],
      [0, 60],
      [480, 60],
    ]);
  });

  it('a mesh switched off still follows the box, so switching it back on fits', () => {
    const b = byId('upright');
    dragCorner(b, 3, 20, 10);
    b.style.warp.on = false;
    resizeBox(1, b.id, { w: 400, h: 180 });
    b.style.warp.on = true;
    close(corners(b).slice(0, 3), [
      [0, 0],
      [b.w, 0],
      [0, b.h],
    ]);
  });

  it('the scaled mesh is one the sanitiser keeps as it is', () => {
    const b = byId('turned');
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
