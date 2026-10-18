// ===== view: what the page looks like =====
// docs/AI_TYPESETTING_PLAN.md sections 1 and 3. A page or a region of one as
// one picture, or the boxes a `where` matches as proof sheets: each box a
// labelled crop with its bubble outline and points. Pictures only, at most
// three per call, each within the model's no-resize size. The legend and the
// note carry ids, pages and counts, never page text.

import { defineTool, ToolError } from '../registry.js';
import { selectBoxes } from '../select.js';
import { renderRegion, proofSheets, proofOrder, OUTLINE_KEY, MAX_SIDE } from '../render.js';
import { app } from '../../store.svelte.js';

export const MAX_IMAGES = 3;
export const PER_SHEET = 20;
// A compare sheet holds each box twice, so fewer to a sheet, in bigger cells.
export const PER_COMPARE_SHEET = 12;
const COMPARE_CELL = 480;

const SOURCES = ['typeset', 'raw', 'clean', 'compare'];

const input = {
  type: 'object',
  properties: {
    target: {
      description:
        'What to show. { page } is a whole page; { page, rect } a region of it, rect [x, y, w, h] in page px; ' +
        '{ where } the matching boxes as proof sheets (unapproved outlines first, lowest confidence first). Pages are 1-based.',
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1 },
        rect: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
        where: { type: 'object', description: 'a box selector, the same shape every tool takes' },
      },
    },
    marks: {
      description: 'Page and region views only. ids: true or a list of box ids to label; outlines: bubble outlines with their points; rulers: page px, ticks every 10 (every 50 or 100 zoomed out), numbered every 50 or more.',
      type: 'object',
      properties: {
        ids: { anyOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string' } }] },
        outlines: { type: 'boolean' },
        rulers: { type: 'boolean' },
      },
    },
    source: { type: 'string', enum: SOURCES, description: '"typeset" (default); "raw": the original scan, its Japanese lettering still on it, for matching an SFX; "clean": the cleaned page with none of our text - original letters that still show there were left by the cleaner; "compare": the raw scan and ours of the same region at one scale, tabbed "original" and "ours" (side by side, or one above the other for a wide region) - with a where, each box as its own pair, its crop taking in where its original was detected. Judge every SFX this way: same place, slant, size, weight and colour as the original.' },
    scale: { type: 'number', description: `page and region views: image px per page px; default fits ${MAX_SIDE} px on the long side, never past 2.` },
  },
  required: ['target'],
};

function pageAt(n) {
  const count = app.pages?.length ?? 0;
  if (!count) throw new ToolError('no chapter is open', 'open a chapter first');
  if (!Number.isInteger(n) || n < 1 || n > count) {
    throw new ToolError(`no page ${JSON.stringify(n)}`, `pages are 1-${count}`);
  }
  return app.pages[n - 1];
}

function checkMarks(marks) {
  if (marks == null) return {};
  if (typeof marks !== 'object' || Array.isArray(marks)) throw new ToolError('marks must be an object', '{ ids, outlines, rulers }');
  const { ids, outlines, rulers } = marks;
  if (ids != null && typeof ids !== 'boolean' && !(Array.isArray(ids) && ids.every((v) => typeof v === 'string'))) {
    throw new ToolError('marks.ids must be true or a list of box ids');
  }
  return { ids: ids ?? false, outlines: !!outlines, rulers: !!rulers };
}

const image = (img) => ({ png: img.png, mime: img.mime, width: img.width, height: img.height });

async function viewRegion(target, marks, source, scale) {
  const n = target.page;
  const p = pageAt(n);
  const rect = target.rect;
  if (rect != null && !(Array.isArray(rect) && rect.length === 4 && rect.every((v) => typeof v === 'number' && Number.isFinite(v)))) {
    throw new ToolError('rect must be [x, y, w, h] in page px');
  }
  if (rect != null && !(rect[2] > 0 && rect[3] > 0)) throw new ToolError('rect needs a width and a height above 0');
  if (scale != null && !(typeof scale === 'number' && scale > 0)) throw new ToolError('scale must be a number above 0');
  const img = await renderRegion(p, rect ?? null, { scale, marks, source });
  const [x, y, w, h] = img.rect;
  return {
    images: [{ ...image(img), page: n, rect: img.rect, scale: Math.round(img.scale * 1e4) / 1e4, ...(img.panels ? { panels: img.panels } : null) }],
    legend: img.boxes.map((b) => ({ id: b.id, page: n, cell: { image: 0, x: b.x, y: b.y, w: b.w, h: b.h } })),
    note:
      `page ${n}, ${source}, page px [${x}, ${y}, ${w}, ${h}] at ${Math.round(img.scale * 1000) / 1000} image px per page px; ` +
      (img.panels ? 'the raw scan ("original") then ours ("ours"), panels in image px; box cells are in ours; ' : '') +
      `${img.boxes.length} box${img.boxes.length === 1 ? '' : 'es'} in view.` +
      (marks.outlines ? ` ${OUTLINE_KEY}` : ''),
  };
}

async function viewWhere(where, source) {
  if (!app.pages?.length) throw new ToolError('no chapter is open', 'open a chapter first');
  if (where == null || typeof where !== 'object' || Array.isArray(where)) throw new ToolError('where must be a selector object');
  const { matches = [] } = (await selectBoxes(where)) ?? {};
  const items = matches
    .map((m) => {
      const p = m.page && typeof m.page === 'object' ? m.page : app.pages[m.pageIndex];
      const index = m.page && typeof m.page === 'object' ? app.pages.indexOf(m.page) : m.pageIndex;
      return p && m.box ? { page: p, pageNo: index + 1, box: m.box } : null;
    })
    .filter(Boolean);
  if (!items.length) return { images: [], legend: [], note: '0 boxes matched; nothing to show. Check the selector.' };
  const ordered = proofOrder(items);
  const compare = source === 'compare';
  const perSheet = compare ? PER_COMPARE_SHEET : PER_SHEET;
  const { sheets, left } = await proofSheets(ordered, { perSheet, maxSheets: MAX_IMAGES, source, ...(compare ? { cell: COMPARE_CELL } : null) });
  const legend = [];
  let k = 0;
  sheets.forEach((sheet, i) => {
    for (const c of sheet.cells) {
      const it = ordered[k++];
      legend.push({ id: c.id, page: it.pageNo, cell: { image: i, x: c.x, y: c.y, w: c.w, h: c.h } });
    }
  });
  const shown = items.length - left;
  return {
    images: sheets.map(image),
    legend,
    note:
      `${items.length} box${items.length === 1 ? '' : 'es'} matched; ${shown} shown on ${sheets.length} proof sheet${sheets.length === 1 ? '' : 's'}, ` +
      'unapproved outlines first (lowest confidence first), then the approved' +
      (left ? `; ${left} left out (at most ${MAX_IMAGES * perSheet} a call): narrow the where, or ask again with the ids not shown.` : '.') +
      (compare
        ? ' Each cell holds the raw scan (tabbed "<id> original") and ours ("ours") of the same crop.'
        : ` Each cell is labelled with its box id and outline state. ${OUTLINE_KEY}`),
  };
}

export const viewTool = defineTool({
  name: 'view',
  description:
    'See the page. A page or region as one picture, with optional marks (box ids, bubble outlines and their points, rulers in page px), ' +
    'typeset, raw, clean, or compare (the raw scan beside ours, to match an SFX to its original). A where returns proof sheets: each matching box as a labelled crop with its outline and points (with compare, the raw scan beside ours), ' +
    `${PER_SHEET} to a sheet, at most ${MAX_IMAGES} sheets a call. Judge each outline and each fit by eye.`,
  input,
  write: false,
  async run(args) {
    const { target, source = 'typeset', scale } = args;
    if (!SOURCES.includes(source)) throw new ToolError(`no source "${source}"`, 'source is "typeset", "raw", "clean" or "compare"');
    if (target == null || typeof target !== 'object' || Array.isArray(target)) {
      throw new ToolError('target is required', '{ page }, { page, rect } or { where }');
    }
    if (target.where != null) {
      if (target.page != null || target.rect != null) throw new ToolError('target takes a where or a page, not both');
      return viewWhere(target.where, source);
    }
    if (target.page == null) throw new ToolError('target needs a page or a where', '{ page }, { page, rect } or { where }');
    return viewRegion(target, checkMarks(args.marks), source, scale);
  },
});
