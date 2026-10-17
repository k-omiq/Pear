// ===== Writing a lettering answer =====
// Where each answer of the lettering setup (lettering.js) goes, for the two
// places that write one: Settings ▸ Project ▸ Lettering and the AI's
// `lettering` tool. A role's font is its tag's font; a character's font is
// the font of the tag the character names, made for them (`voice-<name>`) the
// first time. Only the font key of a tag is touched: whatever else a tag's
// look holds (italic narration, a white outline on SFX) stays.

import { findTag, saveTagDefaults, normalizeTagName, MAX_TAG_LEN } from './tags.svelte.js';
import { guide, updateTerm } from './guide.svelte.js';

export const tagFont = (tag) => (tag ? (findTag(tag)?.style?.font ?? null) : null);

// `font` on the tag `tag`, or the font taken off it when null. A tag that does
// not exist is made only to hold a font.
export function setTagFont(tag, font) {
  if (font == null && !findTag(tag)) return;
  const style = { ...(findTag(tag)?.style ?? {}) };
  if (font == null) delete style.font;
  else style.font = font;
  saveTagDefaults(tag, { style });
}

// The tag a character's boxes take their style from: the one they name, else
// a new name for them that no other character names - two characters called
// the same, or alike past the name cap, would otherwise share one font.
export function voiceTagFor(term) {
  if (term.tag) return term.tag;
  const slug = String(term.target || term.source || term.id).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  const base = normalizeTagName(`voice-${slug || term.id}`);
  const taken = (name) => guide.glossary.some((t) => t.id !== term.id && t.tag === name);
  let name = base;
  for (let n = 2; taken(name); n++) name = normalizeTagName(`${base.slice(0, MAX_TAG_LEN - String(n).length - 1)}-${n}`);
  return name;
}

// A character's font. Linking the voice tag is the one change made to the
// character's term: a locked term keeps its name and spelling, which is what
// the lock protects.
export function setVoiceFont(term, font) {
  const tag = voiceTagFor(term);
  if (font == null && !findTag(tag)) return;
  setTagFont(tag, font);
  if (!term.tag) updateTerm(term.id, { tag });
}
