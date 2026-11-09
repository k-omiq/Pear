import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// Review fixes for the Layer Styles panel: No Fill keeps its overlay controls
// (F43), a Global Light turn is an undo step (F44), a shadow keeps its angle at
// Distance 0 (F48), and Blend If sliders (F46, F47).
import Inspector from './Inspector.svelte';
import BlendRangeSlider from './BlendRangeSlider.svelte';
import { app, loadProjectPages, page, setChapterLight, settleEdits } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo, redo } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle, newShadow, newInnerShadow } from './data.js';
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

async function openFold(view, name) {
  const b = view.container.querySelector(`button.insp-fold[aria-label="${name}"]`);
  if (b && b.getAttribute('aria-expanded') !== 'true') {
    await fireEvent.click(b);
    await tick();
  }
}

describe('F43: No Fill keeps the overlay controls', () => {
  it('shows the colour, gradient and pattern overlay sections on a No Fill box', async () => {
    const { view } = mounted({ noFill: true });
    await tick();
    await openFold(view, 'Overlays');
    expect(view.getByRole('button', { name: 'Add colour overlay' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Add gradient overlay' })).toBeTruthy();
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

  // The kept angle is the style's own (`angle`), not the panel's: it is
  // undone and redone with the distance and survives a save and a reload.
  it('stores the angle at Distance 0 so undo, redo and a reload keep it', async () => {
    const sh = { ...newShadow({ angle: 120 }), useGlobalLight: false };
    const { view, box } = mounted({ shadows: [sh] }, 'effects', 'shadow');
    await tick();
    // Each edit its own undo step: armed by its keydown, closed after it.
    const edit = async (label, value) => {
      const el = view.getByLabelText(label);
      await fireEvent.keyDown(el, { key: 'Enter' });
      await fireEvent.change(el, { target: { value } });
      settleEdits();
    };
    await edit('Shadow 1 angle', '45');
    expect(box().style.shadows[0].angle).toBeUndefined(); // the offset says 45 itself
    await edit('Shadow 1 distance', '0');
    expect(box().style.shadows[0]).toMatchObject({ x: 0, y: 0, angle: 45 });
    await edit('Shadow 1 distance', '10');
    expect(box().style.shadows[0].angle).toBeUndefined();
    undo();
    await tick();
    expect(box().style.shadows[0]).toMatchObject({ x: 0, y: 0, angle: 45 });
    expect(view.getByLabelText('Shadow 1 angle').value).toBe('45');
    // Saved and read back: the angle is in the file.
    const saved = normalizeStyle(JSON.parse(JSON.stringify(box().style)));
    expect(saved.shadows[0].angle).toBe(45);
    redo();
    await tick();
    const s0 = box().style.shadows[0];
    expect(Math.round((Math.atan2(s0.y, -s0.x) * 180) / Math.PI)).toBe(45);
  });

  it('keeps an inner shadow angle typed at Distance 0', async () => {
    const sh = { ...newInnerShadow({ angle: 120 }), useGlobalLight: false, x: 0, y: 0 };
    const { view, box } = mounted({ innerShadows: [sh] }, 'effects', 'shadow');
    await tick();
    await fireEvent.change(view.getByLabelText('Inner shadow 1 angle'), { target: { value: '-30' } });
    expect(box().style.innerShadows[0]).toMatchObject({ x: 0, y: 0, angle: -30 });
    expect(view.getByLabelText('Inner shadow 1 angle').value).toBe('-30');
    await fireEvent.change(view.getByLabelText('Inner shadow 1 distance'), { target: { value: '8' } });
    const s0 = box().style.innerShadows[0];
    expect(Math.round((Math.atan2(s0.y, -s0.x) * 180) / Math.PI)).toBe(-30);
  });

  it('drops the kept angle when the shadow goes on the Global Light', async () => {
    const sh = { ...newShadow({ angle: 120 }), useGlobalLight: false, x: 0, y: 0, angle: 45 };
    const { view, box } = mounted({ shadows: [sh] }, 'effects', 'shadow');
    await tick();
    expect(box().style.shadows[0].angle).toBe(45);
    await fireEvent.click(view.getByLabelText('Shadow 1 uses the global light'));
    expect(box().style.shadows[0].useGlobalLight).toBe(true);
    expect('angle' in box().style.shadows[0]).toBe(false);
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
