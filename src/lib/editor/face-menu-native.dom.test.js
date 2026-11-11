import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, loadProjectPages, selectBox, deselect } from '../store.svelte.js';
import { initHistory, resetHistory } from './history.svelte.js';
import { registerShortcutHandlers, setMacKeyboard, isMacKeyboard } from '../shortcuts.svelte.js';
import { editorActionHandlers } from '../editor-actions.js';
import { setTypingSel, clearTypingSel, onEditAway } from '../typing-selection.svelte.js';
import { defaultStyle } from '../data.js';
import { textCheck } from '../runs.js';

// The system's popup on selected words in the desktop app: what it is made of
// on each system, that a face item runs the command, and that the words keep
// their selection, or the edit ends, however it closes. The Tauri menu API is
// stood in for: each `new` records what it was asked for, and `popup` runs
// whatever the test makes the user do while it is open.

const made = [];
let during = null;
const item = (kind) => async (opts) => {
  const it = { kind, ...opts };
  made.push(it);
  return it;
};
vi.mock('@tauri-apps/api/menu', () => ({
  MenuItem: { new: item('item') },
  CheckMenuItem: { new: item('check') },
  PredefinedMenuItem: { new: item('predefined') },
  Menu: {
    new: async ({ items }) => ({ items, close: async () => {}, popup: async () => during?.(items) }),
  },
}));

const { popFaceMenu } = await import('./face-menu-native.js');

let unregister, mac, agent, text;
const as = (ua) => agent.mockReturnValue(ua);
beforeEach(() => {
  made.length = 0;
  during = null;
  mac = isMacKeyboard();
  setMacKeyboard(true);
  agent = vi.spyOn(navigator, 'userAgent', 'get');
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.chapterMode = 'typeset';
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [{ id: 'b', lineN: null, text: 'one two three', runs: null, runsCheck: textCheck('one two three'), x: 10, y: 10, w: 300, h: 80, style: { ...defaultStyle(), size: 20 } }] }]);
  initHistory();
  resetHistory();
  unregister = registerShortcutHandlers(editorActionHandlers());
  selectBox('b');
  app.editingId = 'b';
  text = document.createElement('div');
  text.className = 'txt editable';
  text.setAttribute('contenteditable', 'true');
  text.textContent = 'one two three';
  document.body.append(text);
  text.focus();
  getSelection().setBaseAndExtent(text.firstChild, 4, text.firstChild, 7);
  setTypingSel('b', 'one two three', 4, 7);
});
afterEach(() => {
  unregister?.();
  agent.mockRestore();
  clearTypingSel();
  app.editingId = null;
  deselect();
  resetHistory();
  app.chapterRef = null;
  loadProjectPages([]);
  setMacKeyboard(mac);
  document.body.innerHTML = '';
});

const labels = (items) => items.map((i) => (i.kind === 'predefined' ? `[${i.item}]` : i.text));

describe('the system popup on selected words', () => {
  it('on macOS and Windows: the system\'s Cut, Copy and Paste, then the face commands with their keys', async () => {
    for (const ua of ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)']) {
      as(ua);
      let items;
      during = (it) => (items = it);
      await popFaceMenu();
      expect(labels(items)).toEqual(['[Cut]', '[Copy]', '[Paste]', '[Separator]', 'Bold', 'Italic', 'Typeface…', 'Clear typeface']);
      const bold = items.find((i) => i.text === 'Bold');
      expect(bold).toMatchObject({ kind: 'check', checked: false, accelerator: 'CmdOrCtrl+B', enabled: true });
      expect(items.find((i) => i.text === 'Italic').accelerator).toBe('CmdOrCtrl+I');
    }
  });

  it('on Linux, where the system\'s items do nothing: Cut and Copy of its own, and no Paste', async () => {
    as('Mozilla/5.0 (X11; Linux x86_64)');
    let items;
    during = (it) => (items = it);
    await popFaceMenu();
    expect(labels(items)).toEqual(['Cut', 'Copy', '[Separator]', 'Bold', 'Italic', 'Typeface…', 'Clear typeface']);
    // Chosen after the popup moved the focus away: the words come back first,
    // then the browser's own copy runs on them.
    const seen = [];
    const was = document.execCommand;
    document.execCommand = (kind) => {
      const s = getSelection();
      seen.push([kind, document.activeElement === text, s.anchorOffset, s.focusOffset]);
      return true;
    };
    try {
      document.body.focus();
      getSelection().collapse(text.firstChild, 0);
      items.find((i) => i.text === 'Copy').action();
      expect(seen).toEqual([['copy', true, 4, 7]]);
    } finally {
      document.execCommand = was;
    }
  });

  it('a face item runs the command on the words, and the selection is there after', async () => {
    as('Mozilla/5.0 (Macintosh)');
    during = (items) => {
      // What the system does with the focus while its menu is up.
      text.blur();
      items.find((i) => i.text === 'Bold').action();
    };
    await popFaceMenu();
    expect(app.pages[0].boxes[0].runs).toEqual([{ start: 4, end: 7, bold: true }]);
    expect(document.activeElement).toBe(text);
    const s = getSelection();
    expect([s.anchorOffset, s.focusOffset]).toEqual([4, 7]);
  });

  it('closed with nothing chosen: the words keep their selection and the edit goes on', async () => {
    as('Mozilla/5.0 (Macintosh)');
    const away = vi.fn();
    const off = onEditAway(away);
    during = () => {
      text.blur();
      getSelection().collapse(text.firstChild, 0);
    };
    try {
      await popFaceMenu();
      expect(document.activeElement).toBe(text);
      const s = getSelection();
      expect([s.anchorOffset, s.focusOffset]).toEqual([4, 7]);
      expect(away).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('with no words selected, makes no menu (the system\'s own shows)', async () => {
    clearTypingSel();
    expect(await popFaceMenu()).toBe(false);
    expect(made).toEqual([]);
  });
});
