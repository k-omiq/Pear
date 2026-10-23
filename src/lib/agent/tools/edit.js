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
import { applyCase, breaksFor } from '../../measure.js';
import { normalizeAuto } from '../../data.js';
import { OUTLINE_FIT } from '../../outline-fit.js';
import { splitOutline } from '../../bubble-outline.js';
import { fitPolygon, intervalsAt } from '../../outline-geom.js';
import { checksFor, fitsOf } from './check.js';
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
  withStyleOrder,
  setLineSpeaker,
  dropBoxOutline,
  refSizeOf,
} from '../../store.svelte.js';
import { setLineTags, normalizeTagName, styleForLine } from '../../tags.svelte.js';
import { applyTextRules } from '../../text-rules.js';
import { letteringSetUp } from '../../lettering.js';
import { guide, guideBound, termById } from '../../guide.svelte.js';
import { presets } from '../../presets.svelte.js';
import { sfxAvailable, sfxKinds, sfxPick, applySfxKind, clearSfx } from '../../sfx.js';
import { WARP_PRESETS, WARP_PRESET_NOTES, warpPresetPts } from '../../warp-presets.js';
import { footprintIn, footprintRegion, matchFor } from './footprint.js';

const DO_PLAIN = ['typeset', 'auto', 'refit', 'fit_balloon', 'free', 'apply_guide', 'delete', 'duplicate', 'clear_sfx', 'approve_outline', 'refit_outline', 'split_outline', 'outline_to_box', 'match_original', 'sfx_pick'];
const DO_NAMED = ['preset:', 'sfx_kind:', 'warp:'];
// "warp:<kind>" alone bends by this much (percent of the kind's strongest).
export const WARP_DEFAULT_AMOUNT = 50;
const WARP_AMOUNT = /^[+-]?\d+(\.\d+)?$/;
const DO_LATER = { match_angle: 'do "match_original" turns a box to the original\'s slant (and sizes, places and colours it).' };
const SET_KEYS = ['text', 'style', 'sizing', 'geometry', 'breaks', 'tags', 'speaker', 'locks', 'outline', 'note'];
const SIZE_RANGE = [4, 300];
const GEOM_KEYS = ['x', 'y', 'w', 'h', 'rotation'];
// A preset is a look, not a placement (Inspector.svelte `PRESET_SKIP`).
const PRESET_SKIP = ['rotation', 'flipH', 'flipV'];
const MAX_OPS = 50;

const object = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isRel = (v) => typeof v === 'string' && /^[+\-*]\d+(\.\d+)?$/.test(v.trim());

const DESCRIPTION = [
  'Change boxes. ops is a list; each op is { where, set?, do? } and they run in order. where is the selector every tool takes (see context).',
  'set: text (the box text), style (a style patch, schema below; style.size is the size the solver aims for, not a lock),',
  'sizing { ref, min } (the size aimed for and the least it may shrink to, px; min null is the chapter floor),',
  'geometry { x, y, w, h, rotation } in page px and degrees (x and y are the top-left corner; the solver keeps what is given, the place by its centre; locks undo it),',
  'breaks ["line one", "line two", ...] the box\'s lines exactly, in order (no added hyphens), held until null clears them; needs outline fit (do "typeset"),',
  'tags (the line\'s tags, replaced whole; the box takes the tags\' style), speaker (the id of the character who says the line, from lettering get or guide, or null; the box takes their font),',
  'locks { size, width, height, pos, breaks } booleans, outline [[x, y], ...] a drawn bubble outline (3+ points, unapproved, the text typeset again inside it), note (a note on the outline for the user).',
  'do: "typeset" (outline fit: style.margin 0.5 em unless set, balloon fit on, then laid out again in its outline: an oval block, no hyphens, centred on the ink),',
  '"auto" (every lock off, kept lines dropped, laid out again by the solver), "refit" (typeset again in the outline it has, keeping locks),',
  '"fit_balloon" (turn the balloon fit on, measuring it when there is none), "free" (balloon fit off and the outline dropped: text drawn on the art, an SFX or sign the finder wrapped in an outline, laid out from itself where it stands), "refit_outline" (find the bubble under the box again),',
  '"split_outline" (an outline that holds two joined bubbles, cut at the neck: the box keeps the piece with its text; then typeset again),',
  '"outline_to_box" (an outline of the box\'s rectangle, grown to hold its text at the size it aims for with outline fit\'s air, or exactly the box when its width or height is held: geometry in the same op sets it first; shrunk in the result names a box that still fits only smaller), "approve_outline" (approve as AI; never an open outline), "apply_guide" (the tags\' styles and the guide\'s text rules),',
  '"match_original" (an SFX, title or sign drawn over the original it replaces, found where the cleaner removed it: balloon fit off, no outline, margin 0, centred on the original, turned to its slant, sized to run its length and held there, in its colours on a colour page or white or black with an outline of the other over the art; noOriginal in the result names boxes with no cleaned original, laid on their detected line instead),',
  '"sfx_kind:<id or name>" (SFX lettering, Rust engine only: the box laid out letter by letter as that sound type; a type is a layout only, the box keeps its font, fill and outlines; sfx_kinds lists them; seed and caption stay; paths, letter hand edits, the power/rough/momentum dials and every other style.sfx field go back to the type\'s), "sfx_pick" (the type the app ranks best for the box\'s text, with the dials it asks for), "clear_sfx" (SFX off, the arc, ring or path it switched off put back);',
  'then tune an SFX in a later op with set style.sfx (power, rough, momentum dials 0..100 with 50 the type as designed, seed for another arrangement, paths, flow, slant, jitter, caption) and the effects that draw only while SFX is on (negative, extrude, shake, trail, strokeShade, strokeOrder, strokeJoin).',
  '"preset:<name or id>", "duplicate", "delete",',
  `"warp:<kind>" or "warp:<kind>:<amount>" (a mesh bend of the whole box, Photoshop-style; amount -100..100, default ${WARP_DEFAULT_AMOUNT}, negative bends the other way; replaces any mesh the box had), "warp:off" (mesh off and cleared). Kinds: ` +
    WARP_PRESETS.map((k) => `${k} (${WARP_PRESET_NOTES[k]})`).join(', ') + '.',
  'Other curves: style.curve (a simple arc of the lines), style.circle (text round a ring), style.path (text along bezier anchors you give); path beats circle beats curve, and a warp bends whatever they drew.',
  'Numbers may be relative: "+2", "-2", "*1.1". All ops are checked first; any bad value changes nothing. dryRun: true checks and counts only.',
  'Each page changed is one undo step for the user. The result gives, per op, matched, changed ids, outcome, the checks for the changed boxes, and fit: each box against its outline in numbers.',
  'outcome: "changed"; "changed some" (the app refused the rest: see notLockable, notApproved, notSplit or noBalloon); "refused" (nothing changed, and those say why); "nothing needed" (every box already was as asked, nothing to write); "nothing matched" (no box: fix the where).',
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
              sizing: {
                type: 'object',
                additionalProperties: false,
                properties: { ref: { type: 'number' }, min: { type: ['number', 'null'] } },
              },
              breaks: { type: ['array', 'null'], items: { type: 'string' } },
              geometry: {
                type: 'object',
                additionalProperties: false,
                properties: Object.fromEntries(GEOM_KEYS.map((k) => [k, { type: ['number', 'string'] }])),
              },
              tags: { type: 'array', items: { type: 'string' } },
              speaker: { type: ['string', 'null'] },
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

// SFX lettering is laid out by the Rust engine alone.
function needSfx(i) {
  if (!sfxAvailable()) fail(i, 'do', 'SFX lettering needs the Rust text engine', 'it is off in this app; leave SFX to the user.');
}

// "arc", "arc:-30" or "off" (what follows "warp:"), as a `do`.
function parseWarp(spec, i) {
  const [name = '', amount, ...extra] = spec.split(':').map((t) => t.trim());
  const kind = name.toLowerCase();
  if (kind === 'off') {
    if (amount != null) fail(i, 'do', '"warp:off" takes no amount');
    return { kind: 'warp', preset: null };
  }
  if (!WARP_PRESETS.includes(kind)) {
    fail(i, 'do', `no warp "${name}"`, `close: ${nearest(name, WARP_PRESETS).join(', ')}. Kinds: ${WARP_PRESETS.join(', ')}, or off.`);
  }
  if (extra.length) fail(i, 'do', `"warp:${spec}" has too many parts`, 'use "warp:<kind>" or "warp:<kind>:<amount>", e.g. "warp:arc:-30".');
  let n = WARP_DEFAULT_AMOUNT;
  if (amount != null) {
    n = WARP_AMOUNT.test(amount) ? Number(amount) : NaN;
    if (!Number.isFinite(n) || n < -100 || n > 100) fail(i, 'do', `warp amount "${amount}" is not a number from -100 to 100`, 'a percentage, e.g. "warp:arc:30"; negative bends the other way.');
  }
  return { kind: 'warp', preset: kind, amount: n };
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
      // A sound type is more than its id (it resets the layout and keeps what
      // SFX switched off), and SFX off puts that back: both go through their
      // actions.
      const sfx = object(s.style.sfx) ? s.style.sfx : {};
      if ('kind' in sfx) fail(i, 'set.style.sfx.kind', 'a sound type is applied, not set', 'use do "sfx_kind:<id>" (sfx_kinds lists them) or do "sfx_pick".');
      if ('on' in sfx) fail(i, 'set.style.sfx.on', 'SFX is switched with its actions', 'use do "sfx_kind:<id>" or "sfx_pick" to switch it on, "clear_sfx" to switch it off.');
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
    if ('sizing' in s) {
      if (!object(s.sizing)) fail(i, 'set.sizing', 'expected { ref, min }');
      const sz = {};
      for (const [k, v] of Object.entries(s.sizing)) {
        if (k !== 'ref' && k !== 'min') fail(i, `set.sizing.${k}`, 'unknown key', 'use ref and min.');
        if (k === 'min' && v === null) {
          sz.min = null;
          continue;
        }
        if (!isNum(v) || v < SIZE_RANGE[0] || v > SIZE_RANGE[1]) fail(i, `set.sizing.${k}`, `expected a size in px, ${SIZE_RANGE[0]} to ${SIZE_RANGE[1]}`);
        sz[k] = v;
      }
      if (sz.ref != null && sz.min != null && sz.min > sz.ref) fail(i, 'set.sizing.min', 'min is above ref', 'the least size is at most the size aimed for.');
      set.sizing = sz;
    }
    if ('breaks' in s) {
      if (s.breaks !== null && (!Array.isArray(s.breaks) || !s.breaks.length || s.breaks.some((t) => typeof t !== 'string'))) {
        fail(i, 'set.breaks', 'expected the lines as a list of strings, or null', 'e.g. ["WAS THERE", "ANYTHING YOU", "WERE INTO?"].');
      }
      set.breaks = s.breaks === null ? null : s.breaks.map((t) => t.trim());
      if (set.breaks) {
        // Checked on every box now, against the text and style it will have.
        for (const m of matches) {
          const style = set.style ? applyStylePatch(cloneStyle(m.box.style), set.style).style : m.box.style;
          if (style.margin == null && op.do?.trim() !== 'typeset') {
            fail(i, 'set.breaks', `box ${m.box.id} is not laid out by outline fit`, 'add do: "typeset" to this op, or set style.margin.');
          }
          const text = applyCase(set.text ?? boxText(m.box, m.page), style);
          if (!breaksFor(text, style, style.size, set.breaks.map((t) => applyCase(t, style)))) {
            fail(i, 'set.breaks', `the lines are not box ${m.box.id}'s text`, 'give every word of the text once, in order, split into lines, with its letters and punctuation as the text has them (capitals may differ); box shows the text.');
          }
        }
      }
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
    if ('speaker' in s) {
      if (s.speaker !== null && !(typeof s.speaker === 'string' && termById(s.speaker)?.character)) {
        const ids = guide.glossary.filter((t) => t.character).map((t) => t.id);
        fail(i, 'set.speaker', `no character "${s.speaker}"`, ids.length ? `ids: ${nearest(String(s.speaker), ids).join(', ')}.` : 'the guide has no characters: lettering set characters [{ name, font }] adds one.');
      }
      const lineless = matches.filter((m) => !m.line).map((m) => m.box.id);
      if (lineless.length) fail(i, 'set.speaker', `box ${lineless.slice(0, 5).join(', ')} has no line to give a speaker`, 'leave those out with where.not: { ids: [...] }.');
      set.speaker = s.speaker;
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
    if (d === 'sfx_pick') needSfx(i);
    if (DO_PLAIN.includes(d)) out.do = { kind: d };
    else if (d.startsWith('preset:')) out.do = { kind: 'preset', preset: findNamed(presets.list, d.slice(7), 'preset', i) };
    else if (d.startsWith('sfx_kind:')) {
      needSfx(i);
      out.do = { kind: 'sfx_kind', type: findNamed(sfxKinds(), d.slice(9).trim(), 'sound type', i).id };
    } else if (d.startsWith('warp:')) {
      out.do = parseWarp(d.slice(5), i);
    } else {
      fail(i, 'do', `unknown action "${d}"`, `close: ${nearest(d, [...DO_PLAIN, ...DO_NAMED]).join(', ')}.`);
    }
    if (out.do.kind === 'delete' && out.set) fail(i, '', 'set and delete in one op', 'a deleted box keeps nothing; drop one of them.');
  }
  return out;
}

// The parts of `set` that `editBoxes` records: text, style, geometry, tags.
function writeSet(set, matches) {
  const hasBoxPart = set.text != null || set.style || set.geometry || set.tags || 'speaker' in set || set.sizing || 'breaks' in set;
  if (!hasBoxPart) return [];
  const changed = editBoxes(
    matches.map((m) => ({ page: m.page, box: m.box })),
    // Lines held by a lock follow a style change below on their own: the fit
    // keys them to the new face and size (store.svelte.js `keepHeldLines`).
    (b, p) => {
      if (set.tags || 'speaker' in set) {
        const ln = lineByN(p, b.lineN);
        if (set.tags) setLineTags(ln, set.tags);
        // The app's own speaker change: one undo step of its own.
        if ('speaker' in set) setLineSpeaker(p, ln.n, set.speaker);
        // The order placement reads them in: a speaker's voice first on a
        // spoken line, so re-tagging a character's box keeps their font.
        b.style = cloneStyle(styleForLine(withStyleOrder(ln), cloneStyle(b.style)));
      }
      if (set.style) {
        const before = b.style.size;
        const { style, errors } = applyStylePatch(cloneStyle(b.style), set.style);
        if (errors.length) return false;
        b.style = style;
        // A size the agent set is the size the solver aims for: it starts
        // from it and shrinks only as far as the outline needs.
        if ('size' in set.style && b.auto && b.style.size !== before) b.auto.refSize = b.style.size;
      }
      if (set.sizing || 'breaks' in set) {
        if (!b.auto && b.style.size > 0) b.auto = normalizeAuto({ refSize: b.style.size });
      }
      if (set.sizing && b.auto) {
        if (set.sizing.ref != null) {
          b.auto.refSize = set.sizing.ref;
          b.style.size = set.sizing.ref;
        }
        if (set.sizing.min === null) delete b.auto.minSize;
        else if (set.sizing.min != null) b.auto.minSize = set.sizing.min;
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
        // What the agent placed, the solver keeps: the width, the height, the
        // centre (`auto.locks`).
        if (b.auto) {
          if (g.w != null) b.auto.locks.width = true;
          if (g.h != null) b.auto.locks.height = true;
          if (g.x != null || g.y != null) b.auto.locks.pos = true;
        }
        if ('rotation' in set.geometry) {
          const v = set.geometry.rotation;
          const r = isNum(v) ? v : resolveRelative(v, b.style.rotation ?? 0).value;
          b.style.rotation = Math.round((((r % 360) + 540) % 360 - 180) * 100) / 100;
        }
      }
      if (set.text != null) setBoxText(b, set.text, p, { fit: false });
      if ('breaks' in set && b.auto) {
        if (set.breaks === null) {
          delete b.auto.breaks;
          b.auto.locks.breaks = false;
        } else {
          if (b.style.margin == null) b.style.margin = OUTLINE_FIT.margin;
          const st = b.style;
          const brk = breaksFor(applyCase(boxText(b, p), st), st, st.size, set.breaks.map((t) => applyCase(t, st)));
          if (brk) {
            b.auto.breaks = brk;
            b.auto.locks.breaks = true;
          }
        }
      }
    },
    // The AI lays the box out as a placement does (`autoFitBox`).
    { solve: true },
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

// Outline fit on, then laid out again in the outline: the agent's typesetting
// (`do: "typeset"`, and what `place` and `add` do with a new box). `auto`
// also lets every lock and kept line go. Returns the ids that changed.
export function typesetMatches(matches, { auto = false } = {}) {
  const before = new Map(matches.map((m) => [m.box.id, fingerprint(m.box)]));
  editBoxes(
    matches.map((m) => ({ page: m.page, box: m.box })),
    (b) => {
      if (b.style.margin == null) b.style.margin = OUTLINE_FIT.margin;
      // Set in its outline means the outline is used.
      if (b.fit && b.style.balloon === false) b.style.balloon = true;
      if (!auto) return;
      if (!b.auto && b.style.size > 0) b.auto = normalizeAuto({ refSize: b.style.size });
      if (!b.auto) return;
      b.auto.on = true;
      for (const k of LOCK_KEYS) b.auto.locks[k] = false;
      delete b.auto.breaks;
    },
    // The AI lays the box out as a placement does (`autoFitBox`).
    { solve: true },
  );
  for (const m of matches) if (m.box.fit) retypesetBox(m.box.id, m.page);
  return matches.filter((m) => fingerprint(m.box) !== before.get(m.box.id)).map((m) => m.box.id);
}

// One `do`, box by box, through the store's command for it. Returns
// { changed, created, deleted } ids.
function writeDo(d, matches) {
  const changed = [];
  const created = [];
  const deleted = [];
  const unsplit = [];
  const noBalloon = [];
  const shrunk = [];
  if (d.kind === 'approve_outline') {
    const byPage = new Map();
    for (const m of matches) byPage.set(m.page, [...(byPage.get(m.page) ?? []), m.box]);
    for (const [p, boxes] of byPage) {
      // An outline the user approved stays theirs.
      const mine = boxes.filter((b) => b.fit && !b.outline?.approved);
      if (approveBoxes(p, mine, 'ai')) changed.push(...mine.map((b) => b.id));
    }
    return { changed, created, deleted };
  }
  if (d.kind === 'typeset' || d.kind === 'auto') {
    const r = typesetMatches(matches, { auto: d.kind === 'auto' });
    return { changed: r, created, deleted };
  }
  if (d.kind === 'match_original') {
    const noOriginal = [];
    const ids = drawOverArt(matches, (b, p) => {
      const found = d.found?.get(b.id);
      if (found?.fp) return { centre: found.fp.centre, ...matchFor(found.fp, p, { text: boxText(b, p), style: b.style }) };
      noOriginal.push(b.id);
      return lineBlockAt(b, p);
    });
    return { changed: ids, created, deleted, noOriginal };
  }
  if (['preset', 'sfx_kind', 'sfx_pick', 'clear_sfx', 'apply_guide', 'warp'].includes(d.kind)) {
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
        } else if (d.kind === 'sfx_kind') {
          if (b.style.sfx?.on && b.style.sfx.kind === d.type) return false;
          applySfxKind(b.style, d.type);
        } else if (d.kind === 'sfx_pick') {
          // The app's own auto pick (the SFX panel's), from the box's text.
          const pick = sfxPick(boxText(b, p));
          const best = pick?.order?.[0];
          if (!best) return false;
          const dials = Object.fromEntries(['power', 'rough', 'momentum'].map((k) => [k, Math.min(100, Math.max(0, Number(pick[k]) || 50))]));
          if (b.style.sfx?.on && b.style.sfx.kind === best && Object.entries(dials).every(([k, v]) => b.style.sfx[k] === v)) return false;
          applySfxKind(b.style, best);
          Object.assign(b.style.sfx, dials);
        } else if (d.kind === 'clear_sfx') {
          if (!b.style.sfx?.on) return false;
          clearSfx(b.style);
        } else if (d.kind === 'warp') {
          // Built on the box's own rectangle: the mesh is box-local, and a
          // warped box keeps its rectangle from here on (store.svelte.js,
          // "hand-placed"), so the bend stays where it was made.
          if (!d.preset) {
            if (!b.style.warp?.on && !b.style.warp?.pts?.length) return false;
            b.style.warp = { ...b.style.warp, on: false, pts: [] };
          } else {
            const { cols, rows, pts } = warpPresetPts(d.preset, d.amount, b.w, b.h);
            b.style.warp = { on: true, cols, rows, pts };
          }
        } else {
          const ln = b.lineN != null ? lineByN(p, b.lineN) : null;
          if (ln) b.style = cloneStyle(styleForLine(withStyleOrder(ln), cloneStyle(b.style)));
          const text = boxText(b, p);
          const ruled = applyTextRules(text, guide.rules);
          if (ruled !== text) setBoxText(b, ruled, p, { fit: false });
        }
      },
      // The AI lays the box out as a placement does (`autoFitBox`).
      { solve: true },
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
    else if (d.kind === 'refit_outline') {
      if (!refitBalloon(id, p)) noBalloon.push(id);
    }
    else if (d.kind === 'outline_to_box') {
      outlineToBox(id, p);
      // Grown to the size it aims for, the text may still not fit there.
      const ref = refSizeOf(b);
      if (b.auto && b.style.size < ref - 0.01) shrunk.push({ id, size: b.style.size, ref });
    }
    else if (d.kind === 'split_outline') {
      const pts = splitBoxOutline(b, p);
      if (pts) commitOutlinePoints(id, pts, p);
      else unsplit.push(id);
    }
    else if (d.kind === 'free') {
      if (b.style.balloon !== false) toggleBalloonFit(id, p);
      dropBoxOutline(id, p);
    }
    else if (d.kind === 'fit_balloon') {
      if (b.style.balloon === false) toggleBalloonFit(id, p);
      else if (!b.fit && !refitBalloon(id, p)) noBalloon.push(id);
    }
    if (fingerprint(b) !== before) changed.push(id);
  }
  return { changed, created, deleted, unsplit, noBalloon, shrunk };
}

// Boxes drawn over the art rather than set in a balloon (rule C): balloon fit
// off and no outline, no air round the ink (margin 0), and what `at(box,
// page)` gives each: { centre, rotation, size, color, strokes }, any of them.
// A size is the size aimed for, held (a least size a little under it); a
// centre is held where it is put. What `place` does with an SFX, a title or a
// blocky word, and what "match_original" does over the original. Returns the
// ids that changed.
export function drawOverArt(matches, at) {
  const before = new Map(matches.map((m) => [m.box.id, fingerprint(m.box)]));
  for (const { page: p, box: b } of matches) {
    if (b.style.balloon !== false) toggleBalloonFit(b.id, p);
    dropBoxOutline(b.id, p);
  }
  editBoxes(
    matches.map((m) => ({ page: m.page, box: m.box })),
    (b, p) => {
      const a = at(b, p) ?? {};
      b.style.margin = 0;
      if (Number.isFinite(a.rotation)) b.style.rotation = a.rotation;
      if (a.color) {
        b.style.color = a.color;
        b.style.autoContrast = false;
      }
      if (Array.isArray(a.strokes)) b.style.strokes = a.strokes.map((k) => ({ ...k }));
      if (a.size > 0) {
        const size = Math.min(SIZE_RANGE[1], Math.max(SIZE_RANGE[0], a.size));
        b.style.size = size;
        if (!b.auto) b.auto = normalizeAuto({ refSize: size });
        b.auto.refSize = size;
        b.auto.minSize = Math.max(SIZE_RANGE[0], Math.round(size * 0.85 * 2) / 2);
      }
      if (a.centre) {
        resizeBox(p.id, b.id, { x: a.centre[0] - b.w / 2, y: a.centre[1] - b.h / 2 });
        if (b.auto) b.auto.locks.pos = true;
      }
    },
    // The AI lays the box out as a placement does (`autoFitBox`).
    { solve: true },
  );
  return matches.filter((m) => fingerprint(m.box) !== before.get(m.box.id)).map((m) => m.box.id);
}

// Where a box's line was detected: the centre of the block the original sat
// in, for a box with no footprint to go by. Nothing when there is none.
export function lineBlockAt(b, p) {
  const det = b.lineN != null ? (p.detect?.boxes ?? []).find((d) => d.n === b.lineN && Array.isArray(d.box) && d.box.length === 4) : null;
  return det ? { centre: [(det.box[0] + det.box[2]) / 2, (det.box[1] + det.box[3]) / 2] } : {};
}

// The piece of a box's outline that holds its text, cut from a joined bubble
// at the neck (`splitOutline`). The text is where the line was detected, when
// that is inside the outline, else the box; the other lines detected inside
// the outline are the other bubbles' texts. Null when there is nothing to cut.
function splitBoxOutline(b, p) {
  const pts = b.fit ? fitPolygon(b.fit) : null;
  if (!pts) return null;
  const inside = ([x0, y0, x1, y1]) => {
    const x = (x0 + x1) / 2;
    return intervalsAt(pts, (y0 + y1) / 2).some(([l, r]) => x >= l && x <= r);
  };
  const blocks = (p.detect?.boxes ?? []).filter((d) => Array.isArray(d.box) && d.box.length === 4 && inside(d.box));
  const own = blocks.find((d) => d.n === b.lineN)?.box ?? [b.x, b.y, b.x + b.w, b.y + b.h];
  const others = blocks.filter((d) => d.n !== b.lineN).map((d) => d.box);
  return splitOutline(pts, own, others);
}

function runOp(c) {
  // Boxes are named as the document stood when the call came; one an earlier
  // op deleted is gone.
  c.matches = c.matches.filter((m) => m.page.boxes.includes(m.box));
  const ids = new Set();
  const out = { matched: c.matches.length };
  // Lines chosen by hand can cost size: the size each box had before them
  // (unless the same op sets a size, which is the agent's own choice).
  const sizedBefore = c.set?.breaks && !c.set.sizing && c.set.style?.size == null ? new Map(c.matches.map((m) => [m.box.id, m.box.style.size])) : null;
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
    if (r.unsplit?.length) out.notSplit = { ids: r.unsplit, why: 'no neck found in the outline; draw the outline (set.outline) instead' };
    if (r.noOriginal?.length) out.noOriginal = { ids: r.noOriginal, why: 'no original found where the cleaner worked (no cleaned image, or nothing cleaned there): laid on the detected line instead, at its size; turn and colour it by eye (view source "raw")' };
    if (r.shrunk?.length) out.shrunk = { boxes: r.shrunk, why: 'the outline was made for the size each box aims for (ref), and its text still fits only smaller (size): allow it (sizing.min), give the box more room (geometry, then outline_to_box again), or a shorter line' };
    if (r.noBalloon?.length) out.noBalloon = { ids: r.noBalloon, why: 'no balloon found under the box (the box now lays out in a rectangle if it had an outline); draw the outline (set.outline) instead' };
    if (c.do.kind === 'approve_outline') {
      const open = c.matches.filter((m) => !m.box.fit).length;
      if (open) out.notApproved = { count: open, why: 'no outline to approve: draw one (set.outline) or use outline_to_box' };
    }
  }
  if (sizedBefore) {
    const costly = c.matches
      .filter((m) => m.box.style.size < sizedBefore.get(m.box.id) * (1 - BREAKS_COST))
      .map((m) => ({ id: m.box.id, before: sizedBefore.get(m.box.id), size: m.box.style.size }));
    if (costly.length) out.breaksCost = { boxes: costly, why: 'these lines fit only smaller: past a tenth of the size, the smaller voice is worse than the orphan or shape they fix (rule 6). Try other lines - more and shorter in a narrow balloon - or give the choice back (breaks null).' };
  }
  const deleted = new Set(out.deleted ?? []);
  out.changed = [...ids].filter((id) => !deleted.has(id));
  out.outcome = outcomeOf(out);
  return out;
}

// The share of its size a box may give up for lines chosen by hand before the
// result says so (instructions rule 6).
const BREAKS_COST = 0.1;

// What an op came to, in words that cannot be mistaken: an empty `changed`
// alone is three different answers (the boxes already were so, the app
// refused, or there were no boxes).
const REFUSALS = ['notLockable', 'notApproved', 'notSplit', 'noBalloon'];
function outcomeOf(out) {
  if (!out.matched) return 'nothing matched';
  const did = out.changed.length || out.created?.length || out.deleted?.length;
  const refused = REFUSALS.some((k) => out[k]);
  if (did) return refused ? 'changed some' : 'changed';
  return refused ? 'refused' : 'nothing needed';
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

// The checks for the changed (and created) boxes, and their fit in numbers.
export const checksOf = (ids) => (ids.length ? checksFor(matchesOf(ids)) : []);
export const fitsFor = (ids) => (ids.length ? fitsOf(matchesOf(ids)) : []);

defineTool({
  name: 'edit',
  description: DESCRIPTION,
  input,
  write: true,
  async run({ ops, dryRun = false }, ctx) {
    if (!Array.isArray(ops) || !ops.length) throw new ToolError('ops must be a non-empty list', 'Use ops: [{ where: { selection: true }, set: { style: { size: "+2" } } }].');
    if (ops.length > MAX_OPS) throw new ToolError(`at most ${MAX_OPS} ops in one call`, 'Split the work, or use wider selectors.');
    if (isTranslateMode()) throw new ToolError('this chapter is in translate mode and has no boxes to edit');
    const compiled = ops.map(compile);
    if (dryRun) return { dryRun: true, ops: compiled.map((c) => ({ matched: c.matches.length, ids: c.matches.slice(0, 50).map((m) => m.box.id) })) };
    // The originals "match_original" lays boxes over are read off the page
    // images first, where the boxes stand now; then everything is written in
    // one synchronous step.
    for (const c of compiled) {
      if (c.do?.kind !== 'match_original') continue;
      c.do.found = new Map();
      for (const m of c.matches) c.do.found.set(m.box.id, await footprintIn(m.page, footprintRegion(m.page, m.box), m.box));
    }
    if (compiled.some((c) => c.do?.found) && !ctx.stillPinned()) throw new ToolError('the chapter changed in the app, so nothing was changed');
    const pages = [...new Set(compiled.flatMap((c) => c.matches.map((m) => m.page)))];
    if (!pages.length) return { ops: compiled.map(() => ({ matched: 0, changed: [], outcome: 'nothing matched' })), note: 'nothing matched; fix the where and call again' };
    const results = ctx.write(pages, () => compiled.map(runOp));
    return {
      ops: results.map((r) => {
        const ids = [...r.changed, ...(r.created ?? [])];
        const fit = fitsFor(ids);
        return { ...r, checks: checksOf(ids), ...(fit.length ? { fit } : null) };
      }),
      // The setup comes first (instructions.js): a reminder, never a refusal,
      // since a user may ask for one quick change before any setup.
      ...(guideBound() && !letteringSetUp(guide.lettering)
        ? { lettering: 'not set up: before lettering more, ask the user the lettering get questions and save them with lettering set' }
        : null),
    };
  },
});
