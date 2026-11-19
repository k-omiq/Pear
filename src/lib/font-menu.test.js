import { afterEach, describe, expect, it } from 'vitest';
import { app, setFontSource } from './store.svelte.js';
import { fontCaveat, setBuiltinHidden, fontGroups, isFamilyOn, setFamilyOn, setFamiliesOn, carryFamilySwitch } from './font-menu.js';
import { systemFontEntry } from './fonts.js';
import { emptyFaces } from './data.js';
import { setPref, prefs, adoptSharedPrefs } from './prefs.svelte.js';

// What a font select says beside the family a box is set in. "Hidden from the
// menus" and "not on this machine" used to be the same words.

afterEach(() => {
  app.fonts.user = [];
  app.fonts.system = [];
  setPref('hiddenBuiltinFonts', []);
  setPref('shownSystemFonts', []);
  setPref('disabledUserFonts', []);
  setPref('fontMarketplaces', []);
  setFontSource(null);
});

const userFont = (name) => ({ name, css: `'${name}'`, real: true, faces: { ...emptyFaces(), regular: { file: `${name}.ttf` } } });
const offered = () => Object.fromEntries(fontGroups().map((g) => [g.key, g.fonts.map((f) => f.name)]));

describe('the Font Library’s on/off switch', () => {
  it('takes a family of any kind out of the menus and puts it back', () => {
    app.fonts.user = [userFont('Wild Words'), userFont('Anime Ace')];
    app.fonts.system = [systemFontEntry({ name: 'Zapfino', faces: { regular: true } }), systemFontEntry({ name: 'Menlo', faces: { regular: true } })];
    const builtin = app.fonts.builtin[0].name;
    // A fresh install: own fonts and built-ins on, installed fonts off.
    expect(isFamilyOn('user', 'Wild Words')).toBe(true);
    expect(isFamilyOn('builtin', builtin)).toBe(true);
    expect(isFamilyOn('system', 'Zapfino')).toBe(false);
    expect(offered().system).toBeUndefined();

    setFamilyOn('user', 'Wild Words', false);
    setFamilyOn('builtin', builtin, false);
    setFamilyOn('system', 'Zapfino', true);
    expect(offered().user).toEqual(['Anime Ace']);
    expect(offered().builtin).not.toContain(builtin);
    expect(offered().system).toEqual(['Zapfino']);
    // Kept where the switches always were, so the old lists still read.
    expect(prefs.disabledUserFonts).toEqual(['Wild Words']);
    expect(prefs.hiddenBuiltinFonts).toEqual([builtin]);
    expect(prefs.shownSystemFonts).toEqual(['Zapfino']);

    setFamiliesOn('system', ['Zapfino', 'Menlo'], true);
    expect(offered().system).toEqual(['Zapfino', 'Menlo']);
    setFamiliesOn('system', ['Zapfino', 'Menlo'], false);
    expect(offered().system).toBeUndefined();
  });

  it('follows a family renamed in the library', () => {
    setFamilyOn('user', 'Old Name', false);
    carryFamilySwitch('Old Name', 'New Name');
    expect(prefs.disabledUserFonts).toEqual(['New Name']);
  });

  it('is adopted from another window’s write', () => {
    const blob = JSON.stringify({
      disabledUserFonts: ['Wild Words'],
      shownSystemFonts: ['Zapfino'],
      hiddenBuiltinFonts: [],
      fontMarketplaces: [{ url: 'https://fonts.example.com/m.json', name: 'M' }, { url: 'ftp://nope', name: 'x' }],
    });
    adoptSharedPrefs(blob);
    expect(prefs.disabledUserFonts).toEqual(['Wild Words']);
    expect(prefs.shownSystemFonts).toEqual(['Zapfino']);
    expect(prefs.fontMarketplaces).toEqual([{ url: 'https://fonts.example.com/m.json', name: 'M' }]);
  });

  it('adopts another window’s font categories, dropping what is not one', () => {
    adoptSharedPrefs(
      JSON.stringify({
        fontCategories: [{ id: 'a', name: ' SFX ', families: ['Bangers', 'Bangers', 3] }, { id: 'a', name: 'Twin' }, { name: 'No id' }],
      }),
    );
    expect(prefs.fontCategories).toEqual([{ id: 'a', name: 'SFX', families: ['Bangers'] }]);
    setPref('fontCategories', []);
  });
});

describe('the note beside a box’s font', () => {
  it('is nothing for a family the menus offer', () => {
    app.fonts.user = [{ name: 'Wild Words', css: "'Wild Words'", real: true, faces: { ...emptyFaces(), regular: { file: 'ww.ttf' } } }];
    expect(fontCaveat('Bangers')).toBe(null);
    expect(fontCaveat('Wild Words')).toBe(null);
    expect(fontCaveat('')).toBe(null);
    expect(fontCaveat(undefined)).toBe(null);
  });

  it('says a hidden built-in and an unshown system font are only out of the menus', () => {
    setBuiltinHidden('Bangers', true);
    app.fonts.system = [systemFontEntry({ name: 'Zapfino', faces: { regular: true } })];
    expect(fontCaveat('Bangers')).toBe('not in menus');
    expect(fontCaveat('Zapfino')).toBe('not in menus');
  });

  it('says a family no list has is missing', () => {
    expect(fontCaveat('Gone Font')).toBe('font missing');
  });

  it('says a user font switched off is only out of the menus', () => {
    app.fonts.user = [{ name: 'Wild Words', css: "'Wild Words'", real: true, faces: { ...emptyFaces(), regular: { file: 'ww.ttf' } } }];
    setFamilyOn('user', 'Wild Words', false);
    expect(fontCaveat('Wild Words')).toBe('not in menus');
    setFamilyOn('user', 'Wild Words', true);
    expect(fontCaveat('Wild Words')).toBe(null);
  });

  it('says missing first, even of a family a menu still lists', () => {
    // What the Rust engine's font source answers for a built-in: no bytes.
    setFontSource({ ready: () => true, missing: (name) => name === 'Bangers' });
    expect(fontCaveat('Bangers')).toBe('font missing');
    expect(fontCaveat('Comic Neue')).toBe(null);
    setBuiltinHidden('Comic Neue', true);
    expect(fontCaveat('Comic Neue')).toBe('not in menus');
  });
});
