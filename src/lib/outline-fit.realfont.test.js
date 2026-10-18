import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { setTypesetEnabled, clearLayoutMemo, brokenLines } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { solveLayout } from './auto-layout.js';
import { fitReport } from './fit-report.js';

// The outline fit on real advances: a line of speech set in an oval balloon
// comes out inside it, with no hyphen the text does not have, in an oval
// block (never an hourglass), and the box keeps the lines it was given.
beforeAll(() => setTypesetEnabled(true));
beforeEach(() => clearLayoutMemo());

const region = { kind: 'ellipse', cx: 200, cy: 200, rx: 95, ry: 120 };
const style = normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', bold: true, size: 18, align: 'center', valign: 'middle', strokes: [], margin: 0.5 });

function solved(text, s = style) {
  const r = solveLayout({ text, style: s, refSize: 18, region, locks: {}, opts: {} });
  const b = { x: r.x, y: r.y, w: r.w, h: r.h, style: { ...s, size: r.size }, fit: region, auto: { breaks: r.breaks } };
  return { r, b, rep: fitReport(b, text) };
}

describe('outline fit with a real face', () => {
  it('sets a long line inside an oval, as an oval, unhyphenated', () => {
    const { r, rep } = solved("BUT I'M JUST SO SO SOCIALLY AWKWARD... I NEVER KNOW WHAT TO SAY");
    expect(r.status).toBe('ok');
    expect(r.size).toBeGreaterThanOrEqual(14);
    expect(rep.inside).toBe(true);
    expect(rep.margin.em).toBeGreaterThanOrEqual(0.25);
    expect(rep.hyphens).toBe(0);
    expect(rep.orphans).toBe(0);
    expect(rep.shape.hourglass).toBe(false);
    expect(['oval', 'short']).toContain(rep.shape.kind);
    expect(Math.abs(rep.centre.dx)).toBeLessThan(4);
    expect(Math.abs(rep.centre.dy)).toBeLessThan(4);
  });

  it('keeps the lines it chose, and drops them once the text changes', () => {
    const text = 'WE CAN STILL CATCH THE LAST TRAIN IF WE RUN';
    const { r, b } = solved(text);
    expect(brokenLines(text, b.style, r.size, r.breaks)).toEqual(r.lines);
    expect(brokenLines(text + '!', b.style, r.size, r.breaks)).toBeNull();
  });

  it('fills a rectangular caption as a rectangle, not an oval', () => {
    const caption = { kind: 'poly', pts: [[40, 60], [400, 60], [400, 190], [40, 190]] };
    const text = 'THE OLD MAN HAD NOT LOST A SINGLE DUEL IN SEVENTY YEARS OF SWORDSMANSHIP';
    const r = solveLayout({ text, style, refSize: 18, region: caption, locks: {}, opts: {} });
    const b = { x: r.x, y: r.y, w: r.w, h: r.h, style: { ...style, size: r.size }, fit: caption, auto: { breaks: r.breaks } };
    const rep = fitReport(b, text);
    expect(rep.inside).toBe(true);
    expect(r.lines.length).toBeGreaterThanOrEqual(3);
    // Every line but the last reaches most of the widest: a block, not a diamond.
    const ws = rep.rows.map((row) => row[0]);
    const max = Math.max(...ws);
    for (const w of ws.slice(0, -1)) expect(w).toBeGreaterThan(0.8 * max);
    expect(rep.shape.kind).not.toBe('oval');
  });

  it('hyphenates only where the box allows it', () => {
    const narrow = { kind: 'ellipse', cx: 200, cy: 200, rx: 52, ry: 90 };
    const text = 'a single stroke suffices extraordinarily';
    const at = (hyphenate) => {
      const s = { ...style, hyphenate };
      const r = solveLayout({ text, style: s, refSize: 18, region: narrow, locks: {}, opts: { minSize: 17 } });
      return fitReport({ x: r.x, y: r.y, w: r.w, h: r.h, style: { ...s, size: r.size }, fit: narrow, auto: { breaks: r.breaks } }, text);
    };
    expect(at(true).hyphens).toBeGreaterThan(0);
    expect(at(false).hyphens).toBe(0);
  });

  it('leaves a style with no margin to the older layout', () => {
    const r = solveLayout({ text: 'WE CAN STILL CATCH THE LAST TRAIN', style: { ...style, margin: null }, refSize: 18, region, locks: {}, opts: {} });
    expect(r.breaks).toBeUndefined();
  });
});
