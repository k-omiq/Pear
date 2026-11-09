// edit and add: checked first, then written through the store inside the run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let seq = 1;
vi.mock('../../library.svelte.js', async (orig) => ({ ...(await orig()), chapterOpenSeq: () => seq }));

const { app, loadProjectPages, pageById, settleEdits, pageCheckItems } = await import('../../store.svelte.js');
const { initHistory, resetHistory, undo, peekStack } = await import('../../editor/history.svelte.js');
const { callContext, revertRun, stopRun, __resetRun } = await import('../run.svelte.js');
const { callTool } = await import('../registry.js');
const { bindTags, unbindTags } = await import('../../tags.svelte.js');
const { bindGuide, unbindGuide } = await import('../../guide.svelte.js');
const { presets } = await import('../../presets.svelte.js');
const { defaultStyle, normalizeStyle, newStrokeEffect } = await import('../../data.js');
const { warpPresetPts } = await import('../../warp-presets.js');
const { WARP_DEFAULT_AMOUNT } = await import('./edit.js');
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
    // A box that draws its line takes new words on the line.
    expect(a.text).toBeNull();
    expect(pageById(1).lines.find((l) => l.n === a.lineN).en).toBe('New words');
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

// F53: a stored stroke effect list holding a picked pattern can be sent back
// whole, with an item added or removed; its tile cannot be changed or put on
// a box that does not hold it.
describe('edit: a read-only field echoed as stored', () => {
  const picked = { kind: 'picked', src: '0123456789abcdef0123456789abcdef.png', cell: [8, 0, 0, 8] };
  const pickStroke = () => ({ ...newStrokeEffect(), fill: 'pattern', pattern: { ...newStrokeEffect().pattern, ...picked } });
  beforeEach(() => {
    pageById(1).boxes[0].style = normalizeStyle({ ...pageById(1).boxes[0].style, strokeEffects: [pickStroke()] });
    pageById(1).boxes[1].style = normalizeStyle({ ...pageById(1).boxes[1].style, strokeEffects: [newStrokeEffect()] });
  });

  it('adds an item to the stored list sent back whole, the picked tile kept', async () => {
    const list = copy(pageById(1).boxes[0].style.strokeEffects);
    const r = await call({ ops: [{ where: { ids: ['a'] }, set: { style: { strokeEffects: [...list, { size: 2 }] } } }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const got = pageById(1).boxes[0].style.strokeEffects;
    expect(got).toHaveLength(2);
    expect(got[0].pattern).toMatchObject(picked);
  });

  it('refuses the same list on a box that does not hold the tile, in one op over both', async () => {
    const start = copy(app.pages.map((p) => p.boxes));
    const list = copy(pageById(1).boxes[0].style.strokeEffects);
    const r = await call({ ops: [{ where: { ids: ['a', 'b'] }, set: { style: { strokeEffects: list } } }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/strokeEffects\[0\]\.pattern\.kind: expected one of/);
    expect(copy(app.pages.map((p) => p.boxes))).toEqual(start);
  });

  it('refuses a tile the box does not hold', async () => {
    const list = copy(pageById(1).boxes[0].style.strokeEffects);
    list[0].pattern.src = 'ffffffffffffffffffffffffffffffff.png';
    const r = await call({ ops: [{ where: { ids: ['a'] }, set: { style: { strokeEffects: list } } }] });
    expect(r.ok).toBe(false);
    expect(pageById(1).boxes[0].style.strokeEffects[0].pattern.src).toBe(picked.src);
  });
});

describe('edit: size, geometry and lines for the solver', () => {
  const auto = { refSize: 20, locks: { size: false, width: false, height: false, pos: false, breaks: false } };
  beforeEach(() => {
    const b = pageById(1).boxes[0];
    b.auto = copy(auto);
  });
  const a = () => pageById(1).boxes[0];

  it('takes a size as the size aimed for, not a lock', async () => {
    const r = await call({ ops: [{ where: { ids: ['a'] }, set: { style: { size: 24 } } }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(a().auto.refSize).toBe(24);
    expect(a().auto.locks.size).toBe(false);
  });

  it('sets the size aimed for and the least size', async () => {
    const r = await call({ ops: [{ where: { ids: ['a'] }, set: { sizing: { ref: 18, min: 14 } } }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(a().auto).toMatchObject({ refSize: 18, minSize: 14 });
    await call({ ops: [{ where: { ids: ['a'] }, set: { sizing: { min: null } } }] });
    expect('minSize' in a().auto).toBe(false);
    const bad = await call({ ops: [{ where: { ids: ['a'] }, set: { sizing: { ref: 12, min: 14 } } }] });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/min is above ref/);
  });

  it('holds the width, height and centre it was given', async () => {
    const r = await call({ ops: [{ where: { ids: ['a'] }, set: { geometry: { x: 40, w: 120, h: 80 } } }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(a().auto.locks).toMatchObject({ width: true, height: true, pos: true, size: false });
  });

  it('holds the lines it was given, and refuses lines that are not the text', async () => {
    const no = await call({ ops: [{ where: { ids: ['a'] }, set: { breaks: ['Hello', 'there...'] } }] });
    expect(no.ok).toBe(false);
    expect(no.error).toMatch(/not laid out by outline fit/);
    const wrong = await call({ ops: [{ where: { ids: ['a'] }, set: { style: { margin: 0.5 }, breaks: ['Hello', 'world'] } }] });
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toMatch(/not box a's text/);
    const r = await call({ ops: [{ where: { ids: ['a'] }, set: { style: { margin: 0.5 }, breaks: ['Hello', 'there…'] } }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(a().auto.breaks.at).toEqual([0, 6]);
    expect(a().auto.locks.breaks).toBe(true);
    await call({ ops: [{ where: { ids: ['a'] }, set: { breaks: null } }] });
    expect(a().auto.breaks).toBeUndefined();
    expect(a().auto.locks.breaks).toBe(false);
  });

  it('keeps held lines through a later change of size, spacing or face', async () => {
    const { brokenLines, applyCase } = await import('../../measure.js');
    const { boxText } = await import('../../store.svelte.js');
    const lines = () => brokenLines(applyCase(boxText(a(), pageById(1)), a().style), a().style, a().style.size, a().auto.breaks);
    await call({ ops: [{ where: { ids: ['a'] }, set: { style: { margin: 0.5 }, breaks: ['Hello', 'there…'] } }] });
    for (const style of [{ size: 26 }, { letterSpacing: 2 }, { bold: true }]) {
      const r = await call({ ops: [{ where: { ids: ['a'] }, set: { style } }] });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(a().auto.locks.breaks).toBe(true);
      expect(lines()).toEqual(['Hello', 'there…']);
    }
  });

  it('typesets by outline fit, and "auto" lets every lock go', async () => {
    a().auto.locks.size = true;
    a().auto.locks.width = true;
    a().style.balloon = false;
    a().fit = { kind: 'ellipse', cx: 90, cy: 40, rx: 90, ry: 40 };
    const r = await call({ ops: [{ where: { ids: ['a'] }, do: 'typeset' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(a().style.margin).toBe(0.5);
    expect(a().style.balloon).toBe(true);
    expect(a().auto.locks.size).toBe(true);
    await call({ ops: [{ where: { ids: ['a'] }, do: 'auto' }] });
    expect(Object.values(a().auto.locks).every((v) => v === false)).toBe(true);
    expect(a().auto.on).toBe(true);
  });
});

describe('edit: split_outline', () => {
  const dumbbell = [];
  for (let i = 0; i <= 40; i++) {
    const t = -Math.PI * 0.85 + (i / 40) * Math.PI * 1.7;
    dumbbell.push([200 - 80 * Math.cos(t), 200 + 80 * Math.sin(t)]);
  }
  for (let i = 0; i <= 40; i++) {
    const t = Math.PI * 0.85 - (i / 40) * Math.PI * 1.7;
    dumbbell.push([440 + 80 * Math.cos(t), 200 + 80 * Math.sin(t)]);
  }

  it('cuts a joined outline at the neck, the box keeping its own bubble', async () => {
    const p = pageById(1);
    p.detect = { boxes: [{ n: 1, box: [180, 170, 220, 230] }, { n: 2, box: [420, 170, 460, 230] }] };
    p.boxes[0].fit = { kind: 'poly', pts: copy(dumbbell) };
    const r = await call({ ops: [{ where: { ids: ['a'] }, do: 'split_outline' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.ops[0].changed).toEqual(['a']);
    const xs = p.boxes[0].fit.pts.map(([x]) => x);
    expect(Math.max(...xs)).toBeLessThan(330);
    expect(p.boxes[0].outline.approved).toBeNull();
    const again = await call({ ops: [{ where: { ids: ['a'] }, do: 'split_outline' }] });
    expect(again.result.ops[0].notSplit.ids).toEqual(['a']);
  });

  it('sets a box free of its outline, with nothing left to flag', async () => {
    const p = pageById(1);
    p.boxes[0].fit = { kind: 'poly', pts: copy(dumbbell) };
    p.boxes[0].outline = { source: 'dark', confidence: 0.3, approved: null };
    const r = await call({ ops: [{ where: { ids: ['a'] }, do: 'free' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(p.boxes[0].fit).toBeNull();
    expect(p.boxes[0].style.balloon).toBe(false);
    expect(p.boxes[0].outline).toMatchObject({ open: true });
    expect(pageCheckItems(p, 0).filter((it) => it.boxId === 'a').map((it) => it.reason)).not.toContain('open');
  });

  it('says so when no balloon is found under a box to refit', async () => {
    const r = await call({ ops: [{ where: { ids: ['a'] }, do: 'refit_outline' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.ops[0].noBalloon).toMatchObject({ ids: ['a'], why: expect.stringContaining('no balloon found') });
  });
});

describe('edit: warp presets', () => {
  const a = () => pageById(1).boxes[0];

  it('bends a box with its own size, one undo step, and undo puts it back', async () => {
    const start = copy(a().style.warp);
    const r = await call({ ops: [{ where: { ids: ['a'] }, do: 'warp:arc' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.ops[0]).toMatchObject({ matched: 1, changed: ['a'] });
    const want = warpPresetPts('arc', WARP_DEFAULT_AMOUNT, 160, 60);
    expect(copy(a().style.warp)).toEqual({ on: true, cols: want.cols, rows: want.rows, pts: want.pts });
    expect(peekStack().undo).toHaveLength(1);
    undo();
    expect(copy(a().style.warp)).toEqual(start);
  });

  it('takes an amount, negative too, on every box it matches, each by its own rectangle', async () => {
    pageById(2).boxes[0].w = 300;
    const r = await call({ ops: [{ where: { pages: 'all' }, do: 'warp:flag:-30' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.ops[0].changed).toEqual(['a', 'b', 'c']);
    expect(copy(a().style.warp.pts)).toEqual(warpPresetPts('flag', -30, 160, 60).pts);
    expect(copy(pageById(2).boxes[0].style.warp.pts)).toEqual(warpPresetPts('flag', -30, 300, 60).pts);
    // One step per page.
    expect(peekStack().undo).toHaveLength(2);
  });

  it('is case- and space-tolerant, and a later warp replaces the mesh', async () => {
    await call({ ops: [{ where: { ids: ['a'] }, do: ' warp: Bulge : 20 ' }] });
    expect(copy(a().style.warp.pts)).toEqual(warpPresetPts('bulge', 20, 160, 60).pts);
    await call({ ops: [{ where: { ids: ['a'] }, do: 'warp:rise:+100' }] });
    expect(copy(a().style.warp.pts)).toEqual(warpPresetPts('rise', 100, 160, 60).pts);
  });

  it('"warp:off" turns the mesh off and clears it, and is nothing on a box with no mesh', async () => {
    await call({ ops: [{ where: { ids: ['a'] }, do: 'warp:wave:40' }] });
    const r = await call({ ops: [{ where: { ids: ['a', 'b'] }, do: 'warp:off' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.ops[0].changed).toEqual(['a']);
    expect(copy(a().style.warp)).toMatchObject({ on: false, pts: [] });
  });

  it('works beside a set in the same op, the warp built on the new size', async () => {
    const r = await call({ ops: [{ where: { ids: ['a'] }, set: { geometry: { w: 200, h: 100 } }, do: 'warp:arch:25' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(copy(a().style.warp.pts)).toEqual(warpPresetPts('arch', 25, 200, 100).pts);
  });

  it('refuses an unknown kind with the nearest names, and an amount out of range or not a number', async () => {
    const start = copy(app.pages.map((p) => p.boxes));
    const unknown = await call({ ops: [{ where: { ids: ['a'] }, do: 'warp:arcc' }] });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/ops\[0\]\.do: no warp "arcc"/);
    expect(unknown.hint).toMatch(/close: arc/);
    for (const bad of ['warp:arc:150', 'warp:arc:-101', 'warp:arc:lots', 'warp:arc:', 'warp:arc:1e2', 'warp:off:3', 'warp:arc:10:2', 'warp:']) {
      const r = await call({ ops: [{ where: { ids: ['a'] }, do: bad }] });
      expect(r.ok, bad).toBe(false);
      expect(r.error, bad).toMatch(/ops\[0\]\.do/);
    }
    expect(copy(app.pages.map((p) => p.boxes))).toEqual(start);
    expect(peekStack().undo).toHaveLength(0);
  });

  it('dryRun counts and writes nothing', async () => {
    const r = await call({ ops: [{ where: { pages: 'all' }, do: 'warp:squeeze' }], dryRun: true });
    expect(r.result.ops[0].matched).toBe(3);
    expect(a().style.warp.on).toBe(false);
  });
});

// The sound types themselves run on the real engine (sfx.engine.test.js).
describe('edit: SFX', () => {
  const a = () => pageById(1).boxes[0];
  it('a sound type and SFX on or off go through their actions, not a style patch', async () => {
    const start = copy(app.pages.map((p) => p.boxes));
    for (const [sfx, path] of [[{ kind: 'impact' }, 'sfx.kind'], [{ on: true }, 'sfx.on'], [{ on: false, seed: 3 }, 'sfx.on']]) {
      const r = await call({ ops: [{ where: { ids: ['a'] }, set: { style: { sfx } } }] });
      expect(r.ok, JSON.stringify(sfx)).toBe(false);
      expect(r.error).toContain(`set.style.${path}`);
      expect(r.hint).toMatch(/sfx_kind/);
    }
    expect(copy(app.pages.map((p) => p.boxes))).toEqual(start);
  });

  it('the type\'s own fields and the SFX effects are style edits', async () => {
    const r = await call({ ops: [{ where: { ids: ['a'] }, set: { style: {
      sfx: { seed: 42, power: 80, slant: -10, caption: { text: 'boom', side: 'below' } },
      extrude: { on: true, length: 0.3 },
    } } }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(a().style.sfx).toMatchObject({ on: false, seed: 42, power: 80, slant: -10, caption: { text: 'boom', side: 'below' } });
    expect(a().style.extrude).toMatchObject({ on: true, length: 0.3 });
    const bad = await call({ ops: [{ where: { ids: ['a'] }, set: { style: { sfx: { power: 300 } } } }] });
    expect(bad.ok).toBe(false);
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

  it('stands a new box upright, whatever turn the last box had', async () => {
    app.lastStyle = { ...app.lastStyle, rotation: 18 };
    let r = await callTool('add', { page: 1, line: 3, rect: [300, 400, 200, 80] }, callContext('mcp'));
    expect(pageById(1).boxes.find((x) => x.id === r.result.id).style.rotation).toBe(0);
    r = await callTool('add', { page: 2, text: 'Turned', rect: [300, 400, 200, 80], style: { rotation: -10 } }, callContext('mcp'));
    expect(pageById(2).boxes.find((x) => x.id === r.result.id).style.rotation).toBe(-10);
  });

  it('keeps the rect and the size it is given, with no balloon fit', async () => {
    const r = await callTool('add', { page: 1, line: 3, rect: [300, 400, 200, 80], style: { size: 30 } }, callContext('mcp'));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const b = pageById(1).boxes.find((x) => x.id === r.result.id);
    expect(b).toMatchObject({ x: 300, y: 400, w: 200, h: 80 });
    expect(b.style.balloon).toBe(false);
    if (b.auto) expect(b.auto.refSize).toBe(30);
  });

  it('gives a line a box again after its box was deleted', async () => {
    const first = await callTool('add', { page: 1, line: 3, rect: [300, 400, 200, 80] }, callContext('mcp'));
    await call({ ops: [{ where: { ids: [first.result.id] }, do: 'delete' }] });
    const again = await callTool('add', { page: 1, line: 3, rect: [300, 400, 200, 80] }, callContext('mcp'));
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(pageById(1).boxes.filter((x) => x.lineN === 3)).toHaveLength(1);
  });
});
