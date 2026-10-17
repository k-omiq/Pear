// ===== font_sheet: see fonts before choosing them =====
// A font name says little of how it looks. This draws the fonts the agent
// names, or the ones whose names match, as one picture: each its number and
// exact name in a plain face over a sample set in the font itself, so the
// model can pick thin or blocky, sharp or brushed, neat or handwritten by eye
// and then use the exact name in style.font.
//
// Read-only. The fonts come from the same lists every other tool reads
// (`allFonts`: user, built-in, then system, the renderer's own priority), and
// each is drawn in the CSS family the app draws it in. One picture a call, at
// most FONT_SHEET_MAX fonts; `offset` pages through more.

import { defineTool, ToolError, nearest } from '../registry.js';
import { renderFontSheet, FONT_SHEET_MAX } from '../render.js';
import { allFonts, fontByName, fontCssFor, fontMissing } from '../../store.svelte.js';

export const DEFAULT_SAMPLE = 'WHAT IS THIS?! Sorcery... BOOM';
export const MAX_SAMPLE = 60;

const input = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fonts: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: FONT_SHEET_MAX, description: `exact family names (case does not matter), at most ${FONT_SHEET_MAX}.` },
    match: { type: 'string', description: 'show the fonts whose names contain this (case-insensitive). Give fonts or match, not both; neither is every font.' },
    text: { type: 'string', description: `the sample, one line, at most ${MAX_SAMPLE} characters; default "${DEFAULT_SAMPLE}". Try the line you mean to set.` },
    offset: { type: 'integer', minimum: 0, description: `skip this many of the matched fonts (pages of ${FONT_SHEET_MAX}).` },
  },
};

// The sample as one line: whitespace runs to one space, cut to MAX_SAMPLE.
export function sampleText(text) {
  if (text == null) return DEFAULT_SAMPLE;
  const t = String(text).replace(/\s+/g, ' ').trim().slice(0, MAX_SAMPLE);
  return t || DEFAULT_SAMPLE;
}

// Each asked-for name as the font lists spell it. Throws on the first name no
// list has, with the nearest names.
export function resolveFonts(asked, names) {
  const out = [];
  for (const raw of asked) {
    const want = String(raw).trim();
    const hit = names.find((n) => n === want) ?? names.find((n) => n.toLowerCase() === want.toLowerCase());
    if (!hit) {
      throw new ToolError(`no font "${want}"`, `close: ${nearest(want, names).join(', ') || '(none)'}. The fonts tool lists exact names; match finds them by part of the name.`);
    }
    if (!out.includes(hit)) out.push(hit);
  }
  return out;
}

export const fontSheetTool = defineTool({
  name: 'font_sheet',
  description:
    'See fonts before choosing them: thin, sharp, blocky, brush, handwritten... One picture of up to ' +
    `${FONT_SHEET_MAX} fonts, each its number and exact name over a sample set in that font. ` +
    'fonts names the families to compare; match shows the families whose names contain it; neither pages through every font (user fonts first), ' +
    `${FONT_SHEET_MAX} at a time with offset. text is the sample (try the real line). Use the exact name shown in style.font.`,
  input,
  write: false,
  async run(args) {
    const { fonts, match, text, offset = 0 } = args;
    if (fonts != null && match != null) throw new ToolError('give fonts or match, not both');
    if (fonts != null && !(Array.isArray(fonts) && fonts.length && fonts.every((f) => typeof f === 'string'))) {
      throw new ToolError('fonts must be a list of family names', 'e.g. fonts: ["Bangers", "Anime Ace"]');
    }
    if (fonts != null && fonts.length > FONT_SHEET_MAX) throw new ToolError(`at most ${FONT_SHEET_MAX} fonts a sheet`, 'split them over two calls');
    if (match != null && typeof match !== 'string') throw new ToolError('match must be a string');
    if (text != null && typeof text !== 'string') throw new ToolError('text must be a string');
    if (!(Number.isInteger(offset) && offset >= 0)) throw new ToolError('offset must be a whole number, 0 or more');

    const names = [...new Set(allFonts().map((f) => f.name))];
    if (!names.length) throw new ToolError('no fonts are loaded yet', 'try again in a moment');
    let picked;
    let what;
    if (fonts != null) {
      picked = resolveFonts(fonts, names);
      what = 'asked for';
    } else if (match != null && match.trim()) {
      const q = match.trim().toLowerCase();
      picked = names.filter((n) => n.toLowerCase().includes(q));
      if (!picked.length) throw new ToolError(`no font name contains "${match.trim()}"`, `close: ${nearest(match.trim(), names).join(', ')}.`);
      what = `match "${match.trim()}"`;
    } else {
      picked = names;
      what = 'available';
    }
    if (offset && offset >= picked.length) {
      throw new ToolError(`offset ${offset} is past the ${picked.length} font${picked.length === 1 ? '' : 's'}`, `use 0 to ${picked.length - 1}`);
    }

    const shown = picked.slice(offset, offset + FONT_SHEET_MAX);
    const entries = shown.map((name, i) => ({
      n: offset + i + 1,
      name,
      css: fontByName(name)?.css ?? fontCssFor(name),
      missing: fontMissing(name),
    }));
    const sheet = await renderFontSheet(entries, { text: sampleText(text) });
    const last = offset + shown.length;
    const more = picked.length - last;
    return {
      images: [{ png: sheet.png, mime: sheet.mime, width: sheet.width, height: sheet.height }],
      legend: sheet.cells.map((c, i) => ({ n: c.n, name: c.name, row: c.row, col: c.col, ...(entries[i].missing ? { missing: true } : null) })),
      note:
        `${picked.length} font${picked.length === 1 ? '' : 's'} ${what}; ${shown.length} shown, numbered ${offset + 1}-${last}` +
        (more > 0 ? `; ${more} more: ask again with offset ${last}.` : '.') +
        ' Each cell: the number and exact name, then the sample in that font (regular face). A font marked missing has no face on this machine and is drawn in a fallback.',
    };
  },
});
