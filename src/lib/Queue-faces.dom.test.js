import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

// Bold and Italic on words selected in a queue line's English field, in a
// typeset chapter: the press goes on from the field to the window, where the
// shortcut registry runs it (App.svelte), on the line's words. The face is a
// step of the field's own undo, and a line a locked box shows is refused.
import Queue from './Queue.svelte';
import { app, loadProjectPages, page, settleEdits } from './store.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { registerShortcutHandlers, dispatchShortcut, setMacKeyboard, isMacKeyboard } from './shortcuts.svelte.js';
import { editorActionHandlers } from './editor-actions.js';
import { clearLineSel } from './typing-selection.svelte.js';
import { defaultStyle, normalizeStyle } from './data.js';

let unregister, mac;
const onWindowKey = (e) => dispatchShortcut(e, { typing: true });
const key = (el, k, more = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, metaKey: true, bubbles: true, cancelable: true, ...more }));

function load(mode, boxOver = {}) {
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.chapterMode = mode;
  loadProjectPages([{
    id: 1, w: 800, h: 1200,
    boxes: [{ id: 'b', lineN: 2, text: null, x: 10, y: 10, w: 300, h: 80, style: normalizeStyle({ ...defaultStyle() }), ...boxOver }],
    lines: [{ n: 1, en: 'alpha' }, { n: 2, en: 'one two three' }],
  }]);
  page().activeLineN = 2;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
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
  clearLineSel();
  settleEdits();
  resetHistory();
  app.chapterRef = null;
  loadProjectPages([]);
  setMacKeyboard(mac);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function field() {
  const view = render(Queue);
  await tick();
  const el = view.getByPlaceholderText('English…');
  el.focus();
  el.setSelectionRange(4, 7);
  await fireEvent.select(el);
  return el;
}
const line = () => page().lines.find((l) => l.n === 2);

describe('face commands in the queue\'s English field', () => {
  it('bold the selected words of the line, and the field\'s Cmd+Z takes it back first', async () => {
    load('typeset');
    const el = await field();
    key(el, 'b');
    settleEdits();
    await tick();
    expect(line().runs).toEqual([{ start: 4, end: 7, bold: true }]);
    key(el, 'z');
    settleEdits();
    await tick();
    expect(line().runs ?? null).toBe(null);
    expect(line().en).toBe('one two three');
    expect([el.selectionStart, el.selectionEnd]).toEqual([4, 7]);
  });

  it('are pruned against the face of the box showing the line', async () => {
    load('typeset', { style: normalizeStyle({ ...defaultStyle(), bold: true }) });
    const el = await field();
    key(el, 'b');
    settleEdits();
    expect(line().runs).toEqual([{ start: 4, end: 7, bold: false }]);
    key(el, 'b');
    settleEdits();
    expect(line().runs ?? null).toBe(null);
  });

  it('are refused, writing nothing, when a box showing the line is locked', async () => {
    load('typeset', { locked: true });
    const el = await field();
    key(el, 'b');
    settleEdits();
    expect(line().runs ?? null).toBe(null);
    expect(app.toast?.msg).toBe('This box is locked - unlock it first');
  });

  it('the field\'s Cmd+Z over a face is refused once a box showing the line is locked', async () => {
    load('typeset');
    const el = await field();
    key(el, 'b');
    settleEdits();
    await tick();
    expect(line().runs).toEqual([{ start: 4, end: 7, bold: true }]);
    page().boxes[0].locked = true;
    key(el, 'z');
    settleEdits();
    expect(line().runs).toEqual([{ start: 4, end: 7, bold: true }]);
    expect(app.toast?.msg).toBe('This box is locked - unlock it first');
    // Unlocked again, the same Cmd+Z takes it back: the field did not step.
    page().boxes[0].locked = false;
    key(el, 'z');
    settleEdits();
    expect(line().runs ?? null).toBe(null);
  });

  it('do nothing in a translate chapter, and nothing once the field lets go', async () => {
    load('translate');
    let el = await field();
    key(el, 'b');
    settleEdits();
    expect(line().runs ?? null).toBe(null);
    cleanup();
    load('typeset');
    el = await field();
    await fireEvent.blur(el);
    key(el, 'b');
    settleEdits();
    expect(line().runs ?? null).toBe(null);
  });
});
