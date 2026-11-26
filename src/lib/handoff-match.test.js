import { describe, it, expect } from 'vitest';
import { normalizeName, levenshtein, isClose, candidatesFor, chapterKey, unlinkedChapterFor, pairPages, pairingLine } from './handoff-match.js';

// SHARED_DATA_FOLDER.md section 8.4.2 and 8.4.4.
describe('names', () => {
  it('are normalized: lowercase, NFKC, no punctuation, no "the", one space', () => {
    expect(normalizeName('  The Surviving -- the APOCALYPSE!! ')).toBe('surviving apocalypse');
    expect(normalizeName('Ｄｕｎｇｅｏｎ　Ｓｔｒｅａｍｅｒ')).toBe('dungeon streamer');
    expect(normalizeName('Theatre of Ⅻ')).toBe('theatre of xii');
    expect(normalizeName('魔王様、リトライ！')).toBe('魔王様 リトライ');
  });

  it('are close within 20 percent, or by whole words for 4 characters or more', () => {
    expect(levenshtein('dungeon streamer', 'dungeon steamer')).toBe(1);
    expect(isClose('Dungeon streamer', 'Dungeon Steamer')).toBe(true);
    expect(isClose('apocalypse', 'Surviving the Apocalypse')).toBe(true);
    expect(isClose('One Piece', 'Two Piece')).toBe(false); // 3 of 9, floor(1.8) = 1
    // Short names: containment needs 4 characters.
    expect(isClose('Ban', 'Ban the Dragon')).toBe(false);
    expect(isClose('Bang', 'Big Bang Theory')).toBe(true);
    // Whole words only.
    expect(isClose('pocalypse', 'Surviving the Apocalypse')).toBe(false);
    expect(isClose('', 'Anything')).toBe(false);
  });

  it('give ranked candidates, leaving out projects linked to the same cleaner library', () => {
    const projects = [
      { id: 'a', name: 'Dungeon Steamers' },
      { id: 'b', name: 'Dungeon Steamer' },
      { id: 'c', name: 'The Dungeon Streamer Returns' },
      { id: 'd', name: 'Dungeon streamer', cleanerLink: { libraryId: 'L1', projectId: 'p1' } },
      { id: 'e', name: 'Dungeon streamer', cleanerLink: { libraryId: 'OLD', projectId: 'p1' } },
      { id: 'f', name: 'Cooking', unreadable: true },
      { id: 'g', name: 'Unrelated' },
    ];
    // e is linked to another library (a reinstalled cleaner): a candidate.
    expect(candidatesFor('Dungeon streamer', 'L1', projects).map((c) => c.project.id)).toEqual(['e', 'b', 'a', 'c']);
  });
});

describe('the chapter key', () => {
  it('is the label read as a decimal, else the number; a label that is no number has none', () => {
    expect(chapterKey({ label: '12.5', number: 12 })).toBe(12.5);
    expect(chapterKey({ label: '12,5', number: 12 })).toBe(12.5);
    expect(chapterKey({ label: ' 7 ', number: 1 })).toBe(7);
    expect(chapterKey({ label: null, number: 12 })).toBe(12);
    expect(chapterKey({ label: '', number: 3 })).toBe(3);
    expect(chapterKey({ label: '12-1', number: 12 })).toBe(null);
    expect(chapterKey({ label: 'Extra', number: 12 })).toBe(null);
    expect(chapterKey({ label: null, number: null })).toBe(null);
  });

  it('finds the unlinked chapter here with that key', () => {
    const p = {
      chapters: [
        { id: 'x', number: 12, cleanerLink: { libraryId: 'L1', chapterId: 'c1' } },
        { id: 'y', number: 13, cleanerLink: { libraryId: 'OLD', chapterId: 'c1' } },
        { id: 'z', number: 14 },
      ],
    };
    expect(unlinkedChapterFor(p, 12, 'L1')).toBe(null);
    expect(unlinkedChapterFor(p, 13, 'L1').id).toBe('y');
    expect(unlinkedChapterFor(p, 14, 'L1').id).toBe('z');
    expect(unlinkedChapterFor(p, null, 'L1')).toBe(null);
  });
});

describe('pairing', () => {
  const pg = (sha, w = 10, h = 20) => ({ sha, w, h });
  const here = (list) => list.map((x, i) => ({ ...x, pageId: i + 1 }));

  it('pairs identical raws first, the rest by position with the same size', () => {
    const r = pairPages([pg('a'), pg('b'), pg('c')], here([pg('x'), pg('a'), pg('y')]));
    expect(r.ok).toBe(true);
    expect(r.pairs.map((p) => [p.index, p.pageId, p.how])).toEqual([
      [0, 2, 'same'],
      [1, 1, 'position'],
      [2, 3, 'position'],
    ]);
    expect(pairingLine(r)).toBe('3 pages: 1 identical, 2 by position');
  });

  it('is refused on the count and on a size', () => {
    expect(pairPages([pg('a')], here([pg('a'), pg('b')]))).toEqual({ ok: false, why: 'Pages differ: 1 here, 2 in Pear' });
    const bad = pairPages([pg('a'), pg('b', 10, 21)], here([pg('a'), pg('c')]));
    expect(bad.ok).toBe(false);
    expect(pairingLine(bad)).toBe('Page 2 is 10x21 here and 10x20 in Pear');
  });
});
