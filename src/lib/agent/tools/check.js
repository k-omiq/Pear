import { defineTool } from '../registry.js';
import { selectBoxes } from '../select.js';
import { countedChecks } from '../counted-checks.js';
import { untrusted } from '../fence.js';
import { app, lineByN, pageCheckItems, reviewOf, CHECK_REASONS } from '../../store.svelte.js';
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
  description: 'Check matching boxes for overflow, check-list reasons (including glossary and guide rules), collisions, panel crossings and tag-size outliers. Return only boxes with problems, in page/box order, with 1-based pages and panel numbers. where uses the query AND selector; pages accepts current (default), all, "2-5", "1,3" or [1,3]; ids/selection default to all pages. Neighbours on the whole page count even outside the selector. count counts all problem boxes, checked counts all selected boxes; problems is capped at 200 with truncated: true. Free text is fenced.',
  input: {
    type: 'object', additionalProperties: false,
    properties: { where: { $ref: '#/$defs/where' } },
    $defs: { where },
  },
  run({ where = {} }) {
    const { matches } = selectBoxes(where);
    const problems = checksFor(matches);
    return { count: problems.length, problems: problems.slice(0, 200), checked: matches.length, ...(problems.length > 200 ? { truncated: true } : {}) };
  },
});
