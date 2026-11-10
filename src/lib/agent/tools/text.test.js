// The text tools: lines reads the chapter's words, text changes them - a
// line's English or source, or one box's own words - inside an AI run, one
// undo step per page, in translate mode too.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../library.svelte.js', async (orig) => ({ ...(await orig()), chapterOpenSeq: () => 1 }));

const { app, loadProjectPages, pageById, settleEdits, lineByN } = await import('../../store.svelte.js');
const { initHistory, resetHistory, undo, stepHere } = await import('../../editor/history.svelte.js');
const { callContext, revertRun, __resetRun } = await import('../run.svelte.js');
const { callTool } = await import('../registry.js');
const { defaultStyle } = await import('../../data.js');
await import('./index.js');

const box = (id, lineN, extra = {}) => ({ id, lineN, text: null, x: 100, y: 100, w: 200, h: 80, style: { ...defaultStyle(), size: 20 }, ...extra });
const call = (name, args) => callTool(name, args, callContext('mcp'));

beforeEach(() => {
  vi.useFakeTimers();
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.chapterMode = 'typeset';
  loadProjectPages([
    {
      id: 1, w: 800, h: 1200,
      lines: [
        { n: 1, jp: 'こんにちは', en: 'Helo there', tags: [] },
        { n: 2, jp: 'ドン', en: 'BOOM', tags: ['sfx'] },
        { n: 3, jp: 'まだ', en: '', tags: [] },
      ],
      boxes: [box('a', 1), box('b', 2), box('own', 2, { text: 'BO-', y: 400 })],
    },
  ]);
  initHistory();
  resetHistory();
  __resetRun();
});
afterEach(() => {
  settleEdits();
  resetHistory();
  __resetRun();
  app.chapterRef = null;
  loadProjectPages([]);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('lines', () => {
  it('reads every line with its source, English, tags and the boxes showing it', async () => {
    const r = await call('lines', {});
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const [p1] = r.result.pages;
    expect(p1.page).toBe(1);
    expect(p1.lines[0]).toMatchObject({ n: 1, jp: { untrusted: 'こんにちは' }, en: { untrusted: 'Helo there' }, boxes: ['a'] });
    expect(p1.lines[1]).toMatchObject({ n: 2, boxes: ['b', 'own'], ownText: [{ id: 'own', text: { untrusted: 'BO-' } }] });
    const open = await call('lines', { pages: 'all', untranslated: true });
    expect(open.result.pages[0].lines.map((l) => l.n)).toEqual([3]);
  });
});

describe('text', () => {
  it('changes a line\'s English, which its boxes draw, as one undo step', async () => {
    const r = await call('text', { ops: [{ page: 1, line: 1, en: 'Hello there' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.ops[0].changes[0]).toMatchObject({ line: 1, before: { untrusted: 'Helo there' }, after: { untrusted: 'Hello there' }, outcome: 'changed', boxes: ['a'] });
    expect(lineByN(pageById(1), 1).en).toBe('Hello there');
    expect(pageById(1).boxes.find((b) => b.id === 'a').text).toBeNull();
    settleEdits();
    undo();
    expect(lineByN(pageById(1), 1).en).toBe('Helo there');
  });

  it('fixes a source misread, and a box that draws its line changes it on the line', async () => {
    const r = await call('text', { ops: [{ page: 1, line: 2, jp: 'ドンッ' }, { id: 'b', text: 'BOOOM' }, { id: 'own', text: 'BOO-' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const p = pageById(1);
    expect(lineByN(p, 2).jp).toBe('ドンッ');
    expect(lineByN(p, 2).en).toBe('BOOOM');
    expect(r.result.ops[1].changes[0]).toMatchObject({ line: 2, via: 'b' });
    // A box with words of its own keeps them its own.
    expect(p.boxes.find((b) => b.id === 'own').text).toBe('BOO-');
  });

  it('checks every op before writing anything', async () => {
    const r = await call('text', { ops: [{ page: 1, line: 1, en: 'Fine' }, { page: 1, line: 9, en: 'Nope' }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no line 9/);
    expect(r.hint).toMatch(/1, 2, 3/);
    expect(lineByN(pageById(1), 1).en).toBe('Helo there');
  });

  it('leaves a locked box\'s words alone, and says so', async () => {
    pageById(1).boxes.find((b) => b.id === 'a').locked = true;
    const r = await call('text', { ops: [{ page: 1, line: 1, en: 'Changed' }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/locked/);
    const e = await call('edit', { ops: [{ where: { ids: ['a'] }, set: { text: 'Changed' } }] });
    expect(e.result.ops[0].changed).toEqual([]);
    expect(lineByN(pageById(1), 1).en).toBe('Helo there');
  });

  it('works in translate mode, where there are no boxes', async () => {
    app.chapterMode = 'translate';
    const r = await call('text', { ops: [{ page: 1, line: 3, en: 'Not yet.' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(lineByN(pageById(1), 3).en).toBe('Not yet.');
  });
});

describe('edit set.text', () => {
  it('on a box that draws its line, changes the line so the queue follows', async () => {
    const r = await call('edit', { ops: [{ where: { ids: ['a'] }, set: { text: 'Hi there' } }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.ops[0].changed).toEqual(['a']);
    expect(lineByN(pageById(1), 1).en).toBe('Hi there');
    expect(pageById(1).boxes.find((b) => b.id === 'a').text).toBeNull();
  });
});

// add_line, delete_line and set_line_box: a translate chapter's queue itself,
// through the typing pane's own store calls and history.
describe('the queue tools', () => {
  const ns = () => pageById(1).lines.map((l) => l.n);
  const snap = () => JSON.stringify({ lines: pageById(1).lines, boxes: pageById(1).boxes.map((b) => b.id) });
  beforeEach(() => {
    app.chapterMode = 'translate';
  });

  it('adds a free line with its words and box, as one undo step', async () => {
    const was = snap();
    const r = await call('add_line', { page: 1, en: 'Psst.', jp: 'ねえ', box: [100, 200, 300, 260] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.line).toMatchObject({ n: -1, label: 'T1', en: { untrusted: 'Psst.' }, jp: { untrusted: 'ねえ' }, box: [100, 200, 300, 260] });
    expect(pageById(1).activeLineN).toBe(-1);
    // lines reads it back with its label and box.
    const read = await call('lines', {});
    expect(read.result.pages[0].lines.at(-1)).toMatchObject({ n: -1, label: 'T1', box: [100, 200, 300, 260] });
    settleEdits();
    expect(undo()).toBe(true);
    expect(snap()).toBe(was);
  });

  it('deletes a numbered line, renumbers the rest and its boxes go with it; undo puts it all back', async () => {
    const was = snap();
    const r = await call('delete_line', { page: 1, line: 2 });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result).toMatchObject({ deleted: { n: 2, en: { untrusted: 'BOOM' } }, renumbered: { 3: 2 }, lines: [1, 2] });
    expect(lineByN(pageById(1), 2).jp).toBe('まだ');
    expect(pageById(1).boxes.map((b) => b.id)).toEqual(['a']);
    settleEdits();
    expect(undo()).toBe(true);
    expect(snap()).toBe(was);
  });

  it('deletes a free line without renumbering anything', async () => {
    await call('add_line', { page: 1 });
    const r = await call('delete_line', { page: 1, line: -1 });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.renumbered).toEqual({});
    expect(ns()).toEqual([1, 2, 3]);
  });

  it('draws, redraws and takes away a line\'s box', async () => {
    let r = await call('set_line_box', { page: 1, line: 3, box: [10, 20, 110, 70] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result).toMatchObject({ before: null, outcome: 'changed', line: { n: 3, box: [10, 20, 110, 70] } });
    r = await call('set_line_box', { page: 1, line: 3, box: [10, 20, 110, 70] });
    expect(r.result.outcome).toBe('nothing needed');
    r = await call('set_line_box', { page: 1, line: 3, box: null });
    expect(r.result).toMatchObject({ before: [10, 20, 110, 70], outcome: 'changed' });
    expect(lineByN(pageById(1), 3).rect).toBeUndefined();
  });

  it('refuses a box off the page, under 8 px or not four numbers, and changes nothing', async () => {
    const was = snap();
    const bad = [
      [[700, 0, 900, 50], /outside the page/],
      [[-1, 0, 50, 50], /outside the page/],
      [[0, 0, 7, 50], /under 8 px/],
      [[50, 50, 10, 10], /x1 < x2/],
      [[0, 0, 50], /four numbers/],
    ];
    for (const [box, msg] of bad) {
      const r = await call('set_line_box', { page: 1, line: 1, box });
      expect(r.ok, JSON.stringify(box)).toBe(false);
      expect(r.error).toMatch(msg);
      const a = await call('add_line', { page: 1, box });
      expect(a.ok).toBe(false);
    }
    expect(snap()).toBe(was);
  });

  it('maps nothing when the last numbered line goes', async () => {
    const r = await call('delete_line', { page: 1, line: 3 });
    expect(r.result).toMatchObject({ renumbered: {}, lines: [1, 2] });
  });

  it('refuses a page or line that is not a whole number', async () => {
    for (const [name, args] of [
      ['add_line', { page: 1.5 }],
      ['add_line', { page: '1' }],
      ['delete_line', { page: 1, line: 2.5 }],
      ['delete_line', { page: 1, line: '2' }],
      ['set_line_box', { page: 1, line: 1.5, box: null }],
    ]) {
      const r = await call(name, args);
      expect(r.ok, JSON.stringify(args)).toBe(false);
    }
    expect(ns()).toEqual([1, 2, 3]);
  });

  it('lets the user undo the agent\'s line changes in translate mode, through the gate', async () => {
    const was = snap();
    await call('add_line', { page: 1, en: 'x', box: [0, 0, 50, 50] });
    settleEdits();
    expect(stepHere('undo')).toBe(true);
    expect(snap()).toBe(was);
    await call('add_line', { page: 1 });
    await call('set_line_box', { page: 1, line: -1, box: [0, 0, 60, 60] });
    await call('text', { ops: [{ page: 1, line: 3, en: 'Not yet.' }] });
    await call('delete_line', { page: 1, line: -1 });
    settleEdits();
    // The run folded its steps on the page into one group of line steps.
    expect(stepHere('undo')).toBe(true);
    expect(snap()).toBe(was);
  });

  it('refuses a missing line, a locked one, and a typeset chapter', async () => {
    let r = await call('delete_line', { page: 1, line: 9 });
    expect([r.ok, r.error]).toEqual([false, 'page 1 has no line 9']);
    pageById(1).boxes.find((b) => b.id === 'a').locked = true;
    r = await call('delete_line', { page: 1, line: 1 });
    expect(r.error).toMatch(/locked/);
    r = await call('add_line', { page: 2 });
    expect(r.error).toMatch(/page must be a page 1-1/);
    app.chapterMode = 'typeset';
    for (const [name, args] of [['add_line', { page: 1 }], ['delete_line', { page: 1, line: 2 }], ['set_line_box', { page: 1, line: 2, box: null }]]) {
      r = await call(name, args);
      expect(r.error).toBe('this is not a translate chapter');
    }
    expect(ns()).toEqual([1, 2, 3]);
  });

  it('Revert takes back every queue change of the run', async () => {
    const was = snap();
    await call('add_line', { page: 1, en: 'x', box: [0, 0, 50, 50] });
    await call('delete_line', { page: 1, line: 1 });
    await call('set_line_box', { page: 1, line: 1, box: [0, 0, 60, 60] });
    revertRun();
    expect(snap()).toBe(was);
  });
});
