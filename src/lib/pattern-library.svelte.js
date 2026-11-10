// ===== Loaded patterns: the person's own, from .pat files =====
//
// A `.pat` (Photoshop's pattern set, or GIMP's one pattern, `pat-file.js`)
// is loaded once and kept app-wide, as brushes are: every chapter opened
// afterwards offers its patterns beside the built-in ones.
//
// On disk, under `<appDataDir>/pattern-library/`:
//
//   library.json            the index: `{ version, items: [{ src, name, set, w, h }] }`
//   patterns/<hash>.png     one tile per pattern, straight RGBA, colour kept
//
// A tile is named by its content hash, as a tile picked from the page is
// (`savePickedTile`), so a pattern chosen for a box is the same file copied
// into the chapter's own patterns/ folder (`copyPickedTiles`): the chapter
// then paints, saves and exports it as any picked tile, and does not need the
// library to be there. `w` and `h` are the pattern's own size, page px at
// 100 %; a tile wider than `TILE_SIDE` is stored smaller and drawn at that
// size, so the pattern keeps its size on the page.
//
// Nothing here throws at the panel except the import and the use, which say
// why. With no Tauri host (the browser preview) the library lives in memory.
import { fsx } from './fsx.js';
import { readPatFile } from './pat-file.js';
import { copyPickedTiles, decodePng, savePickedTile } from './pattern-tiles.svelte.js';
import { PATTERN_SRC } from './data.js';

const DIR_NAME = 'pattern-library';
const INDEX_NAME = 'library.json';
const INDEX_VERSION = 1;
// The longest side a stored tile keeps.
export const TILE_SIDE = 1024;
// The card: as the Inspector's pattern swatches.
const CARD_W = 44;
const CARD_H = 30;

/** The loaded patterns, oldest first. Each `{ src, name, set, w, h, card }`. */
export const loadedPatterns = $state([]);
export const patternLibrary = $state({ loaded: false, busy: false });

const inTauri = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

let rootCache = null;
/** `<appDataDir>/pattern-library`, or null with no host. */
export async function libraryRoot() {
  if (rootCache) return rootCache;
  const base = inTauri() ? await fsx.appDataDir() : null;
  if (!base) return null;
  rootCache = await fsx.join(base, DIR_NAME);
  return rootCache;
}

const clean = (it) =>
  it && typeof it === 'object' && PATTERN_SRC.test(it.src) && it.w > 0 && it.h > 0
    ? { src: it.src, name: String(it.name ?? '').slice(0, 200), set: String(it.set ?? '').slice(0, 200), w: +it.w, h: +it.h }
    : null;

// A swatch of the tile, repeated at a size that shows its look.
function cardOf(tile) {
  if (typeof document === 'undefined') return '';
  const src = document.createElement('canvas');
  src.width = tile.width;
  src.height = tile.height;
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(tile.data), tile.width, tile.height), 0, 0);
  const cnv = document.createElement('canvas');
  cnv.width = CARD_W * 2;
  cnv.height = CARD_H * 2;
  const ctx = cnv.getContext('2d');
  const k = Math.min(1, (CARD_H * 2) / Math.min(tile.width, tile.height));
  const pat = ctx.createPattern(src, 'repeat');
  pat.setTransform(new DOMMatrix().scale(k));
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, cnv.width, cnv.height);
  const url = cnv.toDataURL();
  src.width = src.height = cnv.width = cnv.height = 0;
  return url;
}

// A pattern no wider than TILE_SIDE a side.
function fitted(p) {
  const k = Math.min(1, TILE_SIDE / Math.max(p.width, p.height));
  if (k === 1 || typeof document === 'undefined') return { width: p.width, height: p.height, data: p.data };
  const src = document.createElement('canvas');
  src.width = p.width;
  src.height = p.height;
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
  const cnv = document.createElement('canvas');
  cnv.width = Math.max(1, Math.round(p.width * k));
  cnv.height = Math.max(1, Math.round(p.height * k));
  const ctx = cnv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, cnv.width, cnv.height);
  const img = ctx.getImageData(0, 0, cnv.width, cnv.height);
  src.width = src.height = cnv.width = cnv.height = 0;
  return { width: img.width, height: img.height, data: img.data };
}

async function saveIndex() {
  const root = await libraryRoot();
  if (!root) return;
  await fsx.mkdir(root);
  const items = loadedPatterns.map(({ src, name, set, w, h }) => ({ src, name, set, w, h }));
  await fsx.writeTextFileAtomic(await fsx.join(root, INDEX_NAME), JSON.stringify({ version: INDEX_VERSION, items }));
}

/** Reads the library once; later calls are no-ops. */
export async function loadPatternLibrary() {
  if (patternLibrary.loaded || patternLibrary.busy) return;
  patternLibrary.busy = true;
  try {
    const root = await libraryRoot();
    if (!root) return;
    const path = await fsx.join(root, INDEX_NAME);
    if (!(await fsx.exists(path))) return;
    const idx = JSON.parse(await fsx.readTextFile(path));
    if (idx?.version > INDEX_VERSION) return;
    const items = (Array.isArray(idx?.items) ? idx.items : []).map(clean).filter(Boolean);
    for (const it of items) {
      if (loadedPatterns.some((x) => x.src === it.src)) continue;
      let card = '';
      try {
        card = cardOf(await decodePng(await fsx.readFile(await fsx.join(root, 'patterns', it.src))));
      } catch {
        continue; // a tile gone from the folder: the entry goes too
      }
      loadedPatterns.push({ ...it, card });
    }
  } catch {
    // An unreadable index is an empty library; the next import writes a new one.
  } finally {
    patternLibrary.loaded = true;
    patternLibrary.busy = false;
  }
}

/**
 * Loads the patterns in `files` (`{ name, bytes }`) into the library.
 * Resolves to `{ added, same, skipped }` counts; throws when no file was a
 * pattern file.
 */
export async function importPatterns(files) {
  await loadPatternLibrary();
  const root = await libraryRoot();
  let added = 0;
  let same = 0;
  let skipped = 0;
  let bad = 0;
  let why = '';
  for (const f of files) {
    let read;
    try {
      read = readPatFile(f.bytes);
    } catch (e) {
      bad++;
      why = `${f.name}: ${e?.message ?? e}`;
      continue;
    }
    skipped += read.skipped.length;
    const set = f.name.replace(/\.pat$/i, '');
    for (const [i, p] of read.patterns.entries()) {
      const tile = fitted(p);
      const src = await savePickedTile(tile, root);
      if (loadedPatterns.some((x) => x.src === src)) {
        same++;
        continue;
      }
      loadedPatterns.push({ src, name: p.name || `${set} ${i + 1}`, set, w: p.width, h: p.height, card: cardOf(tile) });
      added++;
    }
  }
  if (bad === files.length) throw new Error(why || 'no pattern file');
  await saveIndex();
  return { added, same, skipped: skipped + bad };
}

/** Takes the set `set` (one .pat's patterns) out of the library. */
export async function removePatternSet(set) {
  const gone = loadedPatterns.filter((x) => x.set === set);
  for (let i = loadedPatterns.length - 1; i >= 0; i--) if (loadedPatterns[i].set === set) loadedPatterns.splice(i, 1);
  await saveIndex();
  // The tiles too, unless another set has the same picture. A chapter that
  // used one keeps its own copy.
  const root = await libraryRoot();
  if (!root) return;
  for (const it of gone) {
    if (loadedPatterns.some((x) => x.src === it.src)) continue;
    try {
      await fsx.remove(await fsx.join(root, 'patterns', it.src));
    } catch {
      // already gone
    }
  }
}

/**
 * Makes a loaded pattern the chapter's own (its tile copied into the open
 * chapter's patterns/ folder) and resolves to the pattern fields that paint
 * it. Throws when the copy fails.
 */
export async function useLoadedPattern(it) {
  const root = await libraryRoot();
  if (root) {
    const lost = await copyPickedTiles([it.src], root);
    if (lost.length) throw new Error('the pattern file could not be copied into the chapter');
  }
  return { kind: 'picked', src: it.src, cell: [it.w, 0, 0, it.h], mode: 'image', scale: 1, angle: 0, aspect: 1, density: 0.5, ox: 0, oy: 0, fgOpacity: 1 };
}
