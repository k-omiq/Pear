import { describe, it, expect } from 'vitest';
import { glossaryHits, glossaryMisses, textHasTerm, findCharacter, sanitizeGlossary, resolveSpeakerNames } from './glossary.js';

const terms = sanitizeGlossary([
  { source: 'ファルツ', target: 'Faltz' },
  { source: '若', target: 'Young Master' },
  { source: '真', target: 'Makoto', aliases: ['マコト'], character: true },
]);

describe('the glossary matcher', () => {
  it('folds width, case and line breaks', () => {
    expect(textHasTerm('ＦＡＬＴＺ\nsaid', 'faltz')).toBe(true);
    expect(textHasTerm('Young\nMaster', 'young master')).toBe(true);
  });

  it('never checks a one-character term', () => {
    expect(glossaryHits('若が来た', 'The boy came', terms)).toEqual([]);
  });

  it('flags a line whose source has the term and whose English lacks it', () => {
    expect(glossaryMisses('ファルツの町', 'The town of Falz', terms).map((t) => t.target)).toEqual(['Faltz']);
    expect(glossaryMisses('ファルツの町', 'The town of Faltz', terms)).toEqual([]);
  });

  it('counts a source alias, and says nothing about a line with no English', () => {
    expect(glossaryMisses('マコト様', 'Lord Makato', terms).map((t) => t.target)).toEqual(['Makoto']);
    expect(glossaryMisses('ファルツ', '', terms)).toEqual([]);
  });

  it('finds a character by any of its names', () => {
    expect(findCharacter(terms, 'makoto')?.target).toBe('Makoto');
    expect(findCharacter(terms, 'マコト')?.target).toBe('Makoto');
    expect(findCharacter(terms, 'Faltz')).toBe(null);
  });

  it('turns imported speaker names into ids, making a character once per new name', () => {
    const { lines, made } = resolveSpeakerNames(
      [{ n: 1, speakerName: 'makoto' }, { n: 2, speakerName: 'Tomoe' }, { n: 3, speakerName: 'TOMOE' }, { n: 4 }],
      terms,
    );
    expect(made.map((t) => t.target)).toEqual(['Tomoe']);
    expect(lines.map((l) => l.speaker)).toEqual([terms[2].id, made[0].id, made[0].id, undefined]);
    expect(lines.some((l) => 'speakerName' in l)).toBe(false);
  });
});
