import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// Effects ▸ Shape ▸ Wobble: a switch, Amount, Tilt and a seed with a dice.
// Each change is one undo step. Only the Rust engine paints it, so under the
// browser engine every control is dimmed and the group says why.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page, settleEdits } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo, peekStack } from './editor/history.svelte.js';
import { engineSwitch } from './engine-switch.svelte.js';
import { glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

const before = glyphPainter();
let restoreCanvas;
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterAll(() => {
  vi.unstubAllGlobals();
  restoreCanvas();
});
beforeEach(() => {
  initHistory();
  resetHistory();
});
afterEach(() => {
  cleanup();
  app.selectedId = null;
  loadProjectPages([]);
  engineSwitch.painting = false;
  setGlyphPainter(before);
  setEffectsSubTab('stroke');
});

function mounted(rust = true, wobble = {}) {
  const style = normalizeStyle({ ...defaultStyle(), wobble: { ...defaultStyle().wobble, ...wobble } });
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'HELLO' }], boxes: [{ id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style }] }]);
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.selectedId = 'b';
  if (rust) {
    setGlyphPainter({ ...before, box: true, wobble: true });
    engineSwitch.painting = true;
  }
  setInspectorTab('effects');
  setEffectsSubTab('wobble');
  const view = render(Inspector);
  return { view, box: () => page().boxes[0] };
}
const records = () => peekStack().undo.length;

describe('the Wobble panel', () => {
  it('is in the Shape group, and off it shows the switch with its numbers dimmed', async () => {
    const { view } = mounted();
    await tick();
    expect(view.getByRole('tab', { name: 'Shape' }).getAttribute('aria-selected')).toBe('true');
    expect(view.getByRole('tab', { name: 'Wobble' }).getAttribute('aria-selected')).toBe('true');
    const sw = view.getByRole('switch', { name: 'Wobble' });
    expect(sw.disabled).toBe(false);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(view.getByLabelText('Wobble seed').disabled).toBe(true);
    expect(view.container.textContent).not.toContain('Wobble needs the Rust text engine');
  });

  it('switch, seed and dice are one undo step each, and undo puts each back', async () => {
    const { view, box } = mounted();
    await tick();
    const base = records();
    const sw = view.getByRole('switch', { name: 'Wobble' });
    await fireEvent.pointerDown(sw);
    await fireEvent.click(sw);
    settleEdits();
    expect(box().style.wobble.on).toBe(true);
    expect(records()).toBe(base + 1);

    const seed = view.getByLabelText('Wobble seed');
    await fireEvent.pointerDown(seed);
    await fireEvent.change(seed, { target: { value: '41.6' } });
    settleEdits();
    expect(box().style.wobble.seed).toBe(42);
    expect(records()).toBe(base + 2);

    const dice = view.getByRole('button', { name: 'New wobble seed' });
    await fireEvent.pointerDown(dice);
    await fireEvent.click(dice);
    settleEdits();
    expect(box().style.wobble.seed).not.toBe(42);
    expect(box().style.wobble.seed).toBeGreaterThanOrEqual(0);
    expect(box().style.wobble.seed).toBeLessThanOrEqual(999);
    expect(records()).toBe(base + 3);

    undo();
    await tick();
    expect(page().boxes[0].style.wobble.seed).toBe(42);
    undo();
    await tick();
    expect(page().boxes[0].style.wobble.seed).toBe(7);
    undo();
    await tick();
    expect(page().boxes[0].style.wobble.on).toBe(false);
  });

  it('under the browser engine the controls are dimmed and the group says why', async () => {
    const { view } = mounted(false, { on: false });
    await tick();
    expect(view.getByRole('switch', { name: 'Wobble' }).disabled).toBe(true);
    expect(view.getByLabelText('Wobble seed').disabled).toBe(true);
    expect(view.container.textContent).toContain('Wobble needs the Rust text engine (Settings).');
  });

  it('under the browser engine a wobble that is on can still be switched off', async () => {
    const { view } = mounted(false, { on: true });
    await tick();
    const sw = view.getByRole('switch', { name: 'Wobble' });
    expect(view.getByLabelText('Wobble seed').disabled).toBe(true);
    expect(view.getByRole('button', { name: 'New wobble seed' }).disabled).toBe(true);
    expect(sw.disabled).toBe(false);
    await fireEvent.click(sw);
    expect(page().boxes[0].style.wobble.on).toBe(false);
    // Off, it cannot be put back on here.
    expect(sw.disabled).toBe(true);
  });
});
