import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  const storage = {};
  vi.stubGlobal('localStorage', {
    getItem: (key) => storage[key] ?? null,
    setItem: (key, value) => { storage[key] = String(value); },
  });
});
afterEach(() => vi.unstubAllGlobals());

const TABLE = [
  ['series', 'Series', 'Project'],
  ['seriesName', 'Series name', 'Project name'],
  ['chapter', 'Chapter', 'Document'],
  ['chapters', 'Chapters', 'Documents'],
  ['newChapter', 'New chapter', 'New document'],
  ['rawPages', 'Raw pages', 'Images'],
  ['raw', 'Raw', 'Image'],
];

describe('word()', () => {
  it.each(TABLE)('%s: comics says %s, general says %s', async (key, comics, general) => {
    const { setPref } = await import('./prefs.svelte.js');
    const { word } = await import('./words.js');
    setPref('usage', 'comics');
    expect(word(key)).toBe(comics);
    setPref('usage', 'general');
    expect(word(key)).toBe(general);
  });

  it('throws on a key it does not know, naming it', async () => {
    const { word } = await import('./words.js');
    expect(() => word('serries')).toThrow(/serries/);
    expect(() => word('toString')).toThrow(/toString/);
  });
});
