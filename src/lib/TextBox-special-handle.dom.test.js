import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, selectBox, setZoom } from './store.svelte.js';
import { initHistory, resetHistory, undo } from './editor/history.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { inspectorTab, effectsSubTab } from './inspector-tabs.svelte.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

// ===========================================================================
// The special effects' on-page handles (fix round 1, 2026-11-11): a point
// for Crack, Lightning and Splash while Effects ▸ Special is open; a drag
// writes x and y (the lightning's arm, its angle), one undo step.
// ===========================================================================

const BOX = (special, over = {}) => ({
  id: 'b', lineN: null, text: 'KABOOM', x: 100, y: 200, w: 200, h: 100,
  style: normalizeStyle({ ...defaultStyle(), size: 30, special, ...over }),
});
const typeset = typesetEnabled();
let restoreCanvas;
const tabs = { tab: inspectorTab.id, sub: effectsSubTab.id };
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
  app.selectedId = null;
  setZoom(1);
  loadProjectPages([]);
  resetHistory();
  inspectorTab.id = tabs.tab;
  effectsSubTab.id = tabs.sub;
});

async function mount(special, sub = 'special', over = {}) {
  inspectorTab.id = 'effects';
  effectsSubTab.id = sub;
  loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: [BOX(special, over)] }]);
  const pg = page();
  const b = pg.boxes[0];
  // The page frame at the window's corner: a client point is a page point.
  const frame = document.createElement('div');
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1600, bottom: 2300, width: 1600, height: 2300, x: 0, y: 0 });
  const view = render(TextBox, { box: b, pageFrameEl: frame, pg });
  selectBox('b');
  await tick();
  return { b, q: (s) => view.container.querySelector(s), qa: (s) => view.container.querySelectorAll(s) };
}
const ev = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
async function drag(el, x, y) {
  el.dispatchEvent(ev('pointerdown', 0, 0));
  document.dispatchEvent(ev('pointermove', x, y));
  await tick();
  document.dispatchEvent(ev('pointerup', x, y));
  await tick();
}

describe('the special handles', () => {
  it('show a point for each effect that has one and is on, only on the Special sub-tab', async () => {
    const { qa } = await mount({ crack: { on: true }, lightning: { on: true }, splash: { on: true }, scratches: { on: true } });
    expect([...qa('.special-gizmo .hit.point')].map((e) => e.dataset.kind)).toEqual(['crack', 'lightning', 'splash']);
    expect(qa('.special-gizmo .hit.arm')).toHaveLength(1);
    cleanup();
    const off = await mount({ crack: { on: true } }, 'stroke');
    expect(off.q('.special-gizmo')).toBeNull();
    cleanup();
    const none = await mount({ scratches: { on: true } });
    expect(none.q('.special-gizmo')).toBeNull();
  });

  it('a splash drag sets where it lands, pulls the spread in, and is one undo step', async () => {
    const { b, q } = await mount({ splash: { on: true } });
    // Page (150, 225) is box-local (50, 25): a quarter across, a quarter down.
    await drag(q('.special-gizmo .hit.point'), 150, 225);
    expect(b.style.special.splash).toMatchObject({ x: 25, y: 25, spread: 50 });
    undo();
    await tick();
    expect(page().boxes[0].style.special.splash).toMatchObject({ x: 50, y: 50, spread: 100 });
  });

  it('a lightning drag aims it from the point, and its arm sets the direction', async () => {
    const { b, q } = await mount({ lightning: { on: true } });
    await drag(q('.special-gizmo .hit.point'), 120, 250);
    expect(b.style.special.lightning).toMatchObject({ aim: 'point', x: 10, y: 50 });
    // Straight up from the start: 90, as the dial reads it.
    await drag(q('.special-gizmo .hit.arm'), 120, 150);
    expect(b.style.special.lightning.angle).toBe(90);
  });

  it('a crack drag moves the focus within the letters', async () => {
    const { b, q } = await mount({ crack: { on: true } });
    await drag(q('.special-gizmo .hit.point'), 100, 200);
    expect(b.style.special.crack.x).toBe(0);
    expect(b.style.special.crack.y).toBe(0);
    expect(b.style.special.crack.spread).toBe(50);
  });

  // The lightning starts on the left edge by default, on the W resize
  // handle: two controls in one place would be a coin toss over which one a
  // press gets, so the resize handles stand down while a point shows.
  it('stand the resize handles down while a point shows', async () => {
    const on = await mount({ lightning: { on: true } });
    expect(on.q('.special-gizmo .hit.point')).not.toBeNull();
    expect(on.q('.handle.w')).toBeNull();
    expect(on.q('.handle.e')).toBeNull();
    cleanup();
    const other = await mount({ lightning: { on: true } }, 'stroke');
    expect(other.q('.special-gizmo')).toBeNull();
    expect(other.q('.handle.w')).not.toBeNull();
    cleanup();
    // Scratches has no point: the box keeps its handles.
    const none = await mount({ scratches: { on: true } });
    expect(none.q('.handle.w')).not.toBeNull();
  });

  // The engine lays the effects before the warp mesh and bends them with the
  // letters, so a point shows where the mesh carries it, and a drag is taken
  // back through the mesh. A shear: the top edge 40 px right, the bottom
  // where it was, so a point h px down moves 40 * (1 - h / 100) right.
  const SHEAR = { warp: { on: true, cols: 1, rows: 1, pts: [[40, 0], [240, 0], [0, 100], [200, 100]] } };
  it('show a point where the warp carries it, and a drag lands under the pointer', async () => {
    const { b, q } = await mount({ splash: { on: true } }, 'special', SHEAR);
    const pt = q('.special-gizmo .hit.point');
    // The middle (100, 50) is carried 20 px right.
    expect(Number(pt.getAttribute('cx'))).toBeCloseTo(120, 6);
    expect(Number(pt.getAttribute('cy'))).toBeCloseTo(50, 6);
    // Box-local (50, 25) shows at (80, 25): page (180, 225).
    await drag(pt, 180, 225);
    expect(b.style.special.splash.x).toBeCloseTo(25, 6);
    expect(b.style.special.splash.y).toBeCloseTo(25, 6);
    await tick();
    expect(Number(q('.special-gizmo .hit.point').getAttribute('cx'))).toBeCloseTo(80, 6);
  });

  it('carry the lightning arm through the warp too', async () => {
    const { b, q } = await mount({ lightning: { on: true, aim: 'point', x: 50, y: 50, angle: 0 } }, 'special', SHEAR);
    // Its start (100, 50) shows at (120, 50); its arm end, 36 px right of
    // the start before the mesh, at (156, 50).
    expect(Number(q('.special-gizmo .hit.point').getAttribute('cx'))).toBeCloseTo(120, 6);
    expect(Number(q('.special-gizmo .hit.arm').getAttribute('cx'))).toBeCloseTo(156, 6);
    // A drag to the shown point straight up from the start (box-local
    // (100, 0) before the mesh, (140, 0) after) aims the bolts up: 90.
    await drag(q('.special-gizmo .hit.arm'), 240, 200);
    expect(b.style.special.lightning.angle).toBe(90);
  });
});
