import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// A glow's Quality > Jitter in the Inspector's Glow sub-tab: a slider and a
// percent field, open only on a gradient glow (Photoshop greys it out on a
// colour one).
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';
import { openFxFolds } from '../test/inspector-folds.js';

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
});

function mounted(style) {
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'HELLO' }], boxes: [{ id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style: normalizeStyle({ ...defaultStyle(), ...style }) }] }]);
  app.selectedId = 'b';
  setInspectorTab('effects');
  setEffectsSubTab('glow');
  const view = render(Inspector);
  return { view, box: () => page().boxes[0] };
}

describe("a glow's Jitter", () => {
  it('is under More on a gradient glow and writes the style, in percent', async () => {
    const { view, box } = mounted({ outerGlow: { on: true, fill: 'gradient' }, innerGlow: { on: true, fill: 'gradient' } });
    await tick();
    await openFxFolds(view);
    await fireEvent.input(view.getByRole('slider', { name: 'Outer glow jitter' }), { target: { value: '60' } });
    expect(box().style.outerGlow.jitter).toBe(0.6);
    await fireEvent.input(view.getByRole('slider', { name: 'Inner glow jitter' }), { target: { value: '25' } });
    expect(box().style.innerGlow.jitter).toBe(0.25);
  });

  it('is not shown on a colour glow, which has no gradient to scatter', async () => {
    const { view } = mounted({ outerGlow: { on: true, fill: 'color' } });
    await tick();
    await openFxFolds(view);
    expect(view.queryByLabelText('Outer glow jitter')).toBeNull();
  });
});
