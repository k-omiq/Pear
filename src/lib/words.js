// The nouns the interface uses for the things a person works on, by what they
// said they use the app for. Comics say Series and Chapter; general use says
// Project and Document. This is a lookup of a few words, not a translation
// layer: there is one language, and a string with more in it than a noun stays
// in the component that owns it.
import { isComics } from './prefs.svelte.js';

const WORDS = {
  series: ['Series', 'Project'],
  seriesName: ['Series name', 'Project name'],
  chapter: ['Chapter', 'Document'],
  chapters: ['Chapters', 'Documents'],
  newChapter: ['New chapter', 'New document'],
  rawPages: ['Raw pages', 'Images'],
};

// Read through `isComics`, so a template that calls this follows the
// preference. An unknown key throws: a typo should fail loudly in a test, not
// print "undefined" in the interface.
export function word(key) {
  const pair = Object.hasOwn(WORDS, key) ? WORDS[key] : null;
  if (!pair) throw new Error(`Unknown word key: ${key}`);
  return isComics() ? pair[0] : pair[1];
}
