import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The Inspector's one set of face controls (C4): the family, Bold, Italic and
// Clear act on the selected words when there are some, else on the whole box,
// and a label says which. The keys reach them the way they do in the app: a
// press in the Text field goes on to the window, where the shortcut registry
// hears it (App.svelte), and the field's own Cmd+Z takes a face back.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page, settleEdits } from './store.svelte.js';
import { setInspectorTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';
import { setTypingSel, clearTypingSel, askFacePick, typingSel } from './typing-selection.svelte.js';
import { registerShortcutHandlers, dispatchShortcut, setMacKeyboard, isMacKeyboard } from './shortcuts.svelte.js';
import { editorActionHandlers } from './editor-actions.js';
import { textCheck } from './runs.js';
import { setCombo, resetCombo } from './shortcuts.svelte.js';
import { panels, setHidden } from './editor/panels.svelte.js';
import { popFaceMenu } from './editor/face-menu-native.js';
import OptionsPanelHost from '../test/OptionsPanelHost.svelte';

const B = (start, end) => ({ start, end, bold: true });
let restoreCanvas, unregister, mac;
// What App.svelte's window keydown does with a press in a field.
const onWindowKey = (e) => dispatchShortcut(e, { typing: true });
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterAll(() => {
  vi.unstubAllGlobals();
  restoreCanvas();
});
beforeEach(() => {
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
  app.selectedId = null;
  app.editingId = null;
  app.chapterRef = null;
  loadProjectPages([]);
  setMacKeyboard(mac);
});

function mounted(extra = {}) {
  const text = 'one two three';
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [{ id: 'b', lineN: null, text, runs: [B(4, 7)], runsCheck: textCheck(text), x: 100, y: 100, w: 240, h: 90, style: normalizeStyle({ ...defaultStyle(), ...extra }) }] }]);
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.chapterMode = 'typeset';
  app.selectedId = 'b';
  setInspectorTab('text');
  const view = render(Inspector);
  const q = (s) => view.container.querySelector(s);
  const style = () => [...view.container.querySelectorAll('.seg button')].slice(0, 2);
  const scope = () => [...view.container.querySelectorAll('.lbl .scope')].map((n) => n.textContent);
  const clear = () => [...view.container.querySelectorAll('.font-row .rbtn')].find((b) => b.textContent === 'Clear');
  return { view, q, style, scope, clear };
}
const runs = () => page().boxes[0].runs;
const key = (el, k, more = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, metaKey: true, bubbles: true, cancelable: true, ...more }));

describe('the Inspector\'s face controls', () => {
  it('act on the whole box with no words selected, and say so', async () => {
    const { view, style, scope, clear } = mounted();
    await tick();
    expect(scope()).toEqual(['Whole box']);
    // The label speaks for the family, B, I and Clear, and only for them:
    // Uppercase is always the whole box's, and sits elsewhere.
    const scoped = view.container.querySelector('.lbl .scope').closest('.grp');
    expect(style().every((b) => scoped.contains(b))).toBe(true);
    expect(scoped.contains(clear())).toBe(true);
    const tt = [...view.container.querySelectorAll('.seg button')].find((b) => b.textContent === 'TT');
    expect(scoped.contains(tt)).toBe(false);
    expect(tt.closest('.field').querySelector('.scope')).toBe(null);
    const [bold] = style();
    expect(bold.getAttribute('aria-pressed')).toBe('false');
    // The box has a run, so Clear is there for the whole of it.
    expect(clear().disabled).toBe(false);
    await fireEvent.click(bold);
    await tick();
    expect(page().boxes[0].style.bold).toBe(true);
    expect(bold.getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(clear());
    await tick();
    expect(runs() ?? null).toBe(null);
  });

  it('act on the selected words, show mixed, one undo step each; Clear only where the words have runs', async () => {
    const { style, scope, clear } = mounted();
    setTypingSel('b', 'one two three', 8, 13);
    await tick();
    expect(scope()).toEqual(['Selected words']);
    expect(clear().disabled).toBe(true);
    setTypingSel('b', 'one two three', 0, 7);
    await tick();
    const [bold, italic] = style();
    expect(bold.classList.contains('mixed')).toBe(true);
    expect(bold.getAttribute('aria-pressed')).toBe('mixed');
    expect(italic.getAttribute('aria-pressed')).toBe('false');
    expect(clear().disabled).toBe(false);
    // A press keeps the focus where the selection is.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    bold.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await fireEvent.click(bold);
    settleEdits();
    await tick();
    expect(runs()).toEqual([B(0, 7)]);
    expect(page().boxes[0].style.bold).toBe(false);
    expect(bold.getAttribute('aria-pressed')).toBe('true');
    undo();
    expect(runs()).toEqual([B(4, 7)]);
  });

  it('show a face asked for at the caret as on', async () => {
    const { style, scope } = mounted();
    app.editingId = 'b';
    setTypingSel('b', 'one two three', 2, 2);
    await tick();
    expect(scope()[0]).toBe('Next letters');
    await fireEvent.click(style()[1]);
    await tick();
    expect(typingSel.pending?.patch).toEqual({ italic: true });
    expect(style()[1].getAttribute('aria-pressed')).toBe('true');
    // Nothing is written until letters are typed.
    expect(runs()).toEqual([B(4, 7)]);
  });

  it('keep the words while the focus moves into them, and let them go when the words change', async () => {
    const { q, style, scope } = mounted();
    await tick();
    const field = q('#insp-text');
    field.focus();
    field.setSelectionRange(8, 13);
    await fireEvent.select(field);
    await tick();
    expect(scope()[0]).toBe('Selected words');
    // Tab or a click into the controls: the field lets go of its selection.
    style()[1].focus();
    await fireEvent.blur(field, { relatedTarget: style()[1] });
    await tick();
    expect(scope()[0]).toBe('Selected words');
    await fireEvent.click(style()[1]);
    await tick();
    expect(runs()).toEqual([B(4, 7), { start: 8, end: 13, italic: true }]);
    // The words change: the range they named is gone.
    field.value = 'one two three!';
    await fireEvent.input(field);
    await tick();
    expect(scope()[0]).toBe('Whole box');
  });

  // The keys and the buttons read one scope: each press below is made both
  // ways on the same state, and must change the same letters.
  it('a bare caret in the Text field drops the words: the label, B and Mod+B all mean the whole box', async () => {
    const { q, style, scope } = mounted();
    await tick();
    const field = q('#insp-text');
    field.focus();
    field.setSelectionRange(8, 13);
    await fireEvent.select(field);
    await tick();
    expect(scope()[0]).toBe('Selected words');
    // A click to a bare caret.
    field.setSelectionRange(2, 2);
    await fireEvent.mouseUp(field);
    await tick();
    expect(scope()).toEqual(['Whole box']);
    key(field, 'b');
    await tick();
    expect(page().boxes[0].style.bold).toBe(true);
    expect(runs()).toEqual([B(4, 7)]);
    await fireEvent.click(style()[0]);
    await tick();
    expect(page().boxes[0].style.bold).toBe(false);
    expect(runs()).toEqual([B(4, 7)]);
  });

  it('with words selected and the focus moved into the controls, Mod+B and B act on the same words', async () => {
    const { q, style } = mounted();
    await tick();
    const field = q('#insp-text');
    field.focus();
    field.setSelectionRange(8, 13);
    await fireEvent.select(field);
    style()[0].focus();
    await fireEvent.blur(field, { relatedTarget: style()[0] });
    await tick();
    key(style()[0], 'b');
    settleEdits();
    await tick();
    expect(runs()).toEqual([B(4, 7), B(8, 13)]);
    await fireEvent.click(style()[0]);
    settleEdits();
    await tick();
    expect(runs()).toEqual([B(4, 7)]);
    expect(page().boxes[0].style.bold).toBe(false);
  });

  it('a text change drops the words, and undoing it does not bring them back', async () => {
    const { q, scope } = mounted();
    await tick();
    const field = q('#insp-text');
    field.focus();
    field.setSelectionRange(8, 13);
    await fireEvent.select(field);
    style: {
      const other = q('.seg button');
      other.focus();
      await fireEvent.blur(field, { relatedTarget: other });
    }
    await tick();
    expect(scope()[0]).toBe('Selected words');
    page().boxes[0].text = 'one two three!';
    await tick();
    expect(scope()[0]).toBe('Whole box');
    page().boxes[0].text = 'one two three';
    await tick();
    expect(scope()[0]).toBe('Whole box');
  });

  it('Mod+B in the Text field bolds the selected words, and the field\'s Cmd+Z takes it back before any typing', async () => {
    const { q } = mounted();
    await tick();
    const field = q('#insp-text');
    field.focus();
    field.setSelectionRange(8, 13);
    await fireEvent.select(field);
    key(field, 'b');
    settleEdits();
    await tick();
    expect(runs()).toEqual([B(4, 7), B(8, 13)]);
    key(field, 'z');
    await tick();
    expect(runs()).toEqual([B(4, 7)]);
    expect(field.value).toBe('one two three');
    expect([field.selectionStart, field.selectionEnd]).toEqual([8, 13]);
    // And Shift+Cmd+Z puts it on again.
    key(field, 'z', { shiftKey: true });
    await tick();
    expect(runs()).toEqual([B(4, 7), B(8, 13)]);
  });

  it('on curved text act on the whole box, and the keys are refused with one toast', async () => {
    const { q, scope } = mounted({ curve: 30 });
    await tick();
    const field = q('#insp-text');
    field.focus();
    field.setSelectionRange(8, 13);
    await fireEvent.select(field);
    await tick();
    expect(scope()).toEqual(['Whole box']);
    key(field, 'b');
    await tick();
    expect(runs()).toEqual([B(4, 7)]);
    expect(app.toast?.msg).toBe('Curved text uses one typeface.');
  });

  it('open the family list for "Typeface…", on the range it was asked for', async () => {
    const { q, scope } = mounted();
    setInspectorTab('fill');
    await tick();
    askFacePick('b', 'one two three', 4, 7);
    await tick();
    await tick();
    await tick();
    expect(scope()[0]).toBe('Selected words');
    expect(q('#insp-font')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('give the focus and the words back to the text when the family list closes', async () => {
    const { q } = mounted();
    await tick();
    // The box being typed into, as TextBox draws it.
    const text = document.createElement('div');
    text.className = 'txt editable';
    text.setAttribute('contenteditable', 'true');
    // jsdom does not make an editable focusable by itself.
    text.tabIndex = 0;
    text.textContent = 'one two three';
    document.body.append(text);
    text.focus();
    getSelection().setBaseAndExtent(text.firstChild, 4, text.firstChild, 7);
    askFacePick('b', 'one two three', 4, 7);
    for (let i = 0; i < 4; i++) await tick();
    await Promise.resolve();
    expect(q('#insp-font')?.getAttribute('aria-expanded')).toBe('true');
    expect(text.contains(document.activeElement)).toBe(false);
    // What WebKit does to the editable's selection while the list has the focus.
    getSelection().collapse(text.firstChild, 0);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
    expect(q('#insp-font')?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(text);
    const s = getSelection();
    expect([s.anchorOffset, s.focusOffset]).toEqual([4, 7]);
    text.remove();
  });

  describe('"Typeface…" with the Text box options panel hidden', () => {
    const made = [];
    beforeEach(() => {
      made.length = 0;
      setHidden('options', true);
    });
    afterEach(() => {
      setHidden('options', false);
      resetCombo('text.typeface');
      delete window.__TAURI_INTERNALS__;
    });
    // The words selected in the box being typed into, the panel hidden.
    async function hiddenWithWords() {
      const text = 'one two three';
      loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [{ id: 'b', lineN: null, text, runs: null, runsCheck: textCheck(text), x: 100, y: 100, w: 240, h: 90, style: normalizeStyle({ ...defaultStyle() }) }] }]);
      app.chapterRef = { projectId: 'p', chapterId: 'c' };
      app.chapterMode = 'typeset';
      app.selectedId = 'b';
      app.editingId = 'b';
      setInspectorTab('fill');
      setTypingSel('b', text, 4, 7);
      const view = render(OptionsPanelHost);
      await tick();
      expect(view.container.querySelector('.insp')).toBe(null);
      return view;
    }
    const opened = async (view) => {
      for (let i = 0; i < 4; i++) await tick();
      return view.container.querySelector('#insp-font')?.getAttribute('aria-expanded');
    };

    it('from its key: shows the panel, on the Text tab, with the family list open for the words, once', async () => {
      setCombo('text.typeface', 'Mod+Shift+y');
      const view = await hiddenWithWords();
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      expect(panels.options.hidden).toBe(false);
      expect(await opened(view)).toBe('true');
      expect([...view.container.querySelectorAll('.lbl .scope')].map((n) => n.textContent)[0]).toBe('Selected words');
      // Hidden and shown again: the ask was taken, the list stays shut.
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      setHidden('options', true);
      await tick();
      setHidden('options', false);
      expect(await opened(view)).toBe('false');
    });

    it('from the system menu\'s item: the same', async () => {
      window.__TAURI_INTERNALS__ = {};
      const view = await hiddenWithWords();
      const items = await new Promise((res) => {
        vi.doMock('@tauri-apps/api/menu', () => ({
          MenuItem: { new: async (o) => ({ kind: 'item', ...o }) },
          CheckMenuItem: { new: async (o) => ({ kind: 'check', ...o }) },
          PredefinedMenuItem: { new: async (o) => ({ kind: 'predefined', ...o }) },
          Menu: { new: async ({ items }) => ({ close: async () => {}, popup: async () => res(items) }) },
        }));
        popFaceMenu();
      });
      items.find((i) => i.text === 'Typeface…').action();
      expect(panels.options.hidden).toBe(false);
      expect(await opened(view)).toBe('true');
      vi.doUnmock('@tauri-apps/api/menu');
    });
  });
});
