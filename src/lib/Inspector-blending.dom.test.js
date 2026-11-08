import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';

// The Fill tab's Blending Options (LAYER_STYLES_PLAN.md phase 6a): the box's
// blend mode is shown now that the engine paints it over the page art, with
// Blend Interior Effects as Group, a note on what blends with the page and
// one on Fill in the special eight.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page } from './store.svelte.js';
import { setInspectorTab } from './inspector-tabs.svelte.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { engineSwitch } from './engine-switch.svelte.js';
import { glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

let restoreCanvas;
const before = glyphPainter();
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
  engineSwitch.painting = false;
  setGlyphPainter(before);
});

function mounted(over = {}, rust = true) {
  const style = normalizeStyle({ ...defaultStyle(), ...over });
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'HELLO' }], boxes: [{ id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style }] }]);
  app.selectedId = 'b';
  if (rust) {
    setGlyphPainter({ ...before, box: true });
    engineSwitch.painting = true;
  }
  setInspectorTab('fill');
  const view = render(Inspector);
  return { view, box: () => page().boxes[0] };
}

describe('the Fill tab blending options', () => {
  it('shows the box blend mode, and what it is set to is the style', async () => {
    const { view, box } = mounted();
    await tick();
    const mode = view.getByRole('combobox', { name: 'Box blend mode' });
    expect(mode.value).toBe('normal');
    expect(view.container.textContent).not.toContain('Blends with the page art.');
    await fireEvent.change(mode, { target: { value: 'multiply' } });
    expect(box().style.blendMode).toBe('multiply');
    flushSync();
    expect(view.container.textContent).toContain('Blends with the page art.');
  });

  it('says how Fill works in the special eight', async () => {
    const { view } = mounted({ blendMode: 'color-dodge', fillOpacity: 0.5 });
    await tick();
    expect(view.container.textContent).toContain('Fill works as in Photoshop for this mode');
  });

  it('offers Blend Interior Effects as Group where an interior effect is', async () => {
    const plain = mounted();
    await tick();
    expect(plain.view.getByLabelText('Blend interior effects as group').disabled).toBe(true);
    cleanup();
    const { view, box } = mounted({ colorOverlays: [{ color: '#0000ff', opacity: 1, blend: 'normal' }] });
    await tick();
    const group = view.getByLabelText('Blend interior effects as group');
    expect(group.disabled).toBe(false);
    await fireEvent.click(group);
    expect(box().style.blending).toEqual({ interior: true, knockout: 'none' });
  });

  it('says it needs the Rust engine without it', async () => {
    const { view } = mounted({}, false);
    await tick();
    expect(view.queryByRole('combobox', { name: 'Box blend mode' })).toBe(null);
  });
});
