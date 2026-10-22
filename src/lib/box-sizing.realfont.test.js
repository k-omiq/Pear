import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { setTypesetEnabled, clearLayoutMemo, lineWidth, textInset } from './measure.js';
import { defaultStyle, normalizeStyle, normalizeAuto } from './data.js';
import { boxCandidate, placeBlock } from './contain.js';
import { resizeBoxMath } from './resize-math.js';
import { app, loadProjectPages, page, resizeBox, retypesetBox, setBoxText, boxText, edgeDragFloor } from './store.svelte.js';

// ===========================================================================
// A box sized by hand, on real advances
// ===========================================================================
// The handles go through `resizeBoxMath` and `resizeBox` exactly as TextBox's
// pointer handler sends them. What is checked is what the user sees: the lines
// the box draws (`placeBlock`, which every renderer draws from) and whether
// they fit the box they were dragged to.

beforeAll(() => setTypesetEnabled(true));
beforeEach(() => clearLayoutMemo());

const TEXT = '...The Truth of the Sword... I shall bear witness...';
const style = (extra = {}) =>
  normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', bold: true, size: 20, align: 'center', valign: 'middle', strokes: [], ...extra });

// A speech balloon set by outline fit (`style.margin`), which keeps the lines
// it chooses on the box (`auto.breaks`) - or, with `fit: null`, a box on bare
// paper laid out from itself.
function load({ fit = { kind: 'ellipse', cx: 400, cy: 360, rx: 150, ry: 110 }, margin = 0.5 } = {}) {
  app.chapterRef = null;
  loadProjectPages([
    {
      id: 1, w: 1000, h: 1400,
      lines: [{ n: 1, en: TEXT, tags: [] }],
      boxes: [{ id: 'a', lineN: 1, text: null, x: 300, y: 300, w: 200, h: 120, style: style({ margin }), fit, auto: normalizeAuto({ refSize: 20 }) }],
    },
  ]);
  const b = page().boxes[0];
  retypesetBox('a', page());
  return b;
}

const linesOf = (b) => placeBlock(boxCandidate(b, boxText(b, page()))).lines;
const widest = (b) => Math.max(...linesOf(b).map((l) => lineWidth(l, b.style, b.style.size)));
const room = (b) => b.w - 2 * textInset(b.style);

// One move of a handle, from where the box stands.
function drag(b, dir, dx, dy) {
  const o = { x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size };
  const floor = edgeDragFloor(b, dir, linesOf(b).length, page());
  resizeBox(1, b.id, resizeBoxMath(dx, dy, dir, o, b.style.rotation, floor), { w: o.w, h: o.h });
}

describe('a width made narrower breaks the lines again', () => {
  it('by an edge: the lines are chosen again for the new width, and the width is kept', () => {
    const b = load();
    const before = linesOf(b);
    expect(before).toHaveLength(2);
    drag(b, 'e', -60, 0);
    expect(b.auto.locks.width).toBe(true);
    expect(linesOf(b).length).toBeGreaterThan(before.length);
    expect(widest(b)).toBeLessThanOrEqual(room(b) + 0.5);
  });

  // The fault: a corner moved sideways leaves the height, so the size it
  // scales to is the size the box had - and the outline fit's lines, keyed to
  // that size, were drawn as before in a box 50 px narrower, past its sides.
  it('by a corner that keeps the size: the outline fit\'s lines go, and the text breaks to the box', () => {
    const b = load();
    const size = b.style.size;
    expect(b.auto.breaks).toBeTruthy();
    expect(widest(b)).toBeGreaterThan(room(b) - 50);
    drag(b, 'se', -50, 0);
    expect(b.style.size).toBe(size);
    expect(b.auto.breaks).toBeUndefined();
    expect(widest(b)).toBeLessThanOrEqual(room(b) + 0.5);
  });

  it('on bare paper too', () => {
    const b = load({ fit: null, margin: null });
    const before = linesOf(b);
    drag(b, 'e', -40, 0);
    expect(linesOf(b).length).toBeGreaterThan(before.length);
    expect(widest(b)).toBeLessThanOrEqual(room(b) + 0.5);
  });

  it('except lines held by a lock, which stay as they were', () => {
    const b = load();
    b.auto.locks.breaks = true;
    const held = linesOf(b);
    drag(b, 'e', -60, 0);
    drag(b, 'se', -20, 0);
    expect(b.auto.breaks).toBeTruthy();
    expect(linesOf(b)).toEqual(held);
  });

  // The edge stops at the widest held line, as it stops at the widest word:
  // a drag never leaves lines hanging out of the box.
  it('and lines held by a lock stop the edge where they would no longer fit', () => {
    const b = load();
    b.auto.locks.breaks = true;
    b.auto.locks.size = true;
    const held = linesOf(b);
    drag(b, 'e', -80, 0);
    expect(linesOf(b)).toEqual(held);
    expect(widest(b)).toBeLessThanOrEqual(room(b) + 0.5);
    expect(b.review).toBeUndefined();
  });
});

describe('a height set by hand', () => {
  // The fault: the next keystroke's solve set the height back to what the
  // lines need, so a box dragged taller for air lost it at once.
  it('is kept through the next edit', () => {
    const b = load({ fit: null, margin: null });
    const w = b.w;
    drag(b, 's', 0, 80);
    const h = b.h;
    expect(b.auto.locks.height).toBe(true);
    setBoxText(b, TEXT + '!', page());
    expect(b.h).toBe(h);
    expect(b.w).toBe(w);
  });

  it('moves the edge and nothing else', () => {
    const b = load();
    const { x, w } = b;
    const lines = linesOf(b);
    const size = b.style.size;
    drag(b, 's', 0, 40);
    expect([b.x, b.w, b.style.size]).toEqual([x, w, size]);
    expect(linesOf(b)).toEqual(lines);
  });
});
