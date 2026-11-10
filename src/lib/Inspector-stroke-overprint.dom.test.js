import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The Photoshop stroke's Overprint checkbox (Effects > Stroke). Reference:
// PhotoCraft's dialog test `stroke_overprint_survives_the_dialog`
// (crates/ui-egui/src/dialogs/layer_style/tests.rs): ticking it stores it,
// and editing another setting keeps it. Ours also holds that each change is
// one history record, that unticking leaves no key (old files stay as they
// were), and that undo puts each step back.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page, settleEdits } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo, peekStack } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle, newStrokeEffect } from './data.js';
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
beforeEach(() => {
  initHistory();
  resetHistory();
});
afterEach(() => {
  cleanup();
  app.selectedId = null;
  loadProjectPages([]);
});

function mounted() {
  const style = normalizeStyle({ ...defaultStyle(), strokeEffects: [newStrokeEffect()] });
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'HELLO' }], boxes: [{ id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style }] }]);
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.selectedId = 'b';
  setInspectorTab('effects');
  setEffectsSubTab('stroke');
  const view = render(Inspector);
  return { view, stroke: () => page().boxes[0].style.strokeEffects[0] };
}
const records = () => peekStack().undo.length;
async function click(el) {
  await fireEvent.pointerDown(el);
  await fireEvent.click(el);
  settleEdits();
  await tick();
}

describe('Photoshop stroke Overprint', () => {
  it('stores Overprint on, keeps it through another edit, drops the key when off, and undoes each step', async () => {
    const { view, stroke } = mounted();
    await tick();
    await openFxFolds(view);
    const box = view.getByLabelText('Stroke 1 overprint');
    expect(box.checked).toBe(false);
    expect('overprint' in stroke()).toBe(false);
    const base = records();

    await click(box);
    expect(stroke().overprint).toBe(true);
    expect(view.getByLabelText('Stroke 1 overprint').checked).toBe(true);
    expect(records()).toBe(base + 1);

    // Editing another setting keeps Overprint.
    const size = view.getByLabelText('Stroke 1 size, page px');
    await fireEvent.pointerDown(size);
    await fireEvent.change(size, { target: { value: '7' } });
    settleEdits();
    await tick();
    expect(stroke().size).toBe(7);
    expect(stroke().overprint).toBe(true);
    expect(records()).toBe(base + 2);

    await click(view.getByLabelText('Stroke 1 overprint'));
    expect('overprint' in stroke()).toBe(false);
    expect(view.getByLabelText('Stroke 1 overprint').checked).toBe(false);
    expect(records()).toBe(base + 3);

    undo();
    await tick();
    expect(stroke().overprint).toBe(true);
    expect(stroke().size).toBe(7);
    undo();
    await tick();
    expect(stroke().overprint).toBe(true);
    expect(stroke().size).toBe(3);
    undo();
    await tick();
    expect('overprint' in stroke()).toBe(false);
    expect(view.getByLabelText('Stroke 1 overprint').checked).toBe(false);
  });
});
