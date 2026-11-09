import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// F76: the Layer Styles controls that had no undo assertion. One control each
// from Photoshop's Stroke, an Inner Shadow and a Colour Overlay: every change
// is one history record, and undoing them all puts the style back.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page, settleEdits } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo, peekStack } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle, newStrokeEffect, newInnerShadow, newOverlay } from './data.js';
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

function mounted(sub) {
  const style = normalizeStyle({ ...defaultStyle(), strokeEffects: [newStrokeEffect()], innerShadows: [newInnerShadow()], colorOverlays: [newOverlay()] });
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'HELLO' }], boxes: [{ id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style }] }]);
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.selectedId = 'b';
  setInspectorTab('effects');
  setEffectsSubTab(sub);
  const view = render(Inspector);
  return { view, box: () => page().boxes[0] };
}
// A real edit starts with a pointer or key press, which arms the panel's
// before-snapshot (armSnap), and a pause ends its burst (settleEdits).
async function edit(el, type, value) {
  await fireEvent.pointerDown(el);
  await fireEvent[type](el, { target: { value } });
  settleEdits();
}
async function openFold(view, name) {
  const b = view.container.querySelector(`button.insp-fold[aria-label="${name}"]`);
  if (b && b.getAttribute('aria-expanded') !== 'true') {
    await fireEvent.click(b);
    await tick();
  }
}
const records = () => peekStack().undo.length;
const fx = (b) => JSON.parse(JSON.stringify({ s: b.style.strokeEffects, i: b.style.innerShadows, o: b.style.colorOverlays }));

describe('Layer Styles controls and undo', () => {
  it('records one step per change in Stroke, Inner Shadow and an overlay, and undoes each', async () => {
    const { view, box } = mounted('stroke');
    await tick();
    const start = fx(box());
    const base = records();

    await edit(view.getByLabelText('Photoshop stroke 1 size'), 'change', '9');
    expect(box().style.strokeEffects[0].size).toBe(9);
    expect(records()).toBe(base + 1);
    const afterStroke = fx(box());

    setEffectsSubTab('shadow');
    await tick();
    await edit(view.getByLabelText('Inner shadow 1 size'), 'change', '13');
    expect(box().style.innerShadows[0].size).toBe(13);
    expect(records()).toBe(base + 2);
    const afterShadow = fx(box());

    setEffectsSubTab('fill');
    setInspectorTab('fill');
    await tick();
    await openFold(view, 'Overlays');
    await edit(view.getByLabelText('Overlay 1 opacity'), 'change', '33');
    expect(box().style.colorOverlays[0].opacity).toBeCloseTo(0.33, 5);
    expect(records()).toBe(base + 3);

    undo();
    expect(fx(box())).toEqual(afterShadow);
    undo();
    expect(fx(box())).toEqual(afterStroke);
    undo();
    expect(fx(box())).toEqual(start);
  });
});
