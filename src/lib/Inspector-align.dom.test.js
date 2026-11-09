import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// Align with Layer, on the Gradient Overlay and on the gradient Stroke (the
// Effects tab's shared gradient controls): unticked it stores `align: false`,
// ticked it leaves the key out again, each an undo step; Shape Burst, which
// reads no frame, has it greyed out showing the kept value, which applies
// again when the style changes back; a glow's gradient has none.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page, settleEdits } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo, redo } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle, newGradientOverlay, normalizeStrokeEffect } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';
import { pageGradients } from './text-paint.js';

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
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.selectedId = 'b';
  setInspectorTab('fill');
  return render(Inspector);
}
const style = () => page().boxes[0].style;

async function openFold(view, name) {
  const b = view.container.querySelector(`button.insp-fold[aria-label="${name}"]`);
  if (b && b.getAttribute('aria-expanded') !== 'true') {
    await fireEvent.click(b);
    await tick();
  }
}

async function toggle(el) {
  await fireEvent.pointerDown(el);
  await fireEvent.click(el);
  settleEdits();
  await tick();
}

describe('Align with Layer', () => {
  it('on a Gradient Overlay: off stores false, on leaves the key out, each an undo step', async () => {
    const view = mounted({ gradientOverlays: [newGradientOverlay()] });
    await tick();
    await openFold(view, 'Overlays');
    await openFold(view, 'Gradient overlay 1 more options');
    const g = () => style().gradientOverlays[0].gradient;
    const box = view.getByLabelText('Gradient overlay 1 align with layer');
    expect(box.checked).toBe(true);
    expect('align' in g()).toBe(false);
    await toggle(box);
    expect(g().align).toBe(false);
    expect(view.getByLabelText('Gradient overlay 1 align with layer').checked).toBe(false);
    await toggle(view.getByLabelText('Gradient overlay 1 align with layer'));
    expect('align' in g()).toBe(false);
    undo();
    expect(g().align).toBe(false);
    undo();
    // Back as it was: no key, not `align: true`.
    expect('align' in g()).toBe(false);
    redo();
    expect(g().align).toBe(false);
  });

  it('on a gradient Stroke', async () => {
    const view = mounted({ strokeEffects: [normalizeStrokeEffect({ size: 4, fill: 'gradient' })] });
    setInspectorTab('effects');
    setEffectsSubTab('stroke');
    await tick();
    await openFold(view, 'Photoshop stroke 1 gradient more options');
    const g = () => style().strokeEffects[0].gradient;
    await toggle(view.getByLabelText('Photoshop stroke 1 gradient align with layer'));
    expect(g().align).toBe(false);
    undo();
    expect('align' in g()).toBe(false);
  });

  it('keeps an off setting through Shape Burst, greyed, and back again', async () => {
    const view = mounted({ gradientOverlays: [newGradientOverlay()] });
    await tick();
    await openFold(view, 'Overlays');
    await openFold(view, 'Gradient overlay 1 more options');
    const g = () => style().gradientOverlays[0].gradient;
    const box = () => view.getByLabelText('Gradient overlay 1 align with layer');
    const setStyle = async (v) => {
      await fireEvent.change(view.getByLabelText('Gradient overlay 1 style'), { target: { value: v } });
      settleEdits();
      await tick();
    };
    await toggle(box());
    expect(g().align).toBe(false);
    expect(pageGradients(style())).toBe(true);
    await setStyle('shapeburst');
    // Shown as stored, greyed; Shape Burst reads no frame, so the box is not
    // laid over the page (no page record, no repaint as it moves).
    expect(box().disabled).toBe(true);
    expect(box().checked).toBe(false);
    expect(g().align).toBe(false);
    expect(pageGradients(style())).toBe(false);
    await setStyle('linear');
    expect(box().disabled).toBe(false);
    expect(box().checked).toBe(false);
    expect(pageGradients(style())).toBe(true);
    await toggle(box());
    expect('align' in g()).toBe(false);
  });

  it('is greyed out for Shape Burst and missing from a glow', async () => {
    const view = mounted({ gradientOverlays: [{ ...newGradientOverlay(), gradient: { style: 'shapeburst' } }], outerGlow: { on: true, fill: 'gradient' } });
    await tick();
    await openFold(view, 'Overlays');
    await openFold(view, 'Gradient overlay 1 more options');
    expect(view.getByLabelText('Gradient overlay 1 align with layer').disabled).toBe(true);
    setInspectorTab('effects');
    setEffectsSubTab('glow');
    await tick();
    expect(view.queryByLabelText('Outer glow gradient align with layer')).toBeNull();
  });
});
