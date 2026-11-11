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
//              spreads them over every letter, less pulls them in.
//              `breakOff` (0 to 100, B5 shatter test) breaks the pieces
//              between the arms loose, where the cracks are densest first,
//              and moves them as `motion` says ('apart' or 'fall'): each
//              keeps the letter's fill, outline and shadow and leaves a
//              clean hole. Decoration only: the paint's padding grows by the
//              farthest a piece may travel (`breakReach`), and no layout,
//              containment or fit answer sees the pieces
//   lightning  paints jagged bolts with forks on the letters' fill: a `core`
//              colour inside a `glow` colour, `glowSize` wide. `aim`
//              'across' (the default, the first-built look) crosses the box
//              from side to side; 'point' starts every bolt at `x`, `y`
//              (percents of the box) and sends it `angle` degrees (0 along
//              the line, counter-clockwise as the dial reads it), a little
//              fan of them, until it leaves the box
//   splash     paints spiky splats, teardrop droplets and streaks in its
//              own `color` on the letters' fill; nothing goes past the fill.
//              `x`, `y` (percents of the box) is where the paint lands,
//              `spread` how far the splats spread from it: 100 (the
//              default, the first-built look) lays one to each stretch of
//              the box wherever `x`, `y` are, less pulls them in
//   scratches  cuts many thin, near-parallel strokes
//
// Amounts are percents, sizes percents of the font size, angles degrees
// (0 runs along the line), seeds 0 to 999. Painted by the Rust engine only.
//
// Known limit: the pattern is laid over the letters' ink box, so it is
// redrawn when the text or the box size changes; Seed re-rolls it.
//
// What the outlines do where a crack or scratches cut: 'fills-cuts' outlines
// each cut, so a crack narrower than the outline reads as a line in its
// colour; 'cut-through' cuts the outline as the letters are, and the page
// shows through. Two keys, so each kind keeps its first-built look:
// `outline` for a box's own stroke (one the Rust engine lays, Effects ▸
// Stroke), 'fills-cuts' by default, and `bandOutline` for the text's own
// outline (a glyph band, Stroke ▸ Outline), 'cut-through' by default. The
// Inspector's one Outline row sets both.

const HEX = /^#[0-9a-f]{6}$/i;

export const SPECIAL_KINDS = ['crack', 'lightning', 'splash', 'scratches'];

export const SPECIAL_SIZE_MIN = 10;
export const SPECIAL_SIZE_MAX = 400;
// The lightning's glow, percents of its default (0: none).
export const SPECIAL_GLOW_MAX = 300;

// How a crack's broken-off pieces move (the crack's `motion`): 'apart'
// moves them out from the focus and turns them, staying near the letters;
// 'fall' drops them below where they were, small ones farther, turning as
// they go, and loses a few small ones. The index is the wire's (paint.mjs).
// A style from before the choice reads as 'fall'.
export const BREAK_MOTIONS = ['apart', 'fall'];

// What an outline does at the cuts (`outline`, `bandOutline`).
export const SPECIAL_OUTLINES = ['fills-cuts', 'cut-through'];
// Where a lightning's bolts run (`aim`); the first is the default.
export const LIGHTNING_AIMS = ['across', 'point'];
const motionOf = (v) => (BREAK_MOTIONS.includes(v) ? v : 'fall');

// How far a broken-off piece may travel, in font sizes: the engine never
// moves one farther (`BREAK_SIDE`, `BREAK_DROP` in special.rs, where they
// come from the motions' numbers; a Rust test checks these are the same).
export const BREAK_SIDE = 0.5;
export const BREAK_DROP = 2.42;

// The padding a style's broken-off pieces need past the letters' own, page
// px: { x, top, bottom }, or null when none breaks off. Whatever the box's
// size.
export function breakReach(style) {
  const c = style?.special?.crack;
  if (!c?.on || !(c.amount > 0) || !(c.breakOff > 0)) return null;
  const size = Number(style.size) || 0;
  const side = BREAK_SIDE * size;
  const bottom = motionOf(c.motion) === 'fall' ? BREAK_DROP * size : side;
  return { x: side, top: side, bottom };
}

export function defaultSpecial() {
  return {
    crack: { on: false, amount: 40, size: 100, x: 50, y: 50, spread: 100, breakOff: 0, motion: 'fall', seed: 1 },
    lightning: { on: false, amount: 40, core: '#ffffff', glow: '#1e90ff', glowSize: 100, aim: 'across', x: 0, y: 50, angle: 0, seed: 1 },
    splash: { on: false, amount: 40, size: 100, color: '#e63946', x: 50, y: 50, spread: 100, seed: 1 },
    scratches: { on: false, amount: 40, angle: -15, seed: 1 },
    outline: 'fills-cuts',
    bandOutline: 'cut-through',
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
      breakOff: within(s.crack?.breakOff, d.crack.breakOff, 0, 100),
      motion: motionOf(s.crack?.motion),
      seed: seedOf(s.crack?.seed, d.crack.seed),
    },
    lightning: {
      on: s.lightning?.on === true,
      amount: amount(s.lightning, 'lightning'),
      core: colourOf(s.lightning?.core, d.lightning.core),
      glow: colourOf(s.lightning?.glow, colourOf(s.lightning?.color, d.lightning.glow)),
      glowSize: within(s.lightning?.glowSize, d.lightning.glowSize, 0, SPECIAL_GLOW_MAX),
      aim: LIGHTNING_AIMS.includes(s.lightning?.aim) ? s.lightning.aim : d.lightning.aim,
      x: within(s.lightning?.x, d.lightning.x, 0, 100),
      y: within(s.lightning?.y, d.lightning.y, 0, 100),
      angle: angleOf(s.lightning?.angle, d.lightning.angle),
      seed: seedOf(s.lightning?.seed, d.lightning.seed),
    },
    splash: {
      on: s.splash?.on === true,
      amount: amount(s.splash, 'splash'),
      size: size(s.splash, 'splash'),
      color: colourOf(s.splash?.color, d.splash.color),
      x: within(s.splash?.x, d.splash.x, 0, 100),
      y: within(s.splash?.y, d.splash.y, 0, 100),
      spread: within(s.splash?.spread, d.splash.spread, 0, 100),
      seed: seedOf(s.splash?.seed, d.splash.seed),
    },
    scratches: { on: s.scratches?.on === true, amount: amount(s.scratches, 'scratches'), angle: angleOf(s.scratches?.angle, d.scratches.angle), seed: seedOf(s.scratches?.seed, d.scratches.seed) },
    outline: SPECIAL_OUTLINES.includes(s.outline) ? s.outline : d.outline,
    bandOutline: SPECIAL_OUTLINES.includes(s.bandOutline) ? s.bandOutline : d.bandOutline,
  };
}

// The effects of `style` that draw something: on, with an amount.
export function shownSpecial(style) {
  const sp = style?.special;
  if (!sp) return [];
  return SPECIAL_KINDS.filter((k) => sp[k]?.on === true && sp[k].amount > 0);
}

// Whether `style` cuts its letters (a crack or scratches draws).
export function specialCuts(style) {
  return shownSpecial(style).some((k) => k === 'crack' || k === 'scratches');
}

// What the Outline row shows for `style` (`outline`, `bandOutline`), given
// whether it has the text's own outline (`hasBand`, a glyph band: data.js
// `outlineRun`) and a box stroke (`hasStroke`, Effects ▸ Stroke): `any`,
// either; `current`, the choice the outlines there share, or null when the
// two keys differ for outlines both there.
export function outlineKinds(style, hasBand, hasStroke) {
  const sp = style?.special ?? {};
  const o = sp.outline === 'cut-through' ? 'cut-through' : 'fills-cuts';
  const b = sp.bandOutline === 'fills-cuts' ? 'fills-cuts' : 'cut-through';
  const current = hasBand && hasStroke ? (o === b ? o : null) : hasBand ? b : o;
  return { any: !!(hasBand || hasStroke), current };
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
    if (k === 'crack') {
      out[k] = { ...base, size: e.size / 100, x: e.x / 100, y: e.y / 100, spread: e.spread / 100 };
      if (e.breakOff > 0) out[k].breakOff = { share: e.breakOff / 100, motion: BREAK_MOTIONS.indexOf(motionOf(e.motion)) };
    }
    else if (k === 'splash') {
      out[k] = { ...base, size: e.size / 100, color: e.color };
      // Placed only when it is pulled in: at 100 the splats are where they
      // always were, wherever x and y are.
      if (e.spread < 100) out[k].at = { x: e.x / 100, y: e.y / 100, spread: e.spread / 100 };
    }
    else if (k === 'lightning') {
      out[k] = { ...base, core: e.core, glow: e.glow, glowSize: e.glowSize / 100 };
      // The dial's angle runs counter-clockwise (90 is up), the engine's
      // clockwise (y down): the bolt goes the way the dial points.
      if (e.aim === 'point') out[k].aim = { x: e.x / 100, y: e.y / 100, angle: rad(-e.angle) };
    }
    else out[k] = { ...base, angle: rad(e.angle) };
  }
  // On the wire only when they are not the defaults, and only with cuts.
  if (specialCuts(style)) {
    if (sp.outline === 'cut-through') out.cutStrokes = true;
    if (sp.bandOutline === 'fills-cuts') out.fillBands = true;
  }
  return out;
}

// ===== the on-page handle =====
// While Effects ▸ Special is open, the selected box shows a point for each
// effect that has one: Crack's focus, Lightning's start (with an arm the
// way it is aimed) and Splash's landing. A drag writes the effect's `x`,
// `y` (and the arm, the lightning's `angle`), as the sliders do.

// The effects that have a handle, in the order they are drawn.
export const HANDLE_KINDS = ['crack', 'lightning', 'splash'];

// How long the lightning's arm is, box-local px.
export const ARM_LENGTH = 36;

// The frame `kind`'s `x`, `y` are percents of, box-local: the letters' ink
// box (`ink`, { x0, y0, x1, y1 }) for a crack, the box itself otherwise.
// A crack without letters measured falls back on the box.
export function handleFrame(kind, box, ink) {
  if (kind === 'crack' && ink && ink.x1 > ink.x0 && ink.y1 > ink.y0) return { x: ink.x0, y: ink.y0, w: ink.x1 - ink.x0, h: ink.y1 - ink.y0 };
  return { x: 0, y: 0, w: Number(box?.w) || 0, h: Number(box?.h) || 0 };
}

// Where `kind`'s handle sits, box-local px, from its stored percents.
export function handlePoint(e, frame) {
  return { x: frame.x + (e.x / 100) * frame.w, y: frame.y + (e.y / 100) * frame.h };
}

// The percents a point (box-local px) sets, kept within 0 to 100 and to a
// tenth.
export function handlePercents(p, frame) {
  const pc = (v, o, len) => (len > 0 ? Math.round(Math.min(100, Math.max(0, ((v - o) / len) * 100)) * 10) / 10 : 50);
  return { x: pc(p.x, frame.x, frame.w), y: pc(p.y, frame.y, frame.h) };
}

// What a handle drag of `kind` writes onto its effect `e`, from the point
// `p` (box-local px): `x`, `y`; a crack or splash spread over everything
// (100, where the point does nothing) is pulled in to half, so the drag is
// seen; a lightning is aimed from the point.
export function dragHandle(kind, e, p, frame) {
  const at = handlePercents(p, frame);
  e.x = at.x;
  e.y = at.y;
  if ((kind === 'crack' || kind === 'splash') && e.spread >= 100) e.spread = 50;
  if (kind === 'lightning') e.aim = 'point';
}

// What a drag of the lightning's arm end writes: its `angle`, degrees from
// the start `from` to the point `p` (box-local px, y down), whole and
// counter-clockwise, as the dial reads it (90 is up).
export function dragArm(e, from, p) {
  if (Math.hypot(p.x - from.x, p.y - from.y) < 2) return;
  e.angle = Math.round((Math.atan2(from.y - p.y, p.x - from.x) * 180) / Math.PI);
  e.aim = 'point';
}

// The end of the lightning's arm, box-local px, from its start `from`.
export function armEnd(e, from, len = ARM_LENGTH) {
  const a = (e.angle * Math.PI) / 180;
  return { x: from.x + Math.cos(a) * len, y: from.y - Math.sin(a) * len };
}
