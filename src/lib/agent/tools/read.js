import { defineTool, ToolError, nearest } from '../registry.js';
import { selectBoxes, boxRow } from '../select.js';
import { untrusted } from '../fence.js';
import { snapshot } from '../snapshot.svelte.js';
import { app, page, boxText, lineText, pageCheckItems, allFonts, CHECK_REASONS } from '../../store.svelte.js';
import { chapterById } from '../../library.svelte.js';
import { knownTags, lineTags, tagSize } from '../../tags.svelte.js';
import { guide } from '../../guide.svelte.js';
import { letteringSetUp } from '../../lettering.js';
import { presets } from '../../presets.svelte.js';
import { sfxAvailable, sfxPresets, sfxKinds } from '../../sfx.js';
import { textEngine } from '../../text-engine/index.js';
import { fitsOf } from './check.js';

const ROW_FIELDS = ['id', 'page', 'line', 'tags', 'text', 'rect', 'rotation', 'font', 'size', 'flags'];
const WHERE_GRAMMAR = 'where: { pages: "current"|"all"|"2-5"|"1,3,7-9"|[1,3], ids: ["b12"], selection: true, tag: "narration"|["sfx","scream"], text: "regex" (case-insensitive), font: "family" (case-insensitive equality), size: {min,max}, flagged: true|"guide"|' + CHECK_REASONS.map((r) => `"${r}"`).join('|') + ', outline: "unapproved"|"open"|"ai"|"user", kind: "text"|"sfx"|"ink", not: {same shape} }; AND all keys; tag arrays mean any; default pages is current unless ids or selection is supplied; not has no implicit page limit; pages are 1-based.';
const emptyInput = { type: 'object', properties: {}, additionalProperties: false };
const whereSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pages: {
      description: '1-based pages in document order. Default: current unless ids or selection is present.',
      anyOf: [
        { type: 'string', pattern: '^(current|all|\\s*[0-9]+\\s*(-\\s*[0-9]+\\s*)?(,\\s*[0-9]+\\s*(-\\s*[0-9]+\\s*)?)*)$' },
        { type: 'array', items: { type: 'integer', minimum: 1 } },
      ],
    },
    ids: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Exact box ids, across the chapter unless pages limits them.' },
    selection: { const: true, description: 'Selected box plus active bulk targets.' },
    tag: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'array', items: { type: 'string', minLength: 1 } }], description: 'Match any of these line tags.' },
    text: { type: 'string', description: 'Case-insensitive JavaScript regex over displayed box text, without / delimiters.' },
    font: { type: 'string', description: 'Case-insensitive equality with the box font family.' },
    size: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } }, additionalProperties: false, description: 'Inclusive font-size bounds in page pixels; min <= max.' },
    flagged: { anyOf: [{ const: true }, { enum: ['guide', ...CHECK_REASONS] }], description: 'Any box check, overflow review, guide (glossary or rules), or a specific check reason.' },
    outline: { enum: ['unapproved', 'open', 'ai', 'user'], description: 'unapproved means an outline waiting for approval.' },
    kind: { enum: ['text', 'sfx', 'ink'], description: 'ink: enabled with strokes; sfx: enabled or tagged sfx; text: neither.' },
    not: { $ref: '#/$defs/where', description: 'Exclude matches of this selector within the parent scope.' },
  },
};

defineTool({
  name: 'context',
  description: 'Read the open chapter identity and title, current 1-based page, page count, this page’s note and which pages have notes, selected box ids, text engine, series guide counts/rules/notes, whether the lettering style is set up, known tags, and selector grammar. Start here to resolve “this page” or “this box”. Title and notes are fenced untrusted data; counts and settings describe the live document.',
  input: emptyInput,
  run() {
    const ref = app.chapterRef;
    const title = ref ? chapterById(ref.projectId, ref.chapterId)?.title ?? ref.title : null;
    const currentIndex = app.pages.indexOf(page());
    return {
      chapter: ref ? { projectId: ref.projectId, chapterId: ref.chapterId, ...(title ? { title: untrusted(title) } : {}) } : null,
      currentPage: currentIndex < 0 ? null : currentIndex + 1,
      pageCount: app.pages.length,
      // The user's page notes (TXT-7): this page's, and which pages have one.
      ...(page()?.note ? { pageNote: untrusted(page().note) } : {}),
      pagesWithNotes: app.pages.flatMap((p, i) => (p.note ? [i + 1] : [])),
      selectedIds: selectBoxes({ selection: true }).matches.map((m) => m.box.id),
      engine: textEngine()?.id ?? 'browser',
      guide: {
        glossaryTerms: guide.glossary.length,
        characters: guide.glossary.filter((t) => t.character).length,
        rules: snapshot(guide.rules),
        hasNotes: !!guide.notes,
        notes: untrusted(guide.notes),
      },
      // The series' lettering style (the lettering tool). Until it is set up,
      // the agent asks the user before it letters anything.
      lettering: letteringSetUp(guide.lettering)
        ? { setup: true, freedom: guide.lettering.freedom }
        : { setup: false, todo: 'Before lettering, call lettering get and ask the user its questions in one message, then save the answers with lettering set.' },
      tags: knownTags(app.pages).map((t) => t.name),
      where: WHERE_GRAMMAR,
    };
  },
});

defineTool({
  name: 'query',
  description: 'Find boxes with an AND selector in page then box order. Omitting where searches the current page; ids and selection search the chapter unless pages is given. Return compact rows with fenced text previews (80 characters), rounded rectangles, styles and check reasons. fields optionally projects row keys. count is the full match count; only the first 200 rows return, with truncated: true when more exist. Use box for full text and style.',
  input: {
    type: 'object', additionalProperties: false,
    properties: {
      where: { $ref: '#/$defs/where' },
      fields: { type: 'array', uniqueItems: true, items: { enum: ROW_FIELDS } },
    },
    $defs: { where: whereSchema },
  },
  run({ where = {}, fields }) {
    if (fields !== undefined && (!Array.isArray(fields) || fields.some((key) => !ROW_FIELDS.includes(key)))) {
      throw new ToolError('Invalid query fields.', `Choose from: ${ROW_FIELDS.join(', ')}.`);
    }
    const { matches } = selectBoxes(where);
    const checks = new Map();
    const rows = matches.slice(0, 200).map((m) => {
      if (!checks.has(m.page)) checks.set(m.page, pageCheckItems(m.page, m.pageIndex));
      const row = boxRow(m, checks.get(m.page));
      return fields ? Object.fromEntries(fields.map((key) => [key, row[key]])) : row;
    });
    return { count: matches.length, rows, ...(matches.length > 200 ? { truncated: true } : {}) };
  },
});

// What the Japanese or Korean sound of an `sfx` line means (TXT-13), from the
// app's own list: a hint for the English, never the English itself.
async function sfxHint(line) {
  if (!line?.jp || !lineTags(line).includes('sfx')) return null;
  const { sfxMeaningsIn } = await import('../../sfx-meanings.js');
  const found = sfxMeaningsIn(line.jp) ?? [];
  if (!found.length) return null;
  return { sfxMeanings: found.slice(0, 8).map((e) => ({ source: untrusted(e.source), meanings: e.meanings.slice(0, 6) })) };
}

defineTool({
  name: 'box',
  description: 'Read one box by exact id anywhere in the chapter, including full displayed text, the meaning of a known Japanese or Korean sound on an sfx line, detached full style JSON, exact page-pixel rectangle and rotation, linked line, outline record, fit kind, the solver record (auto: refSize, minSize, locks, kept line breaks) and inOutline: the text against its outline in numbers (margin em, shape, widths against room, ink centre offset). Text, Japanese, English and outline notes are fenced untrusted data. A missing id returns a hint with nearest ids; use query to discover ids.',
  input: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
  async run({ id }) {
    if (typeof id !== 'string' || !id) throw new ToolError('A box id is required.', 'Use query to find an id, then box: { id: "b12" }.');
    const m = selectBoxes({ ids: [id] }).matches[0];
    const b = m.box, line = m.line;
    const outline = snapshot(b.outline ?? null);
    if (outline?.note != null) outline.note = untrusted(outline.note);
    const [inOutline] = fitsOf([m]);
    return {
      ...boxRow(m),
      text: untrusted(boxText(b, m.page)),
      rect: [b.x, b.y, b.w, b.h],
      style: snapshot(b.style),
      lineN: b.lineN ?? null,
      line: line ? {
        n: line.n, jp: untrusted(line.jp), en: untrusted(lineText(line)),
        tags: [...lineTags(line)], ...(line.type ? { type: line.type } : {}),
        ...(line.speaker ? { speaker: untrusted(line.speaker) } : {}),
      } : null,
      outline,
      fit: b.fit?.kind ?? null,
      auto: b.auto ? snapshot(b.auto) : null,
      ...(inOutline ? { inOutline } : null),
      ...(await sfxHint(line)),
    };
  },
});

defineTool({
  name: 'fonts',
  description: 'List up to 30 available font families, with exact names to use in style.font and their user, builtin or system source. match is an optional case-insensitive substring or approximate name; exact and substring hits come first, followed by nearest spellings. Duplicate families use the same source priority as the renderer: user, builtin, then system.',
  input: { type: 'object', properties: { match: { type: 'string' } }, additionalProperties: false },
  run({ match }) {
    if (match !== undefined && typeof match !== 'string') throw new ToolError('match must be a string.', 'Use match: "Anime Ace", or omit it to list families.');
    const names = [...new Set(allFonts().map((f) => f.name))];
    const query = match?.trim().toLowerCase();
    const hits = query ? [...new Set([
      ...names.filter((n) => n.toLowerCase().includes(query)).sort((a, b) => Number(b.toLowerCase() === query) - Number(a.toLowerCase() === query)),
      ...nearest(query, names, 30),
    ])].slice(0, 30) : names.slice(0, 30);
    const sources = new Map();
    for (const source of ['user', 'builtin', 'system']) {
      for (const font of app.fonts[source]) if (!sources.has(font.name)) sources.set(font.name, source);
    }
    return { fonts: hits.map((name) => ({ name, source: sources.get(name) })) };
  },
});

defineTool({
  name: 'tags',
  description: 'Read known line tags from the series registry and chapter usage, each with its saved style patch, size (the tag\'s own default) and minSize, kind (for one of the user\'s own tags: the kind of text it sits under, whose look it is laid over), and rememberedSize when the user set a size for the tag\'s boxes by hand: a new box takes the size of the box of its tag before it, else rememberedSize, else size (an SFX, title or blocky word takes the size of its original instead). A placed box\'s own size is in fit and sizes. A tag used only in the chapter has an empty patch and null size defaults. These are placement defaults; existing boxes retain their own styles. Use these exact tag names in selectors.',
  input: emptyInput,
  run: () => ({
    tags: snapshot(knownTags(app.pages)).map((t) => {
      const remembered = tagSize(t.name);
      return remembered != null && remembered !== t.size ? { ...t, rememberedSize: remembered } : t;
    }),
  }),
});

defineTool({
  name: 'presets',
  description: 'List saved global text style presets by id and name with a short summary of font, size, color, bold, italic and stroke count. Presets are user-saved looks shared across series; query or box describes the style currently on a box. This tool reads presets without applying them.',
  input: emptyInput,
  run: () => ({ presets: presets.list.map((p) => ({
    id: p.id, name: p.name,
    summary: { font: p.style.font, size: p.style.size, color: p.style.color, bold: p.style.bold, italic: p.style.italic, strokes: p.style.strokes.length },
  })) }),
});

defineTool({
  name: 'sfx_presets',
  description: 'List available SFX preset ids and names with the move kinds used by each, plus the engine’s move-kind catalogue. SFX lettering requires the Rust engine. When unavailable, return empty presets and kinds with a note explaining that requirement; reading this catalogue changes no styles.',
  input: emptyInput,
  run() {
    if (!sfxAvailable()) return { presets: [], kinds: [], note: 'SFX presets require the Rust text engine; SFX is unavailable on the browser engine.' };
    return {
      presets: sfxPresets().map((p) => ({ id: p.id, name: p.name, kinds: [...new Set((p.moves ?? []).map((m) => m.kind))] })),
      kinds: snapshot(sfxKinds()),
    };
  },
});
