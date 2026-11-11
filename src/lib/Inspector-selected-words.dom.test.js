import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The Inspector's row for the faces of selected words (C4): it shows for a
// selection in the box or in the Text field, says when the words are mixed,
// and its buttons are the face commands on that range.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page, settleEdits } from './store.svelte.js';
import { setInspectorTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';
import { setTypingSel, clearTypingSel, askFacePick } from './typing-selection.svelte.js';
import { textCheck } from './runs.js';

const B = (start, end) => ({ start, end, bold: true, italic: false });
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
  clearTypingSel();
  app.selectedId = null;
  loadProjectPages([]);
});

function mounted() {
  const text = 'one two three';
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [{ id: 'b', lineN: null, text, runs: [B(4, 7)], runsCheck: textCheck(text), x: 100, y: 100, w: 240, h: 90, style: normalizeStyle({ ...defaultStyle() }) }] }]);
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.selectedId = 'b';
  setInspectorTab('text');
  return render(Inspector);
}
const runs = () => page().boxes[0].runs;

describe('the selected words row', () => {
  it('is there only while words are selected', async () => {
    const view = mounted();
    await tick();
    expect(view.container.querySelector('.sel-face')).toBe(null);
    setTypingSel('b', 'one two three', 0, 0);
    await tick();
    expect(view.container.querySelector('.sel-face')).toBe(null);
    setTypingSel('b', 'one two three', 0, 7);
    await tick();
    expect(view.container.querySelector('.sel-face')).not.toBe(null);
  });

  it('shows mixed, and its buttons set the face of the range, one undo step each', async () => {
    const view = mounted();
    setTypingSel('b', 'one two three', 0, 7);
    await tick();
    const [bold, italic] = view.container.querySelectorAll('.sel-face .seg button');
    expect(bold.classList.contains('mixed')).toBe(true);
    expect(bold.getAttribute('aria-pressed')).toBe('mixed');
    expect(italic.getAttribute('aria-pressed')).toBe('false');
    // A press keeps the focus where the selection is.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    bold.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await fireEvent.click(bold);
    settleEdits();
    await tick();
    expect(runs()).toEqual([B(0, 7)]);
    expect(bold.classList.contains('on')).toBe(true);
    const clear = view.container.querySelector('.sel-face .rbtn');
    await fireEvent.click(clear);
    await tick();
    expect('runs' in page().boxes[0]).toBe(false);
    undo();
    expect(runs()).toEqual([B(0, 7)]);
  });

  it('reads a selection in the Text field', async () => {
    const view = mounted();
    await tick();
    const field = view.container.querySelector('#insp-text');
    field.focus();
    field.setSelectionRange(8, 13);
    await fireEvent.select(field);
    await tick();
    expect(view.container.querySelector('.sel-face')).not.toBe(null);
    await fireEvent.click(view.container.querySelectorAll('.sel-face .seg button')[1]);
    await tick();
    expect(runs()).toEqual([B(4, 7), { start: 8, end: 13, bold: false, italic: true }]);
    // Leaving the field drops it.
    await fireEvent.blur(field);
    await tick();
    expect(view.container.querySelector('.sel-face')).toBe(null);
  });

  it('opens its family picker for "Typeface…", on the range it was asked for', async () => {
    const view = mounted();
    setInspectorTab('fill');
    await tick();
    askFacePick('b', 'one two three', 4, 7);
    await tick();
    await tick();
    await tick();
    expect(view.container.querySelector('.sel-face')).not.toBe(null);
    expect(view.container.querySelector('#insp-sel-font')?.getAttribute('aria-expanded')).toBe('true');
  });
});
