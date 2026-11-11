// The dock's undo and redo in a translate chapter: always there, dimmed
// (disabled) when the translate gate would refuse the step on top.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import ZoomDock from './ZoomDock.svelte';
import { app, loadProjectPages, page, settleEdits, addQueueLine, addBoxAt } from '../store.svelte.js';
import { initHistory, resetHistory, record } from './history.svelte.js';

beforeEach(() => {
  app.chapterRef = null;
  app.chapterMode = 'translate';
  app.translateTypeset = false;
  loadProjectPages([{ id: 1, w: 800, h: 1200, boxes: [], lines: [{ n: 1, type: 'dialogue', jp: 'a', en: 'b' }] }]);
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
});

it('shows undo and redo, and dims undo when a box step is on top in translate mode', async () => {
  const view = render(ZoomDock, { onFit: () => {} });
  await tick();
  const undoBtn = () => view.getByRole('button', { name: 'Undo' });
  const redoBtn = () => view.getByRole('button', { name: 'Redo' });
  expect([undoBtn().disabled, redoBtn().disabled]).toEqual([true, true]);
  addQueueLine();
  await tick();
  expect(undoBtn().disabled).toBe(false);
  // A box edit made while the typesetting tools were shown.
  app.translateTypeset = true;
  addBoxAt(page(), { text: 'hi', x: 100, y: 100 });
  settleEdits();
  record({ t: 'move', pageId: 1, boxId: page().boxes.at(-1).id, before: { x: 1 }, after: { x: 2 } });
  await tick();
  expect(undoBtn().disabled).toBe(false);
  app.translateTypeset = false;
  await tick();
  expect(undoBtn().disabled).toBe(true);
  expect(undoBtn().isConnected).toBe(true);
});
