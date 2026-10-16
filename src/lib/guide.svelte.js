// ===== The series guide =====
// What a series keeps for itself beyond its tags: the glossary (with its
// characters), the text rules, free notes, and the typesetting defaults the
// series overrides. All of it lives in project.json under one `guide` key,
// beside the tag registry, so it travels with the series folder and applies to
// every chapter in it (docs/AI_TYPESETTING_PLAN.md section 4).
//
// Bound to the open project by the library, exactly like the tag registry
// (`bindTags`): `stored` is the record's `guide`, `save` is called with the
// whole guide after every write. With no project open the guide is empty and
// writes go nowhere. Nothing here imports the store, so the check list and the
// queue can read it without a cycle.
import { sanitizeGlossary, sanitizeTerm, newTermId } from './glossary.js';

// The text rules a series can choose (TXT-3). `keep` is "no rule": nothing is
// flagged, which is also what every project made before the guide reads as.
//   dashes    ascii: no em or en dashes, use '-'
//             em:    a dash between words is '—', never '--' or ' - '
//   ellipsis  dots:  '...', never '…'
//             char:  '…', never '...'
// Both also catch the spaced '. . .'.
export const DASH_RULES = ['keep', 'ascii', 'em'];
export const ELLIPSIS_RULES = ['keep', 'dots', 'char'];

// The typesetting defaults a series may override (FLOW-13), with the values
// each may take. The same keys and ranges as the person's own defaults in
// prefs.svelte.js, so one control set edits either.
export const SERIES_TYPESET_KEYS = {
  defaultAutoHeight: 'bool',
  defaultHyphenate: 'bool',
  defaultBalloon: 'bool',
  defaultBlockShape: ['auto', 'oval', 'rect'],
  defaultMinOrphan: [1, 8],
};

const MAX_NOTES = 20000;

export function emptyGuide() {
  return { glossary: [], rules: { dashes: 'keep', ellipsis: 'keep' }, notes: '', typeset: null };
}

// The series' typesetting override: null when the series uses the person's
// own defaults, else the keys it sets. A key of the wrong type is dropped,
// like any stored preference.
export function sanitizeSeriesTypeset(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, kind] of Object.entries(SERIES_TYPESET_KEYS)) {
    const v = raw[k];
    if (kind === 'bool') {
      if (typeof v === 'boolean') out[k] = v;
    } else if (typeof kind[0] === 'string') {
      if (kind.includes(v)) out[k] = v;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = Math.max(kind[0], Math.min(kind[1], Math.round(v)));
    }
  }
  return Object.keys(out).length ? out : null;
}

// A stored guide, or anything else. An absent `guide` - every project.json
// written before it existed - is the empty guide, and reading it writes
// nothing: the key reaches disk on the project's next write.
export function sanitizeGuide(raw) {
  const g = emptyGuide();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return g;
  g.glossary = sanitizeGlossary(raw.glossary);
  if (DASH_RULES.includes(raw.rules?.dashes)) g.rules.dashes = raw.rules.dashes;
  if (ELLIPSIS_RULES.includes(raw.rules?.ellipsis)) g.rules.ellipsis = raw.rules.ellipsis;
  if (typeof raw.notes === 'string') g.notes = raw.notes.slice(0, MAX_NOTES);
  g.typeset = sanitizeSeriesTypeset(raw.typeset);
  return g;
}

export const guide = $state(emptyGuide());

let saver = null;
// Told when the series' typesetting override changes, so the box defaults are
// pushed again (prefs.svelte.js registers it; this module cannot import prefs).
let onTypeset = null;
export function onSeriesTypeset(fn) {
  onTypeset = typeof fn === 'function' ? fn : null;
}

export function bindGuide(stored, save = null) {
  Object.assign(guide, sanitizeGuide(stored));
  saver = typeof save === 'function' ? save : null;
  onTypeset?.();
}

export function unbindGuide() {
  bindGuide(null, null);
}

export const guideBound = () => saver != null;

function save() {
  if (!saver) return;
  try {
    saver($state.snapshot(guide));
  } catch {
    /* the library's saver reports its own failures */
  }
}

// ---------- the glossary ----------
// Each a discrete click or a field committed on change, never a keystroke, so
// each write goes straight to the saver (the library chains and coalesces).

export function addTerm(fields = {}) {
  const t = sanitizeTerm({ ...fields, id: newTermId() });
  if (!t) return null;
  guide.glossary.push(t);
  save();
  return t;
}

export function updateTerm(id, patch = {}) {
  const i = guide.glossary.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const next = sanitizeTerm({ ...$state.snapshot(guide.glossary[i]), ...patch, id });
  // Clearing both sides of a term deletes it: an empty row means nothing.
  if (!next) {
    removeTerm(id);
    return null;
  }
  guide.glossary[i] = next;
  save();
  return next;
}

export function removeTerm(id) {
  const before = guide.glossary.length;
  guide.glossary = guide.glossary.filter((t) => t.id !== id);
  if (guide.glossary.length !== before) save();
  return guide.glossary.length !== before;
}

export const termById = (id) => (id ? (guide.glossary.find((t) => t.id === id) ?? null) : null);

// ---------- rules, notes, typesetting ----------

export function setGuideRule(key, value) {
  const allowed = key === 'dashes' ? DASH_RULES : key === 'ellipsis' ? ELLIPSIS_RULES : null;
  if (!allowed?.includes(value) || guide.rules[key] === value) return;
  guide.rules[key] = value;
  save();
}

export function setGuideNotes(text) {
  const v = typeof text === 'string' ? text.slice(0, MAX_NOTES) : '';
  if (v === guide.notes) return;
  guide.notes = v;
  save();
}

// `null` hands the series back to the person's own defaults; an object is
// merged over what the series already overrides.
export function setSeriesTypeset(patch) {
  guide.typeset = patch == null ? null : sanitizeSeriesTypeset({ ...(guide.typeset ?? {}), ...patch });
  save();
  onTypeset?.();
}
