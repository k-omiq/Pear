// ===== Warp presets: the mesh for a named bend =====
//
// Photoshop's Warp Text styles as starting meshes for the box's mesh warp
// (`style.warp`, drawn by warp.js): a name and an amount in, the control
// points out, so an agent - or a menu - can say "arc it, 30%" without dragging
// a single handle. Pure geometry like warp.js, which it builds on: no canvas,
// no store, node-testable.
//
// Every preset is a displacement of the identity grid. A control point starts
// where `identityMesh` puts it, at (u * w, v * h) with u and v running 0..1
// across and down the box, and each kind says where that point goes. The
// grid is `PRESET_COLS` by `PRESET_ROWS` cells: eight across is enough for the
// mesh's bicubic surface to draw a half circle or a full sine period smoothly
// (a segment spans at most 22.5 degrees of an arc), four down is enough for
// the curves that vary by row, and both are within the gizmo's handle limit
// (`HANDLE_GRID_MAX`), so the user can still grab and adjust what the preset
// made.
//
// `amount` is a percentage, -100..100, as in Photoshop's Bend slider: 0 is the
// identity grid (on, and changing nothing), 100 the strongest bend a kind
// offers, and a negative amount bends the other way (an arc that frowns
// smiles; a bulge pinches). How far each kind moves a point is scaled to the
// box, so a preset looks the same on a wide caption and a square SFX: arcs by
// the box's width, vertical swells by its height, and waves by whichever of
// the two keeps the slope of the wave about the same.
//
// The finished mesh is centred back on the box: a bend that only moves points
// one way (an arc's ends dropping, an arch's middle rising) would otherwise
// slide the text off the box it was laid out in.

import { identityMesh } from './warp.js';

export const PRESET_COLS = 8;
export const PRESET_ROWS = 4;

// The kinds, in the order a menu would list them, with what each does said in
// a few words for a tool's description.
export const WARP_PRESETS = Object.freeze(['arc', 'arch', 'bulge', 'flag', 'wave', 'rise', 'squeeze', 'inflate', 'perspective']);
export const WARP_PRESET_NOTES = Object.freeze({
  arc: 'bends along a circle, letters fanned out (rainbow; negative smiles)',
  arch: 'the line rises in the middle, letters kept upright',
  bulge: 'top and bottom swell out in the middle (negative pinches)',
  flag: 'one wave along the line, letters kept upright',
  wave: 'a wave whose top and bottom are out of step, letters stretch and shrink',
  rise: 'climbs from low left to high right (negative falls)',
  squeeze: 'left and right sides pinched in at the middle (negative bows out)',
  inflate: 'swells from the centre on both axes (negative deflates)',
  perspective: 'far side smaller, as if turned away (negative turns the left side away)',
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// A hundredth of a page px, and never -0 (which a save would write as 0).
const round2 = (v) => Math.round(v * 100) / 100 || 0;

// How far a kind moves a point at full strength, as a share of the box. Named
// here so the shapes below read as formulas and the tuning is in one place.
const ARCH_RISE = 0.3; // of the width: the arch's middle at 100%
const BULGE_SWELL = 0.45; // of the height: under 0.5, so -100% never closes the middle
const SQUEEZE_PINCH = 0.25; // of the width: 100% leaves half the middle row
const INFLATE_X = 0.2; // of the width
const INFLATE_Y = 0.3; // of the height
const WAVE_H = 0.5; // a wave's height is the smaller of these two shares,
const WAVE_W = 0.12; // so its steepest slope is about the same on any box
const RISE_H = 0.6;
const RISE_W = 0.2;
const FAR_SIDE = 0.7; // perspective: how much smaller the far side gets at 100%
// An arc's inner radius is kept at least this share of the box height, so a
// strong arc on a tall box narrows towards its centre instead of folding the
// mesh through it.
const ARC_MIN_INNER = 0.1;

// The point (u, v) of a w x h box under `kind` at strength `a` (-1..1), in
// box px. `u`, `v` run 0..1; `s`, `t` are the same mapped to -1..1 from the
// centre.
function bend(kind, a, u, v, w, h) {
  const x = u * w;
  const y = v * h;
  const s = 2 * u - 1;
  const t = 2 * v - 1;
  const sign = a < 0 ? -1 : 1;
  const k = Math.abs(a);
  switch (kind) {
    case 'arc': {
      // The middle row is laid along a circle with the box's width as its arc
      // length; rows above and below sit on circles further out and further
      // in, so letters fan from the centre. Turning the full 180 degrees at
      // 100% unless that would push the inner radius under ARC_MIN_INNER.
      const half = h / 2;
      const maxTurn = w / (half + ARC_MIN_INNER * h);
      const turn = Math.min(k * Math.PI, maxTurn);
      if (turn < 1e-6) return [x, y];
      const R = w / turn;
      const phi = (u - 0.5) * turn;
      const r = R + sign * (0.5 - v) * h;
      return [w / 2 + r * Math.sin(phi), half + sign * (R - r * Math.cos(phi))];
    }
    case 'arch':
      return [x, y - a * ARCH_RISE * w * (1 - s * s)];
    case 'bulge':
      return [x, y + t * a * BULGE_SWELL * h * (1 - s * s)];
    case 'flag':
      return [x, y + a * Math.min(WAVE_H * h, WAVE_W * w) * Math.sin(2 * Math.PI * u)];
    case 'wave':
      // The bottom edge a quarter period behind the top.
      return [x, y + a * Math.min(WAVE_H * h, WAVE_W * w) * Math.sin(2 * Math.PI * u - (Math.PI / 2) * v)];
    case 'rise':
      return [x, y - a * Math.min(RISE_H * h, RISE_W * w) * Math.sin((Math.PI / 2) * s)];
    case 'squeeze':
      return [x - s * a * SQUEEZE_PINCH * w * (1 - t * t), y];
    case 'inflate':
      return [x + s * a * INFLATE_X * w * (1 - t * t), y + t * a * INFLATE_Y * h * (1 - s * s)];
    case 'perspective': {
      // A plane turned away from the viewer: the far side `far` times the
      // near side's height, and the spacing across foreshortened to match
      // (depth grows linearly across the plane, size goes as one over depth),
      // which is what makes it read as a turn and not a taper.
      const far = 1 - FAR_SIDE * k;
      const q = sign > 0 ? u : 1 - u; // 0 at the near side, 1 at the far
      const depth = 1 + q * (1 / far - 1);
      const across = q / depth / far; // 0..1 from the near side
      return [sign > 0 ? across * w : w - across * w, h / 2 + (y - h / 2) / depth];
    }
    default:
      return [x, y];
  }
}

// The mesh for `kind` at `amount` percent over a `w` x `h` box: `{ cols,
// rows, pts }`, ready for `style.warp` (with `on: true`), the points row-major
// in box-local page px and rounded to a hundredth. An amount past +-100 is
// clamped and one that is not a number is 0. Null for a kind that is not on
// the list, so a caller cannot mistake it for the identity.
export function warpPresetPts(kind, amount, w, h) {
  if (!WARP_PRESETS.includes(kind)) return null;
  const W = Math.max(1, Number(w) || 0);
  const H = Math.max(1, Number(h) || 0);
  const a = clamp(Number.isFinite(Number(amount)) ? Number(amount) : 0, -100, 100) / 100;
  const cols = PRESET_COLS;
  const rows = PRESET_ROWS;
  const grid = identityMesh(cols, rows, W, H);
  if (a === 0) return { cols, rows, pts: grid.map(([x, y]) => [round2(x), round2(y)]) };
  const moved = grid.map(([x, y]) => bend(kind, a, x / W, y / H, W, H));
  // Centred back on the box, by the bounds of the control points.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of moved) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const dx = W / 2 - (minX + maxX) / 2;
  const dy = H / 2 - (minY + maxY) / 2;
  return { cols, rows, pts: moved.map(([x, y]) => [round2(x + dx), round2(y + dy)]) };
}
