import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import Queue from './Queue.svelte';
import { app, loadProjectPages, page, settleEdits } from './store.svelte.js';
import { initHistory, resetHistory, undo } from './editor/history.svelte.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  app.chapterRef = null;
  app.chapterMode = 'translate';
  loadProjectPages([{
    id: 1, w: 800, h: 1200, boxes: [],
    lines: [
      // The free row has a box drawn, so the pane shows its label (T1) where
      // a free row without one shows the draw button.
      { n: 1, en: 'alpha' }, { n: -1, en: 'free', rect: [0, 0, 40, 40] }, { n: 2, en: 'beta' },
      { n: 3, en: 'gamma' }, { n: 4, en: 'delta' },
    ],
  }]);
  page().activeLineN = 2;
  initHistory();
  resetHistory();
});
afterEach(() => {
  cleanup();
  settleEdits();
  resetHistory();
  loadProjectPages([]);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const altKey = (el, key) => {
  const e = new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

it('moves a row with Alt+arrows and keeps focus and the textarea on the same content through undo', async () => {
  const view = render(Queue);
  await tick();
  const badge = view.container.querySelector('.qrow.editing .badge');
  const textarea = view.getByPlaceholderText('English…');
  badge.focus();
  expect(altKey(badge, 'ArrowDown').defaultPrevented).toBe(true);
  await tick();
  expect(page().activeLineN).toBe(3);
  expect(view.getByPlaceholderText('English…')).toBe(textarea);
  expect(textarea.value).toBe('beta');
  expect(document.activeElement).toBe(badge);
  expect([...view.container.querySelectorAll('.qrow .badge')].map((b) => b.textContent)).toEqual(['1', 'T1', '2', '3', '4']);
  altKey(badge, 'ArrowDown');
  expect(page().activeLineN).toBe(4);
  // At the end of the order, a further press changes nothing.
  altKey(badge, 'ArrowDown');
  expect(page().activeLineN).toBe(4);
  expect(undo()).toBe(true);
  expect(undo()).toBe(true);
  await tick();
  expect(view.getByPlaceholderText('English…')).toBe(textarea);
  expect(textarea.value).toBe('beta');
  expect(page().activeLineN).toBe(2);
});

it('leaves typing keys to the textarea and never moves a free row', async () => {
  const view = render(Queue);
  await tick();
  const textarea = view.getByPlaceholderText('English…');
  textarea.focus();
  const key = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
  textarea.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(false);
  expect(altKey(textarea, 'ArrowUp').defaultPrevented).toBe(false);
  expect(page().activeLineN).toBe(2);
  await fireEvent.input(textarea, { target: { value: 'typed beta' } });
  expect(page().lines.find((l) => l.n === 2).en).toBe('typed beta');
  await fireEvent.click(view.getByRole('button', { name: 'Create tag' }));
  const tagName = view.getByPlaceholderText('Tag name…');
  await fireEvent.input(tagName, { target: { value: 'draft tag' } });
  altKey(view.container.querySelector('.qrow.editing .badge'), 'ArrowUp');
  await tick();
  expect(page().activeLineN).toBe(1);
  expect(view.getByPlaceholderText('English…').value).toBe('typed beta');
  expect(view.getByPlaceholderText('Tag name…')).toBe(tagName);
  expect(tagName.value).toBe('draft tag');
  await fireEvent.keyDown(textarea, { key: 'z', metaKey: true });
  expect(page().lines.find((l) => l.n === 1).en).toBe('beta');
  page().activeLineN = -1;
  await tick();
  const freeRow = view.container.querySelector('.qrow.editing');
  expect(freeRow.dataset.n).toBeUndefined();
  expect(altKey(freeRow.querySelector('.badge'), 'ArrowUp').defaultPrevented).toBe(false);
  expect(page().lines.map((l) => l.n)).toEqual([1, -1, 2, 3, 4]);
  expect(view.queryByRole('textbox', { name: 'Source text' })).toBeNull();
});

it('drags a row to a new place in the reading order, as one undo step', async () => {
  const view = render(Queue);
  await tick();
  // jsdom lays nothing out: each row is 40px tall, in list order.
  const rows = () => [...view.container.querySelectorAll('.qrow')];
  rows().forEach((r, i) => {
    r.getBoundingClientRect = () => ({ top: i * 40, bottom: i * 40 + 40, height: 40, left: 0, right: 200, width: 200 });
  });
  const ptr = (target, type, clientY) => target.dispatchEvent(new MouseEvent(type, { clientY, button: 0, bubbles: true }));
  const delta = rows().find((r) => r.dataset.n === '4');
  ptr(delta, 'pointerdown', 180);
  // Under the start threshold it is still a click, not a drag.
  ptr(window, 'pointermove', 178);
  await tick();
  expect(view.container.querySelector('.qrow.lifted')).toBeNull();
  ptr(window, 'pointermove', 10);
  await tick();
  expect(delta.classList.contains('lifted')).toBe(true);
  expect(rows().find((r) => r.dataset.n === '1').classList.contains('drop-before')).toBe(true);
  ptr(window, 'pointerup', 10);
  await tick();
  expect(page().lines.map((l) => l.en)).toEqual(['delta', 'free', 'alpha', 'beta', 'gamma']);
  expect(page().lines.filter((l) => l.n > 0).map((l) => l.n)).toEqual([1, 2, 3, 4]);
  expect(view.container.querySelector('.qrow.lifted, .qrow.drop-before, .qrow.drop-after')).toBeNull();
  expect(undo()).toBe(true);
  expect(page().lines.map((l) => l.en)).toEqual(['alpha', 'free', 'beta', 'gamma', 'delta']);
});

it('drops a free row nowhere: it does not drag', async () => {
  const view = render(Queue);
  await tick();
  const free = [...view.container.querySelectorAll('.qrow')].find((r) => r.querySelector('.badge.free'));
  free.dispatchEvent(new MouseEvent('pointerdown', { clientY: 50, button: 0, bubbles: true }));
  window.dispatchEvent(new MouseEvent('pointermove', { clientY: 200, bubbles: true }));
  await tick();
  expect(view.container.querySelector('.qrow.lifted')).toBeNull();
  window.dispatchEvent(new MouseEvent('pointerup', { clientY: 200, bubbles: true }));
  expect(page().lines.map((l) => l.n)).toEqual([1, -1, 2, 3, 4]);
});

it('keeps source and English field undo separate and shows collapsed source text', async () => {
  const line = page().lines.find((l) => l.n === 2);
  line.jp = '元の文';
  page().lines[0].jp = '別の文';
  const view = render(Queue);
  await tick();
  const source = view.getByRole('textbox', { name: 'Source text' });
  const english = view.getByPlaceholderText('English…');
  expect(source.rows).toBe(1);
  expect(source.value).toBe('元の文');
  expect(view.container.querySelector('.qrow:not(.editing) .qjp').textContent).toBe('別の文');

  await fireEvent.input(source, { target: { value: '直した文' } });
  await fireEvent.input(english, { target: { value: 'edited English' } });
  await fireEvent.keyDown(source, { key: 'z', metaKey: true });
  expect(line.jp).toBe('元の文');
  expect(line.en).toBe('edited English');
  await fireEvent.keyDown(source, { key: 'z', metaKey: true, shiftKey: true });
  expect(line.jp).toBe('直した文');
  await fireEvent.keyDown(english, { key: 'z', metaKey: true });
  expect(line.en).toBe('beta');
  expect(line.jp).toBe('直した文');
});

it('a drag that starts on the source text selects it and moves nothing', async () => {
  page().activeLineN = 1;
  page().lines.find((l) => l.n === 4).jp = '四';
  const view = render(Queue);
  await tick();
  const jp = [...view.container.querySelectorAll('.qrow')].find((r) => r.dataset.n === '4').querySelector('.qjp');
  jp.dispatchEvent(new MouseEvent('pointerdown', { clientY: 180, button: 0, bubbles: true }));
  window.dispatchEvent(new MouseEvent('pointermove', { clientY: 10, bubbles: true }));
  await tick();
  expect(view.container.querySelector('.qrow.lifted')).toBeNull();
  window.dispatchEvent(new MouseEvent('pointerup', { clientY: 10, bubbles: true }));
  expect(page().lines.map((l) => l.n)).toEqual([1, -1, 2, 3, 4]);
});
