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

  it('leaves a style with no margin to the older layout', () => {
    const r = solveLayout({ text: 'WE CAN STILL CATCH THE LAST TRAIN', style: { ...style, margin: null }, refSize: 18, region, locks: {}, opts: {} });
    expect(r.breaks).toBeUndefined();
  });
});
