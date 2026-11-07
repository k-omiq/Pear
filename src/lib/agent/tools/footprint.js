// ===== footprint: the original lettering a box replaces =====
// Eyes for an SFX before it is drawn: the original's ink, found where the
// cleaner changed the page (the raw scan against the cleaned page, footprint.js),
// as numbers - where it sits, its length and breadth, the slant it runs at,
// how heavy its strokes are, its colours and the tone of the art under it -
// and the look an English SFX takes over it. edit's do "match_original" lays
// a box over the same footprint in one step.
//
// Read-only. The region is drawn small (render.js `regionPixels`); no image
// goes back.

import { defineTool, ToolError } from '../registry.js';
import { regionPixels, boxBounds } from '../render.js';
import { footprintOf, slantOf, lookFor, isUpright, colourMismatch, inkLeftIn, isUncleaned } from '../footprint.js';
import { untrusted } from '../fence.js';
import { app, boxText, lineByN, lineText } from '../../store.svelte.js';
import { applyCase, sizeToCover } from '../../measure.js';
import { lineTags, withKinds } from '../../tags.svelte.js';
import { ART_SIZED_ROLES } from '../../lettering.js';

// Round the region the original is looked for in, of each side: letters run
// past the block detection drew round them.
const GROW = 0.25;
const MIN_GROW = 12;
// The outline band over art: about 3 px on a 1500 px page (rule A).
export const outlineWidthFor = (p) => Math.max(1, Math.round(((p?.w > 0 ? p.w : 1500) / 1500) * 3 * 10) / 10);

// Where to look for the original under box `b`: its line's detected block,
// which is where the original sat, else the box; grown, on the page.
export function footprintRegion(p, b) {
  const block = lineBlock(p, b);
  return grown(block ?? boxBounds(b), p);
}

function lineBlock(p, b) {
  const det = b.lineN != null ? (p.detect?.boxes ?? []).find((d) => d.n === b.lineN && Array.isArray(d.box) && d.box.length === 4) : null;
  return det ? [det.box[0], det.box[1], det.box[2] - det.box[0], det.box[3] - det.box[1]] : null;
}

// Where the original a box's colours are checked against lies: its line's
// block while the box is on it, else under the box itself. A box set apart
// from its block was put there on purpose - a split, a sound placed by hand
// over its original, a block numbered for another line - and checking it
// against the block would ask it for another sound's colours.
export function placedRegion(p, b) {
  const own = boxBounds(b);
  const block = lineBlock(p, b);
  return grown(block && touches(block, own) ? block : own, p);
}

const touches = ([ax, ay, aw, ah], [bx, by, bw, bh]) => ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;

function grown([x, y, w, h], p) {
  const gx = Math.max(MIN_GROW, w * GROW);
  const gy = Math.max(MIN_GROW, h * GROW);
  const x0 = Math.max(0, x - gx);
  const y0 = Math.max(0, y - gy);
  const x1 = p?.w > 0 ? Math.min(p.w, x + w + gx) : x + w + gx;
  const y1 = p?.h > 0 ? Math.min(p.h, y + h + gy) : y + h + gy;
  return [x0, y0, x1 - x0, y1 - y0].map((v) => Math.round(v));
}

// The page's other text, which the cleaner removed too: the detected blocks
// of every line but box `b`'s own - or, round a bare rect, of every line set
// in balloons (dialogue, narration) - so a footprint never takes a
// neighbour's words for the original. Page px [x0, y0, x1, y1], grown a
// little, as letters run past their block.
const PAD = 6;
export function otherText(p, b = null) {
  const own = (d) => (b ? (b.lineN != null ? d.n === b.lineN : false) : withKinds(lineTags(lineByN(p, d.n))).some((t) => ART_SIZED_ROLES.includes(t)));
  return (p.detect?.boxes ?? [])
    .filter((d) => Array.isArray(d.box) && d.box.length === 4 && !own(d))
    .map(({ box: [x0, y0, x1, y1] }) => {
      const g = PAD + 0.08 * Math.min(x1 - x0, y1 - y0);
      return [x0 - g, y0 - g, x1 + g, y1 + g];
    });
}

// `raw` with the pixels inside `rects` (page px) taken from `clean`: as if the
// cleaner had left them alone. A copy; the pictures passed in are kept.
function withoutText(raw, clean, rects) {
  const [rx, ry] = raw.rect;
  const s = raw.scale;
  let data = null;
  for (const [x0, y0, x1, y1] of rects) {
    const ix0 = Math.max(0, Math.floor((x0 - rx) * s));
    const iy0 = Math.max(0, Math.floor((y0 - ry) * s));
    const ix1 = Math.min(raw.width, Math.ceil((x1 - rx) * s));
    const iy1 = Math.min(raw.height, Math.ceil((y1 - ry) * s));
    if (ix1 <= ix0 || iy1 <= iy0) continue;
    data ??= new Uint8ClampedArray(raw.data);
    for (let y = iy0; y < iy1; y++) {
      const from = (y * raw.width + ix0) * 4;
      data.set(clean.data.subarray(from, (y * raw.width + ix1) * 4), from);
    }
  }
  return data ? { ...raw, data } : raw;
}

// The footprint in `region` of page `p`, or why there is none: what the
// cleaner removed there, the page's other text (`otherText`, round box `b`)
// left out. A page names its images by file (`file`, `cleanedFile`); `raw`
// and `cleaned` are their loaded pictures, there only while something holds
// the page's images (regionPixels does).
export async function footprintIn(p, region, b = null) {
  if (!(p.file || p.raw)) return { fp: null, region, why: 'this page has no raw scan to compare' };
  if (!(p.cleanedFile || p.cleaned)) return { fp: null, region, why: 'this page has no cleaned image, so nothing shows where the original was' };
  const clean = await regionPixels(p, region, { source: 'clean' });
  const raw = withoutText(await regionPixels(p, region, { source: 'raw' }), clean, otherText(p, b));
  const fp = footprintOf(raw, clean, { rect: raw.rect, scale: raw.scale });
  return fp
    ? { fp, region: raw.rect }
    : { fp: null, region: raw.rect, why: 'the cleaner changed nothing here besides other lines\' text: no original under it, or it was left uncleaned (view source "clean" shows)' };
}

// The original last read under each box, per page: what `check` compares an
// SFX's colours against. Every fresh read (`originalOf`, the footprint tool,
// match_original) writes it; a check reads it, and reads the page only for a
// box it has none for. Kept with the region and the images it was read from,
// so a moved line or a new cleaned page reads again.
const kept = new WeakMap(); // page -> Map(boxId -> { key, found })
const keyOf = (p, region) => JSON.stringify([p.file ?? p.raw ?? null, p.cleanedFile ?? p.cleaned ?? null, region]);

// The original under box `b` on page `p`, read off the page images now.
export async function originalOf(p, b, region = footprintRegion(p, b)) {
  const found = await footprintIn(p, region, b);
  if (!kept.has(p)) kept.set(p, new Map());
  kept.get(p).set(b.id, { key: keyOf(p, region), found });
  return found;
}

// The original last read under box `b`, when it was read from where the box's
// line now is: { fp, why } or undefined (never read).
export function keptOriginalOf(p, b, region = footprintRegion(p, b)) {
  const k = kept.get(p)?.get(b.id);
  return k && k.key === keyOf(p, region) ? k.found : undefined;
}

// Tags whose boxes take their original's colours exactly (rule C): the sounds
// and titles drawn over the art.
export const MATCHED_COLOUR_TAGS = ['sfx', 'sfx-sharp', 'sfx-soft', 'title'];
const matchesColour = (p, b) => withKinds(lineTags(lineByN(p, b.lineN))).some((t) => MATCHED_COLOUR_TAGS.includes(t));

// Reads the original under every matched SFX box not read yet, so `check` can
// compare its colours. Pages with no cleaned image have nothing to read.
export async function readOriginals(matches) {
  for (const { page: p, box: b } of matches) {
    const region = placedRegion(p, b);
    if (!matchesColour(p, b) || !(p.cleanedFile || p.cleaned) || keptOriginalOf(p, b, region) !== undefined) continue;
    await originalOf(p, b, region);
  }
}

// The `sfx_colour` issue for box `b`: its fill and outline are not its
// original's, as last read. Null when they are, or when no original is known.
export function sfxColourIssue(p, b) {
  if (!matchesColour(p, b)) return null;
  const ink = keptOriginalOf(p, b, placedRegion(p, b))?.fp?.ink;
  const off = ink ? colourMismatch(b.style, ink) : null;
  return off ? { kind: 'sfx_colour', detail: off } : null;
}

// The detected lines (with English) whose original letters the cleaner left
// on page `p`:
// [{ line, jp, rect, left }], left being the share of the raw scan's ink in
// the block still on the cleaned page. The whole page read once at each
// source, kept until its images or its detection change. A page with no
// cleaned image, or images that cannot be read here, has none.
const LEFT_SIDE = 1600;
const leftKept = new WeakMap(); // page -> { key, list }
export async function uncleanedOn(p) {
  if (!(p.file || p.raw) || !(p.cleanedFile || p.cleaned)) return [];
  // Lines with English only: a line nobody will letter is no mess left.
  const blocks = (p.detect?.boxes ?? []).filter((d) => Array.isArray(d.box) && d.box.length === 4 && lineByN(p, d.n)?.jp?.trim() && lineText(lineByN(p, d.n)).trim());
  if (!blocks.length) return [];
  const key = JSON.stringify([p.file ?? p.raw ?? null, p.cleanedFile ?? p.cleaned ?? null, blocks.map((d) => [d.n, d.box])]);
  const had = leftKept.get(p);
  if (had?.key === key) return had.list;
  let list = [];
  try {
    const whole = [0, 0, p.w > 0 ? p.w : 1e6, p.h > 0 ? p.h : 1e6];
    const clean = await regionPixels(p, whole, { source: 'clean', maxSide: LEFT_SIDE });
    const raw = await regionPixels(p, whole, { source: 'raw', maxSide: LEFT_SIDE });
    for (const d of blocks) {
      const [x0, y0, x1, y1] = d.box;
      const rect = [x0, y0, x1 - x0, y1 - y0].map(Math.round);
      const left = inkLeftIn(raw, clean, rect);
      if (isUncleaned(left)) list.push({ line: d.n, jp: untrusted(lineByN(p, d.n).jp, 40), rect, left: left.share });
    }
  } catch {
    list = [];
  }
  leftKept.set(p, { key, list });
  return list;
}

// What an English SFX over `fp` takes: its turn, a size for `text` that runs
// the original's length (across it, over an upright one), and its colours.
// `style` is the box's (for the face).
export function matchFor(fp, p, { text = '', style = null } = {}) {
  const size = style && text ? sizeToCover(applyCase(text, style), style, fp.length, fp.breadth, { upright: isUpright(fp) }) : null;
  return {
    rotation: slantOf(fp),
    ...(isUpright(fp) ? { upright: true } : null),
    ...(size > 0 ? { size: Math.round(size * 2) / 2 } : null),
    ...lookFor(fp, { outlineWidth: outlineWidthFor(p) }),
  };
}

function pageAt(n) {
  const count = app.pages?.length ?? 0;
  if (!count) throw new ToolError('no chapter is open', 'open a chapter first');
  if (!Number.isInteger(n) || n < 1 || n > count) throw new ToolError(`no page ${JSON.stringify(n)}`, `pages are 1-${count}`);
  return app.pages[n - 1];
}

defineTool({
  name: 'footprint',
  description:
    'Find the original lettering (an SFX, a title, a sign) under a box or in a rect, where the cleaner removed it: the raw scan against the cleaned page. ' +
    'Returns centre [x, y], length (along its slant) and breadth, angle (its axis, degrees, clockwise on screen), elongation, stroke (px) and weight (thin|medium|heavy), ' +
    'ink { fill (the colour deepest in its letters), outline (the band round them, or null: it had none), outlineWidth (px), shade (two fill colours, top to bottom: a gradient), colour (a colour page), accent }, under { tone } (the art left under it), and suggest: the turn, the size the box\'s text needs to run its length (with id), and the colours an English SFX takes over it: exactly the original\'s (rule C). ' +
    'id looks round the box\'s detected line (or the box); rect is [x, y, w, h] in page px. Null footprint with a why when the page has no cleaned image or nothing was cleaned there. ' +
    'To lay a box over it in one step: edit with do "match_original".',
  input: {
    type: 'object',
    additionalProperties: false,
    properties: {
      page: { type: 'integer', minimum: 1, description: '1-based page; may be left out with id.' },
      id: { type: 'string', description: 'a box id' },
      rect: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[x, y, w, h] in page px' },
    },
  },
  write: false,
  async run({ page, id, rect } = {}) {
    if ((id == null) === (rect == null)) throw new ToolError('give id or rect', 'id: "b12" looks under that box; rect: [x, y, w, h] anywhere.');
    let p;
    let box = null;
    if (id != null) {
      const i = app.pages.findIndex((pg) => pg.boxes?.some((b) => b.id === id));
      if (i < 0) throw new ToolError(`no box "${id}"`, 'query lists the box ids');
      if (page != null && page !== i + 1) throw new ToolError(`box ${id} is on page ${i + 1}, not page ${page}`);
      p = app.pages[i];
      box = p.boxes.find((b) => b.id === id);
    } else {
      if (!(Array.isArray(rect) && rect.every((v) => typeof v === 'number' && Number.isFinite(v)) && rect[2] > 0 && rect[3] > 0)) {
        throw new ToolError('rect must be [x, y, w, h] in page px, w and h above 0');
      }
      if (page == null) throw new ToolError('page is required with rect');
      p = pageAt(page);
    }
    const { fp, region, why } = box ? await originalOf(p, box) : await footprintIn(p, rect.map(Math.round));
    const n = app.pages.indexOf(p) + 1;
    if (!fp) return { page: n, ...(id ? { id } : null), region, footprint: null, why };
    return {
      page: n,
      ...(id ? { id } : null),
      region,
      footprint: fp,
      suggest: matchFor(fp, p, box ? { text: boxText(box, p), style: box.style } : {}),
    };
  },
});
