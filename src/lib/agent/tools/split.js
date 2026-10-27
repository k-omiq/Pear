// ===== split: one box's text, shared out over its bubbles =====
// The fix for text that belongs in two bubbles but came as one: detection read
// two touching bubbles as one block, or OCR ran two bubbles' lines together.
// One call cuts the box's text into parts, in reading order; the first part
// stays in the box and each other part gets a box of its own (a copy: same
// style, tags and speaker) in its own bubble:
//
//   - a bubble joined to the box's own, found as one outline (joined at a
//     neck, or drawn overlapping): the outline is cut between them
//     (bubble-outline.js `splitOutline`) and each part takes its piece. With
//     two parts and no `at`, the other bubble is found from the outline's
//     shape (`farLobe`), and the parts go to the pieces in reading order
//     (right to left, top to bottom).
//   - a bubble of its own elsewhere: `at` names a point in it, one per part
//     after the first, and the balloon there is found as a click finds it.
//
// Then every piece is typeset in its bubble. One undo step per page.

import { defineTool, ToolError } from '../registry.js';
import { app, boxText, duplicateBox, editBoxes, setBoxText, resizeBox, dropBoxOutline, refitBalloon, commitOutlinePoints, isTranslateMode } from '../../store.svelte.js';
import { breaksFor } from '../../measure.js';
import { splitOutline, farLobe } from '../../bubble-outline.js';
import { fitPolygon, intervalsAt } from '../../outline-geom.js';
import { matchesOf, checksOf, fitsFor, typesetMatches } from './edit.js';
import { sizesOf } from './check.js';
import { withPagePixels } from '../render.js';

export const MAX_PARTS = 4;

const inside = (pts, [x, y]) => intervalsAt(pts, y).some(([l, r]) => x >= l && x <= r);
const dot = ([x, y], r = 2) => [x - r, y - r, x + r, y + r];

// The parts as the text's own pieces (capitals and spacing as the text has
// them), or null when they are not the text, every word once, in order.
export function partsOf(text, parts) {
  const t = String(text ?? '');
  const b = breaksFor(t, null, 0, parts);
  if (!b) return null;
  return b.at.map((from, i) => t.slice(from, b.at[i + 1] ?? t.length).trim());
}

// Reading order of two points on a manga page: the higher first when they sit
// more above each other than side by side, else the one to the right.
export const readsFirst = (a, b) => (Math.abs(a[1] - b[1]) > Math.abs(a[0] - b[0]) ? a[1] <= b[1] : a[0] >= b[0]);

// Where the box's own text sits: its line's detected block, else the box.
function ownBlock(p, b) {
  const det = b.lineN != null ? (p.detect?.boxes ?? []).find((d) => d.n === b.lineN && Array.isArray(d.box) && d.box.length === 4) : null;
  return det ? det.box : [b.x, b.y, b.x + b.w, b.y + b.h];
}

defineTool({
  name: 'split',
  description:
    'Share one box\'s text out over two or more bubbles: for text that belongs in two bubbles but came as one (detection read two touching bubbles as one, or OCR ran two bubbles\' lines together). ' +
    `parts: the text cut into ${MAX_PARTS} pieces at most, in reading order, every word once (capitals may differ). The first part stays in the box; each other part gets a copy of the box (same style, tags, speaker) in its own bubble, and every piece is typeset there. ` +
    'Where the other bubbles are: with two parts and no at, the box\'s outline is cut between its two bubbles (found as one: joined at a neck, or drawn overlapping; check "joined") and the parts go to the pieces in reading order (right to left, top to bottom). ' +
    'at: one [x, y] page-px point per part after the first, inside that part\'s bubble: a point inside the box\'s own joined outline cuts it there; a point in a separate bubble finds that balloon as a click would. ' +
    'Returns the ids in part order, how each found its bubble (cut, found, or none: laid out free at the point), and their checks, fit and sizes. One undo step.',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'parts'],
    properties: {
      id: { type: 'string', description: 'the box whose text to share out' },
      parts: { type: 'array', minItems: 2, maxItems: MAX_PARTS, items: { type: 'string' } },
      at: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, description: 'a point per part after the first, page px' },
    },
  },
  write: true,
  async run({ id, parts, at } = {}, ctx) {
    if (isTranslateMode()) throw new ToolError('this chapter is in translate mode and has no boxes');
    const p = app.pages.find((pg) => pg.boxes?.some((b) => b.id === id));
    if (!p) throw new ToolError(`no box "${id}"`, 'query lists the box ids');
    const b = p.boxes.find((x) => x.id === id);
    if (!Array.isArray(parts) || parts.length < 2 || parts.length > MAX_PARTS || parts.some((t) => typeof t !== 'string' || !t.trim())) {
      throw new ToolError(`parts must be 2 to ${MAX_PARTS} non-empty strings`, 'e.g. ["Wait!", "Where are you going?"]');
    }
    const pieces = partsOf(boxText(b, p), parts);
    if (!pieces) throw new ToolError(`the parts are not box ${id}'s text`, 'give every word of the text once, in order, cut into parts (capitals may differ); box shows the text.');
    const nums = (q) => Array.isArray(q) && q.length === 2 && q.every((v) => typeof v === 'number' && Number.isFinite(v));
    if (at != null && (!Array.isArray(at) || at.length !== pieces.length - 1 || !at.every(nums))) {
      throw new ToolError(`at needs one [x, y] point per part after the first: ${pieces.length - 1} here`);
    }
    if (at?.some(([x, y]) => x < 0 || y < 0 || x > p.w || y > p.h)) throw new ToolError(`a point is off the page (${p.w} x ${p.h} px)`);

    // The seed of each part: the box's own text for the first; each other
    // part's point, or the far lobe of the box's outline.
    const pts = b.fit ? fitPolygon(b.fit) : null;
    const own = ownBlock(p, b);
    let seeds;
    let order = pieces.map((_, i) => i);
    if (at) seeds = [null, ...at];
    else {
      if (pieces.length !== 2) throw new ToolError('with more than two parts, give at: a point in each other part\'s bubble');
      const far = pts ? farLobe(pts, own) : null;
      if (!far) {
        throw new ToolError(`box ${id}'s outline is one bubble, with no second one joined to it`, 'give at: [[x, y]], a point inside the bubble the second part goes in (view with rulers to read it off).');
      }
      seeds = [null, far];
      // The lobe that reads first takes the first part.
      const mine = [(own[0] + own[2]) / 2, (own[1] + own[3]) / 2];
      if (!readsFirst(mine, far)) order = [1, 0];
    }
    const joined = seeds.map((q) => !!(q && pts && inside(pts, q)));
    const seedBox = (i) => (i === 0 ? own : dot(seeds[i]));

    const out = await withPagePixels([p], () => ctx.write([p], () => {
      const ids = [b.id];
      for (let i = 1; i < pieces.length; i++) ids.push(duplicateBox(b.id, p, { select: false }));
      if (ids.some((x) => !x)) return null;
      const boxes = ids.map((x) => p.boxes.find((bb) => bb.id === x));
      // The words first, so each outline below is laid out for its own part.
      // Through editBoxes, which records them for the undo.
      editBoxes(
        boxes.map((box) => ({ page: p, box })),
        (box) => setBoxText(box, pieces[boxes.indexOf(box)], p, { fit: false }),
        // The AI lays the box out as a placement does (`autoFitBox`).
        { solve: true },
      );
      const how = [];
      // Seed i's piece goes to the box of the part that reads there.
      const boxAt = (i) => boxes[order.indexOf(i)];
      for (let i = 0; i < seeds.length; i++) {
        const box = boxAt(i);
        if (i === 0 || joined[i]) {
          const others = seeds.map((_, k) => k).filter((k) => k !== i && (k === 0 || joined[k])).map(seedBox);
          const piece = pts && others.length ? splitOutline(pts, seedBox(i), others) : null;
          if (piece) {
            commitOutlinePoints(box.id, piece, p);
            how[order.indexOf(i)] = 'cut';
          } else how[order.indexOf(i)] = i === 0 ? (b.fit ? 'kept' : 'none') : 'none';
          continue;
        }
        // A bubble of its own: the copy is moved there and finds it.
        dropBoxOutline(box.id, p);
        resizeBox(p.id, box.id, { x: seeds[i][0] - box.w / 2, y: seeds[i][1] - box.h / 2 });
        how[order.indexOf(i)] = refitBalloon(box.id, p) ? 'found' : 'none';
      }
      typesetMatches(matchesOf(ids));
      return { ids, how };
    }));
    if (!out) throw new ToolError('the box could not be copied', 'is a chapter open in typeset mode?');
    return {
      page: app.pages.indexOf(p) + 1,
      ids: out.ids,
      pieces: out.ids.map((x, k) => ({ id: x, bubble: out.how[k] })),
      checks: checksOf(out.ids),
      fit: fitsFor(out.ids),
      sizes: matchesOf(out.ids).map((m) => ({ id: m.box.id, ...sizesOf(m.box, m.page) })),
    };
  },
});
