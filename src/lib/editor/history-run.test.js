// An AI run's group on a page whose stack is not the live one: it lives in the
// history file and still takes every edit of the run on that page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, loadProjectPages, pageById, editBoxes, settleEdits, cloneStyle } from '../store.svelte.js';
import { initHistory, resetHistory, peekStack, inRun, undo } from './history.svelte.js';
import { __setDir, switchHistoryPage, flushHistory, rescaleEntry, migrateEntry } from './history-file.svelte.js';
import { defaultStyle } from '../data.js';

vi.mock('../fsx.js', () => {
  const files = new Map();
  return {
    files,
    fsx: {
      join: async (...p) => p.join('/'),
      mkdir: async () => {},
      exists: async (p) => files.has(p),
      readTextFile: async (p) => {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p);
      },
      writeTextFileAtomic: async (p, c) => void files.set(p, c),
    },
  };
});

const box = (id) => ({ id, lineN: null, text: 'hi', x: 10, y: 10, w: 100, h: 40, style: { ...defaultStyle(), size: 20 } });
const pageDoc = (id, ids) => ({ id, w: 800, h: 1200, lines: [], boxes: ids.map(box) });
const copy = (v) => JSON.parse(JSON.stringify(v));

beforeEach(() => {
  __setDir(null);
  app.chapterRef = null;
  loadProjectPages([pageDoc(1, ['a']), pageDoc(2, ['b', 'c'])]);
  initHistory();
  resetHistory();
});
afterEach(() => {
  settleEdits();
  resetHistory();
  __setDir(null);
  loadProjectPages([]);
});

describe('a run on a page off screen', () => {
  it('folds into one stored group, which undoes as one step there', async () => {
    __setDir('/lib/proj/ch1');
    const p1 = pageById(1);
    const p2 = pageById(2);
    // The live page is claimed by its first record.
    editBoxes([{ page: p1, box: p1.boxes[0] }], (b) => void (b.x += 1));
    const start = copy(p2.boxes);
    const italic = (b) => void (b.style = cloneStyle({ ...b.style, italic: true }));
    inRun('r1', () => editBoxes([{ page: p2, box: p2.boxes[0] }], italic));
    inRun('r1', () => editBoxes([{ page: p2, box: p2.boxes[1] }], (b) => void (b.y += 7)));
    expect(peekStack().undo).toHaveLength(1);
    await switchHistoryPage(1, 2);
    const stack = peekStack().undo;
    expect(stack).toHaveLength(1);
    expect(stack[0]).toMatchObject({ t: 'group', run: 'r1', pageId: 2 });
    expect(stack[0].items.map((it) => it.t)).toEqual(['bulk', 'resize']);
    expect(undo()).toBe(true);
    expect(copy(p2.boxes)).toEqual(start);
    await flushHistory();
  });
});

describe('a stored group', () => {
  const group = {
    t: 'group', pageId: 1, run: 'r1',
    items: [{ t: 'move', pageId: 1, boxId: 'a', before: { x: 10, y: 10 }, after: { x: 20, y: 10 } }],
  };

  it('is rescaled item by item', () => {
    expect(rescaleEntry(group, 2, 2).items[0].after).toEqual({ x: 40, y: 20 });
  });

  it('is migrated item by item, and left as it is when nothing moves', () => {
    expect(migrateEntry(group)).toBe(group);
  });
});
