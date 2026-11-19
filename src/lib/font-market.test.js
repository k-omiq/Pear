import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fakeIndexedDB } from '../test/fake-indexeddb.js';

// A marketplace's manifest (docs/FONT_MARKETPLACE.md) read and checked, and a
// font installed from it through the same path as a dropped file. The network
// is a stand-in `fetch` serving the tracked fixture fonts.

const BASE = 'https://fonts.example.com/market/';
const bangers = readFileSync(new URL('../test/fonts/Bangers-Regular.ttf', import.meta.url));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const manifest = (fonts, extra = {}) => ({ format: 'pear-font-market', version: 1, name: 'Test Market', fonts, ...extra });
const font = (over = {}) => ({
  id: 'bangers',
  family: 'Bangers Test',
  designer: 'Vernon Adams',
  license: { name: 'OFL-1.1', url: 'https://openfontlicense.org' },
  tags: ['Display', 'SFX'],
  files: [{ url: 'files/Bangers-Regular.ttf', style: 'Regular', size: bangers.byteLength, sha256: sha(bangers) }],
  ...over,
});

let market;
let store;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', fakeIndexedDB());
  vi.stubGlobal('FontFace', class {
    async load() {
      return this;
    }
  });
  vi.stubGlobal('document', { fonts: { add() {}, delete() {} }, createElement: () => ({ getContext: () => null }) });
  store = await import('./store.svelte.js');
  market = await import('./font-market.js');
});
afterEach(() => vi.unstubAllGlobals());

describe('reading a manifest', () => {
  it('takes a good font, with its addresses read against the manifest’s', () => {
    const m = market.parseManifest(JSON.stringify(manifest([font({ preview: 'img/bangers.png' })])), `${BASE}index.json`);
    expect(m.name).toBe('Test Market');
    expect(m.skipped).toEqual([]);
    expect(m.fonts).toHaveLength(1);
    expect(m.fonts[0]).toMatchObject({
      id: 'bangers',
      family: 'Bangers Test',
      license: { name: 'OFL-1.1', url: 'https://openfontlicense.org/' },
      preview: `${BASE}img/bangers.png`,
      tags: ['display', 'sfx'],
      files: [{ url: `${BASE}files/Bangers-Regular.ttf`, slot: 'regular', size: bangers.byteLength }],
    });
  });

  it('lists each bad font with its reason and keeps the rest', () => {
    const m = market.parseManifest(
      manifest([
        font(),
        font({ id: 'bangers' }),
        font({ id: 'nolicence', license: undefined }),
        font({ id: 'plain-http', files: [{ url: 'http://evil.example/x.ttf', slot: 'regular' }] }),
        font({ id: 'twice', files: [{ url: 'a.ttf', slot: 'bold' }, { url: 'b.ttf', style: 'Bold' }] }),
        font({ id: 'nostyle', files: [{ url: 'a.ttf', style: 'Light' }] }),
        font({ id: 'badsum', files: [{ url: 'a.ttf', slot: 'regular', sha256: 'abc' }] }),
        font({ id: 'nofiles', files: [] }),
        { family: 'No Id', license: 'OFL', files: [{ url: 'a.ttf' }] },
      ]),
      `${BASE}index.json`,
    );
    expect(m.fonts.map((f) => f.id)).toEqual(['bangers']);
    expect(m.skipped.map((s) => `${s.id}: ${s.reason}`)).toEqual([
      'bangers: id used twice',
      'nolicence: no licence',
      'plain-http: has a file address that is not https',
      'twice: has two files for Bold',
      'nostyle: has a file whose style is not one of Regular, Bold, Italic, Bold Italic',
      'badsum: has a sha256 that is not 64 hex digits',
      'nofiles: no files',
      'No Id: no id',
    ]);
  });

  it('refuses what is not a Pear font list', () => {
    const at = `${BASE}index.json`;
    expect(() => market.parseManifest('<html>', at)).toThrow(/not JSON/);
    expect(() => market.parseManifest('[]', at)).toThrow(/not a JSON object/);
    expect(() => market.parseManifest({ format: 'something-else', fonts: [] }, at)).toThrow(/not a Pear font list/);
    expect(() => market.parseManifest({ version: 9, fonts: [] }, at)).toThrow(/version 9/);
    expect(() => market.parseManifest({ version: 1 }, at)).toThrow(/no "fonts"/);
  });

  it('speaks https, and http only to this machine', () => {
    expect(market.allowedUrl('https://a.example/x.json')).toBe('https://a.example/x.json');
    expect(market.allowedUrl('http://localhost:5240/x.json')).toBe('http://localhost:5240/x.json');
    expect(market.allowedUrl('http://a.example/x.json')).toBe(null);
    expect(market.allowedUrl('file:///etc/hosts')).toBe(null);
    expect(market.allowedUrl('https://user:pw@a.example/')).toBe(null);
    // No address is not the manifest's own address.
    expect(market.allowedUrl('', 'https://a.example/m.json')).toBe(null);
    expect(market.allowedUrl(undefined, 'https://a.example/m.json')).toBe(null);
    const m = market.parseManifest(manifest([font({ license: 'OFL-1.1' })]), `${BASE}index.json`);
    expect(m.fonts[0].license).toEqual({ name: 'OFL-1.1', url: null });
    expect(m.fonts[0].preview).toBe(null);
  });

  it('searches by name, designer and tag', () => {
    const fonts = market.parseManifest(manifest([font(), font({ id: 'b', family: 'Wild Words', designer: 'Blambot', tags: ['dialogue'] })]), `${BASE}i.json`).fonts;
    expect(market.filterFonts(fonts, { query: 'blam' }).map((f) => f.id)).toEqual(['b']);
    expect(market.filterFonts(fonts, { tag: 'sfx' }).map((f) => f.id)).toEqual(['bangers']);
    expect(market.tagsOf(fonts)).toEqual(['dialogue', 'display', 'sfx']);
  });
});

describe('installing a font', () => {
  const serve = (files) =>
    vi.fn(async (url) => {
      const body = files[url];
      return body ? { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) } : { ok: false, status: 404 };
    });

  it('downloads, checks and adds every face, then says it is installed', async () => {
    const m = market.parseManifest(manifest([font()]), `${BASE}index.json`);
    const fetchImpl = serve({ [`${BASE}files/Bangers-Regular.ttf`]: bangers });
    expect(market.installState(m.fonts[0])).toBe(null);
    expect(await market.installMarketFont(m.fonts[0], `${BASE}index.json`, { fetchImpl })).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.app.fonts.user.find((f) => f.name === 'Bangers Test')?.faces.regular.file).toBe('Bangers-Regular.ttf');
    expect(market.installState(m.fonts[0])).toBe('installed');
    // Installed faces are not downloaded again.
    expect(await market.installMarketFont(m.fonts[0], `${BASE}index.json`, { fetchImpl })).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing that is not a font, or not the file the list named', async () => {
    const notFont = new TextEncoder().encode('<html>404 page that answered 200</html>');
    const m = market.parseManifest(manifest([font()]), `${BASE}index.json`);
    let fetchImpl = serve({ [`${BASE}files/Bangers-Regular.ttf`]: notFont });
    expect(await market.installMarketFont(m.fonts[0], BASE, { fetchImpl })).toBe(0);
    expect(store.app.errors.at(-1).msg).toMatch(/not a font file/);
    // A real font, but not the bytes the checksum names.
    const other = readFileSync(new URL('../test/fonts/ComicNeue-Regular.ttf', import.meta.url));
    const m2 = market.parseManifest(manifest([font({ files: [{ url: 'files/x.ttf', slot: 'regular', sha256: sha(bangers) }] })]), `${BASE}index.json`);
    fetchImpl = serve({ [`${BASE}files/x.ttf`]: other });
    expect(await market.installMarketFont(m2.fonts[0], BASE, { fetchImpl })).toBe(0);
    expect(store.app.errors.at(-1).msg).toMatch(/checksum/);
    expect(store.app.fonts.user.some((f) => f.name === 'Bangers Test')).toBe(false);
  });

  it('reads a manifest from its address', async () => {
    const body = new TextEncoder().encode(JSON.stringify(manifest([font()])));
    const m = await market.loadManifest(`${BASE}index.json`, { fetchImpl: serve({ [`${BASE}index.json`]: body }) });
    expect(m.fonts.map((f) => f.family)).toEqual(['Bangers Test']);
    await expect(market.loadManifest('http://fonts.example.com/index.json')).rejects.toThrow(/https/);
  });
});
