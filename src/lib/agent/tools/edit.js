// ===== edit: the one write tool =====
// docs/AI_TYPESETTING_PLAN.md section 1. A call is a list of ops; each op
// names its boxes with a `where` and says what to `set` on them and what to
// `do`. Every op is checked before anything is written, so a bad value
// anywhere changes nothing. Then the ops run in order, inside the AI run
// (`ctx.write`), through the store's own functions: one undo step per page.
//
// A result says, per op, how many boxes matched, which changed, and the checks
// for the changed boxes. 0 matched is a result, not an error.

import { defineTool, ToolError, nearest } from '../registry.js';
import { selectBoxes } from '../select.js';
import { validateStylePatch, styleSchemaText } from '../style-schema.js';
import { applyStylePatch, resolveRelative } from '../../style-patch.js';
import { checksFor } from './check.js';
import {
  app,
  allFonts,
  cloneStyle,
  editBoxes,
  resizeBox,
  setBoxText,
  setBoxLocks,
  LOCK_KEYS,
  commitOutlinePoints,
  refitBalloon,
  retypesetBox,
  toggleBalloonFit,
  approveBoxes,
  outlineToBox,
  deleteBox,
  duplicateBox,
  recordEdit,
  markUnsaved,
  lineByN,
  boxText,
  isTranslateMode,
} from '../../store.svelte.js';
import { setLineTags, normalizeTagName, styleForLine } from '../../tags.svelte.js';
import { applyTextRules } from '../../text-rules.js';
import { guide } from '../../guide.svelte.js';
import { presets } from '../../presets.svelte.js';
import { sfxAvailable, sfxPresets, applySfxPreset, clearSfx } from '../../sfx.js';

const DO_PLAIN = ['refit', 'fit_balloon', 'apply_guide', 'delete', 'duplicate', 'clear_sfx', 'approve_outline', 'refit_outline', 'outline_to_box'];
const DO_NAMED = ['preset:', 'sfx:'];
const DO_LATER = { match_angle: 'match_angle comes with chapter mode; set geometry.rotation for now.' };
const SET_KEYS = ['text', 'style', 'geometry', 'tags', 'locks', 'outline', 'note'];
const GEOM_KEYS = ['x', 'y', 'w', 'h', 'rotation'];
// A preset is a look, not a placement (Inspector.svelte `PRESET_SKIP`).
const PRESET_SKIP = ['rotation', 'flipH', 'flipV'];
const MAX_OPS = 50;

const object = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isRel = (v) => typeof v === 'string' && /^[+\-*]\d+(\.\d+)?$/.test(v.trim());

const DESCRIPTION = [
  'Change boxes. ops is a list; each op is { where, set?, do? } and they run in order. where is the selector every tool takes (see context).',
  'set: text (the box text), style (a style patch, schema below), geometry { x, y, w, h, rotation } in page px and degrees, tags (the line\'s tags, replaced whole; the box takes the tags\' style),',
  'locks { size, width, height, pos, breaks } booleans, outline [[x, y], ...] a drawn bubble outline (3+ points, unapproved, the text typeset again inside it), note (a note on the outline for the user).',
  'do: "refit" (typeset again in the outline it has), "fit_balloon" (turn the balloon fit on, measuring it when there is none), "refit_outline" (find the bubble under the box again),',
  '"outline_to_box" (the box rectangle as its outline), "approve_outline" (approve as AI; never an open outline), "apply_guide" (the tags\' styles and the guide\'s text rules),',
  '"preset:<name or id>", "sfx:<name or id>" (Rust engine only), "clear_sfx", "duplicate", "delete".',
  'Numbers may be relative: "+2", "-2", "*1.1". All ops are checked first; any bad value changes nothing. dryRun: true checks and counts only.',
  'Each page changed is one undo step for the user. The result gives matched, changed ids and the checks for the changed boxes.',
  '',
  styleSchemaText(),
].join('\n');

const whereSchema = { type: 'object', description: 'a box selector, the same shape every tool takes' };
const input = {
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
        required: ['where'],
        properties: {
          where: whereSchema,
          set: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string' },
              style: { type: 'object' },
              geometry: {
                type: 'object',
                additionalProperties: false,
                properties: Object.fromEntries(GEOM_KEYS.map((k) => [k, { type: ['number', 'string'] }])),
              },
              tags: { type: 'array', items: { type: 'string' } },
              locks: {
                type: 'object',
                additionalProperties: false,
                properties: Object.fromEntries(LOCK_KEYS.map((k) => [k, { type: 'boolean' }])),
              },
              outline: { type: 'array', minItems: 3, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } } },
              note: { type: 'string' },
            },
          },
          do: { type: 'string' },
        },
      },
    },
    dryRun: { type: 'boolean' },
  },
};

const fail = (i, path, msg, hint) => {
  throw new ToolError(`ops[${i}]${path ? '.' + path : ''}: ${msg}`, hint);
};

function findFont(name, i) {
  const names = [...new Set(allFonts().map((f) => f.name))];
  const hit = names.find((n) => n === name) ?? names.find((n) => n.toLowerCase() === String(name).toLowerCase());
  if (!hit) fail(i, 'set.style.font', `no font "${name}"`, `close: ${nearest(String(name), names).join(', ') || '(none)'}. The fonts tool lists exact names.`);
  return hit;
}

function findNamed(list, name, what, i) {
  const want = name.trim().toLowerCase();
  const hit = list.find((p) => p.id === name) ?? list.find((p) => String(p.name).toLowerCase() === want);
  if (!hit) {
    const names = list.map((p) => p.name);
    fail(i, 'do', `no ${what} "${name}"`, `close: ${nearest(name, names).join(', ') || '(none)'}.`);
  }
  return hit;
}

// One op, checked and resolved: what it will touch and how. Throws on any bad
// value, before anything is written.
function compile(op, i) {
  if (!object(op)) fail(i, '', 'an op must be an object', 'Use { where: {...}, set: {...} } or { where: {...}, do: "refit" }.');
  for (const k of Object.keys(op)) {
    if (!['where', 'set', 'do'].includes(k)) fail(i, k, 'unknown key', `an op has where, set and do. Close: ${nearest(k, ['where', 'set', 'do']).join(', ')}.`);
  }
  if (!object(op.where)) fail(i, 'where', 'every op needs a where', 'Use where: { selection: true } for "this box", { pages: "current" } for this page.');
  if (op.set == null && op.do == null) fail(i, '', 'nothing to do', 'Give set, do, or both.');
  let matches;
  try {
    matches = selectBoxes(op.where).matches;
  } catch (err) {
    if (err instanceof ToolError) fail(i, 'where', err.message, err.hint);
    throw err;
  }
  const out = { matches, set: null, do: null };

  if (op.set != null) {
    if (!object(op.set)) fail(i, 'set', 'set must be an object');
    const set = {};
    for (const k of Object.keys(op.set)) {
      if (!SET_KEYS.includes(k)) fail(i, `set.${k}`, 'unknown key', `close: ${nearest(k, SET_KEYS).join(', ')}. Allowed: ${SET_KEYS.join(', ')}.`);
    }
    const s = op.set;
    if ('text' in s) {
      if (typeof s.text !== 'string') fail(i, 'set.text', 'expected a string');
      set.text = s.text;
    }
    if ('style' in s) {
      if (!object(s.style)) fail(i, 'set.style', 'expected a style patch object');
      const errors = validateStylePatch(s.style);
      if (errors.length) {
        const e = errors[0];
        fail(i, `set.style${e.path && e.path !== '$' ? '.' + e.path : ''}`, e.error, [e.hint, errors.length > 1 ? `${errors.length - 1} more problem(s) in this patch` : null].filter(Boolean).join('; ') || undefined);
      }
      set.style = { ...s.style };
      if (typeof set.style.font === 'string') set.style.font = findFont(set.style.font, i);
      // A relative value needs a number on every box it reaches.
      for (const m of matches) {
        const e = applyStylePatch(cloneStyle(m.box.style), set.style).errors[0];
        if (e) fail(i, `set.style.${e.path}`, `on box ${m.box.id}: ${e.error}`, 'give a plain value instead.');
      }
    }
    if ('geometry' in s) {
      if (!object(s.geometry)) fail(i, 'set.geometry', 'expected { x, y, w, h, rotation }');
      for (const [k, v] of Object.entries(s.geometry)) {
        if (!GEOM_KEYS.includes(k)) fail(i, `set.geometry.${k}`, 'unknown key', `use ${GEOM_KEYS.join(', ')}.`);
        if (!isNum(v) && !isRel(v)) fail(i, `set.geometry.${k}`, 'expected a number or a relative string ("+10", "*1.2")');
        if ((k === 'w' || k === 'h') && isNum(v) && v < 8) fail(i, `set.geometry.${k}`, 'too small', 'boxes are at least 8 px.');
      }
      set.geometry = { ...s.geometry };
    }
    if ('tags' in s) {
      if (!Array.isArray(s.tags) || s.tags.some((t) => typeof t !== 'string')) fail(i, 'set.tags', 'expected an array of tag names');
      const tags = s.tags.map((t) => normalizeTagName(t));
      const bad = s.tags.find((t, j) => !tags[j]);
      if (bad != null) fail(i, 'set.tags', `"${bad}" is not a tag name`, 'tags tool lists the known ones; a new name is fine.');
      const lineless = matches.filter((m) => !m.line).map((m) => m.box.id);
      if (lineless.length) fail(i, 'set.tags', `box ${lineless.slice(0, 5).join(', ')} has no line to tag`, 'leave those out with where.not: { ids: [...] }.');
      set.tags = tags;
    }
    if ('locks' in s) {
      if (!object(s.locks)) fail(i, 'set.locks', 'expected { size, width, height, pos, breaks } booleans');
      for (const [k, v] of Object.entries(s.locks)) {
        if (!LOCK_KEYS.includes(k)) fail(i, `set.locks.${k}`, 'unknown lock', `use ${LOCK_KEYS.join(', ')}.`);
        if (typeof v !== 'boolean') fail(i, `set.locks.${k}`, 'expected true or false');
      }
      set.locks = { ...s.locks };
    }
    if ('outline' in s) {
      const pts = s.outline;
      if (!Array.isArray(pts) || pts.length < 3 || pts.some((pt) => !Array.isArray(pt) || pt.length !== 2 || !pt.every(isNum))) {
        fail(i, 'set.outline', 'expected 3 or more [x, y] points in page px', 'read the points off a ruled view.');
      }
      if (matches.length > 1) fail(i, 'set.outline', `one outline cannot be drawn for ${matches.length} boxes`, 'name one box with where: { ids: ["b12"] }.');
      set.outline = pts.map(([x, y]) => [x, y]);
    }
    if ('note' in s) {
      if (typeof s.note !== 'string') fail(i, 'set.note', 'expected a string');
      set.note = s.note.slice(0, 500);
    }
    out.set = set;
  }

  if (op.do != null) {
    if (typeof op.do !== 'string') fail(i, 'do', 'expected a string');
    const d = op.do.trim();
    if (DO_LATER[d]) fail(i, 'do', `"${d}" is not here yet`, DO_LATER[d]);
    if (DO_PLAIN.includes(d)) out.do = { kind: d };
    else if (d.startsWith('preset:')) out.do = { kind: 'preset', preset: findNamed(presets.list, d.slice(7), 'preset', i) };
    else if (d.startsWith('sfx:')) {
      if (!sfxAvailable()) fail(i, 'do', 'SFX lettering needs the Rust text engine', 'it is off in this app; leave SFX to the user.');
      out.do = { kind: 'sfx', preset: findNamed(sfxPresets(), d.slice(4), 'SFX preset', i) };
    } else {
      fail(i, 'do', `unknown action "${d}"`, `close: ${nearest(d, [...DO_PLAIN, ...DO_NAMED]).join(', ')}.`);
    }
    if (out.do.kind === 'delete' && out.set) fail(i, '', 'set and delete in one op', 'a deleted box keeps nothing; drop one of them.');
  }
  return out;
}

// The parts of `set` that `editBoxes` records: text, style, geometry, tags.
function writeSet(set, matches) {
  const hasBoxPart = set.text != null || set.style || set.geometry || set.tags;
  if (!hasBoxPart) return [];
  const changed = editBoxes(
    matches.map((m) => ({ page: m.page, box: m.box })),
    (b, p) => {
      if (set.tags) {
        const ln = lineByN(p, b.lineN);
        setLineTags(ln, set.tags);
        b.style = cloneStyle(styleForLine(ln, cloneStyle(b.style)));
      }
      if (set.style) {
        const before = b.style.size;
        const { style, errors } = applyStylePatch(cloneStyle(b.style), set.style);
        if (errors.length) return false;
        b.style = style;
        // A size the agent set is the box's own, as one the user types is:
        // the solver starts from it and keeps it.
        if ('size' in set.style && b.auto && b.style.size !== before) {
          b.auto.refSize = b.style.size;
          b.auto.locks.size = true;
        }
      }
      if (set.geometry) {
        const g = {};
        for (const k of ['x', 'y', 'w', 'h']) {
          if (!(k in set.geometry)) continue;
          const v = set.geometry[k];
          g[k] = isNum(v) ? v : resolveRelative(v, b[k]).value;
        }
        if (g.w != null) g.w = Math.max(8, g.w);
        if (g.h != null) g.h = Math.max(8, g.h);
        if (Object.keys(g).length) resizeBox(p.id, b.id, g);
        if ('rotation' in set.geometry) {
          const v = set.geometry.rotation;
          const r = isNum(v) ? v : resolveRelative(v, b.style.rotation ?? 0).value;
          b.style.rotation = Math.round((((r % 360) + 540) % 360 - 180) * 100) / 100;
        }
      }
      if (set.text != null) setBoxText(b, set.text, p, { fit: false });
    },
  );
  return changed.map((t) => t.box.id);
}

function writeNote(note, matches) {
  const byPage = new Map();
  for (const { page: p, box: b } of matches) {
    if (!b.outline || (b.outline.note ?? '') === note) continue;
    const before = $state.snapshot(b.outline);
    b.outline = { ...before, note: note || undefined };
    if (!note) delete b.outline.note;
    const items = byPage.get(p.id) ?? [];
    items.push({ boxId: b.id, before, after: $state.snapshot(b.outline) });
    byPage.set(p.id, items);
  }
  const ids = [];
  for (const [pageId, items] of byPage) {
    recordEdit({ t: 'outlines', pageId, items });
    ids.push(...items.map((it) => it.boxId));
  }
  if (ids.length) markUnsaved();
  return ids;
}

const fingerprint = (b) => JSON.stringify([b.x, b.y, b.w, b.h, b.style, b.fit, b.outline, b.auto, b.text]);

// One `do`, box by box, through the store's command for it. Returns
// { changed, created, deleted } ids.
function writeDo(d, matches) {
  const changed = [];
  const created = [];
  const deleted = [];
  if (d.kind === 'approve_outline') {
    const byPage = new Map();
    for (const m of matches) byPage.set(m.page, [...(byPage.get(m.page) ?? []), m.box]);
    for (const [p, boxes] of byPage) {
      const ids = boxes.filter((b) => b.fit && b.outline?.approved !== 'ai').map((b) => b.id);
      if (approveBoxes(p, boxes, 'ai')) changed.push(...ids);
    }
    return { changed, created, deleted };
  }
  if (['preset', 'sfx', 'clear_sfx', 'apply_guide'].includes(d.kind)) {
    const out = editBoxes(
      matches.map((m) => ({ page: m.page, box: m.box })),
      (b, p) => {
        if (d.kind === 'preset') {
          const next = cloneStyle(d.preset.style);
          for (const k of PRESET_SKIP) delete next[k];
          const before = b.style.size;
          Object.assign(b.style, next);
          if (b.auto && b.style.size !== before) {
            b.auto.refSize = b.style.size;
            b.auto.locks.size = true;
          }
        } else if (d.kind === 'sfx') {
          applySfxPreset(b.style, d.preset, b);
        } else if (d.kind === 'clear_sfx') {
          if (!b.style.sfx?.on) return false;
          clearSfx(b.style, b);
        } else {
          const ln = b.lineN != null ? lineByN(p, b.lineN) : null;
          if (ln) b.style = cloneStyle(styleForLine(ln, cloneStyle(b.style)));
          const text = boxText(b, p);
          const ruled = applyTextRules(text, guide.rules);
          if (ruled !== text) setBoxText(b, ruled, p, { fit: false });
        }
      },
    );
    return { changed: out.map((t) => t.box.id), created, deleted };
  }
  for (const { page: p, box: b } of matches) {
    const id = b.id;
    if (d.kind === 'delete') {
      deleteBox(id, p);
      if (!p.boxes.some((x) => x.id === id)) deleted.push(id);
      continue;
    }
    if (d.kind === 'duplicate') {
      const copy = duplicateBox(id, p, { select: false });
      if (copy) created.push(copy);
      continue;
    }
    const before = fingerprint(b);
    if (d.kind === 'refit') retypesetBox(id, p);
    else if (d.kind === 'refit_outline') refitBalloon(id, p);
    else if (d.kind === 'outline_to_box') outlineToBox(id, p);
    else if (d.kind === 'fit_balloon') {
      if (b.style.balloon === false) toggleBalloonFit(id, p);
      else if (!b.fit) refitBalloon(id, p);
    }
    if (fingerprint(b) !== before) changed.push(id);
  }
  return { changed, created, deleted };
}

function runOp(c) {
  // Boxes are named as the document stood when the call came; one an earlier
  // op deleted is gone.
  c.matches = c.matches.filter((m) => m.page.boxes.includes(m.box));
  const ids = new Set();
  const out = { matched: c.matches.length };
  if (c.set) {
    for (const id of writeSet(c.set, c.matches)) ids.add(id);
    if (c.set.locks) {
      const lockable = c.matches.filter((m) => m.box.auto).map((m) => m.box.id);
      const before = new Map(c.matches.map((m) => [m.box.id, JSON.stringify(m.box.auto?.locks ?? null)]));
      setBoxLocks(lockable, c.set.locks);
      for (const m of c.matches) if (JSON.stringify(m.box.auto?.locks ?? null) !== before.get(m.box.id)) ids.add(m.box.id);
      if (lockable.length < c.matches.length) out.notLockable = c.matches.length - lockable.length;
    }
    if (c.set.outline) {
      const { page: p, box: b } = c.matches[0] ?? {};
      if (b && commitOutlinePoints(b.id, c.set.outline, p)) ids.add(b.id);
    }
    if (c.set.note != null) for (const id of writeNote(c.set.note, c.matches)) ids.add(id);
  }
  if (c.do) {
    const r = writeDo(c.do, c.matches);
    for (const id of r.changed) ids.add(id);
    if (r.created.length) out.created = r.created;
    if (r.deleted.length) out.deleted = r.deleted;
    if (c.do.kind === 'approve_outline') {
      const open = c.matches.filter((m) => !m.box.fit).length;
      if (open) out.notApproved = { count: open, why: 'no outline to approve: draw one (set.outline) or use outline_to_box' };
    }
  }
  const deleted = new Set(out.deleted ?? []);
  out.changed = [...ids].filter((id) => !deleted.has(id));
  return out;
}

// Boxes by id, found where they now stand, as selector matches.
export function matchesOf(ids) {
  const want = new Set(ids);
  const ms = [];
  if (!want.size) return ms;
  app.pages.forEach((p, pageIndex) => {
    for (const box of p.boxes) {
      if (want.has(box.id)) ms.push({ page: p, pageIndex, box, line: box.lineN != null ? (lineByN(p, box.lineN) ?? null) : null });
    }
  });
  return ms;
}

// The checks for the changed (and created) boxes.
export const checksOf = (ids) => (ids.length ? checksFor(matchesOf(ids)) : []);

defineTool({
  name: 'edit',
  description: DESCRIPTION,
  input,
  write: true,
  run({ ops, dryRun = false }, ctx) {
    if (!Array.isArray(ops) || !ops.length) throw new ToolError('ops must be a non-empty list', 'Use ops: [{ where: { selection: true }, set: { style: { size: "+2" } } }].');
    if (ops.length > MAX_OPS) throw new ToolError(`at most ${MAX_OPS} ops in one call`, 'Split the work, or use wider selectors.');
    if (isTranslateMode()) throw new ToolError('this chapter is in translate mode and has no boxes to edit');
    const compiled = ops.map(compile);
    if (dryRun) return { dryRun: true, ops: compiled.map((c) => ({ matched: c.matches.length, ids: c.matches.slice(0, 50).map((m) => m.box.id) })) };
    const pages = [...new Set(compiled.flatMap((c) => c.matches.map((m) => m.page)))];
    if (!pages.length) return { ops: compiled.map(() => ({ matched: 0, changed: [] })), note: 'nothing matched; fix the where and call again' };
    const results = ctx.write(pages, () => compiled.map(runOp));
    return {
      ops: results.map((r) => ({ ...r, checks: checksOf([...r.changed, ...(r.created ?? [])]) })),
    };
  },
});
