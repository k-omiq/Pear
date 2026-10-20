// Edge and corner resize geometry for a text box, pulled out of TextBox.svelte's
// pointer handler so it can be tested without a DOM. The height floor is applied
// BEFORE the opposite-edge anchor is worked out, so a clamped top-edge drag
// still leaves the bottom edge where it was.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Which handles' drags are held by the height floor: the top and bottom edges,
// alone. A corner scales the type with the box and takes none, and a left or
// right edge does not change the height.
//
// The corners are the only handles that change the size of the type. They
// scale the box and the text together, by one factor, so the lines stay the
// lines they were and the box stays exactly round them. The sides change the
// width or the height and never the size. Said here, where the floor is
// applied, for whoever works a floor out (`edgeDragFloor`, the store): one
// that is not going to be used has nothing to stand down for.
export const takesHeightFloor = (dir) => dir === 'n' || dir === 's';

// `o` is the box at pointer-down ({ x, y, w, h, size }), `dx`/`dy` the pointer
// travel already turned into the box's own frame, `rotation` its angle in
// degrees. `heightFloor` is how short a top or bottom drag may make the box -
// the text's own height, so a drag can never leave text hanging out of it -
// and `widthFloor` how narrow a left or right drag may: its widest word. A
// corner drag takes neither: it scales the text with the box.
export function resizeBoxMath(dx, dy, dir, o, rotation = 0, heightFloor = 30, widthFloor = 40) {
  const rad = (-(rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const hasE = dir.includes('e'), hasW = dir.includes('w'), hasN = dir.includes('n'), hasS = dir.includes('s');
  const corner = (hasE || hasW) && (hasN || hasS);
  const floor = takesHeightFloor(dir) ? Math.max(30, heightFloor) : 30;

  const wFloor = corner ? 40 : Math.max(40, widthFloor);

  let nw = o.w, nh = o.h;
  if (hasE) nw = Math.max(wFloor, o.w + dx);
  if (hasW) nw = Math.max(wFloor, o.w - dx);
  if (hasS) nh = Math.max(floor, o.h + dy);
  if (hasN) nh = Math.max(floor, o.h - dy);
  // On the half-px grid every size the solver picks is on (auto-layout.js
  // `SIZE_STEP`), not on whole px: a box the solver set at 33.5 jumped to 34 or
  // 33 the moment its corner was touched. Rounded down, so the type is never
  // scaled past the box, and the box then scaled by the size's own factor, so
  // the two stay in step. The axis dragged further leads.
  let size;
  if (corner && o.w > 0 && o.h > 0 && o.size > 0) {
    const fx = (hasE ? o.w + dx : o.w - dx) / o.w;
    const fy = (hasS ? o.h + dy : o.h - dy) / o.h;
    const f = Math.abs(fx - 1) > Math.abs(fy - 1) ? fx : fy;
    const least = Math.max(6 / o.size, 40 / o.w, 30 / o.h);
    size = clamp(Math.floor(o.size * Math.max(f, least) * 2) / 2, 6, 200);
    const k = size / o.size;
    nw = o.w * k;
    nh = o.h * k;
  }
  // Opposite edge anchor for rotated box scaling.
  const shiftX = hasE ? (nw - o.w) / 2 : hasW ? (o.w - nw) / 2 : 0;
  const shiftY = hasS ? (nh - o.h) / 2 : hasN ? (o.h - nh) / 2 : 0;
  const x = o.x + o.w / 2 + (shiftX * cos + shiftY * sin) - nw / 2;
  const y = o.y + o.h / 2 + (shiftY * cos - shiftX * sin) - nh / 2;
  return { x, y, w: nw, h: nh, size };
}
