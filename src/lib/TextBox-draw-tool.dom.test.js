import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, selectBox, setZoom } from './store.svelte.js';
import { initHistory, resetHistory, undo } from './editor/history.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { drawTool, setDrawTool, clearDrawTool } from './box-draw-tool.svelte.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

// ===========================================================================
// The shared draw tool on a box, armed for the mask: the new Rectangle and
// Move kinds, Delete on a picked shape, and the tool going away with Escape
// or the selection.
// ===========================================================================
// The page frame is a detached element, so its rect is all zeros: a client
// point is a page point at zoom 1, and the box at (100, 200) puts box-local
// (0, 0) at client (100, 200).

const ELLIPSE = { kind: 'ellipse', cx: 50, cy: 50, rx: 20, ry: 20 };
const SQUARE = { kind: 'poly', pts: [[150, 10], [190, 10], [190, 50], [150, 50]] };
const BOX = (shapes) => ({
  id: 'b', lineN: null, text: 'HELLO THERE', x: 100, y: 200, w: 240, h: 90,
  style: normalizeStyle({ ...defaultStyle(), size: 30, clip: { on: true, mode: 'exclude', brushSize: 20, shapes } }),
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
    expect(b.style.clip.shapes).toEqual([{ kind: 'poly', pts: [[10, 10], [90, 10], [90, 60], [10, 60]] }]);
    undo();
    await tick();
    expect(page().boxes[0].style.clip.shapes).toEqual([]);
  });

  it('a Rectangle with no size is a slip and adds nothing', async () => {
    const { b, capture } = await mount('rect');
    await drag(capture(), [110, 210], [110.5, 260]);
    expect(b.style.clip.shapes).toEqual([]);
  });

  it('Move drags the shape under the pointer alone, one undo step', async () => {
    const { b, capture } = await mount('move', [ELLIPSE, SQUARE]);
    await drag(capture(), [150, 250], [180, 260]);
    expect(b.style.clip.shapes[0]).toEqual({ ...ELLIPSE, cx: 80, cy: 60 });
    expect(b.style.clip.shapes[1]).toEqual(SQUARE);
    undo();
    await tick();
    expect(page().boxes[0].style.clip.shapes).toEqual([ELLIPSE, SQUARE]);
  });

  it('Move on empty space drags every shape', async () => {
    const { b, capture } = await mount('move', [ELLIPSE, SQUARE]);
    await drag(capture(), [320, 280], [330, 285]);
    expect(b.style.clip.shapes[0]).toEqual({ ...ELLIPSE, cx: 60, cy: 55 });
    expect(b.style.clip.shapes[1].pts[0]).toEqual([160, 15]);
  });

  it('Delete removes the picked shape and not the box', async () => {
    const { b, capture } = await mount('move', [ELLIPSE, SQUARE]);
    await drag(capture(), [270, 230], [270, 230]);
    expect(b.style.clip.shapes).toHaveLength(2);
    expect(key('Delete').defaultPrevented).toBe(true);
    await tick();
    expect(page().boxes).toHaveLength(1);
    expect(b.style.clip.shapes).toEqual([ELLIPSE]);
    undo();
    await tick();
    expect(page().boxes[0].style.clip.shapes).toEqual([ELLIPSE, SQUARE]);
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
