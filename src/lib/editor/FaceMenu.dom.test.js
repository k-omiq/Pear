import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import FaceMenu, { openFaceMenu } from './FaceMenu.svelte';
import { app, loadProjectPages, selectBox, deselect } from '../store.svelte.js';
import { initHistory, resetHistory, undo } from './history.svelte.js';
import { registerShortcutHandlers, setMacKeyboard, isMacKeyboard } from '../shortcuts.svelte.js';
import { editorActionHandlers } from '../editor-actions.js';
import { setTypingSel, clearTypingSel } from '../typing-selection.svelte.js';
import { defaultStyle } from '../data.js';
import { textCheck } from '../runs.js';

// The right-click menu on selected words: what it offers and shows, that its
// items are the registry's commands, and that the focus goes back to the text.

const B = (start, end) => ({ start, end, bold: true, italic: false });
let unregister;
let mac;
beforeEach(() => {
  mac = isMacKeyboard();
  setMacKeyboard(true);
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.chapterMode = 'typeset';
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [{ id: 'b', lineN: null, text: 'one two three', runs: [B(4, 7)], runsCheck: textCheck('one two three'), x: 10, y: 10, w: 300, h: 80, style: { ...defaultStyle(), size: 20 } }] }]);
  initHistory();
  resetHistory();
  unregister = registerShortcutHandlers(editorActionHandlers());
  selectBox('b');
  app.editingId = 'b';
});
afterEach(() => {
  cleanup();
  unregister?.();
  clearTypingSel();
  app.editingId = null;
  deselect();
  resetHistory();
  app.chapterRef = null;
  loadProjectPages([]);
  setMacKeyboard(mac);
  document.body.innerHTML = '';
});

async function opened(a, f) {
  // The text the focus goes back to.
  const text = document.createElement('div');
  text.contentEditable = 'true';
  text.tabIndex = 0;
  document.body.append(text);
  text.focus();
  const view = render(FaceMenu);
  setTypingSel('b', 'one two three', a, f);
  openFaceMenu(40, 50);
  await tick();
  await tick();
  const menu = view.container.querySelector('.face-menu');
  const item = (label) => [...menu.querySelectorAll('button')].find((b) => b.querySelector('.fm-label').textContent === label);
  return { view, menu, item, text };
}

describe('the menu of the selected words\' faces', () => {
  it('offers the four commands with their keys, Bold mixed over a half-bold range', async () => {
    const { menu, item } = await opened(0, 7);
    expect([...menu.querySelectorAll('.fm-label')].map((n) => n.textContent)).toEqual(['Bold', 'Italic', 'Typeface…', 'Clear typeface']);
    expect(item('Bold').getAttribute('aria-checked')).toBe('mixed');
    expect(item('Italic').getAttribute('aria-checked')).toBe('false');
    expect(item('Bold').querySelector('.fm-key').textContent).toBe('⌘B');
    expect(item('Italic').querySelector('.fm-key').textContent).toBe('⌘I');
    // The first item has the focus, for the keys.
    expect(document.activeElement).toBe(item('Bold'));
  });

  it('runs the command on the range, closes, gives the focus back to the text, one undo step', async () => {
    const { view, item, text } = await opened(0, 7);
    item('Bold').click();
    await tick();
    expect(app.pages[0].boxes[0].runs).toEqual([B(0, 7)]);
    expect(view.container.querySelector('.face-menu')).toBe(null);
    expect(document.activeElement).toBe(text);
    undo();
    expect(app.pages[0].boxes[0].runs).toEqual([B(4, 7)]);
  });

  it('closes on Escape, changing nothing, and the focus goes back to the text', async () => {
    const { view, menu, text } = await opened(4, 7);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
    expect(view.container.querySelector('.face-menu')).toBe(null);
    expect(document.activeElement).toBe(text);
    expect(app.pages[0].boxes[0].runs).toEqual([B(4, 7)]);
  });

  it('goes with the selection', async () => {
    const { view } = await opened(4, 7);
    clearTypingSel();
    await tick();
    expect(view.container.querySelector('.face-menu')).toBe(null);
  });
});
