import { beforeAll, describe, expect, it } from 'vitest';
import { rustEngine } from '../../test/rust-engine.js';
import { extractsTiles, extractTile } from '../../../text-engine/js/pattern.mjs';

let engine;
beforeAll(async () => { engine = (await rustEngine({ fixtures: false })).low; });

function dots(width, height, period = 7.3) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let ink = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const px = x + (sx + 0.5) / 4;
        const py = y + (sy + 0.5) / 4;
        const u = (px + py) / Math.SQRT2 / period;
        const v = (py - px) / Math.SQRT2 / period;
        if ((u - Math.round(u)) ** 2 + (v - Math.round(v)) ** 2 < 0.09) ink++;
      }
      const i = (y * width + x) * 4;
      data.fill(Math.round(215 - 170 * ink / 16), i, i + 3);
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('extracting a lattice cell from a page crop', () => {
  it('detects a 45 degree tone and copies exactly one opaque cell', () => {
    expect(extractsTiles(engine)).toBe(true);
    const result = extractTile(engine, dots(300, 300));
    expect(result.periodic).toBe(true);
    expect(Math.abs(result.period / 7.3 - 1)).toBeLessThan(0.01);
    expect(Math.abs(((result.angle - 45 + 135) % 90) - 45)).toBeLessThan(1);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    const [ax, ay, bx, by] = result.cell;
    expect(Math.abs(Math.hypot(bx, by) / 7.3 - 1)).toBeLessThan(0.01);
    expect(ax * by - ay * bx).toBeGreaterThan(0);
    const { tile } = result;
    expect(tile.width).toBe(tile.height);
    expect(tile.width).toBeGreaterThanOrEqual(16);
    expect(tile.width).toBeLessThanOrEqual(256);
    expect(tile.data).toBeInstanceOf(Uint8ClampedArray);
    expect(tile.data.length).toBe(tile.width * tile.height * 4);
    expect(tile.data.every((v, i) => i % 4 !== 3 || v === 255)).toBe(true);
    const copy = tile.data.slice();
    extractTile(engine, { width: 1, height: 1, data: new Uint8Array([1, 2, 3, 0]) });
    // Also force a larger memory request after taking the first result.
    engine.exports.mt_pattern_input_reserve(1024 * 1024 * 4);
    expect(tile.data).toEqual(copy);
  });

  it('returns the square fallback for tiny and insufficient crops', () => {
    const tiny = extractTile(engine, { width: 1, height: 2, data: new Uint8Array([12, 34, 56, 0, 7, 8, 9, 255]) });
    expect(tiny.periodic).toBe(false);
    expect(tiny.confidence).toBe(0);
    expect(tiny.cell).toEqual([1, 0, 0, 1]);
    expect([...tiny.tile.data]).toEqual([12, 34, 56, 255]);
    expect(extractTile(engine, dots(20, 20, 9)).periodic).toBe(false);
  });

  it('rejects malformed inputs before calling wasm', () => {
    expect(extractsTiles({})).toBe(false);
    expect(() => extractTile({}, dots(1, 1))).toThrow(/does not extract/);
    for (const crop of [
      { width: 0, height: 1, data: new Uint8Array() },
      { width: 1025, height: 1, data: new Uint8Array(4100) },
      { width: 1.5, height: 1, data: new Uint8Array(6) },
      { width: NaN, height: 1, data: new Uint8Array() },
      { width: 1, height: 1, data: new Uint8Array(3) },
      { width: 1, height: 1, data: [0, 0, 0, 255] },
    ]) expect(() => extractTile(engine, crop)).toThrow(/straight RGBA8/);
  });

  it('the ABI refuses invalid dimensions and clears the report', () => {
    const ex = engine.exports;
    expect(ex.mt_pattern_input_reserve(1024 * 1024 * 4 + 1)).toBe(0);
    for (const [w, h] of [[0, 1], [1, 0], [1025, 1], [1, 1025], [0xffffffff, 0xffffffff]]) {
      expect(ex.mt_pattern_extract(w, h)).toBe(-5);
      expect([...new Float64Array(ex.memory.buffer, ex.mt_pattern_output_info(), 9)]).toEqual(Array(9).fill(0));
    }
  });
});
