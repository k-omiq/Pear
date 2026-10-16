import { describe, it, expect } from 'vitest';
import { sfxMeaning, sfxMeaningsIn } from './sfx-meanings.js';

describe('the SFX meanings', () => {
  it('reads a sound in katakana or hiragana, with its punctuation', () => {
    expect(sfxMeaning('ドキドキ')?.meanings).toContain('pounding heartbeat');
    expect(sfxMeaning('どきどき…!')?.source).toBeTruthy();
  });

  it('reads a Korean sound', () => {
    expect(sfxMeaning('쉿')?.meanings).toContain('shh');
  });

  it('says nothing for ordinary words or nothing at all', () => {
    expect(sfxMeaning('こんにちは')).toBe(null);
    expect(sfxMeaning('')).toBe(null);
  });

  it('finds a sound inside a longer line', () => {
    expect(sfxMeaningsIn('急にドキドキしてきた').length).toBeGreaterThan(0);
  });
});
