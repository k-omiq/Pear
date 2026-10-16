import { describe, expect, it } from 'vitest';
import {
  MAX_SIDE,
  clampRect,
  chooseScale,
  outSize,
  rulerTicks,
  sheetLayout,
  splitSheets,
  proofOrder,
  boxBounds,
  cropFor,
  fitInCell,
  encodingFor,
  markOf,
} from './render.js';

describe('clampRect', () => {
  it('is the whole page when no rect is given', () => {
    expect(clampRect(null, 800, 1200)).toEqual([0, 0, 800, 1200]);
    expect(clampRect(undefined, 800, 1200)).toEqual([0, 0, 800, 1200]);
  });

  it('clamps to the page and rounds outward', () => {
    expect(clampRect([-50, -10, 200, 100], 800, 1200)).toEqual([0, 0, 150, 90]);
    expect(clampRect([700.4, 1100.6, 500, 500], 800, 1200)).toEqual([700, 1100, 100, 100]);
    expect(clampRect([10.5, 20.5, 10, 10], 800, 1200)).toEqual([10, 20, 11, 11]);
  });

  it('turns a negative size around', () => {
    expect(clampRect([100, 100, -50, -20], 800, 1200)).toEqual([50, 80, 50, 20]);
  });

  it('is null for a rect off the page or malformed', () => {
    expect(clampRect([900, 0, 100, 100], 800, 1200)).toBeNull();
    expect(clampRect([0, 0, 0, 100], 800, 1200)).toBeNull();
    expect(clampRect([0, 0, 100], 800, 1200)).toBeNull();
    expect(clampRect([0, 0, NaN, 100], 800, 1200)).toBeNull();
    expect(clampRect('0,0,1,1', 800, 1200)).toBeNull();
  });
});

describe('chooseScale', () => {
  it('fits the long side to the cap', () => {
    expect(chooseScale(2000, 3136)).toBeCloseTo(0.5);
    const [w, h] = outSize(2000, 3136, chooseScale(2000, 3136));
    expect(Math.max(w, h)).toBe(MAX_SIDE);
  });

  it('never upscales past 2', () => {
    expect(chooseScale(100, 50)).toBe(2);
    expect(chooseScale(100, 50, 5)).toBe(2);
  });

  it('takes a given scale, still within the long side', () => {
    expect(chooseScale(400, 300, 1.5)).toBe(1.5);
    expect(chooseScale(2000, 1000, 1)).toBeCloseTo(MAX_SIDE / 2000);
  });

  it('ignores a scale that is no scale', () => {
    expect(chooseScale(784, 100, 0)).toBe(2);
    expect(chooseScale(784, 100, -1)).toBe(2);
    expect(chooseScale(784, 100, NaN)).toBe(2);
  });
});

describe('rulerTicks', () => {
  it('ticks every 100 page px inside the crop, positions in image px', () => {
    const t = rulerTicks(150, 400, 1);
    expect(t.map((x) => x.at)).toEqual([200, 300, 400, 500]);
    expect(t.map((x) => x.pos)).toEqual([50, 150, 250, 350]);
    expect(t.every((x) => x.label === String(x.at))).toBe(true);
  });

  it('thins the numbers when ticks are close, never the ticks', () => {
    const t = rulerTicks(0, 3000, 0.25);
    expect(t).toHaveLength(30);
    const labelled = t.filter((x) => x.label).map((x) => x.at);
    expect(labelled).toEqual([0, 500, 1000, 1500, 2000, 2500]);
  });
});

describe('sheetLayout', () => {
  it('is empty for no cells', () => {
    expect(sheetLayout(0)).toMatchObject({ cols: 0, rows: 0, width: 0, height: 0, cells: [] });
  });

  it('keeps the asked cell size when it fits', () => {
    const L = sheetLayout(4, { cell: 360, gap: 8 });
    expect([L.cols, L.rows, L.cell]).toEqual([2, 2, 360]);
    expect([L.width, L.height]).toEqual([8 + 2 * 368, 8 + 2 * 368]);
    expect(L.cells[3]).toEqual({ x: 376, y: 376, w: 360, h: 360 });
  });

  it('shrinks the cells so twenty stay within the long side', () => {
    const L = sheetLayout(20, { cell: 360 });
    expect([L.cols, L.rows]).toEqual([5, 4]);
    expect(L.cell).toBeLessThan(360);
    expect(Math.max(L.width, L.height)).toBeLessThanOrEqual(MAX_SIDE);
    expect(L.cells).toHaveLength(20);
  });

  it.each([1, 2, 3, 7, 13, 20, 50])('%i cells: inside the sheet, no overlap, long side capped', (n) => {
    const L = sheetLayout(n);
    expect(Math.max(L.width, L.height)).toBeLessThanOrEqual(MAX_SIDE);
    for (const c of L.cells) {
      expect(c.x + c.w).toBeLessThanOrEqual(L.width);
      expect(c.y + c.h).toBeLessThanOrEqual(L.height);
    }
    for (let i = 0; i < L.cells.length; i++) {
      for (let j = i + 1; j < L.cells.length; j++) {
        const a = L.cells[i];
        const b = L.cells[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
  });

  it('cells read left to right, top to bottom', () => {
    const L = sheetLayout(5);
    expect(L.cells.map((c) => [c.x, c.y])).toEqual([
      [8, 8], [8 + L.cell + 8, 8], [8 + 2 * (L.cell + 8), 8], [8, 8 + L.cell + 8], [8 + L.cell + 8, 8 + L.cell + 8],
    ]);
  });
});

describe('splitSheets', () => {
  const items = Array.from({ length: 75 }, (_, i) => i);

  it('cuts into sheets of perSheet, at most maxSheets, counting the rest', () => {
    const { sheets, left } = splitSheets(items, 20, 3);
    expect(sheets.map((s) => s.length)).toEqual([20, 20, 20]);
    expect(sheets[1][0]).toBe(20);
    expect(left).toBe(15);
  });

  it('a short list is one short sheet', () => {
    expect(splitSheets([1, 2, 3], 20, 3)).toEqual({ sheets: [[1, 2, 3]], left: 0 });
    expect(splitSheets([], 20, 3)).toEqual({ sheets: [], left: 0 });
  });
});

describe('proofOrder', () => {
  const fit = { kind: 'rect', x: 0, y: 0, w: 10, h: 10 };
  const b = (id, outline, withFit = true) => ({ id, ...(withFit ? { fit } : {}), outline });

  it('puts unapproved first, lowest confidence first, ties in the order given, approved last in the order given', () => {
    const boxes = [
      b('user', { confidence: 0.2, approved: 'user' }),
      b('w8', { confidence: 0.8, approved: null }),
      b('ai', { confidence: 0.1, approved: 'ai' }),
      b('w3', { confidence: 0.3, approved: null }),
      b('open', { confidence: 0, approved: null, open: true }, false),
      b('w3b', { confidence: 0.3, approved: null }),
      b('none', undefined, false),
    ];
    expect(proofOrder(boxes).map((x) => x.id)).toEqual(['open', 'none', 'w3', 'w3b', 'w8', 'user', 'ai']);
  });

  it('reads the box out of a match', () => {
    const items = [{ box: b('a', { confidence: 0.9, approved: null }) }, { box: b('b', { confidence: 0.1, approved: null }) }];
    expect(proofOrder(items).map((x) => x.box.id)).toEqual(['b', 'a']);
  });
});

describe('crops', () => {
  it('boxBounds turns with the box', () => {
    expect(boxBounds({ x: 10, y: 20, w: 40, h: 20 })).toEqual([10, 20, 40, 20]);
    const [x, y, w, h] = boxBounds({ x: 10, y: 20, w: 40, h: 20, style: { rotation: 90 } });
    expect([x, y, w, h].map((v) => Math.round(v))).toEqual([20, 10, 20, 40]);
  });

  it('cropFor pads the box and its outline by a quarter, clamped to the page', () => {
    const m = markOf({ id: 'b1', x: 100, y: 100, w: 200, h: 100, fit: { kind: 'rect', x: 80, y: 90, w: 240, h: 120 } });
    expect(cropFor(m, 1000, 1000)).toEqual([20, 60, 360, 180]);
    const edge = markOf({ id: 'b2', x: 0, y: 0, w: 40, h: 40 });
    expect(cropFor(edge, 1000, 1000)).toEqual([0, 0, 56, 56]);
  });

  it('fitInCell centres the crop and never scales past 2', () => {
    expect(fitInCell(200, 100, { x: 0, y: 0, w: 300, h: 300 })).toEqual({ s: 1.5, x: 0, y: 75, w: 300, h: 150 });
    expect(fitInCell(50, 50, { x: 10, y: 10, w: 300, h: 300 })).toEqual({ s: 2, x: 110, y: 110, w: 100, h: 100 });
  });
});

describe('markOf', () => {
  it('reads plain geometry, the outline state and its points, and no text', () => {
    const m = markOf({
      id: 'b7',
      text: 'page words',
      x: 1, y: 2, w: 3, h: 4,
      fit: { kind: 'rect', x: 0, y: 0, w: 10, h: 10 },
      outline: { confidence: 0.4, approved: null },
    });
    expect(m).toMatchObject({ id: 'b7', state: 'waiting', confidence: 0.4, points: [[0, 0], [10, 0], [10, 10], [0, 10]] });
    expect(JSON.stringify(m)).not.toContain('page words');
  });

  it('an open outline has no points', () => {
    expect(markOf({ id: 'b', x: 0, y: 0, w: 1, h: 1, outline: { open: true, confidence: 0 } })).toMatchObject({ state: 'open', points: [] });
  });
});

describe('encodingFor', () => {
  it('stays PNG until the base64 passes the cap', () => {
    expect(encodingFor(1000)).toBe('image/png');
    expect(encodingFor(1_500_000)).toBe('image/png');
    expect(encodingFor(1_500_001)).toBe('image/jpeg');
  });
});
