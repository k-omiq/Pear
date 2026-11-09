import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// A multi effect's instances (Drop Shadow, Inner Shadow, Colour Overlay,
// Gradient Overlay, Photoshop Stroke): each its own switch, moved up and
// down, duplicated, at most FX_INSTANCES_MAX of a kind, every change one
// undo step. And the Advanced Blending controls past Channels: Knockout,
// Blend Clipped Layers as Group, Transparency Shapes Layer and Vector Mask
// Hides Effects.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo, redo } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle, newShadow, normalizeOverlay, newStrokeEffect, FX_INSTANCES_MAX } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';
import { settleEdits } from './store.svelte.js';
import { engineSwitch } from './engine-switch.svelte.js';
import { glyphPainter, setGlyphPainter } from './text-engine/index.js';

const painter = glyphPainter();

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
  engineSwitch.painting = false;
  setGlyphPainter(painter);
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

// A click as a person makes it: the panel arms its undo snapshot on the
// pointerdown, before the control writes.
async function press(el) {
  await fireEvent.pointerDown(el);
  await fireEvent.click(el);
  settleEdits();
  await tick();
}
async function tickBox(el, on) {
  await fireEvent.pointerDown(el);
  el.checked = on;
  await fireEvent.change(el);
  settleEdits();
  await tick();
}

async function openFold(view, name) {
  const b = view.container.querySelector(`button.insp-fold[aria-label="${name}"]`);
  if (b && b.getAttribute('aria-expanded') !== 'true') {
    await fireEvent.click(b);
    await tick();
  }
}

const shadow = (color) => ({ ...newShadow({ angle: 120 }), color });

describe('multi effect instances', () => {
  it('switches a shadow off and back as undo steps, storing on only when off', async () => {
    const { view, box } = mounted({ shadows: [shadow('#ff0000'), shadow('#00ff00')] }, 'effects', 'shadow');
    await tick();
    const on = view.getByLabelText('Shadow 2 on');
    expect(on.checked).toBe(true);
    await tickBox(on, false);
    expect(box().style.shadows[1].on).toBe(false);
    expect('on' in box().style.shadows[0]).toBe(false);
    undo();
    expect('on' in box().style.shadows[1]).toBe(false);
    redo();
    expect(box().style.shadows[1].on).toBe(false);
    await tick();
    await tickBox(view.getByLabelText('Shadow 2 on'), true);
    expect('on' in box().style.shadows[1]).toBe(false);
  });

  it('moves an overlay up and down, first on top, and undoes the move', async () => {
    const { view, box } = mounted({ colorOverlays: [normalizeOverlay({ color: '#ff0000' }), normalizeOverlay({ color: '#0000ff' })] }, 'fill');
    await tick();
    await openFold(view, 'Overlays');
    const colours = () => box().style.colorOverlays.map((o) => o.color);
    expect(view.getByLabelText('Move Overlay 1 up').disabled).toBe(true);
    expect(view.getByLabelText('Move Overlay 2 down').disabled).toBe(true);
    await press(view.getByLabelText('Move Overlay 2 up'));
    expect(colours()).toEqual(['#0000ff', '#ff0000']);
    undo();
    expect(colours()).toEqual(['#ff0000', '#0000ff']);
    await tick();
    await press(view.getByLabelText('Move Overlay 1 down'));
    expect(colours()).toEqual(['#0000ff', '#ff0000']);
  });

  it('duplicates a stroke in place, a copy and not the same object, up to the cap', async () => {
    const k = { ...newStrokeEffect(), size: 7, color: '#123456' };
    const { view, box } = mounted({ strokeEffects: [k] }, 'effects', 'stroke');
    await tick();
    await press(view.getByLabelText('Duplicate Photoshop stroke 1'));
    const list = box().style.strokeEffects;
    expect(list.length).toBe(2);
    expect(list[0]).toEqual(list[1]);
    expect(list[0]).not.toBe(list[1]);
    undo();
    expect(box().style.strokeEffects.length).toBe(1);
    // At the cap the duplicate and the Add are off.
    box().style.strokeEffects = Array.from({ length: FX_INSTANCES_MAX }, () => ({ ...k }));
    await tick();
    expect(view.getByLabelText('Duplicate Photoshop stroke 1').disabled).toBe(true);
    expect(view.getByRole('button', { name: /Add Photoshop stroke/ }).disabled).toBe(true);
    await press(view.getByLabelText('Duplicate Photoshop stroke 1'));
    expect(box().style.strokeEffects.length).toBe(FX_INSTANCES_MAX);
  });
});

describe('Advanced Blending: Knockout and the switches', () => {
  // The Blending Options group is the Rust engine's.
  beforeEach(() => {
    setGlyphPainter({ ...painter, box: true });
    engineSwitch.painting = true;
  });

  it('offers Blend Interior Effects as Group only for an interior effect that is switched on', async () => {
    const { view, box } = mounted({ colorOverlays: [normalizeOverlay({ on: false })], gradientOverlays: [] }, 'fill');
    await tick();
    await openFold(view, 'Advanced blending');
    const group = () => view.getByLabelText('Blend interior effects as group');
    expect(group().disabled).toBe(true);
    delete box().style.colorOverlays[0].on;
    await tick();
    expect(group().disabled).toBe(false);
  });

  it('sets Knockout as an undo step', async () => {
    const { view, box } = mounted({}, 'fill');
    await tick();
    await openFold(view, 'Advanced blending');
    const sel = view.getByRole('combobox', { name: 'Knockout' });
    await fireEvent.pointerDown(sel);
    await fireEvent.change(sel, { target: { value: 'deep' } });
    settleEdits();
    expect(box().style.blending.knockout).toBe('deep');
    undo();
    expect(box().style.blending.knockout).toBe('none');
  });

  it('stores each switch only off its default, and undoes it', async () => {
    const { view, box } = mounted({}, 'fill');
    await tick();
    await openFold(view, 'Advanced blending');
    const ts = view.getByLabelText('Transparency shapes layer');
    const clip = view.getByLabelText('Blend clipped layers as group');
    expect([ts.checked, clip.checked]).toEqual([true, true]);
    // The data key stays off its default; no control drives it any more.
    expect('vectorMaskHidesEffects' in box().style.blending).toBe(false);
    await tickBox(ts, false);
    expect(box().style.blending.transparencyShapes).toBe(false);
    await tickBox(clip, false);
    expect(box().style.blending.blendClipped).toBe(false);
    undo();
    expect('blendClipped' in box().style.blending).toBe(false);
    await tick();
    await tickBox(view.getByLabelText('Transparency shapes layer'), true);
    expect('transparencyShapes' in box().style.blending).toBe(false);
  });
});
