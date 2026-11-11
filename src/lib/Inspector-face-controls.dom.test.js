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
    const { style, scope, clear } = mounted();
    await tick();
    expect(scope()).toEqual(['Whole box', 'Whole box']);
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
    expect(scope()).toEqual(['Selected words', 'Selected words']);
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
    expect(scope()[1]).toBe('Next letters');
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
    expect(scope()[1]).toBe('Selected words');
    // Tab or a click into the controls: the field lets go of its selection.
    style()[1].focus();
    await fireEvent.blur(field, { relatedTarget: style()[1] });
    await tick();
    expect(scope()[1]).toBe('Selected words');
    await fireEvent.click(style()[1]);
    await tick();
    expect(runs()).toEqual([B(4, 7), { start: 8, end: 13, italic: true }]);
    // The words change: the range they named is gone.
    field.value = 'one two three!';
    await fireEvent.input(field);
    await tick();
    expect(scope()[1]).toBe('Whole box');
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
    expect(scope()).toEqual(['Whole box', 'Whole box']);
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
});
