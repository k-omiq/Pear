// tag: a tag's defaults, checked whole, then written to the registry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../library.svelte.js', async (orig) => ({ ...(await orig()), chapterOpenSeq: () => 1 }));

const { app, loadProjectPages } = await import('../../store.svelte.js');
const { bindTags, unbindTags, findTag } = await import('../../tags.svelte.js');
const { bindGuide, unbindGuide } = await import('../../guide.svelte.js');
const { callTool } = await import('../registry.js');
const { callContext, revertRun, __resetRun } = await import('../run.svelte.js');
const { newStrokeEffect } = await import('../../data.js');
await import('./tag.js');

const call = (args) => callTool('tag', args, callContext('mcp'));
const originalFonts = app.fonts;
let saved;

beforeEach(() => {
  saved = vi.fn();
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.fonts = { user: [{ name: 'CCVictorySpeech Regular' }], builtin: [{ name: 'Comic Neue' }], system: [] };
  bindTags({ list: [{ name: 'speech', style: { color: '#111111' }, size: 18, minSize: 14 }] }, saved);
  bindGuide({}, vi.fn());
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [] }]);
  __resetRun();
});
afterEach(() => {
  __resetRun();
  loadProjectPages([]);
  unbindGuide();
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

  it('puts a user\'s tag under a kind of text, and takes it off with null', async () => {
    const r = await call({ name: 'angry', kind: 'shout', style: { font: 'Comic Neue' } });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.tag).toMatchObject({ name: 'angry', kind: 'shout' });
    await call({ name: 'angry', kind: null });
    expect('kind' in findTag('angry')).toBe(false);
    expect((await call({ name: 'angry', kind: 'yelling' })).error).toMatch(/not a kind of text/);
    expect((await call({ name: 'speech', kind: 'shout' })).error).toMatch(/a kind itself/);
  });

  // F53: the tag's own picked pattern, sent back with an item added.
  it('takes back a stroke effect list holding the tag\'s own picked tile', async () => {
    const pat = { ...newStrokeEffect().pattern, kind: 'picked', src: '0123456789abcdef0123456789abcdef.png', cell: [8, 0, 0, 8] };
    const list = [{ ...newStrokeEffect(), fill: 'pattern', pattern: pat }];
    bindTags({ list: [{ name: 'speech', style: { strokeEffects: list }, size: 18 }] }, saved);
    const r = await call({ name: 'speech', style: { strokeEffects: [...list, { size: 2 }] } });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(findTag('speech').style.strokeEffects[0].pattern.src).toBe(pat.src);
    const other = [{ ...list[0], pattern: { ...pat, src: 'ffffffffffffffffffffffffffffffff.png' } }];
    expect((await call({ name: 'speech', style: { strokeEffects: other } })).ok).toBe(false);
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

  it('is part of the run, so Revert puts the tag back', async () => {
    expect((await call({ name: 'speech', style: { font: 'Comic Neue' } })).ok).toBe(true);
    expect(findTag('speech').style.font).toBe('Comic Neue');
    revertRun();
    expect(findTag('speech').style).toEqual({ color: '#111111' });
  });
});
