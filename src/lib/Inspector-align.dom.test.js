import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// Align with Layer, on the Gradient Overlay and on the gradient Stroke (the
// Effects tab's shared gradient controls): unticked it stores `align: false`,
// ticked it leaves the key out again, each an undo step; Shape Burst, which
// reads no frame, has it greyed out; a glow's gradient has none.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page, settleEdits } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo, redo } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle, newGradientOverlay, normalizeStrokeEffect } from './data.js';
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
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.selectedId = 'b';
  setInspectorTab('fill');
  return render(Inspector);
}
const style = () => page().boxes[0].style;

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
    const g = () => style().strokeEffects[0].gradient;
    await toggle(view.getByLabelText('Photoshop stroke 1 gradient align with layer'));
    expect(g().align).toBe(false);
    undo();
    expect('align' in g()).toBe(false);
  });

  it('is greyed out for Shape Burst and missing from a glow', async () => {
    const view = mounted({ gradientOverlays: [{ ...newGradientOverlay(), gradient: { style: 'shapeburst' } }], outerGlow: { on: true, fill: 'gradient' } });
    await tick();
    expect(view.getByLabelText('Gradient overlay 1 align with layer').disabled).toBe(true);
    setInspectorTab('effects');
    setEffectsSubTab('glow');
    await tick();
    expect(view.queryByLabelText('Outer glow gradient align with layer')).toBeNull();
  });
});
