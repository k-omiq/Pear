import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, selectBox, setFontSource, setZoom, fitHeld, noteFontsChanged } from './store.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

// ===========================================================================
// A drag of a box's handles, through the component
// ===========================================================================

const BOX = () => ({
  id: 'b', lineN: null, text: 'WAIT FOR ME\nOVER THERE\nBY THE DOOR', x: 100, y: 200, w: 240, h: 300,
  style: normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30 }),
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
  setFontSource(null);
  app.selectedId = null;
  setZoom(1);
  loadProjectPages([]);
  resetHistory();
});

// A handle dragged once, from the box as BOX() places it.
async function dragHandle(sel, dx, dy, mods = {}) {
  loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: [BOX()] }]);
  const pg = page();
  const b = pg.boxes[0];
  const view = render(TextBox, { box: b, pageFrameEl: document.createElement('div'), pg });
  selectBox('b');
  await tick();
  const ev = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...mods });
  view.container.querySelector(sel).dispatchEvent(ev('pointerdown', 500, 500));
  document.dispatchEvent(ev('pointermove', 500 + dx, 500 + dy));
  await tick();
  document.dispatchEvent(ev('pointerup', 500 + dx, 500 + dy));
  await tick();
  return b;
}

// The box has no height handle: the bottom edge scales the box and the
// type together, and a corner adds its sideways travel to the width.
describe('the handles', () => {
  it('there is no top edge, and the bottom edge is the size handle', async () => {
    loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: [BOX()] }]);
    const pg = page();
    const view = render(TextBox, { box: pg.boxes[0], pageFrameEl: document.createElement('div'), pg });
    selectBox('b');
    await tick();
    expect(view.container.querySelector('.handle.n')).toBeNull();
    expect(view.container.querySelector('.handle.side.size.s')).not.toBeNull();
  });
  it('the bottom edge dragged far up stops at the smallest size, about the top', async () => {
    setFontSource({ ready: () => true });
    const b = await dragHandle('.handle.side.s', 0, -1000);
    expect(b.style.size).toBe(6);
    expect(b.y).toBe(200);
    expect(b.style.autoHeight).toBe(true);
  });
  it('a corner moved sideways too sets the width past the scaled one, and the text breaks again in it', async () => {
    setFontSource({ ready: () => true });
    const b = await dragHandle('.handle.corner.se', 48, 60);
    expect(b.style.size).toBe(36);
    expect(b.w).toBe(336);
    expect(b.x).toBe(100);
    expect(b.style.autoHeight).toBe(true);
  });
});

describe('a corner, with the box\'s face still arriving', () => {
  for (const dir of ['se', 'sw', 'ne', 'nw']) {
    it(`the ${dir} corner: no fit is held, and the box is where the drag left it when the face lands`, async () => {
      let arrived = false;
      setFontSource({ ready: () => arrived });
      const b = await dragHandle(`.handle.corner.${dir}`, 0, dir.includes('s') ? 60 : -60);
      expect(b.w).toBe(288);
      expect(b.h).toBe(360);
      expect(b.style.size).toBe(36);
      expect(b.style.autoHeight).toBe(true);
      expect(fitHeld(b)).toBe(false);
      const left = { x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size };
      arrived = true;
      noteFontsChanged();
      await tick();
      expect({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size }).toEqual(left);
    });
  }
  it('Cmd changes nothing: a corner scales by one factor either way', async () => {
    const b = await dragHandle('.handle.corner.se', 0, 60, { metaKey: true });
    expect(b.h).toBe(360);
    expect(b.style.size).toBe(36);
    expect(b.style.autoHeight).toBe(true);
  });
  it('a side never changes the size, Cmd or not', async () => {
    const b = await dragHandle('.handle.side.e', 40, 0, { metaKey: true });
    expect(b.w).toBe(280);
    expect(b.style.size).toBe(30);
  });
  it('the bottom edge is the corner\'s up and down: the same scale, no fit held', async () => {
    setFontSource({ ready: () => false });
    const b = await dragHandle('.handle.side.s', 0, 60);
    expect(b.w).toBe(288);
    expect(b.h).toBe(360);
    expect(b.style.size).toBe(36);
    expect(b.style.autoHeight).toBe(true);
    expect(fitHeld(b)).toBe(false);
  });
});
