// ===== letters: one SFX letter at a time =====
// An SFX is drawn, not set (instructions rule C), and a letterer drawing one
// moves single letters: the first one up and bigger, the last one tipped out,
// one dropped below the rest. The SFX gizmo does that by hand (sfx-gizmo.js);
// this reads where each letter sits, so the agent can do it with `edit`
// set.letters.
//
// Units are the recipe's (style.sfx, data.js): a letter's place is ems of the
// box's size from the box's centre; its move (dx, dy) is ems of that LETTER,
// its turn degrees, its scale a factor. Only an SFX box has letters of its
// own: plain text is laid out by lines, and moves as a whole (wobble, curve,
// path, warp).
import { defineTool, ToolError } from '../registry.js';
import { selectBoxes } from '../select.js';
import { untrusted } from '../fence.js';
import { boxText } from '../../store.svelte.js';
import { applyCase } from '../../measure.js';
import { sfxActive, sfxPlacement } from '../../sfx.js';
import { glyphKey } from '../../sfx-gizmo.js';

const r2 = (n) => Math.round(n * 100) / 100;

// The letters of an SFX box as the engine lays them out now, or null.
export function lettersOf(b, p) {
  if (!sfxActive(b.style)) return null;
  const text = applyCase(boxText(b, p), b.style);
  const placed = sfxPlacement(text, b.style, b.style.size);
  if (!placed?.letters) return null;
  const s = String(text);
  const glyphs = b.style.sfx?.glyphs ?? {};
  return placed.letters.map((l, n) => {
    const key = glyphKey(l.group, l.index);
    const e = glyphs[key];
    return {
      key,
      n,
      ch: untrusted(s.slice(l.start, l.end)),
      // The engine places letters in px from the box centre, turned in radians.
      at: [r2(l.x / b.style.size), r2(l.y / b.style.size)],
      turn: r2(((l.rot ?? 0) * 180) / Math.PI),
      scale: r2(Math.sqrt(Math.abs((l.sx ?? 1) * (l.sy ?? 1)))),
      ...(e ? { moved: { dx: e.dx, dy: e.dy, rot: e.rot, s: e.s } } : null),
    };
  });
}

defineTool({
  name: 'letters',
  description:
    'Read the letters of one SFX box (style.sfx on): per letter its key ("group:index", what edit set.letters names), n (reading order), ch, at (where it sits: [x, y] in ems of the box size from the box centre, y down), turn (degrees), scale, and moved (the hand edit it carries: dx, dy in ems of that letter, rot degrees, s factor); limits: aim (what to keep to), hard (what edit refuses past), most (how many letters may carry a hand edit). ' +
    'Plain text has no letters of its own: move it as a whole (wobble, curve, path, warp, rotation), or make it an SFX first (do "sfx_pick" or "sfx_kind:<id>").',
  input: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1 } } },
  run({ id }) {
    const m = selectBoxes({ ids: [id] }).matches[0];
    if (!m) throw new ToolError(`no box "${id}"`, 'query lists the box ids.');
    const letters = lettersOf(m.box, m.page);
    if (!letters) {
      throw new ToolError(`box ${id} is not an SFX, so it has no letters of its own`, 'do "sfx_pick" or "sfx_kind:<id>" first (Rust engine), or move the text as a whole: style.wobble, curve, path, warp.');
    }
    return { id, size: m.box.style.size, kind: m.box.style.sfx.kind ?? null, count: letters.length, letters, limits: { aim: LETTER_AIM, hard: LETTER_CAPS, most: maxMoved(letters.length) } };
  },
});

// ---- set.letters: moving single SFX letters (edit) ----
// Hard limits, past which letters stop reading as one word. The SFX gizmo
// lets a person go further by hand; the agent stays inside these.
export const LETTER_CAPS = Object.freeze({ move: 2, rot: 60, sMin: 0.4, sMax: 2.5 });
// What the instructions ask for: the hard caps are for the rare original that
// needs more.
export const LETTER_AIM = Object.freeze({ move: 0.6, rot: 25, sMin: 0.7, sMax: 1.6 });
// How many letters of an SFX may carry a hand edit: half, two on a short one.
export const maxMoved = (n) => Math.max(2, Math.ceil(n / 2));
const LETTER_FIELDS = ['key', 'n', 'dx', 'dy', 'rot', 's', 'reset'];
const REL = /^[+\-*]\d+(\.\d+)?$/;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function resolve(v, cur) {
  if (isNum(v)) return v;
  if (typeof v === 'string' && REL.test(v.trim())) {
    const n = Number(v.trim().slice(1));
    const op = v.trim()[0];
    return op === '+' ? cur + n : op === '-' ? cur - n : cur * n;
  }
  return NaN;
}

// Each match's new `glyphs`, checked against its letters as they stand.
// Throws `fail(path, error, hint)` on anything it cannot do.
export function compileLetters(list, matches, fail) {
  if (!Array.isArray(list) || !list.length) fail('set.letters', 'expected a list of letter edits', 'e.g. [{ n: 0, dy: -0.3, s: 1.3 }, { key: "0:4", rot: 12 }]; letters lists them.');
  if (list.length > 64) fail('set.letters', 'at most 64 letter edits in one op');
  const byId = new Map();
  for (const m of matches) {
    const ls = lettersOf(m.box, m.page);
    if (!ls) fail('set.letters', `box ${m.box.id} is not an SFX, so it has no letters of its own`, 'turn it into one in an earlier edit call (do "sfx_pick" or "sfx_kind:<id>"); plain text moves as a whole (style.wobble, curve, path, set.mesh).');
    // Only the letters the box has now: a hand edit left on a letter that new
    // words took away draws nothing, and is dropped.
    const own = new Set(ls.map((l) => l.key));
    const before = Object.entries(m.box.style.sfx?.glyphs ?? {}).filter(([k]) => own.has(k));
    const glyphs = JSON.parse(JSON.stringify(Object.fromEntries(before)));
    list.forEach((e, j) => {
      const at = `set.letters[${j}]`;
      if (!e || typeof e !== 'object' || Array.isArray(e)) fail(at, 'expected an object');
      for (const k of Object.keys(e)) if (!LETTER_FIELDS.includes(k)) fail(`${at}.${k}`, 'unknown key', `a letter edit is { key or n, dx, dy, rot, s } or { key or n, reset: true }`);
      let key = e.key;
      if (key == null) {
        if (!Number.isInteger(e.n) || e.n < 0 || e.n >= ls.length) fail(at, `box ${m.box.id} has letters 0-${ls.length - 1}`, 'n is the reading order letters gives; or give key.');
        key = ls[e.n].key;
      } else if (!ls.some((l) => l.key === key)) {
        fail(`${at}.key`, `box ${m.box.id} has no letter "${key}"`, `its keys: ${ls.map((l) => l.key).join(', ')}`);
      }
      if (e.reset === true) {
        delete glyphs[key];
        return;
      }
      const cur = { dx: 0, dy: 0, rot: 0, s: 1, ...(glyphs[key] ?? {}) };
      const next = {};
      for (const f of ['dx', 'dy', 'rot', 's']) {
        const v = f in e ? resolve(e[f], cur[f]) : cur[f];
        if (!Number.isFinite(v)) fail(`${at}.${f}`, 'expected a number or a relative "+0.2", "-10", "*1.2"');
        next[f] = Math.round(v * 100) / 100;
      }
      if (Math.abs(next.dx) > LETTER_CAPS.move || Math.abs(next.dy) > LETTER_CAPS.move) fail(at, `a letter moves at most ${LETTER_CAPS.move} of its own ems (dx, dy)`, 'past that it stops reading as part of the word; move the whole SFX (geometry) or its path (style.sfx.paths) instead.');
      if (Math.abs(next.rot) > LETTER_CAPS.rot) fail(`${at}.rot`, `a letter turns at most ${LETTER_CAPS.rot} degrees`, 'turn the whole box (geometry.rotation) or the type\'s rise (style.sfx.rise) for more.');
      if (next.s < LETTER_CAPS.sMin || next.s > LETTER_CAPS.sMax) fail(`${at}.s`, `a letter scales ${LETTER_CAPS.sMin} to ${LETTER_CAPS.sMax}`, 'size the whole box for more.');
      if (next.dx || next.dy || next.rot || next.s !== 1) glyphs[key] = next;
      else delete glyphs[key];
    });
    // Strict guidance made a rule: most of an SFX stays where its type puts it.
    // A box past it already (moved by hand) may still have letters reset.
    const moved = Object.keys(glyphs).length;
    if (moved > maxMoved(ls.length) && moved > before.length) {
      fail('set.letters', `box ${m.box.id} would have ${moved} of ${ls.length} letters moved by hand`, 'move at most half of them (two on a short SFX); for an even change to all, use the type\'s dials (style.sfx power, rough, momentum, jitter, rise, flow) instead.');
    }
    byId.set(m.box.id, glyphs);
  }
  return byId;
}

// ---- set.mesh: the box's mesh warp point by point (edit) ----
// Presets (do "warp:<kind>") bend the whole box one way; this sets the mesh
// itself: the four corners (a perspective, a lean, a box squeezed to the
// art), or single points of the grid. Box-local page px, as style.warp keeps
// them.
export const MESH_CAP = 0.4; // of the box's shorter side, from where a point rests
const MESH_FIELDS = ['grid', 'corners', 'move', 'off'];

function bilinear(c, u, v) {
  const [tl, tr, br, bl] = c;
  return [
    (1 - u) * (1 - v) * tl[0] + u * (1 - v) * tr[0] + u * v * br[0] + (1 - u) * v * bl[0],
    (1 - u) * (1 - v) * tl[1] + u * (1 - v) * tr[1] + u * v * br[1] + (1 - u) * v * bl[1],
  ];
}

// Twice the signed area of a triangle (screen y down: positive is the rest
// orientation).
const tri = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);

export function compileMesh(spec, matches, fail, { identityMesh, MIN, MAX }) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('set.mesh', 'expected an object', '{ corners: [[x,y] x4] } or { move: [{ col, row, dx, dy }] }, box-local page px; { off: true } clears it.');
  for (const k of Object.keys(spec)) if (!MESH_FIELDS.includes(k)) fail(`set.mesh.${k}`, 'unknown key', `allowed: ${MESH_FIELDS.join(', ')}`);
  const byId = new Map();
  for (const m of matches) {
    const b = m.box;
    if (spec.off === true) {
      byId.set(b.id, { on: false, pts: [] });
      continue;
    }
    const w = b.w;
    const h = b.h;
    const cap = MESH_CAP * Math.min(w, h);
    let cols;
    let rows;
    if (spec.grid != null) {
      if (!Array.isArray(spec.grid) || spec.grid.length !== 2 || !spec.grid.every((n) => Number.isInteger(n) && n >= MIN && n <= MAX)) fail('set.mesh.grid', `expected [cols, rows], each ${MIN}-${MAX}`);
      [cols, rows] = spec.grid;
    }
    const own = b.style.warp?.on && b.style.warp.pts?.length ? b.style.warp : null;
    // A new grid starts flat; otherwise the box's own mesh, scaled to the box.
    const base = cols != null && (!own || own.cols !== cols || own.rows !== rows) ? null : own;
    cols ??= own?.cols ?? 4;
    rows ??= own?.rows ?? 4;
    const rest = identityMesh(cols, rows, w, h);
    let pts = base ? base.pts.map(([x, y]) => [(x * w) / (base.w || w), (y * h) / (base.h || h)]) : rest.map((p) => [...p]);
    if (spec.corners != null) {
      const c = spec.corners;
      if (!Array.isArray(c) || c.length !== 4 || !c.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum))) fail('set.mesh.corners', 'expected 4 points [x, y]: top-left, top-right, bottom-right, bottom-left', 'box-local page px; [0,0] is the box\'s top-left at rest.');
      const restC = [[0, 0], [w, 0], [w, h], [0, h]];
      c.forEach((p, k) => {
        if (Math.hypot(p[0] - restC[k][0], p[1] - restC[k][1]) > cap) fail(`set.mesh.corners[${k}]`, `a corner moves at most ${Math.round(cap)} px (${MESH_CAP * 100}% of the box's shorter side)`, 'past that the letters stretch out of reading; resize or turn the box instead.');
      });
      pts = [];
      for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) pts.push(bilinear(c, i / cols, j / rows));
    }
    // A move is held to how far it goes, from where the point is now.
    const start = pts.map((p) => [...p]);
    if (spec.move != null) {
      if (!Array.isArray(spec.move) || !spec.move.length || spec.move.length > 64) fail('set.mesh.move', 'expected 1-64 moves [{ col, row, dx, dy }]');
      spec.move.forEach((mv, k) => {
        const at = `set.mesh.move[${k}]`;
        if (!Number.isInteger(mv?.col) || !Number.isInteger(mv?.row) || mv.col < 0 || mv.row < 0 || mv.col > cols || mv.row > rows) fail(at, `col 0-${cols}, row 0-${rows}`, 'the mesh has (cols+1) x (rows+1) points; 0,0 is top-left.');
        if (!isNum(mv.dx ?? 0) || !isNum(mv.dy ?? 0)) fail(at, 'dx and dy are px');
        const idx = mv.row * (cols + 1) + mv.col;
        pts[idx] = [pts[idx][0] + (mv.dx ?? 0), pts[idx][1] + (mv.dy ?? 0)];
      });
      pts.forEach((p, k) => {
        const far = Math.hypot(p[0] - start[k][0], p[1] - start[k][1]);
        if (far > cap) fail('set.mesh.move', `point ${k % (cols + 1)},${Math.floor(k / (cols + 1))} would move ${Math.round(far)} px; the most is ${Math.round(cap)}`, 'smaller moves, or a warp preset (do "warp:<kind>:<amount>").');
      });
    }
    // No cell turned over: a folded mesh draws the letters inside out. The
    // painter cuts each cell into two triangles (warp.js cellTriangles), so
    // both must keep their turn.
    const P = (i, j) => pts[j * (cols + 1) + i];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const [tl, tr, br, bl] = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];
        if (tri(tl, tr, br) <= 0 || tri(tl, br, bl) <= 0) fail('set.mesh', `cell ${i},${j} would fold over`, 'move neighbouring points together, or less.');
      }
    }
    byId.set(b.id, { on: true, cols, rows, pts: pts.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]), w, h });
  }
  return byId;
}
