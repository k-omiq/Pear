import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';

// The Inspector's Bevel & Emboss sub-tab: it is there, in Photoshop's dialog
// order, and what a control is set to is what the box's style then holds.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page, setChapterLight } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab, EFFECTS_SUBTABS } from './inspector-tabs.svelte.js';
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
    const { view } = mounted();
    await tick();
    expect(view.getByRole('tab', { name: 'Bevel & Emboss' }).getAttribute('aria-selected')).toBe('true');
    const text = view.container.textContent;
    const at = (w) => text.indexOf(w);
    for (const w of ['Structure', 'Shading', 'Contour', 'Texture']) expect(at(w)).toBeGreaterThan(-1);
    expect(at('Structure')).toBeLessThan(at('Shading'));
    expect(at('Shading')).toBeLessThan(at('Range') === -1 ? at('Texture') : at('Range'));
    expect(view.getByRole('switch', { name: 'Bevel & Emboss' }).getAttribute('aria-checked')).toBe('false');
  });

  it('writes what a control is set to into the box style', async () => {
    const { view, box } = mounted();
    await fireEvent.click(view.getByRole('switch', { name: 'Bevel & Emboss' }));
    expect(box().style.bevel.on).toBe(true);
    await fireEvent.change(view.getByRole('combobox', { name: 'Bevel style' }), { target: { value: 'emboss' } });
    expect(box().style.bevel.style).toBe('emboss');
    await fireEvent.change(view.getByRole('combobox', { name: 'Bevel technique' }), { target: { value: 'chisel-hard' } });
    expect(box().style.bevel.technique).toBe('chisel-hard');
    await fireEvent.change(view.getByLabelText('Bevel depth, percent'), { target: { value: '250' } });
    expect(box().style.bevel.depth).toBe(2.5);
    await fireEvent.change(view.getByLabelText('Bevel size, page px'), { target: { value: '12' } });
    expect(box().style.bevel.size).toBe(12);
    await fireEvent.click(view.getByLabelText('Bevel direction Down'));
    expect(box().style.bevel.direction).toBe('down');
    // Off the Global Light the angle is the box's own.
    await fireEvent.click(view.getByLabelText('Bevel uses the global light'));
    expect(box().style.bevel.useGlobalLight).toBe(false);
    await fireEvent.change(view.getByLabelText('Bevel angle'), { target: { value: '45' } });
    expect(box().style.bevel.angle).toBe(45);
    // The elements' switches open their controls.
    await fireEvent.click(view.getByRole('switch', { name: 'Bevel contour' }));
    expect(box().style.bevel.contour.on).toBe(true);
    flushSync();
    expect(view.container.textContent).toContain('Range (not painted yet)');
    await fireEvent.click(view.getByRole('switch', { name: 'Bevel texture' }));
    expect(box().style.bevel.texture.on).toBe(true);
    await fireEvent.change(view.getByLabelText('Bevel texture depth, percent'), { target: { value: '-150' } });
    expect(box().style.bevel.texture.depth).toBe(-1.5);
  });

  it("turns the chapter's light from a bevel on the Global Light", async () => {
    const { view, box } = mounted({ on: true });
    // The chapter's light is set only with a chapter open.
    const ref = app.chapterRef;
    app.chapterRef = ref ?? { project: 'p', chapter: 'c' };
    try {
      await fireEvent.change(view.getByLabelText('Bevel altitude'), { target: { value: '55' } });
      expect(app.typesetting.light?.altitude).toBe(55);
      expect(box().style.bevel.altitude).toBe(30);
    } finally {
      setChapterLight({ angle: 120, altitude: 30 });
      app.chapterRef = ref;
    }
  });
});
