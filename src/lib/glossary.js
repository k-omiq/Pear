// ===== The series glossary (TXT-1, TXT-2, TXT-6) =====
// One list of terms per series, kept in project.json inside the series guide
// (`guide.svelte.js`): "this source word is always this English word here".
// A character is a term too - a name is the term a reader notices most when it
// drifts - marked `character`, with a stable `id` a line's `speaker` points at
// and an optional tag its boxes take their style from.
//
// Pure: no store, no filesystem, so the matcher can be tested in node and the
// check list, the queue's chips and (later) the agent's `check` all share it.
//
// The matching rule follows Komatose's `glossary.ts` (see THIRD-PARTY.md): both
// sides folded by NFKC, case and whitespace, so full-width letters, a capital
// at the start of a sentence and a name broken across two lines all still
// match; a term shorter than 2 characters after folding is never checked,
// because one kana or one letter is found inside almost anything.

const MAX_TERM = 100;
const MAX_NOTE = 2000;
const MAX_ALIASES = 30;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

let idSeq = 0;
// Ids only have to be unique within one series' list, and survive a save; a
// time stamp plus a counter is plenty and needs no crypto.
export const newTermId = () => `g${Date.now().toString(36)}${(idSeq++).toString(36)}`;

// One stored entry, vetted field by field like a tag: anything of the wrong
// type is dropped rather than coerced, and an entry with neither side is no
// entry. `aliases` are other SOURCE spellings of the same term (a name in kanji
// and in katakana), never other English ones: an English alias would let the
// very drift the check exists to catch count as "used".
export function sanitizeTerm(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = str(raw.source, MAX_TERM);
  const target = str(raw.target, MAX_TERM);
  if (!source && !target) return null;
  const aliases = Array.isArray(raw.aliases)
    ? [...new Set(raw.aliases.map((a) => str(a, MAX_TERM)).filter(Boolean))].slice(0, MAX_ALIASES)
    : [];
  return {
    id: typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(raw.id) ? raw.id : newTermId(),
    source,
    target,
    aliases,
    note: str(raw.note, MAX_NOTE),
    // Locked: a term the user wrote or accepted, which an AI edit may not
    // change. Every term made by hand is locked; absent reads as locked.
    locked: raw.locked !== false,
    character: raw.character === true,
    tag: typeof raw.tag === 'string' && raw.tag.trim() ? raw.tag.trim() : null,
  };
}

// A whole stored list. Ids are made unique here too: a hand-edited file with
// two entries sharing an id would leave a speaker pointing at either.
export function sanitizeGlossary(raw) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(raw) ? raw : []) {
    const t = sanitizeTerm(e);
    if (!t) continue;
    if (seen.has(t.id)) t.id = newTermId();
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

export const foldTerm = (s) =>
  typeof s === 'string' ? s.normalize('NFKC').replace(/\s+/g, '').toLowerCase() : '';

// Does `text` contain `term`, under the fold? Anywhere, including inside a
// longer word: "Makoto-sama" uses "Makoto".
export function textHasTerm(text, term) {
  const t = foldTerm(term);
  if (t.length < 2) return false;
  return foldTerm(text).includes(t);
}

// The terms whose source (or a source alias) is in `jp`, each with whether
// its English is in `en`. Longer sources first, so the chips read the
// specific name before a shorter term found inside it. A line with no English
// yet reports nothing: it is not a miss, it is a line not translated.
export function glossaryHits(jp, en, terms) {
  if (!String(jp ?? '').trim() || !String(en ?? '').trim()) return [];
  const out = [];
  for (const t of terms ?? []) {
    if (!t?.target) continue;
    const sources = [t.source, ...(t.aliases ?? [])].filter(Boolean);
    if (!sources.some((s) => textHasTerm(jp, s))) continue;
    out.push({ term: t, used: textHasTerm(en, t.target) });
  }
  return out.sort((a, b) => b.term.source.length - a.term.source.length);
}

export const glossaryMisses = (jp, en, terms) =>
  glossaryHits(jp, en, terms)
    .filter((h) => !h.used)
    .map((h) => h.term);

// The characters a line's speaker can be.
export const glossaryCharacters = (terms) => (terms ?? []).filter((t) => t.character && t.target);

// A speaker named in an imported file, by its English or source name or an
// alias, under the fold. Null when nothing in the list is called that.
export function findCharacter(terms, name) {
  const n = foldTerm(name);
  if (!n) return null;
  return (
    glossaryCharacters(terms).find(
      (t) => foldTerm(t.target) === n || foldTerm(t.source) === n || (t.aliases ?? []).some((a) => foldTerm(a) === n),
    ) ?? null
  );
}

// An imported file's speakers, by name (`speakerName`, see importer.js), made
// into character ids: each line takes the id of the character called that,
// and a name the series has no character for becomes a new character, once.
// Returns the lines (copies where one changed) and the characters it made, for
// the caller to add to the series' glossary. `terms` is not changed.
export function resolveSpeakerNames(lines, terms) {
  const made = [];
  const all = [...(terms ?? [])];
  const out = (lines ?? []).map((l) => {
    if (!l || typeof l.speakerName !== 'string') return l;
    const { speakerName, ...rest } = l;
    let c = findCharacter(all, speakerName);
    if (!c) {
      c = sanitizeTerm({ target: speakerName, character: true });
      all.push(c);
      made.push(c);
    }
    return { ...rest, speaker: c.id };
  });
  return { lines: out, made };
}
