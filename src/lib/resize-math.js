// Edge and corner resize geometry for a text box, pulled out of TextBox.svelte's
// pointer handler so it can be tested without a DOM. The floors are applied
// BEFORE the opposite-edge anchor is worked out, so a clamped drag still
// leaves the opposite edge where it was.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Which handles' drags change the height: every handle but the left and right
// edges. A drag of one of these is the user setting the height by hand.
export const takesHeightFloor = (dir) => dir.includes('n') || dir.includes('s');

// The sides change the box and never the type: each moves one edge, and the
// text breaks again in what it leaves at the size it is set at.
// `keepAspect` keeps a corner's proportions without scaling.
//
// `scale` (the corners, in TextBox.svelte) is the gesture that changes the
// type: the box and the text by one factor, so the lines stay the lines they
// were and the box stays exactly round them. A corner takes the pointer's
// travel along the box's diagonal, a side its own axis.
// The answer then carries `scale`, the factor.
//
// `o` is the box at pointer-down ({ x, y, w, h, size }), `dx`/`dy` the pointer
// travel already turned into the box's own frame, `rotation` its angle in
// degrees. `heightFloor` is how short the drag may make the box - the text's
// own height, so a drag can never leave text hanging out of it - and
// `widthFloor` how narrow: its widest word. A scale takes neither.
export function resizeBoxMath(dx, dy, dir, o, rotation = 0, heightFloor = 30, widthFloor = 40, { scale = false, keepAspect = false } = {}) {
  const rad = (-(rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const hasE = dir.includes('e'), hasW = dir.includes('w'), hasN = dir.includes('n'), hasS = dir.includes('s');
  const corner = (hasE || hasW) && (hasN || hasS);
  const hFloor = Math.max(30, heightFloor);
  const wFloor = Math.max(40, widthFloor);

  let nw = o.w, nh = o.h;
  let k = null;
  const fx = (hasE ? o.w + dx : hasW ? o.w - dx : o.w) / o.w;
  const fy = (hasS ? o.h + dy : hasN ? o.h - dy : o.h) / o.h;
  // A corner's one factor: the pointer projected onto the diagonal from the
  // opposite corner, so every pixel of travel moves it a little, both axes at
  // once. Taking whichever axis had moved further instead flipped between
  // the two as the hand wobbled - on a wide box a few px of y outweigh tens
  // of x - and the size jumped by whole steps back and forth.
  const df = 1 + ((hasE ? dx : -dx) * o.w + (hasS ? dy : -dy) * o.h) / (o.w * o.w + o.h * o.h);
  if (scale && o.w > 0 && o.h > 0) {
    // On the half-px grid every size the solver picks is on (auto-layout.js
    // `SIZE_STEP`), rounded down so the type is never scaled past the box, and
    // the box then scaled by the size's own factor, so the two stay in step.
    const f = corner ? df : hasE || hasW ? fx : fy;
    const least = Math.max(o.size > 0 ? 6 / o.size : 0, 40 / o.w, 30 / o.h);
    if (o.size > 0) {
      const size = clamp(Math.floor(o.size * Math.max(f, least) * 2) / 2, 6, 200);
      k = size / o.size;
    } else k = Math.max(f, least);
    nw = o.w * k;
    nh = o.h * k;
  } else if (corner && keepAspect && o.w > 0 && o.h > 0) {
    const f = Math.max(df, wFloor / o.w, hFloor / o.h);
    nw = o.w * f;
    nh = o.h * f;
  } else {
    if (hasE || hasW) nw = Math.max(wFloor, o.w * fx);
    if (hasN || hasS) nh = Math.max(hFloor, o.h * fy);
  }
  // Opposite edge anchor for rotated box scaling.
  const shiftX = hasE ? (nw - o.w) / 2 : hasW ? (o.w - nw) / 2 : 0;
  const shiftY = hasS ? (nh - o.h) / 2 : hasN ? (o.h - nh) / 2 : 0;
  const x = o.x + o.w / 2 + (shiftX * cos + shiftY * sin) - nw / 2;
  const y = o.y + o.h / 2 + (shiftY * cos - shiftX * sin) - nh / 2;
  return k != null ? { x, y, w: nw, h: nh, scale: k } : { x, y, w: nw, h: nh };
}
