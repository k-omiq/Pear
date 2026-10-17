import { describe, expect, it } from 'vitest';
import { boxCorners, boxCollisions, panelCrossings, sizeOutliers, countedChecks } from './counted-checks.js';

const box = (id, overrides = {}) => ({ id, lineN: null, text: '', x: 0, y: 0, w: 20, h: 20, ...overrides });
const sized = (id, size, tags = []) => box(id, { style: { size }, tags });
const tagsOf = (b) => b.tags ?? [];

describe('boxCorners', () => {
  it('returns axis-aligned corners when rotation is absent or zero', () => {
    const b = box('a', { x: 10, y: 20, w: 40, h: 20 });
    const expected = [[10, 20], [50, 20], [50, 40], [10, 40]];
    expect(boxCorners(b)).toEqual(expected);
    expect(boxCorners({ ...b, style: { rotation: 0 } })).toEqual(expected);
  });

  it.each([90, -90, 450])('rotates %s degrees about the centre', (rotation) => {
    const corners = boxCorners(box('a', { x: 10, y: 20, w: 40, h: 20, style: { rotation } }));
    const expected = rotation === -90
      ? [[20, 50], [20, 10], [40, 10], [40, 50]]
      : [[40, 10], [40, 50], [20, 50], [20, 10]];
    corners.forEach((point, i) => point.forEach((value, j) => expect(value).toBeCloseTo(expected[i][j], 10)));
  });
});

describe('boxCollisions', () => {
  it('reports one row per overlapping pair in array order with pixel depth', () => {
    expect(boxCollisions({ boxes: [box('b'), box('a', { x: 10 }), box('c', { x: 15 })] })).toEqual([
      { boxId: 'b', other: 'a', overlap: 10 },
      { boxId: 'b', other: 'c', overlap: 5 },
      { boxId: 'a', other: 'c', overlap: 15 },
    ]);
  });

  it.each([{ x: 20 }, { y: 20 }, { x: 20, y: 20 }, { x: 21 }])('ignores touching or separated boxes: %j', (position) => {
    expect(boxCollisions({ boxes: [box('a'), box('b', position)] }, { minOverlap: 0 })).toEqual([]);
  });

  it('requires strictly more depth than the configurable threshold', () => {
    const p = { boxes: [box('a'), box('b', { x: 16 })] };
    expect(boxCollisions(p)).toEqual([]);
    expect(boxCollisions(p, { minOverlap: 3 })).toEqual([{ boxId: 'a', other: 'b', overlap: 4 }]);
  });

  it('detects overlap caused only by rotation', () => {
    const a = box('a', { x: 10, y: 40, w: 80, h: 20 });
    const b = box('b', { x: 40, y: 10 });
    expect(boxCollisions({ boxes: [a, b] })).toEqual([]);
    const collisions = boxCollisions({ boxes: [{ ...a, style: { rotation: 90 } }, b] });
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ boxId: 'a', other: 'b' });
    expect(collisions[0].overlap).toBeCloseTo(20);
  });

  it('separates rotated rectangles even when their axis-aligned bounds overlap', () => {
    const a = box('a', { w: 100, h: 10, style: { rotation: 45 } });
    const b = box('b', { x: -15, y: 15, w: 100, h: 10, style: { rotation: 45 } });
    expect(boxCollisions({ boxes: [a, b] }, { minOverlap: 0 })).toEqual([]);
  });

  it('measures separation depth for a contained rectangle', () => {
    const p = { boxes: [box('outer', { w: 100, h: 100 }), box('inner', { x: 40, y: 40, w: 10, h: 10 })] };
    expect(boxCollisions(p)).toEqual([{ boxId: 'outer', other: 'inner', overlap: 50 }]);
  });

  it('skips non-positive box dimensions', () => {
    const boxes = [box('valid'), ...[{ w: 0 }, { h: 0 }, { w: -1 }, { h: -1 }].map((v, i) => box(`bad${i}`, v))];
    expect(boxCollisions({ boxes })).toEqual([]);
  });
});

describe('panelCrossings', () => {
  const detect = { panels: [[10, 20, 110, 120]], boxes: [] };

  it('uses xyxy panels and distinguishes inside, tolerance, and a crossing', () => {
    const p = { detect, boxes: [
      box('inside', { x: 90, y: 90 }),
      box('tolerated', { x: 93, y: 90 }),
      box('crossing', { x: 94, y: 90 }),
    ] };
    expect(panelCrossings(p)).toEqual([{ boxId: 'crossing', panel: 0 }]);
    expect(panelCrossings(p, { tolerance: 4 })).toEqual([]);
  });

  it.each([{ x: 6, y: 50 }, { x: 50, y: 16 }, { x: 94, y: 50 }, { x: 50, y: 104 }])('checks every panel edge: %j', (position) => {
    expect(panelCrossings({ detect, boxes: [box('crossing', position)] })).toEqual([{ boxId: 'crossing', panel: 0 }]);
  });

  it('checks rotated corners even when the unrotated box fits', () => {
    const b = box('rotated', { x: 15, y: 65, w: 90, h: 10 });
    const p = { detect: { panels: [[10, 40, 110, 100]] }, boxes: [b] };
    expect(panelCrossings(p)).toEqual([]);
    expect(panelCrossings({ ...p, boxes: [{ ...b, style: { rotation: 45 } }] })).toEqual([{ boxId: 'rotated', panel: 0 }]);
  });

  it('ignores boxes whose centres are outside and keeps original panel indices', () => {
    const p = { detect: { panels: [[200, 200, 300, 300], null, ...detect.panels] }, boxes: [
      box('outside', { x: 111, y: 80, w: 30 }),
      box('crossing', { x: 94, y: 90 }),
    ] };
    expect(panelCrossings(p)).toEqual([{ boxId: 'crossing', panel: 2 }]);
  });

  it('returns no crossings without panels', () => {
    expect(panelCrossings({ boxes: [box('a')] })).toEqual([]);
    expect(panelCrossings({ boxes: [box('a')], detect: { panels: [] } })).toEqual([]);
  });
});

describe('sizeOutliers', () => {
  it('flags both directions against an odd-sized group median', () => {
    const boxes = [10, 20, 20, 20, 40].map((size, i) => sized(`b${i}`, size, ['dialogue']));
    expect(sizeOutliers({ boxes }, tagsOf)).toEqual([
      { boxId: 'b0', size: 10, median: 20, tag: 'dialogue' },
      { boxId: 'b4', size: 40, median: 20, tag: 'dialogue' },
    ]);
  });

  it('leaves out the groups it is told to skip', () => {
    const boxes = [10, 20, 20, 20, 40].map((size, i) => sized(`b${i}`, size, ['title']));
    expect(sizeOutliers({ boxes }, tagsOf, { skip: ['title'] })).toEqual([]);
  });

  it('averages the middle two sizes for even groups and defaults to untagged', () => {
    const boxes = [10, 18, 22, 40].map((size, i) => sized(`b${i}`, size));
    expect(sizeOutliers({ boxes }, tagsOf)).toEqual([
      { boxId: 'b0', size: 10, median: 20, tag: 'untagged' },
      { boxId: 'b3', size: 40, median: 20, tag: 'untagged' },
    ]);
  });

  it('groups only by the first callback tag, including legacy line types', () => {
    const p = {
      lines: [{ n: 1, tags: ['sfx', 'shared'] }, { n: 2, type: 'sfx' }, { n: 3, tags: ['sfx'] }],
      boxes: [
        ...[10, 20, 20].map((size, i) => ({ ...sized(`s${i}`, size), lineN: i + 1 })),
        ...[100, 100, 100].map((size, i) => sized(`d${i}`, size, ['dialogue', 'sfx'])),
      ],
    };
    const fromLine = (b) => {
      const line = p.lines.find((l) => l.n === b.lineN);
      return line ? line.tags ?? [line.type] : tagsOf(b);
    };
    expect(sizeOutliers(p, fromLine)).toEqual([{ boxId: 's0', size: 10, median: 20, tag: 'sfx' }]);
  });

  it('skips small groups and excludes missing or nonnumeric sizes from group counts', () => {
    const boxes = [sized('a', 10), sized('b', 40), sized('missing'), sized('nan', NaN), sized('string', '20'), sized('infinite', Infinity), box('no-style')];
    expect(sizeOutliers({ boxes }, tagsOf)).toEqual([]);
    expect(sizeOutliers({ boxes }, tagsOf, { minGroup: 2 })).toEqual([
      { boxId: 'a', size: 10, median: 25, tag: 'untagged' },
      { boxId: 'b', size: 40, median: 25, tag: 'untagged' },
    ]);
  });

  it('uses a strict, configurable ratio', () => {
    const p = { boxes: [sized('small', 10), sized('normal', 20), sized('large', 40)] };
    expect(sizeOutliers(p, tagsOf, { ratio: 2 })).toEqual([]);
    expect(sizeOutliers(p, tagsOf, { ratio: 1.9 })).toHaveLength(2);
  });
});

describe('countedChecks', () => {
  const empty = { collisions: [], panels: [], sizes: [] };

  it.each([undefined, null, {}, { boxes: [] }, { boxes: null, detect: null }, { boxes: {}, detect: { panels: {} } }])('handles an empty or malformed page: %j', (p) => {
    expect(countedChecks(p, tagsOf)).toEqual(empty);
  });

  it('skips malformed geometry, sizes and panels without throwing', () => {
    const p = {
      boxes: [null, {}, box('nan', { x: NaN, style: { size: NaN } }), box('infinite', { w: Infinity }), box('valid', { style: { size: NaN } })],
      detect: { panels: [null, [], {}, [0, 0, NaN, 100], [0, 0, -10, 100]] },
    };
    expect(countedChecks(p, tagsOf)).toEqual(empty);
  });

  it('combines all checks, forwards options, and leaves the page unchanged', () => {
    const p = {
      boxes: [
        box('a', { x: 84, style: { size: 10 } }),
        box('b', { x: 100, style: { size: 40 } }),
      ],
      detect: { panels: [[0, 0, 100, 100]] },
    };
    const before = structuredClone(p);
    expect(countedChecks(p, tagsOf)).toEqual({ collisions: [], panels: [{ boxId: 'a', panel: 0 }], sizes: [] });
    expect(countedChecks(p, tagsOf, { minOverlap: 3, tolerance: 4, ratio: 2, minGroup: 2 })).toEqual({
      collisions: [{ boxId: 'a', other: 'b', overlap: 4 }],
      panels: [],
      sizes: [{ boxId: 'a', size: 10, median: 25, tag: 'untagged' }],
    });
    expect(p).toEqual(before);
  });
});
