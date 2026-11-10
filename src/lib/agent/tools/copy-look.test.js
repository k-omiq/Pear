// copy_look: another chapter's look per tag, read from its saved record, and
// laid on this chapter's boxes of the same tags.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const record = {
  pages: [{
    id: 1,
    lines: [
      { n: 1, en: 'Hi', tags: ['speech'] },
      { n: 2, en: 'Yo', tags: ['speech'] },
      { n: 3, en: 'Hey', tags: ['speech'] },
      { n: 4, en: 'BAM', tags: ['sfx-soft'] },
    ],
    boxes: [
      { id: 's1', lineN: 1, style: { font: 'Arial', size: 30, bold: true, color: '#111111', strokeEffects: [{ size: 3, position: 'outside', color: '#ffffff' }] }, auto: { refSize: 32 } },
      { id: 's2', lineN: 2, style: { font: 'Arial', size: 28, bold: true, color: '#111111', strokeEffects: [{ size: 3, position: 'outside', color: '#ffffff' }] } },
      { id: 's3', lineN: 3, style: { font: 'Gone Font', size: 40, bold: false, color: '#111111' } },
      { id: 'x1', lineN: 4, style: { font: 'Gone Font', size: 60, color: '#ff0000', sfx: { on: true, kind: 'impact' } } },
    ],
  }],
};
vi.mock('../../library.svelte.js', async (orig) => ({
  ...(await orig()),
  chapterOpenSeq: () => 1,
  projectById: (id) => (id === 'p' ? { id: 'p', chapters: [{ id: 'c14', number: 14 }, { id: 'c15', number: 15 }] } : null),
  chapterById: (pid, cid) => (pid === 'p' && ['c14', 'c15'].includes(cid) ? { id: cid } : null),
  readChapterRecord: async () => record,
}));

// The picked tiles a look names are copied from the source chapter's folder.
let tilesLost = [];
const copyPickedTiles = vi.fn(async () => tilesLost);
vi.mock('../../pattern-tiles.svelte.js', async (orig) => ({ ...(await orig()), copyPickedTiles: (...a) => copyPickedTiles(...a) }));

const { app, loadProjectPages, pageById, settleEdits } = await import('../../store.svelte.js');
const { initHistory, resetHistory, undo } = await import('../../editor/history.svelte.js');
const { callContext, __resetRun } = await import('../run.svelte.js');
const { callTool } = await import('../registry.js');
const { normalizeStyle } = await import('../../data.js');
const { looksOf } = await import('./copy-look.js');
const { defaultStyle, newStrokeEffect } = await import('../../data.js');
const { validateStylePatch } = await import('../style-schema.js');

let fonts;
beforeEach(() => {
  app.chapterRef = { projectId: 'p', chapterId: 'c15' };
  app.chapterMode = 'typeset';
  fonts = app.fonts;
  app.fonts = { builtin: [{ name: 'Arial' }, { name: 'Comic Neue' }], user: [], system: [] };
  loadProjectPages([{
    id: 1, w: 800, h: 1200,
    lines: [{ n: 1, en: 'Hello', tags: ['speech'] }, { n: 2, en: 'Bye', tags: ['narration'] }],
    boxes: [
      { id: 'a', lineN: 1, text: null, x: 10, y: 10, w: 100, h: 40, style: normalizeStyle({ font: 'Comic Neue', size: 20, margin: 0.5, autoHeight: false }) },
      { id: 'n', lineN: 2, text: null, x: 10, y: 200, w: 100, h: 40, style: normalizeStyle({ font: 'Comic Neue', size: 20 }) },
    ],
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
  app.fonts = fonts;
  loadProjectPages([]);
});
const call = (args) => callTool('copy_look', args, callContext('mcp'));

describe('looksOf', () => {
  it('takes the commonest of each look key and the median size aimed for, per first tag', () => {
    const [speech, sfx] = looksOf(record.pages);
    expect(speech).toMatchObject({ tag: 'speech', boxes: 3, size: 32, style: { font: 'Arial', bold: true, color: '#111111', strokeEffects: [{ size: 3, position: 'outside', color: '#ffffff' }] } });
    expect(sfx).toMatchObject({ tag: 'sfx-soft', sfxKinds: ['impact'] });
  });
});

describe('looksOf, layer styles', () => {
  it('carries a hollow look\'s effects and sends layer styles at their defaults as off', () => {
    const glow = { ...defaultStyle().outerGlow, on: true, size: 9 };
    const pages = [{ lines: [{ n: 1, tags: ['title'] }], boxes: [{ id: 't', lineN: 1, style: { ...defaultStyle(), noFill: true, outerGlow: glow, strokeEffects: [newStrokeEffect()] } }] }];
    const [look] = looksOf(pages);
    expect(look.style.noFill).toBe(true);
    expect(look.style.outerGlow).toMatchObject({ on: true, size: 9 });
    expect(look.style.strokeEffects).toHaveLength(1);
    // Left at default, they still switch the target's own off.
    expect(look.style.bevel).toEqual({ on: false });
    expect(look.style.satin).toEqual({ on: false });
    expect(look.style.innerShadows).toEqual([]);
    expect(validateStylePatch({ bevel: look.style.bevel })).toEqual([]);
  });
});

describe('copy_look', () => {
  it('reads another chapter by its number, marking tags this chapter has none of', async () => {
    const r = await call({ from: '14' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.from).toBe('p/c14');
    expect(r.result.looks.find((l) => l.tag === 'sfx-soft').notHere).toBe(true);
    expect(pageById(1).boxes[0].style.font).toBe('Comic Neue');
  });

  it('applies a look to this chapter\'s boxes of the tag, one undo away, and leaves other tags', async () => {
    const r = await call({ from: '14', apply: true });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.applied).toEqual([{ tag: 'speech', matched: 1, changed: 1 }]);
    const [a, n] = pageById(1).boxes;
    expect(a.style).toMatchObject({ font: 'Arial', bold: true, color: '#111111', autoHeight: true });
    expect(a.auto.refSize).toBe(32);
    expect(n.style.font).toBe('Comic Neue');
    undo();
    expect(pageById(1).boxes[0].style.font).toBe('Comic Neue');
  });

  // F53: the look is read from the store, so its own picked tile copies across.
  describe('a look with a picked pattern', () => {
    const picked = { kind: 'picked', src: '0123456789abcdef0123456789abcdef.png', cell: [8, 0, 0, 8] };
    const strokeEffects = [{ ...newStrokeEffect(), fill: 'pattern', pattern: { ...newStrokeEffect().pattern, ...picked } }];
    beforeEach(() => {
      copyPickedTiles.mockClear();
      tilesLost = [];
      record.pages[0].lines.push({ n: 5, en: 'Now', tags: ['narration'] });
      record.pages[0].boxes.push({ id: 'p1', lineN: 5, style: { ...defaultStyle(), font: 'Arial', strokeEffects } });
    });
    afterEach(() => {
      record.pages[0].lines.pop();
      record.pages[0].boxes.pop();
    });

    it('copies the stroke effect and its tile file', async () => {
      const r = await call({ from: '14', apply: true, tags: ['narration'] });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.result.skipped ?? []).toEqual([]);
      const n = pageById(1).boxes[1];
      expect(n.style.strokeEffects).toHaveLength(1);
      expect(n.style.strokeEffects[0].pattern).toMatchObject(picked);
      expect(copyPickedTiles).toHaveBeenCalledTimes(1);
      expect(copyPickedTiles.mock.calls[0][0]).toEqual([picked.src]);
    });

    it('says when the tile could not be copied', async () => {
      tilesLost = [picked.src];
      const r = await call({ from: '14', apply: true, tags: ['narration'] });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.result.skipped).toEqual([expect.objectContaining({ key: 'pattern', value: picked.src })]);
    });
  });

  it('refuses this chapter and an unknown one', async () => {
    expect((await call({ from: '15' })).error).toMatch(/this chapter/);
    expect((await call({ from: '99' })).error).toMatch(/no chapter/);
  });
});
