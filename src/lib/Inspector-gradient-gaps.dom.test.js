import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The effect gradient editor (review Gaps table, F87): opacity stops apart
// from the colour stops, a midpoint diamond between each two, Smoothness, the
// Interpolation Method and Dither, each an undo step.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page, settleEdits } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo, redo } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle, newGradientOverlay } from './data.js';
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
  const view = render(Inspector);
  return { view, g: () => page().boxes[0].style.gradientOverlays[0].gradient };
}

async function openFold(view, name) {
  const b = view.container.querySelector(`button.insp-fold[aria-label="${name}"]`);
  if (b && b.getAttribute('aria-expanded') !== 'true') {
    await fireEvent.click(b);
    await tick();
  }
}

const T = 'Tint gradient';
// A real edit starts with a press, which arms the panel's before-snapshot,
// and a pause ends its burst.
async function edit(el, value) {
  await fireEvent.pointerDown(el);
  await fireEvent.change(el, { target: { value } });
  settleEdits();
}
async function press(el) {
  await fireEvent.pointerDown(el);
  await fireEvent.pointerUp(el);
  settleEdits();
  await tick();
}
const overlay = () => ({ gradientOverlays: [{ ...newGradientOverlay(), gradient: { stops: [{ color: '#000000', pos: 0 }, { color: '#ffffff', pos: 1 }], opacityStops: [{ opacity: 1, pos: 0 }, { opacity: 0, pos: 1 }] } }] });

describe('the effect gradient editor', () => {
  it('has a rail of opacity stops and a rail of colour stops, a midpoint between each two', async () => {
    const { view } = mounted(overlay());
    await tick();
    await openFold(view, 'Pattern');
    expect(view.getAllByRole('button', { name: new RegExp(`^${T} colour stop`) })).toHaveLength(2);
    expect(view.getAllByRole('button', { name: new RegExp(`^${T} opacity stop`) })).toHaveLength(2);
    expect(view.getByRole('button', { name: `${T} colour midpoint 1 at 50 percent` })).toBeTruthy();
    expect(view.getByRole('button', { name: `${T} opacity midpoint 1 at 50 percent` })).toBeTruthy();
  });

  it('moves a colour midpoint as one undo step, and leaves an even one out', async () => {
    const { view, g } = mounted(overlay());
    await tick();
    await openFold(view, 'Pattern');
    await press(view.getByRole('button', { name: `${T} colour midpoint 1 at 50 percent` }));
    await edit(view.getByLabelText(`${T} midpoint, percent`), '25');
    expect(g().stops[1].mid).toBe(0.25);
    expect(view.getByRole('button', { name: `${T} colour midpoint 1 at 25 percent` })).toBeTruthy();
    // Held to Photoshop's 5 to 95 %.
    await edit(view.getByLabelText(`${T} midpoint, percent`), '2');
    expect(g().stops[1].mid).toBe(0.05);
    undo();
    expect(g().stops[1].mid).toBe(0.25);
    undo();
    expect('mid' in g().stops[1]).toBe(false);
    redo();
    expect(g().stops[1].mid).toBe(0.25);
  });

  it('sets an opacity stop apart from the colour stops, and the arrow keys move a midpoint', async () => {
    const { view, g } = mounted(overlay());
    await tick();
    await openFold(view, 'Pattern');
    const second = view.getByRole('button', { name: `${T} opacity stop 2 at 100 percent, 0 percent opaque` });
    await press(second);
    await edit(view.getByLabelText(`${T} stop opacity, percent`), '40');
    expect(g().opacityStops[1].opacity).toBe(0.4);
    expect(g().stops.map((s) => s.color)).toEqual(['#000000', '#ffffff']);
    await edit(view.getByLabelText(`${T} stop location, percent`), '70');
    expect(g().opacityStops[1].pos).toBe(0.7);
    expect(g().stops[1].pos).toBe(1);
    undo();
    expect(g().opacityStops[1].pos).toBe(1);
    await tick();
    const mid = view.getByRole('button', { name: `${T} opacity midpoint 1 at 50 percent` });
    await fireEvent.keyDown(mid, { key: 'ArrowRight', shiftKey: true });
    settleEdits();
    expect(g().opacityStops[1].mid).toBe(0.6);
    undo();
    expect('mid' in g().opacityStops[1]).toBe(false);
  });

  it('adds a stop where the rail is clicked, its colour the ramp\'s there, and deletes it down to two', async () => {
    const { view, g } = mounted(overlay());
    await tick();
    await openFold(view, 'Pattern');
    const rail = view.container.querySelector('.fxg-rail.bottom');
    await fireEvent.pointerDown(rail, { clientX: 0 });
    await tick();
    expect(g().stops).toHaveLength(3);
    expect(g().stops[0].color).toBe('#000000');
    await fireEvent.click(view.getByRole('button', { name: `${T} delete stop` }));
    expect(g().stops).toHaveLength(2);
    expect(view.getByRole('button', { name: `${T} delete stop` }).disabled).toBe(true);
  });

  it('sets Smoothness, the Method and Dither, each an undo step', async () => {
    const { view, g } = mounted(overlay());
    await tick();
    await openFold(view, 'Pattern');
    await openFold(view, `${T} more options`);
    await edit(view.getByLabelText(`${T} smoothness, percent`), '60');
    expect(g().smoothness).toBe(0.6);
    await edit(view.getByLabelText(`${T} interpolation method`), 'perceptual');
    expect(g().method).toBe('perceptual');
    await fireEvent.pointerDown(view.getByLabelText(`${T} dither`));
    await fireEvent.click(view.getByLabelText(`${T} dither`));
    settleEdits();
    expect(g().dither).toBe(true);
    undo();
    expect(g().dither).toBe(false);
    undo();
    expect(g().method).toBe('classic');
    undo();
    expect(g().smoothness).toBe(0);
  });

  it('gives a glow\'s gradient Smoothness and a Method, and no Dither box', async () => {
    const { view } = mounted({ ...overlay(), outerGlow: { on: true, fill: 'gradient' } });
    setInspectorTab('effects');
    setEffectsSubTab('glow');
    await tick();
    await openFold(view, 'Outer glow gradient more options');
    expect(view.getByLabelText('Outer glow gradient interpolation method')).toBeTruthy();
    expect(view.getByLabelText('Outer glow gradient smoothness, percent')).toBeTruthy();
    expect(view.getAllByRole('button', { name: /^Outer glow gradient opacity stop/ })).toHaveLength(2);
    expect(view.queryByLabelText('Outer glow gradient dither')).toBeNull();
  });
});
