import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app, loadProjectPages, page } from './store.svelte.js';
import { initHistory, resetHistory, undo, redo } from './editor/history.svelte.js';
import { clipToBubble } from './box-mask-actions.js';
import { bubbleLink } from './box-mask.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// Clip to bubble: one undo step for every box it acts on, the selected box or
// the Bulk panel's picked boxes, linking them all or, when all are linked,
// unlinking them all.
// ===========================================================================

const fit = (cx) => ({ kind: 'ellipse', cx, cy: 150, rx: 90, ry: 60 });
const box = (id, x) => ({ id, lineN: null, text: 'HI', x, y: 100, w: 120, h: 80, style: normalizeStyle(defaultStyle()), fit: fit(x + 60) });

beforeEach(() => {
  initHistory();
  resetHistory();
  loadProjectPages([{ id: 1, w: 1000, h: 800, lines: [], boxes: [box('a', 100), box('b', 400), box('c', 700)] }]);
});
afterEach(() => {
  app.selectedId = null;
  app.bulk.active = false;
  app.bulk.targets = [];
  resetHistory();
});

const linked = () => page().boxes.map((b) => !!bubbleLink(b));

describe('Clip to bubble', () => {
  it('links the selected box in one undo step, and leaves its layout alone', () => {
    app.selectedId = 'a';
    const geom = ({ x, y, w, h, fit }) => JSON.stringify({ x, y, w, h, fit });
    const before = geom(page().boxes[0]);
    expect(clipToBubble()).toBe(true);
    expect(linked()).toEqual([true, false, false]);
    expect(page().boxes[0].mask.on).toBe(true);
    expect(geom(page().boxes[0])).toBe(before);
    undo();
    expect(linked()).toEqual([false, false, false]);
    redo();
    expect(linked()).toEqual([true, false, false]);
  });

  it('acts on every box the Bulk panel picked, as one step', () => {
    app.bulk.active = true;
    app.bulk.targets = ['a', 'c'];
    expect(clipToBubble()).toBe(true);
    expect(linked()).toEqual([true, false, true]);
    undo();
    expect(linked()).toEqual([false, false, false]);
  });

  it('links the boxes that lack it when some have it, and unlinks all when all have it', () => {
    app.bulk.active = true;
    app.bulk.targets = ['a'];
    clipToBubble();
    app.bulk.targets = ['a', 'b'];
    clipToBubble();
    expect(linked()).toEqual([true, true, false]);
    clipToBubble();
    expect(linked()).toEqual([false, false, false]);
    // Each press was one step.
    undo();
    expect(linked()).toEqual([true, true, false]);
    undo();
    expect(linked()).toEqual([true, false, false]);
  });
});
