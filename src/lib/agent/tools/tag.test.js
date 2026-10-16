// tag: a tag's defaults, checked whole, then written to the registry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../library.svelte.js', async (orig) => ({ ...(await orig()), chapterOpenSeq: () => 1 }));

const { app, loadProjectPages } = await import('../../store.svelte.js');
const { bindTags, unbindTags, findTag } = await import('../../tags.svelte.js');
const { callTool } = await import('../registry.js');
const { callContext, __resetRun } = await import('../run.svelte.js');
await import('./tag.js');

const call = (args) => callTool('tag', args, callContext('mcp'));
const originalFonts = app.fonts;
let saved;

beforeEach(() => {
  saved = vi.fn();
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.fonts = { user: [{ name: 'CCVictorySpeech Regular' }], builtin: [{ name: 'Comic Neue' }], system: [] };
  bindTags({ list: [{ name: 'speech', style: { color: '#111111' }, size: 18, minSize: 14 }] }, saved);
  loadProjectPages([]);
  __resetRun();
});
afterEach(() => {
  unbindTags();
  app.fonts = originalFonts;
  app.chapterRef = null;
});

describe('tag', () => {
  it('merges a style into the tag, and sets its sizes', async () => {
    const r = await call({ name: 'speech', style: { font: 'ccvictoryspeech regular' }, size: 16, minSize: 12 });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(findTag('speech')).toMatchObject({ style: { color: '#111111', font: 'CCVictorySpeech Regular' }, size: 16, minSize: 12 });
    expect(saved).toHaveBeenCalled();
  });

  it('adds a new tag, and clears a size with null', async () => {
    expect((await call({ name: 'narration', size: 15 })).ok).toBe(true);
    expect(findTag('narration').size).toBe(15);
    await call({ name: 'speech', minSize: null });
    expect(findTag('speech').minSize).toBeNull();
  });

  it('refuses geometry, unknown fonts and a least size above the size, changing nothing', async () => {
    for (const [args, re] of [
      [{ name: 'speech', style: { size: 20 } }, /not a tag key/],
      [{ name: 'speech', style: { font: 'Nope Sans' } }, /no font/],
      [{ name: 'speech', minSize: 20 }, /minSize is above size/],
      [{ name: 'speech' }, /nothing to set/],
    ]) {
      const r = await call(args);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(re);
    }
    expect(findTag('speech')).toMatchObject({ size: 18, minSize: 14, style: { color: '#111111' } });
  });
});
