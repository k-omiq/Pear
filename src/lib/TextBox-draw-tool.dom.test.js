import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, selectBox, setZoom } from './store.svelte.js';
import { initHistory, resetHistory, undo } from './editor/history.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { drawTool, drawSettings, setDrawTool, clearDrawTool } from './box-draw-tool.svelte.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

// ===========================================================================
// The shared draw tool on a box, armed for the mask, on the page layer that
// takes the pointer over the whole page: the Rectangle and Move kinds, Delete on a picked shape, and the tool going away with Escape
// or the selection.
// ===========================================================================
// The page frame is a detached element, so its rect is all zeros: a client
// point is a page point at zoom 1. The mask is pinned to the page, so every
// point below is a page px, the box itself at (100, 200).

const ELLIPSE = { kind: 'ellipse', op: 'hide', cx: 150, cy: 250, rx: 20, ry: 20 };
const SQUARE = { kind: 'poly', op: 'hide', pts: [[250, 210], [290, 210], [290, 250], [250, 250]] };
const BOX = (shapes) => ({
  id: 'b', lineN: null, text: 'HELLO THERE', x: 100, y: 200, w: 240, h: 90,
  style: normalizeStyle({ ...defaultStyle(), size: 30 }),
  mask: { on: true, shapes },
});
const typeset = typesetEnabled();
let restoreCanvas;
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
  setTypesetEnabled(true);
  clearLayoutMemo();
  initHistory();
});
afterAll(() => {
  restoreCanvas();
  setTypesetEnabled(typeset);
  clearLayoutMemo();
});
afterEach(() => {
  cleanup();
  clearDrawTool();
  app.selectedId = null;
  setZoom(1);
  loadProjectPages([]);
  resetHistory();
});

async function mount(kind, shapes = []) {
  loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: [BOX(shapes)] }]);
  const pg = page();
  const view = render(TextBox, { box: pg.boxes[0], pageFrameEl: document.createElement('div'), pg });
  selectBox('b');
  await tick();
  setDrawTool('mask', kind);
  await tick();
  return { b: pg.boxes[0], capture: () => view.container.querySelector('.mask-gizmo .capture'), q: (s) => view.container.querySelector(s) };
}
const ev = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
async function drag(target, from, to) {
  target.dispatchEvent(ev('pointerdown', ...from));
  document.dispatchEvent(ev('pointermove', ...to));
  await tick();
  document.dispatchEvent(ev('pointerup', ...to));
  await tick();
}
const key = (k) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e;
};

describe('the draw tool on a masked box', () => {
  it('Rectangle draws a four-point polygon, one undo step', async () => {
    const { b, capture } = await mount('rect');
    await drag(capture(), [110, 210], [190, 260]);
    expect(b.mask.shapes).toEqual([{ kind: 'poly', op: 'hide', pts: [[110, 210], [190, 210], [190, 260], [110, 260]] }]);
    undo();
    await tick();
    expect(page().boxes[0].mask.shapes).toEqual([]);
  });

  it('a Rectangle with no size is a slip and adds nothing', async () => {
    const { b, capture } = await mount('rect');
    await drag(capture(), [110, 210], [110.5, 260]);
    expect(b.mask.shapes).toEqual([]);
  });

  it('Move drags the shape under the pointer alone, one undo step', async () => {
    const { b, capture } = await mount('move', [ELLIPSE, SQUARE]);
    await drag(capture(), [150, 250], [180, 260]);
    expect(b.mask.shapes[0]).toEqual({ ...ELLIPSE, cx: 180, cy: 260 });
    expect(b.mask.shapes[1]).toEqual(SQUARE);
    undo();
    await tick();
    expect(page().boxes[0].mask.shapes).toEqual([ELLIPSE, SQUARE]);
  });

  it('Move on empty space drags every shape', async () => {
    const { b, capture } = await mount('move', [ELLIPSE, SQUARE]);
    await drag(capture(), [320, 280], [330, 285]);
    expect(b.mask.shapes[0]).toEqual({ ...ELLIPSE, cx: 160, cy: 255 });
    expect(b.mask.shapes[1].pts[0]).toEqual([260, 215]);
  });

  it('Delete removes the picked shape and not the box', async () => {
    const { b, capture } = await mount('move', [ELLIPSE, SQUARE]);
    await drag(capture(), [270, 230], [270, 230]);
    expect(b.mask.shapes).toHaveLength(2);
    expect(key('Delete').defaultPrevented).toBe(true);
    await tick();
    expect(page().boxes).toHaveLength(1);
    expect(b.mask.shapes).toEqual([ELLIPSE]);
    undo();
    await tick();
    expect(page().boxes[0].mask.shapes).toEqual([ELLIPSE, SQUARE]);
  });

  it('a pick made before an undo is dropped, so Delete cannot take another shape', async () => {
    const { b, capture, q } = await mount('move', [ELLIPSE, SQUARE]);
    // A third shape, then it (index 2) picked; undo takes it away, and
    // index 2 now names nothing (or, after more edits, another shape).
    setDrawTool('mask', 'rect');
    await tick();
    await drag(capture(), [290, 260], [310, 280]);
    expect(b.mask.shapes).toHaveLength(3);
    setDrawTool('mask', 'move');
    await tick();
    await drag(capture(), [300, 270], [300, 270]);
    expect(q('.mask-gizmo .picked')).not.toBeNull();
    undo();
    await tick();
    expect(page().boxes[0].mask.shapes).toEqual([ELLIPSE, SQUARE]);
    expect(q('.mask-gizmo .picked')).toBeNull();
    // Nothing picked: the key is not the tool's.
    expect(key('Delete').defaultPrevented).toBe(false);
    expect(page().boxes[0].mask.shapes).toEqual([ELLIPSE, SQUARE]);
  });

  it('a picked shape that was just moved can still be deleted', async () => {
    const { b, capture } = await mount('move', [ELLIPSE, SQUARE]);
    await drag(capture(), [270, 230], [280, 240]);
    expect(b.mask.shapes[1].pts[0]).toEqual([260, 220]);
    expect(key('Delete').defaultPrevented).toBe(true);
    await tick();
    expect(b.mask.shapes).toEqual([ELLIPSE]);
  });

  it('Escape in an open popover is the popover\'s, and the tool stays armed', async () => {
    await mount('ellipse');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    try {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      let reached = false;
      dialog.addEventListener('keydown', () => (reached = true));
      dialog.dispatchEvent(e);
      expect(reached).toBe(true);
      expect(drawTool.target).toBe('mask');
    } finally {
      dialog.remove();
    }
  });

  it('Brush shows a ring of the brush size under the pointer', async () => {
    const { capture, q } = await mount('brush');
    capture().dispatchEvent(ev('pointermove', 150, 250));
    await tick();
    const ring = q('.liq-ring');
    expect(ring).not.toBeNull();
    expect(ring.getAttribute('style')).toContain('width: 20px');
  });

  it('Escape puts the tool down and keeps the box selected', async () => {
    await mount('ellipse');
    expect(drawTool.target).toBe('mask');
    expect(key('Escape').defaultPrevented).toBe(true);
    await tick();
    expect(drawTool.target).toBe(null);
    expect(app.selectedId).toBe('b');
  });

  it('the tool goes when the box is no longer selected', async () => {
    const { q } = await mount('brush');
    expect(q('.mask-gizmo .capture')).not.toBeNull();
    app.selectedId = null;
    await tick();
    expect(drawTool.target).toBe(null);
    expect(drawTool.kind).toBe(null);
  });
});

describe('the draw tool on a faded box', () => {
  async function mountFade(kind, shapes = []) {
    const { mask: _m, ...box } = BOX([]);
    loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: [{ ...box, fade: { on: true, shapes } }] }]);
    const pg = page();
    const view = render(TextBox, { box: pg.boxes[0], pageFrameEl: document.createElement('div'), pg });
    selectBox('b');
    await tick();
    setDrawTool('fade', kind);
    await tick();
    return { b: pg.boxes[0], capture: () => view.container.querySelector('.mask-gizmo .capture'), q: (s) => view.container.querySelector(s) };
  }

  it('Rectangle adds a shape with the panel\'s strength and soft edge, one undo step, and no mask', async () => {
    drawSettings.fade.strength = 70;
    drawSettings.fade.soft = 25;
    const { b, capture, q } = await mountFade('rect');
    expect(q('.draw-page.fade')).not.toBeNull();
    await drag(capture(), [110, 210], [190, 260]);
    expect(b.fade.shapes).toEqual([{ kind: 'poly', strength: 70, soft: 25, pts: [[110, 210], [190, 210], [190, 260], [110, 260]] }]);
    expect(b.mask ?? null).toBe(null);
    undo();
    await tick();
    expect(page().boxes[0].fade.shapes).toEqual([]);
  });

  it('Move drags a fade shape and Delete removes it', async () => {
    const shape = { kind: 'ellipse', strength: 50, soft: 0, cx: 150, cy: 250, rx: 20, ry: 20 };
    const { b, capture } = await mountFade('move', [shape]);
    await drag(capture(), [150, 250], [170, 255]);
    expect(b.fade.shapes).toEqual([{ ...shape, cx: 170, cy: 255 }]);
    expect(key('Delete').defaultPrevented).toBe(true);
    await tick();
    expect(b.fade.shapes).toEqual([]);
  });

  it('Brush draws at the fade\'s own brush size', async () => {
    drawSettings.fade.size = 33;
    const { b, capture, q } = await mountFade('brush');
    capture().dispatchEvent(ev('pointermove', 150, 250));
    await tick();
    expect(q('.liq-ring').getAttribute('style')).toContain('width: 33px');
    await drag(capture(), [150, 250], [180, 260]);
    expect(b.fade.shapes[0]).toMatchObject({ kind: 'stroke', size: 33 });
  });
});

// The paint's marks are drawn on the same page layer and stored in the box's
// own frame: from the box's corner, unmirrored, so they move with it.
describe('the draw tool painting over the letters', () => {
  async function mountPaint(kind, marks = [], style = {}) {
    const { mask: _m, ...box } = BOX([]);
    box.style = normalizeStyle({ ...box.style, ...style, paint: { on: true, marks } });
    loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: [box] }]);
    const pg = page();
    const view = render(TextBox, { box: pg.boxes[0], pageFrameEl: document.createElement('div'), pg });
    selectBox('b');
    await tick();
    setDrawTool('paint', kind);
    await tick();
    return { b: pg.boxes[0], capture: () => view.container.querySelector('.mask-gizmo .capture'), q: (s) => view.container.querySelector(s) };
  }

  it('Rectangle adds a mark in the box\'s frame with the panel\'s colour, opacity and soft edge, as one style step', async () => {
    Object.assign(drawSettings.paint, { color: '#00aa44', opacity: 60, soft: 10 });
    const { b, capture, q } = await mountPaint('rect');
    expect(q('.draw-page.paint')).not.toBeNull();
    await drag(capture(), [110, 210], [190, 260]);
    expect(b.style.paint.marks).toEqual([{ kind: 'poly', color: '#00aa44', opacity: 60, soft: 10, pts: [[10, 10], [90, 10], [90, 60], [10, 60]] }]);
    expect(b.mask ?? null).toBe(null);
    undo();
    await tick();
    expect(page().boxes[0].style.paint.marks).toEqual([]);
  });

  it('a mirrored box stores the mark mirrored, so it lands under the pointer once flipped', async () => {
    const { b, capture } = await mountPaint('rect', [], { flipH: true });
    await drag(capture(), [110, 210], [190, 260]);
    // The box is 240 wide: page x 110 is 10 in from its left edge, which the
    // mirror puts 10 in from its right.
    expect(b.style.paint.marks[0].pts).toEqual([[230, 10], [150, 10], [150, 60], [230, 60]]);
  });

  it('the Eraser draws a brush mark that takes paint away', async () => {
    drawSettings.paint.size = 18;
    const { b, capture } = await mountPaint('erase');
    await drag(capture(), [150, 250], [180, 260]);
    expect(b.style.paint.marks[0]).toMatchObject({ kind: 'stroke', size: 18, erase: true, pts: [[50, 50], [80, 60]] });
  });

  it('Move carries a mark and Delete removes it, each as a style step', async () => {
    const mark = { kind: 'ellipse', color: '#ff0000', opacity: 100, soft: 0, cx: 50, cy: 50, rx: 20, ry: 20 };
    const { b, capture } = await mountPaint('move', [mark]);
    await drag(capture(), [150, 250], [170, 255]);
    expect(b.style.paint.marks).toEqual([{ ...mark, cx: 70, cy: 55 }]);
    expect(key('Delete').defaultPrevented).toBe(true);
    await tick();
    expect(b.style.paint.marks).toEqual([]);
    undo();
    await tick();
    expect(page().boxes[0].style.paint.marks).toEqual([{ ...mark, cx: 70, cy: 55 }]);
  });
});

// Moves with box (fix round 1): the shapes are stored in the box's own
// frame, box-local from its corner at (100, 200).
describe('the draw tool on a mask that moves with its box', () => {
  async function mountFollow(kind, shapes) {
    const r = await mount(kind, shapes);
    r.b.mask = { ...r.b.mask, follow: true };
    await tick();
    return r;
  }
  const LOCAL = { kind: 'ellipse', op: 'hide', cx: 50, cy: 50, rx: 20, ry: 20 };

  it('a new shape is stored box-local, and the others are left as stored', async () => {
    const { b, capture } = await mountFollow('rect', [LOCAL]);
    await drag(capture(), [110, 210], [190, 260]);
    expect(b.mask.shapes[0]).toEqual(LOCAL);
    expect(b.mask.shapes[1]).toEqual({ kind: 'poly', op: 'hide', pts: [[10, 10], [90, 10], [90, 60], [10, 60]] });
  });

  it('Move picks a shape where it is shown on the page, and stores where it went box-local', async () => {
    const { b, capture } = await mountFollow('move', [LOCAL]);
    // Shown at page (150, 250).
    await drag(capture(), [150, 250], [170, 255]);
    expect(b.mask.shapes[0]).toEqual({ ...LOCAL, cx: 70, cy: 55 });
  });
});
