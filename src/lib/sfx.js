// ===== SFX lettering: the JS side of the engine's sound types =====
//
// SFX is a fourth glyph-by-glyph layout, beside the arc, the ring and the path
// (measure.js). The Rust engine computes it (`sfxPlace`, text-engine/src/sfx/):
// the text's groups (its lines, and the sides of a `/`) each run along a path,
// every letter sized, turned, leaned and kerned by its ink. One of the
// engine's twelve sound types (`sfxKinds`) gives every number the box leaves
// unset (null), and the look the type is drawn with.
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

import { textEngine } from './text-engine/index.js';
import { faceFor } from './measure.js';
import { normalizeSfx, normalizeStyle } from './data.js';
import { findTag } from './tags.svelte.js';

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

// Every type ranked for `text` (auto pick), best first, and the strength the
// sound asks for; null without the engine.
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

// Every layout number of `sfx`, the type's where the box leaves it null.
export function sfxResolved(sfx) {
  const k = sfxKind(sfx?.kind) ?? {};
  return {
    vertical: (sfx?.dir ?? k.dir ?? 'h') === 'v',
    flow: sfx?.flow ?? k.flow ?? { from: 1, to: 1, pow: 1 },
    follow: sfx?.follow ?? k.follow ?? 0.5,
    gap: sfx?.gap ?? k.gap ?? 0,
    bigTighter: sfx?.bigTighter ?? 0.5,
    slant: sfx?.slant ?? k.slant ?? 0,
    rise: sfx?.rise ?? k.rise ?? 0,
    jitter: sfx?.jitter ?? k.jitter ?? { rot: 0, size: 0, off: 0 },
  };
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

export function sfxParams(sfx) {
  return {
    ...sfxResolved(sfx),
    joinBars: sfx.joinBars !== false,
    kern: sfx.kern !== false,
    seed: sfx.seed,
    kind: sfxKind(sfx.kind) ? sfx.kind : null,
    strength: sfx.strength,
    paths: sfx.paths,
    edits: sfxEdits(sfx.glyphs),
  };
}

// ---- the layout ----

// Whether the engine's refusal of a layout has been said (below).
let refused = false;
const placed = new Map();
const PLACED_MAX = 96;

// The engine's placement of `text` at `sizePx`, or null when the style is not
// SFX: `{ letters, paths, bounds }` as `sfxPlace` gives it. Kept for the last
// few recipes asked, so a box drawn, measured and hit-tested in one frame is
// laid out once.
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

// How much wider than at the face's size a letter's outlines are: its scale
// to the 0.4, so small letters do not get fat rims.
export const letterPen = (sx, sy) => Math.max(0.01, Math.min(100, Math.sqrt(Math.abs(sx * sy)) ** 0.4));

// The layout for the (already case-applied) `text` at `sizePx`, or [] when the
// style is not SFX. One entry per code point of `text`, newlines included: the
// other curves give one, and what reads them by index (the caret on a curve,
// the borrowed letters of a run) counts on it.
export function sfxLayout(text, style, sizePx) {
  const p = sfxPlacement(text, style, sizePx);
  if (!p) return [];
  const s = String(text);
  const starts = new Map(p.letters.map((l) => [l.start, l]));
  const out = [];
  let u = 0;
  let last = null;
  for (const ch of s) {
    const l = starts.get(u);
    if (l) {
      out.push({
        ch: s.slice(l.start, l.end),
        x: l.x, y: l.y, rot: l.rot, sx: l.sx, sy: l.sy, skew: l.skew,
        w: l.adv, drip: 0,
        group: l.group, index: l.index, dir: l.dir, em: l.em, pen: letterPen(l.sx, l.sy),
      });
      last = l;
    } else {
      out.push({ ch: '', x: last?.x ?? 0, y: last?.y ?? 0, rot: last?.rot ?? 0, sx: 1, sy: 1, skew: 0, w: 0, drip: 0 });
    }
    u += ch.length;
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

// The style fields a type's look writes. Remove SFX puts them back.
const LOOK_KEYS = ['font', 'color', 'gradient', 'pattern', 'noFill', 'strokes', 'strokeJoin', 'negative'];

// A plain copy of a value that may be a Svelte state proxy (`structuredClone`
// refuses a proxy).
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const gray = (v) => {
  const c = Math.round(255 * (1 - Math.min(1, Math.max(0, v))));
  const h = c.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
};

// Writes the type's look onto `style`: the fill, the outlines and the
// corners, and the font of the type's lettering tag when the series has set
// one.
export function applyLook(style, kind) {
  const look = kind?.look;
  if (!look) return;
  const ink = '#111111';
  const fill = look.fill ?? { type: 'solid' };
  style.noFill = false;
  style.gradient = { ...plain(style.gradient), on: false };
  style.pattern = { ...plain(style.pattern), on: false };
  style.negative = { ...plain(style.negative), on: false };
  style.color = ink;
  if (fill.type === 'white') style.color = '#ffffff';
  else if (fill.type === 'gray') style.color = gray(fill.gray ?? 0.5);
  else if (fill.type === 'tone' || fill.type === 'gradTone') {
    const density = fill.type === 'tone' ? fill.density : Math.max(fill.from, fill.to);
    style.pattern = {
      ...style.pattern,
      on: true,
      kind: 'dots',
      fg: ink,
      bg: '#ffffff',
      density: Math.min(1, Math.max(0, density ?? 0.5)),
      fade: fill.type === 'gradTone'
        ? { on: true, angle: fill.angle ?? 90, from: Math.min(fill.from, fill.to) / (density || 1), to: 1 }
        : { ...style.pattern.fade, on: false },
    };
  } else if (fill.type === 'negative') {
    style.color = '#ffffff';
    style.negative = { on: true, grow: fill.grow ?? 0.15, color: ink };
  }
  // The box's strokes are bands from the letter out, innermost first, each
  // its own width (text-paint.js `strokeBands`), as the table has them.
  style.strokes = (look.outlines ?? []).map((o) => ({
    color: o.color,
    width: Math.round(o.width * style.size * 10) / 10,
    opacity: 1,
  }));
  style.strokeJoin = look.sharp ? 'miter' : 'round';
  const font = findTag(kind.tag)?.style?.font;
  if (typeof font === 'string' && font) style.font = font;
}

// Mutates `style` to the sound type `id`: its layout (every number back to
// the type's), its look, and SFX on. The seed, the strength, the caption and
// the box's own text, place and size stay. What it writes over is kept in
// `sfx.before`, taken once, when SFX goes on, so a second type is laid over
// the first one's look and Remove SFX still finds the box's own.
export function applySfxKind(style, id) {
  const kind = sfxKind(id);
  if (!kind) return false;
  const before = style.sfx?.on && style.sfx.before
    ? plain(style.sfx.before)
    : {
        curve: style.curve,
        circle: !!style.circle?.on,
        path: !!style.path?.on,
        look: Object.fromEntries(LOOK_KEYS.map((k) => [k, plain(style[k])])),
      };
  style.sfx = normalizeSfx({
    on: true,
    kind: id,
    seed: style.sfx?.seed,
    strength: style.sfx?.strength,
    joinBars: style.sfx?.joinBars,
    kern: style.sfx?.kern,
    caption: plain(style.sfx?.caption),
    before,
  });
  applyLook(style, kind);
  enableSfx(style);
  return true;
}

// A recipe pasted from another box (`pasteStyle`) carries what SFX wrote over
// on THAT box (`sfx.before`). The paste does not move a box's own geometry:
// what Remove SFX puts back of its bends is this box's.
export function rebaseSfx(style) {
  const before = style?.sfx?.before;
  if (!before) return;
  before.path = !!style.path?.on;
}

// Switches SFX off and puts back what applying a type wrote over: the look
// and the bends SFX switched off. `keepBends` leaves the arc, the ring and the
// path as they are now, for a caller that is switching one of them on.
export function clearSfx(style, keepBends = false) {
  const before = style.sfx.before;
  if (before) {
    if (before.look) {
      const back = normalizeStyle({ ...plain(style), ...before.look });
      for (const k of LOOK_KEYS) if (k in before.look) style[k] = back[k];
    }
    if (!keepBends) {
      style.curve = before.curve;
      style.circle.on = before.circle;
      style.path.on = before.path;
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

// The point a path's bend is dragged by: the middle of the curve (half way
// from the chord's middle to the control point), so the handle sits on the
// line it bends. In the units of the path.
export function bendHandle(path) {
  const [ax, ay] = path.a;
  const [bx, by] = path.b;
  const k = (path.bend ?? 0) / 2;
  return [(ax + bx) / 2 - (by - ay) * k, (ay + by) / 2 + (bx - ax) * k];
}

// The bend that puts the curve's middle at `pt`: the reverse of `bendHandle`,
// the share of the chord `pt` sits off its middle, on the engine's side (the
// control point is the middle plus `bend` times the chord turned a quarter,
// text-engine/src/sfx/path.rs). Kept to the range data.js allows.
export function bendFor(path, pt) {
  const [ax, ay] = path.a;
  const [bx, by] = path.b;
  const nx = -(by - ay);
  const ny = bx - ax;
  const len2 = nx * nx + ny * ny;
  if (!(len2 > 1e-12)) return 0;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const bend = (2 * ((pt[0] - mx) * nx + (pt[1] - my) * ny)) / len2;
  return Math.min(2, Math.max(-2, Math.round(bend * 1000) / 1000));
}
