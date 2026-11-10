import { beforeAll, describe, expect, it } from 'vitest';
import { rustEngine } from '../../test/rust-engine.js';
import { encodesPages, encodePage } from '../../../text-engine/js/encode.mjs';

let engine;
beforeAll(async () => { engine = (await rustEngine({ fixtures: false })).low; });

// One-pixel red and blue columns on white: what a canvas's 4:2:0 JPEG smears.
function columns(width, height, alpha = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = x % 4 === 1 ? [224, 16, 16] : x % 4 === 3 ? [16, 48, 224] : [255, 255, 255];
      data.set([...c, alpha], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}
const sof = (f) => {
  for (let i = 0; i + 1 < f.length; i++) if (f[i] === 0xff && f[i + 1] === 0xc0) return i;
  return -1;
};

describe('a page encoded by the engine', () => {
  it('a JPEG keeps its colour at full resolution: every component sampled 1x1', () => {
    expect(encodesPages(engine)).toBe(true);
    const f = encodePage(engine, columns(64, 32), 'jpeg', 0.95);
    expect([f[0], f[1]]).toEqual([0xff, 0xd8]);
    const at = sof(f);
    expect(at).toBeGreaterThan(0);
    expect((f[at + 5] << 8) | f[at + 6]).toBe(32);
    expect((f[at + 7] << 8) | f[at + 8]).toBe(64);
    expect(f[at + 9]).toBe(3);
    for (let c = 0; c < 3; c++) expect(f[at + 11 + c * 3]).toBe(0x11);
  });

  it('a WebP is a lossless WebP', () => {
    const f = encodePage(engine, columns(64, 32), 'webp-lossless');
    expect(new TextDecoder().decode(f.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(f.slice(8, 16))).toBe('WEBPVP8L');
  });

  it('the file is a copy: a later encode does not change it', () => {
    const a = encodePage(engine, columns(16, 16), 'jpeg');
    const before = a.slice();
    encodePage(engine, columns(300, 300), 'webp-lossless');
    expect(a).toEqual(before);
  });

  it('refuses what it cannot encode, says so, and the next page still encodes', () => {
    expect(() => encodePage(engine, { width: 4, height: 4, data: new Uint8ClampedArray(10) }, 'jpeg')).toThrow(/RGBA8/);
    expect(() => encodePage(engine, columns(20000, 1), 'webp-lossless')).toThrow(/cannot hold/);
    expect(() => encodePage(engine, columns(4, 4), 'gif')).toThrow();
    expect(encodePage(engine, columns(8, 8), 'jpeg').length).toBeGreaterThan(100);
  });
});
