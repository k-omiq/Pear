import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { setTypesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { fitReport, fitIssues } from './fit-report.js';
import { fitPolygon } from './outline-geom.js';

// The report on real advances and real ink: a block inside its oval reads as
// inside with air to spare; the same block moved down past the curve reads as
// outside on the bottom, by about the distance it was moved past.
beforeAll(() => setTypesetEnabled(true));
beforeEach(() => clearLayoutMemo());

const oval = { kind: 'poly', pts: fitPolygon({ kind: 'ellipse', cx: 200, cy: 200, rx: 110, ry: 80 }) };
const style = normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', bold: false, size: 18, align: 'center', valign: 'middle', strokes: [] });
const TEXT = 'WE CAN STILL CATCH THE LAST TRAIN';

describe('fitReport with a real face', () => {
  it('measures a block inside its outline', () => {
    const b = { x: 120, y: 160, w: 160, h: 80, style, fit: oval };
    const rep = fitReport(b, TEXT);
    expect(rep.inside).toBe(true);
    expect(rep.margin.px).toBeGreaterThan(5);
    expect(rep.lines).toBeGreaterThan(1);
    expect(Math.abs(rep.centre.dx)).toBeLessThan(3);
    expect(fitIssues(rep).map((i) => i.kind)).not.toContain('outside');
  });

  it('sees ink below the outline', () => {
    const b = { x: 120, y: 160 + 90, w: 160, h: 80, style, fit: oval };
    const rep = fitReport(b, TEXT);
    expect(rep.inside).toBe(false);
    expect(rep.overflow.b).toBeGreaterThan(10);
    expect(fitIssues(rep)[0].kind).toBe('outside');
  });

  it('has nothing to say without an outline', () => {
    expect(fitReport({ x: 0, y: 0, w: 100, h: 40, style, fit: null }, TEXT)).toBeNull();
  });
});
