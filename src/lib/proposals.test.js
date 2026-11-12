// TXT-4: AI wording waits beside the user's words until they take it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./library.svelte.js', () => ({ chapterOpenSeq: () => 1 }));

const { app, loadProjectPages, settleEdits, lineByN } = await import('./store.svelte.js');
const { initHistory, resetHistory, undo } = await import('./editor/history.svelte.js');
const { propose, acceptProposal, rejectProposal, isStale, dropRunProposals } = await import('./proposals.svelte.js');
const { recordForExport } = await import('./package-flow.js');
const { callTool } = await import('./agent/registry.js');
const { callContext, revertRun, __resetRun } = await import('./agent/run.svelte.js');
await import('./agent/tools/index.js');
const { defaultStyle } = await import('./data.js');

const page = () => app.pages[0];
const en = (n) => lineByN(page(), n).en;

beforeEach(() => {
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  loadProjectPages([
    {
      id: 1,
      w: 800,
      h: 1200,
      lines: [
        { n: 1, jp: 'a', en: 'Where are you going?' },
        { n: 2, jp: 'b', en: 'Home.' },
      ],
      boxes: [{ id: 'b1', lineN: 1, text: 'Where are you going?', x: 10, y: 10, w: 200, h: 60, style: { ...defaultStyle(), size: 20 } }],
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
});

describe('proposals', () => {
  it('Use applies the words as one undo step and drops the others', () => {
    const a = propose(page(), { line: 1 }, 'Going where?');
    propose(page(), { line: 1 }, 'Where to?');
    expect(page().proposals).toHaveLength(2);
    expect(en(1)).toBe('Where are you going?');
    expect(acceptProposal(1, a.id)).toBe('used');
    expect(en(1)).toBe('Going where?');
    expect(page().proposals).toHaveLength(0);
    undo();
    expect(en(1)).toBe('Where are you going?');
  });

  it('a proposal whose words changed since is not taken silently', () => {
    const a = propose(page(), { line: 2 }, 'Going home.');
    lineByN(page(), 2).en = 'Back home.';
    expect(isStale(page(), a)).toBe(true);
    expect(acceptProposal(1, a.id)).toBe('stale');
    expect(en(2)).toBe('Back home.');
    expect(acceptProposal(1, a.id, { force: true })).toBe('used');
    expect(en(2)).toBe('Going home.');
  });

  it('the same words, or no change, make no proposal; Reject drops one', () => {
    expect(propose(page(), { line: 2 }, 'Home.')).toBeNull();
    const a = propose(page(), { line: 2 }, 'Home!');
    expect(propose(page(), { line: 2 }, 'Home!')).toBe(a);
    expect(rejectProposal(1, a.id)).toBe(true);
    expect(page().proposals).toEqual([]);
  });

  it('never leaves in a package', () => {
    const record = { typesetting: { mode: 'smart', version: 1 }, pages: [{ id: 1, lines: [], proposals: [{ id: 'x' }] }, { id: 2, lines: [] }] };
    const out = recordForExport(record);
    expect('proposals' in out.pages[0]).toBe(false);
    expect(record.pages[0].proposals).toHaveLength(1);
  });
});

describe('the text tool in the AI panel', () => {
  it('proposes instead of writing, and Revert run takes the proposals back', async () => {
    const r = await callTool('text', { ops: [{ page: 1, line: 1, en: 'Going where?', reason: 'shorter' }, { page: 1, line: 2, jp: 'c' }] }, callContext('panel'));
    expect(r.ok).toBe(true);
    expect(en(1)).toBe('Where are you going?');
    // The source is an OCR fix and is written.
    expect(lineByN(page(), 2).jp).toBe('c');
    expect(r.result.proposed[0]).toMatchObject({ line: 1, outcome: 'proposed', proposed: { untrusted: 'Going where?' } });
    expect(page().proposals[0]).toMatchObject({ target: { line: 1 }, reason: 'shorter' });
    revertRun();
    expect(page().proposals).toEqual([]);
    expect(lineByN(page(), 2).jp).toBe('b');
  });

  it('the MCP door still writes directly', async () => {
    const r = await callTool('text', { ops: [{ page: 1, line: 2, en: 'Home!' }] }, callContext('mcp'));
    expect(r.ok).toBe(true);
    expect(en(2)).toBe('Home!');
  });

  it('edit set.text is refused in the panel, with the way to do it', async () => {
    const r = await callTool('edit', { ops: [{ where: { ids: ['b1'] }, set: { text: 'x' } }] }, callContext('panel'));
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/Call text/);
  });

  it('dropRunProposals keeps the user\'s and other runs\'', () => {
    propose(page(), { line: 1 }, 'A', { run: 'r1' });
    propose(page(), { line: 2 }, 'B', { run: 'r2' });
    expect(dropRunProposals('r1')).toBe(1);
    expect(page().proposals.map((p) => p.text)).toEqual(['B']);
  });
});

describe('review fixes', () => {
  it('a line number now holding other source words is stale', () => {
    const a = propose(page(), { line: 2 }, 'Going home.');
    lineByN(page(), 2).jp = 'other words';
    expect(isStale(page(), a)).toBe(true);
    expect(acceptProposal(1, a.id)).toBe('stale');
  });

  it('Use on a locked box changes nothing and keeps the proposal', () => {
    const a = propose(page(), { line: 1 }, 'Going where?');
    page().boxes[0].locked = true;
    expect(acceptProposal(1, a.id)).toBe('locked');
    expect(en(1)).toBe('Where are you going?');
    expect(page().proposals).toHaveLength(1);
  });

  it('a prompt that only proposed can be reverted', async () => {
    const { aiRun } = await import('./agent/run.svelte.js');
    await callTool('text', { ops: [{ page: 1, line: 1, en: 'Going where?' }] }, callContext('panel'));
    const { endPromptRun } = await import('./agent/run.svelte.js');
    endPromptRun();
    expect(aiRun.canRevert).toBe(true);
    revertRun();
    expect(page().proposals).toEqual([]);
  });

  it('the panel Stop refuses a write that began before it, run or no run', async () => {
    const { stopPromptRun } = await import('./agent/run.svelte.js');
    const ctx = callContext('panel');
    stopPromptRun();
    expect(() => ctx.write([page()], () => {})).toThrow(/stopped/);
  });
});
