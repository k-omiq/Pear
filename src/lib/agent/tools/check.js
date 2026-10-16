import { defineTool } from '../registry.js';
import { selectBoxes } from '../select.js';
import { countedChecks } from '../counted-checks.js';
import { untrusted } from '../fence.js';
import { app, lineByN, boxText, pageCheckItems, reviewOf, CHECK_REASONS } from '../../store.svelte.js';
import { fitReport, fitIssues, fitQuality } from '../../fit-report.js';
import { lineTags } from '../../tags.svelte.js';

// Check the whole page before projecting onto matches: neighbours and the
// tag-size median must still count when only one box was selected.
export function checksFor(matches) {
  const pages = new Map();
  for (const { page, pageIndex } of matches) {
    if (pages.has(page)) continue;
    const issues = new Map(page.boxes.map((b) => [b.id, []]));
    for (const item of pageCheckItems(page, pageIndex ?? app.pages.indexOf(page))) {
      const list = issues.get(item.boxId);
      if (!list) continue; // Unplaced lines have no matching box.
      const issue = { kind: item.reason };
      if (item.review?.reason) issue.detail = untrusted(item.review.reason);
      if (item.terms) issue.detail = item.terms.map((term) => untrusted(term));
      if (item.breaks) issue.detail = [...item.breaks];
      if (item.font) issue.detail = item.font;
      if (item.confidence != null) issue.detail = { confidence: item.confidence };
      list.push(issue);
    }
    for (const b of page.boxes) {
      const review = reviewOf(b, page);
      if (review && !issues.get(b.id).some((issue) => issue.kind === 'overflow')) {
        issues.get(b.id).push({ kind: 'overflow', ...(review.reason ? { detail: untrusted(review.reason) } : {}) });
      }
    }
    // The text against its outline, in numbers (fit-report.js): only for a box
    // with an outline, since a box with none has nothing to be inside.
    for (const b of page.boxes) {
      const rep = fitReport(b, boxText(b, page));
      if (rep) issues.get(b.id).push(...fitIssues(rep, { round: roundOutline(b) }));
    }
    const counted = countedChecks(page, (b) => lineTags(lineByN(page, b.lineN)));
    for (const { boxId, other, overlap } of counted.collisions) {
      issues.get(boxId).push({ kind: 'collision', with: other, detail: { overlap } });
      issues.get(other).push({ kind: 'collision', with: boxId, detail: { overlap } });
    }
    for (const { boxId, panel } of counted.panels) {
      issues.get(boxId).push({ kind: 'panel', detail: { panel: panel + 1 } });
    }
    for (const { boxId, size, median, tag } of counted.sizes) {
      issues.get(boxId).push({ kind: 'size', detail: { size, median, tag } });
    }
    pages.set(page, issues);
  }
  return matches.flatMap(({ page, pageIndex, box }) => {
    const issues = pages.get(page).get(box.id) ?? [];
    return issues.length ? [{ id: box.id, page: (pageIndex ?? app.pages.indexOf(page)) + 1, issues }] : [];
  });
}

// A balloon asks for an oval block; a caption frame or a box drawn as its own
// outline does not.
const roundOutline = (b) => b.fit?.kind !== 'rect' && !['caption', 'box'].includes(b.outline?.source);

// The fit report, short, for the boxes a write changed: what the agent reads
// before it looks. Boxes with no outline are left out.
export function fitsOf(matches) {
  const out = [];
  for (const { page, box: b } of matches) {
    const rep = fitReport(b, boxText(b, page));
    if (!rep) continue;
    out.push({
      id: b.id,
      quality: fitQuality(rep, { round: roundOutline(b), ref: b.auto?.refSize }),
      size: rep.size,
      lines: rep.lines,
      inside: rep.inside,
      ...(rep.overflow ? { overflow: rep.overflow } : null),
      margin: rep.margin.em,
      shape: rep.shape.kind,
      ...(rep.shape.oval != null ? { oval: rep.shape.oval } : null),
      widths: rep.rows.map((r) => r[0]),
      room: rep.rows.map((r) => r[1]),
      centre: [rep.centre.dx, rep.centre.dy],
      fill: rep.fill,
    });
  }
  return out;
}

const where = {
  type: 'object', additionalProperties: false,
  properties: {
    pages: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'integer', minimum: 1 } }] },
    ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    selection: { const: true },
    tag: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    text: { type: 'string', description: 'Case-insensitive JavaScript regex over displayed text.' },
    font: { type: 'string' },
    size: { type: 'object', additionalProperties: false, properties: { min: { type: 'number' }, max: { type: 'number' } } },
    flagged: { anyOf: [{ const: true }, { enum: ['guide', ...CHECK_REASONS] }] },
    outline: { enum: ['unapproved', 'open', 'ai', 'user'] },
    kind: { enum: ['text', 'sfx', 'ink'] },
    not: { $ref: '#/$defs/where' },
  },
};

defineTool({
  name: 'check',
  description: 'Check matching boxes for overflow, check-list reasons (including glossary and guide rules), collisions, panel crossings and tag-size outliers, and, for a box with a bubble outline, its text against that outline: outside (ink past the outline, px per side), tight (air under 0.25 em), hourglass, shape (funnel, pyramid or far from an oval, in a balloon), offcentre (ink centre off the bubble centre, px), hyphen and orphan. quality: the mean lettering score (0-100: air, shape, centre, hyphens, orphans, size kept against the size aimed for, fill) of the boxes with outlines and the five weakest, to work on first. Return only boxes with problems, in page/box order, with 1-based pages and panel numbers. where uses the query AND selector; pages accepts current (default), all, "2-5", "1,3" or [1,3]; ids/selection default to all pages. Neighbours on the whole page count even outside the selector. count counts all problem boxes, checked counts all selected boxes; problems is capped at 200 with truncated: true. Free text is fenced.',
  input: {
    type: 'object', additionalProperties: false,
    properties: { where: { $ref: '#/$defs/where' } },
    $defs: { where },
  },
  run({ where = {} }) {
    const { matches } = selectBoxes(where);
    const problems = checksFor(matches);
    const fits = fitsOf(matches);
    const pageOf = new Map(matches.map((m) => [m.box.id, (m.pageIndex ?? app.pages.indexOf(m.page)) + 1]));
    const quality = fits.length
      ? {
          mean: Math.round(fits.reduce((s, f) => s + f.quality, 0) / fits.length),
          weakest: [...fits].sort((a, z) => a.quality - z.quality).slice(0, 5).map((f) => ({ id: f.id, page: pageOf.get(f.id), quality: f.quality })),
        }
      : null;
    return { count: problems.length, problems: problems.slice(0, 200), checked: matches.length, ...(quality ? { quality } : {}), ...(problems.length > 200 ? { truncated: true } : {}) };
  },
});
