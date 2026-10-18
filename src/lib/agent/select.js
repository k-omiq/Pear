import {
  app, page, boxText, lineByN, reviewOf, outlineState, pageCheckItems, CHECK_REASONS,
} from '../store.svelte.js';
import { lineTags, knownTags, normalizeTagName } from '../tags.svelte.js';
import { ToolError, nearest } from './registry.js';
import { untrusted } from './fence.js';

const KEYS = ['pages', 'ids', 'selection', 'tag', 'text', 'font', 'size', 'flagged', 'outline', 'kind', 'not'];
const FLAGS = [...new Set(['guide', ...CHECK_REASONS])];
const PAGE_HINT = 'Use "current", "all", "2-5", "1,3,7-9", or an array of 1-based page numbers.';
const object = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const has = (v, k) => Object.hasOwn(v, k);

/** Resolve a page scope, deduplicated and in document order. */
export function parsePages(spec = 'current') {
  if (spec === 'all') return [...app.pages];
  if (spec === 'current') return app.pages.includes(page()) ? [page()] : [];
  const count = app.pages.length;
  const numbers = new Set();
  const add = (n) => {
    if (!Number.isSafeInteger(n) || n < 1 || n > count) {
      throw new ToolError(`Page ${n} is out of range; the chapter has ${count} pages.`, PAGE_HINT);
    }
    numbers.add(n);
  };
  // A lone page number, as an agent writes it: one page.
  if (typeof spec === 'number') add(spec);
  else if (Array.isArray(spec)) {
    for (const n of spec) {
      if (typeof n !== 'number') throw new ToolError('Page arrays must contain numbers.', PAGE_HINT);
      add(n);
    }
  } else if (typeof spec === 'string' && spec.trim()) {
    for (const part of spec.split(',')) {
      const match = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(part.trim());
      if (!match) throw new ToolError('Invalid page selector.', PAGE_HINT);
      const start = Number(match[1]), end = Number(match[2] ?? match[1]);
      // Check both ends before expanding, including on an empty chapter.
      add(start);
      add(end);
      if (start > end) throw new ToolError('Page ranges must run from first to last.', PAGE_HINT);
      for (let n = start + 1; n < end; n++) add(n);
    }
  } else {
    throw new ToolError('Invalid page selector.', PAGE_HINT);
  }
  return app.pages.filter((_, i) => numbers.has(i + 1));
}

/** Live store matches; only boxRow turns their page text into tool output.
 * `pages` is the resolved positive scope, including pages with no boxes.
 * A nested `not` is relative to that scope, with no implicit current-page limit.
 */
export function selectBoxes(where = {}) {
  const checks = new Map();
  const itemsFor = (p) => {
    if (!checks.has(p)) checks.set(p, pageCheckItems(p, app.pages.indexOf(p)));
    return checks.get(p);
  };
  const compile = (w, nested = false) => {
    if (!object(w)) throw new ToolError('A selector must be an object.', 'Use { pages: "all", tag: "sfx" }.');
    for (const key of Object.keys(w)) {
      if (!KEYS.includes(key)) {
        throw new ToolError(`Unknown selector key "${key}".`, `Close keys: ${nearest(key, KEYS).join(', ')}. Allowed: ${KEYS.join(', ')}.`);
      }
    }
    const scope = parsePages(has(w, 'pages') ? w.pages : nested || has(w, 'ids') || has(w, 'selection') ? 'all' : 'current');
    const pageSet = new Set(scope);
    let ids, selected, tags, regex;
    if (has(w, 'ids')) {
      if (!Array.isArray(w.ids) || w.ids.some((id) => typeof id !== 'string' || !id)) {
        throw new ToolError('ids must be an array of box ids.', 'Use ids: ["b12"].');
      }
      const known = app.pages.flatMap((p) => p.boxes.map((b) => b.id));
      ids = new Set(w.ids);
      for (const id of ids) {
        if (!known.includes(id)) throw new ToolError(`Unknown box id "${id}".`, `Nearest ids: ${nearest(id, known).join(', ') || '(no boxes)'}.`);
      }
    }
    if (has(w, 'selection')) {
      if (w.selection !== true) throw new ToolError('selection must be true.', 'Use selection: true, or omit it.');
      selected = new Set([app.selectedId, ...(app.bulk.active ? app.bulk.targets : [])].filter(Boolean));
    }
    if (has(w, 'tag')) {
      const names = Array.isArray(w.tag) ? w.tag : [w.tag];
      const known = knownTags(app.pages).map((t) => t.name);
      tags = names.map((name) => {
        const tag = normalizeTagName(name);
        if (!tag || !known.includes(tag)) {
          throw new ToolError(`Unknown tag "${name}".`, `Known tags: ${known.join(', ') || '(none)'}. Close: ${nearest(name, known).join(', ') || '(none)'}.`);
        }
        return tag;
      });
    }
    if (has(w, 'text')) {
      if (typeof w.text !== 'string') throw new ToolError('text must be a regex string.', 'Use text: "hello|goodbye" (case-insensitive).');
      try { regex = new RegExp(w.text, 'i'); }
      catch { throw new ToolError('Invalid text regex.', 'Use a JavaScript regex string without / delimiters, e.g. "hello|goodbye".'); }
    }
    if (has(w, 'font') && typeof w.font !== 'string') {
      throw new ToolError('font must be a family name.', 'Use the fonts tool for exact family names.');
    }
    if (has(w, 'size')) {
      if (!object(w.size) || Object.keys(w.size).some((key) => !['min', 'max'].includes(key)) ||
          Object.values(w.size).some((v) => !Number.isFinite(v)) ||
          (has(w.size, 'min') && has(w.size, 'max') && w.size.min > w.size.max)) {
        throw new ToolError('Invalid size range.', 'Use size: { min: 20, max: 40 } with finite numbers and min <= max; either bound is optional.');
      }
    }
    if (has(w, 'flagged') && w.flagged !== true && !FLAGS.includes(w.flagged)) {
      throw new ToolError('Invalid flagged selector.', `Use true or one of: ${FLAGS.join(', ')}.`);
    }
    if (has(w, 'outline') && !['unapproved', 'open', 'ai', 'user'].includes(w.outline)) {
      throw new ToolError('Invalid outline selector.', 'Use unapproved, open, ai, or user.');
    }
    if (has(w, 'kind') && !['text', 'sfx', 'ink'].includes(w.kind)) {
      throw new ToolError('Invalid kind selector.', 'Use text, sfx, or ink.');
    }
    const exclude = has(w, 'not') ? compile(w.not, true).matches : null;
    const matches = (m) => {
      const { page: p, box: b, line } = m;
      if (!pageSet.has(p) || (ids && !ids.has(b.id)) || (selected && !selected.has(b.id))) return false;
      const lineTagNames = lineTags(line);
      if (tags && !tags.some((t) => lineTagNames.includes(t))) return false;
      if (regex && !regex.test(boxText(b, p))) return false;
      if (has(w, 'font') && b.style?.font?.toLowerCase() !== w.font.toLowerCase()) return false;
      if (w.size && ((w.size.min != null && !(b.style?.size >= w.size.min)) ||
          (w.size.max != null && !(b.style?.size <= w.size.max)))) return false;
      if (has(w, 'flagged')) {
        if (w.flagged === 'overflow') {
          if (!reviewOf(b, p)) return false;
        } else if (!itemsFor(p).some((it) => it.boxId === b.id &&
            (w.flagged === true || (w.flagged === 'guide' ? ['glossary', 'rules'].includes(it.reason) : it.reason === w.flagged)))) return false;
      }
      if (has(w, 'outline') && outlineState(b) !== (w.outline === 'unapproved' ? 'waiting' : w.outline)) return false;
      if (has(w, 'kind')) {
        const ink = !!(b.style?.ink?.on && b.style.ink.strokes?.length);
        const sfx = !!b.style?.sfx?.on || lineTagNames.includes('sfx');
        if (!(w.kind === 'ink' ? ink : w.kind === 'sfx' ? sfx : !ink && !sfx)) return false;
      }
      return !exclude?.(m);
    };
    return { scope, matches };
  };
  const selector = compile(where);
  const matches = [];
  app.pages.forEach((p, pageIndex) => {
    for (const box of p.boxes) {
      const m = { page: p, pageIndex, box, line: lineByN(p, box.lineN) ?? null };
      if (selector.matches(m)) matches.push(m);
    }
  });
  return { matches, pages: selector.scope };
}

// A caller returning many rows can supply the page's checks once.
export function boxRow(m, checks = pageCheckItems(m.page, m.pageIndex)) {
  const { page: p, pageIndex, box: b, line } = m;
  return {
    id: b.id,
    page: pageIndex + 1,
    line: b.lineN ?? null,
    tags: [...lineTags(line)],
    text: untrusted(boxText(b, p), 80),
    rect: [b.x, b.y, b.w, b.h].map(Math.round),
    rotation: b.style?.rotation ?? 0,
    font: b.style?.font ?? null,
    size: b.style?.size ?? null,
    flags: [...new Set(checks.filter((it) => it.boxId === b.id).map((it) => it.reason))],
  };
}
