// ===== Text proposals (TXT-4) =====
// AI wording is never written over the user's words. In the AI panel, a text
// change the agent makes is kept as a proposal on its page, beside the words
// it would replace, until the user takes it (Use) or drops it (Reject)
// (docs/komatose-port/06-text.md TXT-4, TXT-8).
//
// A proposal: { id, target, text, base, by, reason?, run? }
//   target   { line: n } - a line's English - or { box: id } - a box's own words
//   base     the words when it was made. Use applies it only while the words
//            are still `base`; once they changed, the user sees both and
//            decides (`acceptProposal` with force).
//   run      the AI run that made it, so Revert run takes it back too
//
// Proposals live on the page (`p.proposals`) and are saved in chapter.json,
// but never in exports or packages. Taking one rejects the rest for the same
// words; taking one is an ordinary text edit, one undo step.
import { app, pageById, lineByN, lineText, boxText, editBoxes, setBoxText, writeLineText, markUnsaved, settleEdits } from './store.svelte.js';

import { MAX_PER_PAGE, sanitizeOne, newId } from './proposal-data.js';
export { sanitizeProposals } from './proposal-data.js';

const sameTarget = (a, b) => (a.line != null ? a.line === b.line : a.box === b.box);

// The words a target holds now, or null when it is gone.
export function targetText(p, target) {
  if (target.line != null) {
    const ln = lineByN(p, target.line);
    return ln ? lineText(ln) : null;
  }
  const b = p.boxes?.find((x) => x.id === target.box);
  return b ? boxText(b, p) : null;
}

export const proposalsFor = (p, target) => (p?.proposals ?? []).filter((x) => sameTarget(x.target, target));

// A new proposal on `p`. Nothing when it would change nothing, or the same
// words are proposed already. Returns the proposal, or null.
export function propose(p, target, text, { by = 'ai', reason = '', run = '' } = {}) {
  const base = targetText(p, target);
  if (base == null) return null;
  if (text === base) return null;
  p.proposals ??= [];
  const same = p.proposals.find((x) => sameTarget(x.target, target) && x.text === text);
  if (same) return same;
  const pr = sanitizeOne({ id: newId(), target, text, base, by, reason, run });
  if (!pr) return null;
  if (p.proposals.length >= MAX_PER_PAGE) p.proposals.shift();
  p.proposals.push(pr);
  markUnsaved();
  return p.proposals[p.proposals.length - 1];
}

const find = (pageId, id) => {
  const p = pageById(pageId);
  const i = p?.proposals?.findIndex((x) => x.id === id) ?? -1;
  return i < 0 ? null : { p, i, pr: p.proposals[i] };
};

// Whether a proposal still applies as made: its words are still its base.
export function isStale(p, pr) {
  const now = targetText(p, pr.target);
  return now == null || now !== pr.base;
}

// Use: the words become the proposal's. Refused ('stale') while the words
// changed since it was made, unless `force` - the user saw both. The other
// proposals for the same words go.
export function acceptProposal(pageId, id, { force = false } = {}) {
  const f = find(pageId, id);
  if (!f) return 'gone';
  const { p, pr } = f;
  const now = targetText(p, pr.target);
  if (now == null) {
    rejectProposal(pageId, id);
    return 'gone';
  }
  if (now !== pr.base && !force) return 'stale';
  settleEdits();
  if (pr.target.line != null) writeLineText(p, pr.target.line, 'en', pr.text);
  else {
    const b = p.boxes.find((x) => x.id === pr.target.box);
    editBoxes([{ page: p, box: b }], (box, pg) => setBoxText(box, pr.text, pg, { fit: false }), { solve: true });
  }
  p.proposals = p.proposals.filter((x) => !sameTarget(x.target, pr.target));
  markUnsaved();
  return 'used';
}

export function rejectProposal(pageId, id) {
  const f = find(pageId, id);
  if (!f) return false;
  f.p.proposals.splice(f.i, 1);
  markUnsaved();
  return true;
}

// Revert run: the proposals a run made go with the rest of its work.
export function dropRunProposals(runId) {
  let n = 0;
  for (const p of app.pages) {
    const before = p.proposals?.length ?? 0;
    if (!before) continue;
    p.proposals = p.proposals.filter((x) => x.run !== runId);
    n += before - p.proposals.length;
  }
  if (n) markUnsaved();
  return n;
}

export const pendingCount = () => app.pages.reduce((n, p) => n + (p.proposals?.length ?? 0), 0);
