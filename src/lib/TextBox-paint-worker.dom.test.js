import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The full paint of a box at rest goes to the paint worker
// (`requestBoxPicture`), and its result comes back later. It is shown only if
// it is still the picture the box wants; one asked for while another is on
// its way waits, and only the newest is painted. The worker is a stand-in
// here that answers when the case says so.
const requests = [];
// Requests made and not yet answered, and the most there ever were.
const open = { now: 0, most: 0 };
vi.mock('./editor/box-picture.js', async (original) => {
  const mod = await original();
  return {
    ...mod,
    paintBoxPicture: vi.fn(mod.paintBoxPicture),
    pictureWorkerReady: vi.fn(() => true),
    requestBoxPicture: vi.fn((box) => {
      let answer;
      let fail;
      const promise = new Promise((resolve, reject) => {
        answer = resolve;
        fail = reject;
      });
      open.now++;
      open.most = Math.max(open.most, open.now);
      const req = {
        id: box.id,
        color: box.style.color,
        box,
        promise,
        prepMs: 0,
        answer: (res = { raster: null, ms: 1 }) => {
          open.now--;
          answer(res);
        },
        fail: (err = new Error('refused')) => {
          open.now--;
          fail(err);
        },
        // The picture to keep, as `requestBoxPicture`'s `apply` returns it:
        // 10 x 10 page px at the picture's scale.
        apply: vi.fn(() => {
          const canvas = document.createElement('canvas');
          canvas.width = 20;
          canvas.height = 20;
          return { canvas, ox: 0, oy: 0, cw: 10, ch: 10, ss: 2 };
        }),
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
  open.now = 0;
  open.most = 0;
});
afterEach(() => {
  cleanup();
  engineSwitch.painting = false;
  app.selectedId = null;
  setZoom(1);
  loadProjectPages([]);
  vi.unstubAllGlobals();
});

const boxOf = (id, x = 100) => ({ id, lineN: null, text: 'WAIT', x, y: 200, w: 240, h: 90, style: normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30, color: '#000000' }) });
async function mounted(ids = ['b']) {
  loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: ids.map((id, i) => boxOf(id, 100 + i * 300)) }]);
  setZoom(1);
  const pg = page();
  for (const b of pg.boxes) render(TextBox, { box: b, pageFrameEl: document.createElement('div'), pg });
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
    expect(requests[0].apply).toHaveBeenCalledWith({ raster: null, ms: 1 });
    expect(requests[0].cancel).not.toHaveBeenCalled();
    // The picture it made is kept, and shown: at 100% on a 1x display, one
    // canvas px per device px of its 10 x 10 page px.
    const el = document.querySelector('canvas.warpl');
    expect(el.width).toBeGreaterThanOrEqual(10);
    expect(el.width).toBeLessThanOrEqual(11);
    expect(requests[0].apply.mock.results[0].value.canvas.width).toBe(20);
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

  it('a worker that died has the picture painted here, once', async () => {
    await mounted();
    requests[0].answer({ dead: true });
    await settle();
    expect(requests[0].apply).not.toHaveBeenCalled();
    expect(requests[0].cancel).toHaveBeenCalledTimes(1);
    expect(paintBoxPicture).toHaveBeenCalledTimes(1);
    expect(requests.length).toBe(1);
  });

  it('a paint the worker refused is painted here once, and the box stays a picture', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await mounted();
      requests[0].fail();
      await settle();
      expect(requests[0].cancel).toHaveBeenCalled();
      expect(paintBoxPicture).toHaveBeenCalledTimes(1);
      expect(requests.length).toBe(1);
      expect(said).not.toHaveBeenCalled();
      expect(document.querySelector('canvas.warpl')).toBeTruthy();
    } finally {
      said.mockRestore();
    }
  });

  it('four boxes at once: never more than two with the worker, and all four painted', async () => {
    await mounted(['a', 'b', 'c', 'd']);
    expect(requests.length).toBe(2);
    for (let i = 0; i < 4; i++) {
      requests[i].answer();
      await settle();
    }
    expect(requests.map((r) => r.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(open.most).toBe(2);
    for (const r of requests) expect(r.apply).toHaveBeenCalledTimes(1);
    expect(paintBoxPicture).not.toHaveBeenCalled();
  });
});

describe('a masked box moved', () => {
  // Only a live move frame may read the kept mask between pixels (wire v24,
  // `liveMove`): the drag's frames say so, and the drag let go asks for one
  // more paint that does not, so the picture at rest is exact.
  const ev = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  it('sends its drag frames live and paints once more at rest when let go', async () => {
    loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: [{ ...boxOf('m'), mask: { on: true, shapes: [{ kind: 'ellipse', op: 'hide', cx: 220, cy: 245, rx: 80, ry: 30 }] } }] }]);
    setZoom(1);
    const pg = page();
    const view = render(TextBox, { box: pg.boxes[0], pageFrameEl: document.createElement('div'), pg });
    await settle();
    requests.at(-1).answer();
    await settle();
    const root = view.container.querySelector('.tbox');
    root.dispatchEvent(ev('pointerdown', 0, 0));
    for (const [x, y] of [[3.5, 1.25], [10.5, 3.25]]) {
      document.dispatchEvent(ev('pointermove', x, y));
      await settle();
      requests.at(-1).answer();
      await settle();
    }
    const frames = requests.filter((r) => r.box.pinMove);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((r) => r.box.liveMove === true)).toBe(true);
    const asked = requests.length;
    document.dispatchEvent(ev('pointerup', 10.5, 3.25));
    await settle();
    expect(requests.length).toBe(asked + 1);
    const rest = requests.at(-1).box;
    expect(rest.pinMove).toEqual([-10.5, -3.25]);
    expect(rest.liveMove).toBeUndefined();
    expect(pg.boxes[0].x).toBe(110.5);
  });

  it('a move that is no drag (typed X, a nudge, an undo) is painted at rest', async () => {
    loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: [{ ...boxOf('m'), mask: { on: true, shapes: [{ kind: 'ellipse', op: 'hide', cx: 220, cy: 245, rx: 80, ry: 30 }] } }] }]);
    setZoom(1);
    const pg = page();
    render(TextBox, { box: pg.boxes[0], pageFrameEl: document.createElement('div'), pg });
    await settle();
    requests.at(-1).answer();
    await settle();
    pg.boxes[0].x = 117.25;
    await settle();
    const rest = requests.at(-1).box;
    expect(rest.pinMove).toEqual([-17.25, 0]);
    expect(rest.liveMove).toBeUndefined();
  });
});
