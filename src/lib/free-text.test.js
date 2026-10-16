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
