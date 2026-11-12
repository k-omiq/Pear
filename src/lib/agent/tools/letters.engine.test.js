// The agent's finer controls: single SFX letters (the letters tool, edit
// set.letters) and the mesh point by point (edit set.mesh), with their caps.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rustEngine } from '../../../test/rust-engine.js';

vi.mock('../../library.svelte.js', async (orig) => ({ ...(await orig()), chapterOpenSeq: () => 1 }));

const { textEngine, setTextEngine } = await import('../../text-engine/index.js');
const { clearLayoutMemo } = await import('../../measure.js');
const { app, loadProjectPages, pageById, settleEdits } = await import('../../store.svelte.js');
const { initHistory, resetHistory, undo } = await import('../../editor/history.svelte.js');
const { callContext, __resetRun } = await import('../run.svelte.js');
const { callTool } = await import('../registry.js');
const { defaultStyle } = await import('../../data.js');
await import('./index.js');

const defaultEngine = textEngine();
beforeAll(async () => {
  setTextEngine(await rustEngine());
  clearLayoutMemo();
});
afterAll(() => {
  setTextEngine(defaultEngine);
  clearLayoutMemo();
});

const box = (id, text, extra = {}) => ({
  id, lineN: null, text, x: 100, y: 100, w: 260, h: 120,
  style: { ...defaultStyle(), font: 'Bangers', size: 48 }, ...extra,
});
const edit = (ops) => callTool('edit', { ops }, callContext('mcp'));
const get = (id) => pageById(1).boxes.find((b) => b.id === id);

beforeEach(async () => {
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.chapterMode = 'typeset';
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('s', 'BOOOM'), box('t', 'Hello there')] }]);
  initHistory();
  resetHistory();
  __resetRun();
  const r = await edit([{ where: { ids: ['s'] }, do: 'sfx_pick' }]);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  resetHistory();
});
afterEach(() => {
  settleEdits();
  resetHistory();
  __resetRun();
  app.chapterRef = null;
  loadProjectPages([]);
  clearLayoutMemo();
});

describe('letters', () => {
  it('reads each SFX letter, fenced, and refuses plain text', async () => {
    const r = await callTool('letters', { id: 's' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.count).toBe(5);
    expect(r.result.letters[0]).toMatchObject({ n: 0, key: expect.stringMatching(/^\d+:\d+$/) });
    const plain = await callTool('letters', { id: 't' });
    expect(plain.ok).toBe(false);
    expect(plain.error).toMatch(/not an SFX/);
  });
});

describe('edit set.letters', () => {
  it('moves a letter, adds a relative move once, and undo takes it back', async () => {
    const r = await edit([{ where: { ids: ['s'] }, set: { letters: [{ n: 0, dy: -0.3, s: 1.3 }, { n: 4, rot: 12 }] } }]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const keys = (await callTool('letters', { id: 's' })).result.letters.map((l) => l.key);
    expect(get('s').style.sfx.glyphs[keys[0]]).toEqual({ dx: 0, dy: -0.3, rot: 0, s: 1.3 });
    expect(get('s').style.sfx.glyphs[keys[4]]).toEqual({ dx: 0, dy: 0, rot: 12, s: 1 });
    await edit([{ where: { ids: ['s'] }, set: { letters: [{ key: keys[4], rot: '+5' }] } }]);
    expect(get('s').style.sfx.glyphs[keys[4]].rot).toBe(17);
    const read = (await callTool('letters', { id: 's' })).result.letters[4];
    expect(read.moved).toMatchObject({ rot: 17 });
    await edit([{ where: { ids: ['s'] }, set: { letters: [{ key: keys[4], reset: true }] } }]);
    expect(get('s').style.sfx.glyphs[keys[4]]).toBeUndefined();
    undo();
    undo();
    undo();
    expect(get('s').style.sfx.glyphs ?? {}).toEqual({});
  });

  it('holds the hard caps, and changes nothing when refused', async () => {
    const cases = [
      [{ n: 0, dx: 3 }, /at most 2/],
      [{ n: 0, rot: 90 }, /at most 60/],
      [{ n: 0, s: 4 }, /0.4 to 2.5/],
      [{ n: 9, dy: 0.2 }, /letters 0-4/],
      [{ key: '9:9', dy: 0.2 }, /no letter/],
      [{ n: 0, wiggle: 1 }, /unknown key/],
    ];
    for (const [e, re] of cases) {
      const r = await edit([{ where: { ids: ['s'] }, set: { letters: [e] } }]);
      expect(r.ok, JSON.stringify(e)).toBe(false);
      expect(r.error).toMatch(re);
    }
    // More than half the letters moved: refused.
    const many = await edit([{ where: { ids: ['s'] }, set: { letters: [0, 1, 2, 3].map((n) => ({ n, dy: 0.1 })) } }]);
    expect(many.ok).toBe(false);
    expect(many.error).toMatch(/4 of 5 letters/);
    expect(many.hint).toMatch(/at most half/);
    expect(get('s').style.sfx.glyphs ?? {}).toEqual({});
  });

  it('refuses plain text, new words in the same op, and a new sound type', async () => {
    expect((await edit([{ where: { ids: ['t'] }, set: { letters: [{ n: 0, dy: 0.1 }] } }])).error).toMatch(/not an SFX/);
    expect((await edit([{ where: { ids: ['s'] }, set: { text: 'BANG', letters: [{ n: 0, dy: 0.1 }] } }])).error).toMatch(/new letters/);
    expect((await edit([{ where: { ids: ['s'] }, set: { letters: [{ n: 0, dy: 0.1 }] }, do: 'sfx_pick' }])).error).toMatch(/lays the letters out again/);
  });
});

describe('edit set.mesh', () => {
  it('sets the corners as a perspective, and nudges a point', async () => {
    const r = await edit([{ where: { ids: ['t'] }, set: { mesh: { grid: [2, 2], corners: [[10, 0], [250, 10], [260, 120], [0, 110]] } } }]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const w = get('t').style.warp;
    expect(w).toMatchObject({ on: true, cols: 2, rows: 2, w: 260, h: 120 });
    expect(w.pts).toHaveLength(9);
    expect(w.pts[0]).toEqual([10, 0]);
    expect(w.pts[2]).toEqual([250, 10]);
    expect(w.pts[4]).toEqual([130, 60]);
    await edit([{ where: { ids: ['t'] }, set: { mesh: { move: [{ col: 1, row: 1, dx: 5, dy: -4 }] } } }]);
    expect(get('t').style.warp.pts[4]).toEqual([135, 56]);
    // The corners kept: the move started from the box's own mesh.
    expect(get('t').style.warp.pts[0]).toEqual([10, 0]);
    await edit([{ where: { ids: ['t'] }, set: { mesh: { off: true } } }]);
    expect(get('t').style.warp.on).toBe(false);
  });

  it('refuses far points, folds, and a size or warp preset in the same op', async () => {
    const far = await edit([{ where: { ids: ['t'] }, set: { mesh: { corners: [[100, 0], [260, 0], [260, 120], [0, 120]] } } }]);
    expect(far.error).toMatch(/at most 48 px/);
    // Two columns of points pass each other: the cell between them turns over.
    const move = [[1, 40], [2, -40]].flatMap(([col, dx]) => [0, 1].map((row) => ({ col, row, dx, dy: 0 })));
    const fold = await edit([{ where: { ids: ['t'] }, set: { mesh: { grid: [4, 1], move } } }]);
    expect(fold.error).toMatch(/cell 1,0 would fold/);
    expect(get('t').style.warp?.on ?? false).toBe(false);
    expect((await edit([{ where: { ids: ['t'] }, set: { geometry: { w: 300 }, mesh: { grid: [2, 2] } } }])).error).toMatch(/own px/);
    expect((await edit([{ where: { ids: ['t'] }, set: { mesh: { grid: [2, 2] } }, do: 'warp:arc' }])).error).toMatch(/replaces the mesh/);
    expect((await edit([{ where: { ids: ['t'] }, set: { mesh: { grid: [0, 2] } } }])).error).toMatch(/cols, rows/);
  });
});

describe('review fixes', () => {
  it('reads places in ems and turns in degrees, with the caps it holds to', async () => {
    const r = (await callTool('letters', { id: 's' })).result;
    for (const l of r.letters) {
      expect(Math.abs(l.at[0])).toBeLessThan(5);
      expect(Math.abs(l.turn)).toBeLessThan(90);
    }
    expect(r.limits.hard.move).toBe(2);
    expect(r.limits.aim.move).toBe(0.6);
    expect(r.limits.most).toBe(3);
  });

  it('two letter ops on one box in one call are refused, not lost', async () => {
    const r = await edit([
      { where: { ids: ['s'] }, set: { letters: [{ n: 0, dy: -0.3 }] } },
      { where: { ids: ['s'] }, set: { letters: [{ n: 4, rot: 10 }] } },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/earlier op of this call moved letters/);
    const t = await edit([
      { where: { ids: ['s'] }, set: { style: { size: 50 } } },
      { where: { ids: ['s'] }, do: 'clear_sfx' },
      { where: { ids: ['t'] }, set: { geometry: { w: 200 } } },
      { where: { ids: ['t'] }, set: { mesh: { grid: [2, 2] } } },
    ]);
    expect(t.error).toMatch(/ops\[3\].*resized box t/);
  });

  it('letter edits left on letters that are gone are dropped, and never lock a box', async () => {
    const keys = (await callTool('letters', { id: 's' })).result.letters.map((l) => l.key);
    // As if by hand: four of five letters moved, past the half rule.
    get('s').style.sfx.glyphs = Object.fromEntries(keys.slice(0, 4).map((k) => [k, { dx: 0, dy: 0.1, rot: 0, s: 1 }]));
    get('s').style.sfx.glyphs['7:7'] = { dx: 0, dy: 0.2, rot: 0, s: 1 };
    const r = await edit([{ where: { ids: ['s'] }, set: { letters: [{ key: keys[0], reset: true }] } }]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(Object.keys(get('s').style.sfx.glyphs).sort()).toEqual(keys.slice(1, 4).sort());
  });

  it('a warp preset can be tuned with small moves, and a dented cell is a fold', async () => {
    expect((await edit([{ where: { ids: ['t'] }, do: 'warp:arc:100' }])).ok).toBe(true);
    const before = get('t').style.warp.pts.map((p) => [...p]);
    const { cols } = get('t').style.warp;
    const r = await edit([{ where: { ids: ['t'] }, set: { mesh: { move: [{ col: 0, row: 0, dx: 1, dy: 0 }] } } }]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(get('t').style.warp.pts[0][0]).toBeCloseTo(before[0][0] + 1, 1);
    expect(get('t').style.warp.cols).toBe(cols);
    // One triangle of the cell turned over though the quad's area stays positive.
    resetHistory();
    get('t').style.warp = { on: false, pts: [] };
    const dent = await edit([{ where: { ids: ['t'] }, set: { mesh: { grid: [4, 4], move: [{ col: 1, row: 0, dx: -40, dy: 25 }] } } }]);
    expect(dent.error).toMatch(/fold/);
  });
});
