// Special effects (plan 8, unit B4): Crack, Lightning, Splash and Scratches.
//
// Each is a seeded generator in the Rust engine (text-engine/src/paint/
// special.rs): only these numbers go to the painter, in the glyph job
// (wire v15), and the engine makes the shapes from them. A pattern is laid
// over the whole box, never restarted per letter, and the same seed gives
// the same picture wherever the box stands.
//
//   crack      cuts branching jagged lines out of the letters; past 60 % the
//              pieces between two arms fall out. `x`, `y` (percents of the
//              letters' ink box) is where they gather, `spread` how far: 100
//              spreads them over every letter, less pulls them in
//   lightning  paints jagged bolts with forks on the letters' fill: a `core`
//              colour inside a `glow` colour, `glowSize` wide
//   splash     paints spiky splats, teardrop droplets and streaks in its
//              own `color` on the letters' fill; nothing goes past the fill
//   scratches  cuts many thin, near-parallel strokes
//
// Amounts are percents, sizes percents of the font size, angles degrees
// (0 runs along the line), seeds 0 to 999. Painted by the Rust engine only.
//
// Known limit: the pattern is laid over the letters' ink box, so it is
// redrawn when the text or the box size changes; Seed re-rolls it.
//
// A crack or scratches cut the box's own strokes through as they cut a
// glyph band: one look whatever stroke the box has.

const HEX = /^#[0-9a-f]{6}$/i;

export const SPECIAL_KINDS = ['crack', 'lightning', 'splash', 'scratches'];

export const SPECIAL_SIZE_MIN = 10;
export const SPECIAL_SIZE_MAX = 400;
// The lightning's glow, percents of its default (0: none).
export const SPECIAL_GLOW_MAX = 300;

export function defaultSpecial() {
  return {
    crack: { on: false, amount: 40, size: 100, x: 50, y: 50, spread: 100, seed: 1 },
    lightning: { on: false, amount: 40, core: '#ffffff', glow: '#1e90ff', glowSize: 100, seed: 1 },
    splash: { on: false, amount: 40, size: 100, color: '#e63946', seed: 1 },
    scratches: { on: false, amount: 40, angle: -15, seed: 1 },
  };
}

const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const within = (v, d, lo, hi) => Math.min(hi, Math.max(lo, num(v, d)));
const seedOf = (v, d) => Math.round(within(v, d, 0, 999));
// An angle, degrees, within half a turn either way of 0 (as the dial gives
// it).
const angleOf = (v, d) => within(v, d, -180, 180);
const colourOf = (v, d) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d);

// The special effects as this build reads them. A lightning saved with one
// `color` (before its core and glow) keeps it as its glow.
export function normalizeSpecial(src) {
  const d = defaultSpecial();
  const s = src && typeof src === 'object' ? src : {};
  const amount = (o, k) => within(o?.amount, d[k].amount, 0, 100);
  const size = (o, k) => within(o?.size, d[k].size, SPECIAL_SIZE_MIN, SPECIAL_SIZE_MAX);
  return {
    crack: {
      on: s.crack?.on === true,
      amount: amount(s.crack, 'crack'),
      size: size(s.crack, 'crack'),
      x: within(s.crack?.x, d.crack.x, 0, 100),
      y: within(s.crack?.y, d.crack.y, 0, 100),
      spread: within(s.crack?.spread, d.crack.spread, 0, 100),
      seed: seedOf(s.crack?.seed, d.crack.seed),
    },
    lightning: {
      on: s.lightning?.on === true,
      amount: amount(s.lightning, 'lightning'),
      core: colourOf(s.lightning?.core, d.lightning.core),
      glow: colourOf(s.lightning?.glow, colourOf(s.lightning?.color, d.lightning.glow)),
      glowSize: within(s.lightning?.glowSize, d.lightning.glowSize, 0, SPECIAL_GLOW_MAX),
      seed: seedOf(s.lightning?.seed, d.lightning.seed),
    },
    splash: {
      on: s.splash?.on === true,
      amount: amount(s.splash, 'splash'),
      size: size(s.splash, 'splash'),
      color: colourOf(s.splash?.color, d.splash.color),
      seed: seedOf(s.splash?.seed, d.splash.seed),
    },
    scratches: { on: s.scratches?.on === true, amount: amount(s.scratches, 'scratches'), angle: angleOf(s.scratches?.angle, d.scratches.angle), seed: seedOf(s.scratches?.seed, d.scratches.seed) },
  };
}

// The effects of `style` that draw something: on, with an amount.
export function shownSpecial(style) {
  const sp = style?.special;
  if (!sp) return [];
  return SPECIAL_KINDS.filter((k) => sp[k]?.on === true && sp[k].amount > 0);
}

// Whether any special effect draws on this style.
export function specialActive(style) {
  return shownSpecial(style).length > 0;
}

// The glyph job's `special` (paint.mjs, wire v15) for a box whose frame is
// `rect` in the job's coordinates, or null when none draws. Shares and
// radians, as the engine reads them.
export function specialJob(style, rect) {
  const shown = shownSpecial(style);
  if (!shown.length) return null;
  const sp = style.special;
  const rad = (deg) => (deg * Math.PI) / 180;
  const out = { rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h } };
  for (const k of shown) {
    const e = sp[k];
    const base = { amount: e.amount / 100, seed: e.seed };
    if (k === 'crack') out[k] = { ...base, size: e.size / 100, x: e.x / 100, y: e.y / 100, spread: e.spread / 100 };
    else if (k === 'splash') out[k] = { ...base, size: e.size / 100, color: e.color };
    else if (k === 'lightning') out[k] = { ...base, core: e.core, glow: e.glow, glowSize: e.glowSize / 100 };
    else out[k] = { ...base, angle: rad(e.angle) };
  }
  return out;
}
