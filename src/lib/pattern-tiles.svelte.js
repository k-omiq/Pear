// ===== Picked pattern tiles: the files and their decoded pixels =====
//
// A picked pattern (`style.pattern.kind === 'picked'`, see `defaultStyle`)
// names a PNG in the chapter's patterns/ folder by its content hash, and the
// lattice cell it repeats on. The file holds one cell, already seamless: the
// engine (`extractTile`, text-engine/js/pattern.mjs) made it so.
//
// The painter asks for a tile's pixels synchronously, in the middle of a
// paint, so they are read and decoded ahead and held here. A tile asked for
// before it is held is loaded in the background and `patternTiles.version`
// moves when it lands, which is in the editor picture's key: the box repaints
// with it. An export awaits `loadPickedTiles` first.
//
// The name is the content's hash, so one name is one picture in every chapter:
// the map is keyed by the name alone, and a pick made twice is stored once.
// Files are never removed here. A tile no box uses any more can still be named
// by an undo step or a preset, and it is a few kilobytes.
import { fsx } from './fsx.js';
import { PATTERN_SRC } from './data.js';

// The open chapter's folder and its open sequence, from library.svelte.js
// (`bindPatternTiles`). Not imported: the painter imports this module, and
// the library imports most of the app.
let openChapterDir = () => null;
let chapterOpenSeq = () => 0;
export function bindPatternTiles(deps) {
  openChapterDir = deps.dir;
  chapterOpenSeq = deps.seq;
}

export const PATTERNS_DIR = 'patterns';

export const patternTiles = $state({ version: 0 });

// name -> { width, height, data }
const tiles = new Map();
// name -> Promise, while it is being read
const loading = new Map();
// Names whose read failed in this chapter, so a missing file is not asked for
// on every paint. Cleared when another chapter opens (`forgetPickedTiles`).
const missing = new Set();
const MAX_TILES = 64;

const canDecode = () => typeof document !== 'undefined';
const inTauri = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

/** A held tile's pixels, or null; a tile not held yet starts loading. */
export function pickedTile(src) {
  if (!src) return null;
  const t = tiles.get(src);
  if (t) return t;
  if (!missing.has(src)) void loadPickedTile(src);
  return null;
}

function hold(src, tile) {
  if (tiles.size >= MAX_TILES) tiles.delete(tiles.keys().next().value);
  tiles.set(src, tile);
}

// PNG bytes to straight RGBA, through the browser's own decoder.
async function decodePng(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  try {
    const cnv = document.createElement('canvas');
    cnv.width = bitmap.width;
    cnv.height = bitmap.height;
    const ctx = cnv.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    cnv.width = 0;
    cnv.height = 0;
    return { width: img.width, height: img.height, data: img.data };
  } finally {
    bitmap.close?.();
  }
}

/** Reads and decodes one tile of the open chapter; resolves to it or null. */
export function loadPickedTile(src, dir = openChapterDir()) {
  if (!src || !PATTERN_SRC.test(src)) return Promise.resolve(null);
  if (tiles.has(src)) return Promise.resolve(tiles.get(src));
  if (loading.has(src)) return loading.get(src);
  if (!dir || !canDecode()) return Promise.resolve(null);
  const seq = chapterOpenSeq();
  const job = (async () => {
    try {
      const bytes = await fsx.readFile(await fsx.join(dir, PATTERNS_DIR, src));
      const tile = await decodePng(bytes);
      // A chapter swapped while this read: the name is still the same picture
      // (it is its hash), so it is kept; only the repaint is not owed.
      hold(src, tile);
      if (seq === chapterOpenSeq()) patternTiles.version++;
      return tile;
    } catch {
      missing.add(src);
      return null;
    } finally {
      loading.delete(src);
    }
  })();
  loading.set(src, job);
  return job;
}

/**
 * The picked tiles `boxes` paint with, all loaded: an export awaits this
 * before it paints, as it does the brush tips (`settleBoxTips`), because the
 * painter cannot await.
 */
export async function settlePickedTiles(boxes, dir = openChapterDir()) {
  const names = new Set();
  for (const b of boxes ?? []) {
    const pat = b?.style?.pattern;
    if (pat?.on && pat.kind === 'picked' && pat.src) names.add(pat.src);
  }
  await Promise.all([...names].map((n) => loadPickedTile(n, dir)));
}

/** Another chapter is opening: names that were missing may be there. */
export function forgetPickedTiles() {
  missing.clear();
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A tile as PNG bytes, through a canvas.
async function encodePng(tile) {
  const cnv = document.createElement('canvas');
  cnv.width = tile.width;
  cnv.height = tile.height;
  cnv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(tile.data), tile.width, tile.height), 0, 0);
  const blob = await new Promise((res, rej) => cnv.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the tile'))), 'image/png'));
  cnv.width = 0;
  cnv.height = 0;
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Writes `tile` into the open chapter's patterns/ folder under its content
 * hash and holds it; resolves to the file name. Throws when the write fails.
 * With no chapter folder at all (the plain-browser dev preview, which has no
 * file system) the tile is only held. The caller checks `chapterOpenSeq`
 * before it uses the name.
 */
export async function savePickedTile(tile, dir = openChapterDir()) {
  if (!dir && inTauri()) throw new Error('No chapter is open');
  const bytes = await encodePng(tile);
  const name = `${(await sha256Hex(bytes)).slice(0, 32)}.png`;
  if (dir) {
    const folder = await fsx.join(dir, PATTERNS_DIR);
    const path = await fsx.join(folder, name);
    if (!(await fsx.exists(path))) {
      await fsx.mkdir(folder);
      await fsx.writeFileAtomic(path, bytes);
    }
  }
  missing.delete(name);
  hold(name, { width: tile.width, height: tile.height, data: new Uint8ClampedArray(tile.data) });
  patternTiles.version++;
  return name;
}

/**
 * Copies the picked tiles `names` from another chapter's folder (`fromDir`)
 * into the open chapter's where it does not have them yet: a look copied
 * from that chapter (copy_look) names them. Resolves to the names that could
 * not be copied; a box naming one shows the default pattern, as a missing
 * file does.
 */
export async function copyPickedTiles(names, fromDir, dir = openChapterDir()) {
  const lost = [];
  for (const name of new Set(names)) {
    try {
      if (!PATTERN_SRC.test(name) || !fromDir || !dir) throw new Error('no folder');
      const folder = await fsx.join(dir, PATTERNS_DIR);
      const path = await fsx.join(folder, name);
      if (!(await fsx.exists(path))) {
        const bytes = await fsx.readFile(await fsx.join(fromDir, PATTERNS_DIR, name));
        await fsx.mkdir(folder);
        await fsx.writeFileAtomic(path, bytes);
      }
      missing.delete(name);
    } catch {
      lost.push(name);
    }
  }
  return lost;
}

// ---------- a picked tile in a preset ----------
//
// Presets are global and a chapter folder is not, so a preset whose pattern
// is a picked tile carries the tile's PNG with it, as a data URL
// (presets.svelte.js). Applied in a chapter that does not have the file, the
// file is written back under the same name.

const PNG_URL = 'data:image/png;base64,';
// Past this a tile is not carried: presets live in localStorage, which holds
// a few megabytes for everything. A big texture stays in its chapter.
export const MAX_TILE_URL = 1024 * 1024;

/** The tile's file as a data URL, or null when it cannot be read. */
export async function pickedTileUrl(src, dir = openChapterDir()) {
  if (!src || !PATTERN_SRC.test(src) || !dir) return null;
  try {
    const bytes = await fsx.readFile(await fsx.join(dir, PATTERNS_DIR, src));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const url = PNG_URL + btoa(bin);
    return url.length <= MAX_TILE_URL ? url : null;
  } catch {
    return null;
  }
}

/** Whether `url` is a tile a preset may carry. */
export const isTileUrl = (url) => typeof url === 'string' && url.startsWith(PNG_URL) && url.length <= MAX_TILE_URL;

/**
 * Writes a preset's tile into the open chapter when it is not there yet, and
 * loads it. Best effort: a tile that cannot be written leaves the box on the
 * default pattern, as a missing file does.
 */
export async function restorePickedTile(src, url, dir = openChapterDir()) {
  if (!src || !PATTERN_SRC.test(src) || !isTileUrl(url) || !dir) return;
  try {
    const folder = await fsx.join(dir, PATTERNS_DIR);
    const path = await fsx.join(folder, src);
    if (!(await fsx.exists(path))) {
      const bin = atob(url.slice(PNG_URL.length));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await fsx.mkdir(folder);
      await fsx.writeFileAtomic(path, bytes);
    }
    missing.delete(src);
    await loadPickedTile(src, dir);
  } catch {
    // see above
  }
}
