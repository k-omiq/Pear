// ===== Text proposals: the data (TXT-4) =====
// What a proposal is on disk, checked on the way in. No imports, so the store
// can read proposals at load without a cycle (proposals.svelte.js does the
// rest).
export const MAX_PER_PAGE = 40;
const MAX_TEXT = 2000;

let seq = 0;
export const newId = () => `pr${Date.now().toString(36)}${(seq++).toString(36)}`;

// A proposal off disk, or null when it cannot be one.
export function sanitizeOne(x) {
  if (!x || typeof x !== 'object') return null;
  const t = x.target;
  const target = Number.isInteger(t?.line) ? { line: t.line } : typeof t?.box === 'string' && t.box ? { box: t.box } : null;
  if (!target || typeof x.text !== 'string' || typeof x.base !== 'string' || x.text.length > MAX_TEXT) return null;
  return {
    id: typeof x.id === 'string' && x.id ? x.id.slice(0, 40) : newId(),
    target,
    text: x.text,
    base: x.base,
    by: typeof x.by === 'string' && x.by ? x.by.slice(0, 24) : 'ai',
    ...(typeof x.reason === 'string' && x.reason ? { reason: x.reason.slice(0, 300) } : null),
    ...(typeof x.run === 'string' && x.run ? { run: x.run.slice(0, 40) } : null),
  };
}

// The page's proposals as loaded: valid ones only, at most MAX_PER_PAGE.
export function sanitizeProposals(list) {
  if (!Array.isArray(list)) return [];
  return list.map(sanitizeOne).filter(Boolean).slice(0, MAX_PER_PAGE);
}

