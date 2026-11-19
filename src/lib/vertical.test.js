// Vertical text (tategaki): `verticalLayout` in measure.js, read as a glyph
// layout by `placeBlock`, the caret (curve-caret.js) and the containment check.
//
// No canvas here, so the stand-in metric: a wide letter is one em, a narrow
// one 0.55 em (`verticalLayout`'s own stand-in).

import { describe, it, expect } from 'vitest';
import { verticalLayout } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { placeBlock, containBox, curvedStyle, verticalStyle, sizesVertically, handPlacedBox } from './contain.js';
import { caretAt, columnKey, selectionBoxes, caretNearest } from './curve-caret.js';

const SIZE = 20;
// No outline, so the inset is the box padding alone (2 px).
const style = (over = {}) => normalizeStyle({ ...defaultStyle(), size: SIZE, lineHeight: 1.5, letterSpacing: 0, strokeEffects: [], vertical: true, align: 'left', ...over });
// A box whose content is `cells` ems tall.
const tall = (cells) => cells * SIZE + 4;
const lay = (text, over, h = tall(10), w = 200) => verticalLayout(text, style(over), SIZE, w, h);
const close = (a, b) => expect(a).toBeCloseTo(b, 6);

describe('verticalLayout', () => {
  it('places one glyph per code point, down the column', () => {
    const g = lay('あいう');
    expect(g).toHaveLength(3);
    expect(g.map((x) => x.ch)).toEqual(['あ', 'い', 'う']);
    // Same column, each an em below the last, starting at the content top.
    expect(new Set(g.map((x) => x.x)).size).toBe(1);
    close(g[0].y, -tall(10) / 2 + 2 + SIZE / 2);
    close(g[1].y - g[0].y, SIZE);
    close(g[2].y - g[1].y, SIZE);
    for (const x of g) expect(x.rot).toBe(0);
  });

  it('orders columns right to left, a line height apart, centred across the box', () => {
    const g = lay('あい\nう');
    expect(g.cols).toBe(2);
    // Two columns: the block is one pitch plus an em wide, about the centre.
    close(g[0].x, (1.5 * SIZE + SIZE) / 2 - SIZE / 2);
    close(g[3].x, g[0].x - 1.5 * SIZE);
    expect(g[3].x).toBeLessThan(g[0].x);
    // The new column starts at the top again.
    close(g[3].y, g[0].y);
  });

  it('wraps a column at the box content height', () => {
    const g = lay('あいうえお', {}, tall(3));
    expect(g.map((x) => x.col)).toEqual([0, 0, 0, 1, 1]);
    close(g[3].y, g[0].y);
    expect(g.cols).toBe(2);
  });

  it('lets a mark that never starts a column hang off the one before', () => {
    const g = lay('あいう。', {}, tall(3));
    expect(g.map((x) => x.col)).toEqual([0, 0, 0, 0]);
  });

  it('turns the long mark, dashes, waves, ellipses and brackets a quarter', () => {
    const g = lay('「あー」…〜');
    expect(g.map((x) => x.rot)).toEqual([Math.PI / 2, 0, Math.PI / 2, Math.PI / 2, Math.PI / 2, Math.PI / 2]);
  });

  it('sets small kana high and to the right, and 、。 to the top right', () => {
    const g = lay('きゃ。');
    close(g[1].x - g[1].cx, 0.12 * SIZE);
    close(g[1].y - g[1].cy, -0.2 * SIZE);
    expect(g[2].x).toBeGreaterThan(g[2].cx);
    expect(g[2].y).toBeLessThan(g[2].cy);
    // The cell is where the caret goes, whatever the nudge.
    close(g[1].cy - g[0].cy, SIZE);
  });

  it('stacks Latin upright, one letter to an em cell, by default', () => {
    const g = lay('abc');
    for (const x of g) expect(x.rot).toBe(0);
    close(g[1].y - g[0].y, SIZE);
    close(g[2].y - g[1].y, SIZE);
  });

  it('runs a Latin word down the column turned sideways when asked', () => {
    const g = lay('abc', { verticalLatin: 'sideways' });
    for (const x of g) expect(x.rot).toBe(Math.PI / 2);
    // Each letter its own advance down the column, not an em.
    close(g[1].y - g[0].y, 0.55 * SIZE);
    // Japanese around it stays upright.
    const m = lay('あabい', { verticalLatin: 'sideways' });
    expect(m.map((x) => x.rot)).toEqual([0, Math.PI / 2, Math.PI / 2, 0]);
  });

  it('moves a Latin word that will not fit to the next column whole', () => {
    // Four cells of room: "ab" fills two, the space one, "cde" (three) wraps.
    const g = lay('ab cde', {}, tall(4));
    expect(g.map((x) => x.col)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('keeps a lone two-digit number upright as a pair in one cell', () => {
    const g = lay('あ12い', { verticalLatin: 'sideways' });
    expect(g[1].rot).toBe(0);
    expect(g[2].rot).toBe(0);
    close(g[1].y, g[2].y);
    expect(g[1].x).toBeLessThan(g[2].x);
    close(g[3].y - g[0].y, 2 * SIZE);
  });

  it('adds letter spacing down the column and aligns each column to its end', () => {
    const g = lay('あい', { letterSpacing: 4 });
    close(g[1].y - g[0].y, SIZE + 4);
    const b = lay('あい', { align: 'right' }, tall(10));
    // The last cell ends at the content bottom.
    close(b[1].y + SIZE / 2, tall(10) / 2 - 2);
    const c = lay('あい', { align: 'center' }, tall(10));
    close((c[0].y + c[1].y) / 2, 0);
  });

  it('marks a Return as nothing to draw, with the end of the column it closes', () => {
    const g = lay('あい\nう');
    expect(g[2].ch).toBe('');
    expect(g[2].col).toBe(1);
    close(g[2].bx, g[0].x);
    close(g[2].by, g[1].cy + SIZE / 2);
  });

  it('scales with the size it is laid out at, as the zoom does', () => {
    const a = verticalLayout('あい\nう', style(), SIZE, 200, tall(10));
    const b = verticalLayout('あい\nう', style(), SIZE * 2, 200, tall(10));
    close(b[3].x, a[3].x * 2);
    close(b[1].y, a[1].y * 2);
  });
});

describe('vertical text in the caret', () => {
  const g = lay('あい\nう');
  it('stands between two letters of a column, across it', () => {
    const c = caretAt(g, 1);
    close(c.y, g[0].cy + SIZE / 2);
    close(c.x, g[0].cx);
    close(c.rot, Math.PI / 2);
  });
  it('stands at the end of a column before its Return, and at the top of the next after it', () => {
    const before = caretAt(g, 2);
    close(before.x, g[0].cx);
    close(before.y, g[1].cy + SIZE / 2);
    const after = caretAt(g, 3);
    close(after.x, g[3].cx);
    close(after.y, g[3].cy - SIZE / 2);
  });
  it('moves Up and Down along the column, Left to the next column and Right back', () => {
    expect(columnKey(g, 1, 'ArrowDown')).toBe(2);
    expect(columnKey(g, 1, 'ArrowUp')).toBe(0);
    // From the top of the first column to the top of the second.
    expect(columnKey(g, 0, 'ArrowLeft')).toBe(3);
    expect(columnKey(g, 3, 'ArrowRight')).toBe(0);
    // Past the last column: the end.
    expect(columnKey(g, 3, 'ArrowLeft')).toBe(4);
    expect(columnKey([{ x: 0, y: 0, rot: 0, w: 1, ch: 'a' }], 0, 'ArrowLeft')).toBe(null);
  });
  it('selects down a column without spanning the gap between columns', () => {
    const boxes = selectionBoxes(g, 0, 4);
    // The Return draws no box.
    expect(boxes).toHaveLength(3);
    for (const b of boxes) close(b.rot, Math.PI / 2);
    close(boxes[2].w, SIZE);
  });
  it('finds the caret nearest a click in a column', () => {
    expect(caretNearest(g, g[1].cx, g[1].cy + 5)).toBe(2);
    expect(caretNearest(g, g[3].cx, g[3].cy - 5)).toBe(3);
  });
});

describe('vertical text as a box', () => {
  const cand = (over, w = 120, h = tall(5)) => ({ x: 0, y: 0, w, h, style: style(over), text: 'あいうえおかきくけこ', runs: null, fit: null, mask: null, breaks: null });

  it('is placed as a glyph layout that says it is vertical', () => {
    const p = placeBlock(cand());
    expect(p.isCurve).toBe(true);
    expect(p.vertical).toBe(true);
    expect(p.layout).toHaveLength(10);
    expect(p.layout.cols).toBe(2);
  });

  it('is horizontal while a bend is on, and while the switch is off', () => {
    expect(verticalStyle(style({ curve: 30 }))).toBe(false);
    expect(verticalStyle(style({ vertical: false }))).toBe(false);
    expect(placeBlock(cand({ vertical: false })).isCurve).toBe(false);
    expect(curvedStyle(style())).toBe(true);
  });

  it('is sized by the app only by its columns', () => {
    expect(handPlacedBox(cand())).toBe(true);
    expect(sizesVertically(cand())).toBe(true);
  });

  it('overflows sideways when its columns are wider than the box', () => {
    const wide = containBox(cand({}, 120), placeBlock(cand({}, 120)));
    expect(wide.fits).toBe(true);
    const narrow = cand({}, 30);
    const v = containBox(narrow, placeBlock(narrow));
    expect(v.fits).toBe(false);
    expect(v.overflow.l).toBeGreaterThan(0);
    expect(v.overflow.r).toBeGreaterThan(0);
  });
});
