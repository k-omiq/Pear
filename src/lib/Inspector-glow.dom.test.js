import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';

// A glow's Quality > Jitter in the Inspector's Glow sub-tab: a slider and a
// percent field, open only on a gradient glow (Photoshop greys it out on a
// colour one).
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

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
  it('is open on a gradient glow and writes the style, in percent', async () => {
    const { view, box } = mounted({ outerGlow: { on: true, fill: 'gradient' }, innerGlow: { on: true, fill: 'gradient' } });
    const field = view.getByLabelText('Outer glow jitter, percent');
    expect(field.disabled).toBe(false);
    await fireEvent.change(field, { target: { value: '60' } });
    expect(box().style.outerGlow.jitter).toBe(0.6);
    await fireEvent.input(view.getByLabelText('Inner glow jitter'), { target: { value: '25' } });
    expect(box().style.innerGlow.jitter).toBe(0.25);
  });

  it('is shut on a colour glow', () => {
    const { view } = mounted({ outerGlow: { on: true, fill: 'color' } });
    expect(view.getByLabelText('Outer glow jitter').disabled).toBe(true);
    expect(view.getByLabelText('Outer glow jitter, percent').disabled).toBe(true);
  });
});
