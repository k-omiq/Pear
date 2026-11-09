import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The full paint of a box at rest goes to the paint worker
// (`requestBoxPicture`), and its result comes back later. It is shown only if
// it is still the picture the box wants; one asked for while another is on
// its way waits, and only the newest is painted. The worker is a stand-in
// here that answers when the case says so.
const requests = [];
vi.mock('./editor/box-picture.js', async (original) => {
  const mod = await original();
  return {
    ...mod,
    paintBoxPicture: vi.fn(mod.paintBoxPicture),
    requestBoxPicture: vi.fn((box) => {
      let answer;
      const promise = new Promise((resolve) => (answer = resolve));
      const req = {
        color: box.style.color,
        promise,
        prepMs: 0,
        answer: (res = { raster: null, ms: 1 }) => answer(res),
        apply: vi.fn(() => ({ ox: 0, oy: 0, cw: 10, ch: 10, ss: 1 })),
        cancel: vi.fn(),
      };
      requests.push(req);
      return req;
    }),
  };
});

import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, setZoom } from './store.svelte.js';
import { engineSwitch } from './engine-switch.svelte.js';
import { paintBoxPicture } from './editor/box-picture.js';
import { _setDisplayScale } from './editor/display-scale.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

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
  requests.length = 0;
});
afterEach(() => {
  cleanup();
  engineSwitch.painting = false;
  app.selectedId = null;
  setZoom(1);
  loadProjectPages([]);
  vi.unstubAllGlobals();
});

async function mounted() {
  const b = { id: 'b', lineN: null, text: 'WAIT', x: 100, y: 200, w: 240, h: 90, style: normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30, color: '#000000' }) };
  loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: [b] }]);
  setZoom(1);
  const pg = page();
  render(TextBox, { box: pg.boxes[0], pageFrameEl: document.createElement('div'), pg });
  await tick();
  return pg.boxes[0];
}
const settle = async () => {
  for (let i = 0; i < 3; i++) await tick();
};

describe('the full paint in the paint worker', () => {
  it('is asked of the worker, not painted here, and shown when it comes back', async () => {
    await mounted();
    expect(requests.length).toBe(1);
    expect(paintBoxPicture).not.toHaveBeenCalled();
    expect(requests[0].apply).not.toHaveBeenCalled();
    requests[0].answer();
    await settle();
    expect(requests[0].apply).toHaveBeenCalledTimes(1);
    expect(requests[0].cancel).not.toHaveBeenCalled();
  });

  it('a result for a picture the box no longer wants is let go, and only the newest is painted', async () => {
    const box = await mounted();
    const first = requests[0];
    // Two changes while the first is on its way: the second waits, the third takes its place.
    box.style.color = '#ff0000';
    await tick();
    box.style.color = '#00ff00';
    await tick();
    expect(requests.length).toBe(1);
    first.answer();
    await settle();
    expect(first.apply).not.toHaveBeenCalled();
    expect(first.cancel).toHaveBeenCalledTimes(1);
    // The waiting one goes now, with the box as it is: the newest.
    expect(requests.length).toBe(2);
    expect(requests[1].color).toBe('#00ff00');
    requests[1].answer();
    await settle();
    expect(requests[1].apply).toHaveBeenCalledTimes(1);
    expect(paintBoxPicture).not.toHaveBeenCalled();
  });

  it('a worker that died has the picture painted here', async () => {
    await mounted();
    requests[0].answer({ dead: true });
    await settle();
    expect(requests[0].apply).not.toHaveBeenCalled();
    expect(requests[0].cancel).toHaveBeenCalledTimes(1);
    // Painted again at once: asked of the worker again here, as the stand-in
    // does not know it is dead (a real dead one says null, and it is painted here).
    expect(requests.length).toBe(2);
  });
});
