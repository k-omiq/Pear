import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { setTypesetEnabled, clearLayoutMemo, lineWidth, textInset } from './measure.js';
import { defaultStyle, normalizeStyle, normalizeAuto } from './data.js';
import { boxCandidate, placeBlock } from './contain.js';
import { resizeBoxMath } from './resize-math.js';
import { app, loadProjectPages, page, resizeBox, retypesetBox, setBoxText, boxText, edgeDragFloor, edgeDragWidthFloor } from './store.svelte.js';

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

// A side drag never changes the size. Narrower than the widest word, the word
// is hyphenated when the box allows it, so the side goes on past it; a top or
// bottom edge dragged past the text widens the box instead of squashing it.
describe('a side past the text', () => {
  const loadWord = (extra = {}) => {
    app.chapterRef = null;
    loadProjectPages([
      {
        id: 1, w: 1000, h: 1400,
        lines: [{ n: 1, en: 'UNBELIEVABLE COMPREHENSION', tags: [] }],
        boxes: [{ id: 'a', lineN: 1, text: null, x: 300, y: 300, w: 400, h: 120, style: style(extra), fit: null }],
      },
    ]);
    return page().boxes[0];
  };
  const wordWidth = (b) => Math.ceil(lineWidth('COMPREHENSION', b.style, b.style.size) + 2 * textInset(b.style));

  it('hyphenates: the width goes below the widest word, every line fits, the size stays', () => {
    const b = loadWord();
    const word = wordWidth(b);
    const floor = edgeDragWidthFloor(b, page());
    expect(floor).toBeLessThan(word);
    resizeBox(1, b.id, { w: floor }, { w: b.w, h: b.h });
    expect(b.w).toBe(floor);
    expect(b.style.size).toBe(20);
    expect(linesOf(b).some((l) => l.trim().endsWith('-'))).toBe(true);
    expect(widest(b)).toBeLessThanOrEqual(room(b) + 0.5);
  });

  it('splits a word with no syllable to cut when the width goes below it', () => {
    app.chapterRef = null;
    loadProjectPages([
      {
        id: 1, w: 1000, h: 1400,
        lines: [{ n: 1, en: 'BEAM TRUTH', tags: [] }],
        boxes: [{ id: 'a', lineN: 1, text: null, x: 300, y: 300, w: 400, h: 120, style: style(), fit: null, auto: normalizeAuto({ refSize: 20 }) }],
      },
    ]);
    const b = page().boxes[0];
    const word = Math.ceil(lineWidth('TRUTH', b.style, b.style.size) + 2 * textInset(b.style));
    const floor = edgeDragWidthFloor(b, page());
    expect(floor).toBeLessThan(word);
    resizeBox(1, b.id, { w: floor }, { w: b.w, h: b.h });
    expect(b.w).toBe(floor);
    expect(b.style.size).toBe(20);
    expect(linesOf(b).some((l) => l.trim().endsWith('-'))).toBe(true);
    expect(widest(b)).toBeLessThanOrEqual(room(b) + 0.5);
  });

  it('with "Hyphenate long words" off it stops at the widest word', () => {
    const b = loadWord({ hyphenate: false });
    expect(edgeDragWidthFloor(b, page())).toBe(wordWidth(b));
  });

  // The plain wrap (`PLAIN_BREAKS`) never hyphenates, so its side used to stop
  // at the widest word. A width set below it gives the box hyphenation.
  // (The plain wrap itself, `shape: 'off'`, is measured by the DOM, which this
  // lane does not have; `hyphenateForWidth` turns its shape back on too.)
  for (const [name, extra] of [['"Hyphenate long words" off', { hyphenate: false }]]) {
    it(`with ${name}, a width below the widest word turns hyphenation on and goes past it`, () => {
      const b = loadWord(extra);
      const word = wordWidth(b);
      resizeBox(1, b.id, { w: word - 30 }, { w: b.w, h: b.h });
      expect(b.style.hyphenate).toBe(true);
      expect(b.style.shape).not.toBe('off');
      expect(b.w).toBeLessThan(word);
      expect(linesOf(b).some((l) => l.trim().endsWith('-'))).toBe(true);
      expect(widest(b)).toBeLessThanOrEqual(room(b) + 0.5);
    });
  }

  it('a width that still holds the widest word leaves hyphenation as it was', () => {
    const b = loadWord({ hyphenate: false });
    resizeBox(1, b.id, { w: wordWidth(b) + 10 }, { w: b.w, h: b.h });
    expect(b.style.hyphenate).toBe(false);
  });
});

// The bottom edge sets the size and nothing else: the lines are the lines
// they were, at every step of the drag, outline fit or not. A corner moved
// straight up or down is the bottom edge; moved sideways it sets the width
// too, and the lines break again in it. A side after a scale breaks them
// again.
describe('a size drag keeps the layout', () => {
  const dragScale = (b, dir, dx, dy) => {
    const o = { x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size };
    const base = { w: o.w, h: o.h, style: JSON.parse(JSON.stringify(b.style)) };
    const floor = edgeDragWidthFloor(b, page());
    for (const f of [0.25, 0.5, 0.75, 1]) resizeBox(1, b.id, resizeBoxMath(dx * f, dy * f, dir, o, 0, 30, Math.min(floor, o.w), { scale: true }), base);
  };
  const scaleBy = (b, dx, dy) => dragScale(b, 's', dx, dy);
  for (const [name, opts] of [['an outline-fit box', {}], ['a box on bare paper', { fit: null, margin: null }]]) {
    for (const [dir, dy] of [['s', 23], ['s', -19], ['s', 61], ['se', 40], ['nw', 30], ['sw', -15]]) {
      it(`${name}, ${dir} by ${dy}`, () => {
        const b = load(opts);
        const before = linesOf(b).map((l) => l.trim());
        const size = b.style.size;
        dragScale(b, dir, 0, dy);
        expect(b.style.size).not.toBe(size);
        expect(linesOf(b).map((l) => l.trim())).toEqual(before);
      });
    }
    it(`${name}: a corner moved sideways too sets the width, and the lines fit it`, () => {
      const b = load(opts);
      const size = b.style.size;
      dragScale(b, 'se', -60, 20);
      expect(b.style.size).toBeGreaterThan(size);
      expect(b.auto.locks.width).toBe(true);
      expect(b.auto.breaks?.scaled).not.toBe(true);
      expect(widest(b)).toBeLessThanOrEqual(room(b) + 0.5);
    });
    // The balloon fit used to send a box to the page's width once a drag
    // asked it for a height its rows could not reach.
    it(`${name}: no size or width drag runs the width away`, () => {
      const b = load(opts);
      const w0 = b.w;
      dragScale(b, 's', 0, -40);
      expect(b.w).toBeLessThanOrEqual(w0);
      dragScale(b, 'se', 30, -10);
      expect(b.w).toBeLessThan(w0 + 60);
      drag(b, 'e', -40, 0);
      expect(b.w).toBeLessThan(w0 + 60);
    });
  }
  it('a side after a scale breaks the lines again', () => {
    const b = load({ fit: null, margin: null });
    scaleBy(b, 40, 30);
    expect(b.auto.breaks?.scaled).toBe(true);
    const held = linesOf(b);
    drag(b, 'e', -80, 0);
    expect(b.auto.breaks).toBeUndefined();
    expect(linesOf(b).length).toBeGreaterThan(held.length);
    expect(widest(b)).toBeLessThanOrEqual(room(b) + 0.5);
  });
});
