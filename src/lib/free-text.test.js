// Free lettering the second detector found (DTC-2) has no bubble to measure.
import { describe, expect, it } from 'vitest';
import { loadProjectPages, page, measureBalloon } from './store.svelte.js';

const white = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) });

describe('measuring a block the second detector called free text', () => {
  it('is an open outline, with no fit', () => {
    loadProjectPages([{ id: 1, w: 200, h: 200, lines: [], boxes: [], detect: { panels: [], boxes: [
      { n: 1, box: [40, 40, 80, 120], vertical: true, font_size: 20, kind: 'free' },
    ] } }]);
    const m = measureBalloon(page(), [40, 40, 80, 120], white(200, 200));
    expect(m.fit).toBe(null);
    expect(m.outline.open).toBe(true);
  });

  it('is measured as before when the box is bubble text or unclassed', () => {
    for (const kind of ['bubble', undefined]) {
      loadProjectPages([{ id: 1, w: 200, h: 200, lines: [], boxes: [], detect: { panels: [], boxes: [
        { n: 1, box: [40, 40, 80, 120], vertical: true, font_size: 20, ...(kind ? { kind } : {}) },
      ] } }]);
      const before = JSON.stringify(measureBalloon(page(), [40, 40, 80, 120], white(200, 200)));
      loadProjectPages([{ id: 1, w: 200, h: 200, lines: [], boxes: [], detect: { panels: [], boxes: [] } }]);
      expect(JSON.stringify(measureBalloon(page(), [40, 40, 80, 120], white(200, 200)))).toBe(before);
    }
  });
});

describe('measuring a block inside a bubble the second detector found', () => {
  const load = (bubbles) =>
    loadProjectPages([{ id: 1, w: 400, h: 400, lines: [], boxes: [], detect: { panels: [], bubbles, boxes: [
      { n: 1, box: [180, 170, 220, 230], vertical: true, font_size: 20, kind: 'bubble' },
    ] } }]);

  it('keeps the bubble rectangles through a load, and drops broken ones', () => {
    load([[100, 100, 300, 300], [1, 2, 3], 'x']);
    expect(page().detect.bubbles).toEqual([[100, 100, 300, 300]]);
  });

  it('falls back to the oval in the bubble box when no outline can be traced', () => {
    load([[100, 100, 300, 300]]);
    const m = measureBalloon(page(), [180, 170, 220, 230], white(400, 400));
    expect(m.fit).toMatchObject({ kind: 'ellipse', cx: 200, cy: 200 });
    expect(m.outline).toMatchObject({ source: 'bubble', confidence: 0.4 });
  });

  it('is open for text off to one side of the bubble box: one lobe of a joined pair', () => {
    load([[0, 100, 900, 300]]);
    expect(measureBalloon(page(), [180, 170, 220, 230], white(400, 400)).outline.open).toBe(true);
  });
});
