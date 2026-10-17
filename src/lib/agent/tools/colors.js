// ===== colors: what colours a region is =====
// Eyes for colour, which a picture alone gives the model only roughly: the
// colours a patch of a page is made of, with how much of it each covers, its
// average and how light it is, and the accent - the most colourful colour that
// is not the background, which on a colour page is the ink of the original
// SFX. Two jobs: colour-match an English SFX to the one it replaces (sample
// the raw art over the original), and pick a text colour that reads on the
// art under a balloon or a box.
//
// Read-only. The region is drawn small (render.js `regionPixels`, at most
// 400 px on the long side) and measured by palette.js; no image goes back,
// only numbers, so it costs the model almost nothing to ask.

import { defineTool, ToolError } from '../registry.js';
import { regionPixels, boxBounds } from '../render.js';
import { paletteOf } from '../palette.js';
import { app } from '../../store.svelte.js';

const SOURCES = ['raw', 'clean', 'typeset'];
export const DEFAULT_COUNT = 5;

export const COLORS_NOTE =
  'palette: the colours, largest share first (palette[0] is usually the background; on a rect drawn tight round big letters it may be their ink). ' +
  'accent: the most colourful colour that is not palette[0] and covers 3% or more, null on black and white: give it to an English SFX that replaces this one (style.color, a stroke, or gradient stops), the rest of the palette for its outline or shading. ' +
  'mean is the average colour, luminance its lightness 0..1, tone dark|mid|light: on a dark tone set white text, on light black, on mid add a stroke of the other.';

const input = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'integer', minimum: 1, description: '1-based page. May be left out when id is given (the box\'s page).' },
    rect: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[x, y, w, h] in page px. Give rect or id, not both; neither is the whole page.' },
    id: { type: 'string', description: 'a box id: sample under that box\'s bounds (its rotation included).' },
    source: { type: 'string', enum: SOURCES, description: '"raw" (default): the original scan, its lettering still on it. "clean": the cleaned page, none of our text (the tone a box will sit on). "typeset": with our text.' },
    count: { type: 'integer', minimum: 2, maximum: 8, description: `palette size, at most; default ${DEFAULT_COUNT}.` },
  },
};

function pageAt(n) {
  const count = app.pages?.length ?? 0;
  if (!count) throw new ToolError('no chapter is open', 'open a chapter first');
  if (!Number.isInteger(n) || n < 1 || n > count) throw new ToolError(`no page ${JSON.stringify(n)}`, `pages are 1-${count}`);
  return app.pages[n - 1];
}

// The box with `id` and its 1-based page, wherever it is.
function boxById(id) {
  for (let i = 0; i < (app.pages?.length ?? 0); i++) {
    const box = app.pages[i].boxes?.find((b) => b.id === id);
    if (box) return { box, pageNo: i + 1 };
  }
  return null;
}

export const colorsTool = defineTool({
  name: 'colors',
  description:
    'Read the colours of a page region as numbers: palette (hex and share, largest first), mean, luminance, tone and accent. ' +
    'To colour-match an English SFX, sample source "raw" on the original SFX\'s rect (or the id of the box over it) and use accent, or the palette, in its style. ' +
    'To pick a text colour, sample under the balloon or the box: white text on a dark tone, black on a light one. ' +
    'page is 1-based; rect is [x, y, w, h] in page px; give rect or id, or neither for the whole page.',
  input,
  write: false,
  async run(args) {
    const { page, rect, id, source = 'raw', count = DEFAULT_COUNT } = args;
    if (!SOURCES.includes(source)) throw new ToolError(`no source "${source}"`, 'source is "raw", "clean" or "typeset"');
    if (!(Number.isInteger(count) && count >= 2 && count <= 8)) throw new ToolError('count must be a whole number from 2 to 8');
    if (rect != null && id != null) throw new ToolError('give rect or id, not both', 'id samples under the box; rect is any region');
    if (rect != null && !(Array.isArray(rect) && rect.length === 4 && rect.every((v) => typeof v === 'number' && Number.isFinite(v)))) {
      throw new ToolError('rect must be [x, y, w, h] in page px');
    }
    if (rect != null && !(rect[2] > 0 && rect[3] > 0)) throw new ToolError('rect needs a width and a height above 0');

    let n = page;
    let region = rect ?? null;
    if (id != null) {
      if (typeof id !== 'string' || !id) throw new ToolError('id must be a box id string');
      const hit = boxById(id);
      if (!hit) throw new ToolError(`no box "${id}"`, 'query lists the box ids');
      if (n != null && n !== hit.pageNo) throw new ToolError(`box ${id} is on page ${hit.pageNo}, not page ${n}`, 'leave page out, or give that page');
      n = hit.pageNo;
      region = boxBounds(hit.box);
    } else if (n == null) {
      throw new ToolError('page is required', 'give page (1-based), or the id of a box');
    }
    const p = pageAt(n);

    const px = await regionPixels(p, region, { source });
    const colours = paletteOf(px, { count });
    if (!colours) throw new ToolError('nothing to read in that region');
    return {
      page: n,
      ...(id != null ? { id } : null),
      rect: px.rect,
      source,
      ...colours,
      note: COLORS_NOTE,
    };
  },
});
