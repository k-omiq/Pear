import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// Effects ▸ Paint ▸ Mask and Fade: the "Moves with box" switch (review round,
// 2026-11-11). Off by default (pinned to the page); a flip converts the
// shapes and is one undo step.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo, peekStack } from './editor/history.svelte.js';
import { engineSwitch } from './engine-switch.svelte.js';
import { glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

const before = glyphPainter();
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
  setGlyphPainter(before);
  setEffectsSubTab('stroke');
});

const RECT = { kind: 'poly', op: 'hide', pts: [[110, 110], [150, 110], [150, 150], [110, 150]] };
function mounted(sub) {
  const style = normalizeStyle(defaultStyle());
  const box = { id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style, mask: { on: true, shapes: [RECT] }, fade: { on: true, shapes: [{ kind: 'poly', strength: 50, soft: 0, pts: RECT.pts }] } };
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'HELLO' }], boxes: [box] }]);
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.selectedId = 'b';
  setGlyphPainter({ ...before, box: true, special: true });
  engineSwitch.painting = true;
  setInspectorTab('effects');
  setEffectsSubTab(sub);
  return { view: render(Inspector), box: () => page().boxes[0] };
}
const records = () => peekStack().undo.length;

describe('Moves with box', () => {
  it.each([['mask', 'Mask'], ['fade', 'Fade']])('%s: off by default; a flip stores the shapes box-local, one undo step', async (key, label) => {
    const { view, box } = mounted(key);
    await tick();
    const sw = view.getByRole('switch', { name: `${label} moves with box` });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    const base = records();
    await fireEvent.click(sw);
    await tick();
    expect(box()[key].follow).toBe(true);
    expect(box()[key].shapes[0].pts[0]).toEqual([10, 10]);
    expect(records()).toBe(base + 1);
    expect(view.getByRole('switch', { name: `${label} moves with box` }).getAttribute('aria-checked')).toBe('true');
    undo();
    await tick();
    expect(box()[key].follow).toBeUndefined();
    expect(box()[key].shapes[0].pts[0]).toEqual([110, 110]);
  });
});
