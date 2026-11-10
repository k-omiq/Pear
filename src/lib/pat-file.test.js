import { describe, expect, it } from 'vitest';
import { readPatFile } from './pat-file.js';

// A tiny .pat writer, to the layout pat-file.js reads.
class W {
  constructor() {
    this.out = [];
  }
  u8(x) {
    this.out.push(x & 255);
  }
  u16(x) {
    this.u8(x >> 8);
    this.u8(x);
  }
  u32(x) {
    this.u16(x >>> 16);
    this.u16(x & 0xffff);
  }
  raw(bytes) {
    for (const b of bytes) this.u8(b);
  }
}

// PackBits each row as literal runs.
function packRows(plane, w, h) {
  const counts = [];
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = [w - 1, ...plane.slice(y * w, y * w + w)];
    counts.push(row.length);
    rows.push(...row);
  }
  const out = [];
  for (const c of counts) out.push(c >> 8, c & 255);
  return [...out, ...rows];
}

function pattern(w, { mode, name, planes, rle = false, palette = null, version = 1 }) {
  const x = new W();
  x.u32(version);
  x.u32(mode);
  x.u16(planes[0].length / w);
  x.u16(w);
  x.u32(name.length);
  for (const c of name) x.u16(c.charCodeAt(0));
  x.u8(4);
  x.raw([1, 2, 3, 4]);
  if (palette) {
    x.raw(palette);
    x.u32(0);
  }
  const h = planes[0].length / w;
  const body = new W();
  body.u32(0);
  body.u32(0);
  body.u32(h);
  body.u32(w);
  body.u32(planes.length);
  for (const p of planes) {
    const data = rle ? packRows(p, w, h) : p;
    body.u32(1);
    body.u32(23 + data.length);
    body.u32(8);
    body.u32(0);
    body.u32(0);
    body.u32(h);
    body.u32(w);
    body.u16(8);
    body.u8(rle ? 1 : 0);
    body.raw(data);
  }
  // The two masks, not written.
  body.u32(0);
  body.u32(0);
  x.u32(3);
  x.u32(body.out.length);
  x.raw(body.out);
  return x.out;
}

function file(...patterns) {
  const x = new W();
  x.raw([...'8BPT'].map((c) => c.charCodeAt(0)));
  x.u16(1);
  x.u32(patterns.length);
  for (const p of patterns) x.raw(p);
  return new Uint8Array(x.out);
}

describe('readPatFile', () => {
  it('reads gray, RGB with transparency, and indexed patterns as RGBA', () => {
    const gray = pattern(2, { mode: 1, name: 'Gray', planes: [[0, 64, 128, 255]] });
    const rgb = pattern(2, { mode: 3, name: 'Red', rle: true, planes: [[255, 10, 0, 0], [0, 20, 255, 0], [0, 30, 0, 255], [255, 128, 0, 255]] });
    const pal = new Array(768).fill(0);
    pal.splice(3, 3, 12, 34, 56);
    const idx = pattern(1, { mode: 2, name: 'Pal', planes: [[1, 0]], palette: pal });
    const { patterns, skipped } = readPatFile(file(gray, rgb, idx));
    expect(skipped).toEqual([]);
    expect(patterns.map((p) => [p.name, p.width, p.height])).toEqual([
      ['Gray', 2, 2],
      ['Red', 2, 2],
      ['Pal', 1, 2],
    ]);
    expect([...patterns[0].data]).toEqual([0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
    // Colour stays colour; the fourth channel is the alpha.
    expect([...patterns[1].data.slice(0, 8)]).toEqual([255, 0, 0, 255, 10, 20, 30, 128]);
    expect([...patterns[1].data.slice(8)]).toEqual([0, 255, 0, 0, 0, 0, 255, 255]);
    expect([...patterns[2].data]).toEqual([12, 34, 56, 255, 0, 0, 0, 255]);
  });

  it('skips a pattern it cannot read and goes on to the next', () => {
    const bad = pattern(1, { mode: 4, name: 'CMYK short', planes: [[1]] });
    const good = pattern(1, { mode: 1, name: 'Ok', planes: [[7]] });
    const { patterns, skipped } = readPatFile(file(bad, good));
    expect(patterns.map((p) => p.name)).toEqual(['Ok']);
    expect(skipped).toEqual([{ index: 0, reason: 'the pattern has no pixels' }]);
  });

  it('stops at a pattern whose header is not one', () => {
    const odd = pattern(1, { mode: 1, name: 'Odd', planes: [[7]], version: 9 });
    const { patterns, skipped } = readPatFile(file(odd, pattern(1, { mode: 1, name: 'Lost', planes: [[7]] })));
    expect(patterns).toEqual([]);
    expect(skipped).toEqual([{ index: 0, reason: 'pattern version 9' }]);
  });

  it("reads GIMP's one-pattern .pat", () => {
    const x = new W();
    const name = [...new TextEncoder().encode('Blue\0')];
    for (const v of [24 + name.length, 1, 2, 1, 3]) x.u32(v);
    x.raw([...'GPAT'].map((c) => c.charCodeAt(0)));
    x.raw(name);
    x.raw([0, 0, 255, 9, 8, 7]);
    const { patterns } = readPatFile(new Uint8Array(x.out));
    expect(patterns).toHaveLength(1);
    expect(patterns[0].name).toBe('Blue');
    expect([...patterns[0].data]).toEqual([0, 0, 255, 255, 9, 8, 7, 255]);
  });

  it('refuses what is not a pattern file, and a cut-off one ends cleanly', () => {
    expect(() => readPatFile(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow('not a Photoshop pattern file');
    const whole = file(pattern(2, { mode: 1, name: 'A', planes: [[1, 2, 3, 4]] }));
    const { patterns, skipped } = readPatFile(whole.subarray(0, whole.length - 3));
    expect(patterns).toEqual([]);
    expect(skipped[0].reason).toBe('the file ends early');
  });
});
