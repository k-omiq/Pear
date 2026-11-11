// Special effects (plan 8, unit B4): Crack, Lightning, Splash and Scratches.
//
// Each is a seeded generator in the Rust engine (text-engine/src/paint/
// special.rs): only these numbers go to the painter, in the glyph job
// (wire v14), and the engine makes the shapes from them. A pattern is laid
// over the whole box, never restarted per letter, and the same seed gives
// the same picture wherever the box stands.
//
//   crack      cuts branching jagged lines out of the letters; past 60 % the
//              pieces between two arms fall out
//   lightning  paints jagged bolts with branches and a soft halo on the
//              letters' fill, in a colour of its own
//   splash     adds blobs and droplets round the letters, which the strokes
//              and shadows wrap, and cuts spatter holes in them
//   scratches  cuts many thin, near-parallel strokes
//
// Amounts are percents, sizes percents of the font size, angles degrees
// (0 runs along the line), seeds 0 to 999. Painted by the Rust engine only.

const HEX = /^#[0-9a-f]{6}$/i;

export const SPECIAL_KINDS = ['crack', 'lightning', 'splash', 'scratches'];

export const SPECIAL_SIZE_MIN = 10;
export const SPECIAL_SIZE_MAX = 400;

// How far a splash reaches past the letters' ink, in its size times the font
// size: the farthest droplet's edge (`SPLASH_REACH` in special.rs).
export const SPLASH_REACH = 1.2;

export function defaultSpecial() {
  return {
    crack: { on: false, amount: 40, size: 100, seed: 1 },
    lightning: { on: false, amount: 40, angle: 20, color: '#1e90ff', seed: 1 },
    splash: { on: false, amount: 40, size: 100, seed: 1 },
    scratches: { on: false, amount: 40, angle: -15, seed: 1 },
  };
}

const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const within = (v, d, lo, hi) => Math.min(hi, Math.max(lo, num(v, d)));
const seedOf = (v, d) => Math.round(within(v, d, 0, 999));
// An angle, degrees, within half a turn either way of 0 (as the dial gives
// it).
const angleOf = (v, d) => within(v, d, -180, 180);

// The special effects as this build reads them.
export function normalizeSpecial(src) {
  const d = defaultSpecial();
  const s = src && typeof src === 'object' ? src : {};
  const amount = (o, k) => within(o?.amount, d[k].amount, 0, 100);
  const size = (o, k) => within(o?.size, d[k].size, SPECIAL_SIZE_MIN, SPECIAL_SIZE_MAX);
  return {
    crack: { on: s.crack?.on === true, amount: amount(s.crack, 'crack'), size: size(s.crack, 'crack'), seed: seedOf(s.crack?.seed, d.crack.seed) },
    lightning: {
      on: s.lightning?.on === true,
      amount: amount(s.lightning, 'lightning'),
      angle: angleOf(s.lightning?.angle, d.lightning.angle),
      color: typeof s.lightning?.color === 'string' && HEX.test(s.lightning.color) ? s.lightning.color.toLowerCase() : d.lightning.color,
      seed: seedOf(s.lightning?.seed, d.lightning.seed),
    },
    splash: { on: s.splash?.on === true, amount: amount(s.splash, 'splash'), size: size(s.splash, 'splash'), seed: seedOf(s.splash?.seed, d.splash.seed) },
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

// How far past the letters' ink a style's special effects draw, page px at
// the style's size: a splash's farthest droplet. The rest cut or paint
// inside the letters.
export function specialReach(style) {
  const sp = style?.special?.splash;
  if (!sp?.on || !(sp.amount > 0)) return 0;
  return SPLASH_REACH * (sp.size / 100) * (Number(style.size) || 0);
}

// The glyph job's `special` (paint.mjs, wire v14) for a box whose frame is
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
    if (k === 'crack' || k === 'splash') out[k] = { ...base, size: e.size / 100 };
    else if (k === 'lightning') out[k] = { ...base, angle: rad(e.angle), color: e.color };
    else out[k] = { ...base, angle: rad(e.angle) };
  }
  return out;
}
