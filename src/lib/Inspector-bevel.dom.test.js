import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';

// The Inspector's Bevel & Emboss sub-tab: it is there, in Photoshop's dialog
// order, and what a control is set to is what the box's style then holds.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page, setChapterLight } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab, EFFECTS_SUBTABS } from './inspector-tabs.svelte.js';
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
afterEach(() => {
  cleanup();
  app.selectedId = null;
  loadProjectPages([]);
});

function mounted(bevel = {}) {
  const style = normalizeStyle({ ...defaultStyle(), bevel });
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'HELLO' }], boxes: [{ id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style }] }]);
  app.selectedId = 'b';
  setInspectorTab('effects');
  setEffectsSubTab('bevel');
  const view = render(Inspector);
  return { view, box: () => page().boxes[0] };
}

describe('the Bevel & Emboss sub-tab', () => {
  it('sits after Glow, and shows Structure, Shading, Contour and Texture in that order', async () => {
    expect(EFFECTS_SUBTABS.indexOf('bevel')).toBe(EFFECTS_SUBTABS.indexOf('glow') + 1);
    const off = mounted().view;
    await tick();
    expect(off.getByRole('tab', { name: 'Bevel' }).getAttribute('aria-selected')).toBe('true');
    expect(off.getByRole('switch', { name: 'Bevel & Emboss' }).getAttribute('aria-checked')).toBe('false');
    // Off, the effect is its switch alone; on, its settings show.
    expect(off.container.textContent).not.toContain('Structure');
    cleanup();
    const { view } = mounted({ on: true });
    await tick();
    const text = view.container.textContent;
    const at = (w) => text.indexOf(w);
    for (const w of ['Structure', 'Shading', 'Contour', 'Texture']) expect(at(w)).toBeGreaterThan(-1);
    expect(at('Structure')).toBeLessThan(at('Shading'));
    expect(at('Shading')).toBeLessThan(at('Contour'));
    expect(at('Contour')).toBeLessThan(at('Texture'));
  });

  it('writes what a control is set to into the box style', async () => {
    const { view, box } = mounted();
    await fireEvent.click(view.getByRole('switch', { name: 'Bevel & Emboss' }));
    expect(box().style.bevel.on).toBe(true);
    flushSync();
    await fireEvent.change(view.getByRole('combobox', { name: 'Bevel style' }), { target: { value: 'emboss' } });
    expect(box().style.bevel.style).toBe('emboss');
    await fireEvent.click(within(view.getByRole('group', { name: 'Bevel technique' })).getByRole('button', { name: 'Hard' }));
    expect(box().style.bevel.technique).toBe('chisel-hard');
    await fireEvent.input(view.getByRole('slider', { name: 'Bevel depth' }), { target: { value: '250' } });
    expect(box().style.bevel.depth).toBe(2.5);
    await fireEvent.input(view.getByRole('slider', { name: 'Bevel size' }), { target: { value: '12' } });
    expect(box().style.bevel.size).toBe(12);
    await fireEvent.click(within(view.getByRole('group', { name: 'Bevel direction' })).getByRole('button', { name: 'Down' }));
    expect(box().style.bevel.direction).toBe('down');
    // Off the Global Light the angle is the box's own.
    await fireEvent.click(view.getByLabelText('Bevel uses the global light'));
    expect(box().style.bevel.useGlobalLight).toBe(false);
    await fireEvent.change(view.getByLabelText('Bevel light, degrees'), { target: { value: '45' } });
    expect(box().style.bevel.angle).toBe(45);
    await fireEvent.change(view.getByLabelText('Bevel light altitude, degrees'), { target: { value: '60' } });
    expect(box().style.bevel.altitude).toBe(60);
    // The elements wait in their folds; their switches open their controls.
    await openFxFolds(view);
    await fireEvent.click(view.getByRole('switch', { name: 'Bevel contour' }));
    expect(box().style.bevel.contour.on).toBe(true);
    flushSync();
    expect(view.container.textContent).toContain('Range is not painted yet');
    await fireEvent.click(view.getByRole('switch', { name: 'Bevel texture' }));
    expect(box().style.bevel.texture.on).toBe(true);
    flushSync();
    await fireEvent.input(view.getByRole('slider', { name: 'Bevel texture depth' }), { target: { value: '-150' } });
    expect(box().style.bevel.texture.depth).toBe(-1.5);
  });

  it("turns the chapter's light from a bevel on the Global Light", async () => {
    const { view, box } = mounted({ on: true });
    // The chapter's light is set only with a chapter open.
    const ref = app.chapterRef;
    app.chapterRef = ref ?? { project: 'p', chapter: 'c' };
    try {
      await fireEvent.change(view.getByLabelText('Bevel light altitude, degrees'), { target: { value: '55' } });
      expect(app.typesetting.light?.altitude).toBe(55);
      expect(box().style.bevel.altitude).toBe(30);
    } finally {
      setChapterLight({ angle: 120, altitude: 30 });
      app.chapterRef = ref;
    }
  });
});
