import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The Effects tab's two rows: a group segment, then the group's sub-tabs in
// words. Each group remembers the sub-tab it last showed, and the Mask panel's
// tools arm the shared draw tool.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab, effectsSubTab, EFFECTS_TABS, EFFECTS_GROUPS } from './inspector-tabs.svelte.js';
import { drawTool, clearDrawTool } from './box-draw-tool.svelte.js';
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
afterEach(() => {
  cleanup();
  clearDrawTool();
  setEffectsSubTab('stroke');
  app.selectedId = null;
  loadProjectPages([]);
});

function mounted(clip = {}) {
  const style = normalizeStyle({ ...defaultStyle(), clip: { on: false, mode: 'exclude', brushSize: 20, shapes: [], ...clip } });
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'HELLO' }], boxes: [{ id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style }] }]);
  app.selectedId = 'b';
  setInspectorTab('effects');
  return render(Inspector);
}
const names = (view, label) => view.getByRole('tablist', { name: label }).querySelectorAll('[role="tab"]');

describe('the Effects groups', () => {
  it('every sub-tab is in a group, and no group holds more than four', () => {
    for (const t of EFFECTS_TABS) expect(EFFECTS_GROUPS.map((g) => g.id)).toContain(t.group);
    for (const g of EFFECTS_GROUPS) expect(EFFECTS_TABS.filter((t) => t.group === g.id).length).toBeLessThanOrEqual(4);
  });

  it('shows four groups, then the open group\'s sub-tabs as words', async () => {
    const view = mounted();
    await tick();
    expect([...names(view, 'Effects groups')].map((b) => b.textContent)).toEqual(['Styles', 'Shape', 'Surface', 'Paint']);
    expect([...names(view, 'Effects options')].map((b) => b.textContent)).toEqual(['Stroke', 'Shadow', 'Glow', 'Bevel']);
    await fireEvent.click(view.getByRole('tab', { name: 'Shape' }));
    expect([...names(view, 'Effects options')].map((b) => b.textContent)).toEqual(['Warp', 'Transform', 'Liquify', 'Wobble']);
    expect(effectsSubTab.id).toBe('warp');
  });

  it('a group goes back to the sub-tab it last showed', async () => {
    const view = mounted();
    await tick();
    await fireEvent.click(view.getByRole('tab', { name: 'Shape' }));
    await fireEvent.click(view.getByRole('tab', { name: 'Liquify' }));
    await fireEvent.click(view.getByRole('tab', { name: 'Styles' }));
    expect(effectsSubTab.id).toBe('stroke');
    await fireEvent.click(view.getByRole('tab', { name: 'Shape' }));
    expect(effectsSubTab.id).toBe('liquify');
    expect(view.getByRole('tab', { name: 'Shape' }).getAttribute('aria-selected')).toBe('true');
  });

  it('picking a sub-tab from outside the panel picks its group', async () => {
    const view = mounted();
    setEffectsSubTab('mask');
    await tick();
    expect(view.getByRole('tab', { name: 'Paint' }).getAttribute('aria-selected')).toBe('true');
    expect(view.getByRole('tab', { name: 'Mask' }).getAttribute('aria-selected')).toBe('true');
  });

  it('the Mask tools are dimmed while the mask is off, and arm the draw tool when it is on', async () => {
    setEffectsSubTab('mask');
    let view = mounted();
    await tick();
    expect(view.getByRole('button', { name: 'Rectangle' }).disabled).toBe(true);
    cleanup();
    view = mounted({ on: true });
    await tick();
    await fireEvent.click(view.getByRole('button', { name: 'Rectangle' }));
    expect(drawTool).toEqual({ target: 'mask', kind: 'rect' });
    expect(view.container.textContent).toContain('Drag on the box to draw a rectangle.');
    await fireEvent.click(view.getByRole('button', { name: 'Move' }));
    expect(drawTool.kind).toBe('move');
    // The same tool again puts it down.
    await fireEvent.click(view.getByRole('button', { name: 'Move' }));
    expect(drawTool.target).toBe(null);
  });
});
