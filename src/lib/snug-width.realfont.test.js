import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { setTypesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle, normalizeAuto } from './data.js';
import { boxCandidate, placeBlock, containBox, boxHull } from './contain.js';
import { app, loadProjectPages, page, boxText, snugWidthFor, snugBoxes, snugPageBoxes, reviewOf, reviewBox, duplicateBox, copyBox, pasteBox } from './store.svelte.js';
import { lineWidth, textInset } from './measure.js';

// ===========================================================================
// Shrinking a box to its text, and the box as shown around spilled ink
// ===========================================================================
// "Shrink box to text" takes a box's width down to the narrowest that keeps
// every line it has, with the edge its text is aligned to held in place - so
// nothing on the page moves but the box's empty sides. What is checked is what
// the user sees: the lines the box draws (`placeBlock`, which every renderer
// draws from), where the held edge is on the page, and that the ink fits.

beforeAll(() => setTypesetEnabled(true));
beforeEach(() => clearLayoutMemo());

const style = (extra = {}) =>
  normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', bold: true, size: 20, align: 'center', valign: 'middle', strokeEffects: [], ...extra });

function load(boxes) {
  app.chapterRef = null;
  loadProjectPages([
    {
      id: 1, w: 1000, h: 1400,
      lines: boxes.map((b, i) => ({ n: i + 1, en: b.text, tags: [] })),
      boxes: boxes.map((b, i) => ({ id: `b${i}`, lineN: i + 1, text: null, x: 200, y: 300, w: 500, h: 120, fit: null, ...b, text: null, style: style(b.style) })),
    },
  ]);
  return page().boxes;
}

const linesOf = (b) => placeBlock(boxCandidate(b, boxText(b, page()))).lines;
const fits = (b) => containBox(boxCandidate(b, boxText(b, page()))).fits;

// A point on the box's own frame (u, v from its top-left, before the turn),
// where it lands on the page.
function onPage(b, u, v) {
  const a = ((b.style.rotation || 0) * Math.PI) / 180;
  const ox = u - b.w / 2;
  const oy = v - b.h / 2;
  return [b.x + b.w / 2 + ox * Math.cos(a) - oy * Math.sin(a), b.y + b.h / 2 + ox * Math.sin(a) + oy * Math.cos(a)];
}

describe('shrink a box to its text', () => {
  it('centred text: both sides come in, the lines and the centre stay', () => {
    const [b] = load([{ text: 'HELLO THERE' }]);
    const lines = linesOf(b);
    const centre = onPage(b, b.w / 2, b.h / 2);
    expect(snugBoxes([{ page: page(), box: b }], { quiet: true })).toBe(1);
    expect(b.w).toBeLessThan(300);
    expect(linesOf(b)).toEqual(lines);
    const now = onPage(b, b.w / 2, b.h / 2);
    expect(now[0]).toBeCloseTo(centre[0], 6);
    expect(now[1]).toBeCloseTo(centre[1], 6);
    expect(fits(b)).toBe(true);
  });

  it('left-aligned text keeps its left edge; right-aligned its right, turned with the box', () => {
    const [l, r] = load([
      { text: 'HELLO THERE', style: { align: 'left' } },
      { text: 'HELLO THERE', style: { align: 'right', rotation: 30 } },
    ]);
    const left = onPage(l, 0, l.h / 2);
    const right = onPage(r, r.w, r.h / 2);
    expect(snugBoxes([{ page: page(), box: l }, { page: page(), box: r }], { quiet: true })).toBe(2);
    const l2 = onPage(l, 0, l.h / 2);
    const r2 = onPage(r, r.w, r.h / 2);
    expect(l2[0]).toBeCloseTo(left[0], 6);
    expect(l2[1]).toBeCloseTo(left[1], 6);
    expect(r2[0]).toBeCloseTo(right[0], 6);
    expect(r2[1]).toBeCloseTo(right[1], 6);
  });

  it('a flipped box holds the edge its text shows against', () => {
    const [b] = load([{ text: 'HELLO THERE', style: { align: 'left', flipH: true } }]);
    const right = onPage(b, b.w, b.h / 2);
    snugBoxes([{ page: page(), box: b }], { quiet: true });
    const now = onPage(b, b.w, b.h / 2);
    expect(now[0]).toBeCloseTo(right[0], 6);
  });

  it('keeps several lines as they broke, and asks for nothing once snug', () => {
    const [b] = load([{ text: 'THE TRUTH OF THE SWORD, I SHALL BEAR WITNESS TO IT', w: 260 }]);
    const lines = linesOf(b);
    expect(lines.length).toBeGreaterThan(1);
    snugBoxes([{ page: page(), box: b }], { quiet: true });
    expect(linesOf(b)).toEqual(lines);
    expect(snugWidthFor(b, page())).toBeNull();
  });

  it('leaves a curve, a locked box and Fit to box alone', () => {
    const boxes = load([
      { text: 'HELLO THERE', style: { curve: 40 } },
      { text: 'HELLO THERE', locked: true },
      { text: 'HELLO THERE', style: { fitText: true } },
    ]);
    for (const b of boxes) expect(snugWidthFor(b, page())).toBeNull();
  });

  it('leaves a little air either side of the widest line', () => {
    const [b] = load([{ text: 'HELLO THERE' }]);
    snugBoxes([{ page: page(), box: b }], { quiet: true });
    const widest = Math.max(...linesOf(b).map((l) => lineWidth(l.trim(), b.style, b.style.size)));
    const spare = b.w - widest - 2 * textInset(b.style);
    expect(spare).toBeGreaterThanOrEqual(2 * 4);
    expect(spare).toBeLessThan(2 * 0.25 * b.style.size + 4);
  });

  it('a duplicate and a paste are born shrunk; a width set by hand stays', () => {
    const [b, locked] = load([{ text: 'HELLO THERE' }, { text: 'HELLO THERE', y: 600, auto: normalizeAuto({ refSize: 20, locks: { width: true } }) }]);
    const lines = linesOf(b);
    const byId = (id) => page().boxes.find((x) => x.id === id);
    const dup = byId(duplicateBox(b.id, page(), { select: false }));
    expect(dup.w).toBeLessThan(b.w);
    expect(linesOf(dup)).toEqual(lines);
    copyBox(b.id);
    const pasted = byId(pasteBox());
    expect(pasted.w).toBe(dup.w);
    const kept = byId(duplicateBox(locked.id, page(), { select: false }));
    expect(kept.w).toBe(locked.w);
  });

  it('the page action shrinks every box that can be', () => {
    const boxes = load([{ text: 'HI' }, { text: 'HELLO THERE' }, { text: 'HELLO', style: { curve: 40 } }]);
    const w = boxes.map((b) => b.w);
    expect(snugPageBoxes()).toBe(2);
    expect(boxes[0].w).toBeLessThan(w[0]);
    expect(boxes[1].w).toBeLessThan(w[1]);
    expect(boxes[2].w).toBe(w[2]);
  });
});

describe('the box as shown holds ink that spills out of it', () => {
  it('grows only on the sides the ink is past, by the ink plus a little air', () => {
    const h = boxHull({ style: { size: 20 }, review: { overflow: { l: 0, t: 30, r: 5, b: 0 } } });
    expect(h.l).toBe(0);
    expect(h.b).toBe(0);
    expect(h.t).toBeGreaterThan(30);
    expect(h.r).toBeGreaterThan(5);
    expect(h.t - 30).toBe(h.r - 5);
    expect(boxHull({ style: { size: 20 } })).toEqual({ l: 0, t: 0, r: 0, b: 0 });
  });

  it('a curve bowing out of its box: the box grows at the top, the flag stays down', () => {
    const [b] = load([{ text: 'CURVED WORDS GO HERE', w: 160, h: 40, style: { curve: 120 } }]);
    reviewBox(b, page());
    expect(b.review?.overflow).toBeTruthy();
    const h = boxHull(b);
    expect(h.l + h.t + h.r + h.b).toBeGreaterThan(0);
    expect(reviewOf(b, page())).toBeNull();
  });

  it('straight text in a box too small for it is still flagged', () => {
    const [b] = load([{ text: 'THE TRUTH OF THE SWORD, I SHALL BEAR WITNESS TO IT', w: 120, h: 30, style: { autoHeight: false } }]);
    // A chapter opening grows a height to hold its lines; this one is cut
    // short again by hand.
    b.h = 30;
    reviewBox(b, page());
    expect(reviewOf(b, page())).toBeTruthy();
  });
});
