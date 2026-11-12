// TXT-5 with real metrics: each wording is measured in the box's outline by
// the solver, the page is left as it was, and in the AI panel only wordings
// that fit become proposals.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../library.svelte.js', async (orig) => ({ ...(await orig()), chapterOpenSeq: () => 1 }));

const { app, loadProjectPages, pageById, settleEdits } = await import('../../store.svelte.js');
const { initHistory, resetHistory, peekStack } = await import('../../editor/history.svelte.js');
const { callContext, __resetRun } = await import('../run.svelte.js');
const { callTool } = await import('../registry.js');
const { normalizeStyle } = await import('../../data.js');
const { setTypesetEnabled } = await import('../../measure.js');
await import('./edit.js');
await import('./alternatives.js');

const style = normalizeStyle({ font: 'Comic Neue', size: 24, bold: false, align: 'center', valign: 'middle', strokeEffects: [], margin: 0.5 });
const LONG = 'WE CAN STILL CATCH THE VERY LAST TRAIN HOME TONIGHT IF WE RUN AS FAST AS WE POSSIBLY CAN RIGHT NOW';
const a = () => pageById(1).boxes[0];

beforeAll(() => setTypesetEnabled(true));
beforeEach(async () => {
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.chapterMode = 'typeset';
  loadProjectPages([{
    id: 1, w: 800, h: 1200,
    lines: [{ n: 1, en: LONG, tags: ['speech'] }],
    boxes: [{ id: 'a', lineN: 1, text: null, x: 140, y: 100, w: 120, h: 200, style, fit: { kind: 'ellipse', cx: 200, cy: 200, rx: 75, ry: 120 }, outline: { source: 'ring', confidence: 1, approved: null } }],
  }]);
  initHistory();
  resetHistory();
  __resetRun();
  await callTool('edit', { ops: [{ where: { ids: ['a'] }, do: 'typeset' }] }, callContext('mcp'));
  settleEdits();
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

describe('alternatives', () => {
  it('measures each wording, changes nothing, and through the door proposes nothing', async () => {
    const before = JSON.stringify(a());
    const r = await callTool('alternatives', { id: 'a', wordings: [LONG + ' AND THEN SOME MORE WORDS', 'RUN FOR IT!'] }, callContext('mcp'));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const [best, worst] = r.result.tried;
    expect(best.text.untrusted).toBe('RUN FOR IT!');
    expect(best.fits).toBe(true);
    expect(worst.fits).toBe(false);
    expect(JSON.stringify(a())).toBe(before);
    expect(pageById(1).proposals).toEqual([]);
    expect(peekStack(pageById(1).id)?.length ?? 0).toBe(0);
  });

  it('in the AI panel, the wordings that fit become proposals', async () => {
    const r = await callTool('alternatives', { id: 'a', wordings: ['RUN FOR IT!', LONG + ' AND MORE AND MORE AND MORE'], reason: 'too long' }, callContext('panel'));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(pageById(1).proposals.map((p) => p.text)).toEqual(['RUN FOR IT!']);
    expect(pageById(1).proposals[0]).toMatchObject({ target: { line: 1 }, base: LONG, reason: 'too long' });
    expect(r.result.proposed).toHaveLength(1);
  });
});
