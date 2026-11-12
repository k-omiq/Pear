// ===== Tags =====
// A tag is a name the user puts on a queued line - `sfx`, `narration`, whatever
// else they invent - plus a style patch, reference size and minimum size that a
// box picks up at the moment it is placed.
//
// Two halves, deliberately kept apart, because they persist in different places
// and for different reasons:
//
//   the applied tags  live on the line, in chapter.json, with the document.
//                     They are what the user marked up, and they mean nothing
//                     without the chapter they were marked on.
//   the registry      lives in project.json, with the project. It is that
//                     project's working vocabulary - "sfx means Bangers with a
//                     fat outline here" - and a second project starts with none
//                     of it: a tag made in one series must not turn up, usable
//                     and pre-styled, in another. Nothing needs the registry to
//                     draw: a tag's defaults are baked into the box's own style
//                     at placement time, so a chapter opened on a machine whose
//                     copy of the project lacks the registry renders identically.
//                     The remembered font size per tag lives beside it, for the
//                     same reason - "sfx is about 60 in this series".
//
// This module imports only the style schema in data.js, never the store or
// filesystem. Functions that touch the document take pages as an argument,
// which also makes the whole model testable in node. The store imports *this*,
// for the one thing that has to happen inside placement.

import { defaultStyle, normalizeStyle, strokesFromBands } from './data.js';
import { ROLE_TAGS } from './lettering.js';

// Every write here is a discrete click - created a tag, edited a tag, applied a
// tag - never a drag or a key repeat, so there is nothing to coalesce: each one
// hands the whole registry to the saver the library bound (see `bindTags`).

// The two values `line.type` has ever carried that mean anything to a reader.
// `dialogue` is the unmarked default and is deliberately not a tag: the queue has
// always hidden its badge, and promoting it would put a tag on every line in
// every chapter ever imported.
export const LEGACY_TAGS = ['sfx', 'narration'];

// A tag name is folded to one canonical spelling before anything else sees it.
// Without this, a user typing `SFX` creates a second tag beside the `sfx` that is
// already in every chapter.json detection has ever written, and the migration
// below buys nothing. Length is capped because the name is rendered in a badge on
// a row in a narrow floating panel.
// This function must be idempotent - `normalizeTagName(normalizeTagName(x))`
// has to equal `normalizeTagName(x)` - because the two halves of the model
// normalise at different moments and then compare the results by string
// equality. `tagsInUse` reports the name stored on the line; `boxesWithTag`
// re-normalises the name it is handed and matches against that. A name that
// changed on the second pass matched nothing, so a tag the panel had just
// offered restyled zero boxes and the queue's lit chip added a near-duplicate
// instead of removing it.
//
// Hence the second trim, after the cap and not before it: a 25-character name
// whose 24th character is a space came out of `.slice()` still carrying it.
export const MAX_TAG_LEN = 24;
export function normalizeTagName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_TAG_LEN).trim();
  return n === '' ? null : n;
}

// ---------- the registry ----------
// Ordered most-recently-used first. One array rather than a list plus a separate
// recency order, because two of them can disagree - a name in the order that is
// not in the list is a slot in the picker that applies a tag with no defaults and
// no way to edit it. The picker's first two slots are simply the first two
// entries.
export const tags = $state({ list: [], sizes: {} });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const okSize = (v) => (isNum(v) && v > 0 ? v : null);

// What a tag's style patch may hold (LET-1): any style key but these.
// Geometry and transforms belong to the box, even when its lettering comes
// from a tag - a path, a clip, ink, a warp mesh or an SFX recipe were drawn
// for one box's text, and a rotation for one balloon; paint marks were laid
// over one box's letters, in its own frame. Size has its own
// reference and floor beside the patch. And the five line-breaking keys are
// the typesetting defaults' (Settings, or the series' override, FLOW-13): a
// tag saved off a box laid out plain would otherwise turn the smart breaker
// off for every later box of the tag without anyone choosing that.
const BOX_STYLE_KEYS = new Set([
  'size', 'path', 'ink', 'paint', 'warp', 'circle', 'sfx', 'rotation', 'flipH', 'flipV', 'curve',
  'shape', 'minOrphan', 'hyphenate', 'margin', 'balloon', 'autoHeight',
]);
export const TAG_STYLE_KEYS = Object.keys(defaultStyle()).filter((k) => !BOX_STYLE_KEYS.has(k));
const isPatch = (v) =>
  v != null && typeof v === 'object' &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function sanitizeTagStyle(style) {
  if (!isPatch(style)) return {};
  const picked = {};
  for (const k of TAG_STYLE_KEYS) if (Object.hasOwn(style, k)) picked[k] = $state.snapshot(style[k]);
  // A tag saved before 2026-11-10 set its outline as bands (`strokes`): the
  // strokes they make (`strokesFromBands`), as `normalizeStyle` reads a box's.
  if (Array.isArray(style.strokes) && !Object.hasOwn(picked, 'strokeEffects')) picked.strokeEffects = strokesFromBands($state.snapshot(style.strokes));
  const vetted = normalizeStyle({ ...defaultStyle(), ...picked });
  return Object.fromEntries(Object.keys(picked).map((k) => [k, vetted[k]]));
}

// The kind of text a user's own tag sits under (a role, lettering.js): a
// style of that kind - "angry" under speech - whose look is laid over the
// kind's, and which counts as that kind wherever a rule asks (an SFX is drawn
// over the art). A role itself sits under nothing.
const kindFor = (name, kind) => (ROLE_TAGS.includes(kind) && !ROLE_TAGS.includes(name) ? kind : null);

// One entry, stored or carried in a package. The migration is a read-time
// one, like the line tags': an entry written before tags held a style has
// `font`, `outline` and `outlineWidth` instead, and reads as the patch those
// meant - the font, and the outline as the whole stroke list (a width of 0 is
// "no outline"). Nothing rewrites the file; the next registry write saves the
// new shape. An entry that has a `style` ignores the old fields.
export function sanitizeTagEntry(e) {
  const name = normalizeTagName(e && typeof e === 'object' ? e.name : e);
  if (!name) return null;
  let style = e?.style;
  if (!isPatch(style)) {
    style = {};
    if (typeof e?.font === 'string' && e.font !== '') style.font = e.font;
    if (e?.outline != null || e?.outlineWidth != null) {
      const width = e.outlineWidth ?? 3;
      style.strokeEffects = width <= 0 ? [] : strokesFromBands([{ color: e.outline ?? '#ffffff', width, opacity: 1 }]);
    }
  }
  const kind = kindFor(name, e?.kind);
  return { name, style: sanitizeTagStyle(style), size: okSize(e?.size), minSize: okSize(e?.minSize), ...(kind ? { kind } : null) };
}

// A stored registry is a preference of the least important kind, so the same rule
// as the panel geometry applies: anything that does not parse, or does not carry
// the right types, is dropped rather than coerced. An entry survives only if its
// name survives; each default is vetted on its own, so one bad colour costs a
// colour and not the tag.
export function sanitizeTags(stored) {
  let raw = stored;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.list) ? raw.list : [];
  const out = [];
  const seen = new Set();
  for (const e of arr) {
    const entry = sanitizeTagEntry(e);
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(entry);
  }
  return out;
}

// The remembered font size per tag group, keyed by the line's first tag - the
// same one `styleForLine` lets win - with the untagged group under ''. Anything
// that is not a finite number is dropped, like a bad tag default.
export function sanitizeTagSizes(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (isNum(v)) out[k] = v;
  return out;
}

// The registry is bound to the open project by the library, which is the one
// module that knows where project.json is: `stored` is `{ list, sizes }` off the
// project record and `save` is called with the same shape after every write.
// With no project open the registry is empty and writes go nowhere, which is
// what `unbindTags` puts it back to.
let saver = null;

export function bindTags(stored, save = null) {
  tags.list = sanitizeTags(stored);
  tags.sizes = sanitizeTagSizes(stored?.sizes);
  saver = typeof save === 'function' ? save : null;
}

export function unbindTags() {
  bindTags(null, null);
}

// ---------- an AI run's Revert ----------
// A run keeps what it changed, tag by tag and size key by size key, and its
// Revert puts back only that: a tag the user made or edited after the run
// (Revert stays open after it ends) is theirs and stays. A tag only moved up
// the recency order counts as unchanged.
export const snapshotTags = () => ({ list: $state.snapshot(tags.list), sizes: $state.snapshot(tags.sizes) });
export const emptyTagChanges = () => ({ list: new Map(), sizes: new Map() });

// Into `kept`, the first time each one changes between two snapshots: a tag's
// entry and place before (null: it did not exist), a size key's value before.
export function keepTagChanges(kept, before, after) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const name of new Set([...before.list, ...after.list].map((t) => t.name))) {
    if (kept.list.has(name)) continue;
    const index = before.list.findIndex((t) => t.name === name);
    const was = before.list[index] ?? null;
    if (!same(was, after.list.find((t) => t.name === name) ?? null)) kept.list.set(name, was ? { entry: was, index } : null);
  }
  for (const key of new Set([...Object.keys(before.sizes), ...Object.keys(after.sizes)])) {
    if (!kept.sizes.has(key) && before.sizes[key] !== after.sizes[key]) kept.sizes.set(key, before.sizes[key] ?? null);
  }
}

export const tagChangesKept = (kept) => kept.list.size > 0 || kept.sizes.size > 0;

// What `keepTagChanges` kept, put back over the registry as it is now, and saved.
export function restoreTagChanges(kept) {
  if (!saver || !tagChangesKept(kept)) return false;
  // Copies through `snapshotTags`: see `snapshotGuide` for why not here.
  let { list, sizes } = snapshotTags();
  for (const [name, was] of kept.list) {
    list = list.filter((t) => t.name !== name);
    if (was) list.splice(Math.min(was.index, list.length), 0, was.entry);
  }
  for (const [key, was] of kept.sizes) {
    if (was == null) delete sizes[key];
    else sizes[key] = was;
  }
  tags.list = sanitizeTags(list);
  tags.sizes = sanitizeTagSizes(sizes);
  save();
  return true;
}

function save() {
  if (!saver) return;
  try {
    saver({ list: $state.snapshot(tags.list), sizes: $state.snapshot(tags.sizes) });
  } catch {
    /* the library's saver reports its own failures */
  }
}

// Size memory per tag group: the REFERENCE size the user chose for the group,
// which placement solves down from (FIT-1). Read at placement (see
// `inheritedStyleFor`), written on a deliberate size change and nothing else
// (see `rememberSizeFor`). An unchanged size is not a write, so it does not
// reach project.json.
export const tagSize = (key) => (isNum(tags.sizes[key]) ? tags.sizes[key] : null);

export function rememberTagSize(key, size) {
  if (typeof key !== 'string' || !isNum(size) || tags.sizes[key] === size) return;
  tags.sizes[key] = size;
  save();
}

// A default size the user has just set in the tag's form is also the size the
// group is remembered at: it is the newest deliberate choice for this kind of
// text, and a memory left over from an older chapter must not outrank it. Only
// a CHANGED default writes it, so saving the form for its font does not throw
// away a size learned from the boxes since. No save here - the caller saves.
function seedSize(name, before, after) {
  if (after != null && after !== before) tags.sizes[name] = after;
}

export const findTag = (name) => tags.list.find((t) => t.name === name) ?? null;

// The kind of text a tag is: a kind itself (a role), the kind a user's tag
// sits under, or null.
export const kindOfTag = (name) => (ROLE_TAGS.includes(name) ? name : (findTag(name)?.kind ?? null));

// Tags with, after them, the kind each user's tag sits under: what the rules
// that ask "is this an SFX?" or "is this speech?" read, and what a style is
// laid over.
export function withKinds(names) {
  const out = [...names];
  for (const n of names) {
    const k = findTag(n)?.kind;
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

// Every tag of the given kinds: the roles themselves and the user's tags
// under them.
export const tagsOfKinds = (kinds) => [...kinds, ...tags.list.filter((t) => kinds.includes(t.kind)).map((t) => t.name)];

// Registering and re-ranking are one operation because they are one event: the
// user used this tag. A name that is not in the registry joins it at the front
// with no defaults - which is how a tag that only ever existed in an imported
// chapter.json becomes editable - and a name already in it moves to the front.
// `defaults` is only honoured on the way in; see `updateTag` for why an existing
// entry is never overwritten from here.
export function touchTag(name, defaults = null) {
  const n = normalizeTagName(name);
  if (!n) return null;
  const found = findTag(n);
  const entry = found ?? sanitizeTagEntry({ name: n, style: defaults?.style, size: defaults?.size, minSize: defaults?.minSize, kind: defaults?.kind });
  if (!found) seedSize(n, null, entry.size);
  tags.list = [entry, ...tags.list.filter((t) => t.name !== n)];
  save();
  return entry;
}

// Creating a tag is `touchTag` with the defaults the creation form collected.
// Naming it separately would be a parallel function; naming it at all is worth it
// because the caller's intent - and the failure when the name is already taken -
// is different. An existing name is returned rather than re-defaulted, so the
// create form can never silently overwrite the defaults of a tag the user forgot
// they had.
export function createTag(name, defaults = null) {
  return touchTag(name, defaults);
}

// The whole not-retroactive rule lives here, and it lives here by being absent:
// this writes the registry and nothing else. It never walks the document, because
// a box's style is a value that was copied out of this entry once, at placement,
// and never a reference back into it. So a tag edited today cannot reach a box
// placed yesterday - not by policy, but because there is no path from here to
// that box. See `styleForLine` for the other half.
//
// `null` clears a default back to unset, which is the state that means "fall back
// to whatever the style would have been". `undefined` leaves the field alone.
export function updateTag(name, patch = {}) {
  const t = findTag(normalizeTagName(name));
  if (!t) return null;
  if (patch.style !== undefined) t.style = sanitizeTagStyle(patch.style);
  if (patch.minSize !== undefined) t.minSize = okSize(patch.minSize);
  if (patch.kind !== undefined) {
    const kind = kindFor(t.name, patch.kind);
    if (kind) t.kind = kind;
    else delete t.kind;
  }
  if (patch.size !== undefined) {
    const size = okSize(patch.size);
    seedSize(t.name, t.size, size);
    t.size = size;
  }
  save();
  return t;
}

// What the settings form saves, and the reason it is not `updateTag` with a
// fallback to `createTag`: the picker offers tags the open chapter uses that the
// registry has never seen, and saving settings on one of those has to admit it -
// but admitting it through `touchTag` re-ranked it to slot 1, which is a third
// case in a rule stated as "promote on apply, never on remove". The user was
// configuring a tag, not using it, and the picker reordered under their cursor
// while they did. So a name the registry does not hold joins at the *end*, where
// it changes nobody's first two slots.
export function saveTagDefaults(name, defaults = {}) {
  const n = normalizeTagName(name);
  if (!n) return null;
  if (findTag(n)) return updateTag(n, defaults);
  const entry = sanitizeTagEntry({ name: n, style: defaults.style, size: defaults.size, minSize: defaults.minSize, kind: defaults.kind });
  seedSize(n, null, entry.size);
  tags.list = [...tags.list, entry];
  save();
  return entry;
}

// Renaming is deliberately not offered. A tag's name is the only thing joining an
// entry here to the lines carrying it in every chapter on disk - including the
// ones not open - so a rename would either orphan those lines or need a rewrite
// this app has no way to perform across chapters it has not read.
//
// Deleting is offered, and it is a narrower thing than it looks: it forgets the
// vocabulary entry and nothing else. The lines carrying the name keep carrying
// it, in this chapter and in every chapter on disk; the boxes keep the style
// they were placed with, because that style is a value they own and never a
// reference back here. What actually changes is that the tag stops proposing
// defaults to boxes placed from now on, and stops appearing in the picker -
// except that a chapter still using it puts it back, unconfigured, via
// `knownTags`. All of which the UI has to say out loud, because "delete" is a
// word users read as "and take it off my document".
//
// Returns whether an entry was there to remove.
export function deleteTag(name) {
  const n = normalizeTagName(name);
  if (!n || !findTag(n)) return false;
  tags.list = tags.list.filter((t) => t.name !== n);
  save();
  return true;
}

// ---------- the settings form's two halves ----------
// Seeding the form from an entry, and reading the entry back out of it. One
// round trip, kept here so the queue and Settings cannot disagree about it.
// The form edits only the font and the outline (the first stroke); a style
// saved off a box ("Save as tag style") holds much more, and every other key
// of the patch survives a save untouched - `extra` is how many there are, so
// the form can say so.
//
// The outline switch means "this tag sets the outline", so it is lit by the
// patch holding a stroke list at all, even an empty one (a tag that says "no
// outline"); saving writes the list or removes it.
export function tagFormFields(t) {
  const style = t?.style ?? {};
  const stroke = style.strokeEffects?.[0];
  return {
    outlineOn: Object.hasOwn(style, 'strokeEffects'),
    font: style.font ?? '',
    outline: stroke?.color ?? '#ffffff',
    outlineWidth: stroke?.size ?? (style.strokeEffects?.length === 0 ? 0 : 3),
    // '' is an unset size, shown as an empty field.
    size: t?.size ?? '',
    minSize: t?.minSize ?? '',
    extra: Object.keys(style).filter((k) => k !== 'font' && k !== 'strokeEffects').length,
    // The kind a user's tag sits under; '' for none.
    kind: t?.kind ?? '',
    // The patch the form was opened on, which a save starts from.
    style: $state.snapshot(style),
  };
}

// The patch with only what the form edits left in it: the form's "Clear the
// rest" button, for a tag whose saved box style is no longer wanted.
export const formOnlyStyle = (style) =>
  Object.fromEntries(Object.entries(style ?? {}).filter(([k]) => k === 'font' || k === 'strokeEffects'));

export function tagFormDefaults(f, prevStyle = f.style ?? {}) {
  const style = { ...$state.snapshot(prevStyle ?? {}) };
  if (f.font === '' || f.font == null) delete style.font;
  else style.font = f.font;
  if (f.outlineOn) {
    // The form's one outline is the first stroke; the strokes under it stay.
    const under = (Array.isArray(style.strokeEffects) ? style.strokeEffects : []).slice(1);
    style.strokeEffects = +f.outlineWidth <= 0 ? [] : [...strokesFromBands([{ color: f.outline, width: +f.outlineWidth, opacity: 1 }]), ...under];
  } else delete style.strokeEffects;
  return {
    style: sanitizeTagStyle(style),
    size: f.size === '' || f.size == null ? null : +f.size,
    minSize: f.minSize === '' || f.minSize == null ? null : +f.minSize,
    // A form that never showed a kind leaves it alone.
    ...(f.kind !== undefined ? { kind: f.kind || null } : null),
  };
}

// ---------- tags on a line ----------
// The migration, and it is a read-time one: nothing rewrites a file. A line that
// has never been tagged has no `tags` array, and is read as carrying whatever its
// legacy `line.type` said - so every chapter detection has ever written arrives
// already tagged, with no save, no schema bump and no chance of a load marking a
// document dirty. The array's *presence* is the marker that the user has taken
// over: once they have, an empty array means "no tags", not "fall back to type".
export function lineTags(line) {
  if (!line) return [];
  if (Array.isArray(line.tags)) return line.tags;
  return LEGACY_TAGS.includes(line.type) ? [line.type] : [];
}

export const hasTag = (line, name) => lineTags(line).includes(name);

// Writing tags also projects them back onto `line.type`, because that field is
// still what the JSON and PSD exporters write and what the importer reads, and
// neither of them knows about tags. Left alone, a line the user untagged would
// keep exporting as `sfx` forever. The projection is the first legacy tag in the
// user's own order, so the leftmost tag is the one that speaks for the line
// outside this app.
export function setLineTags(line, names) {
  const out = [];
  for (const raw of names) {
    const n = normalizeTagName(raw);
    if (n && !out.includes(n)) out.push(n);
  }
  line.tags = out;
  line.type = out.find((n) => LEGACY_TAGS.includes(n)) ?? 'dialogue';
  return out;
}

// One click on a picker chip. Applying also promotes the tag in the registry -
// that is what makes the first two slots the two tags the user actually reaches
// for - while removing does not: un-tagging one line is not a statement about how
// often the tag is used, and letting it re-rank would shuffle the picker under
// the user's cursor as they correct a mistake.
export function toggleLineTag(line, name) {
  const n = normalizeTagName(name);
  if (!n) return lineTags(line);
  const cur = lineTags(line);
  if (cur.includes(n)) return setLineTags(line, cur.filter((x) => x !== n));
  const next = setLineTags(line, [...cur, n]);
  touchTag(n);
  return next;
}

// ---------- surviving a re-import ----------
// A translations file describes `{ n, jp, en, type }` and nothing else - the
// importer has never had a `tags` field to read, and re-importing replaces a
// page's lines wholesale. So re-running a corrected translation over a chapter
// that had been tagged by hand threw every hand-applied tag away while leaving
// the boxes exactly where they were: `sfx` and `narration` came back through
// `type`, and anything the user had invented was gone with no warning.
//
// This carries them across, joined by line number, which is the same join the
// placed boxes already use (`box.lineN`). The rule is the one `lineTags` already
// states: the presence of a `tags` array is the marker that the user has taken
// over that line, so where it is present it wins outright and the incoming
// `type` does not get a vote. A line the user never touched has no array and
// takes whatever the file says, exactly as before.
//
// Written through `setLineTags` so the restored tags also re-project onto
// `type`; otherwise a restored line would carry `tags: ['sfx']` under the
// incoming `type: 'dialogue'` and the exporters, which still read `type`, would
// disagree with the queue about the same line.
//
// Precedence, in full: an incoming line that carries its own `tags` array wins -
// the file said something explicit and a file the user chose to import is a
// statement. Failing that, the previous page's array carries forward. Failing
// both, the incoming `type` speaks, which is the pre-tag behaviour unchanged.
//
// It also keeps the page's free-typed lines - the ones a box made with the Text
// tool brought into existence, numbered below zero (see `isFreeLine` in
// store.svelte.js). A translations file describes the translator's lines and
// says nothing whatever about these, so the wholesale replacement would take
// them out, and the cost is not a tag: it is the *text*, which is where a free
// box's text lives, plus the box's only queue row. The user would be left with a
// box on the page rendering nothing, no row to type into, and no way back short
// of re-importing the old file. They are appended after the incoming lines, in
// their own order, which is where they already sit in the queue - free lines are
// pushed on the end as they are made, so a re-import does not shuffle the panel.
//
// A number the incoming file already claims is left to the file. It cannot
// happen from any producer this app has met (translators number from 1) and if
// it does, two lines answering to one number is the one outcome nothing
// downstream survives - `lineByN` would hand the box whichever came first.
//
// The speaker (TXT-6) is carried the same way and for the same reason: a file
// that names no speaker for a line says nothing about who speaks it, so the
// one the user picked stays; a file that names one wins.
export function carryTagsForward(prevLines = [], nextLines = []) {
  const kept = new Map();
  const speakers = new Map();
  for (const l of prevLines) {
    if (l && Array.isArray(l.tags)) kept.set(l.n, l.tags);
    if (l && typeof l.speaker === 'string') speakers.set(l.n, l.speaker);
  }
  const out = nextLines.map((l) => {
    const speaker = l.speaker == null && l.speakerName == null ? speakers.get(l.n) : undefined;
    const tags = Array.isArray(l.tags) ? null : kept.get(l.n);
    if (!tags && speaker === undefined) return l;
    const copy = { ...l };
    if (tags) setLineTags(copy, tags);
    if (speaker !== undefined) copy.speaker = speaker;
    return copy;
  });
  const taken = new Set(nextLines.map((l) => l?.n));
  for (const l of prevLines) {
    if (l && Number.isFinite(l.n) && l.n < 0 && !taken.has(l.n)) out.push({ ...l });
  }
  return out;
}

// ---------- defaults reaching a box ----------
// Called by `placeActiveAt` when a box is made, and by the restyles that put a
// box back to what its tags say (a tag chip, "Reset to tag style", "Apply tag
// style to chapter"). What comes back is a plain style value the box then owns
// outright, which is why editing the tag later cannot touch it.
//
// The leftmost tag wins, key by key: a later tag only fills keys the earlier
// ones left unset, so the first tag on a line is its primary one and adding a
// second cannot quietly restyle it. A nested group - the stroke list, the
// shadows, a gradient - is one key and replaces the box's value whole: a tag
// that defines the outline defines THE outline, it is not added to the box's.
// A key no tag defines keeps the box's value, so a tag with an empty patch
// changes nothing. Values are snapshots, never the registry's proxies.
export function styleForLine(line, base) {
  const out = { ...base };
  const done = new Set();
  for (const name of lineTags(line)) {
    const t = findTag(name);
    if (!t) continue;
    for (const k of TAG_STYLE_KEYS) {
      if (done.has(k) || !Object.hasOwn(t.style, k)) continue;
      out[k] = $state.snapshot(t.style[k]);
      done.add(k);
    }
  }
  return out;
}

// ---------- picker + bulk-editor surface ----------
// Everything below takes the pages it should look at rather than reaching for the
// open document, which is also how scope is expressed: the whole chapter is
// `app.pages`, the current page is `[page()]`. A scope enum would have been a
// second vocabulary for something the caller can already say by choosing an
// array, and it would have had to be threaded through every one of these.

// Every tag name actually carried by a line in `pages`, first-seen order (page
// order, then line order). This is the list the bulk editor's tag selector shows:
// tags in use in this chapter, not the user's whole vocabulary.
export function tagsInUse(pages = []) {
  const out = [];
  for (const p of pages) {
    for (const l of p?.lines ?? []) {
      for (const t of lineTags(l)) if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

// What the picker offers: the registry in recency order, then any tag the open
// chapter uses that the registry has never heard of, as an unconfigured entry.
// The second half is what stops a freshly imported chapter full of `sfx` from
// presenting an empty picker - those tags exist, the user just has not applied
// one by hand yet.
export function knownTags(pages = []) {
  const out = tags.list.map((t) => ({ ...t }));
  for (const name of tagsInUse(pages)) {
    if (!out.some((t) => t.name === name)) out.push({ name, style: {}, size: null, minSize: null });
  }
  return out;
}

// The picker's first four slots.
export const recentTags = (pages = []) => knownTags(pages).slice(0, 4);

// Every box carrying `name` within `pages`. The boxes come back live - the same
// objects the document holds, not snapshots - because the caller's whole purpose
// is to write styles onto them and record one history entry for the lot. The page
// and line ride along so a caller can address the box by page id without going
// looking for it again.
//
// A box with no line at all (`lineN == null`) is never returned, and there is
// exactly one kind left: a free-typed box saved to disk before free-typed boxes
// joined the queue, which `loadProjectPages` deliberately does not migrate. It
// has no line, tags live on lines, so it cannot be tagged and cannot be reached
// by a tag-scoped bulk edit.
//
// A box typed onto the canvas *today* has a line - a negative-numbered one it
// created (see `addEmptyBox`) - and is returned like any other. That is the
// whole point of giving it one: "everything is taggable" is a claim about this
// function, and it used to be false for every box the Text tool made.
export function boxesWithTag(name, pages = []) {
  const n = normalizeTagName(name);
  const out = [];
  if (!n) return out;
  for (const p of pages) {
    // A page's lines by number, built once per page rather than a `.find` per
    // box - a chapter of hundreds of placed boxes made that O(boxes × lines)
    // for the same answer, since line numbers are unique within a page.
    const byN = new Map();
    for (const l of p?.lines ?? []) if (l && !byN.has(l.n)) byN.set(l.n, l);
    for (const b of p?.boxes ?? []) {
      if (b.lineN == null) continue;
      const line = byN.get(b.lineN);
      if (line && hasTag(line, n)) out.push({ page: p, line, box: b });
    }
  }
  return out;
}
