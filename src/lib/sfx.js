// ===== SFX lettering: the JS side of the engine's sound types =====
//
// SFX is a fourth glyph-by-glyph layout, beside the arc, the ring and the path
// (measure.js). The Rust engine computes it (`sfxPlace`, text-engine/src/sfx/):
// the text's groups (its lines, and the sides of a `/`) each run along a path,
// every letter sized, turned, leaned and kerned by its ink. One of the
// engine's twelve sound types (`sfxKinds`) gives every number the box leaves
// unset (null). A type is a layout only: the box keeps its own look.
//
//   layout   [{ ch, x, y, rot, sx, sy, skew, w, ... }], one per code point of
//            the text, positions in px from the box centre, `rot` and `skew`
//            in radians, `sx`/`sy` the glyph's own scale. The same shape the
//            other curves give, plus the three, so everything that reads a
//            curve's layout reads this one. A letter that draws several code
//            points (a voiced mark, a run of long bars, `!!`) is the first of
//            them; the rest, and what the engine does not draw (a space, the
//            `/` between groups, a newline), draw nothing (`ch: ''`) and sit
//            where the letter before them sits.
//
// It works ONLY with the Rust engine. `sfxActive` is false under the browser
// engine, and every reader in the app asks that one question: an SFX style
// under the browser engine is plain text.
//
// Every number is the engine's: what a type and the macros make of the box's
// unset fields (`sfxResolved`), where each letter is and its ink box, and the
// handles' maths (`sfxHit`, `sfxTurn`, `sfxScale`, `sfxMove`, `sfxBendFor`,
// `sfxCurve`). This file only forwards the box's recipe and hands back what
// comes out; without the engine those calls answer null.

import { textEngine } from './text-engine/index.js';
import { faceFor } from './measure.js';
import { normalizeSfx, normalizeStyle } from './data.js';

export function sfxAvailable() {
  return typeof textEngine()?.sfxPlace === 'function';
}

// Whether a style is laid out as SFX right now.
export function sfxActive(style) {
  return !!style?.sfx?.on && sfxAvailable();
}

// ---- the engine's table of sound types ----
//
// Asked once per engine and kept BY the engine, weakly: an engine the app has
// let go of is not held alive by its table.
const NO_KINDS = Object.freeze([]);
const kindsOf = new WeakMap();

export function sfxKinds() {
  const e = textEngine();
  if (!e || typeof e.sfxKinds !== 'function') return NO_KINDS;
  let kinds = kindsOf.get(e);
  if (!kinds) {
    const got = e.sfxKinds();
    kinds = Array.isArray(got?.kinds) ? got.kinds : NO_KINDS;
    kindsOf.set(e, kinds);
  }
  return kinds;
}

export const sfxKind = (id) => sfxKinds().find((k) => k.id === id) ?? null;

// Every type ranked for `text` (auto pick), best first, and the three macros
// the sound asks for (`{ order, scores, power, rough, momentum }`); null
// without the engine.
export function sfxPick(text) {
  const e = textEngine();
  if (typeof e?.sfxPick !== 'function') return null;
  try {
    const got = e.sfxPick(String(text ?? ''));
    return Array.isArray(got?.order) ? got : null;
  } catch {
    return null;
  }
}

// ---- the recipe as the engine reads it ----

// Every layout number of `sfx` as the layout will use it: `{ vertical,
// flow: { from, to, pow }, follow, gap, bigTighter, slant, rise,
// jitter: { rot, size, off } }`. The engine fills each the box leaves null
// from the type, moved by the macros; null without the engine.
export function sfxResolved(sfx) {
  const e = textEngine();
  if (!sfx || typeof e?.sfxResolve !== 'function') return null;
  try {
    return e.sfxResolve(sfxParams(sfx));
  } catch {
    return null;
  }
}

// The hand edits of `glyphs` (`{ 'g:i': { dx, dy, rot, s } }`) as the engine's.
export function sfxEdits(glyphs) {
  const out = [];
  for (const [key, g] of Object.entries(glyphs ?? {})) {
    const [group, index] = key.split(':').map(Number);
    out.push({ group, index, dx: g.dx ?? 0, dy: g.dy ?? 0, rot: g.rot ?? 0, scale: g.s ?? 1 });
  }
  return out;
}

// The box's recipe as the engine takes it. What the box leaves null goes as
// null, and the engine fills it from the type: no type default is copied here.
export function sfxParams(sfx) {
  return {
    vertical: sfx.dir == null ? null : sfx.dir === 'v',
    joinBars: sfx.joinBars !== false,
    kern: sfx.kern !== false,
    seed: sfx.seed,
    kind: sfxKind(sfx.kind) ? sfx.kind : null,
    power: sfx.power ?? null,
    rough: sfx.rough ?? null,
    momentum: sfx.momentum ?? null,
    flow: sfx.flow ?? null,
    follow: sfx.follow ?? null,
    gap: sfx.gap ?? null,
    bigTighter: sfx.bigTighter ?? null,
    slant: sfx.slant ?? null,
    rise: sfx.rise ?? null,
    jitter: sfx.jitter ?? null,
    paths: sfx.paths ?? [],
    edits: sfxEdits(sfx.glyphs),
  };
}

// ---- the layout ----

// Whether the engine's refusal of a layout has been said (below).
let refused = false;
const placed = new Map();
const PLACED_MAX = 96;

// The engine's placement of `text` at `sizePx`, or null when the style is not
// SFX: `{ letters, paths, bounds, cp }` as `sfxPlace` gives it
// (text-engine/js/engine.mjs: each letter's place and ink `quad`, each
// path's `ctrl` and `mid`). Kept for the last few recipes asked, so a box
// drawn, measured and hit-tested in one frame is laid out once.
export function sfxPlacement(text, style, sizePx) {
  if (!text || !(sizePx > 0) || !(style?.size > 0) || !sfxActive(style)) return null;
  const face = faceFor(style, sizePx);
  const params = sfxParams(style.sfx);
  const key = JSON.stringify([text, face, params]);
  const hit = placed.get(key);
  if (hit) {
    placed.delete(key);
    placed.set(key, hit);
    return hit;
  }
  let got;
  try {
    got = textEngine().sfxPlace(face, String(text), params);
  } catch (error) {
    // The engine refuses a recipe or a size it cannot answer for. A layout
    // that threw would take the box's whole placement with it (and the page's
    // relayout): the box is left with no letters, and the engine's reason is
    // said once.
    if (!refused) console.error('SFX layout refused by the text engine:', error);
    refused = true;
    return null;
  }
  placed.set(key, got);
  if (placed.size > PLACED_MAX) placed.delete(placed.keys().next().value);
  return got;
}

// The layout for the (already case-applied) `text` at `sizePx`, or [] when the
// style is not SFX. One entry per code point of `text`, newlines included: the
// other curves give one, and what reads them by index (the caret on a curve,
// the borrowed letters of a run) counts on it.
export function sfxLayout(text, style, sizePx) {
  const p = sfxPlacement(text, style, sizePx);
  if (!p) return [];
  const s = String(text);
  const out = [];
  let last = null;
  // `cp` has one entry per code point: the letter that draws it, or -1. A
  // placement without one has no letters to draw.
  for (const i of p.cp ?? []) {
    const l = p.letters[i];
    if (l) {
      out.push({
        ch: s.slice(l.start, l.end),
        x: l.x, y: l.y, rot: l.rot, sx: l.sx, sy: l.sy, skew: l.skew,
        w: l.adv, drip: 0,
        group: l.group, index: l.index, dir: l.dir, em: l.em, pen: l.pen,
      });
      last = l;
    } else {
      out.push({ ch: '', x: last?.x ?? 0, y: last?.y ?? 0, rot: last?.rot ?? 0, sx: 1, sy: 1, skew: 0, w: 0, drip: 0 });
    }
  }
  return out;
}

// ---- applying a type ----

// SFX is one glyph layout among four, and the others are switched off when it
// is switched on, so the Inspector does not show an arc that has no effect.
export function enableSfx(style) {
  style.sfx.on = true;
  style.curve = 0;
  style.circle.on = false;
  style.path.on = false;
}

// A plain copy of a value that may be a Svelte state proxy (`structuredClone`
// refuses a proxy).
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// What Remove SFX puts back (`sfx.before`): taken once, when SFX goes on.
// The bends SFX switches off, and with `box` the whole look and the box's
// width and height, so the box comes back as it was in every way.
function beforeSfx(style, box) {
  if (style.sfx?.on && style.sfx.before) return plain(style.sfx.before);
  const out = { curve: style.curve, circle: !!style.circle?.on, path: !!style.path?.on };
  if (box) {
    const { sfx, ink, ...look } = plain(style);
    out.look = look;
    out.box = { w: box.w, h: box.h };
  }
  return out;
}

// A fresh recipe with SFX on: `kind` (null for none), the seed and the
// caption kept, every layout number unset, the dials at 50, no paths and no
// letter hand edits.
function freshSfx(style, kind, box) {
  style.sfx = normalizeSfx({
    on: true,
    kind,
    seed: style.sfx?.seed,
    caption: plain(style.sfx?.caption),
    before: beforeSfx(style, box),
  });
  enableSfx(style);
}

// Mutates `style` to the sound type `id`, as the reference's preset click
// does (docs/giongo/04-reference-controls.md 1.7) less the look: a fresh
// recipe of that type with SFX on, every layout number unset (the type's),
// the macros at 50, the paths the type's own (none stored), no letter hand
// edits, the switches back on. Only the seed, the caption and `sfx.before`
// stay. A type is a layout and nothing else: the box's font, fill, outlines,
// corners and effects are the user's and are not touched. `box`, when SFX is
// going on for a box that exists, is what Remove SFX puts its size back to.
export function applySfxKind(style, id, box = null) {
  const kind = sfxKind(id);
  if (!kind) return false;
  freshSfx(style, id, box);
  return true;
}

// SFX on with no sound type: the letters one by one in a plain row (or along
// the paths the box is given), every letter control there to use. A box that
// is SFX already keeps its recipe.
export function startSfx(style, box = null) {
  if (style.sfx?.on) return false;
  freshSfx(style, null, box);
  return true;
}

// The type off, the box still SFX: its layout numbers back to plain.
export function clearSfxKind(style) {
  if (!style.sfx?.on || style.sfx.kind == null) return false;
  freshSfx(style, null, null);
  return true;
}

// A recipe pasted from another box (`pasteStyle`) carries what SFX wrote over
// on THAT box (`sfx.before`). The paste does not move a box's own geometry:
// what Remove SFX puts back of its bends is this box's.
export function rebaseSfx(style) {
  const before = style?.sfx?.before;
  if (!before) return;
  before.path = !!style.path?.on;
  // The look and the size were that box's, not this one's.
  delete before.look;
  delete before.box;
}

// Switches SFX off and puts the box back as it was before SFX went on: its
// whole look, its width and height (about its centre, so a box moved while it
// was SFX stays where it was moved to) and the bends SFX switched off.
// `keepBends` only switches SFX off, for a caller that is switching an arc, a
// ring or a path on: that edit is the user's, so nothing is put back. `box`
// is the box the style belongs to, for its size.
export function clearSfx(style, keepBends = false, box = null) {
  const before = style.sfx.before;
  if (before && !keepBends) {
    if (before.look) {
      const back = normalizeStyle({ ...plain(style), ...before.look, sfx: plain(style.sfx), ink: plain(style.ink) });
      for (const k of Object.keys(before.look)) if (k in back) style[k] = back[k];
    }
    style.curve = before.curve;
    style.circle.on = before.circle;
    style.path.on = before.path;
    if (box && before.box) {
      box.x += (box.w - before.box.w) / 2;
      box.y += (box.h - before.box.h) / 2;
      box.w = before.box.w;
      box.h = before.box.h;
    }
  }
  style.sfx.on = false;
  style.sfx.before = null;
}

// ---- for the SFX tool, the panel and the canvas handles ----

// Kana or kanji: a source that reads as Japanese.
const JP = /[぀-ヿㇰ-ㇿ㐀-鿿ｦ-ﾟ]/;
export const looksJapanese = (s) => JP.test(String(s ?? ''));

// What auto pick reads for a box: the Japanese sound it was read from when its
// line has one (the type table is built on kana), the box's own text when not.
export const sfxPickText = (text, jp) => (looksJapanese(jp) ? String(jp) : String(text ?? ''));

// The sound a new SFX box says when the queue has no line for it: a Japanese
// one over a Japanese page, an English one otherwise.
export const sfxDefaultText = (jpSource) => (jpSource ? 'ドン!!' : 'BOOM!!');

// ---- the handles' maths, the engine's (text-engine/src/sfx/gizmo.rs) ----
//
// Each is null without the engine. Points are px in the frame the letters
// were placed in (`sfxPlacement` at the size on screen), except a path's,
// which are its own ems.

// The engine's, or null.
function engineCall(name, ...args) {
  const e = textEngine();
  if (typeof e?.[name] !== 'function') return null;
  try {
    return e[name](...args);
  } catch {
    return null;
  }
}

// The letter at `x, y`: the index into `letters` (sfxPlacement's) of the
// topmost whose ink quad holds the point, else of the nearest within `slop`
// px, else -1.
export const sfxHit = (letters, x, y, slop = 0) => (letters?.length ? engineCall('sfxHit', letters, x, y, slop) : -1);

// One pointer move on the ring, Blender style: `{ total, shown }`. Hand the
// previous pointer point as `from` and the last `total` back each move (start
// it at the letter's turn at grab): the total counts on past half a turn.
// `shown` is what the letter's edit stores: whole degrees, -180..180,
// clockwise positive, snapped to `snapDeg` when above 0 (Shift: 15).
export const sfxTurn = (centre, from, to, total, snapDeg = 0) => engineCall('sfxTurn', centre, from, to, total, snapDeg);

// One pointer move on the scale handle: `startScale` times the distance from
// `centre` now over at grab, 0.2..5, two decimals, steps of 0.05 with `snap`.
export const sfxScale = (centre, start, now, startScale, snap = false) => engineCall('sfxScale', centre, start, now, startScale, snap);

// One pointer move dragging a letter: its edit's `[dx, dy]` in its own ems
// (three decimals) from `[startDx, startDy]` at grab. Pass the letter from
// `sfxPlacement` (its `unit`, the em its edit is in), not its `em`.
export const sfxMove = (letter, start, now, startDx, startDy) => engineCall('sfxMove', letter, start, now, startDx, startDy);

// The bend (-2..2, three decimals) that puts the middle of `path`'s curve
// nearest `pt`, both in the path's ems.
export const sfxBendFor = (path, pt) => engineCall('sfxBendFor', path, pt);

// `path`'s curve in its ems: `{ ctrl, mid }`, the control point the overlay
// draws it with and its middle, where the bend handle sits. A placed path
// (`sfxPlacement(...).paths`) has both already.
export const sfxCurve = (path) => engineCall('sfxCurve', path);

// The bend handle's place (the curve's middle) and the bend for a handle
// dragged to `pt`: the old names of `sfxCurve(path).mid` and `sfxBendFor`.
export const bendHandle = (path) => sfxCurve(path)?.mid ?? null;
export const bendFor = sfxBendFor;

// The outline of letter `index` (into `sfxPlacement(...).letters`) as an SVG
// path `d`, holes included, px from the box's centre at `sizePx`: the picked
// letter's highlight. '' when the style is not SFX or without the engine.
let outlineMemo = { key: '', d: '' };
export function sfxOutline(text, style, sizePx, index) {
  if (!text || !(sizePx > 0) || !(style?.size > 0) || !sfxActive(style) || !(index >= 0)) return '';
  const face = faceFor(style, sizePx);
  const params = sfxParams(style.sfx);
  const key = JSON.stringify([text, face, params, index]);
  if (outlineMemo.key === key) return outlineMemo.d;
  const d = engineCall('sfxOutline', face, String(text), params, index) ?? '';
  outlineMemo = { key, d };
  return d;
}
