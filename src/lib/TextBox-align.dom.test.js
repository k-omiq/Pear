import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The editor's wiring for a gradient with Align with Layer off: the box's
// picture is painted over its page (`gradientSheet`, handed to
// `paintBoxPicture` and to the warp drag's `pictureTexture`), and the
// picture's key holds the box's place on the page (`pageGradientKey`), so a
// move or a turn repaints it while a box with Align on is not repainted by
// either. The paints are the real ones on the lane's stand-in canvas,
// wrapped so a case can read what they were handed (as in
// TextBox-engine-picture.dom.test.js).
vi.mock('./editor/box-picture.js', async (original) => {
  const mod = await original();
  return { ...mod, paintBoxPicture: vi.fn(mod.paintBoxPicture), pictureTexture: vi.fn(mod.pictureTexture) };
});

import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, selectBox, setZoom, moveBoxTo, moveGeom } from './store.svelte.js';
import { engineSwitch } from './engine-switch.svelte.js';
import { paintBoxPicture, pictureTexture } from './editor/box-picture.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { _setDisplayScale } from './editor/display-scale.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeGradientOverlay, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

const PAGE = { w: 1600, h: 2300 };
const ramp = (align) => normalizeGradientOverlay({ gradient: { style: 'linear', angle: 0, ...(align ? null : { align: false }) } });
const box = (id, align, over = {}) => ({ id, lineN: null, text: 'WAIT', x: 100, y: 200, w: 240, h: 90, style: normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30, gradientOverlays: [ramp(align)], ...over }) });

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
  pictureTexture.mockClear();
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
  return { view, box: pg.boxes[0], pg, paints: () => paintBoxPicture.mock.calls.length, sheet: () => paintBoxPicture.mock.calls.at(-1)?.[9] };
}

describe('a box whose gradient has Align with Layer off, in the editor', () => {
  it('is painted over its page, and a move or a turn repaints it', async () => {
    const m = await mounted(box('off', false));
    expect(m.paints()).toBeGreaterThan(0);
    expect(m.sheet()).toEqual(PAGE);
    let before = m.paints();
    moveBoxTo(m.box, 333.3, 77.7, m.pg, moveGeom(m.box));
    await tick();
    expect(m.paints()).toBe(before + 1);
    before = m.paints();
    m.box.style.rotation = 20;
    await tick();
    expect(m.paints()).toBe(before + 1);
    before = m.paints();
    m.box.style.flipH = true;
    await tick();
    expect(m.paints()).toBe(before + 1);
  });

  it('with Align on, is handed no page, and a move does not repaint it', async () => {
    const m = await mounted(box('on', true));
    expect(m.paints()).toBeGreaterThan(0);
    expect(m.sheet()).toBeNull();
    const before = m.paints();
    moveBoxTo(m.box, 333.3, 77.7, m.pg, moveGeom(m.box));
    await tick();
    expect(m.paints()).toBe(before);
  });

  it('hands the page to the warp drag\'s texture too', async () => {
    const m = await mounted(box('warped', false, { warp: { on: true, cols: 1, rows: 1, pts: [[0, 0], [250, 12], [-6, 96], [240, 90]] } }));
    selectBox(m.box.id);
    setInspectorTab('effects');
    setEffectsSubTab('transform');
    await tick();
    const handle = m.view.container.querySelector('.warp-gizmo .wh');
    expect(handle).toBeTruthy();
    await fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100, clientY: 200 });
    expect(pictureTexture).toHaveBeenCalled();
    expect(pictureTexture.mock.calls.at(-1)[8]).toEqual(PAGE);
    await fireEvent.pointerUp(window, { pointerId: 1 });
  });
});
