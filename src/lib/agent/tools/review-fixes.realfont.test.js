// What an agent's first real run tripped over (2026-11-07), with real metrics:
// boxes born Fixed never reached the solver (stale everywhere, clipped
// heights, a word or two to a line); lines set for old words outlived new
// words; and every write's answer listed every check.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../library.svelte.js', async (orig) => ({ ...(await orig()), chapterOpenSeq: () => 1 }));

const { app, loadProjectPages, pageById, settleEdits, isLayoutStale } = await import('../../store.svelte.js');
const { initHistory, resetHistory, undo } = await import('../../editor/history.svelte.js');
const { callContext, __resetRun } = await import('../run.svelte.js');
const { callTool } = await import('../registry.js');
const { normalizeStyle } = await import('../../data.js');
const { setTypesetEnabled } = await import('../../measure.js');
const { selectBoxes } = await import('../select.js');
const { checksFor } = await import('./check.js');
await import('./index.js');

// Fixed, as a series whose boxes are born Fixed has them.
const style = normalizeStyle({ font: 'Comic Neue', size: 24, align: 'center', valign: 'middle', strokeEffects: [], margin: 0.5, autoHeight: false });
const call = async (name, args) => {
  const r = await callTool(name, args, callContext('mcp'));
  expect(r.ok, JSON.stringify(r)).toBe(true);
  settleEdits();
  return r.result;
};
const a = () => pageById(1).boxes[0];
const issuesOf = (id) => checksFor(selectBoxes({ ids: [id] }).matches)[0]?.issues.map((i) => i.kind) ?? [];

beforeAll(() => setTypesetEnabled(true));
beforeEach(() => {
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.chapterMode = 'typeset';
  // A tall balloon, and a box far too short for its words, as Fixed left it.
  loadProjectPages([{
    id: 1, w: 800, h: 1200,
    lines: [{ n: 1, en: 'IF YOU REALLY WANT IT THAT BADLY THEN TAKE IT', tags: ['speech'] }],
    boxes: [{ id: 'a', lineN: 1, text: null, x: 150, y: 180, w: 100, h: 40, style, fit: { kind: 'ellipse', cx: 200, cy: 200, rx: 80, ry: 150 }, outline: { source: 'ring', confidence: 1, approved: null }, auto: { on: true, refSize: 24 } }],
  }]);
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
});

describe('a box laid out by outline fit is the solver\'s', () => {
  it('check names a Fixed one, and typeset hands it to the solver: no stale, no clipped height', async () => {
    expect(issuesOf('a')).toContain('fixed');
    await call('edit', { ops: [{ where: { ids: ['a'] }, do: 'typeset' }] });
    expect(a().style.autoHeight).toBe(true);
    expect(isLayoutStale(a(), pageById(1))).toBe(false);
    const kinds = issuesOf('a');
    for (const k of ['fixed', 'stale', 'overflow', 'outside', 'hourglass']) expect(kinds).not.toContain(k);
    // One undo takes the sizing back with the rest.
    undo();
    expect(a().style.autoHeight).toBe(false);
  });

  it('keeps a height the agent set, held by its lock rather than by Fixed', async () => {
    await call('edit', { ops: [{ where: { ids: ['a'] }, do: 'typeset' }] });
    await call('edit', { ops: [{ where: { ids: ['a'] }, set: { geometry: { h: 220 } } }] });
    expect(a().style.autoHeight).toBe(true);
    expect(a().auto.locks.height).toBe(true);
    expect(a().h).toBe(220);
  });
});

describe('lines set by hand', () => {
  it('are let go when the words change, and the answer says so', async () => {
    await call('edit', { ops: [{ where: { ids: ['a'] }, do: 'typeset' }] });
    const set = await call('edit', { ops: [{ where: { ids: ['a'] }, set: { breaks: ['IF YOU REALLY', 'WANT IT THAT BADLY', 'THEN TAKE IT'] } }] });
    expect(set.ops[0].breaksNotShown).toBeUndefined();
    expect(a().auto.locks.breaks).toBe(true);
    const r = await call('text', { ops: [{ page: 1, line: 1, en: 'IF YOU WANT IT SO BADLY, JUST TAKE IT' }] });
    expect(r.breaksDropped?.ids).toEqual(['a']);
    expect(a().auto.locks.breaks).toBe(false);
  });
});

describe('compact', () => {
  it('answers with what needs work and the mean quality, not every check', async () => {
    const r = await call('edit', { ops: [{ where: { ids: ['a'] }, do: 'typeset' }], compact: true });
    const op = r.ops[0];
    expect(op.checks).toBeUndefined();
    expect(op.fit).toBeUndefined();
    expect(op.quality).toBeTypeOf('number');
    // The unapproved outline is the user's to look at, not a fault.
    for (const p of op.problems ?? []) expect(p.issues.map((i) => i.kind)).not.toContain('outline');
  });
});
