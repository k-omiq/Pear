// The shared edit layer: a style patch, many boxes in one edit, and the
// history's `group` kind with AI runs folded into one step per page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, loadProjectPages, page, editBoxes, settleEdits, moveLine, lineByN, setBoxText, cloneStyle } from './store.svelte.js';
import { initHistory, resetHistory, undo, redo, peekStack, inRun, record } from './editor/history.svelte.js';
import { applyStylePatch, resolveRelative } from './style-patch.js';
import { defaultStyle } from './data.js';

const copy = (v) => JSON.parse(JSON.stringify(v));
const box = (id, lineN, extra = {}) => ({ id, lineN, text: null, x: 10, y: 10, w: 200, h: 80, style: { ...defaultStyle(), size: 20 }, ...extra });
const fixture = () => [
  {
    id: 1, w: 800, h: 1200,
    lines: [{ n: 1, jp: 'あ', en: 'one' }, { n: 2, jp: 'い', en: 'two' }],
    boxes: [box('a', 1), box('b', 2, { x: 300 })],
  },
  { id: 2, w: 800, h: 1200, lines: [{ n: 1, jp: 'う', en: 'three' }], boxes: [box('c', 1)] },
];

beforeEach(() => {
  vi.useFakeTimers();
  app.chapterRef = null;
  app.chapterMode = 'typeset';
  loadProjectPages(fixture());
  initHistory();
  resetHistory();
});
afterEach(() => {
  settleEdits();
  resetHistory();
  loadProjectPages([]);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('applyStylePatch', () => {
  it('merges objects, resolves relative numbers and patches lists by index', () => {
    const base = { ...defaultStyle(), size: 20, strokes: [{ color: '#ffffff', width: 3, opacity: 1 }] };
    const { style, errors } = applyStylePatch(base, { size: '*1.5', gradient: { angle: 90 }, strokes: { 0: { width: '+2' } } });
    expect(errors).toEqual([]);
    expect(style.size).toBe(30);
    expect(style.gradient.angle).toBe(90);
    expect(style.gradient.kind).toBe(base.gradient.kind);
    expect(style.strokes).toEqual([{ color: '#ffffff', width: 5, opacity: 1 }]);
    expect(style.autoContrast).toBe(false);
  });

  it('replaces a list given whole', () => {
    const { style } = applyStylePatch(defaultStyle(), { strokes: [{ width: 6, color: '#000000' }, { width: 2, color: '#ffffff' }] });
    expect(style.strokes.map((s) => s.width)).toEqual([6, 2]);
  });

  it('changes nothing when any part is bad', () => {
    const base = defaultStyle();
    const { style, errors } = applyStylePatch(base, { size: '+2', strokes: { 4: { width: 1 } } });
    expect(errors).toHaveLength(1);
    expect(style).toEqual(applyStylePatch(base, {}).style);
    expect(resolveRelative('+2', 'Comic Neue')).toEqual({ error: expect.any(String) });
    expect(resolveRelative('Comic Neue', 3)).toBeNull();
  });
});

describe('editBoxes', () => {
  it('records one bulk entry per page for a style-only edit', () => {
    const [p1, p2] = app.pages;
    const targets = [{ page: p1, box: p1.boxes[0] }, { page: p1, box: p1.boxes[1] }, { page: p2, box: p2.boxes[0] }];
    const before = copy(p1.boxes);
    const changed = editBoxes(targets, (b) => {
      b.style = cloneStyle({ ...b.style, italic: true });
    });
    expect(changed).toHaveLength(3);
    // The live stack holds page 1's entry; page 2's went to its own stack (no
    // history file here, so it stays live too - two entries, one per page).
    const entries = peekStack().undo;
    expect(entries.map((e) => [e.t, e.pageId, e.items.length])).toEqual([['bulk', 1, 2], ['bulk', 2, 1]]);
    undo();
    undo();
    expect(copy(p1.boxes)).toEqual(before);
  });

  it('records a group when boxes change in more than style', () => {
    const p = page();
    const before = copy(p.boxes);
    editBoxes([{ page: p, box: p.boxes[0] }, { page: p, box: p.boxes[1] }], (b, pg) => {
      b.x += 15;
      setBoxText(b, 'NEW', pg, { fit: false });
    });
    const [e] = peekStack().undo;
    expect(e.t).toBe('group');
    expect(e.items.map((it) => it.t)).toEqual(['resize', 'text', 'resize', 'text']);
    expect(undo()).toBe(true);
    expect(copy(p.boxes)).toEqual(before);
    expect(redo()).toBe(true);
    expect(p.boxes.map((b) => [b.x, b.text])).toEqual([[25, 'NEW'], [315, 'NEW']]);
  });

  it('the bulk panel\'s apply stays one bulk entry, carrying lastStyle, when the fit moves a box', () => {
    const p = page();
    const before = copy(p.boxes);
    editBoxes([{ page: p, box: p.boxes[0] }], (b) => {
      b.style = cloneStyle({ ...b.style, italic: true });
      b.w += 40;
    }, { always: true, lastStyleBefore: { size: 1 }, lastStyleAfter: { size: 2 } });
    const [e] = peekStack().undo;
    expect(e).toMatchObject({ t: 'bulk', lastStyleBefore: { size: 1 }, lastStyleAfter: { size: 2 } });
    undo();
    expect(copy(p.boxes)).toEqual(before);
  });

  it('reads a free box\'s text off its own page, not the one on screen', () => {
    const p2 = app.pages[1];
    p2.lines.push({ n: -1, jp: '', en: 'free words' });
    p2.boxes.push(box('f', -1, { x: 400 }));
    const changed = editBoxes([{ page: p2, box: p2.boxes[1] }], (b, pg) => setBoxText(b, 'new words', pg, { fit: false }));
    expect(changed).toHaveLength(1);
    expect(peekStack().undo.at(-1)).toMatchObject({ t: 'text', pageId: 2, before: 'free words', after: 'new words' });
  });

  it('leaves out a box the mutation declines, and records nothing for no change', () => {
    const p = page();
    expect(editBoxes([{ page: p, box: p.boxes[0] }], () => false)).toEqual([]);
    expect(editBoxes([{ page: p, box: p.boxes[0] }], () => {})).toEqual([]);
    expect(peekStack().undo).toEqual([]);
  });
});

describe('a run is one undo step per page', () => {
  const italic = (b) => {
    b.style = cloneStyle({ ...b.style, italic: !b.style.italic });
  };

  it('folds every edit of the run on a page into one group', () => {
    const p = page();
    const start = copy(p.boxes);
    inRun('r1', () => editBoxes([{ page: p, box: p.boxes[0] }], italic));
    inRun('r1', () => editBoxes([{ page: p, box: p.boxes[1] }], (b) => void (b.x += 5)));
    const stack = peekStack().undo;
    expect(stack).toHaveLength(1);
    expect(stack[0]).toMatchObject({ t: 'group', run: 'r1' });
    expect(stack[0].items.map((it) => it.t)).toEqual(['bulk', 'resize']);
    expect(undo()).toBe(true);
    expect(copy(p.boxes)).toEqual(start);
  });

  it('a user edit on the page closes the group there', () => {
    const p = page();
    inRun('r1', () => editBoxes([{ page: p, box: p.boxes[0] }], italic));
    editBoxes([{ page: p, box: p.boxes[1] }], italic);
    inRun('r1', () => editBoxes([{ page: p, box: p.boxes[0] }], (b) => void (b.y += 5)));
    expect(peekStack().undo.map((e) => [e.t, e.run ?? null])).toEqual([['group', 'r1'], ['bulk', null], ['group', 'r1']]);
  });

  it('a walked group is sealed, and another run never joins it', () => {
    const p = page();
    inRun('r1', () => editBoxes([{ page: p, box: p.boxes[0] }], italic));
    undo();
    redo();
    inRun('r1', () => editBoxes([{ page: p, box: p.boxes[1] }], italic));
    inRun('r2', () => editBoxes([{ page: p, box: p.boxes[1] }], italic));
    expect(peekStack().undo.map((e) => [e.run, e.items.length])).toEqual([['r1', 1], ['r1', 1], ['r2', 1]]);
  });

  it('keeps line numbers in step through a renumber', () => {
    const p = page();
    inRun('r1', () => record({ t: 'line', pageId: 1, lineN: 2, before: 'two', after: 'TWO', boxes: [] }));
    lineByN(p, 2).en = 'TWO';
    expect(moveLine(2, 1)).toBe(true);
    const group = peekStack().undo.find((e) => e.t === 'group');
    expect(group.items[0].lineN).toBe(1);
    expect(undo()).toBe(true); // the order
    expect(undo()).toBe(true); // the group
    expect(lineByN(p, 2).en).toBe('two');
  });

  it('never holds an order entry', () => {
    const p = page();
    inRun('r1', () => moveLine(2, 1));
    expect(peekStack().undo.map((e) => e.t)).toEqual(['order']);
    expect(p.lines.map((l) => l.n)).toEqual([1, 2]);
  });
});
