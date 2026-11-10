// ===== Pattern from page: the one-shot pick =====
//
// "Pick from page" in the Inspector's pattern section starts it; the next drag
// on the page draws a rectangle (Canvas.svelte lays a layer over the page for
// it), and the region under it becomes the box's pattern:
//
//   1. the crop is read off the page's own picture - the cleaned page, or the
//      raw one when `raw` is set, since cleaning often takes the tone away;
//   2. the engine finds its repeat and makes one seamless cell of it
//      (`extractTile`, text-engine/js/pattern.mjs);
//   3. the cell is written to <chapter>/patterns/ under its content hash
//      (`savePickedTile`);
//   4. the box's pattern becomes that tile, one style step in the history.
//
// It is not a rail tool: it ends after one drag, and Escape ends it early
// (App.svelte, ahead of its other uses of the key). The drag itself is the
// page's one-shot rectangle (page-rect-pick.svelte.js); this is one caller.
import { pageById, cloneStyle, boxEdited, toast } from './store.svelte.js';
import { record } from './editor/history.svelte.js';
import { chapterOpenSeq } from './library.svelte.js';
import { pageRasterSrc } from './page-pixels.js';
import { glyphPainter } from './text-engine/index.js';
import { extractsTiles, extractTile } from '../../text-engine/js/pattern.mjs';
import { savePickedTile } from './pattern-tiles.svelte.js';
import { pageRectPick } from './page-rect-pick.svelte.js';

// The largest crop handed to the engine, a side. A bigger rectangle gives its
// centre: a tone is the same all over, and the engine's limit is this.
export const PICK_MAX_SIDE = 1024;
// Smaller than this, a side, is a click, not a region.
const PICK_MIN_SIDE = 8;

export const patternPick = $state({
  active: false,
  pageId: null,
  boxId: null,
  // Which of the box's patterns the tile goes to, a path into its style:
  // 'pattern' (the fill's), 'patternOverlay.pattern', 'bevel.texture.pattern'
  // or 'strokeEffects.<i>.pattern' (`stylePatterns` in data.js).
  target: 'pattern',
  // Read the raw page instead of the cleaned one.
  raw: false,
  busy: false,
});

/** Whether a pick can run at all: the Rust engine paints, and can extract. */
export function canPickPattern() {
  const p = glyphPainter();
  return p?.screen === true && extractsTiles(p.engine?.low);
}

export function startPatternPick(pageId, boxId, target = 'pattern') {
  if (patternPick.busy) return;
  // Before `active` is raised: a pick already waiting is told it was replaced,
  // and when that pick is this one its cancel must not lower the new flag.
  pageRectPick.start({
    hint: 'Drag over the tone to take it · Esc to cancel',
    onDone: (r, pg) => void finishPatternPick(pg.id, { x0: r[0], y0: r[1], x1: r[2], y1: r[3] }),
    onCancel: (why) => {
      patternPick.active = false;
      if (why === 'small') toast('Drag a larger region to take a pattern from', 'warn');
    },
  });
  patternPick.active = true;
  patternPick.pageId = pageId;
  patternPick.boxId = boxId;
  patternPick.target = PICK_TARGET.test(target) ? target : 'pattern';
}

// The pattern paths a pick may write to.
const PICK_TARGET = /^(pattern|patternOverlay\.pattern|bevel\.texture\.pattern|strokeEffects\.\d+\.pattern)$/;

/** The pattern at `target` in `style` (see `patternPick.target`), or null. */
export function patternAtPath(style, target) {
  if (!PICK_TARGET.test(target ?? '')) return null;
  const p = target.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), style);
  return p && typeof p === 'object' ? p : null;
}

export function cancelPatternPick() {
  if (patternPick.active) pageRectPick.cancel();
  patternPick.active = false;
}

// `rect` in page px, cut to the page and to the engine's limit.
function cropRect(rect, w, h) {
  let x0 = Math.max(0, Math.floor(Math.min(rect.x0, rect.x1)));
  let y0 = Math.max(0, Math.floor(Math.min(rect.y0, rect.y1)));
  let x1 = Math.min(w, Math.ceil(Math.max(rect.x0, rect.x1)));
  let y1 = Math.min(h, Math.ceil(Math.max(rect.y0, rect.y1)));
  const cut = (a, b) => {
    const over = b - a - PICK_MAX_SIDE;
    return over > 0 ? [a + Math.floor(over / 2), a + Math.floor(over / 2) + PICK_MAX_SIDE] : [a, b];
  };
  [x0, x1] = cut(x0, x1);
  [y0, y1] = cut(y0, y1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// The page's picture, decoded by the browser.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Without it the canvas below is tainted and refuses to be read
    // (asset-protocol pages; see page-pixels.js).
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read the page'));
    img.src = src;
  });
}

// The crop's straight RGBA, through a canvas the size of the crop only.
async function readCrop(src, r) {
  const img = await loadImage(src);
  const cnv = document.createElement('canvas');
  cnv.width = r.w;
  cnv.height = r.h;
  const ctx = cnv.getContext('2d');
  ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  const data = ctx.getImageData(0, 0, r.w, r.h);
  cnv.width = 0;
  cnv.height = 0;
  return { width: data.width, height: data.height, data: data.data };
}

/**
 * The drag has ended over page `pageId`, from (x0, y0) to (x1, y1) page px.
 * Resolves once the box has its pattern, or the pick has said why not.
 */
export async function finishPatternPick(pageId, rect) {
  const boxId = patternPick.boxId;
  const target = patternPick.target;
  const raw = patternPick.raw;
  patternPick.active = false;
  const pg = pageById(pageId);
  if (!pg || pageId !== patternPick.pageId) {
    toast('Pick a region on the page the box is on', 'warn');
    return;
  }
  const r = cropRect(rect, pg.w || Infinity, pg.h || Infinity);
  if (r.w < PICK_MIN_SIDE || r.h < PICK_MIN_SIDE) {
    toast('Drag a larger region to take a pattern from', 'warn');
    return;
  }
  const src = raw ? pg.raw : pageRasterSrc(pg);
  if (!src || !canPickPattern()) return;
  const seq = chapterOpenSeq();
  patternPick.busy = true;
  try {
    const crop = await readCrop(src, r);
    const engine = glyphPainter().engine.low;
    const found = extractTile(engine, crop);
    const name = await savePickedTile(found.tile);
    // The chapter changed under the pick: its box is not this one any more.
    if (seq !== chapterOpenSeq()) return;
    const box = pageById(pageId)?.boxes.find((b) => b.id === boxId);
    if (!box) return;
    const p = patternAtPath(box.style, target);
    // The effect it was for was removed while the tile was read.
    if (!p) return;
    const before = cloneStyle(box.style);
    // The tone at the page's own size and lie: the geometry controls start
    // over, the colours and opacities stay the box's.
    Object.assign(p, {
      on: true,
      kind: 'picked',
      src: name,
      cell: found.cell.map((v) => Math.round(v * 1e4) / 1e4),
      mode: p.kind === 'picked' ? p.mode : 'tone',
      scale: 1,
      angle: 0,
      aspect: 1,
      density: 0.5,
      ox: 0,
      oy: 0,
    });
    boxEdited(box, pg);
    record({ t: 'style', pageId, boxId, before, after: cloneStyle(box.style) });
    toast(
      found.periodic
        ? `Tone found: ${found.period.toFixed(1)} px repeat at ${Math.round(found.angle)}°`
        : 'No repeat found, using it as a texture',
    );
  } catch (e) {
    if (seq === chapterOpenSeq()) toast(`Could not take a pattern: ${e?.message ?? e}`, 'error');
  } finally {
    patternPick.busy = false;
  }
}
