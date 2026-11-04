// Joined bubbles cut at their neck, from the outline's shape alone.
//
// Two or three bubbles drawn touching often close into one outline, and one
// text block in it does not tell the finder there is a join: `splitInterior`
// only cuts between the centres of two blocks. TypeR's neck finder
// (vendor/typer-geometry.js `findCut`) reads the neck off the outline itself:
// a short chord between two concave corners that leaves two round chambers.
// It favours a single bubble, like TypeR: a wrong cut costs more than a miss.

import { area, box, clipToSide, findCut, polygonContour } from './vendor/typer-geometry.js';

// Which side of the chord a-b the point is on: +1, -1, or 0 on the line.
function sideOf(a, b, x, y) {
  return Math.sign((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]));
}

// Of a block's rectangle, the share that lies on `side` of the chord.
function shareOn(block, a, b, side) {
  const [x0, y0, x1, y1] = block;
  const rect = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const whole = area(rect);
  return whole > 0 ? area(clipToSide(rect, a, b, side)) / whole : 0;
}

// The text's chamber of `pts` (an outline, [[x, y], ...]) when it is joined
// bubbles: `{ pts, neck: [a, b] }`, in the outline's own space. Null when there
// is no neck, and when the neck runs through the block ([x0, y0, x1, y1], same
// space): a neck lies between texts, and a chord through one is the dent of a
// decorated frame (measured: a scroll caption's corner), or one text detected
// over a neck, which keeps the whole.
//
// Only `findCut`'s neck and round-lobe gates are used (its `openRecovery`
// mode). Its dent and corner fallbacks are for a user's selection of one
// bubble, and cut scroll and cloud frames here.
export const NECK_HOLDS = 0.97;
export function neckChamber(pts, block) {
  if (!Array.isArray(pts) || pts.length < 3 || !Array.isArray(block) || block.length !== 4) return null;
  const click = { x: (block[0] + block[2]) / 2, y: (block[1] + block[3]) / 2 };
  const cut = findCut([polygonContour(pts)], click, box(pts), true);
  if (!cut || cut.ambiguous || !cut.neck) return null;
  const [a, b] = cut.neck;
  const side = sideOf(a, b, click.x, click.y);
  if (!side || shareOn(block, a, b, side) < NECK_HOLDS) return null;
  const chamber = clipToSide(pts, a, b, side);
  return chamber.length >= 3 ? { pts: chamber, neck: [a, b] } : null;
}
