// ===== place, add, detect: boxes from the page =====
// docs/AI_TYPESETTING_PLAN.md section 1. `place` is the app's own Place
// (the solver puts every detected line in its bubble); `add` is one box at a
// point or in a rectangle; `detect` runs detection where a page has none.
// Each waits for its slow part first (measuring, the engine) and writes in one
// synchronous step inside the AI run, so a chapter switch in between changes
// nothing.

import { defineTool, ToolError } from '../registry.js';
import { parsePages } from '../select.js';
import { matchesOf, checksOf, fitsFor } from './edit.js';
import { validateStylePatch } from '../style-schema.js';
import { app, measureForPlace, commitPlace, addBoxAt, isTranslateMode, placeableDetectedLines, lineByN } from '../../store.svelte.js';
import { hasRawImage } from '../../page-images.js';
import { sidecarReady, detectOnePage, detectionChapter } from '../../sidecar.js';

const pagesSchema = {
  description: '"current", "all", "2-5", "1,3,7-9" or [1, 3]; 1-based. Default "current".',
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'integer', minimum: 1 } }],
};

const pagesOf = (spec) => parsePages(spec ?? 'current');
const pageNo = (p) => app.pages.indexOf(p) + 1;

defineTool({
  name: 'place',
  description:
    'Place every detected line that has no box yet, each in its bubble, laid out by the solver: the app\'s Place. ' +
    'pages limits it. Lines already placed are left alone; to lay a placed box out again use edit with do: "refit". ' +
    'Returns the new box ids per page and the checks for them.',
  input: { type: 'object', additionalProperties: false, properties: { pages: pagesSchema } },
  write: true,
  async run({ pages } = {}, ctx) {
    if (isTranslateMode()) throw new ToolError('this chapter is in translate mode and has no boxes');
    const ps = pagesOf(pages).filter((p) => placeableDetectedLines(p).length);
    if (!ps.length) return { placed: 0, pages: [], note: 'nothing to place: no detected lines without a box on those pages. Run detect first if a page has none.' };
    const measured = await measureForPlace(ps);
    if (!measured) throw new ToolError(measured === null ? 'the place was cancelled' : 'a place is already running, or the chapter changed', 'Wait, then call again.');
    if (!ctx.stillPinned()) throw new ToolError('the chapter changed in the app, so nothing was placed');
    const r = ctx.write(ps, () => commitPlace(ps, measured));
    const ids = [];
    const per = [];
    for (const [p, items] of r.placed) {
      if (!items.length) continue;
      const pageIds = items.map((it) => it.box.id);
      ids.push(...pageIds);
      per.push({ page: pageNo(p), ids: pageIds });
    }
    return {
      placed: r.total,
      pages: per,
      ...(r.changed ? { changedWhileFitting: r.changed, hint: 'those pages changed while being measured; call place again' } : {}),
      checks: checksOf(ids),
      fit: fitsFor(ids),
    };
  },
});

defineTool({
  name: 'add',
  description:
    'Add one box. page is 1-based. line: a line number on that page with no box yet; or text for new free text. ' +
    'at [x, y]: the box goes in the balloon at that point, as a click would place it. rect [x, y, w, h]: exactly there, with no balloon fit. ' +
    'style: a style patch (the edit schema). Page px. Returns the new box id and its checks.',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['page'],
    properties: {
      page: { type: 'integer', minimum: 1 },
      line: { type: 'integer' },
      text: { type: 'string' },
      at: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      rect: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
      style: { type: 'object' },
    },
  },
  write: true,
  run({ page: n, line, text, at, rect, style } = {}, ctx) {
    const [p] = pagesOf([n]);
    if ((line == null) === (text == null)) throw new ToolError('give line or text, not both and not neither', 'line: 3 places line 3; text: "..." adds free text.');
    if ((at == null) === (rect == null)) throw new ToolError('give at or rect', 'at: [x, y] fits the balloon there; rect: [x, y, w, h] is exact.');
    const nums = (a, k) => Array.isArray(a) && a.length === k && a.every((v) => typeof v === 'number' && Number.isFinite(v));
    if (at != null && !nums(at, 2)) throw new ToolError('at must be [x, y] numbers');
    if (rect != null && (!nums(rect, 4) || rect[2] < 8 || rect[3] < 8)) throw new ToolError('rect must be [x, y, w, h] numbers, w and h at least 8');
    const pt = at ?? [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2];
    if (pt[0] < 0 || pt[1] < 0 || pt[0] > p.w || pt[1] > p.h) throw new ToolError(`the point is off the page (${p.w} x ${p.h} px)`);
    if (line != null && !lineByN(p, line)) throw new ToolError(`page ${n} has no line ${line}`, 'query or box shows line numbers.');
    if (style != null) {
      const e = validateStylePatch(style)[0];
      if (e) throw new ToolError(`style.${e.path}: ${e.error}`, e.hint);
    }
    const b = ctx.write([p], () => addBoxAt(p, { lineN: line ?? null, text: text ?? null, x: at?.[0], y: at?.[1], rect, style }));
    if (typeof b === 'string') throw new ToolError(b);
    return { id: b.id, page: n, rect: [b.x, b.y, b.w, b.h].map(Math.round), checks: checksOf([b.id]), fit: fitsFor([b.id]) };
  },
});

defineTool({
  name: 'detect',
  description:
    'Run text detection and OCR on pages that have none yet (the app\'s Detect). Slow: seconds per page. ' +
    'Pages that already have detection are skipped; the user re-detects by hand. Then call place.',
  input: { type: 'object', additionalProperties: false, properties: { pages: pagesSchema } },
  write: true,
  async run({ pages } = {}, ctx) {
    if (isTranslateMode()) throw new ToolError('this chapter is in translate mode');
    if (!sidecarReady()) throw new ToolError('the detection engine is not ready', 'Ask the user to check it in Settings, System.');
    if (app.detecting) throw new ToolError('detection is already running', 'Wait, then call again.');
    const asked = pagesOf(pages);
    const ps = asked.filter((p) => !p.detect && hasRawImage(p));
    if (!ps.length) return { detected: [], skipped: asked.length, note: 'every page asked for already has detection or has no raw image' };
    // Joins the run, so Revert takes the new lines back off these pages.
    ctx.write(ps, () => {});
    const current = detectionChapter();
    const done = [];
    const failed = [];
    app.detecting = true;
    try {
      for (const p of ps) {
        if (!current() || !ctx.stillPinned()) break;
        const r = await detectOnePage(p, { ocr: true, language: app.projectOcrLanguage }, current);
        if (r.stopped) break;
        if (r.error) failed.push({ page: pageNo(p), error: r.error });
        else if (!r.skipped) done.push({ page: pageNo(p), lines: r.lines });
      }
    } finally {
      app.detecting = false;
    }
    if (!current()) throw new ToolError('the chapter changed in the app, so detection stopped');
    return { detected: done, ...(failed.length ? { failed } : {}), skipped: asked.length - ps.length };
  },
});
