// ===== Pictures of SFX lettering for the Inspector's SFX panel =====
//
// Three pictures, all painted by the same painter that draws the box on the
// page and in the export (`pictureTexture`, then `warpTexture`), so a preview
// is the engine's own picture and not a second drawing of it:
//
//   the stage      the selected box's own text and style, as it paints now
//   a type card    the box's text in the box's own look, laid out as one of
//                  the engine's sound types (`applySfxKind`: the type's
//                  layout, every number and dial back to the type's, no hand
//                  edits and no drawn paths), with the box's seed
//   a variation    the box's sound as it is, with another seed: what a click
//                  on it leaves the box (its paths and hand edits stay)
//
// The cards show the first eight code points of the text. All are cut to the
// ink they hold (a sound effect spreads well past its frame) and scaled to
// fit. Where the ink is comes from the painter, which cuts its raster to it
// (`renderBoxTexture`'s `ink`): no picture is read back pixel by pixel.
//
// The cards are small PNG data URLs kept in a bounded cache, so painting one
// is a thing that happens once per (text, look, type, seed) and never again.
import { defaultStyle, normalizeStyle } from './data.js';
import { applySfxKind } from './sfx.js';
import { pictureTexture } from './editor/box-picture.js';
import { boxFootprint, warpTexture } from './exporter.js';

// A card's tile, in CSS px. The panel shows it with `background-size: contain`,
// so a card a little wider or narrower than this only gets more or less margin.
export const CARD_W = 92;
export const CARD_H = 62;
const CARD_PAD = 4;
// The size the card's text is set at. Paths, gaps and effects are in ems and
// the outlines are scaled with the size, so any size gives the same picture.
const CARD_SIZE = 30;
// Texture px per tile px: the footprint holds a margin round the letters, so
// the ink is painted a little finer than it is shown and scaled down.
const CARD_OVER = 1.5;
const CARD_MAX_PX = 480 * 240;
// A card with one wide letter is enlarged to fill its tile, but by no more than
// this (tile px per texture px), so a small texture is not blown up into mush.
const CARD_ENLARGE = 2;
const CARD_WORD = 'SFX';
const CARD_LETTERS = 8;

// The stage is painted at the scale it is shown at: its own canvas's pixels,
// fitted to the letters, never more than three device px per page px (one
// short word in a large frame is not a billboard), and never more than this
// many pixels of footprint.
const STAGE_PAD = 10;
const STAGE_ENLARGE = 3;
const STAGE_MIN_PX = 256 * 1024;
const STAGE_MAX_PX = 2.5 * 1024 * 1024;
// A stage whose ink came out this much smaller than the stage's room (the
// first paint of a box, fitted to its footprint) is painted once more at the
// scale its ink asks for, rather than enlarged soft.
const STAGE_REPAINT = 1.25;

// The dials' centre: the type as designed.
const DIAL_MID = 50;

const CACHE_MAX = 600;
const CACHE_DROP = 200;
const cache = new Map();

export const cachedCard = (key) => cache.get(key);
export function keepCard(key, url) {
  cache.set(key, url);
  if (cache.size > CACHE_MAX) {
    let n = CACHE_DROP;
    for (const k of cache.keys()) {
      if (n-- <= 0) break;
      cache.delete(k);
    }
  }
}
export const cardCacheSize = () => cache.size;
export const clearCardCache = () => cache.clear();

/** Device pixels per CSS px, as a painter should take it: 1 to 2. */
export function previewDpr() {
  const d = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  return d > 0 ? Math.min(2, d) : 1;
}

/**
 * The text a card shows: the box's first eight code points, line breaks kept,
 * and the word "SFX" when there is nothing to show.
 */
export function cardText(text) {
  const cut = [...String(text ?? '')].slice(0, CARD_LETTERS).join('').replace(/\s+$/, '');
  return cut.trim() === '' ? CARD_WORD : cut;
}

// A plain copy of a value that may be a Svelte state proxy.
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

// The fields of `style.sfx` a variation is painted from: the recipe less the
// seed (the card's own), the caption and what Remove SFX puts back. Picking a
// variation changes only the seed, so the drawn paths and hand edits are in
// it. While a letter or path is dragged the panel reads none of this
// (`sfxLive`); the variations repaint once when the drag ends.
const SFX_LAYOUT = ['kind', 'power', 'rough', 'momentum', 'dir', 'joinBars', 'kern', 'flow', 'follow', 'gap', 'bigTighter', 'slant', 'rise', 'jitter', 'paths', 'glyphs'];

/**
 * Everything a card's picture depends on, as plain data: it is in the cache
 * key, and the painter reads nothing else of the box. The box's look (font,
 * fill, outlines, shadows, the SFX effects) and its SFX layout, less what a
 * card does not draw: the page's (ink, mask, mesh, turn and flip), the
 * caption, the frame and the seed (the card's own). Outline and shadow sizes
 * are kept as shares of the size, so
 * a box made bigger is the same card.
 */
export function cardSpec(style, text) {
  const size = style.size > 0 ? style.size : CARD_SIZE;
  const rel = (v) => Math.round(((Number(v) || 0) / size) * 1e4) / 1e4;
  const sx = style.sfx;
  let sfx = null;
  if (sx) {
    sfx = {};
    for (const k of SFX_LAYOUT) sfx[k] = plain(sx[k]);
  }
  return {
    text: cardText(text),
    font: style.font,
    bold: !!style.bold,
    italic: !!style.italic,
    uppercase: !!style.uppercase,
    color: style.color,
    noFill: !!style.noFill,
    gradient: plain(style.gradient),
    pattern: plain(style.pattern),
    strokeEffects: (style.strokeEffects ?? []).map((k) => ({ ...plain(k), size: rel(k.size) })),
    shadows: (style.shadows ?? []).map((k) => ({ ...plain(k), x: rel(k.x), y: rel(k.y), size: rel(k.size) })),
    strokeOrder: style.strokeOrder,
    strokeJoin: style.strokeJoin,
    strokeShade: style.strokeShade,
    negative: plain(style.negative),
    extrude: plain(style.extrude),
    shake: plain(style.shake),
    trail: plain(style.trail),
    sfx,
  };
}

// What of the box's SFX a type card keeps: nothing. A type sets every
// number and switch of the recipe (`applySfxKind`); the seed is the card's.
function typeSfx() {
  return {};
}

/**
 * The cache key of one card at one density: a type card (`kind` set) or a
 * variation (`kind` null). `seed` is the card's. A type card's key holds the
 * box's look and none of its layout; a variation's holds both.
 */
export function cardKey(spec, { kind = null, seed = 1 }, fonts, dpr) {
  const of = kind ? { ...spec, sfx: typeSfx() } : spec;
  return `${kind ? 't:' + kind : 'v'}|${seed}|${fonts}|${dpr}|${JSON.stringify(of)}`;
}

/** `cardKey` for every card in `cards`, the spec stated twice in all. */
export function cardKeys(spec, cards, fonts, dpr) {
  const asType = JSON.stringify({ ...spec, sfx: typeSfx() });
  const asVariation = JSON.stringify(spec);
  return cards.map(({ kind = null, seed = 1 }) => `${kind ? 't:' + kind : 'v'}|${seed}|${fonts}|${dpr}|${kind ? asType : asVariation}`);
}

// The page-less box a preview is painted from. Nothing here is the user's
// box: its id is its own, its ink and mask are off, and its text is stated.
function previewBox(style, text, w, h, id) {
  return { id, lineN: null, text, x: 0, y: 0, w, h, fit: null, style };
}

// The style a card paints: the spec at the card's size, SFX on with the
// card's seed, and for a type card the type laid over the box's look.
export function cardStyle(spec, { kind = null, seed = 1 } = {}) {
  const abs = (v) => v * CARD_SIZE;
  const style = normalizeStyle({
    ...defaultStyle(),
    font: spec.font,
    bold: spec.bold,
    italic: spec.italic,
    uppercase: spec.uppercase,
    color: spec.color,
    noFill: spec.noFill,
    gradient: spec.gradient,
    pattern: spec.pattern,
    strokeEffects: spec.strokeEffects.map((k) => ({ ...k, size: abs(k.size) })),
    shadows: spec.shadows.map((k) => ({ ...k, x: abs(k.x), y: abs(k.y), size: abs(k.size) })),
    strokeOrder: spec.strokeOrder,
    strokeJoin: spec.strokeJoin,
    strokeShade: spec.strokeShade,
    negative: spec.negative,
    extrude: spec.extrude,
    shake: spec.shake,
    trail: spec.trail,
    sfx: { ...(kind ? typeSfx() : (spec.sfx ?? {})), on: true },
    size: CARD_SIZE,
    align: 'center',
    valign: 'middle',
    autoHeight: false,
    balloon: false,
  });
  if (kind) {
    applySfxKind(style, kind);
    // A type card is the type as a click on it leaves the box: no drawn
    // paths, no hand edits, the dials at the type's own.
    style.sfx.paths = [];
    style.sfx.glyphs = {};
    for (const d of ['power', 'rough', 'momentum']) if (d in style.sfx) style.sfx[d] = DIAL_MID;
  }
  style.sfx.seed = seed;
  return style;
}

// Where the ink is in the texture the preview draws from, or null for "the
// whole canvas": a texture warp resampled the picture (the painter's `ink`
// no longer says where it is), or the painter did not say.
function inkOf(raw, tex) {
  return tex.canvas === raw.canvas ? (raw.ink ?? null) : null;
}

// The picture, cut to its ink (`r`, canvas px; the whole canvas when null),
// drawn contained and centred in a W x H canvas with `pad` px of margin. `cap`
// is the most it will be enlarged. Drawn pixel for pixel where it lands at its
// own size. Returns the scale it was drawn at, or 0 when nothing was drawn.
function drawFit(ctx, canvas, r, W, H, pad, cap) {
  const src = r ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
  if (!(src.w > 0 && src.h > 0)) return 0;
  let k = Math.min((W - 2 * pad) / src.w, (H - 2 * pad) / src.h, cap);
  if (!(k > 0)) return 0;
  // Painted at the size it is shown: no resample, on whole pixels.
  const same = Math.abs(k - 1) < 0.01;
  if (same) k = 1;
  const dw = src.w * k;
  const dh = src.h * k;
  const dx = same ? Math.round((W - dw) / 2) : (W - dw) / 2;
  const dy = same ? Math.round((H - dh) / 2) : (H - dh) / 2;
  ctx.imageSmoothingEnabled = !same;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, src.x, src.y, src.w, src.h, dx, dy, dw, dh);
  return k;
}

// Device px per page px that fits `size` (page px) into `w` x `h` (device px).
const fitScale = (size, w, h) => (size.w > 0 && size.h > 0 ? Math.min(w / size.w, h / size.h) : 1);

function release(...texes) {
  for (const t of texes) {
    if (t?.canvas) {
      t.canvas.width = 0;
      t.canvas.height = 0;
    }
  }
}

/**
 * One card as a PNG data URL, or null when the engine could not paint it:
 * `{ kind }` a type card, `{ seed }` a variation (or both).
 */
export function paintCard(spec, card, dpr = 1) {
  let raw = null;
  let tex = null;
  try {
    const style = cardStyle(spec, card);
    // SFX is placed from the box's centre, so the frame is only a place for
    // the centre to be; the picture holds the ink wherever it reaches.
    const box = previewBox(style, spec.text, 4 * CARD_SIZE, 2 * CARD_SIZE, 'sfx-card');
    const W = Math.round(CARD_W * dpr);
    const H = Math.round(CARD_H * dpr);
    const pad = CARD_PAD * dpr;
    // Painted at about the size it is shown: the footprint fitted to the
    // tile, a little finer for the margin the footprint keeps round the ink.
    const f = boxFootprint(box);
    const scale = CARD_OVER * fitScale({ w: f.cw, h: f.ch }, W - 2 * pad, H - 2 * pad);
    raw = pictureTexture(box, undefined, undefined, scale, CARD_MAX_PX);
    tex = warpTexture(raw, box);
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    drawFit(out.getContext('2d'), tex.canvas, inkOf(raw, tex), W, H, pad, CARD_ENLARGE);
    const url = out.toDataURL('image/png');
    out.width = 0;
    out.height = 0;
    return url;
  } catch {
    return null;
  } finally {
    release(raw, tex);
  }
}

/**
 * The stage: the box's own text and style, painted into `canvas` (whose pixel
 * size the caller has set), cut to its ink and centred. `snap` is plain data:
 * `{ style, text, w, h }`, the style a snapshot of the box's.
 *
 * Painted at the scale the stage shows it: the canvas's pixels fitted to the
 * letters, and no larger. Where the letters are is known once they are
 * painted, so `hint` is what the last paint of this box said (`{ w, h }`, the
 * ink's size in page px); without one the box's footprint is fitted, and a
 * picture that came out well short of the stage is painted once more at the
 * scale its ink asks for. A hint a little out only means the ink is scaled a
 * little to fit.
 *
 * Returns null when nothing was painted, else the hint for the next paint.
 */
export function paintStage(canvas, snap, dpr = 1, hint = null) {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  try {
    const style = normalizeStyle(snap.style);
    // What belongs to the page and not to the lettering: hand-drawn ink, the
    // box's own geometry. (The mask is the box's and never in a style.)
    style.ink = { on: false, strokes: [] };
    const text = String(snap.text ?? '').trim() === '' ? CARD_WORD : snap.text;
    const box = previewBox(style, text, snap.w, snap.h, 'sfx-stage');
    const pad = STAGE_PAD * dpr;
    const roomW = W - 2 * pad;
    const roomH = H - 2 * pad;
    const most = STAGE_ENLARGE * dpr;
    const budget = Math.min(STAGE_MAX_PX, Math.max(STAGE_MIN_PX, 4 * W * H));
    let fit = hint?.w > 0 && hint?.h > 0 ? hint : null;
    if (!fit) {
      const f = boxFootprint(box);
      fit = { w: f.cw, h: f.ch };
    }
    for (let pass = 0; pass < 2; pass++) {
      const scale = Math.min(fitScale(fit, roomW, roomH), most);
      const raw = pictureTexture(box, undefined, undefined, scale, budget);
      const ss = raw.ss > 0 ? raw.ss : 1;
      const tex = warpTexture(raw, box);
      try {
        const ink = inkOf(raw, tex);
        if (ink && !(ink.w > 0 && ink.h > 0)) return null;
        const r = ink ?? { w: tex.canvas.width, h: tex.canvas.height };
        const next = { w: r.w / ss, h: r.h / ss };
        const k = Math.min(roomW / r.w, roomH / r.h, most / ss);
        // Short of the stage and not yet at the most it may be enlarged: once
        // more, at the scale the ink asks for.
        if (pass === 0 && ink && k > STAGE_REPAINT && ss < scale * 1.001) {
          fit = next;
          continue;
        }
        ctx.clearRect(0, 0, W, H);
        return drawFit(ctx, tex.canvas, ink, W, H, pad, most / ss) > 0 ? next : null;
      } finally {
        release(raw, tex);
      }
    }
    return null;
  } catch {
    return null;
  }
}
