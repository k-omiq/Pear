import { describe, expect, it } from 'vitest';
import { WARP_PRESETS, WARP_PRESET_NOTES, PRESET_COLS, PRESET_ROWS, warpPresetPts } from './warp-presets.js';
import { isIdentityMesh, identityMesh, meshMap, warpActive } from './warp.js';
import { normalizeWarp, WARP_MAX_GRID } from './data.js';
import { HANDLE_GRID_MAX } from './warp-gizmo.js';

const W = 240;
const H = 90;
const N = (PRESET_COLS + 1) * (PRESET_ROWS + 1);
// Point (i, j) of a row-major mesh.
const at = (pts, i, j) => pts[j * (PRESET_COLS + 1) + i];
const row = (pts, j) => Array.from({ length: PRESET_COLS + 1 }, (_, i) => at(pts, i, j));
const col = (pts, i) => Array.from({ length: PRESET_ROWS + 1 }, (_, j) => at(pts, i, j));
const bounds = (pts) => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};
const height = (pts, i) => at(pts, i, PRESET_ROWS)[1] - at(pts, i, 0)[1];
const width = (pts, j) => at(pts, PRESET_COLS, j)[0] - at(pts, 0, j)[0];
const mid = PRESET_COLS / 2;
const midRow = PRESET_ROWS / 2;

describe('WARP_PRESETS', () => {
  it('has the Photoshop kinds the agent is promised, each with a note', () => {
    for (const k of ['arc', 'arch', 'bulge', 'flag', 'wave', 'rise', 'squeeze']) expect(WARP_PRESETS).toContain(k);
    for (const k of WARP_PRESETS) expect(WARP_PRESET_NOTES[k], k).toMatch(/\w/);
  });

  it('uses a grid the sanitiser keeps and the gizmo still gives handles for', () => {
    expect(PRESET_COLS).toBeLessThanOrEqual(Math.min(HANDLE_GRID_MAX, WARP_MAX_GRID));
    expect(PRESET_ROWS).toBeLessThanOrEqual(Math.min(HANDLE_GRID_MAX, WARP_MAX_GRID));
  });
});

describe('warpPresetPts', () => {
  it('is null for a kind not on the list', () => {
    expect(warpPresetPts('twirl', 50, W, H)).toBeNull();
    expect(warpPresetPts('', 50, W, H)).toBeNull();
    expect(warpPresetPts(undefined, 50, W, H)).toBeNull();
  });

  it('is the identity grid at 0 for every kind, and for an amount that is not a number', () => {
    for (const k of WARP_PRESETS) {
      for (const amount of [0, -0, 'lots', NaN, null]) {
        const m = warpPresetPts(k, amount, W, H);
        expect(m.cols).toBe(PRESET_COLS);
        expect(m.rows).toBe(PRESET_ROWS);
        expect(isIdentityMesh(m.pts, m.cols, m.rows, W, H), `${k} ${amount}`).toBe(true);
      }
    }
  });

  it('bends every kind at +-50, with finite points, a full grid that survives normalizeWarp, and stays on the box', () => {
    for (const k of WARP_PRESETS) {
      for (const amount of [50, -50, 100, -100]) {
        const m = warpPresetPts(k, amount, W, H);
        expect(m.pts, k).toHaveLength(N);
        expect(m.pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), k).toBe(true);
        expect(isIdentityMesh(m.pts, m.cols, m.rows, W, H), `${k} ${amount}`).toBe(false);
        const style = { warp: { on: true, ...m } };
        expect(normalizeWarp(style.warp).pts, k).toEqual(m.pts);
        expect(warpActive(style, W, H), k).toBe(true);
        // Centred on the box, and never flung far past it.
        const b = bounds(m.pts);
        expect((b.minX + b.maxX) / 2, `${k} ${amount}`).toBeCloseTo(W / 2, 1);
        expect((b.minY + b.maxY) / 2, `${k} ${amount}`).toBeCloseTo(H / 2, 1);
        expect(b.maxX - b.minX, k).toBeLessThan(W * 2);
        expect(b.maxY - b.minY, k).toBeLessThan(H + W);
        // The surface the painter draws through it is finite everywhere.
        const map = meshMap(m.pts, m.cols, m.rows, W, H);
        for (const [x, y] of identityMesh(16, 8, W, H)) expect(map.at(x, y).every(Number.isFinite), k).toBe(true);
      }
    }
  });

  it('clamps the amount to +-100 and grows with it', () => {
    for (const k of WARP_PRESETS) {
      expect(warpPresetPts(k, 150, W, H), k).toEqual(warpPresetPts(k, 100, W, H));
      expect(warpPresetPts(k, -500, W, H), k).toEqual(warpPresetPts(k, -100, W, H));
      const id = identityMesh(PRESET_COLS, PRESET_ROWS, W, H);
      const moved = (amount) => {
        const { pts } = warpPresetPts(k, amount, W, H);
        return pts.reduce((sum, [x, y], n) => sum + Math.hypot(x - id[n][0], y - id[n][1]), 0);
      };
      expect(moved(60), k).toBeGreaterThan(moved(20));
    }
  });

  it('rounds to a hundredth and never writes -0', () => {
    for (const k of WARP_PRESETS) {
      for (const [x, y] of warpPresetPts(k, -37, W, H).pts) {
        expect(Math.round(x * 100) / 100).toBe(x);
        expect(Object.is(x, -0) || Object.is(y, -0), k).toBe(false);
      }
    }
  });

  it('arc: the middle row on a circle with equal steps, letters fanned, a rainbow at + and a smile at -', () => {
    const { pts } = warpPresetPts('arc', 50, W, H);
    const m = row(pts, midRow);
    const steps = m.slice(1).map((p, i) => Math.hypot(p[0] - m[i][0], p[1] - m[i][1]));
    for (const s of steps) expect(s).toBeCloseTo(steps[0], 1);
    // The top of the middle is the highest point of each row.
    for (let j = 0; j <= PRESET_ROWS; j++) {
      const r = row(pts, j);
      expect(Math.min(...r.map((p) => p[1]))).toBe(r[mid][1]);
    }
    // Fanned: the top row is longer than the bottom.
    expect(width(pts, 0)).toBeGreaterThan(width(pts, PRESET_ROWS) - 1e-9);
    const len = (r) => r.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - r[i][0], p[1] - r[i][1]), 0);
    expect(len(row(pts, 0))).toBeGreaterThan(len(row(pts, PRESET_ROWS)));
    // Negative is the same bend upside down.
    const neg = warpPresetPts('arc', -50, W, H).pts;
    for (let j = 0; j <= PRESET_ROWS; j++) {
      for (let i = 0; i <= PRESET_COLS; i++) {
        const p = at(neg, i, j);
        const q = at(pts, i, PRESET_ROWS - j);
        expect(p[0]).toBeCloseTo(q[0], 1);
        expect(p[1]).toBeCloseTo(H - q[1], 1);
      }
    }
  });

  it('arc: never folds the inner row, even at 100% on a square or tall box', () => {
    for (const [w, h] of [[200, 200], [100, 300], [600, 80]]) {
      for (const amount of [100, -100]) {
        const { pts } = warpPresetPts('arc', amount, w, h);
        const inner = row(pts, amount > 0 ? PRESET_ROWS : 0);
        for (let i = 1; i < inner.length; i++) expect(inner[i][0], `${w}x${h} ${amount}`).toBeGreaterThan(inner[i - 1][0]);
        // Each column still runs one way from top to bottom: no step of it
        // turns back on the column's own direction.
        for (let i = 0; i <= PRESET_COLS; i++) {
          const c = col(pts, i);
          const dir = [c.at(-1)[0] - c[0][0], c.at(-1)[1] - c[0][1]];
          for (let j = 1; j < c.length; j++) {
            const step = [c[j][0] - c[j - 1][0], c[j][1] - c[j - 1][1]];
            expect(step[0] * dir[0] + step[1] * dir[1], `${w}x${h} ${amount} col ${i}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('arch and flag keep letters upright: columns only move up or down, all together', () => {
    const id = identityMesh(PRESET_COLS, PRESET_ROWS, W, H);
    for (const k of ['arch', 'flag', 'rise']) {
      const { pts } = warpPresetPts(k, 70, W, H);
      for (let i = 0; i <= PRESET_COLS; i++) {
        const shift = at(pts, i, 0)[1] - id[i][1];
        for (let j = 0; j <= PRESET_ROWS; j++) {
          const n = j * (PRESET_COLS + 1) + i;
          expect(pts[n][0], k).toBeCloseTo(id[n][0], 1);
          expect(pts[n][1] - id[n][1], k).toBeCloseTo(shift, 1);
        }
      }
    }
    // The arch rises in the middle; negative sags.
    const up = warpPresetPts('arch', 50, W, H).pts;
    expect(at(up, mid, 0)[1]).toBeLessThan(at(up, 0, 0)[1]);
    const down = warpPresetPts('arch', -50, W, H).pts;
    expect(at(down, mid, 0)[1]).toBeGreaterThan(at(down, 0, 0)[1]);
  });

  it('flag is one full wave; wave stretches and shrinks the letters', () => {
    const flag = warpPresetPts('flag', 50, W, H).pts;
    const top = row(flag, 0).map((p) => p[1]);
    // Up then down: the first quarter above the ends, the third below.
    expect(top[2]).not.toBeCloseTo(top[0], 0);
    expect(Math.sign(top[2] - top[0])).toBe(-Math.sign(top[6] - top[0]));
    expect(top[PRESET_COLS]).toBeCloseTo(top[0], 1);
    const wave = warpPresetPts('wave', 50, W, H).pts;
    const heights = Array.from({ length: PRESET_COLS + 1 }, (_, i) => height(wave, i));
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(H * 0.1);
  });

  it('rise climbs left to right, and negative is its mirror', () => {
    const { pts } = warpPresetPts('rise', 50, W, H);
    expect(at(pts, PRESET_COLS, 0)[1]).toBeLessThan(at(pts, 0, 0)[1]);
    const neg = warpPresetPts('rise', -50, W, H).pts;
    for (let j = 0; j <= PRESET_ROWS; j++) {
      for (let i = 0; i <= PRESET_COLS; i++) {
        expect(at(neg, i, j)[0]).toBeCloseTo(W - at(pts, PRESET_COLS - i, j)[0], 1);
        expect(at(neg, i, j)[1]).toBeCloseTo(at(pts, PRESET_COLS - i, j)[1], 1);
      }
    }
  });

  it('bulge swells the middle column and keeps the corners; negative pinches it', () => {
    const { pts } = warpPresetPts('bulge', 50, W, H);
    expect(height(pts, mid)).toBeGreaterThan(H * 1.3);
    expect(height(pts, 0)).toBeCloseTo(H, 1);
    const pinch = warpPresetPts('bulge', -100, W, H).pts;
    expect(height(pinch, mid)).toBeGreaterThan(0);
    expect(height(pinch, mid)).toBeLessThan(H * 0.2);
  });

  it('squeeze pinches the middle row, inflate swells both ways from the centre', () => {
    const sq = warpPresetPts('squeeze', 50, W, H).pts;
    expect(width(sq, midRow)).toBeLessThan(W * 0.8);
    expect(width(sq, 0)).toBeCloseTo(width(sq, PRESET_ROWS), 1);
    for (const p of sq) expect(p[1] % (H / PRESET_ROWS)).toBeCloseTo(0, 1);
    const inf = warpPresetPts('inflate', 50, W, H).pts;
    expect(width(inf, midRow)).toBeGreaterThan(W * 1.1);
    expect(height(inf, mid)).toBeGreaterThan(H * 1.1);
  });

  it('perspective shrinks the far side and foreshortens the spacing towards it', () => {
    const { pts } = warpPresetPts('perspective', 50, W, H);
    expect(height(pts, PRESET_COLS)).toBeLessThan(height(pts, 0) * 0.8);
    const xs = row(pts, midRow).map((p) => p[0]);
    const steps = xs.slice(1).map((x, i) => x - xs[i]);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThan(steps[i - 1]);
    expect(xs[0]).toBeCloseTo(0, 1);
    expect(xs[PRESET_COLS]).toBeCloseTo(W, 1);
    // Negative turns the other side away: the mirror image.
    const neg = warpPresetPts('perspective', -50, W, H).pts;
    for (let j = 0; j <= PRESET_ROWS; j++) {
      for (let i = 0; i <= PRESET_COLS; i++) {
        expect(at(neg, i, j)[0]).toBeCloseTo(W - at(pts, PRESET_COLS - i, j)[0], 1);
        expect(at(neg, i, j)[1]).toBeCloseTo(at(pts, PRESET_COLS - i, j)[1], 1);
      }
    }
  });

  it('builds on the box it is given, at least a pixel each way', () => {
    const a = warpPresetPts('bulge', 40, 100, 50);
    const b = warpPresetPts('bulge', 40, 200, 100);
    a.pts.forEach(([x, y], n) => {
      expect(b.pts[n][0]).toBeCloseTo(x * 2, 1);
      expect(b.pts[n][1]).toBeCloseTo(y * 2, 1);
    });
    expect(warpPresetPts('arc', 50, 0, -4).pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });
});
