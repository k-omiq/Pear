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
import { footprintOf, slantOf, lookFor, isUpright } from '../footprint.js';
import { app, boxText, lineByN } from '../../store.svelte.js';
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
  const det = b.lineN != null ? (p.detect?.boxes ?? []).find((d) => d.n === b.lineN && Array.isArray(d.box) && d.box.length === 4) : null;
  const base = det ? [det.box[0], det.box[1], det.box[2] - det.box[0], det.box[3] - det.box[1]] : boxBounds(b);
  return grown(base, p);
}

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
    'ink { fill, outline, colour (a colour page), accent }, under { tone } (the art left under it), and suggest: the turn, the size the box\'s text needs to run its length (with id), and the colours an English SFX takes over it (rules A and B). ' +
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
    const { fp, region, why } = await footprintIn(p, box ? footprintRegion(p, box) : rect.map(Math.round), box);
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
