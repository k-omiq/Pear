// ===== Font marketplaces =====
// A marketplace is a JSON manifest at an address the user adds; we host ours,
// anyone can host one. The format is FONT_MARKETPLACE.md, and
// `parseManifest` is its one reader: everything a manifest says is checked
// here, and a font that fails a check is listed with the reason, never
// half-installed.
//
// Nothing is fetched unless the user asks: adding a marketplace, pressing
// Refresh, pressing Install. In the desktop app the bytes come through Rust
// (`font_fetch`, font_library.rs), which only speaks https and caps the size;
// in a browser through `fetch`, which needs the host to allow it (CORS).
import { isTauri } from './importer.js';
import { fontKind } from './font-names.js';
import { addFontData, FACE_SLOTS, SLOT_LABEL } from './fonts.js';
import { app, toast, toastError } from './store.svelte.js';

export const MANIFEST_FORMAT = 'pear-font-market';
export const MANIFEST_VERSION = 1;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_FONT_BYTES = 64 * 1024 * 1024;
const MAX_FONTS = 5000;
const MAX_TAGS = 16;

// https, or http to this machine (a marketplace being written locally).
export function allowedUrl(raw, base = undefined) {
  // Nothing is no address, not the base's own.
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  let u;
  try {
    u = new URL(s, base);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === 'https:') return u.href;
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return u.href;
  return null;
}

const STYLE_SLOT = {
  regular: 'regular',
  normal: 'regular',
  bold: 'bold',
  italic: 'italic',
  oblique: 'italic',
  'bold italic': 'boldItalic',
  'bold-italic': 'boldItalic',
  bolditalic: 'boldItalic',
  'bold oblique': 'boldItalic',
};
function slotOf(file) {
  if (FACE_SLOTS.includes(file?.slot)) return file.slot;
  const s = String(file?.style ?? file?.slot ?? '').trim().toLowerCase();
  return STYLE_SLOT[s] ?? null;
}

const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// A manifest's text, checked. Returns { name, version, description, homepage,
// fonts, skipped } or throws with words for the user. `url` is where it came
// from: relative file and preview addresses are read against it.
export function parseManifest(raw, url) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('this address did not answer with a font list (not JSON)');
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('this font list is not a JSON object');
  if (data.format !== undefined && data.format !== MANIFEST_FORMAT) throw new Error(`this is not a Pear font list (format "${text(data.format, 40)}")`);
  const version = Number(data.version ?? 1);
  if (!Number.isInteger(version) || version < 1) throw new Error('this font list has no readable version');
  if (version > MANIFEST_VERSION) throw new Error(`this font list is version ${version}; this build reads up to ${MANIFEST_VERSION}`);
  if (!Array.isArray(data.fonts)) throw new Error('this font list has no "fonts" array');

  const fonts = [];
  const skipped = [];
  const ids = new Set();
  for (const f of data.fonts.slice(0, MAX_FONTS)) {
    const id = text(f?.id, 120);
    const family = text(f?.family, 120);
    const why = (reason) => skipped.push({ id: id || family || '(unnamed)', reason });
    if (!id) {
      why('no id');
      continue;
    }
    if (ids.has(id)) {
      why('id used twice');
      continue;
    }
    if (!family) {
      why('no family name');
      continue;
    }
    const licenseName = text(f.license?.name ?? (typeof f.license === 'string' ? f.license : ''), 120);
    if (!licenseName) {
      why('no licence');
      continue;
    }
    const files = [];
    let bad = '';
    for (const file of Array.isArray(f.files) ? f.files : []) {
      const fileUrl = allowedUrl(file?.url, url);
      const slot = slotOf(file);
      if (!fileUrl) bad = 'a file address that is not https';
      else if (!slot) bad = `a file whose style is not one of ${Object.values(SLOT_LABEL).join(', ')}`;
      else if (files.some((x) => x.slot === slot)) bad = `two files for ${SLOT_LABEL[slot]}`;
      if (bad) break;
      const sha = typeof file.sha256 === 'string' ? file.sha256.trim().toLowerCase() : '';
      if (sha && !/^[0-9a-f]{64}$/.test(sha)) {
        bad = 'a sha256 that is not 64 hex digits';
        break;
      }
      const size = Number.isFinite(+file.size) && +file.size > 0 ? Math.round(+file.size) : null;
      if (size && size > MAX_FONT_BYTES) {
        bad = 'a file larger than 64 MB';
        break;
      }
      files.push({ url: fileUrl, slot, sha256: sha || null, size });
    }
    if (bad) {
      why(`has ${bad}`);
      continue;
    }
    if (!files.length) {
      why('no files');
      continue;
    }
    ids.add(id);
    fonts.push({
      id,
      family,
      designer: text(f.designer, 120),
      description: text(f.description, 600),
      license: { name: licenseName, url: allowedUrl(f.license?.url, url) },
      preview: allowedUrl(f.preview, url),
      tags: (Array.isArray(f.tags) ? f.tags : [])
        .map((t) => text(t, 40).toLowerCase())
        .filter(Boolean)
        .slice(0, MAX_TAGS),
      files,
    });
  }
  return {
    name: text(data.name, 120) || new URL(url).hostname,
    version,
    description: text(data.description, 600),
    homepage: allowedUrl(data.homepage, url),
    updated: text(data.updated, 40),
    fonts,
    skipped,
  };
}

// ---- reading what a marketplace lists ----
export function filterFonts(fonts, { query = '', tag = '' } = {}) {
  const q = query.trim().toLowerCase();
  return fonts.filter(
    (f) =>
      (!tag || f.tags.includes(tag)) &&
      (!q || f.family.toLowerCase().includes(q) || f.designer.toLowerCase().includes(q) || f.tags.some((t) => t.includes(q))),
  );
}
export function tagsOf(fonts) {
  const count = new Map();
  for (const f of fonts) for (const t of f.tags) count.set(t, (count.get(t) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

// 'installed' when the library has every face the marketplace lists for the
// family, 'partial' when it has some, null when none.
export function installState(font, userFonts = app.fonts.user) {
  const g = userFonts.find((f) => f.name === font.family);
  if (!g) return null;
  const have = font.files.filter((x) => g.faces?.[x.slot]).length;
  return have === font.files.length ? 'installed' : have ? 'partial' : null;
}

// ---- fetching ----
let invoker = null;
async function invoke(cmd, args) {
  invoker ??= import('@tauri-apps/api/core').then((m) => m.invoke);
  return (await invoker)(cmd, args);
}

// The bytes at `url`, no more than `max`. Rust in the desktop app, fetch in a
// browser. `fetchImpl` is for the tests.
export async function fetchBytes(url, max, { fetchImpl = null } = {}) {
  const ok = allowedUrl(url);
  if (!ok) throw new Error('only https addresses can be used');
  if (!fetchImpl && isTauri()) {
    const out = await invoke('font_fetch', { url: ok, max });
    return out instanceof ArrayBuffer ? out : new Uint8Array(out).buffer;
  }
  const res = await (fetchImpl || fetch)(ok, { credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > max) throw new Error('the file is larger than allowed');
  return buf;
}

export async function loadManifest(url, opts = {}) {
  const ok = allowedUrl(url);
  if (!ok) throw new Error('only https addresses can be used');
  const buf = await fetchBytes(ok, MAX_MANIFEST_BYTES, opts);
  return parseManifest(new TextDecoder('utf-8').decode(buf), ok);
}

async function sha256Hex(buf) {
  const c = globalThis.crypto?.subtle;
  if (!c) return null;
  const d = new Uint8Array(await c.digest('SHA-256', buf));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// One downloaded file, checked before anything keeps it: a font by its
// first bytes, the size and the hash the manifest gave. The browser loading
// it (`addFontData`) is the last check.
export async function checkFontBytes(buf, file) {
  if (!fontKind(buf)) throw new Error('the download is not a font file');
  if (file.size && buf.byteLength !== file.size) throw new Error(`the download is ${buf.byteLength} bytes, the list says ${file.size}`);
  if (file.sha256) {
    const got = await sha256Hex(buf);
    if (got && got !== file.sha256) throw new Error('the download does not match the list’s checksum');
  }
  return true;
}

const fileName = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'font';
  } catch {
    return 'font';
  }
};

// Every file of `font`, downloaded, checked and added to the library through
// the same path as a dropped file. Faces already in the library are not
// downloaded again. Returns how many faces went in.
export async function installMarketFont(font, marketUrl, { fetchImpl = null, onProgress = null } = {}) {
  const g = app.fonts.user.find((f) => f.name === font.family);
  const todo = font.files.filter((x) => !g?.faces?.[x.slot]);
  if (app.fonts.builtin.some((f) => f.name === font.family)) {
    toast(`"${font.family}" is a built-in font`);
    return 0;
  }
  let added = 0;
  let i = 0;
  for (const file of todo) {
    onProgress?.(i++, todo.length);
    try {
      const buf = await fetchBytes(file.url, MAX_FONT_BYTES, { fetchImpl });
      await checkFontBytes(buf, file);
      const r = await addFontData({ family: font.family, slot: file.slot, file: fileName(file.url), data: buf, source: { market: marketUrl, id: font.id }, quiet: true });
      if (r) added++;
    } catch (e) {
      toastError(`Could not install ${font.family} ${SLOT_LABEL[file.slot]} - ${e?.message || e}`);
      return added;
    }
  }
  onProgress?.(todo.length, todo.length);
  if (added) toast(added === 1 ? `Installed "${font.family}"` : `Installed "${font.family}" - ${added} faces`);
  return added;
}

// ---- the lists, kept between launches ----
// What each marketplace listed the last time it was fetched, so the library
// shows it without asking the network again. Per machine, beside the prefs.
const CACHE_KEY = 'mt.fontMarkets';
export function readMarketCache() {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    // Only entries with a list in them: a damaged one must not break the
    // library's render.
    const out = {};
    for (const [url, e] of Object.entries(v)) if (Array.isArray(e?.manifest?.fonts)) out[url] = e;
    return out;
  } catch {
    return {};
  }
}
export function writeMarketCache(cache) {
  try {
    const s = JSON.stringify(cache);
    // A cache too big to keep is not kept, and the old one goes too, so a
    // removed marketplace's list does not stay behind; the lists are fetched
    // again instead.
    if (s.length < 2_000_000) localStorage.setItem(CACHE_KEY, s);
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    /* no room: same answer */
  }
}
