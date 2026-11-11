// The typing pane's keyboard (Queue.svelte inside a translate chapter): Enter
// and Tab step through the lines across pages, Alt+digit toggles the numbered
// tags, Alt+T finds or makes a tag, Esc leaves the field.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import Queue, { drawLineBox } from './Queue.svelte';
import { patternPick, startPatternPick, cancelPatternPick } from './pattern-pick.svelte.js';
import BubbleNumbers from './editor/BubbleNumbers.svelte';
import { pageRectPick } from './page-rect-pick.svelte.js';
import {
  app,
  loadProjectPages,
  page,
  settleEdits,
  isTranslateMode,
  isTranslateChapter,
  setTranslateTypeset,
  stepLine,
  gotoPage,
  setLineText,
} from './store.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { setMacKeyboard, setCombo, resetAllCombos } from './shortcuts.svelte.js';

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
  pageRectPick.cancel();
  cleanup();
  settleEdits();
  resetHistory();
  loadProjectPages([]);
  app.chapterMode = 'typeset';
  app.translateTypeset = false;
  resetAllCombos();
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

it('follows the keys as the user rebound them', async () => {
  expect(setCombo('translate.next', 'Mod+Enter').ok).toBe(true);
  expect(setCombo('translate.tag1', 'Ctrl+1').ok).toBe(true);
  const view = render(Queue);
  await flush();
  // Plain Enter is now the field's own again.
  expect(key(english(view), { key: 'Enter' }).defaultPrevented).toBe(false);
  key(english(view), { key: 'Enter', metaKey: true });
  await flush();
  expect(page().activeLineN).toBe(2);
  // The rebound tag key toggles; the old Alt+1 types its character.
  const chips = () => [...view.container.querySelectorAll('.qrow.active .qtag')].map((b) => b.textContent);
  expect(chips()[0]).toBe('⌃1sfx');
  expect(key(english(view), { key: '¡', code: 'Digit1', altKey: true }).defaultPrevented).toBe(false);
  key(english(view), { key: '1', code: 'Digit1', ctrlKey: true });
  expect(page().lines[1].tags).toEqual([]);
});

// ---------- lines added, deleted and drawn (plan section 3) ----------

it('deletes a focused row with Delete, says so with an Undo, and leaves a field’s Delete alone', async () => {
  const view = render(Queue);
  await flush();
  // In the English field Delete edits the text.
  expect(key(english(view), { key: 'Delete' }).defaultPrevented).toBe(false);
  expect(page().lines).toHaveLength(2);
  key(english(view), { key: 'Escape' });
  const row = view.container.querySelector('.qrow.active');
  expect(key(row, { key: 'Delete' }).defaultPrevented).toBe(true);
  await flush();
  expect(page().lines.map((l) => [l.n, l.en])).toEqual([[1, '']]);
  expect(app.toast.msg).toBe('Deleted line 1');
  expect(app.toast.action.label).toBe('Undo');
  app.toast.action.run();
  await flush();
  expect(page().lines.map((l) => [l.n, l.en])).toEqual([[1, 'alpha'], [2, '']]);
  // A second press of a stale Undo does nothing.
  const stale = { ...app.toast };
  stale.action?.run?.();
  expect(page().lines).toHaveLength(2);
});

it('takes Backspace on a row too, but not on a button inside it', async () => {
  const view = render(Queue);
  await flush();
  key(english(view), { key: 'Escape' });
  const chip = view.container.querySelector('.qrow.active .qtag');
  key(chip, { key: 'Backspace' });
  expect(page().lines).toHaveLength(2);
  key(view.container.querySelector('.qrow.active'), { key: 'Backspace' });
  expect(page().lines).toHaveLength(1);
});

it('asks a hand-added line for its box, draws it, and goes back to the English', async () => {
  const view = render(Queue);
  await flush();
  await fireEvent.click(view.getByText('Add line'));
  await flush();
  const draw = view.container.querySelector('.qrow.active .badge-draw');
  expect(draw.title).toBe("Draw this line's box on the page");
  await fireEvent.click(draw);
  expect(pageRectPick.active).toBe(true);
  expect(pageRectPick.hint).toBe('Drag a box for this line · Esc cancels');
  // Focus moves away while the user drags; the done puts it back.
  draw.focus();
  pageRectPick.finish(page(), 300, 200, 100, 150);
  await flush();
  expect(page().lines.at(-1).rect).toEqual([100, 150, 300, 200]);
  expect(view.container.querySelector('.qrow.active .badge').textContent).toBe('T1');
  expect(document.activeElement).toBe(english(view));
  expect(view.container.querySelector('.qrow.active .badge-draw')).toBe(null);
});

it('cancels a drag under 8 px, and Esc, without drawing anything', async () => {
  const view = render(Queue);
  await flush();
  await fireEvent.click(view.getByText('Add line'));
  await flush();
  await fireEvent.click(view.container.querySelector('.qrow.active .badge-draw'));
  pageRectPick.finish(page(), 100, 100, 105, 160);
  expect(pageRectPick.active).toBe(false);
  expect(page().lines.at(-1).rect).toBeUndefined();
  expect(app.toast.msg).toBe('Drag a larger box for the line');
  await fireEvent.click(view.container.querySelector('.qrow.active .badge-draw'));
  expect(pageRectPick.cancel()).toBe(true);
  expect(page().lines.at(-1).rect).toBeUndefined();
});

it('keeps Draw or Redraw and Delete in the row menu', async () => {
  page().detect = { panels: [], boxes: [{ n: 1, box: [0, 0, 50, 50] }] };
  const view = render(Queue);
  await flush();
  const menuFor = async (n) => {
    const btn = view.getByLabelText(`Line ${n} actions`);
    await fireEvent.click(btn);
    await flush();
    return [...document.querySelectorAll('.row-menu [role="menuitem"]')];
  };
  let items = await menuFor(1);
  expect(items.map((b) => b.textContent)).toEqual(['Redraw box on page', 'Delete line']);
  expect(items[1].classList.contains('danger')).toBe(true);
  await fireEvent.click(items[0]);
  await flush();
  expect(pageRectPick.active).toBe(true);
  pageRectPick.cancel();
  items = await menuFor(2);
  expect(items[0].textContent).toBe('Draw box on page');
  await fireEvent.click(items[1]);
  await flush();
  expect(page().lines.map((l) => l.n)).toEqual([1]);
  expect(app.toast.msg).toBe('Deleted line 2');
});

it('marks a line on the page by its drawn box, with the T label its row has', async () => {
  page().detect = { panels: [], boxes: [{ n: 1, box: [0, 0, 50, 50] }] };
  page().lines.push({ n: -1, type: 'dialogue', jp: '', en: '', rect: [100, 100, 200, 160] });
  page().lines.push({ n: -2, type: 'dialogue', jp: '', en: '' });
  const view = render(BubbleNumbers, { pg: page() });
  await flush();
  const marks = [...view.container.querySelectorAll('.mark')].map((g) => [g.querySelector('text').textContent, g.querySelector('.area').getAttribute('x')]);
  expect(marks).toEqual([['1', '0'], ['T1', '100']]);
});

it('takes the toast’s Undo past typing still settling: that newer edit wins', async () => {
  const view = render(Queue);
  await flush();
  key(english(view), { key: 'Escape' });
  key(view.container.querySelector('.qrow.active'), { key: 'Delete' });
  await flush();
  const undoDelete = app.toast.action.run;
  // An edit inside its settle window is not on the stack yet; the Undo must
  // settle it first and then see it is not the delete any more.
  setLineText(page(), 1, 'typed after');
  undoDelete();
  expect(page().lines.map((l) => [l.n, l.en])).toEqual([[1, 'typed after']]);
  expect(app.toast.msg).toBe('Undo the newer edits first');
});

it('ends a line pick when the page turns, the chapter closes or the mode switches, and touches nothing', async () => {
  const view = render(Queue);
  await flush();
  const arm = async () => {
    await fireEvent.click(view.getByLabelText('Line 1 actions'));
    await flush();
    await fireEvent.click(document.querySelector('.row-menu [role="menuitem"]'));
    await flush();
    expect(pageRectPick.active).toBe(true);
  };
  await arm();
  gotoPage(1);
  expect(pageRectPick.active).toBe(false);
  expect(app.pages[0].lines[0].rect).toBeUndefined();
  gotoPage(0);
  await flush();
  await arm();
  setTranslateTypeset(true);
  expect(pageRectPick.active).toBe(false);
  setTranslateTypeset(false);
  await flush();
  await arm();
  const shown = page();
  loadProjectPages([{ id: 9, w: 800, h: 1200, boxes: [], lines: [{ n: 1, en: 'other' }] }]);
  expect(pageRectPick.active).toBe(false);
  // A late drag with no pick waiting changes no page.
  pageRectPick.finish(shown, 0, 0, 100, 100);
  expect([shown.lines[0].rect, page().lines[0].rect]).toEqual([undefined, undefined]);
});

it('hands the layer over between the pattern pick and a line pick, both ways', async () => {
  const view = render(Queue);
  await flush();
  english(view).blur();
  startPatternPick(1, 'b1', 'pattern');
  expect(drawLineBox(1)).toBe(true);
  expect([patternPick.active, pageRectPick.hint]).toEqual([false, 'Drag a box for this line · Esc cancels']);
  startPatternPick(1, 'b1', 'pattern');
  expect([patternPick.active, pageRectPick.hint]).toEqual([true, 'Drag over the tone to take it · Esc to cancel']);
  // The replaced line pick neither drew a box nor took the caret.
  expect(page().lines[0].rect).toBeUndefined();
  await flush();
  expect(view.container.contains(document.activeElement)).toBe(false);
  cancelPatternPick();
  expect(pageRectPick.active).toBe(false);
});

it('marks a line by its first good block when a malformed one comes ahead of it', async () => {
  page().detect = { panels: [], boxes: [{ n: 1, box: [0, 0, 'x', 50] }, { n: 1, box: [10, 20, 60, 70] }, { n: 2, box: null }] };
  const view = render(BubbleNumbers, { pg: page() });
  await flush();
  const marks = [...view.container.querySelectorAll('.mark')].map((g) => [g.querySelector('text').textContent, g.querySelector('.area').getAttribute('x')]);
  expect(marks).toEqual([['1', '10']]);
});

it('keeps only the part of a drag on the page, and refuses it when that part is under 8 px', async () => {
  const view = render(Queue);
  await flush();
  await fireEvent.click(view.getByText('Add line'));
  await flush();
  const draw = () => fireEvent.click(view.container.querySelector('.qrow.active .badge-draw'));
  // 100 px wide as dragged, 5 px of it on the page.
  await draw();
  pageRectPick.finish(page(), 795, 100, 895, 200);
  expect(page().lines.at(-1).rect).toBeUndefined();
  expect(app.toast.msg).toBe('Drag a larger box for the line');
  await draw();
  pageRectPick.finish(page(), 700, -50, 900, 100);
  expect(page().lines.at(-1).rect).toEqual([700, 0, 800, 100]);
});
