import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CONTOUR_PRESET_POINTS, PSD_CONTOUR_POINTS, psdContourPoints } from './contour-presets.js';
import { CONTOUR_PRESETS } from './data.js';

// The engine's table, read from its source: the PSD writer's copy must be it.
function rustPresets() {
  const src = readFileSync(fileURLToPath(new URL('../../text-engine/src/paint/fx/contour.rs', import.meta.url)), 'utf8');
  const body = src.slice(src.indexOf('pub const PRESETS'), src.indexOf("/// The presets' names"));
  const out = [];
  for (const m of body.matchAll(/\(\s*"([^"]+)",\s*&\[([\s\S]*?)\]\s*,?\s*\)/g)) {
    out.push([m[1], [...m[2].matchAll(/\(\s*([\d.]+),\s*([\d.]+),\s*(true|false)\s*\)/g)].map((q) => [+q[1], +q[2], q[3] === 'true'])]);
  }
  return out;
}

describe('the contour presets the PSD writer names', () => {
  it("are the engine's twelve, in its order, point for point", () => {
    const rust = rustPresets();
    expect(rust).toHaveLength(12);
    expect(Object.keys(CONTOUR_PRESET_POINTS)).toEqual(CONTOUR_PRESETS);
    rust.forEach(([, pts], i) => expect(CONTOUR_PRESET_POINTS[CONTOUR_PRESETS[i]]).toEqual(pts));
  });
});

describe('psdContourPoints (PhotoCraft psd_contour_points)', () => {
  it('keeps a contour of 16 points or fewer whole', () => {
    const pts = Array.from({ length: 16 }, (_, i) => [i * 17, (i * 31) % 256]);
    expect(psdContourPoints(pts)).toEqual([...Array(16).keys()]);
    expect(psdContourPoints([[0, 0], [255, 255]])).toEqual([0, 1]);
  });

  it('thins a longer one to 16, both ends kept, in order', () => {
    const pts = Array.from({ length: 64 }, (_, i) => [(i * 255) / 63, 128 + 100 * Math.sin(i / 4)]);
    const kept = psdContourPoints(pts);
    expect(kept).toHaveLength(PSD_CONTOUR_POINTS);
    expect(kept[0]).toBe(0);
    expect(kept.at(-1)).toBe(63);
    expect([...kept].sort((a, b) => a - b)).toEqual(kept);
  });

  it("keeps Ring - Double's peaks and valleys", () => {
    const pts = CONTOUR_PRESET_POINTS['ring-double'];
    expect(pts.length).toBeGreaterThan(PSD_CONTOUR_POINTS);
    const kept = psdContourPoints(pts).map((i) => pts[i][1]);
    expect(kept).toHaveLength(PSD_CONTOUR_POINTS);
    expect(Math.max(...kept)).toBe(Math.max(...pts.map((p) => p[1])));
    expect(Math.min(...kept.slice(1))).toBe(Math.min(...pts.slice(1).map((p) => p[1])));
    // Every preset fits.
    for (const p of Object.values(CONTOUR_PRESET_POINTS)) expect(psdContourPoints(p).length).toBeLessThanOrEqual(PSD_CONTOUR_POINTS);
  });

  it('takes a vertical step without a NaN', () => {
    const pts = [[0, 0], ...Array.from({ length: 20 }, (_, i) => [128, i * 12]), [255, 255]];
    const kept = psdContourPoints(pts);
    expect(kept).toHaveLength(PSD_CONTOUR_POINTS);
    expect(kept.every(Number.isInteger)).toBe(true);
  });
});
