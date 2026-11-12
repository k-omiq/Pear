// ===== alternatives: wordings that fit (TXT-5) =====
// A line too long for its balloon is the text problem a typesetter meets most.
// The agent writes a few shorter wordings with the same meaning; this tool
// lays each one out in the box's outline with the solver - nothing on the page
// changes - and says which fit at the size the box aims for. In the AI panel
// the ones that fit become proposals the user takes or drops (TXT-4); through
// the MCP door it only measures.
import { defineTool, ToolError } from '../registry.js';
import { untrusted } from '../fence.js';
import { app, boxText, trialSolve, boxLocked } from '../../store.svelte.js';
import { fitReport, fitQuality } from '../../fit-report.js';
import { fitPolygon, isRectOutline } from '../../outline-geom.js';
import { propose } from '../../proposals.svelte.js';
import { readsLine, lineLocked } from './edit.js';

const MAX = 8;
const MAX_CHARS = 600;
// A wording fits when no ink leaves the outline and the size gives up no
// more than this share of what the box aims for (instructions rule 6).
const SHRINK = 0.1;
const PROPOSE = 3;

const roundOutline = (b) => b.fit?.kind !== 'rect' && !['caption', 'box'].includes(b.outline?.source) && !isRectOutline(fitPolygon(b.fit));

function measure(b, text, aim) {
  const rep = fitReport(b, text);
  if (!rep) return null;
  const size = b.style.size;
  const quality = fitQuality(rep, { round: roundOutline(b), ref: b.auto?.refSize });
  const fits = !!rep.inside && size >= aim * (1 - SHRINK) - 0.01;
  return { fits, size, quality, lines: rep.lines, ...(rep.overflow ? { overflow: rep.overflow } : null), margin: rep.margin.em };
}

defineTool({
  name: 'alternatives',
  description:
    `Try up to ${MAX} other wordings for one box and learn which fit its outline at the size it aims for, with nothing on the page changed. ` +
    'Each wording is laid out by the solver in the box\'s outline; per wording: fits (no ink outside and shrunk no more than a tenth), size, quality (0-100), lines, overflow. Best first. ' +
    `In the AI panel the best ${PROPOSE} that fit become proposals the user takes or drops (a card with Use and Reject); through other doors nothing is written. ` +
    'Write the wordings yourself: shorter, the same meaning and voice, the glossary\'s names, no filler. Use it for a box that overflows, shrank far below its kind, or reads cramped.',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'wordings'],
    properties: {
      id: { type: 'string', description: 'the box' },
      wordings: { type: 'array', minItems: 1, maxItems: MAX, items: { type: 'string' } },
      reason: { type: 'string', description: 'why, in a few words; shown to the user with each proposal' },
    },
  },
  write: true,
  run({ id, wordings, reason = '' }, ctx) {
    if (!Array.isArray(wordings) || !wordings.length) throw new ToolError('wordings must be a non-empty list of strings');
    if (wordings.length > MAX) throw new ToolError(`at most ${MAX} wordings`);
    for (const [i, w] of wordings.entries()) {
      if (typeof w !== 'string' || !w.trim()) throw new ToolError(`wordings[${i}] must be words`);
      if (w.length > MAX_CHARS) throw new ToolError(`wordings[${i}] is longer than ${MAX_CHARS} characters`);
    }
    const pi = app.pages.findIndex((p) => p.boxes?.some((b) => b.id === id));
    if (pi < 0) throw new ToolError(`no box "${id}"`, 'query or lines list the box ids.');
    const p = app.pages[pi];
    const b = p.boxes.find((x) => x.id === id);
    if (boxLocked(b)) throw new ToolError(`box ${id} is locked`, 'the user locked it to hold it as it is; ask them first');
    if (!b.fit) throw new ToolError(`box ${id} has no outline to measure against`, 'edit do "typeset" gives it one; then try again.');
    const now = boxText(b, p);
    const aim = b.auto?.refSize > 0 ? b.auto.refSize : b.style.size;

    const tried = [...new Set(wordings)].map((w) => {
      const m = trialSolve(b, p, w, (box) => measure(box, w, aim));
      return { text: w, ...(m ?? { fits: null, note: 'could not be measured now (a font still loading)' }) };
    });
    tried.sort((x, y) => (y.fits === true) - (x.fits === true) || (y.quality ?? 0) - (x.quality ?? 0));

    let proposed = [];
    if (ctx?.door === 'panel') {
      const onLine = readsLine(b, p);
      if (onLine && lineLocked(p, b.lineN)) throw new ToolError(`line ${b.lineN} is shown by a locked box`, 'ask the user before changing its words');
      const target = onLine ? { line: b.lineN } : { box: b.id };
      const run = ctx.runId();
      proposed = tried
        .filter((t) => t.fits && t.text !== now)
        .slice(0, PROPOSE)
        .map((t) => propose(p, target, t.text, { run, reason }))
        .filter(Boolean);
    }
    return {
      id,
      page: pi + 1,
      now: untrusted(now),
      aimedFor: aim,
      tried: tried.map(({ text, ...m }) => ({ text: untrusted(text), ...m })),
      ...(ctx?.door === 'panel'
        ? {
            proposed: proposed.map((pr) => ({ proposal: pr.id, pageId: p.id, page: pi + 1, ...(pr.target.line != null ? { line: pr.target.line } : { id: b.id }), before: untrusted(pr.base), proposed: untrusted(pr.text) })),
            note: proposed.length ? 'The user sees each as a card with Use and Reject.' : 'None fit: write shorter ones, or tell the user.',
          }
        : null),
    };
  },
});
