import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeIndexedDB } from '../test/fake-indexeddb.js';

// The Font Library's drag and "Move to…": a face moved is its record rewritten
// under its new `family::slot` key and the session's lists made to match; and
// a window following another's writes (`syncUserFonts`). IndexedDB is the
// small stand-in; the module is loaded fresh for each case.

const SFNT = (fill) => Uint8Array.from([0, 1, 0, 0, fill, fill]).buffer;
const fontFile = (name, fill) => ({ name, arrayBuffer: async () => SFNT(fill) });

let idb;
let fonts;
let store;
let registered;
beforeEach(async () => {
  vi.resetModules();
  idb = fakeIndexedDB();
  vi.stubGlobal('indexedDB', idb);
  registered = new Set();
  vi.stubGlobal(
    'FontFace',
    class {
      constructor(family, data, desc) {
        this.family = family;
        this.fill = new Uint8Array(data)[4];
        this.desc = desc;
      }
      async load() {
        return this;
      }
    },
  );
  vi.stubGlobal('document', {
    fonts: { add: (f) => registered.add(f), delete: (f) => registered.delete(f) },
    createElement: () => ({ getContext: () => null }),
  });
  store = await import('./store.svelte.js');
  fonts = await import('./fonts.js');
});
afterEach(() => vi.unstubAllGlobals());

// What the browser has, as `family/weight/style=fill`.
const live = () =>
  [...registered].map((f) => `${f.family}/${f.desc.weight ?? '400'}/${f.desc.style ?? 'normal'}=${f.fill}`).sort();
const keys = () => [...idb.rows.keys()].sort();
const faces = (name) => {
  const g = store.app.fonts.user.find((f) => f.name === name);
  return g ? Object.fromEntries(Object.entries(g.faces).filter(([, v]) => v).map(([k, v]) => [k, v.file])) : null;
};

async function twoFamilies() {
  await fonts.addFontFile(fontFile('Alpha.ttf', 1));
  await fonts.addFontFile(fontFile('Alpha-Bold.ttf', 2));
  await fonts.addFontFile(fontFile('Beta.ttf', 3));
}

describe('moving a face', () => {
  it('rewrites its record under the new slot and registers it there', async () => {
    await twoFamilies();
    const said = [];
    fonts.watchUserFaces({ added: (f, s) => said.push(['added', f, s]), removed: (f, s) => said.push(['removed', f, s]), removedFamily() {} });
    await fonts.moveFontFace({ family: 'Alpha', slot: 'bold' }, { family: 'Alpha', slot: 'italic' });
    expect(keys()).toEqual(['Alpha::italic', 'Alpha::regular', 'Beta::regular']);
    expect(idb.rows.get('Alpha::italic')).toMatchObject({ name: 'Alpha', slot: 'italic', file: 'Alpha-Bold.ttf' });
    expect(faces('Alpha')).toEqual({ regular: 'Alpha.ttf', italic: 'Alpha-Bold.ttf' });
    expect(live()).toEqual(['Alpha/400/italic=2', 'Alpha/400/normal=1', 'Beta/400/normal=3']);
    // Added before the old one is let go: the family is never without it.
    expect(said).toEqual([
      ['added', 'Alpha', 'italic'],
      ['removed', 'Alpha', 'bold'],
    ]);
  });

  it('swaps with the face already in the slot, and loses neither', async () => {
    await twoFamilies();
    await fonts.moveFontFace({ family: 'Alpha', slot: 'regular' }, { family: 'Alpha', slot: 'bold' });
    expect(faces('Alpha')).toEqual({ regular: 'Alpha-Bold.ttf', bold: 'Alpha.ttf' });
    expect(idb.rows.get('Alpha::bold').file).toBe('Alpha.ttf');
    expect(idb.rows.get('Alpha::regular').file).toBe('Alpha-Bold.ttf');
    expect(live()).toEqual(['Alpha/400/normal=2', 'Alpha/700/normal=1', 'Beta/400/normal=3']);
  });

  it('moves a face to another family, and the emptied family goes', async () => {
    await twoFamilies();
    const version = store.app.fontsVersion;
    const before = store.app.fonts.user;
    await fonts.moveFontFace({ family: 'Beta', slot: 'regular' }, { family: 'Alpha', slot: 'italic' });
    expect(store.app.fonts.user.map((f) => f.name)).toEqual(['Alpha']);
    expect(faces('Alpha')).toEqual({ regular: 'Alpha.ttf', bold: 'Alpha-Bold.ttf', italic: 'Beta.ttf' });
    expect(keys()).toEqual(['Alpha::bold', 'Alpha::italic', 'Alpha::regular']);
    // A new list, so the store's name index sees the change.
    expect(store.app.fonts.user).not.toBe(before);
    expect(store.fontByName('Beta')).toBe(null);
    expect(store.app.fontsVersion).toBeGreaterThan(version);
  });
});

describe('renaming and merging families', () => {
  it('renames every face of a family', async () => {
    await twoFamilies();
    expect(await fonts.renameUserFont('Alpha', 'Gamma')).toBe(true);
    // Where Alpha was.
    expect(store.app.fonts.user.map((f) => f.name)).toEqual(['Gamma', 'Beta']);
    expect(faces('Gamma')).toEqual({ regular: 'Alpha.ttf', bold: 'Alpha-Bold.ttf' });
    expect(keys()).toEqual(['Beta::regular', 'Gamma::bold', 'Gamma::regular']);
    expect(store.fontByName('Gamma')?.faces.bold.file).toBe('Alpha-Bold.ttf');
    expect(store.fontByName('Alpha')).toBe(null);
  });

  it('merges into a family that exists, keeping back a slot that is taken', async () => {
    await twoFamilies();
    // Beta has a regular; Alpha's regular stays in Alpha, its bold moves.
    const r = await fonts.mergeUserFonts('Alpha', 'Beta');
    expect(r).toEqual({ moved: 1, kept: ['regular'] });
    expect(faces('Alpha')).toEqual({ regular: 'Alpha.ttf' });
    expect(faces('Beta')).toEqual({ regular: 'Beta.ttf', bold: 'Alpha-Bold.ttf' });
  });

  it('refuses a built-in’s name', async () => {
    await twoFamilies();
    const builtin = store.app.fonts.builtin[0].name;
    expect(await fonts.renameUserFont('Alpha', builtin)).toBe(false);
    expect(faces('Alpha')).toEqual({ regular: 'Alpha.ttf', bold: 'Alpha-Bold.ttf' });
  });
});

describe('following another window', () => {
  it('registers a face another window wrote, lets go of one it removed, and leaves the rest alone', async () => {
    await twoFamilies();
    const alpha = [...registered].find((f) => f.family === 'Alpha' && !f.desc.weight);
    // Another window: Beta removed, Delta added, Alpha's regular untouched.
    idb.rows.delete('Beta::regular');
    idb.rows.set('Delta::regular', { key: 'Delta::regular', name: 'Delta', slot: 'regular', file: 'Delta.ttf', data: SFNT(9), at: 1 });
    expect(await fonts.syncUserFonts()).toBe(true);
    expect(store.app.fonts.user.map((f) => f.name)).toEqual(['Alpha', 'Delta']);
    expect(live()).toEqual(['Alpha/400/normal=1', 'Alpha/700/normal=2', 'Delta/400/normal=9']);
    // The very same face object: a box set in Alpha never lost it.
    expect(registered.has(alpha)).toBe(true);
    // Nothing more to do the second time.
    expect(await fonts.syncUserFonts()).toBe(false);
  });

  it('picks up a face replaced in place', async () => {
    await twoFamilies();
    idb.rows.set('Beta::regular', { key: 'Beta::regular', name: 'Beta', slot: 'regular', file: 'Beta-v2.ttf', data: SFNT(7), at: Date.now() + 1 });
    await fonts.syncUserFonts();
    expect(faces('Beta')).toEqual({ regular: 'Beta-v2.ttf' });
    expect(live()).toContain('Beta/400/normal=7');
    expect(live()).not.toContain('Beta/400/normal=3');
  });

  it('tells the other windows after each write', async () => {
    const told = vi.fn();
    fonts.setFontsWrittenHook(told);
    await fonts.addFontFile(fontFile('Alpha.ttf', 1));
    expect(told).toHaveBeenCalledTimes(1);
    await fonts.moveFontFace({ family: 'Alpha', slot: 'regular' }, { family: 'Alpha', slot: 'bold' });
    expect(told).toHaveBeenCalledTimes(2);
    await fonts.removeUserFont('Alpha');
    expect(told).toHaveBeenCalledTimes(3);
    // A sync is reading, not writing: it tells nobody.
    idb.rows.set('Zeta::regular', { key: 'Zeta::regular', name: 'Zeta', slot: 'regular', file: 'z.ttf', data: SFNT(5), at: 2 });
    await fonts.syncUserFonts();
    expect(told).toHaveBeenCalledTimes(3);
  });
});
