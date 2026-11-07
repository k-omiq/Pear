// ===== The series' lettering style =====
// How a series is lettered: which font each kind of text gets, whether each
// character has a voice of their own, and how much freedom an AI letterer has
// past that. Asked once per series - by the AI before its first run, or filled
// in by hand in Settings ▸ Project ▸ Lettering - and kept with the series, so
// every chapter and every run letters the same way.
//
// Only the freedom and the free notes are stored here (in project.json, inside
// the series guide). The fonts are not: a role is a tag with a well-known name,
// and its font is that tag's font, in the tag registry beside the guide. That
// is what makes an answer do something - a box placed from a line tagged
// `narration` already takes the narration tag's style (`styleForLine`), and an
// AI that decides a box is a thin sharp SFX re-tags its line `sfx-sharp` and
// gets that font. A character's voice is the same mechanism once more: the
// character's glossary term names a tag (TXT-6), and that tag holds the font.
//
// Pure: no store, no registry. The tool and the Settings section join this to
// the tags and the glossary.

// Each kind of text the setup asks about, in the order it asks. `tag` is the
// tag that carries the role's look; `label` names it in Settings and in the
// AI's question; `hint` says which text it is, plainly enough for a person who
// has never heard the word "role". The first five are the tags translation
// already writes, so a chapter tagged during translation needs nothing more.
export const LETTERING_ROLES = [
  { tag: 'speech', label: 'Main speech', hint: 'ordinary dialogue in balloons' },
  { tag: 'narration', label: 'Narration', hint: 'captions and narration boxes' },
  { tag: 'thought', label: 'Thoughts', hint: 'inner voice: thought bubbles, inner monologue' },
  { tag: 'shout', label: 'Shouts', hint: 'raised voices in spiky balloons' },
  { tag: 'scream', label: 'Screams', hint: 'screams and wails, the loudest voice' },
  { tag: 'side', label: 'Side text', hint: 'small text outside balloons: asides, mutters, labels' },
  { tag: 'sfx', label: 'SFX', hint: 'ordinary sound effects drawn on the art' },
  { tag: 'sfx-sharp', label: 'Thin sharp SFX', hint: 'glints, shines, swishes, twitches: thin, fast strokes' },
  { tag: 'sfx-soft', label: 'Soft SFX', hint: 'cute, bouncy or gentle sounds' },
  { tag: 'blocky', label: 'Blocky text', hint: 'heavy block letters: impact words, signs, emphasis captions' },
  { tag: 'title', label: 'Titles', hint: 'chapter titles, credits, name cards' },
  { tag: 'note', label: 'Translator notes', hint: 'small notes at the page edge' },
];

export const ROLE_TAGS = LETTERING_ROLES.map((r) => r.tag);

// The roles that are a way of speaking rather than a kind of text: a line in
// one of these keeps its speaker's voice (their font), with the role adding
// only what the voice leaves unset - a shout's bold, say. Any other role
// (narration, an SFX, a title) is the text's own and beats the voice.
export const VOICE_ROLES = ['speech', 'thought', 'shout', 'scream'];
export const roleByTag = (tag) => LETTERING_ROLES.find((r) => r.tag === tag) ?? null;

// The roles drawn to the size of the art they sit on - a sound effect over its
// original, a title on its logo - rather than to a reading size the boxes of
// one kind should share. Their size is never an outlier. The sounds first.
export const SFX_ROLES = ['sfx', 'sfx-sharp', 'sfx-soft'];
export const ART_SIZED_ROLES = [...SFX_ROLES, 'blocky', 'title'];

// How far an AI letterer may go past what the series set. `null` - the state
// of every series before it was asked - is "not set up yet", and is what tells
// the AI to ask before it letters anything.
export const FREEDOMS = ['strict', 'balanced', 'free'];
export const FREEDOM_TEXT = {
  strict: 'Only the fonts and looks set here. Turns text with the art and fits it, nothing else. Asks before anything new.',
  balanced: 'The fonts set here, plus the craft: SFX coloured and turned to match the art, white text in dark balloons, stacked screams, and a font of its own choosing for a kind of text left open (saved here, so it stays).',
  free: 'All of balanced, and also other fonts for one-off moments, warps, text on paths, gradients and textures, and dramatic lines broken into word boxes.',
};

const MAX_NOTES = 4000;

export const emptyLettering = () => ({ freedom: null, notes: '' });

// A stored lettering record, or anything else. Absent - every project.json
// written before it existed - is the empty record, "not set up yet".
export function sanitizeLettering(raw) {
  const out = emptyLettering();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (FREEDOMS.includes(raw.freedom)) out.freedom = raw.freedom;
  if (typeof raw.notes === 'string') out.notes = raw.notes.slice(0, MAX_NOTES);
  return out;
}

export const letteringSetUp = (l) => FREEDOMS.includes(l?.freedom);

// The fonts boxes already use, per line tag, most used first: what a person
// lettering this series by hand chose, read off the open chapter, so the AI's
// setup questions can offer it as the answer. `rows` are `{ tags, font }`, one
// per box; a box with no tag counts under ''.
export function fontsByTag(rows) {
  const by = new Map();
  for (const { tags, font } of rows) {
    if (!font) continue;
    for (const t of tags?.length ? tags : ['']) {
      const m = by.get(t) ?? new Map();
      m.set(font, (m.get(font) ?? 0) + 1);
      by.set(t, m);
    }
  }
  return Object.fromEntries([...by].map(([t, m]) => [t, [...m].sort((a, b) => b[1] - a[1]).map(([font, boxes]) => ({ font, boxes }))]));
}
