// An AI run: one undo per page, Revert, Stop, and the pin to the open chapter.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let seq = 1;
vi.mock('../library.svelte.js', () => ({ chapterOpenSeq: () => seq }));

const { app, loadProjectPages, pageById, editBoxes, settleEdits, cloneStyle } = await import('../store.svelte.js');
const { initHistory, resetHistory, undo, peekStack } = await import('../editor/history.svelte.js');
const { callContext, revertRun, stopRun, aiRun, IDLE_MS, __resetRun } = await import('./run.svelte.js');
const { ToolError } = await import('./registry.js');
const { bindGuide, unbindGuide, guide, addTerm } = await import('../guide.svelte.js');
const { defaultStyle } = await import('../data.js');

const box = (id) => ({ id, lineN: null, text: 'hi', x: 10, y: 10, w: 100, h: 40, style: { ...defaultStyle(), size: 20 } });
const copy = (v) => JSON.parse(JSON.stringify(v));
const italic = (b) => void (b.style = cloneStyle({ ...b.style, italic: true }));

beforeEach(() => {
  vi.useFakeTimers();
  seq = 1;
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  loadProjectPages([
    { id: 1, w: 800, h: 1200, lines: [], boxes: [box('a'), box('b')] },
    { id: 2, w: 800, h: 1200, lines: [], boxes: [box('c')] },
  ]);
  initHistory();
  resetHistory();
  __resetRun();
});
afterEach(() => {
  settleEdits();
  resetHistory();
  __resetRun();
  unbindGuide();
  app.chapterRef = null;
  loadProjectPages([]);
  vi.clearAllTimers();
  vi.useRealTimers();
});

const write = (ctx, p, fn) => ctx.write([p], () => editBoxes(p.boxes.map((b) => ({ page: p, box: b })), fn));

describe('a run', () => {
  it('is one undo step per page', () => {
    const ctx = callContext('mcp');
    const p = pageById(1);
    const start = copy(p.boxes);
    write(ctx, p, italic);
    write(ctx, p, (b) => void (b.x += 3));
    expect(aiRun).toMatchObject({ active: true, edits: 2, pages: 1, canRevert: true });
    expect(peekStack().undo).toHaveLength(1);
    undo();
    expect(copy(p.boxes)).toEqual(start);
  });

  it('reverts every page it touched, over later edits, as an undoable step', () => {
    const ctx = callContext('mcp');
    const p1 = pageById(1);
    const p2 = pageById(2);
    const start1 = copy(p1.boxes);
    const start2 = copy(p2.boxes);
    write(ctx, p1, italic);
    write(ctx, p2, italic);
    // The user edits a box after the run.
    editBoxes([{ page: p1, box: p1.boxes[0] }], (b) => void (b.y += 50));
    expect(revertRun()).toBe(2);
    expect(copy(p1.boxes)).toEqual(start1);
    expect(copy(p2.boxes)).toEqual(start2);
    expect(aiRun.canRevert).toBe(false);
    // One restore per page; with no history file both sit on this stack.
    expect(peekStack().undo.slice(-2).map((e) => [e.t, e.pageId])).toEqual([['restore', 1], ['restore', 2]]);
    undo();
    undo();
    expect(p1.boxes[0].style.italic).toBe(true);
    expect(p1.boxes[0].y).toBe(60);
  });

  it('puts the series guide back too', () => {
    const saved = [];
    bindGuide({ glossary: [] }, (g) => saved.push(g));
    const ctx = callContext('mcp');
    ctx.writeGuide(() => addTerm({ source: '誠', target: 'Makoto' }));
    expect(guide.glossary).toHaveLength(1);
    revertRun();
    expect(guide.glossary).toHaveLength(0);
    expect(saved.at(-1).glossary).toEqual([]);
  });
});

describe('Stop', () => {
  it('keeps the work and refuses writes until the agent goes quiet', () => {
    const ctx = callContext('mcp');
    const p = pageById(1);
    write(ctx, p, italic);
    expect(stopRun()).toBe(true);
    expect(aiRun.active).toBe(false);
    expect(p.boxes[0].style.italic).toBe(true);
    expect(() => write(ctx, p, (b) => void (b.x += 1))).toThrow(ToolError);
    vi.advanceTimersByTime(IDLE_MS + 1);
    write(callContext("mcp"), p, (b) => void (b.x += 1));
    expect(aiRun.active).toBe(true);
  });
});

describe('a call that began before a Stop, a Revert or a door turned off', () => {
  it('writes nothing after it, and says so between its steps', () => {
    const ctx = callContext('mcp');
    const p = pageById(1);
    write(ctx, p, italic);
    expect(ctx.stillPinned()).toBe(true);
    revertRun();
    expect(ctx.stillPinned()).toBe(false);
    expect(() => write(ctx, p, (b) => void (b.x += 1))).toThrow(/stopped or reverted/);
    expect(aiRun.active).toBe(false);
  });

  it('a user edit still settling stays the user\'s own step', async () => {
    const { nudgeBox } = await import('../store.svelte.js');
    const p = pageById(1);
    nudgeBox('a', 5, 0);
    write(callContext('mcp'), p, italic);
    expect(peekStack().undo.map((e) => e.t)).toEqual(['move', 'group']);
  });
});

describe('Revert after detection', () => {
  it('puts the page\'s detection back too', () => {
    const p = pageById(1);
    const ctx = callContext('mcp');
    ctx.write([p], () => {});
    p.detect = { boxes: [{ n: 1, box: [0, 0, 10, 10] }] };
    p.lines = [{ n: 1, jp: 'x', en: '' }];
    revertRun();
    expect(p.detect).toBe(null);
    expect(p.lines).toEqual([]);
    undo();
    expect(p.detect.boxes).toHaveLength(1);
  });
});

describe('the pin to the open chapter', () => {
  it('ends the run and refuses its writes after a chapter switch', () => {
    const ctx = callContext('mcp');
    const p = pageById(1);
    write(ctx, p, italic);
    seq = 2;
    expect(() => write(ctx, p, (b) => void (b.x += 1))).toThrow(/chapter changed/);
    expect(aiRun.active).toBe(false);
    // Nor can the old run be reverted into the new chapter.
    expect(revertRun()).toBe(0);
  });

  it('refuses a write with no chapter open', () => {
    app.chapterRef = null;
    expect(() => write(callContext('mcp'), pageById(1), italic)).toThrow(/no chapter/);
  });
});
