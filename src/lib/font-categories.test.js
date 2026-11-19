import { describe, expect, it } from 'vitest';
import {
  cleanCategories,
  createCategory,
  renameCategory,
  deleteCategory,
  moveCategory,
  addToCategory,
  removeFromCategory,
  categoriesOf,
  carryFamily,
  copyFamily,
  dropFamily,
  familiesInView,
  countIn,
  freeName,
} from './font-categories.js';

const fonts = ['Alpha', 'Beta', 'Gamma'].map((name) => ({ name }));

describe('font categories', () => {
  it('makes a category with a free name, and its families start inside it', () => {
    let { list, id } = createCategory([], 'SFX', ['Alpha', 'Alpha'], 'c1');
    expect(list).toEqual([{ id: 'c1', name: 'SFX', families: ['Alpha'] }]);
    ({ list } = createCategory(list, 'sfx', [], 'c2'));
    expect(list[1].name).toBe('sfx 2');
    expect(freeName(list, '  ')).toBe('New category');
    expect(id).toBe('c1');
  });

  it('renames without taking another category’s name', () => {
    let list = createCategory([], 'A', [], 'a').list;
    list = createCategory(list, 'B', [], 'b').list;
    expect(renameCategory(list, 'b', 'A')[1].name).toBe('A 2');
    expect(renameCategory(list, 'b', '   ')).toBe(list);
    expect(renameCategory(list, 'a', 'A')[0].name).toBe('A');
  });

  it('a family can sit in several categories, or in none (bare)', () => {
    let list = createCategory([], 'Dialogue', ['Alpha'], 'd').list;
    list = createCategory(list, 'SFX', [], 's').list;
    list = addToCategory(list, 's', 'Alpha');
    list = addToCategory(list, 's', 'Beta');
    expect(categoriesOf(list, 'Alpha').map((c) => c.id)).toEqual(['d', 's']);
    expect(familiesInView(fonts, list, 'bare').map((f) => f.name)).toEqual(['Gamma']);
    expect(familiesInView(fonts, list, 's').map((f) => f.name)).toEqual(['Alpha', 'Beta']);
    expect(familiesInView(fonts, list, null)).toBe(fonts);
    list = removeFromCategory(list, 's', 'Alpha');
    expect(countIn(fonts, list, 's')).toBe(1);
  });

  it('counts only families the library still has', () => {
    const list = createCategory([], 'Gone', ['Alpha', 'Zeta'], 'g').list;
    expect(countIn(fonts, list, 'g')).toBe(1);
  });

  it('follows a renamed or merged family, and forgets a removed one', () => {
    let list = createCategory([], 'A', ['Alpha', 'Beta'], 'a').list;
    list = createCategory(list, 'B', ['Alpha'], 'b').list;
    expect(carryFamily(list, 'Alpha', 'Omega')).toEqual([
      { id: 'a', name: 'A', families: ['Beta', 'Omega'] },
      { id: 'b', name: 'B', families: ['Omega'] },
    ]);
    // Merged into a family already in the category: once, not twice.
    expect(carryFamily(list, 'Alpha', 'Beta')[0].families).toEqual(['Beta']);
    expect(dropFamily(list, 'Alpha').map((c) => c.families)).toEqual([['Beta'], []]);
  });

  it('moves and deletes, keeping the rest in order', () => {
    let list = ['a', 'b', 'c'].reduce((l, id) => createCategory(l, id.toUpperCase(), [], id).list, []);
    expect(moveCategory(list, 'c', -1).map((c) => c.id)).toEqual(['a', 'c', 'b']);
    expect(moveCategory(list, 'a', -1)).toBe(list);
    expect(deleteCategory(list, 'b').map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('reads only what a stored list may hold', () => {
    expect(cleanCategories('nope')).toBe(null);
    expect(cleanCategories([{ id: 'x', name: 'X', families: 'Alpha' }, null, { id: 'y', name: '' }])).toEqual([{ id: 'x', name: 'X', families: [] }]);
  });

  it('copies a split-off family into the same categories', () => {
    const list = [
      { id: 'a', name: 'A', families: ['Alpha'] },
      { id: 'b', name: 'B', families: ['Beta'] },
    ];
    expect(copyFamily(list, 'Alpha', 'Alpha 2').map((c) => c.families)).toEqual([['Alpha', 'Alpha 2'], ['Beta']]);
  });

  it('numbers a taken long name without passing the length limit', () => {
    const long = 'x'.repeat(60);
    let list = createCategory([], long, [], 'a').list;
    list = createCategory(list, long, [], 'b').list;
    const cleaned = cleanCategories(list);
    expect(cleaned[1].name.length).toBeLessThanOrEqual(60);
    expect(cleaned[1].name).not.toBe(cleaned[0].name);
  });
});
