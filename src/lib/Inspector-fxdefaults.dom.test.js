import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// Each effect's "…" menu in the Inspector: Make default, Reset to default and
// Reset to factory (LAYER_STYLES_PLAN.md item 12, phase 7a). A Reset is one
// undo step.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo, history } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle, newShadow } from './data.js';
import { prefs, setPref } from './prefs.svelte.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

const TIP = 'Used when you add or reset this effect.';

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
  setPref('fxDefaults', {});
});
afterEach(() => {
  cleanup();
  app.selectedId = null;
  loadProjectPages([]);
  setPref('fxDefaults', {});
});

function mounted(style, sub) {
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'HELLO' }], boxes: [{ id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style: normalizeStyle({ ...defaultStyle(), ...style }) }] }]);
  app.selectedId = 'b';
  setInspectorTab('effects');
  setEffectsSubTab(sub);
  const view = render(Inspector);
  return { view, box: () => page().boxes[0] };
}

async function pick(view, menu, item) {
  await fireEvent.click(view.getByRole('button', { name: menu }));
  await tick();
  await fireEvent.click(view.getByRole('menuitem', { name: item }));
  await tick();
  await tick();
}

describe("an effect's defaults menu", () => {
  it('offers Make default, Reset to default and Reset to factory, each saying what a default is for', async () => {
    const { view } = mounted({ shadows: [newShadow({ angle: 120 })] }, 'shadow');
    await fireEvent.click(view.getByRole('button', { name: 'Shadow 1 defaults' }));
    await tick();
    const items = view.getAllByRole('menuitem');
    expect(items.map((b) => b.textContent)).toEqual(['Make default', 'Reset to default', 'Reset to factory']);
    for (const b of items) expect(b.getAttribute('title')).toContain(TIP);
  });

  it('saves a default, resets to it as one undo step, and a new shadow starts from it', async () => {
    const { view, box } = mounted({ shadows: [newShadow({ angle: 120 })] }, 'shadow');
    const size = () => view.getByLabelText('Shadow 1 size');
    await fireEvent.keyDown(size());
    await fireEvent.change(size(), { target: { value: '20' } });
    expect(box().style.shadows[0].size).toBe(20);
    await pick(view, 'Shadow 1 defaults', 'Make default');
    expect(prefs.fxDefaults.dropShadow).toMatchObject({ size: 20, useGlobalLight: true, distance: 5 });
    expect(prefs.fxDefaults.dropShadow).not.toHaveProperty('x');

    await fireEvent.keyDown(size());
    await fireEvent.change(size(), { target: { value: '40' } });
    expect(box().style.shadows[0].size).toBe(40);
    await pick(view, 'Shadow 1 defaults', 'Reset to default');
    expect(box().style.shadows[0].size).toBe(20);
    // One undo takes the Reset back, and only the Reset.
    // (The two typed sizes before it fall in one edit burst, as any quick
    // edits do: the step under the Reset goes back to the start.)
    undo();
    expect(page().boxes[0].style.shadows[0].size).toBe(40);
    expect(history.canUndo).toBe(true);
    undo();
    expect(page().boxes[0].style.shadows[0].size).toBe(5);
    expect(history.canUndo).toBe(false);

    // Add shadow starts from the saved default.
    await fireEvent.click(view.getByRole('button', { name: 'Add shadow' }));
    expect(page().boxes[0].style.shadows.at(-1).size).toBe(20);
  });

  it('resets to the factory and forgets the saved default', async () => {
    setPref('fxDefaults', { dropShadow: { ...newShadow({ angle: 120 }), size: 30 } });
    const { view, box } = mounted({ shadows: [{ ...newShadow({ angle: 120 }), size: 30, opacity: 0.2 }] }, 'shadow');
    await pick(view, 'Shadow 1 defaults', 'Reset to factory');
    expect(prefs.fxDefaults.dropShadow).toBeUndefined();
    expect(box().style.shadows[0]).toMatchObject({ size: 5, opacity: 0.75 });
  });

  it('switches on a never-edited glow at the saved default, and keeps a Satin switched off on Reset', async () => {
    setPref('fxDefaults', { outerGlow: { size: 33, color: '#ff8800' }, satin: { distance: 40 } });
    const { view, box } = mounted({ satin: { on: false, size: 3 } }, 'glow');
    await fireEvent.click(view.getByRole('switch', { name: 'Outer glow' }));
    expect(box().style.outerGlow).toMatchObject({ on: true, size: 33, color: '#ff8800' });
    // An edited one keeps its own values when switched on.
    await fireEvent.click(view.getByRole('switch', { name: 'Satin' }));
    expect(box().style.satin).toMatchObject({ on: true, size: 3, distance: 11 });
    await fireEvent.click(view.getByRole('switch', { name: 'Satin' }));
    await pick(view, 'Satin defaults', 'Reset to default');
    expect(box().style.satin).toMatchObject({ on: false, size: 14, distance: 40 });
  });
});
