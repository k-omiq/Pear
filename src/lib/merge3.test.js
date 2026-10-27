import { describe, expect, it } from 'vitest';
import { merge3 } from './merge3.js';

describe('merge3', () => {
  it('keeps what each side changed, and mine where both changed one value', () => {
    const base = { name: 'A', guide: { notes: '', rules: { ellipsis: 'dots' } } };
    const mine = { name: 'A', guide: { notes: 'mine', rules: { ellipsis: 'dots' } } };
    const theirs = { name: 'B', guide: { notes: '', rules: { ellipsis: 'char' } } };
    expect(merge3(base, mine, theirs)).toEqual({ name: 'B', guide: { notes: 'mine', rules: { ellipsis: 'char' } } });
    expect(merge3({ v: 1 }, { v: 2 }, { v: 3 })).toEqual({ v: 2 });
  });

  it('merges lists of records by id or name, keeping both sides\' new ones', () => {
    const base = { tags: [{ name: 'sfx', size: 60 }, { name: 'speech', size: 20 }] };
    const mine = { tags: [{ name: 'sfx', size: 64 }, { name: 'speech', size: 20 }, { name: 'angry', size: 24 }] };
    const theirs = { tags: [{ name: 'speech', size: 22 }, { name: 'sfx', size: 60 }, { name: 'calm', size: 18 }] };
    expect(merge3(base, mine, theirs).tags).toEqual([
      { name: 'speech', size: 22 },
      { name: 'sfx', size: 64 },
      { name: 'calm', size: 18 },
      { name: 'angry', size: 24 },
    ]);
  });

  it('drops what one side removed and the other left alone', () => {
    const base = { glossary: [{ id: 't1', en: 'Faltz' }, { id: 't2', en: 'Root' }], extra: 1 };
    const mine = { glossary: [{ id: 't1', en: 'Faltz' }], extra: 1 };
    const theirs = { glossary: [{ id: 't1', en: 'Faltz' }, { id: 't2', en: 'Root' }, { id: 't3', en: 'Laurel' }] };
    expect(merge3(base, mine, theirs)).toEqual({ glossary: [{ id: 't1', en: 'Faltz' }, { id: 't3', en: 'Laurel' }] });
  });

  it('an untouched side takes the other whole', () => {
    const base = { a: [1, 2] };
    expect(merge3(base, base, { a: [3] })).toEqual({ a: [3] });
    expect(merge3(base, { a: [4] }, base)).toEqual({ a: [4] });
  });
});
