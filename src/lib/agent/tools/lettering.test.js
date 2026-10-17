// lettering: the series' lettering style - read with what the chapter already
// uses, asked while not set up, saved to the guide and the tag registry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Another chapter of the series, lettered by hand, read off "disk".
const series = vi.hoisted(() => ({ project: null, records: {} }));
vi.mock('../../library.svelte.js', async (orig) => ({
  ...(await orig()),
  chapterOpenSeq: () => 1,
  projectById: (id) => (id === series.project?.id ? series.project : null),
  readChapterRecord: async (_p, id) => {
    if (!series.records[id]) throw new Error('No such chapter');
    return series.records[id];
  },
}));

const { app, loadProjectPages, inheritedStyleFor } = await import('../../store.svelte.js');
const { bindTags, unbindTags, findTag } = await import('../../tags.svelte.js');
const { guide, bindGuide, unbindGuide } = await import('../../guide.svelte.js');
const { callTool } = await import('../registry.js');
const { callContext, revertRun, __resetRun } = await import('../run.svelte.js');
await import('./lettering.js');

const call = (args) => callTool('lettering', args, callContext('mcp'));
const originalFonts = app.fonts;
const box = (id, lineN, font) => ({ id, lineN, x: 10, y: 10, w: 100, h: 60, style: { font, size: 30 } });
let savedGuide;

beforeEach(() => {
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.fonts = { user: [{ name: 'DaftBrush Text' }, { name: 'CCMarianChurchland' }, { name: 'SSGirlKisser' }, { name: 'Stabby Thin' }], builtin: [], system: [] };
  bindTags({ list: [{ name: 'narration', style: { font: 'CCMarianChurchland', italic: true }, size: 26 }] }, vi.fn());
  savedGuide = vi.fn();
  bindGuide({ glossary: [{ id: 'mom', source: 'ママ', target: 'Mother', character: true }] }, savedGuide);
  loadProjectPages([{
    id: 1, w: 800, h: 1200,
    lines: [
      { n: 1, en: 'Hello', tags: ['speech'] },
      { n: 2, en: 'Hi', tags: ['speech'], speaker: 'mom' },
      { n: 3, en: 'Long ago', tags: ['narration'] },
    ],
    boxes: [box('b1', 1, 'DaftBrush Text'), box('b2', 2, 'SSGirlKisser'), box('b3', 1, 'DaftBrush Text'), box('b4', 3, 'CCMarianChurchland'), box('b5', null, 'Stabby Thin')],
  }]);
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

describe('lettering get', () => {
  it('reads not set up, with the questions to ask and the fonts the chapter already uses', async () => {
    const { ok, result } = await call({ action: 'get' });
    expect(ok).toBe(true);
    expect(result.setup).toBe(false);
    const speech = result.roles.find((r) => r.role === 'speech');
    expect(speech).toMatchObject({ font: null, usedFonts: [{ font: 'DaftBrush Text', boxes: 2 }, { font: 'SSGirlKisser', boxes: 1 }] });
    expect(result.roles.find((r) => r.role === 'narration')).toMatchObject({ font: 'CCMarianChurchland', look: 'italic' });
    expect(result.otherFonts['(untagged)']).toEqual([{ font: 'Stabby Thin', boxes: 1 }]);
    // A role with a font is not asked again; the voices question is there
    // because the series has a character; freedom comes last.
    const keys = result.ask.map((q) => q.key);
    expect(keys).toContain('speech');
    expect(keys).not.toContain('narration');
    expect(keys).toContain('characters');
    expect(keys.at(-1)).toBe('freedom');
    expect(result.ask.find((q) => q.key === 'speech').seen).toEqual(['DaftBrush Text', 'SSGirlKisser']);
    expect(result.characters).toEqual([{ id: 'mom', name: { untrusted: 'Mother' }, tag: null, font: null }]);
    expect(result.speakerLines).toBe(1);
  });

  it('counts the fonts of the series\' other chapters too, skipping one it cannot read', async () => {
    series.project = { id: 'p', chapters: [{ id: 'c', number: 2 }, { id: 'c1', number: 1 }, { id: 'gone', number: 3 }, { id: 'dup', number: 1, duplicate: true }] };
    series.records = {
      c1: { pages: [{ lines: [{ n: 1, tags: ['speech'] }], boxes: [box('x1', 1, 'SSGirlKisser'), box('x2', 1, 'SSGirlKisser')] }] },
      dup: { pages: [{ lines: [{ n: 1, tags: ['speech'] }], boxes: [box('y1', 1, 'Nope')] }] },
    };
    const { result } = await call({ action: 'get' });
    expect(result.chaptersRead).toBe(2);
    expect(result.roles.find((r) => r.role === 'speech').usedFonts).toEqual([{ font: 'SSGirlKisser', boxes: 3 }, { font: 'DaftBrush Text', boxes: 2 }]);
    series.project = null;
    series.records = {};
  });

  it('asks no voices question when the series has no character and no line names a speaker', async () => {
    bindGuide({}, savedGuide);
    app.pages[0].lines[1].speaker = undefined;
    const { result } = await call({ action: 'get' });
    expect(result.ask.map((q) => q.key)).not.toContain('characters');
  });
});

describe('lettering set', () => {
  it('saves role fonts on the role tags, a voice on the character, and the freedom in the guide', async () => {
    const r = await call({
      action: 'set',
      fonts: { speech: 'daftbrush text', 'sfx-sharp': 'Stabby Thin', narration: null },
      characters: [{ id: 'mom', font: 'SSGirlKisser' }],
      freedom: 'balanced',
      notes: 'SFX take the colour of the art.',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(findTag('speech').style).toEqual({ font: 'DaftBrush Text' });
    expect(findTag('sfx-sharp').style).toEqual({ font: 'Stabby Thin' });
    // Clearing a font leaves the rest of the tag's look.
    expect(findTag('narration').style).toEqual({ italic: true });
    expect(guide.glossary[0].tag).toBe('voice-mother');
    expect(findTag('voice-mother').style).toEqual({ font: 'SSGirlKisser' });
    expect(guide.lettering).toEqual({ freedom: 'balanced', notes: 'SFX take the colour of the art.' });
    expect(r.result.setup).toBe(true);
    expect(r.result.ask).toBeUndefined();
    expect(savedGuide).toHaveBeenCalled();
  });

  it('checks everything first: a bad font, role or character changes nothing', async () => {
    // Each bad call also carries a good freedom, which must not be saved.
    for (const [args, re] of [
      [{ action: 'set', freedom: 'free', fonts: { speech: 'Nope Sans' } }, /no font "Nope Sans"/],
      [{ action: 'set', freedom: 'free', fonts: { dialog: 'DaftBrush Text' } }, /not a role/],
      [{ action: 'set', freedom: 'free', characters: [{ id: 'dad', font: 'DaftBrush Text' }] }, /no character "dad"/],
      [{ action: 'set', freedom: 'wild' }, /freedom/],
      [{ action: 'set' }, /nothing to set/],
      [{ action: 'get', freedom: 'free' }, /get takes only action/],
    ]) {
      const r = await call(args);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(re);
    }
    expect(findTag('speech')).toBeNull();
    expect(guide.lettering.freedom).toBeNull();
  });

  it('is part of the run: Revert puts the guide and the tags back', async () => {
    await call({ action: 'set', fonts: { speech: 'DaftBrush Text' }, characters: [{ id: 'mom', font: 'SSGirlKisser' }], freedom: 'free' });
    revertRun();
    expect(findTag('speech')).toBeNull();
    expect(findTag('voice-mother')).toBeNull();
    expect(guide.glossary[0].tag).toBeNull();
    expect(guide.lettering.freedom).toBeNull();
  });

  it('Revert puts back only what the run changed, not the user\'s tag and guide edits since', async () => {
    const { saveTagDefaults } = await import('../../tags.svelte.js');
    const { setGuideNotes } = await import('../../guide.svelte.js');
    await call({ action: 'set', fonts: { speech: 'DaftBrush Text' }, freedom: 'free' });
    saveTagDefaults('mine', { style: { font: 'Stabby Thin' } });
    saveTagDefaults('narration', { style: { font: 'CCMarianChurchland', italic: false } });
    setGuideNotes('the user wrote this');
    revertRun();
    expect(findTag('speech')).toBeNull();
    expect(guide.lettering.freedom).toBeNull();
    expect(findTag('mine')?.style.font).toBe('Stabby Thin');
    expect(findTag('narration')?.style.italic).toBe(false);
    expect(guide.notes).toBe('the user wrote this');
  });
});

describe('context', () => {
  it('says whether the lettering is set up', async () => {
    await import('./read.js');
    const before = await callTool('context', {}, callContext('mcp'));
    expect(before.result.lettering).toMatchObject({ setup: false });
    expect(before.result.lettering.todo).toMatch(/lettering get/);
    await call({ action: 'set', freedom: 'strict' });
    const after = await callTool('context', {}, callContext('mcp'));
    expect(after.result.lettering).toEqual({ setup: true, freedom: 'strict' });
  });
});

describe('a character\'s voice', () => {
  it('beats the ways of speaking, and loses to any other kind of text', async () => {
    await call({ action: 'set', fonts: { speech: 'DaftBrush Text', shout: 'Stabby Thin' }, characters: [{ id: 'mom', font: 'SSGirlKisser' }] });
    const font = (tags) => inheritedStyleFor({ n: 9, tags, speaker: 'mom' }).font;
    expect(font(['speech'])).toBe('SSGirlKisser');
    expect(font(['shout'])).toBe('SSGirlKisser');
    expect(font([])).toBe('SSGirlKisser');
    expect(font(['narration'])).toBe('CCMarianChurchland');
    expect(inheritedStyleFor({ n: 9, tags: ['speech'] }).font).toBe('DaftBrush Text');
  });

  it('wins too when the line already carries the voice tag after a way of speaking', async () => {
    await call({ action: 'set', fonts: { shout: 'Stabby Thin' }, characters: [{ id: 'mom', font: 'SSGirlKisser' }] });
    expect(inheritedStyleFor({ n: 9, tags: ['shout', 'voice-mother'], speaker: 'mom' }).font).toBe('SSGirlKisser');
  });

  it('follows the character through Reset to tag style', async () => {
    const { resetBoxToTagStyle } = await import('../../store.svelte.js');
    await call({ action: 'set', fonts: { speech: 'DaftBrush Text' }, characters: [{ id: 'mom', font: 'SSGirlKisser' }] });
    app.pages[0].boxes.find((b) => b.id === 'b2').style.font = 'Stabby Thin';
    resetBoxToTagStyle('b2');
    expect(app.pages[0].boxes.find((b) => b.id === 'b2').style.font).toBe('SSGirlKisser');
  });

  it('gets a tag of its own when two characters share a name', async () => {
    const { addTerm } = await import('../../guide.svelte.js');
    const twin = addTerm({ source: 'ママ2', target: 'Mother', character: true });
    await call({ action: 'set', characters: [{ id: 'mom', font: 'SSGirlKisser' }, { id: twin.id, font: 'Stabby Thin' }] });
    const tagOf = (id) => guide.glossary.find((t) => t.id === id).tag;
    expect(tagOf('mom')).toBe('voice-mother');
    expect(tagOf(twin.id)).toBe('voice-mother-2');
    expect(findTag('voice-mother').style.font).toBe('SSGirlKisser');
    expect(findTag('voice-mother-2').style.font).toBe('Stabby Thin');
  });

  it('can be named by the user when the guide has no such character, and follows set.speaker', async () => {
    await import('./edit.js');
    const r = await call({ action: 'set', characters: [{ name: 'Old Swordsman', font: 'Stabby Thin' }, { name: 'mother', font: 'SSGirlKisser' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const sword = guide.glossary.find((t) => t.target === 'Old Swordsman');
    expect(sword).toMatchObject({ character: true, locked: false, tag: 'voice-old-swordsman' });
    expect(guide.glossary.filter((t) => t.character)).toHaveLength(2); // "mother" is the guide's Mother
    expect(findTag('voice-old-swordsman').style.font).toBe('Stabby Thin');
    const e = await callTool('edit', { ops: [{ where: { ids: ['b1'] }, set: { speaker: sword.id } }] }, callContext('mcp'));
    expect(e.ok, JSON.stringify(e)).toBe(true);
    expect(app.pages[0].lines[0].speaker).toBe(sword.id);
    expect(app.pages[0].boxes.find((b) => b.id === 'b1').style.font).toBe('Stabby Thin');
    const bad = await callTool('edit', { ops: [{ where: { ids: ['b1'] }, set: { speaker: 'nobody' } }] }, callContext('mcp'));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/no character "nobody"/);
    const both = await call({ action: 'set', characters: [{ id: 'mom', name: 'Mother', font: 'SSGirlKisser' }] });
    expect(both.ok).toBe(false);
  });

  it('is found when the term names its tag in another case', async () => {
    const { updateTerm } = await import('../../guide.svelte.js');
    updateTerm('mom', { tag: 'Voice Mom' });
    await call({ action: 'set', characters: [{ id: 'mom', font: 'SSGirlKisser' }] });
    expect(guide.glossary[0].tag).toBe('voice mom');
    expect(inheritedStyleFor({ n: 9, tags: ['speech'], speaker: 'mom' }).font).toBe('SSGirlKisser');
  });
});
