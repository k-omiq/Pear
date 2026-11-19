import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fakeIndexedDB } from '../test/fake-indexeddb.js';

// The Font Library screen: the user's families with their switch, the
// keyboard way to move a face ("Move to…"), and the confirm step a folder of
// several families goes through before anything is saved.

const idb = fakeIndexedDB();
beforeAll(() => {
  vi.stubGlobal('indexedDB', idb);
  vi.stubGlobal('FontFace', class {
    async load() {
      return this;
    }
  });
  document.fonts ??= { add() {}, delete() {} };
  if (!document.fonts.add) Object.assign(document.fonts, { add() {}, delete() {} });
});

const { default: FontLibrary } = await import('./FontLibrary.svelte');
const { app } = await import('./store.svelte.js');
const { prefs, setPref } = await import('./prefs.svelte.js');
const fonts = await import('./fonts.js');

const fixture = (name) => readFileSync(resolve(process.cwd(), 'src/test/fonts', name));
const fileOf = (name, bytes, rel = '') => {
  const f = new File([bytes], name);
  if (rel) Object.defineProperty(f, 'webkitRelativePath', { value: rel });
  // jsdom's File may not read: give it the bytes directly.
  f.arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return f;
};
const until = async (fn, tries = 50) => {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
    await tick();
  }
  return fn();
};

beforeEach(async () => {
  idb.rows.clear();
  app.fonts.user = [];
  await fonts.addFontFile(fileOf('Alpha.ttf', fixture('ComicNeue-Regular.ttf')));
  await fonts.addFontFile(fileOf('Beta.ttf', fixture('Bangers-Regular.ttf')));
});
afterEach(() => {
  cleanup();
  setPref('disabledUserFonts', []);
});

it('lists the user’s families with a switch that takes one out of the menus', async () => {
  const view = render(FontLibrary, { props: { embedded: true, onclose: vi.fn() } });
  expect(view.getByRole('region', { name: 'Alpha' })).toBeTruthy();
  const sw = view.getByRole('switch', { name: 'Offer Beta in the font menus' });
  expect(sw.getAttribute('aria-checked')).toBe('true');
  await fireEvent.click(sw);
  expect(prefs.disabledUserFonts).toEqual(['Beta']);
  expect(view.getByRole('switch', { name: 'Offer Beta in the font menus' }).getAttribute('aria-checked')).toBe('false');
});

it('moves a face from the keyboard, through Move to…', async () => {
  const view = render(FontLibrary, { props: { embedded: true } });
  await fireEvent.click(view.getByRole('button', { name: 'Move the Regular face of Beta to…' }));
  await tick();
  const menu = view.getByRole('dialog', { name: 'Move to' });
  // Alpha's four slots, then Beta's: Alpha · Bold is the second button after "own".
  const buttons = [...menu.querySelectorAll('.fl-menu-item')];
  expect(buttons[0].textContent).toBe('A family of its own');
  await fireEvent.click(buttons[2]);
  await until(() => app.fonts.user.length === 1);
  expect(app.fonts.user.map((f) => f.name)).toEqual(['Alpha']);
  expect(app.fonts.user[0].faces.bold?.file).toBe('Beta.ttf');
  expect([...idb.rows.keys()].sort()).toEqual(['Alpha::bold', 'Alpha::regular']);
});

it('asks how to sort a pick of several families, and saves nothing until Import', async () => {
  const view = render(FontLibrary, { props: { embedded: true } });
  const input = document.querySelector('input[type="file"][multiple]:not([webkitdirectory])');
  const files = [fileOf('DejaVuSans.ttf', fixture('DejaVuSans.ttf'), 'Pack/DejaVuSans.ttf'), fileOf('DejaVuSans-Oblique.ttf', fixture('DejaVuSans-Oblique.ttf'), 'Pack/DejaVuSans-Oblique.ttf'), fileOf('Bangers-Regular.ttf', fixture('Bangers-Regular.ttf'), 'Pack/Bangers-Regular.ttf')];
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await fireEvent.change(input);
  const sheet = await until(() => document.querySelector('.is-sheet'));
  expect(sheet).toBeTruthy();
  expect(sheet.querySelector('.is-head').textContent).toContain('2 families');
  const names = [...sheet.querySelectorAll('.is-fam-name')].map((i) => i.value);
  expect(names).toEqual(['DejaVu Sans', 'Bangers']);
  expect([...idb.rows.keys()].some((k) => k.startsWith('DejaVu'))).toBe(false);
  // One family per folder: everything in "Pack".
  await fireEvent.click(view.getByLabelText(/One family per folder/));
  expect([...sheet.querySelectorAll('.is-fam-name')].map((i) => i.value)).toEqual(['Pack']);
  // Back to the names inside the files. Bangers is a built-in's name: left
  // out until it is renamed.
  await fireEvent.click(view.getByLabelText(/By family name in the files/));
  expect(sheet.textContent).toContain('a built-in has this name');
  expect(view.getByRole('button', { name: 'Import 2 faces' }).disabled).toBe(false);
  const bangers = [...sheet.querySelectorAll('.is-fam-name')].find((i) => i.value === 'Bangers');
  bangers.value = 'Bangers Mine';
  await fireEvent.change(bangers);
  await fireEvent.click(view.getByRole('button', { name: 'Import 3 faces' }));
  await until(() => app.fonts.user.some((f) => f.name === 'DejaVu Sans') && app.fonts.user.some((f) => f.name === 'Bangers Mine'));
  expect(app.fonts.user.find((f) => f.name === 'DejaVu Sans').faces).toMatchObject({ regular: { file: 'DejaVuSans.ttf' }, italic: { file: 'DejaVuSans-Oblique.ttf' } });
  expect(idb.rows.has('Bangers Mine::regular')).toBe(true);
  expect(document.querySelector('.is-sheet')).toBe(null);
});

it('makes a category, groups a family into it, and lists the bare ones apart', async () => {
  setPref('fontCategories', []);
  const view = render(FontLibrary, { props: { embedded: true } });
  const side = view.getByRole('group', { name: 'Categories' });
  await fireEvent.click([...side.querySelectorAll('button')].find((b) => b.textContent.includes('New category')));
  const name = view.getByRole('textbox', { name: 'Name of the new category' });
  await fireEvent.input(name, { target: { value: 'SFX' } });
  await fireEvent.keyDown(name, { key: 'Enter' });
  expect(prefs.fontCategories.map((c) => c.name)).toEqual(['SFX']);
  // The new category opens, empty.
  await tick();
  expect(view.getByRole('heading', { level: 2 }).textContent).toBe('SFX');
  expect(view.queryByRole('region', { name: 'Alpha' })).toBe(null);
  // Back to all, and put Beta in it from its folder button.
  await fireEvent.click(view.getByRole('button', { name: /^Your fonts/ }));
  await fireEvent.click(view.getByRole('button', { name: 'Categories of Beta' }));
  const menu = view.getByRole('dialog', { name: 'Categories of Beta' });
  await fireEvent.click(menu.querySelector('input[type="checkbox"]'));
  expect(prefs.fontCategories[0].families).toEqual(['Beta']);
  await fireEvent.keyDown(menu, { key: 'Escape' });
  // The category shows Beta only; the bare list shows Alpha only.
  const cat = [...side.querySelectorAll('button')].find((b) => b.textContent.includes('SFX'));
  expect(cat.textContent).toContain('1');
  await fireEvent.click(cat);
  expect(view.getByRole('region', { name: 'Beta' })).toBeTruthy();
  expect(view.queryByRole('region', { name: 'Alpha' })).toBe(null);
  await fireEvent.click([...side.querySelectorAll('button')].find((b) => b.textContent.includes('Not in a category')));
  expect(view.getByRole('region', { name: 'Alpha' })).toBeTruthy();
  expect(view.queryByRole('region', { name: 'Beta' })).toBe(null);
  setPref('fontCategories', []);
});

it('a removed family leaves its categories; deleting a category keeps its fonts', async () => {
  setPref('fontCategories', [{ id: 'c', name: 'Titles', families: ['Alpha', 'Beta'] }]);
  const view = render(FontLibrary, { props: { embedded: true } });
  await fireEvent.click(view.getByRole('button', { name: 'Remove Alpha' }));
  await fireEvent.click(view.getByRole('button', { name: 'Remove family' }));
  await until(() => prefs.fontCategories[0].families.length === 1);
  expect(prefs.fontCategories[0].families).toEqual(['Beta']);
  const side = view.getByRole('group', { name: 'Categories' });
  await fireEvent.click([...side.querySelectorAll('button')].find((b) => b.textContent.includes('Titles')));
  await fireEvent.click(view.getByRole('button', { name: 'Delete…' }));
  await fireEvent.click(view.getByRole('button', { name: 'Delete category' }));
  expect(prefs.fontCategories).toEqual([]);
  expect(app.fonts.user.map((f) => f.name)).toEqual(['Beta']);
  // Back on every font.
  await tick();
  expect(view.getByRole('heading', { level: 2 }).textContent).toBe('Your fonts');
});

it('lists every marketplace under Marketplace and opens one on its own', async () => {
  setPref('fontMarketplaces', [
    { url: 'https://a.example.com/fonts.json', name: 'Shop A' },
    { url: 'https://b.example.com/fonts.json', name: 'Shop B' },
  ]);
  const view = render(FontLibrary, { props: { embedded: true } });
  const side = view.getByRole('group', { name: 'Marketplaces' });
  const subs = [...side.querySelectorAll('button')].map((b) => b.textContent.trim());
  expect(subs).toEqual(['Shop A', 'Shop B', 'Add marketplace']);
  await fireEvent.click([...side.querySelectorAll('button')][1]);
  expect(view.getByRole('heading', { level: 2 }).textContent).toBe('Shop B');
  expect(view.queryByRole('textbox', { name: 'Marketplace address' })).toBe(null);
  await fireEvent.click([...side.querySelectorAll('button')][2]);
  expect(view.getByRole('heading', { level: 2 }).textContent).toBe('Marketplace');
  expect(view.getByRole('textbox', { name: 'Marketplace address' })).toBeTruthy();
  setPref('fontMarketplaces', []);
});

it('a face moved into another family takes its emptied family’s categories along', async () => {
  setPref('fontCategories', [{ id: 'c', name: 'SFX', families: ['Beta'] }]);
  const view = render(FontLibrary, { props: { embedded: true } });
  await fireEvent.click(view.getByRole('button', { name: 'Move the Regular face of Beta to…' }));
  await tick();
  const menu = view.getByRole('dialog', { name: 'Move to' });
  await fireEvent.click([...menu.querySelectorAll('.fl-menu-item')][2]);
  await until(() => app.fonts.user.length === 1);
  // Beta is gone; its face lives in Alpha now, and so does its membership.
  await until(() => prefs.fontCategories[0].families.includes('Alpha'));
  expect(prefs.fontCategories[0].families).toEqual(['Alpha']);
  setPref('fontCategories', []);
});

it('an armed Delete belongs to one category and disarms on leaving it', async () => {
  setPref('fontCategories', [
    { id: 'a', name: 'Dialogue', families: [] },
    { id: 'b', name: 'SFX', families: [] },
  ]);
  const view = render(FontLibrary, { props: { embedded: true } });
  const side = view.getByRole('group', { name: 'Categories' });
  const row = (n) => [...side.querySelectorAll('button')].find((b) => b.textContent.includes(n));
  await fireEvent.click(row('Dialogue'));
  await fireEvent.click(view.getByRole('button', { name: 'Delete…' }));
  expect(view.getByRole('button', { name: 'Delete category' })).toBeTruthy();
  await fireEvent.click(row('SFX'));
  await tick();
  expect(view.queryByRole('button', { name: 'Delete category' })).toBe(null);
  expect(prefs.fontCategories).toHaveLength(2);
  setPref('fontCategories', []);
});

it('the Categories menu takes the focus when it opens', async () => {
  setPref('fontCategories', [{ id: 'a', name: 'Dialogue', families: [] }]);
  const view = render(FontLibrary, { props: { embedded: true } });
  await fireEvent.click(view.getByRole('button', { name: 'Categories of Alpha' }));
  await tick();
  const menu = view.getByRole('dialog', { name: 'Categories of Alpha' });
  expect(menu.contains(document.activeElement)).toBe(true);
  setPref('fontCategories', []);
});
