// ===== What the SFX handles change on a box, and how it is recorded =====
//
// The handles themselves are `SfxGizmo.svelte`: each text group's path with a
// dot at each end and a diamond on its curve, and, on a letter picked by a
// press, the reference's gizmo (docs/giongo/04-reference-controls.md 2): a
// ring that turns it, two arrows that move it along the screen's x or y, a
// square that moves it freely and an arm that sizes it. What a drag writes is
// worked out by the engine (`sfxTurn`, `sfxScale`, `sfxMove`, `sfxBendFor`,
// sfx.js); what it does to the box's recipe, and the one history step it
// makes, is here, so that a node test can check it.
//
// Units are the recipe's (`style.sfx`, data.js): a path's ends are ems of the
// box's size from the box's centre; a letter's move is ems of that LETTER (the
// engine's `unit` for it), its turn degrees and its scale a factor.

import { cloneStyle, markUnsaved, reviewBox, pageById, settleEdits } from './store.svelte.js';
import { record } from './editor/history.svelte.js';

// A second press within this long and this near, on the same part, is a
// double: it resets what that part changes.
export const DOUBLE_MS = 400;
export const DOUBLE_PX = 12;

// What a double press on each part of the gizmo puts back.
export const GLYPH_RESET = Object.freeze({
  ring: { rot: 0 },
  scale: { s: 1 },
  x: { dx: 0 },
  y: { dy: 0 },
  plane: { dx: 0, dy: 0 },
  centre: { dx: 0, dy: 0 },
  letter: { dx: 0, dy: 0, rot: 0, s: 1 },
});

// Whether a press on `part` at `t` ms, client `x, y`, is the second of a
// double after `prev` ({ part, t, x, y } of the last press, or null).
export function isDouble(prev, part, t, x, y) {
  return !!prev && prev.part === part && t - prev.t <= DOUBLE_MS && Math.hypot(x - prev.x, y - prev.y) <= DOUBLE_PX;
}

// The gizmo's size for a stage `w` x `h` CSS px: 1 on a big canvas, down to
// 0.6 on a small one. An unmeasured stage is a big one.
export function gizmoScale(w, h) {
  if (!(w > 0) || !(h > 0)) return 1;
  return Math.min(1, Math.max(0.6, Math.min(w, h) / 560));
}

// The screen's x (`axis` 'x') or y axis in the box's stored frame: the box's
// turn undone, then its flip. A step along it is a step along the screen's
// axis once the box is turned and mirrored back.
export function screenAxis(rotDeg, flipH, flipV, axis) {
  const r = ((rotDeg || 0) * Math.PI) / 180;
  const c = Math.cos(r);
  const sn = Math.sin(r);
  const u = axis === 'x' ? [c, -sn] : [sn, c];
  return [flipH ? -u[0] : u[0], flipV ? -u[1] : u[1]];
}

// Pointer moves to writes, at most one per animation frame: `push` keeps the
// latest move and asks for a frame, the frame applies it. `flush` applies a
// waiting move now (the release), `cancel` drops it.
export function frameLoop(apply) {
  let pending = null;
  let raf = 0;
  const run = () => {
    raf = 0;
    const ev = pending;
    pending = null;
    if (ev) apply(ev);
  };
  return {
    push(ev) {
      pending = ev;
      if (!raf) raf = requestAnimationFrame(run);
    },
    flush() {
      if (raf) cancelAnimationFrame(raf);
      run();
    },
    cancel() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      pending = null;
    },
  };
}

export const glyphKey = (group, index) => `${group}:${index}`;

const round = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const NO_EDIT = Object.freeze({ dx: 0, dy: 0, rot: 0, s: 1 });

// The letter's hand edit, or the one that changes nothing.
export const glyphOf = (sfx, key) => sfx?.glyphs?.[key] ?? NO_EDIT;
export const hasGlyphEdit = (sfx, key) => !!sfx?.glyphs?.[key];

// Writes the letter's hand edit, kept to the range data.js allows. An edit
// that changes nothing is taken out, so a letter dragged back to where it
// was is a letter with no edit (and Reset letter edits has nothing to say).
export function setGlyph(sfx, key, patch) {
  const g = { ...glyphOf(sfx, key), ...patch };
  const e = {
    dx: round(clamp(+g.dx || 0, -20, 20)),
    dy: round(clamp(+g.dy || 0, -20, 20)),
    rot: round(clamp(+g.rot || 0, -360, 360)),
    s: round(clamp(Number.isFinite(+g.s) ? +g.s : 1, 0.1, 5)),
  };
  const glyphs = { ...JSON.parse(JSON.stringify(sfx.glyphs ?? {})) };
  if (e.dx || e.dy || e.rot || e.s !== 1) glyphs[key] = e;
  else delete glyphs[key];
  sfx.glyphs = glyphs;
}

// The box's own paths, one per group the engine laid out: what it has, and
// the engine's made ones after them. A handle can only move a path the box
// holds, and the ones the engine made are where the letters are now, so the
// first drag starts from exactly what is on screen.
export function ownPaths(sfx, placed) {
  const have = sfx.paths ?? [];
  if (have.length >= (placed?.length ?? 0)) return;
  const out = JSON.parse(JSON.stringify(have));
  for (let i = out.length; i < Math.min(4, placed.length); i++) {
    const q = placed[i];
    out.push({ a: [round(q.a[0]), round(q.a[1])], b: [round(q.b[0]), round(q.b[1])], bend: round(q.bend ?? 0) });
  }
  sfx.paths = out;
}

export function setPathEnd(sfx, i, end, [x, y]) {
  const q = sfx.paths[i];
  if (!q) return;
  q[end] = [round(x), round(y)];
}

// One gesture on the handles, from its first change to its one commit or
// cancel. The before is the whole style, which is what the `style` history
// kind puts back, so cancel and undo mean the same thing. Anything still
// waiting to be recorded (an Inspector burst, typing) goes first.
export function sfxGesture(box, pageId) {
  settleEdits();
  const before = cloneStyle(box.style);
  let settled = false;
  return {
    get settled() {
      return settled;
    },
    commit() {
      if (settled) return false;
      settled = true;
      const after = cloneStyle(box.style);
      if (JSON.stringify(before) === JSON.stringify(after)) return false;
      markUnsaved();
      // The letters moved, and whether they are still in the box is the flag's
      // to say (OVF-7). Once, here, not per pointer move.
      reviewBox(box, pageById(pageId) ?? undefined);
      record({ t: 'style', pageId, boxId: box.id, before, after });
      return true;
    },
    cancel() {
      if (settled) return false;
      settled = true;
      box.style = cloneStyle(before);
      return true;
    },
  };
}

// A one-shot edit as one history step: `fn` changes `box.style.sfx`.
export function sfxEdit(box, pageId, fn) {
  const g = sfxGesture(box, pageId);
  fn(box.style.sfx);
  return g.commit();
}
