import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, selectBox, setZoom } from './store.svelte.js';
import { initHistory, resetHistory, undo } from './editor/history.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle, defaultPathPts } from './data.js';
import { inspectorTab, effectsSubTab } from './inspector-tabs.svelte.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

// ===========================================================================
// The curve path's on-box editor: its own mode, wide hit shapes, a press on
// the line adds a point, double-click flips smooth/corner.
// ===========================================================================

const BOX = () => ({
  id: 'b', lineN: null, text: 'WAVY WAVY WAVY', x: 100, y: 200, w: 240, h: 300,
  style: normalizeStyle({ ...defaultStyle(), size: 30, path: { on: true, pts: defaultPathPts(240, 300) } }),
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

async function mount(sub = 'warp') {
  inspectorTab.id = 'effects';
  effectsSubTab.id = sub;
  loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: [BOX()] }]);
  const pg = page();
  const b = pg.boxes[0];
  const view = render(TextBox, { box: b, pageFrameEl: document.createElement('div'), pg });
  selectBox('b');
  await tick();
  return { b, q: (s) => view.container.querySelector(s), qa: (s) => view.container.querySelectorAll(s) };
}
const ev = (type, x, y, mods = {}) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...mods });

describe('the curve path editor', () => {
  it('owns the box on the Warp sub-tab: the resize handles stand down, the path ends are free', async () => {
    const { q, qa } = await mount('warp');
    expect(q('.handle')).toBeNull();
    expect(qa('.path-gizmo .hit.anchor')).toHaveLength(3);
  });

  it('is off on any other sub-tab, and the box keeps its handles there', async () => {
    const { q } = await mount('stroke');
    expect(q('.path-gizmo')).toBeNull();
    expect(q('.handle')).not.toBeNull();
  });

  it('drags an end anchor, and its smooth neighbour re-fits', async () => {
    const { b, qa } = await mount();
    const before = b.style.path.pts[1].ix;
    qa('.path-gizmo .hit.anchor')[2].dispatchEvent(ev('pointerdown', 500, 500));
    document.dispatchEvent(ev('pointermove', 500, 400));
    await tick();
    document.dispatchEvent(ev('pointerup', 500, 400));
    await tick();
    expect(b.style.path.pts[2].y).toBe(50);
    expect(b.style.path.pts[1].ix).not.toBe(before);
  });

  it('a press on the line adds a point there and drags it out, in one undo step', async () => {
    const { b, q } = await mount();
    // Box-local (60, 150): a quarter of the way along the middle line.
    q('.path-gizmo .phit').dispatchEvent(ev('pointerdown', 160, 350));
    document.dispatchEvent(ev('pointermove', 160, 300));
    await tick();
    document.dispatchEvent(ev('pointerup', 160, 300));
    await tick();
    const pts = b.style.path.pts;
    expect(pts).toHaveLength(4);
    expect(pts[1].x).toBeCloseTo(60, 0);
    expect(pts[1].y).toBeCloseTo(100, 0);
    expect(pts[1].auto).toBe(true);
    undo();
    await tick();
    expect(page().boxes[0].style.path.pts).toHaveLength(3);
  });

  it('double-click makes a point a sharp corner, Alt-click removes it', async () => {
    const { b, qa } = await mount();
    qa('.path-gizmo .hit.anchor')[1].dispatchEvent(ev('dblclick', 0, 0));
    await tick();
    expect(b.style.path.pts[1].auto).toBeUndefined();
    expect(qa('.path-gizmo rect.pa')).toHaveLength(1);
    qa('.path-gizmo .hit.anchor')[1].dispatchEvent(ev('pointerdown', 0, 0, { altKey: true }));
    await tick();
    expect(b.style.path.pts).toHaveLength(2);
  });
});
