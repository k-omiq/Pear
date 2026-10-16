import { describe, it, expect } from 'vitest';
import { shapeOf, addedHyphens, orphanCount, fitIssues, fitQuality } from './fit-report.js';
import { fitPolygon, intervalsAt, roomOver, visualCentre } from './outline-geom.js';

describe('the line-width profile', () => {
  it('names an oval, an hourglass, a funnel, a pyramid and a rectangle', () => {
    expect(shapeOf([60, 100, 60]).kind).toBe('oval');
    expect(shapeOf([62, 86, 100, 86, 62]).oval).toBeGreaterThan(0.9);
    expect(shapeOf([100, 60, 100]).kind).toBe('hourglass');
    expect(shapeOf([90, 100, 70, 98]).hourglass).toBe(true);
    expect(shapeOf([100, 80, 60]).kind).toBe('funnel');
    expect(shapeOf([50, 70, 100]).kind).toBe('pyramid');
    expect(shapeOf([96, 100, 97]).kind).toBe('rect');
    expect(shapeOf([80, 100]).kind).toBe('short');
  });

  it('counts added hyphens and short orphans only', () => {
    expect(addedHyphens(['SO-', 'CIALLY', 'WELL-', 'KNOWN'], 'SOCIALLY WELL-KNOWN')).toBe(1);
    expect(orphanCount(['OH,', 'IS THAT', 'SO?'])).toBe(2);
    expect(orphanCount(['OH, IS', 'THAT SO?'])).toBe(0);
    expect(orphanCount(['HI'])).toBe(0);
  });

  it('turns a report into issues', () => {
    const rep = { size: 16, inside: false, overflow: { l: 0, t: 0, r: 0, b: 7 }, margin: { px: -7, em: -0.44 }, rows: [[40, 50], [30, 60], [40, 50]], shape: shapeOf([40, 30, 40]), centre: { dx: 0, dy: 9 }, hyphens: 2, orphans: 0 };
    expect(fitIssues(rep).map((i) => i.kind)).toEqual(['outside', 'hourglass', 'offcentre', 'hyphen']);
    const ok = { ...rep, inside: true, overflow: undefined, margin: { px: 8, em: 0.5 }, shape: shapeOf([40, 60, 40]), centre: { dx: 1, dy: 2 }, hyphens: 0 };
    expect(fitIssues(ok)).toEqual([]);
  });
});

describe('the outline as a polygon', () => {
  it('reads every fit kind as points, with its room and its centre', () => {
    const ell = fitPolygon({ kind: 'ellipse', cx: 100, cy: 100, rx: 50, ry: 30 });
    expect(ell.length).toBe(64);
    const [l, r] = intervalsAt(ell, 100)[0];
    expect(r - l).toBeGreaterThan(99);
    const rect = fitPolygon({ kind: 'rect', x: 0, y: 0, w: 40, h: 20 });
    expect(roomOver(rect, 5, 15)).toEqual([0, 40]);
    expect(roomOver(rect, 15, 25)).toBeNull();
    const c = visualCentre(fitPolygon({ kind: 'rect', x: 10, y: 20, w: 40, h: 20 }));
    expect(c).toEqual([30, 30]);
    // A band near the crown of the oval is narrower than its middle.
    const crown = roomOver(ell, 72, 80);
    expect(crown[1] - crown[0]).toBeLessThan(r - l - 30);
  });
});

describe('fitQuality', () => {
  const good = { size: 16, inside: true, margin: { px: 9, em: 0.56 }, shape: { kind: 'oval', oval: 0.9, hourglass: false }, centre: { dx: 0, dy: 1 }, hyphens: 0, orphans: 0, fill: 0.35 };
  it('scores a well lettered balloon high, and each broken rule lower', () => {
    const q = fitQuality(good, { ref: 16 });
    expect(q).toBeGreaterThanOrEqual(90);
    expect(fitQuality({ ...good, inside: false, overflow: { l: 0, t: 6, r: 0, b: 0 } }, { ref: 16 })).toBeLessThan(q - 40);
    expect(fitQuality({ ...good, shape: { kind: 'hourglass', oval: 0.6, hourglass: true } }, { ref: 16 })).toBeLessThan(q - 25);
    expect(fitQuality({ ...good, hyphens: 1 }, { ref: 16 })).toBe(q - 10);
    expect(fitQuality({ ...good, size: 12 }, { ref: 16 })).toBeLessThan(q - 15);
    expect(fitQuality({ ...good, margin: { px: 2, em: 0.12 } }, { ref: 16 })).toBeLessThan(q - 20);
    // A caption frame asks no oval of its block.
    expect(fitQuality({ ...good, shape: { kind: 'rect', oval: 0.5, hourglass: false } }, { round: false, ref: 16 })).toBe(fitQuality(good, { round: false, ref: 16 }));
    expect(fitQuality(null)).toBeNull();
  });
});
