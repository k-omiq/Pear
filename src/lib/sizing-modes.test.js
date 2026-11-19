import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app, loadProjectPages, page, setBoxText, boxEdited, resizeBox, setBoxSizing, autoFitBox, selectBox } from './store.svelte.js';
import { undo } from './editor/history.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo, textInset, layoutLines, contentWidth } from './measure.js';
import { neededHeight } from './typeset.js';
import { sizingOf, normalizeStyle, strokesFromBands } from './data.js';

// ===========================================================================
// The three sizing modes: what you set is what you get
// ===========================================================================
// An edit changes only what the box's mode says (`sizingOf`): Auto height
// gives the height the text needs, both ways; Fixed changes nothing; Fit to
// box sets the size to the largest that fits. Handles and the Inspector's
// fields change the box, never the size, except a scale (Cmd-drag).
//
// An engine that measures by arithmetic, as edge-drag-floor.test.js uses.
function fakeEngine() {
  const ink = (face, text) => ({ width: text.length * face.size * 0.5, left: 0, right: text.length * face.size * 0.5, ascent: face.size * 0.7, descent: face.size * 0.2 });
  return {
    id: 'rust',
    advance: (face, text) => text.length * face.size * 0.5,
    fontBox: (face) => ({ ascent: Math.round(face.size * 0.8), descent: Math.round(face.size * 0.2) }),
    lineInk: ink,
    glyphInk: ink,
    loading: () => false,
    onFontsChange: () => () => {},
    faceReady: () => true,
  };
}
const SHORT = 'HI THERE';
const LONG = 'THE WORDS THAT WERE SET IN THE FACE AND THEN SOME MORE OF THEM';
const open = (over = {}) => {
  const style = normalizeStyle({ font: 'Wild Words', size: 20, lineHeight: 1.1, valign: 'middle', strokeEffects: [], ...over.style });
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [{ id: 'b1', lineN: null, text: SHORT, x: 100, y: 300, w: 200, h: 400, ...over, style }] }]);
  const b = page().boxes[0];
  selectBox(b.id);
  return b;
};
const need = (b) => {
  clearLayoutMemo();
  const n = layoutLines(b.text, b.style, b.style.size, contentWidth(b.w, b.style), null).length;
  return neededHeight(n, b.style, textInset(b.style));
};
const original = { engine: textEngine(), typeset: typesetEnabled() };

beforeEach(() => {
  setTextEngine(fakeEngine());
  setTypesetEnabled(false);
  initHistory();
});
afterEach(() => {
  setTextEngine(original.engine);
  setTypesetEnabled(original.typeset);
  loadProjectPages([]);
  resetHistory();
  app.selectedId = null;
});

describe('Auto height', () => {
  it('gives the height back when the text gets shorter, and never moves the width or the size', () => {
    const b = open({ text: LONG });
    autoFitBox(b);
    const tall = b.h;
    expect(tall).toBe(need(b));
    setBoxText(b, SHORT);
    // No shorter than a box is drawn, 30.
    expect(b.h).toBe(Math.max(30, need(b)));
    expect(b.h).toBeLessThan(tall);
    expect(b.w).toBe(200);
    expect(b.style.size).toBe(20);
  });

  it('a new size keeps the width, and the height follows', () => {
    const b = open({ text: LONG });
    b.style.size = 30;
    boxEdited(b);
    expect(b.w).toBe(200);
    expect(b.style.size).toBe(30);
    expect(b.h).toBe(need(b));
  });

  it('a width set breaks the text again and the height follows', () => {
    const b = open({ text: LONG });
    autoFitBox(b);
    resizeBox(1, 'b1', { w: 400 });
    expect(b.w).toBe(400);
    expect(b.h).toBe(need(b));
    expect(b.style.size).toBe(20);
  });
});

describe('Fixed', () => {
  it('changes nothing for an edit, and flags text that no longer fits', () => {
    const b = open({ h: 60 });
    setBoxSizing(b, 'fixed');
    expect(sizingOf(b.style)).toBe('fixed');
    const before = { x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size };
    setBoxText(b, LONG);
    expect({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size }).toEqual(before);
    expect(b.review).toBeTruthy();
  });

  it('a drag never leaves it shorter than its text', () => {
    const b = open({ text: LONG });
    setBoxSizing(b, 'fixed');
    resizeBox(1, 'b1', { h: 31 });
    expect(b.h).toBe(need(b));
  });
});

describe('Fit to box', () => {
  it('fills the box: shrinks for more text, grows back for less, never past the size it was set at', () => {
    const b = open({ h: 80 });
    setBoxSizing(b, 'fit');
    expect(b.style.fitMax).toBe(20);
    setBoxText(b, LONG);
    expect(b.style.size).toBeLessThan(20);
    // It fits: no flag.
    expect(b.review ?? null).toBe(null);
    setBoxText(b, SHORT);
    expect(b.style.size).toBe(20);
    expect({ w: b.w, h: b.h }).toEqual({ w: 200, h: 80 });
  });

  it('a smaller box shrinks the text, a bigger one gives it back, up to the ceiling', () => {
    const b = open({ text: LONG });
    setBoxSizing(b, 'fit');
    resizeBox(1, 'b1', { h: 50 });
    const small = b.style.size;
    expect(small).toBeLessThan(20);
    expect(b.h).toBe(50);
    resizeBox(1, 'b1', { h: 600 });
    expect(b.style.size).toBe(20);
    expect(b.h).toBe(600);
  });
});

describe('switching modes', () => {
  it('is one undo step', () => {
    const b = open({ text: LONG, h: 60 });
    const before = { h: b.h, size: b.style.size, mode: sizingOf(b.style) };
    setBoxSizing(b, 'fit');
    expect(sizingOf(b.style)).toBe('fit');
    undo();
    expect({ h: b.h, size: b.style.size, mode: sizingOf(b.style) }).toEqual(before);
  });
});

describe('a scale', () => {
  it('changes the box and every length drawn in it by one factor', () => {
    const b = open({ style: { strokeEffects: strokesFromBands([{ color: '#fff', width: 4 }]) } });
    const base = { w: b.w, h: b.h, style: JSON.parse(JSON.stringify(b.style)) };
    resizeBox(1, 'b1', { w: 300, h: 600, scale: 1.5 }, base);
    expect(b.style.size).toBe(30);
    expect(b.style.strokeEffects[0].size).toBe(6);
    // Each step scales from the start, so a drag's steps do not compound.
    resizeBox(1, 'b1', { w: 400, h: 800, scale: 2 }, base);
    expect(b.style.size).toBe(40);
    expect(b.style.strokeEffects[0].size).toBe(8);
  });
});

// Vertical text turns Auto round: the height is the user's and the width is
// what the columns need (`hugColumns`), about the box's centre.
describe('Auto on vertical text', () => {
  const columnsW = (b, cols) => Math.max(30, Math.ceil((cols - 1) * b.style.size * b.style.lineHeight + b.style.size + 2 * textInset(b.style)));
  it('widens the box by its columns, and narrows it again', () => {
    // 400 tall: 19 cells of 20 px a column, so 40 letters are three columns.
    const b = open({ text: 'あ'.repeat(40), style: { vertical: true } });
    const cx = b.x + b.w / 2;
    autoFitBox(b);
    expect(b.w).toBe(columnsW(b, 3));
    expect(b.x + b.w / 2).toBeCloseTo(cx, 6);
    expect(b.h).toBe(400);
    setBoxText(b, 'あ'.repeat(10));
    expect(b.w).toBe(columnsW(b, 1));
  });

  it('keeps a width set by hand, which makes the box Fixed', () => {
    const b = open({ text: 'あ'.repeat(40), style: { vertical: true } });
    autoFitBox(b);
    resizeBox(page().id, b.id, { w: 300 });
    expect(sizingOf(b.style)).toBe('fixed');
    expect(b.w).toBe(300);
  });

  it('leaves a Fixed vertical box as it is', () => {
    const b = open({ text: 'あ'.repeat(40), style: { vertical: true, autoHeight: false } });
    autoFitBox(b);
    expect(b.w).toBe(200);
  });
});
