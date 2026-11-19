import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { zlibSync } from 'fflate';
import { readFontInfo, fontKind, extraStyleWords, styleLabel } from './font-names.js';

// What a font file says about itself, read from the tracked fixtures
// (src/test/fonts) and from a WOFF written here around one of them.

const fixture = (name) => readFileSync(new URL(`../test/fonts/${name}`, import.meta.url));

// A WOFF 1 holding the sfnt's tables, each zlib-compressed: enough of the
// format for the reader, which only walks the table directory.
function toWoff(sfnt) {
  const u8 = new Uint8Array(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = v.getUint16(4, false);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    const tag = v.getUint32(at, false);
    const off = v.getUint32(at + 8, false);
    const len = v.getUint32(at + 12, false);
    const raw = u8.subarray(off, off + len);
    const comp = zlibSync(raw);
    tables.push({ tag, orig: raw, data: comp.length < raw.length ? comp : raw });
  }
  let size = 44 + n * 20;
  for (const t of tables) size += (t.data.length + 3) & ~3;
  const out = new Uint8Array(size);
  const w = new DataView(out.buffer);
  w.setUint32(0, 0x774f4646);
  w.setUint32(4, v.getUint32(0, false));
  w.setUint32(8, size);
  w.setUint16(12, n);
  let off = 44 + n * 20;
  tables.forEach((t, i) => {
    const at = 44 + i * 20;
    w.setUint32(at, t.tag);
    w.setUint32(at + 4, off);
    w.setUint32(at + 8, t.data.length);
    w.setUint32(at + 12, t.orig.length);
    out.set(t.data, off);
    off += (t.data.length + 3) & ~3;
  });
  return out;
}

describe('reading a font file’s own names', () => {
  it('reads family, style and weight from a TrueType file', () => {
    const info = readFontInfo(fixture('ComicNeue-Regular.ttf'));
    expect(info.kind).toBe('ttf');
    expect(info.family).toBe('Comic Neue');
    expect(info.style).toBe('Regular');
    expect(info.bold).toBe(false);
    expect(info.italic).toBe(false);
    expect(info.weight).toBe(400);
  });

  it('knows an oblique is the italic slot', () => {
    const info = readFontInfo(fixture('DejaVuSans-Oblique.ttf'));
    expect(info.family).toBe('DejaVu Sans');
    expect(info.italic).toBe(true);
    expect(info.bold).toBe(false);
  });

  it('reads a WOFF the same as the font inside it', () => {
    const ttf = fixture('Bangers-Regular.ttf');
    const plain = readFontInfo(ttf);
    const woff = readFontInfo(toWoff(ttf));
    expect(woff.kind).toBe('woff');
    expect({ ...woff, kind: 'ttf' }).toEqual(plain);
  });

  it('says what it cannot read rather than guessing', () => {
    expect(readFontInfo(new Uint8Array([1, 2, 3]))).toBe(null);
    expect(readFontInfo(new TextEncoder().encode('<html>not a font at all</html>'))).toBe(null);
    expect(fontKind(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('woff2');
    expect(readFontInfo(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 0, 0, 0, 0]))).toEqual({ kind: 'woff2' });
    // A directory that points past the end of the file.
    const cut = fixture('DejaVuSans.ttf').subarray(0, 400);
    expect(readFontInfo(cut)).toBe(null);
  });

  it('names the words of a style the four slots do not hold', () => {
    expect(extraStyleWords('Bold Italic')).toEqual([]);
    expect(extraStyleWords('Light Italic')).toEqual(['Light']);
    expect(extraStyleWords('SemiCondensed Black')).toEqual(['Semi', 'Condensed', 'Black']);
    expect(styleLabel({ typoStyle: 'Light', style: 'Regular' })).toBe('Light');
    expect(styleLabel({ bold: true, italic: true, width: 3 })).toBe('Condensed Bold Italic');
  });
});
