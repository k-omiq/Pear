import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// A face command while typing in a box, then Cmd+Z, both through the keys as
// the app hears them: the press lands on the box's editable, which takes
// Cmd+Z for its own undo (`onEditKey`), and goes on to the window, where the
// shortcut registry runs Mod+B (App.svelte). The face is a step of the
// field's undo of its own, so Cmd+Z takes it back before any typing, and the
// words stay as they are.
import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, beginEdit, setZoom, settleEdits } from './store.svelte.js';
import { registerShortcutHandlers, dispatchShortcut, setMacKeyboard, isMacKeyboard } from './shortcuts.svelte.js';
import { editorActionHandlers } from './editor-actions.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { setTypingSel, clearTypingSel } from './typing-selection.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

class FakeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const typeset = typesetEnabled();
let restoreCanvas, unregister, mac;
const onWindowKey = (e) => dispatchShortcut(e, { typing: true });
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
  setTypesetEnabled(true);
  clearLayoutMemo();
});
afterAll(() => {
  restoreCanvas();
  setTypesetEnabled(typeset);
  clearLayoutMemo();
});
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.stubGlobal('ResizeObserver', FakeObserver);
  mac = isMacKeyboard();
  setMacKeyboard(true);
  initHistory();
  resetHistory();
  unregister = registerShortcutHandlers(editorActionHandlers());
  window.addEventListener('keydown', onWindowKey);
});
afterEach(() => {
  cleanup();
  window.removeEventListener('keydown', onWindowKey);
  unregister?.();
  clearTypingSel();
  app.editingId = null;
  app.selectedId = null;
  app.chapterRef = null;
  setZoom(1);
  loadProjectPages([]);
  setMacKeyboard(mac);
  vi.unstubAllGlobals();
});

const key = (el, k, more = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, metaKey: true, bubbles: true, cancelable: true, ...more }));

describe('Cmd+Z right after a face command, while typing in a box', () => {
  it('takes the face back, then puts it on again with Shift+Cmd+Z; the words stay', async () => {
    loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: [{ id: 'b', lineN: null, text: 'one two three', x: 100, y: 200, w: 400, h: 90, style: normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30 }) }] }]);
    app.chapterRef = { projectId: 'p', chapterId: 'c' };
    app.chapterMode = 'typeset';
    setZoom(1);
    const pg = page();
    const view = render(TextBox, { box: pg.boxes[0], pageFrameEl: document.createElement('div'), pg });
    await tick();
    beginEdit('b');
    await tick();
    await tick();
    const ed = view.container.querySelector('.txt.editable');
    expect(ed).not.toBe(null);
    ed.focus();
    setTypingSel('b', 'one two three', 4, 7);
    key(ed, 'b');
    settleEdits();
    await tick();
    expect(page().boxes[0].runs).toEqual([{ start: 4, end: 7, bold: true }]);
    key(ed, 'z');
    await tick();
    expect(page().boxes[0].runs ?? null).toBe(null);
    expect(page().boxes[0].text).toBe('one two three');
    expect(app.editingId).toBe('b');
    key(ed, 'z', { shiftKey: true });
    await tick();
    expect(page().boxes[0].runs).toEqual([{ start: 4, end: 7, bold: true }]);
  });
});
