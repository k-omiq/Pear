import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../../../text-engine/js/engine.mjs';
import { drawsScreens, encodeJob, paintJob, patternKinds, patternSwatch, patternTile, WIRE_VERSION } from '../../../text-engine/js/paint.mjs';
import { engineWasm, fixtureFont } from '../../test/rust-engine.js';
import { PATTERN_KINDS } from '../data.js';

let engine, font;
beforeAll(async () => {
  engine = await createEngine(engineWasm());
  font = engine.addFont(fixtureFont('ComicNeue-Regular.ttf'));
});

const names = [...PATTERN_KINDS,
  'halftone-fade',
  'square-dots',
  'diamond-dots',
  'line-tone',
  'sand',
  'stipple',
  'speed-lines',
  'burst',
  'rings',
  'waves',
  'zigzag',
  'bricks',
  'scales',
  'hex',
  'triangles',
  'plus',
  'stars',
  'hearts',
  'kakeami',
  'glitch',
];
const screen = (kind = 'dots', pattern = {}, rest = {}) => ({
  kind: 'screen', pattern: { kind, ...pattern }, basis: [12, 0, 0, 12],
  x: 0, y: 0, cx: 24, cy: 16, reach: 29, line: 0.12, fade: null, color: '#123456', ...rest,
});
const swatch = (fill, rest = {}) => patternSwatch(engine, { width: 48, height: 32, fill, ...rest });
const job = (fill) => ({ curved: false, align: 'left', bands: [], fill, runs: [{ text: 'WAIT!', x: 2, y: 35 }] });

describe('procedural screen fills', () => {
  it('publishes the kinds in wire order and keeps the app’s first eleven ids', () => {
    expect(WIRE_VERSION).toBe(8);
    expect(drawsScreens(engine)).toBe(true);
    expect(patternKinds(engine)).toEqual(names);
    expect(patternKinds(engine)).toHaveLength(31);
    expect(patternTile(engine, { kind: 'waves' }, 16, 0.12)).toBeNull();
    expect(patternKinds(engine).slice(0, 11)).toEqual(PATTERN_KINDS);
    expect(patternKinds({ exports: {} })).toBeNull();
    expect(drawsScreens({ exports: {} })).toBe(false);
    expect(patternSwatch({ exports: {} }, {})).toBeNull();
  });

  it.each(names)('paints a copied, nonconstant swatch of %s', (name) => {
    const tiles = vi.fn(() => { throw new Error('built-ins must not request a tile'); });
    const raster = swatch(screen(name), { tiles });
    expect(raster.width).toBe(48);
    expect(raster.height).toBe(32);
    expect(raster.data).toHaveLength(48 * 32 * 4);
    expect(new Set(raster.data.filter((_, i) => i % 4 === 0)).size).toBeGreaterThan(1);
    const saved = raster.data.slice();
    swatch({ kind: 'solid', color: '#ff0000' });
    expect(raster.data).toEqual(saved);
    expect(tiles).not.toHaveBeenCalled();
  });

  it('writes the exact screen record, defaults, colour opacity and degree conversion', () => {
    const f = screen('stripes', { fg: '#ff000080', fgOpacity: 0.5, bg: '#12345680', bgOpacity: 0.25, angle: 90 });
    const bytes = encodeJob({ job: job(f), font, size: 40 }).slice();
    const b = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const start = 112;
    expect(b.getUint32(start, true)).toBe(5);
    expect(b.getUint32(start + 4, true)).toBe(2);
    expect(b.getUint32(start + 8, true)).toBe(0xffffffff);
    expect(b.getUint32(start + 12, true)).toBe(0);
    expect(b.getUint32(start + 16, true)).toBe(1);
    expect(b.getFloat64(start + 68, true)).toBe(Math.PI / 2);
    expect(b.getFloat64(start + 76, true)).toBe(1);
    expect(b.getFloat64(start + 84, true)).toBe(0);
    expect(b.getFloat64(start + 92, true)).toBe(0);
    expect(b.getFloat64(start + 100, true)).toBe(0.5);
    expect([...bytes.slice(start + 116, start + 124)]).toEqual([255, 0, 0, 64, 18, 52, 86, 32]);
    expect(swatch(screen('unknown')).data).toEqual(swatch(screen('dots')).data);
    expect(swatch(screen('stripes', { angle: 90 })).data).toEqual(swatch(screen('hstripes')).data);
  });

  it('paints screens in jobs, including a run fill and a curved fill frame', () => {
    const f = screen('diagonal', { angle: 23, aspect: 1.8, ox: 0.3 });
    for (const curved of [false, true]) {
      const j = { ...job(null), curved, runs: [{ text: 'W', x: 24, y: 35, rot: 0.2, fill: f }] };
      const raster = paintJob(engine, { job: j, font, size: 40, transform: [2, 0, 0, 2, 0, 0] });
      expect(raster.data.length).toBe(raster.width * raster.height * 4);
      expect(raster.data.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
      expect(new Set(raster.data.filter((_, i) => i % 4 === 0)).size).toBeGreaterThan(2);
    }
    expect(paintJob(engine, { job: job(f), font, size: 40 })).not.toBeNull();
  });

  it('composes transparent foreground and ground independently', () => {
    const r = swatch(screen('stripes', { fg: '#ff000080', fgOpacity: 0.5, bgOpacity: 0 }));
    expect([...r.data.slice(4, 8)]).toEqual([255, 0, 0, 64]);
    expect([...r.data.slice(8 * 4, 9 * 4)]).toEqual([0, 0, 0, 0]);
    expect(swatch(screen('dots', { density: 0 })).data.every((v) => v === 255)).toBe(true);
    const full = swatch(screen('dots', { density: 1 })).data;
    expect(full.every((v, i) => v === (i % 4 === 3 ? 255 : 0))).toBe(true);
  });

  it('supports other fill kinds and refuses malformed swatches without stale results', () => {
    const tile = { width: 1, height: 1, data: new Uint8Array([10, 20, 30, 255]) };
    expect([...swatch({ kind: 'pattern', px: 12, ax: 0, ay: 0, style: { color: '#000' } }, { tiles: () => tile }).data.slice(0, 4)])
      .toEqual([10, 20, 30, 255]);
    const linear = swatch({ kind: 'linear', x0: 0, y0: 0, x1: 48, y1: 0, stops: [{ pos: 0, color: '#000' }, { pos: 1, color: '#fff' }] });
    expect(linear.data[0]).toBeLessThan(linear.data[47 * 4]);
    expect(swatch(null).data.every((v) => v === 0)).toBe(true);
    for (const size of [0, 2049]) expect(() => swatch(screen(), { width: size })).toThrow(/malformed/);
    for (const bad of [{ pattern: { aspect: 0 } }, { basis: [1, 2, 2, 4] }, { x: NaN }, { reach: 0 }]) {
      expect(() => swatch(screen('dots', {}, bad))).toThrow(/malformed/);
      expect([...new Float64Array(engine.exports.memory.buffer, engine.exports.mt_paint_job_result(), 4)]).toEqual([0, 0, 0, 0]);
    }
    expect(swatch(screen())).not.toBeNull();
  });
  it.each(['sand', 'stipple', 'speed-lines', 'kakeami', 'glitch'])('%s uses a repeatable seed', (kind) => {
    const a = swatch(screen(kind, { seed: 1 })).data;
    expect(a).toEqual(swatch(screen(kind, { seed: 1 })).data);
    expect(a).not.toEqual(swatch(screen(kind, { seed: 2 })).data);
  });

  it('halftone-fade uses the same shape and the supplied job-space fade', () => {
    const fade = { x0: 0, y0: 0, x1: 48, y1: 0 };
    const a = swatch(screen('halftone-fade', {}, { fade })).data;
    expect(a).toEqual(swatch(screen('halftone', {}, { fade })).data);
    const ink = (from, to) => {
      let sum = 0;
      for (let y = 0; y < 32; y++) for (let x = from; x < to; x++) sum += 255 - a[(y * 48 + x) * 4];
      return sum;
    };
    expect(ink(0, 24)).toBeGreaterThan(ink(24, 48));
  });

});
