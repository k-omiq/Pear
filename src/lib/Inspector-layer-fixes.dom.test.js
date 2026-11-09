import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// Review fixes for the Layer Styles panel: No Fill keeps its overlay controls
// (F43), a Global Light turn is an undo step (F44), a shadow keeps its angle at
// Distance 0 (F48), and Blend If sliders (F46, F47).
import Inspector from './Inspector.svelte';
import BlendRangeSlider from './BlendRangeSlider.svelte';
import { app, loadProjectPages, page, setChapterLight } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo, redo } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle, newShadow } from './data.js';
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

function mounted(style, tab = 'fill', sub = null) {
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'HELLO' }], boxes: [{ id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style: normalizeStyle({ ...defaultStyle(), ...style }) }] }]);
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.selectedId = 'b';
  setInspectorTab(tab);
  if (sub) setEffectsSubTab(sub);
  const view = render(Inspector);
  return { view, box: () => page().boxes[0] };
}

describe('F43: No Fill keeps the overlay controls', () => {
  it('shows the colour, gradient and pattern overlay sections on a No Fill box', async () => {
    const { view } = mounted({ noFill: true });
    await tick();
    expect(view.container.textContent).toContain('Colour overlays');
    expect(view.container.textContent).toContain('Gradient overlays');
    expect(view.getByRole('switch', { name: 'Pattern overlay' })).toBeTruthy();
  });
});

describe('F44 and F48: shadow angle', () => {
  it('turns the Global Light from a shadow field as one undo step', async () => {
    const style = { shadows: [{ ...newShadow({ angle: 120 }), useGlobalLight: true }] };
    const { view } = mounted(style, 'effects', 'shadow');
    await tick();
    const was = app.typesetting.light?.angle ?? 120;
    await fireEvent.change(view.getByLabelText('Shadow 1 angle'), { target: { value: '45' } });
    expect(app.typesetting.light.angle).toBe(45);
    undo();
    expect(app.typesetting.light?.angle ?? 120).toBe(was);
    redo();
    expect(app.typesetting.light.angle).toBe(45);
    setChapterLight({ angle: was });
  });

  it('keeps an off-light shadow angle through Distance 0', async () => {
    const sh = { ...newShadow({ angle: 120 }), useGlobalLight: false };
    const { view, box } = mounted({ shadows: [sh] }, 'effects', 'shadow');
    await tick();
    await fireEvent.change(view.getByLabelText('Shadow 1 angle'), { target: { value: '45' } });
    await fireEvent.change(view.getByLabelText('Shadow 1 distance'), { target: { value: '0' } });
    await fireEvent.change(view.getByLabelText('Shadow 1 distance'), { target: { value: '10' } });
    const s0 = box().style.shadows[0];
    expect(Math.round(Math.hypot(s0.x, s0.y))).toBe(10);
    expect(Math.round((Math.atan2(s0.y, -s0.x) * 180) / Math.PI)).toBe(45);
  });
});

describe('F46 and F47: the Blend If slider', () => {
  const sliderAt = (value, onchange = () => {}) => {
    const view = render(BlendRangeSlider, { label: 'This', value, onchange });
    const track = view.container.querySelector('.br-track');
    track.getBoundingClientRect = () => ({ left: 0, top: 0, width: 255, height: 12, right: 255, bottom: 12 });
    return { view, track, inputs: () => [...track.querySelectorAll('input')] };
  };

  it('writes the clamped value back to the input', async () => {
    const { inputs } = sliderAt([0, 0, 100, 100]);
    const black = inputs()[0];
    black.value = '200';
    await fireEvent.input(black);
    expect(black.value).toBe('100');
  });

  it('raises the handle that can move toward the pointer when two sit together', async () => {
    const { track, inputs } = sliderAt([0, 0, 255, 255]);
    await fireEvent.click(track.parentElement.querySelector('input[aria-label="This split"]'));
    await tick();
    // Pointer at 128: the white handles are nearest, and white low is free to move.
    await fireEvent.pointerMove(track, { clientX: 128 });
    await tick();
    const z = inputs().map((i) => i.style.zIndex);
    expect(z).toEqual(['1', '1', '2', '1']);
  });
});
