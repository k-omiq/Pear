// The typing pane's keyboard (Queue.svelte inside a translate chapter): Enter
// and Tab step through the lines across pages, Alt+digit toggles the numbered
// tags, Alt+T finds or makes a tag, Esc leaves the field.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import Queue from './Queue.svelte';
import {
  app,
  loadProjectPages,
  page,
  settleEdits,
  isTranslateMode,
  isTranslateChapter,
  setTranslateTypeset,
  stepLine,
} from './store.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { setMacKeyboard } from './shortcuts.svelte.js';

let raf;
beforeEach(() => {
  vi.useFakeTimers();
  raf = [];
  vi.stubGlobal('requestAnimationFrame', (fn) => (raf.push(fn), raf.length));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  setMacKeyboard(true);
  app.chapterRef = null;
  app.chapterMode = 'translate';
  app.translateTypeset = false;
  loadProjectPages([
    {
      id: 1, w: 800, h: 1200, boxes: [],
      lines: [
        { n: 1, jp: 'あ', en: 'alpha', tags: ['speech'] },
        { n: 2, jp: 'い', en: '', tags: ['sfx'] },
      ],
    },
    { id: 2, w: 800, h: 1200, boxes: [], lines: [{ n: 1, jp: 'う', en: '' }, { n: 2, jp: 'え', en: '' }] },
  ]);
  page().activeLineN = 1;
  initHistory();
  resetHistory();
});
afterEach(() => {
  cleanup();
  settleEdits();
  resetHistory();
  loadProjectPages([]);
  app.chapterMode = 'typeset';
  app.translateTypeset = false;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async () => {
  await tick();
  for (const fn of raf.splice(0)) fn();
  await tick();
};
const key = (el, init) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
};
const english = (view) => view.container.querySelector('.qrow.active textarea.qen');

it('steps with Enter and Tab across the page edge, and back with Shift+Tab', async () => {
  const view = render(Queue);
  await flush();
  expect(document.activeElement).toBe(english(view));
  expect(key(english(view), { key: 'Enter' }).defaultPrevented).toBe(true);
  await flush();
  expect([app.pageIndex, page().activeLineN]).toEqual([0, 2]);
  expect(document.activeElement).toBe(english(view));
  key(english(view), { key: 'Tab' });
  await flush();
  expect([app.pageIndex, page().activeLineN]).toEqual([1, 1]);
  key(english(view), { key: 'Tab', shiftKey: true });
  await flush();
  expect([app.pageIndex, page().activeLineN]).toEqual([0, 2]);
  // Shift+Enter is the field's own line break.
  expect(key(english(view), { key: 'Enter', shiftKey: true }).defaultPrevented).toBe(false);
});

it('stops at the ends of the chapter', () => {
  app.pageIndex = 1;
  page().activeLineN = 2;
  expect(stepLine(1)).toBe(null);
  app.pageIndex = 0;
  page().activeLineN = 1;
  expect(stepLine(-1)).toBe(null);
});

it('toggles the numbered tags with Alt+digit, in name order that does not move', async () => {
  const view = render(Queue);
  await flush();
  const chips = () => [...view.container.querySelectorAll('.qrow.active .qtag')].map((b) => b.textContent);
  expect(chips()).toEqual(['1sfx', '2speech']);
  key(english(view), { key: '¡', code: 'Digit1', altKey: true });
  expect(page().lines[0].tags).toEqual(['speech', 'sfx']);
  await flush();
  expect(chips()).toEqual(['1sfx', '2speech']);
  key(english(view), { key: '™', code: 'Digit2', altKey: true });
  expect(page().lines[0].tags).toEqual(['sfx']);
  key(english(view), { key: 'º', code: 'Digit0', altKey: true });
  expect(page().lines[0].tags ?? []).toEqual([]);
});

it('finds or makes a tag with Alt+T and goes back to the English field', async () => {
  const view = render(Queue);
  await flush();
  key(english(view), { key: '†', code: 'KeyT', altKey: true });
  await flush();
  const input = view.getByLabelText('Find or add a tag');
  expect(document.activeElement).toBe(input);
  await fireEvent.input(input, { target: { value: 'thought' } });
  key(input, { key: 'Enter' });
  await flush();
  expect(page().lines[0].tags).toContain('thought');
  expect(view.queryByLabelText('Find or add a tag')).toBe(null);
  expect(document.activeElement).toBe(english(view));
});

it('lets go of the field with Esc, and Enter on the row goes back in', async () => {
  const view = render(Queue);
  await flush();
  key(english(view), { key: 'Escape' });
  const row = view.container.querySelector('.qrow.active');
  expect(document.activeElement).toBe(row);
  key(row, { key: 'ArrowDown' });
  await flush();
  expect(page().activeLineN).toBe(2);
  key(view.container.querySelector('.qrow.active'), { key: 'Enter' });
  await flush();
  expect(document.activeElement).toBe(english(view));
});

it('shows and hides the typesetting tools without leaving the translate chapter', () => {
  expect(isTranslateMode()).toBe(true);
  expect(setTranslateTypeset(true)).toBe(true);
  expect(isTranslateMode()).toBe(false);
  expect(isTranslateChapter()).toBe(true);
  app.tool = 'text';
  setTranslateTypeset(false);
  expect(isTranslateMode()).toBe(true);
  expect(app.tool).toBe('pan');
  app.chapterMode = 'typeset';
  expect(setTranslateTypeset(true)).toBe(false);
});
