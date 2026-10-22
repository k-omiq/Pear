// ===== What the SFX handles change on a box, and how it is recorded =====
//
// The handles themselves are `SfxGizmo.svelte`: a dot at each end of
// every text group's path, a diamond that bends it, and, on a letter picked
// by a click, a ring that turns it and a square that sizes it. What a drag
// writes is worked out here, like `warp-gizmo.js` does for the mesh, so that
// "one history step per gesture" is something a node test can check.
//
// Units are the recipe's (`style.sfx`, data.js): a path's ends are ems of the
// box's size from the box's centre; a letter's move is ems of that LETTER (the
// engine's `em` for it, which a letter grown along the path has more of), its
// turn degrees and its scale a factor.

import { cloneStyle, markUnsaved, reviewBox, pageById, settleEdits } from './store.svelte.js';
import { record } from './editor/history.svelte.js';

// The arrows' steps: page px for a path's point, ems for a letter. Shift is ten.
export const NUDGE_SETTLE_MS = 400;
export const PATH_NUDGE_PX = 1;
export const LETTER_NUDGE_EM = 0.02;

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
