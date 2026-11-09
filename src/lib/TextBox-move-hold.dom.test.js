import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// A box whose picture depends on where it stands on the page - a pattern whose
// tiles start at the page's corner, a gradient laid over the page with Align
// with Layer off - is NOT repainted on every move of a pointer drag: the
// picture the press found is held (`placeHeld`) and the box is painted once
// where it lands. A move from anywhere else (`moveBoxTo` from a tool) still
// repaints as it goes. The paint is the real one on the lane's stand-in
// canvas, wrapped so a case can count it (as in TextBox-align.dom.test.js).
vi.mock('./editor/box-picture.js', async (original) => {
  const mod = await original();
  return { ...mod, paintBoxPicture: vi.fn(mod.paintBoxPicture) };
});

import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, selectBox, setZoom, moveBoxTo, moveGeom } from './store.svelte.js';
import { engineSwitch } from './engine-switch.svelte.js';
import { paintBoxPicture } from './editor/box-picture.js';
import { _setDisplayScale } from './editor/display-scale.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeGradientOverlay, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

const PAGE = { w: 1600, h: 2300 };
const STYLES = {
  plain: {},
  pageTone: { pattern: { ...defaultStyle().pattern, on: true, kind: 'dots', anchor: 'page' } },
  alignOff: { gradientOverlays: [normalizeGradientOverlay({ gradient: { style: 'linear', angle: 0, align: false } })] },
};
const box = (kind, over = {}) => ({
  id: kind, lineN: null, text: 'WAIT', x: 100, y: 200, w: 240, h: 90,
  style: normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30, ...STYLES[kind], ...over }),
});

class FakeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const typeset = typesetEnabled();
let restoreCanvas;
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
  setTypesetEnabled(true);
  clearLayoutMemo();
});
afterAll(() => {
  restoreCanvas();
  setTypesetEnabled(typeset);
  clearLayoutMemo();
});
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.stubGlobal('ResizeObserver', FakeObserver);
  engineSwitch.painting = true;
  _setDisplayScale(1);
  paintBoxPicture.mockClear();
});
afterEach(() => {
  cleanup();
  engineSwitch.painting = false;
  app.selectedId = null;
  setZoom(1);
  loadProjectPages([]);
  vi.unstubAllGlobals();
});

async function mounted(b) {
  loadProjectPages([{ id: 1, ...PAGE, lines: [], boxes: [b] }]);
  setZoom(1);
  const pg = page();
  const view = render(TextBox, { box: pg.boxes[0], pageFrameEl: document.createElement('div'), pg });
  await tick();
  const root = view.container.querySelector('.tbox');
  return { view, root, box: pg.boxes[0], pg, paints: () => paintBoxPicture.mock.calls.length };
}
// As the existing gesture tests dispatch them: MouseEvents, so `pointerId`
// is undefined on the press and on every move alike.
const ev = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });

// Press on the box and select it, settled, before counting.
async function grab(m, x = 150, y = 250) {
  m.root.dispatchEvent(ev('pointerdown', x, y));
  await tick();
  return m.paints();
}
async function dragMoves(m, from, steps) {
  for (const [i, [x, y]] of steps.entries()) {
    document.dispatchEvent(ev('pointermove', x, y));
    await tick();
    expect(m.paints(), `move ${i + 1}`).toBe(from);
  }
}
const STEPS = [[170, 260], [200, 280], [240, 310]];

describe('a pointer drag of a box whose picture follows its place on the page', () => {
  for (const kind of ['pageTone', 'alignOff']) {
    it(`${kind}: not repainted while the pointer moves it, and repainted once where it lands`, async () => {
      const m = await mounted(box(kind));
      expect(m.paints()).toBeGreaterThan(0);
      const before = await grab(m);
      await dragMoves(m, before, STEPS);
      // It did follow the pointer.
      expect([m.box.x, m.box.y]).toEqual([100 + 90, 200 + 60]);
      document.dispatchEvent(ev('pointerup', 240, 310));
      await tick();
      expect(m.paints()).toBe(before + 1);
      // Painted at the new place: the box the paint was handed stands there.
      const painted = paintBoxPicture.mock.calls.at(-1)[1];
      expect([painted.x, painted.y]).toEqual([190, 260]);
      // And nothing more after it settles.
      await tick();
      expect(m.paints()).toBe(before + 1);
    });

    it(`${kind}: moved without the pointer (moveBoxTo), repainted on each move`, async () => {
      const m = await mounted(box(kind));
      let before = m.paints();
      for (const [x, y] of [[300, 400], [320, 410], [333.3, 77.7]]) {
        moveBoxTo(m.box, x, y, m.pg, moveGeom(m.box));
        await tick();
        expect(m.paints()).toBe(before + 1);
        before = m.paints();
      }
    });

    it(`${kind}: the window losing the focus ends the drag, releases the picture once, and later moves do nothing`, async () => {
      const m = await mounted(box(kind));
      const before = await grab(m);
      await dragMoves(m, before, STEPS.slice(0, 2));
      expect([m.box.x, m.box.y]).toEqual([150, 230]);
      window.dispatchEvent(new Event('blur'));
      await tick();
      expect(m.paints()).toBe(before + 1);
      // The pointer comes back over the page: the box stays where it was let go.
      document.dispatchEvent(ev('pointermove', 400, 500));
      await tick();
      expect([m.box.x, m.box.y]).toEqual([150, 230]);
      expect(m.paints()).toBe(before + 1);
      // And a late pointerup is nobody's.
      document.dispatchEvent(ev('pointerup', 400, 500));
      await tick();
      expect(m.paints()).toBe(before + 1);
    });
  }
});

describe('a pointer drag of a plain box', () => {
  // As "a move does not" in TextBox-engine-picture.dom.test.js, through the pointer.
  it('repaints nothing, during the drag or when it is let go', async () => {
    const m = await mounted(box('plain'));
    expect(m.paints()).toBeGreaterThan(0);
    const before = await grab(m);
    await dragMoves(m, before, STEPS);
    expect([m.box.x, m.box.y]).toEqual([190, 260]);
    document.dispatchEvent(ev('pointerup', 240, 310));
    await tick();
    expect(m.paints()).toBe(before);
  });
});

describe('a rotation-handle drag of a box with Align with Layer off', () => {
  // Turned already, so the turn's oversample does not change with it (the
  // first degree of a turn from upright repaints to make the picture finer).
  // The centre is (220, 245) on a page frame at the origin.
  it('is not repainted per move, and is repainted once when the handle is let go', async () => {
    const m = await mounted(box('alignOff', { rotation: 7 }));
    selectBox(m.box.id);
    await tick();
    const handle = m.root.querySelector('.handle.rot');
    expect(handle).toBeTruthy();
    handle.dispatchEvent(ev('pointerdown', 220, 100));
    await tick();
    const before = m.paints();
    const turns = [];
    for (const [x, y] of [[400, 300], [300, 400], [100, 400]]) {
      document.dispatchEvent(ev('pointermove', x, y));
      await tick();
      turns.push(m.box.style.rotation);
      expect(m.paints(), `turn to ${m.box.style.rotation}`).toBe(before);
    }
    // Off the right angles, where the oversample would change and repaint.
    expect(turns).toEqual([107, 153, -142]);
    document.dispatchEvent(ev('pointerup', 100, 400));
    await tick();
    expect(m.paints()).toBe(before + 1);
  });
});
