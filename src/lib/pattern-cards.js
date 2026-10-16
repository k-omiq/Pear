// ===== The pattern picker's cards, painted by the engine =====
//
// Under the Rust engine a pattern is shaded per pixel (`Fill::Screen`), and a
// card is one small rectangle of that fill: the same call, with the box's own
// colours, density, turn and stretch, so the card is what lands on the
// letters. Under the browser engine the Inspector draws the eleven canvas
// tiles as it always has, and nothing here runs.
import { glyphPainter } from './text-engine/index.js';
import { patternSwatch } from '../../text-engine/js/paint.mjs';
import { screenFill } from './exporter.js';
import { pickedTile } from './pattern-tiles.svelte.js';

// The size a card's tile is drawn at, as a font size: `patternTilePx` makes a
// tile a third of it, so cards are comparable with each other whatever the
// box's size; the Scale slider is under them.
export const CARD_FONT = 44;

const cache = new Map();
const CACHE_MAX = 200;

// What a card is painted from, so a card is painted once per look.
function cardKey(pattern, w, h, dpr) {
  const { kind, fg, bg, fgOpacity, bgOpacity, angle, density, aspect, seed, mode, src } = pattern;
  return JSON.stringify([kind, fg, bg, fgOpacity, bgOpacity, angle, density, aspect, seed, mode, src, w, h, dpr]);
}

/**
 * A card for `pattern` (a style's pattern, any kind), `w` by `h` CSS px, as a
 * data URL; '' where the engine cannot paint it (no Rust painter, an old wasm,
 * a document-less test).
 */
export function patternCard(pattern, w, h, dpr = 1) {
  const painter = glyphPainter();
  const engine = painter?.screen === true ? painter.engine?.low : null;
  if (!engine || typeof document === 'undefined') return '';
  const key = cardKey(pattern, w, h, dpr);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let url = '';
  try {
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(h * dpr));
    // The card's own offset, fade and anchor are left out: a card shows the
    // kind, not where its tiles start. A picked tile is shown at its own size.
    const p = { ...pattern, ox: 0, oy: 0, anchor: 'box', fade: { ...pattern.fade, on: false }, scale: 1 };
    const style = { size: CARD_FONT * dpr, color: '#000000', pattern: p };
    if (p.kind === 'picked') p.cell = p.cell.map((v) => v * dpr);
    const fill = screenFill(style, { x: 0, y: 0, w: W, h: H }, null, null);
    const raster = patternSwatch(engine, {
      width: W,
      height: H,
      fill,
      tiles: (f) => pickedTile(f.pattern?.src),
    });
    if (raster) {
      const cnv = document.createElement('canvas');
      cnv.width = W;
      cnv.height = H;
      cnv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(raster.data), W, H), 0, 0);
      url = cnv.toDataURL();
    }
  } catch {
    url = '';
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, url);
  return url;
}
