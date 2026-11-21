// Moving the page the manga-cleaner way (navigation.js): a trackpad's
// two-finger scroll is the scroller's own, a pinch or Cmd/Ctrl + wheel zooms,
// the wheel zooms only when Settings says so, and a zoomed page has half a
// viewport of room on every side to be scrolled into.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Canvas from './Canvas.svelte';
import { app, loadProjectPages, setZoom, applyFit } from '../store.svelte.js';
import { setPref } from '../prefs.svelte.js';
import { NAVIGATION_PRESETS } from './navigation.js';
import { installFakeCanvas } from '../../test/fake-canvas.js';

let restoreCanvas;
const sizes = {};
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // jsdom lays nothing out; the scroller is given a viewport to be half of.
  for (const k of ['clientWidth', 'clientHeight']) {
    sizes[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
    Object.defineProperty(HTMLElement.prototype, k, {
      configurable: true,
      get() {
        return this.classList?.contains('editor-scroll') ? (k === 'clientWidth' ? 800 : 600) : 0;
      },
    });
  }
});
afterAll(() => {
  // jsdom keeps these on Element; the stub on HTMLElement only shadows them.
  for (const [k, d] of Object.entries(sizes)) {
    if (d) Object.defineProperty(HTMLElement.prototype, k, d);
    else delete HTMLElement.prototype[k];
  }
  vi.unstubAllGlobals();
  restoreCanvas();
});
afterEach(() => {
  cleanup();
  loadProjectPages([]);
  setPref('navigation', NAVIGATION_PRESETS.trackpad);
});

async function open() {
  app.projectLayout = 'pages';
  loadProjectPages([{ id: 1, w: 800, h: 1200, raw: 'asset://localhost/p.png', lines: [], boxes: [] }]);
  app.pageIndex = 0;
  const view = render(Canvas, { props: { onReady: () => {} } });
  await tick();
  return view.container.querySelector('.editor-scroll');
}
const wheel = (el, init) => {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40, ...init });
  el.dispatchEvent(e);
  return e;
};

it('leaves a two-finger scroll to the scroller and zooms on a pinch', async () => {
  const el = await open();
  expect(wheel(el, {}).defaultPrevented).toBe(false);
  expect(wheel(el, { deltaX: 30, deltaY: 0 }).defaultPrevented).toBe(false);
  expect(wheel(el, { ctrlKey: true }).defaultPrevented).toBe(true);
  expect(wheel(el, { metaKey: true }).defaultPrevented).toBe(true);
});

it('zooms on the plain wheel with the mouse setting, and Shift still scrolls', async () => {
  setPref('navigation', NAVIGATION_PRESETS.mouse);
  const el = await open();
  expect(wheel(el, {}).defaultPrevented).toBe(true);
  expect(wheel(el, { shiftKey: true }).defaultPrevented).toBe(false);
});

it('gives a zoomed page half a viewport of room on every side, and none at Fit', async () => {
  const el = await open();
  const stage = el.querySelector('.stage');
  applyFit(0.4);
  await tick();
  expect(stage.style.getPropertyValue('--room-x') || '0px').toBe('0px');
  setZoom(1.5);
  await tick();
  expect(stage.style.getPropertyValue('--room-x')).toBe('400px');
  expect(stage.style.getPropertyValue('--room-y')).toBe('300px');
  applyFit(0.4);
  await tick();
  expect(stage.style.getPropertyValue('--room-x')).toBe('0px');
});

it('lets the middle button pan only while Settings says so', async () => {
  const el = await open();
  const stage = el.querySelector('.stage');
  const press = () => {
    const e = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 1, pointerId: 1 });
    stage.dispatchEvent(e);
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 1, pointerId: 1 }));
    return e;
  };
  expect(press().defaultPrevented).toBe(true);
  setPref('navigation', { ...NAVIGATION_PRESETS.trackpad, middlePan: false });
  expect(press().defaultPrevented).toBe(false);
});
