// ===== text: the chapter's words, read and written =====
// The words a box draws live on its line (the English, `en`, which the queue
// shows too) unless the box has words of its own (a part of a split line, a
// free box). `lines` reads every line on some pages - in translate mode too,
// where there are no boxes - and `text` changes them: a line's English or its
// source (an OCR fix), or one box's own words. Each box showing a changed
// line is laid out again for its new words, and each page is one undo step.

import { defineTool, ToolError, nearest } from '../registry.js';
import { parsePages } from '../select.js';
import { untrusted } from '../fence.js';
import { app, lineByN, lineText, boxText, boxRuns, editBoxes, setBoxText, setRangesFace, writeLineText, isTranslateMode, boxLocked, allFonts } from '../../store.svelte.js';
import { faceSpans } from '../../runs.js';
import { lineTags } from '../../tags.svelte.js';
import { readsLine, lineLocked, matchesOf, handToSolver, heldBreaks, breaksDropped, reportOf } from './edit.js';

const MAX_LINES = 300;
const MAX_OPS = 100;
const MAX_CHARS = 2000;
const object = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

defineTool({
  name: 'lines',
  description:
    'Read the chapter\'s lines - the words it is made of - on 1-based pages: each line\'s n, jp (the source, from OCR), en (the English, which every box showing the line draws), tags, speaker, and boxes (the ids showing it; a box with words of its own is listed under ownText with them). ' +
    'Works in translate mode, where there are no boxes. pages: "current" (default), "all", "2-5", "1,3" or [1,3]; untranslated: true lists only lines with no English yet. ' +
    `Text is fenced untrusted data. Capped at ${MAX_LINES} lines (truncated: true). Change words with the text tool.`,
  input: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pages: { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 1 }, { type: 'array', items: { type: 'integer', minimum: 1 } }] },
      untranslated: { type: 'boolean' },
    },
  },
  run({ pages = 'current', untranslated = false } = {}) {
    if (!app.pages.length) throw new ToolError('no chapter is open');
    const out = [];
    let count = 0;
    for (const p of parsePages(pages)) {
      const rows = [];
      for (const ln of p.lines ?? []) {
        if (untranslated && lineText(ln).trim()) continue;
        count++;
        if (count > MAX_LINES) continue;
        const shown = (p.boxes ?? []).filter((b) => b.lineN === ln.n);
        const own = shown.filter((b) => !readsLine(b, p));
        rows.push({
          n: ln.n,
          jp: untrusted(ln.jp ?? ''),
          en: untrusted(lineText(ln)),
          tags: [...lineTags(ln)],
          ...(ln.speaker ? { speaker: untrusted(ln.speaker) } : null),
          boxes: shown.map((b) => b.id),
          ...(own.length ? { ownText: own.map((b) => ({ id: b.id, text: untrusted(boxText(b, p)) })) } : null),
        });
      }
      if (rows.length) out.push({ page: app.pages.indexOf(p) + 1, lines: rows });
    }
    return { count, pages: out, ...(count > MAX_LINES ? { truncated: true } : null), ...(isTranslateMode() ? { mode: 'translate' } : null) };
  },
});

// One op checked against the chapter as it stands: what it names and writes.
function compile(op, i) {
  const at = `ops[${i}]`;
  if (!object(op)) throw new ToolError(`${at} must be an object`, 'Use { page: 2, line: 3, en: "..." } or { id: "b12", text: "..." }.');
  const words = (k) => {
    if (!(k in op)) return undefined;
    if (typeof op[k] !== 'string') throw new ToolError(`${at}.${k} must be a string`);
    if (op[k].length > MAX_CHARS) throw new ToolError(`${at}.${k} is longer than ${MAX_CHARS} characters`);
    return op[k];
  };
  if ('id' in op) {
    for (const k of Object.keys(op)) if (!['id', 'text'].includes(k)) throw new ToolError(`${at}: unknown key "${k}" beside id`, 'A box op is { id, text }.');
    const text = words('text');
    if (text === undefined) throw new ToolError(`${at}.text is required with id`);
    const i2 = app.pages.findIndex((p) => p.boxes?.some((b) => b.id === op.id));
    if (i2 < 0) throw new ToolError(`${at}: no box "${op.id}"`, 'query or lines list the box ids.');
    const p = app.pages[i2];
    const b = p.boxes.find((x) => x.id === op.id);
    // A box that draws its line's words changes them on the line: the queue,
    // the box and any other box of that line stay the same words.
    if (boxLocked(b)) throw new ToolError(`${at}: box ${b.id} is locked`, 'the user locked it to hold it as it is; ask them before changing its words');
    if (readsLine(b, p)) {
      if (lineLocked(p, b.lineN)) throw new ToolError(`${at}: line ${b.lineN} is shown by a locked box`, 'the user locked it to hold it as it is; ask them before changing its words');
      return { p, page: i2 + 1, n: b.lineN, field: 'en', v: text, via: b.id };
    }
    return { p, page: i2 + 1, box: b, v: text };
  }
  for (const k of Object.keys(op)) if (!['page', 'line', 'en', 'jp'].includes(k)) throw new ToolError(`${at}: unknown key "${k}"`, 'A line op is { page, line, en?, jp? }; a box op { id, text }.');
  const count = app.pages.length;
  if (!Number.isInteger(op.page) || op.page < 1 || op.page > count) throw new ToolError(`${at}.page must be a page 1-${count}`);
  const p = app.pages[op.page - 1];
  if (!Number.isInteger(op.line) || !lineByN(p, op.line)) {
    throw new ToolError(`${at}: page ${op.page} has no line ${JSON.stringify(op.line)}`, `its lines: ${(p.lines ?? []).map((l) => l.n).join(', ') || 'none'}; lines reads them.`);
  }
  const en = words('en');
  const jp = words('jp');
  if (en !== undefined && lineLocked(p, op.line)) throw new ToolError(`${at}: line ${op.line} is shown by a locked box`, 'the user locked it to hold it as it is; ask them before changing its English (its source, jp, may still be fixed)');
  if (en === undefined && jp === undefined) throw new ToolError(`${at} changes nothing`, 'give en (the English) or jp (the source), or both.');
  return [
    ...(jp !== undefined ? [{ p, page: op.page, n: op.line, field: 'jp', v: jp }] : []),
    ...(en !== undefined ? [{ p, page: op.page, n: op.line, field: 'en', v: en }] : []),
  ];
}

const wordsOf = (w) => (w.box ? boxText(w.box, w.p) : w.field === 'jp' ? (lineByN(w.p, w.n).jp ?? '') : lineText(lineByN(w.p, w.n)));

defineTool({
  name: 'text',
  description:
    'Change the words. ops: [{ page, line, en?, jp? }] - a line\'s English (en: what every box showing that line draws, and what the queue shows) or its source (jp: to fix an OCR misread) - or [{ id, text }] - one box\'s words (a box that draws its line\'s words changes them on its line). ' +
    `Up to ${MAX_OPS} ops, all checked before anything is written. Works in translate mode too. Each box showing a changed line is laid out again for its new words; each page changed is one undo step for the user. ` +
    'Returns per op the words before and after (fenced), the boxes laid out again, and their checks and fit (compact: true keeps only what needs work, as edit does). Lines set by hand (edit set.breaks) for the old words are let go: breaksDropped names those boxes. Keep the meaning; follow the series guide\'s glossary; and tell the user every change you made, before and after.',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['ops'],
    properties: {
      ops: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_OPS,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1 },
            line: { type: 'integer' },
            en: { type: 'string' },
            jp: { type: 'string' },
            id: { type: 'string' },
            text: { type: 'string' },
          },
        },
      },
      compact: { type: 'boolean', description: 'return only what needs work, as edit does' },
    },
  },
  write: true,
  run({ ops, compact = false }, ctx) {
    if (!Array.isArray(ops) || !ops.length) throw new ToolError('ops must be a non-empty list', 'Use ops: [{ page: 2, line: 3, en: "Hello." }].');
    if (ops.length > MAX_OPS) throw new ToolError(`at most ${MAX_OPS} ops in one call`);
    if (!app.pages.length) throw new ToolError('no chapter is open');
    const writes = ops.map((op, i) => compile(op, i));
    const flat = writes.flat();
    const pages = [...new Set(flat.map((w) => w.p))];
    const held = heldBreaks(pages);
    const results = ctx.write(pages, () => {
      const out = writes.map((list) =>
        [list].flat().map((w) => {
          const before = wordsOf(w);
          let boxes = [];
          if (before !== w.v) {
            if (w.box) {
              editBoxes([{ page: w.p, box: w.box }], (b, p) => setBoxText(b, w.v, p, { fit: false }), { solve: true });
              boxes = [w.box.id];
            } else {
              writeLineText(w.p, w.n, w.field, w.v);
              if (w.field === 'en') boxes = w.p.boxes.filter((b) => b.lineN === w.n).map((b) => b.id);
            }
          }
          return {
            page: w.page,
            ...(w.box ? { id: w.box.id } : { line: w.n, field: w.field, ...(w.via ? { via: w.via } : null) }),
            before: untrusted(before),
            after: untrusted(wordsOf(w)),
            outcome: before === w.v ? 'nothing needed' : 'changed',
            ...(boxes.length ? { boxes } : null),
          };
        }),
      );
      // New words are laid out by the solver, as edit lays out an outline
      // fit box: a Fixed one is handed over first (edit.js `handToSolver`).
      handToSolver(matchesOf(out.flat().flatMap((r) => r.boxes ?? [])));
      return out;
    });
    return {
      ops: results.map((list) => {
        const ids = [...new Set(list.flatMap((r) => r.boxes ?? []))];
        const { checks, ...rest } = reportOf(ids, { compact });
        return { changes: list, ...(checks?.length ? { checks } : null), ...rest };
      }),
      ...breaksDropped(pages, held),
    };
  },
});

// The stretches of a box's words set in a face other than the box's own
// (runs.js), as the agent reads them: UTF-16 offsets into the box's text, the
// letters (fenced), and the face. Null when every letter is in the box face.
export function boxFaces(b, p) {
  const text = boxText(b, p) ?? '';
  const s = b.style ?? {};
  const out = faceSpans(boxRuns(b, p), text.length, s)
    .filter((r) => r.end > r.start && (r.bold !== !!s.bold || r.italic !== !!s.italic || (r.font && r.font !== s.font)))
    .map((r) => ({ start: r.start, end: r.end, text: untrusted(text.slice(r.start, r.end)), bold: r.bold, italic: r.italic, ...(r.font && r.font !== s.font ? { font: r.font } : null) }));
  return out.length ? out : null;
}

// Every `[start, end)` of `words` in `text`, or only the nth (1-based).
function wordRanges(text, words, nth) {
  const out = [];
  for (let at = text.indexOf(words); at >= 0 && words; at = text.indexOf(words, at + words.length)) out.push([at, at + words.length]);
  return nth ? out.slice(nth - 1, nth) : out;
}

defineTool({
  name: 'face',
  description:
    'Set bold, italic or the typeface of part of one box\'s words, the way a letterer stresses one word in a line. id: the box. Which words: start and end (UTF-16 offsets into the box\'s text, end exclusive; box shows the text and its faces), or words: an exact, case-sensitive piece of the text, every place it appears unless nth (1-based) picks one. ' +
    'What: bold and/or italic (true or false), font (an exact family from fonts; null is the box\'s own), or clear: true (back to the box\'s face). A range is widened to whole letters. One undo step for the user. The face of the whole box stays edit set.style. Returns the ranges set and the box\'s faces after.',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1 },
      start: { type: 'integer', minimum: 0 },
      end: { type: 'integer', minimum: 0 },
      words: { type: 'string', minLength: 1, maxLength: MAX_CHARS },
      nth: { type: 'integer', minimum: 1 },
      bold: { type: 'boolean' },
      italic: { type: 'boolean' },
      font: { type: ['string', 'null'] },
      clear: { const: true },
    },
  },
  write: true,
  run({ id, start, end, words, nth, bold, italic, font, clear }, ctx) {
    const i = app.pages.findIndex((p) => p.boxes?.some((b) => b.id === id));
    if (i < 0) throw new ToolError(`no box "${id}"`, 'query or lines list the box ids.');
    const p = app.pages[i];
    const b = p.boxes.find((x) => x.id === id);
    if (boxLocked(b)) throw new ToolError(`box ${id} is locked`, 'the user locked it to hold it as it is; ask them before changing it');
    const text = boxText(b, p) ?? '';
    let ranges;
    if (words != null) {
      if (start != null || end != null) throw new ToolError('give start and end, or words, not both');
      ranges = wordRanges(text, words, nth);
      if (!ranges.length) throw new ToolError(`the box's text has no "${words}"${nth ? ` ${nth} times` : ''}`, 'words matches the exact letters, case included; box shows its text.');
    } else {
      if (start == null || end == null) throw new ToolError('give start and end, or words', 'face: { id: "b12", words: "never", bold: true }');
      if (!(start < end) || end > text.length) throw new ToolError(`start and end must be 0 <= start < end <= ${text.length}`);
      ranges = [[start, end]];
    }
    let change;
    if (clear) {
      if (bold != null || italic != null || font !== undefined) throw new ToolError('clear goes alone', 'clear: true puts the words back in the box face.');
      change = { clear: true };
    } else {
      const set = {};
      if (bold != null) set.bold = bold;
      if (italic != null) set.italic = italic;
      if (font !== undefined) {
        if (font === null) set.font = null;
        else {
          const names = [...new Set(allFonts().map((f) => f.name))];
          const hit = names.find((n) => n === font) ?? names.find((n) => n.toLowerCase() === font.toLowerCase());
          if (!hit) throw new ToolError(`no font "${font}"`, `close: ${nearest(font, names).join(', ') || '(none)'}. The fonts tool lists exact names.`);
          // The box's own family is the box's face, not a run of it.
          set.font = hit === b.style?.font ? null : hit;
        }
      }
      if (!Object.keys(set).length) throw new ToolError('nothing to set', 'give bold, italic, font or clear: true.');
      change = { set };
    }
    const done = ctx.write([p], () => setRangesFace(b, ranges, change, p));
    return { id, page: i + 1, outcome: done ? 'changed' : 'nothing needed', ranges: done ?? ranges, faces: boxFaces(b, p) };
  },
});
