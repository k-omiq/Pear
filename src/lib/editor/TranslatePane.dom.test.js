// The translate workspace's two new halves render: the typing pane with its
// counts, and the numbered bubbles on the page, badges on the corner the
// series reads from.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import TranslatePane from './TranslatePane.svelte';
import BubbleNumbers from './BubbleNumbers.svelte';
import { app, loadProjectPages, page } from '../store.svelte.js';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  app.chapterMode = 'translate';
  app.projectOcrLanguage = 'ja';
  loadProjectPages([
    {
      id: 1, w: 800, h: 1200, boxes: [],
      lines: [{ n: 1, jp: 'あ', en: 'alpha' }, { n: 2, jp: 'い', en: '' }],
      detect: { panels: [], boxes: [{ n: 1, box: [600, 100, 700, 300] }, { n: 2, box: [100, 100, 200, 300] }] },
    },
  ]);
  page().activeLineN = 2;
});
afterEach(() => {
  cleanup();
  loadProjectPages([]);
  app.chapterMode = 'typeset';
  app.projectOcrLanguage = 'ja';
  app.translateTypeset = false;
  app.viewCleaned = false;
  vi.unstubAllGlobals();
});

it('shows where the translator is and which way the series reads', async () => {
  const view = render(TranslatePane);
  await tick();
  expect(view.getByText('1 / 2 on this page')).toBeTruthy();
  expect(view.getByText('Right to left')).toBeTruthy();
  await fireEvent.click(view.getByRole('button', { name: 'Keyboard keys' }));
  expect(view.getByText('Find or add a tag')).toBeTruthy();
  await fireEvent.click(view.getByRole('button', { name: /Typeset/ }));
  expect(app.translateTypeset).toBe(true);
});

it('offers the cleaned pages with the typesetting tools out, and drops back to raw when they go', async () => {
  page().cleaned = 'blob:cleaned';
  const view = render(TranslatePane);
  await tick();
  expect(view.queryByRole('button', { name: /Cleaned/ })).toBe(null);
  app.translateTypeset = true;
  await tick();
  await fireEvent.click(view.getByRole('button', { name: /Cleaned/ }));
  expect(app.viewCleaned).toBe(true);
  await fireEvent.click(view.getByRole('button', { name: /Typeset/ }));
  expect(app.translateTypeset).toBe(false);
  expect(app.viewCleaned).toBe(false);
});

it('numbers each bubble, done filled and the active one lit, badge on the reading corner', async () => {
  const view = render(BubbleNumbers, { pg: page() });
  await tick();
  const marks = [...view.container.querySelectorAll('.mark')];
  expect(marks.map((m) => m.textContent.trim())).toEqual(['1', '2']);
  expect(marks[0].classList.contains('done')).toBe(true);
  expect(marks[1].classList.contains('active')).toBe(true);
  // Right to left: the badge sits on the box's right edge.
  expect(marks[0].querySelector('.badge').getAttribute('transform')).toMatch(/^translate\(700 100\)/);
  await fireEvent.click(marks[0]);
  expect(page().activeLineN).toBe(1);
});

it('puts the badge on the left edge for a left-to-right series', async () => {
  app.projectOcrLanguage = 'ko';
  const view = render(BubbleNumbers, { pg: page() });
  await tick();
  expect(view.container.querySelector('.badge').getAttribute('transform')).toMatch(/^translate\(600 100\)/);
});
