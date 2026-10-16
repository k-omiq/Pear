import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, loadProjectPages, pageCheckItems, CHECK_REASONS, reviewOf, settleEdits } from '../store.svelte.js';
import { initHistory, resetHistory } from '../editor/history.svelte.js';
import { bindGuide, unbindGuide } from '../guide.svelte.js';
import { bindTags, unbindTags } from '../tags.svelte.js';
import { selectBoxes, parsePages, boxRow } from './select.js';
import { ToolError } from './registry.js';
import { isFenced } from './fence.js';

const originalFonts = app.fonts;
const rect = { kind: 'rect', x: 0, y: 0, w: 200, h: 120 };
const box = (id, lineN, style = {}, extra = {}) => ({
  id, lineN, x: 10.4, y: 20.6, w: 100.2, h: 70.5,
  style: { font: 'Comic Neue', size: 24, ...style }, ...extra,
});
const fixture = () => [
  {
    id: 100, w: 800, h: 1200,
    lines: [
      { n: 1, jp: '真琴', en: 'Hello—stranger', type: 'narration' },
      { n: 2, jp: 'ドン', en: 'BANG!', tags: ['sfx', 'scream'] },
      { n: 3, jp: '空', en: '' },
    ],
    boxes: [
      box('b1', 1, { font: 'Anime Ace', size: 20, rotation: 12.5 }, { fit: rect }),
      box('b2', 2, { font: 'Bangers', size: 40 }, { outline: { open: true, source: 'box' } }),
      box('b3', null, { font: 'Missing Font', size: 12 }, { text: 'Free text' }),
      box('b4', 3),
    ],
  },
  {
    id: 200, w: 800, h: 1200,
    lines: [
      { n: 1, en: 'Second PAGE', tags: ['narration'] },
      { n: 2, en: 'whoosh', type: 'sfx' },
      { n: 3, en: '', tags: ['scream'] },
    ],
    boxes: [
      box('b5', 1, { font: 'Anime Ace', size: 30 }, { fit: rect, outline: { approved: 'user', source: 'manual' } }),
      box('b6', 2, {}, { fit: rect, outline: { approved: 'ai', source: 'ring' } }),
      box('b7', 3, { ink: { on: true, strokes: [{ pts: [[0, 0, 1], [10, 10, 1]] }] } }),
      box('b8', null, { sfx: { on: true, moves: [{ kind: 'step', a: 0.1, b: 0 }] } }, { text: 'SWISH' }),
      box('b9', null, { ink: { on: true, strokes: [] } }, { text: 'Plain' }),
    ],
  },
  {
    id: 300, w: 800, h: 1200, boxes: [],
    lines: [{ n: 1, jp: '未訳', en: '' }], detect: { boxes: [{ n: 1, box: [0, 0, 100, 100] }] },
  },
];
const ids = (where) => selectBoxes(where).matches.map((m) => m.box.id);

beforeEach(() => {
  vi.useFakeTimers();
  app.chapterRef = null;
  app.chapterMode = 'typeset';
  app.fonts = { ...originalFonts, user: [{ name: 'Anime Ace', css: 'sans-serif' }], system: [] };
  app.bulk.active = false;
  app.bulk.targets = [];
  bindGuide({ glossary: [{ source: '真琴', target: 'Makoto', character: true }], rules: { dashes: 'ascii' } });
  bindTags({ list: [{ name: 'saved-only', style: { font: 'Bangers' }, size: 32, minSize: 14 }] });
  initHistory();
  resetHistory();
  loadProjectPages(fixture());
  // Runtime review/stamp changes after load: the selector must read live checks.
  app.pages[0].boxes[1].review = { kind: 'overflow', overflow: { l: 2, t: 0, r: 0, b: 0 }, reason: 'sized by hand' };
  app.pages[1].boxes[0].auto = { on: true, refSize: 30, status: 'ok', stamp: 'old-layout' };
});

afterEach(() => {
  settleEdits();
  resetHistory();
  loadProjectPages([]);
  unbindGuide();
  unbindTags();
  app.fonts = originalFonts;
  app.bulk.active = false;
  app.bulk.targets = [];
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('parsePages', () => {
  it('resolves current and all as live pages and retains empty pages', () => {
    app.pageIndex = 1;
    expect(parsePages()).toEqual([app.pages[1]]);
    expect(parsePages('current')[0]).toBe(app.pages[1]);
    expect(parsePages('all')).toEqual(app.pages);
    expect(parsePages([])).toEqual([]);
  });

  it.each([
    ['2-5', [2, 3, 4, 5]], ['3', [3]], ['1,3,7-9', [1, 3, 7, 8, 9]],
    [' 3, 1 - 2, 2 ', [1, 2, 3]], [[3, 1, 3, 2], [1, 2, 3]],
  ])('parses %j as deduplicated 1-based pages in document order', (spec, expected) => {
    loadProjectPages(Array.from({ length: 9 }, (_, i) => ({ id: i + 101, lines: [], boxes: [] })));
    expect(parsePages(spec).map((p) => app.pages.indexOf(p) + 1)).toEqual(expected);
  });

  it.each(['0', '4', '1-4', [0], [4], [1.5], [Infinity]])('names the page count for out-of-range %j', (spec) => {
    expect(() => parsePages(spec)).toThrow(/3 pages/);
    try { parsePages(spec); } catch (err) { expect(err).toBeInstanceOf(ToolError); expect(err.hint).toContain('1-based'); }
  });

  it.each(['', '2-1', '1,,2', '1.5', 'one', '1-2-3', null, {}, 2, ['2']])('rejects malformed %j with a hint', (spec) => {
    expect(() => parsePages(spec)).toThrow(ToolError);
    try { parsePages(spec); } catch (err) { expect(err.hint).toBeTruthy(); }
  });

  it('handles an empty document without returning the store’s stand-in page', () => {
    loadProjectPages([]);
    expect(parsePages()).toEqual([]);
    expect(parsePages('all')).toEqual([]);
    expect(() => parsePages('1')).toThrow(/0 pages/);
    expect(selectBoxes()).toEqual({ matches: [], pages: [] });
  });
});

describe('selectBoxes', () => {
  it('defaults to the current page and exposes live page, box and line references', () => {
    app.pageIndex = 1;
    const { matches, pages } = selectBoxes();
    expect(matches.map((m) => m.box.id)).toEqual(['b5', 'b6', 'b7', 'b8', 'b9']);
    expect(pages).toEqual([app.pages[1]]);
    expect(matches[0].page).toBe(app.pages[1]);
    expect(matches[0].pageIndex).toBe(1);
    expect(matches[0].box).toBe(app.pages[1].boxes[0]);
    expect(matches[0].line).toBe(app.pages[1].lines[0]);
    expect(matches[3].line).toBeNull();
  });

  it('orders ids by document order and ANDs explicit page scope', () => {
    expect(ids({ ids: ['b9', 'b1', 'b5', 'b1'] })).toEqual(['b1', 'b5', 'b9']);
    expect(ids({ pages: '2', ids: ['b1', 'b5'] })).toEqual(['b5']);
    expect(ids({ ids: [] })).toEqual([]);
    expect(selectBoxes({ pages: '3' })).toEqual({ matches: [], pages: [app.pages[2]] });
  });

  it('combines the selected box with active bulk targets, ignoring stale selections', () => {
    app.selectedId = 'b6';
    app.bulk.targets = ['b1', 'b6', 'gone'];
    expect(ids({ selection: true })).toEqual(['b6']);
    app.bulk.active = true;
    expect(ids({ selection: true })).toEqual(['b1', 'b6']);
    expect(ids({ pages: 'current', selection: true })).toEqual(['b1']);
    expect(ids({ ids: ['b5', 'b6'], selection: true })).toEqual(['b6']);
    app.selectedId = null;
    app.bulk.active = false;
    expect(ids({ selection: true })).toEqual([]);
  });

  const filters = [
    [{ tag: 'narration' }, ['b1', 'b5']],
    [{ tag: ['sfx', 'scream'] }, ['b2', 'b6', 'b7']],
    [{ tag: 'SFX' }, ['b2', 'b6']],
    [{ tag: 'saved-only' }, []],
    [{ tag: [] }, []],
    [{ text: 'hello|second' }, ['b1', 'b5']],
    [{ text: '^free text$' }, ['b3']],
    [{ font: 'ANIME ace' }, ['b1', 'b5']],
    [{ size: { min: 20, max: 30 } }, ['b1', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9']],
    [{ size: { min: 30 } }, ['b2', 'b5']],
    [{ size: { max: 12 } }, ['b3']],
    [{ outline: 'unapproved' }, ['b1']],
    [{ outline: 'open' }, ['b2']],
    [{ outline: 'ai' }, ['b6']],
    [{ outline: 'user' }, ['b5']],
    [{ kind: 'text' }, ['b1', 'b3', 'b4', 'b5', 'b9']],
    [{ kind: 'sfx' }, ['b2', 'b6', 'b8']],
    [{ kind: 'ink' }, ['b7']],
    [{ flagged: 'guide' }, ['b1']],
    [{ flagged: 'overflow' }, ['b2']],
  ];
  it.each(filters)('applies %j', (filter, expected) => {
    expect(ids({ pages: 'all', ...filter })).toEqual(expected);
  });

  it.each(filters)('negates %j across the whole parent scope', (filter, excluded) => {
    const all = ids({ pages: 'all' });
    expect(ids({ pages: 'all', not: filter })).toEqual(all.filter((id) => !excluded.includes(id)));
  });

  it('uses displayed box text rather than only the linked line', () => {
    app.pages[0].boxes[0].text = 'Override';
    expect(ids({ text: 'hello' })).toEqual([]);
    expect(ids({ text: 'override' })).toEqual(['b1']);
  });

  it('ANDs filters, including nested exclusions with pages, ids and selection', () => {
    expect(ids({ pages: 'all', tag: 'narration', font: 'anime ace', size: { min: 25 }, text: 'page', outline: 'user', kind: 'text' })).toEqual(['b5']);
    expect(ids({ pages: 'all', not: { pages: '2', not: { ids: ['b6'] } } })).toEqual(['b1', 'b2', 'b3', 'b4', 'b6']);
    app.selectedId = 'b5';
    expect(ids({ pages: 'all', tag: 'narration', not: { selection: true } })).toEqual(['b1']);
  });

  it.each(CHECK_REASONS)('supports check reason %s and skips line-only items', (reason) => {
    const expected = app.pages.flatMap((p, i) => {
      const items = pageCheckItems(p, i);
      return p.boxes.filter((b) => reason === 'overflow' ? reviewOf(b, p) : items.some((it) => it.boxId === b.id && it.reason === reason)).map((b) => b.id);
    });
    expect(ids({ pages: 'all', flagged: reason })).toEqual(expected);
    if (['english', 'unplaced'].includes(reason)) {
      expect(pageCheckItems(app.pages[2], 2).some((it) => it.reason === reason)).toBe(true);
      expect(expected).toEqual([]);
    }
  });

  it('flagged true includes every box check, but never returns unplaced lines', () => {
    expect(ids({ pages: 'all', flagged: true })).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
    expect(ids({ pages: 'all', flagged: 'empty' })).toEqual(['b4']);
    expect(ids({ pages: 'all', flagged: 'stale' })).toEqual(['b5']);
  });

  it('keeps guide checks only on the first box of a split line', () => {
    const p = app.pages[0];
    p.boxes.push({ ...p.boxes[0], id: 'split', text: 'second half' });
    expect(ids({ flagged: 'guide' })).toEqual(['b1']);
    p.boxes[4].text = 'Makoto';
    expect(ids({ flagged: 'glossary' })).toEqual([]);
    expect(ids({ flagged: 'rules' })).toEqual(['b1']);
  });

  it.each([
    null, [], 'all', { typo: true }, { ids: 'b1' }, { ids: [1] }, { ids: ['b10'] },
    { selection: false }, { tag: 'narratio' }, { tag: ['sfx', 'missing'] }, { tag: 1 },
    { text: '[' }, { text: 2 }, { font: null }, { size: null }, { size: { min: NaN } },
    { size: { max: Infinity } }, { size: { min: '20' } }, { size: { min: 30, max: 20 } },
    { size: { minimum: 20 } }, { flagged: false }, { flagged: 'manual' }, { outline: 'waiting' },
    { kind: 'drawing' }, { not: null }, { pages: 'all', not: { tag: 'missing' } },
  ])('rejects bad selector %j with a corrective hint', (where) => {
    expect(() => selectBoxes(where)).toThrow(ToolError);
    try { selectBoxes(where); } catch (err) { expect(err.hint).toEqual(expect.any(String)); expect(err.hint.length).toBeGreaterThan(0); }
  });

  it('suggests nearby ids, known tags and valid selector keys', () => {
    for (const [where, hint] of [[{ ids: ['b10'] }, 'b1'], [{ tag: 'narratio' }, 'narration'], [{ pagse: 'all' }, 'pages']]) {
      try { selectBoxes(where); } catch (err) { expect(err.hint).toContain(hint); }
    }
  });
});

describe('boxRow', () => {
  it('returns compact geometry and flags with a fenced preview', () => {
    const row = boxRow(selectBoxes({ ids: ['b1'] }).matches[0]);
    expect(row).toEqual({
      id: 'b1', page: 1, line: 1, tags: ['narration'], text: { untrusted: 'Hello—stranger' },
      rect: [10, 21, 100, 71], rotation: 12.5, font: 'Anime Ace', size: 20,
      flags: ['outline', 'glossary', 'rules'],
    });
    expect(isFenced(row.text)).toBe(true);
  });

  it('caps only the preview and reports a null line for canvas-only boxes', () => {
    app.pages[0].boxes[2].text = 'x'.repeat(100);
    const row = boxRow(selectBoxes({ ids: ['b3'] }).matches[0]);
    expect(row.line).toBeNull();
    expect(row.tags).toEqual([]);
    expect(row.rotation).toBe(0);
    expect(row.text).toEqual({ untrusted: `${'x'.repeat(80)}…` });
    expect(app.pages[0].boxes[2].text).toHaveLength(100);
  });
});
