import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import FaceMenu, { openFaceMenu } from './FaceMenu.svelte';
import { app, loadProjectPages, selectBox, deselect } from '../store.svelte.js';
import { initHistory, resetHistory, undo } from './history.svelte.js';
import { registerShortcutHandlers, setMacKeyboard, isMacKeyboard } from '../shortcuts.svelte.js';
import { editorActionHandlers } from '../editor-actions.js';
import { setTypingSel, clearTypingSel, onEditAway } from '../typing-selection.svelte.js';
import { defaultStyle } from '../data.js';
import { textCheck } from '../runs.js';

// The right-click menu on selected words: what it offers and shows, that its
// items are the registry's commands, and that the focus goes back to the text.

// The box is regular, so a run names only what differs from it (runs.js).
const B = (start, end) => ({ start, end, bold: true });
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
  text.setAttribute('contenteditable', 'true');
  text.tabIndex = 0;
  text.textContent = 'one two three';
  document.body.append(text);
  text.focus();
  getSelection().setBaseAndExtent(text.firstChild, a, text.firstChild, f);
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
  it('offers Cut and Copy, then the four commands with their keys, Bold mixed over a half-bold range', async () => {
    const { menu, item } = await opened(0, 7);
    expect([...menu.querySelectorAll('.fm-label')].map((n) => n.textContent)).toEqual(['Cut', 'Copy', 'Bold', 'Italic', 'Typeface…', 'Clear typeface']);
    expect(menu.querySelectorAll('.fm-sep').length).toBe(1);
    expect(item('Cut').querySelector('.fm-key').textContent).toBe('⌘X');
    expect(item('Copy').querySelector('.fm-key').textContent).toBe('⌘C');
    expect(item('Bold').getAttribute('aria-checked')).toBe('mixed');
    expect(item('Italic').getAttribute('aria-checked')).toBe('false');
    expect(item('Bold').querySelector('.fm-key').textContent).toBe('⌘B');
    expect(item('Italic').querySelector('.fm-key').textContent).toBe('⌘I');
    // The first item has the focus, for the keys.
    expect(document.activeElement).toBe(item('Cut'));
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

  it('gives the words their selection back with the focus, which WebKit would put at the start', async () => {
    const { menu, text } = await opened(4, 7);
    // What WebKit does to the editable's selection while a menu item has the focus.
    getSelection().collapse(text.firstChild, 0);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
    const s = getSelection();
    expect([s.anchorOffset, s.focusOffset]).toEqual([4, 7]);
    expect(s.anchorNode === text.firstChild).toBe(true);
  });

  it('goes with the selection', async () => {
    const { view } = await opened(4, 7);
    clearTypingSel();
    await tick();
    expect(view.container.querySelector('.face-menu')).toBe(null);
  });

  it('Cut and Copy give the words back, then run the browser\'s own command on them', async () => {
    const { item, text } = await opened(4, 7);
    const was = document.execCommand;
    const seen = [];
    document.execCommand = (kind) => {
      const s = getSelection();
      seen.push([kind, document.activeElement === text, s.anchorOffset, s.focusOffset]);
      return true;
    };
    try {
      item('Copy').click();
      await tick();
      expect(seen).toEqual([['copy', true, 4, 7]]);
    } finally {
      document.execCommand = was;
    }
  });

  it('closed with nowhere to give the focus back, ends the edit', async () => {
    vi.useFakeTimers();
    const away = vi.fn();
    const off = onEditAway(away);
    try {
      const { view } = await opened(4, 7);
      window.dispatchEvent(new Event('resize'));
      await tick();
      expect(view.container.querySelector('.face-menu')).toBe(null);
      vi.runAllTimers();
      expect(away).toHaveBeenCalledTimes(1);
    } finally {
      off();
      vi.useRealTimers();
    }
  });
});
