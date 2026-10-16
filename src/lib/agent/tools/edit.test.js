// edit and add: checked first, then written through the store inside the run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let seq = 1;
vi.mock('../../library.svelte.js', async (orig) => ({ ...(await orig()), chapterOpenSeq: () => seq }));

const { app, loadProjectPages, pageById, settleEdits } = await import('../../store.svelte.js');
const { initHistory, resetHistory, undo, peekStack } = await import('../../editor/history.svelte.js');
const { callContext, revertRun, stopRun, __resetRun } = await import('../run.svelte.js');
const { callTool } = await import('../registry.js');
const { bindTags, unbindTags } = await import('../../tags.svelte.js');
const { bindGuide, unbindGuide } = await import('../../guide.svelte.js');
const { presets } = await import('../../presets.svelte.js');
const { defaultStyle } = await import('../../data.js');
await import('./edit.js');
await import('./place.js');

const copy = (v) => JSON.parse(JSON.stringify(v));
const box = (id, lineN, extra = {}) => ({ id, lineN, text: null, x: 10, y: 10, w: 160, h: 60, style: { ...defaultStyle(), size: 20 }, ...extra });
const originalFonts = app.fonts;
const originalPresets = presets.list;

const call = (args) => callTool('edit', args, callContext('mcp'));

beforeEach(() => {
  vi.useFakeTimers();
  seq = 1;
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.chapterMode = 'typeset';
  app.fonts = { user: [{ name: 'Anime Ace' }], builtin: [{ name: 'Comic Neue' }], system: [] };
  presets.list = [{ id: 'pr1', name: 'Narrator', style: { ...defaultStyle(), font: 'Anime Ace', italic: true, rotation: 30 } }];
  bindTags({ list: [{ name: 'narration', style: { italic: true }, size: 30, minSize: 16 }] });
  bindGuide({ rules: { dashes: 'ascii', ellipsis: 'dots' } }, () => {});
  loadProjectPages([
    {
      id: 1, w: 800, h: 1200,
      lines: [{ n: 1, en: 'Hello there…', tags: [] }, { n: 2, en: 'Second line', tags: [] }, { n: 3, en: 'Not placed', tags: [] }],
      boxes: [box('a', 1), box('b', 2, { y: 200 })],
    },
    { id: 2, w: 800, h: 1200, lines: [{ n: 1, en: 'Page two', tags: [] }], boxes: [box('c', 1)] },
  ]);
  initHistory();
  resetHistory();
  __resetRun();
});
afterEach(() => {
  settleEdits();
  resetHistory();
  __resetRun();
  unbindTags();
  unbindGuide();
  app.fonts = originalFonts;
  presets.list = originalPresets;
  app.chapterRef = null;
  loadProjectPages([]);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('edit', () => {
  it('styles many boxes on many pages, one undo per page, with relative values', async () => {
    const start = copy(app.pages.map((p) => p.boxes));
    const r = await call({ ops: [{ where: { pages: 'all' }, set: { style: { size: '+4', font: 'anime ace' } } }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.ops[0]).toMatchObject({ matched: 3, changed: ['a', 'b', 'c'] });
    expect(Array.isArray(r.result.ops[0].checks)).toBe(true);
    for (const p of app.pages) for (const b of p.boxes) expect(b.style.font).toBe('Anime Ace');
    expect(pageById(1).boxes[0].style.size).toBe(24);
    // One step per page; with no history file the test's pages share a stack.
    expect(peekStack().undo).toHaveLength(2);
    undo();
    undo();
    expect(copy(app.pages.map((p) => p.boxes))).toEqual(start);
  });

  it('a bad value anywhere changes nothing and says what is close', async () => {
    const start = copy(app.pages.map((p) => p.boxes));
    const r = await call({
      ops: [
        { where: { pages: 'all' }, set: { style: { italic: true } } },
        { where: { pages: 'all' }, set: { style: { font: 'Anime Aec' } } },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ops\[1\].*no font "Anime Aec"/);
    expect(r.hint).toMatch(/Anime Ace/);
    expect(copy(app.pages.map((p) => p.boxes))).toEqual(start);
    expect(peekStack().undo).toHaveLength(0);
  });

  it('refuses unknown keys, actions and lock names with hints', async () => {
    const bad = [
      [{ where: {}, set: { colour: '#fff' } }, /unknown key/],
      [{ where: {}, do: 'refti' }, /unknown action/],
      [{ where: {}, set: { locks: { sise: true } } }, /unknown lock/],
      [{ where: {}, do: 'match_angle' }, /not here yet/],
      [{ set: { text: 'x' } }, /needs a where/],
      [{ where: {}, set: { style: { size: 9999 } } }, /set\.style\.size/],
    ];
    for (const [op, re] of bad) {
      const r = await call({ ops: [op] });
      expect(r.ok, JSON.stringify(op)).toBe(false);
      expect(r.error).toMatch(re);
    }
  });

  it('0 matched is a result', async () => {
    const r = await call({ ops: [{ where: { text: 'nothing like this' }, set: { style: { italic: true } } }] });
    expect(r.ok).toBe(true);
    expect(r.result.ops[0]).toMatchObject({ matched: 0, changed: [] });
  });

  it('dryRun counts and writes nothing', async () => {
    const r = await call({ ops: [{ where: { pages: 'all' }, do: 'delete' }], dryRun: true });
    expect(r.result).toEqual({ dryRun: true, ops: [{ matched: 3, ids: ['a', 'b', 'c'] }] });
    expect(app.pages.flatMap((p) => p.boxes)).toHaveLength(3);
  });

  it('text, geometry and tags; tags bring the tag style', async () => {
    const r = await call({
      ops: [
        { where: { ids: ['a'] }, set: { text: 'New words', geometry: { x: '+20', rotation: 370 } } },
        { where: { ids: ['b'] }, set: { tags: ['Narration'] } },
      ],
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const [a, b] = pageById(1).boxes;
    expect(a.text).toBe('New words');
    expect(a.x).toBe(30);
    expect(a.style.rotation).toBe(10);
    expect(pageById(1).lines[1].tags).toEqual(['narration']);
    expect(b.style.italic).toBe(true);
  });

  it('presets keep the box rotation; apply_guide fixes the text rules', async () => {
    const r = await call({ ops: [{ where: { ids: ['a'] }, do: 'preset:narrator' }, { where: { ids: ['a'] }, do: 'apply_guide' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const a = pageById(1).boxes[0];
    expect(a.style.italic).toBe(true);
    expect(a.style.rotation).toBe(0);
    expect(a.text).toBe('Hello there...');
  });

  it('duplicate and delete on a page not on screen, nothing selected', async () => {
    app.selectedId = 'a';
    const r = await call({ ops: [{ where: { ids: ['c'] }, do: 'duplicate' }, { where: { ids: ['c'] }, do: 'delete' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.ops[0].created).toHaveLength(1);
    expect(r.result.ops[1].deleted).toEqual(['c']);
    expect(pageById(2).boxes.map((b) => b.id)).toEqual(r.result.ops[0].created);
    expect(app.selectedId).toBe('a');
    expect(app.pageIndex).toBe(0);
  });

  it('approve_outline approves as ai and says which had nothing to approve', async () => {
    pageById(1).boxes[0].fit = { kind: 'rect', x: 10, y: 10, w: 160, h: 60 };
    const r = await call({ ops: [{ where: { ids: ['a', 'b'] }, do: 'approve_outline' }] });
    expect(r.result.ops[0].changed).toEqual(['a']);
    expect(r.result.ops[0].notApproved.count).toBe(1);
    expect(pageById(1).boxes[0].outline.approved).toBe('ai');
  });

  it('approve_outline leaves an outline the user approved as theirs', async () => {
    const a = pageById(1).boxes[0];
    a.fit = { kind: 'rect', x: 10, y: 10, w: 160, h: 60 };
    a.outline = { source: 'manual', confidence: 1, approved: 'user' };
    const r = await call({ ops: [{ where: { ids: ['a'] }, do: 'approve_outline' }] });
    expect(r.result.ops[0].changed).toEqual([]);
    expect(a.outline.approved).toBe('user');
  });

  it('Stop refuses the next edit; Revert puts the pages back', async () => {
    const start = copy(app.pages.map((p) => p.boxes));
    await call({ ops: [{ where: { pages: 'all' }, set: { style: { bold: true } } }] });
    stopRun();
    const r = await call({ ops: [{ where: { pages: 'all' }, set: { style: { italic: true } } }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stopped/);
    revertRun();
    expect(copy(app.pages.map((p) => p.boxes))).toEqual(start);
  });

  it('a chapter switch mid-run ends it', async () => {
    await call({ ops: [{ where: { ids: ['a'] }, set: { style: { bold: true } } }] });
    seq = 2;
    const r = await call({ ops: [{ where: { ids: ['a'] }, set: { style: { italic: true } } }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/chapter changed/);
    expect(pageById(1).boxes[0].style.italic).toBe(false);
  });
});

describe('add', () => {
  it('places an unplaced line in a rect, one undo step', async () => {
    const r = await callTool('add', { page: 1, line: 3, rect: [300, 400, 200, 80] }, callContext('mcp'));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const b = pageById(1).boxes.find((x) => x.id === r.result.id);
    expect(b).toMatchObject({ lineN: 3, x: 300, y: 400, w: 200 });
    undo();
    expect(pageById(1).boxes.some((x) => x.id === r.result.id)).toBe(false);
  });

  it('adds free text at a point; refuses a placed line', async () => {
    const r = await callTool('add', { page: 2, text: 'Free words', at: [400, 600] }, callContext('mcp'));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(pageById(2).boxes).toHaveLength(2);
    const bad = await callTool('add', { page: 1, line: 1, at: [50, 50] }, callContext('mcp'));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/already has a box/);
  });
});
