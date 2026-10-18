// Lines chosen by hand, with real metrics: a set.breaks that fits only much
// smaller says so in the result, as the orphan rule weighs size against it.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../library.svelte.js', async (orig) => ({ ...(await orig()), chapterOpenSeq: () => 1 }));

const { app, loadProjectPages, pageById, settleEdits } = await import('../../store.svelte.js');
const { initHistory, resetHistory } = await import('../../editor/history.svelte.js');
const { callContext, __resetRun } = await import('../run.svelte.js');
const { callTool } = await import('../registry.js');
const { normalizeStyle } = await import('../../data.js');
const { setTypesetEnabled } = await import('../../measure.js');
await import('./edit.js');

const style = normalizeStyle({ font: 'Comic Neue', size: 24, bold: false, align: 'center', valign: 'middle', strokes: [], margin: 0.5 });
const call = (args) => callTool('edit', args, callContext('mcp'));
const a = () => pageById(1).boxes[0];

beforeAll(() => setTypesetEnabled(true));
beforeEach(() => {
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.chapterMode = 'typeset';
  // A narrow balloon: four short lines fit it; one long line only small.
  loadProjectPages([{
    id: 1, w: 800, h: 1200,
    lines: [{ n: 1, en: 'WE CAN STILL CATCH THE LAST TRAIN', tags: ['speech'] }],
    boxes: [{ id: 'a', lineN: 1, text: null, x: 140, y: 100, w: 120, h: 200, style, fit: { kind: 'ellipse', cx: 200, cy: 200, rx: 75, ry: 120 }, outline: { source: 'ring', confidence: 1, approved: null } }],
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

describe('set.breaks', () => {
  it('says so when the lines fit only much smaller, and not when they keep the size', async () => {
    await call({ ops: [{ where: { ids: ['a'] }, do: 'typeset' }] });
    const before = a().style.size;
    let r = await call({ ops: [{ where: { ids: ['a'] }, set: { breaks: ['WE CAN STILL CATCH', 'THE LAST TRAIN'] } }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(a().style.size).toBeLessThan(before * 0.9);
    expect(r.result.ops[0].breaksCost.boxes).toEqual([{ id: 'a', before, size: a().style.size }]);
    r = await call({ ops: [{ where: { ids: ['a'] }, set: { breaks: null } }] });
    const free = a().style.size;
    r = await call({ ops: [{ where: { ids: ['a'] }, set: { breaks: ['WE CAN', 'STILL CATCH', 'THE LAST', 'TRAIN'] } }] });
    expect(r.result.ops[0].breaksCost, `${free} -> ${a().style.size}`).toBeUndefined();
  });
});
