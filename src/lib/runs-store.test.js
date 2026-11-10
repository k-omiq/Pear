// The faces beside a box's words (runs.js) through every writer of those
// words: loading and saving, typing and its history, the queue's field, the
// Inspector's record, a copy, a split, and the AI's text tool.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./library.svelte.js', async (orig) => ({ ...(await orig()), chapterOpenSeq: () => 1 }));

const store = await import('./store.svelte.js');
const { app, loadProjectPages, pageById, settleEdits, lineByN, setBoxText, setLineText, boxRuns, boxText, beginEdit, endEdit, recordEdit, boxSnap, boxEditRecords, duplicateBox, copyBox, pasteBox, selectBox, deselect } = store;
const { initHistory, resetHistory, undo, redo } = await import('./editor/history.svelte.js');
const { callContext, __resetRun } = await import('./agent/run.svelte.js');
const { callTool } = await import('./agent/registry.js');
const { defaultStyle } = await import('./data.js');
const { saveRuns } = await import('./runs.js');
await import('./agent/tools/index.js');

const B = (start, end) => ({ start, end, bold: true, italic: false });
const I = (start, end) => ({ start, end, bold: false, italic: true });
const box = (id, lineN, extra = {}) => ({ id, lineN, text: null, x: 100, y: 100, w: 200, h: 80, style: { ...defaultStyle(), size: 20 }, ...extra });
const call = (name, args) => callTool(name, args, callContext('mcp'));
const p1 = () => pageById(1);
const byId = (id) => p1().boxes.find((b) => b.id === id);
const plain = (v) => JSON.parse(JSON.stringify(v));

const doc = () => [
  {
    id: 1, w: 800, h: 1200,
    lines: [
      { n: 1, jp: 'あ', en: 'one two three', runs: [B(4, 7)], tags: [] },
      { n: 2, jp: 'い', en: 'plain words', tags: [] },
      { n: -1, type: 'dialogue', jp: '', en: 'free and bold', runs: [B(9, 13)] },
    ],
    boxes: [box('a', 1), box('b', 2), box('free', -1, { y: 300 }), box('own', 2, { text: 'its own words', runs: [I(0, 3)], y: 500 })],
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.chapterMode = 'typeset';
  loadProjectPages(doc());
  initHistory();
  resetHistory();
  __resetRun();
});
afterEach(() => {
  settleEdits();
  deselect();
  resetHistory();
  __resetRun();
  app.chapterRef = null;
  loadProjectPages([]);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('load and save', () => {
  it('loads an old chapter with no runs and saves it without the key', () => {
    const old = [{ id: 1, w: 800, h: 1200, lines: [{ n: 1, jp: 'x', en: 'hello' }], boxes: [box('a', 1), box('t', null, { text: 'own' })] }];
    loadProjectPages(plain(old));
    const p = p1();
    const lines = saveRuns(plain(p.lines), 'en');
    const boxes = saveRuns(plain(p.boxes), 'text');
    expect(JSON.stringify(lines)).not.toContain('runs');
    expect(JSON.stringify(boxes)).not.toContain('runs');
    expect(lines).toEqual([{ n: 1, jp: 'x', en: 'hello', placed: true }]);
  });

  it('normalises runs on load: cut to the text, none beside words the box does not own, none in the box face', () => {
    loadProjectPages([
      {
        id: 1, w: 800, h: 1200,
        lines: [{ n: 1, en: 'short', runs: [B(2, 99), { start: 'x' }] }],
        boxes: [
          box('a', 1, { runs: [B(0, 2)] }),
          box('t', null, { text: 'abc', runs: [B(0, 1), I(1, 3)], style: { ...defaultStyle(), size: 20, italic: true } }),
        ],
      },
    ]);
    expect(lineByN(p1(), 1).runs).toEqual([B(2, 5)]);
    expect('runs' in byId('a')).toBe(false);
    expect(byId('t').runs).toEqual([B(0, 1)]);
  });

  it('a box shows its line\'s runs, or its own beside its own words', () => {
    expect(boxRuns(byId('a'), p1())).toEqual([B(4, 7)]);
    expect(boxRuns(byId('b'), p1())).toBe(null);
    expect(boxRuns(byId('own'), p1())).toEqual([I(0, 3)]);
  });
});

describe('setBoxText', () => {
  it('shifts a free box\'s runs on its line', () => {
    setBoxText(byId('free'), 'free, and bold', p1(), { fit: false, span: [4, 4] });
    expect(lineByN(p1(), -1)).toMatchObject({ en: 'free, and bold', runs: [B(10, 14)] });
  });
  it('carries a queue box\'s line runs onto its first own words, and drops them with the override', () => {
    const a = byId('a');
    setBoxText(a, 'one two three!', p1(), { fit: false });
    expect(a.text).toBe('one two three!');
    expect(a.runs).toEqual([B(4, 7)]);
    // The line itself is untouched.
    expect(lineByN(p1(), 1).runs).toEqual([B(4, 7)]);
    setBoxText(a, null, p1(), { fit: false });
    expect('runs' in a).toBe(false);
    expect(boxRuns(a, p1())).toEqual([B(4, 7)]);
  });
  it('a split piece keeps the faces of its own words', () => {
    // What the split tool does: a copy per piece, then each box's piece.
    selectBox('a');
    const id = duplicateBox('a', p1(), { select: false });
    setBoxText(byId('a'), 'one two', p1(), { fit: false });
    setBoxText(byId(id), 'two three', p1(), { fit: false });
    expect(byId('a').runs).toEqual([B(4, 7)]);
    expect(boxRuns(byId(id), p1())).toEqual([B(0, 3)]);
  });
});

describe('copies', () => {
  it('a duplicate and a paste carry the words\' runs, each its own copy', () => {
    const d = duplicateBox('a', p1(), { select: false });
    const runs = boxRuns(byId(d), p1());
    expect(runs).toEqual([B(4, 7)]);
    expect(runs).not.toBe(lineByN(p1(), 1).runs);
    selectBox('own');
    copyBox('own');
    const pa = pasteBox();
    const pb = pasteBox();
    expect(boxRuns(byId(pa), p1())).toEqual([I(0, 3)]);
    expect(boxRuns(byId(pa), p1())).not.toBe(boxRuns(byId(pb), p1()));
  });
});

describe('history', () => {
  it('typing: one text entry, undo and redo put the runs back', () => {
    const b = byId('free');
    beginEdit('free');
    setBoxText(b, 'free bold', p1(), { span: [5, 9] });
    expect(lineByN(p1(), -1).runs).toEqual([B(5, 9)]);
    setBoxText(b, 'free', p1(), { span: [4, 9] });
    expect('runs' in lineByN(p1(), -1)).toBe(false);
    endEdit('free');
    undo();
    expect(lineByN(p1(), -1)).toMatchObject({ en: 'free and bold', runs: [B(9, 13)] });
    redo();
    expect(lineByN(p1(), -1).en).toBe('free');
    expect('runs' in lineByN(p1(), -1)).toBe(false);
  });

  it('the queue field: one line entry, and undo puts the runs back', () => {
    setLineText(p1(), 1, 'one three', { span: [4, 8] });
    expect('runs' in lineByN(p1(), 1)).toBe(false);
    settleEdits();
    undo();
    expect(lineByN(p1(), 1)).toMatchObject({ en: 'one two three', runs: [B(4, 7)] });
    redo();
    expect(lineByN(p1(), 1).en).toBe('one three');
    expect('runs' in lineByN(p1(), 1)).toBe(false);
  });

  it('the Inspector record carries the runs of both sides', () => {
    const b = byId('own');
    const before = boxSnap(b, p1());
    setBoxText(b, 'words', p1(), { fit: false });
    const after = boxSnap(b, p1());
    const entries = boxEditRecords({ pageId: 1, boxId: 'own' }, before, after, false);
    const text = entries.find((e) => e.t === 'text');
    expect(text).toMatchObject({ runsBefore: [I(0, 3)], runsAfter: null });
    for (const e of entries) recordEdit(e);
    undo();
    expect(b).toMatchObject({ text: 'its own words', runs: [I(0, 3)] });
  });

  it('an entry for words with no runs is written as before, with no runs keys', () => {
    const log = [];
    const off = store.setRecorder((e) => log.push(e));
    try {
      setLineText(p1(), 2, 'plain words!');
      settleEdits();
    } finally {
      off();
    }
    expect(log).toHaveLength(1);
    expect('runsBefore' in log[0]).toBe(false);
  });
});

describe('the AI text tool', () => {
  // Both calls are one AI run, which is one undo step a page.
  it('a line op shifts the line\'s runs, and its undo puts them back', async () => {
    const r = await call('text', { ops: [{ page: 1, line: 1, en: 'one two three four' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(lineByN(p1(), 1).runs).toEqual([B(4, 7)]);
    const w = await call('text', { ops: [{ page: 1, line: 1, en: 'zero one two three four' }] });
    expect(w.ok).toBe(true);
    expect(lineByN(p1(), 1).runs).toEqual([B(9, 12)]);
    settleEdits();
    undo();
    expect(lineByN(p1(), 1)).toMatchObject({ en: 'one two three', runs: [B(4, 7)] });
  });
  it('a box op on a box with its own words shifts its own runs', async () => {
    const r = await call('text', { ops: [{ id: 'own', text: 'its own new words' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(byId('own').runs).toEqual([I(0, 3)]);
    expect(boxText(byId('own'), p1())).toBe('its own new words');
  });
});
