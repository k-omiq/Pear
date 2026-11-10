// ===== Photoshop pattern files (.pat) =====
//
// A `.pat` is Photoshop's pattern preset file: '8BPT', a version (1), a
// count, then each pattern in turn:
//
//   u32 version (1), u32 image mode, u16 height, u16 width,
//   Unicode name (u32 length in UTF-16 units, then the units),
//   Pascal id (u8 length, then the bytes),
//   indexed only: a 256-entry RGB colour table and 4 bytes we skip,
//   a virtual memory array list: u32 version (3), u32 length, then that many
//   bytes - the rectangle (top, left, bottom, right), u32 channel count, and
//   count + 2 channels (the last two are the masks), each:
//     u32 written (0: nothing follows), u32 length (0: nothing follows),
//     u32 depth, the channel's rectangle, u16 depth again, u8 compression
//     (0 raw, 1 PackBits with a u16 byte count per row first), the data.
//
// The colour channels come first, in the mode's order; one written channel
// past them is the pattern's transparency. Every pattern comes back as
// straight RGBA8, whatever its mode, so a colour pattern keeps its colours.
//
// Nothing here trusts the file: every read is bounds-checked, sizes are
// capped, and a pattern that cannot be read is skipped with its reason, not
// thrown, so one odd pattern does not lose the rest of the set.

// Photoshop's image modes.
const GRAY = 1;
const INDEXED = 2;
const RGB = 3;
const CMYK = 4;
const MULTICHANNEL = 7;
const DUOTONE = 8;
const LAB = 9;
const COLOUR_CHANNELS = { [GRAY]: 1, [INDEXED]: 1, [RGB]: 3, [CMYK]: 4, [MULTICHANNEL]: 1, [DUOTONE]: 1, [LAB]: 3 };

// A pattern bigger than this a side is refused: Photoshop's own limit is
// far past anything a tone needs, and a decoded pattern lives in memory.
export const PAT_MAX_SIDE = 8192;
const MAX_PATTERNS = 2000;

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
  }
  need(n) {
    if (n < 0 || this.at + n > this.b.length) throw new Error('the file ends early');
  }
  u8() {
    this.need(1);
    return this.b[this.at++];
  }
  u16() {
    this.need(2);
    const x = this.v.getUint16(this.at);
    this.at += 2;
    return x;
  }
  u32() {
    this.need(4);
    const x = this.v.getUint32(this.at);
    this.at += 4;
    return x;
  }
  bytes(n) {
    this.need(n);
    const x = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return x;
  }
}

// PackBits: a count byte n, then n + 1 literal bytes (n < 128) or one byte
// repeated 257 - n times (n > 128); 128 is a no-op.
function unpackBits(src, out, at, len) {
  let i = 0;
  let o = at;
  const end = at + len;
  while (o < end && i < src.length) {
    const n = src[i++];
    if (n < 128) {
      const k = Math.min(n + 1, end - o, src.length - i);
      out.set(src.subarray(i, i + k), o);
      i += n + 1;
      o += k;
    } else if (n > 128) {
      const k = Math.min(257 - n, end - o);
      out.fill(src[i++] ?? 0, o, o + k);
      o += k;
    }
  }
}

// One channel's bytes, `w * h * (depth / 8)` of them, raw.
function channelBytes(data, compression, w, h, bpp) {
  const row = w * bpp;
  const out = new Uint8Array(row * h);
  if (compression === 0) {
    out.set(data.subarray(0, Math.min(data.length, out.length)));
    return out;
  }
  if (compression !== 1) throw new Error(`compression ${compression} is not read`);
  // The row byte counts, then the rows.
  const counts = new DataView(data.buffer, data.byteOffset, Math.min(data.byteLength, h * 2));
  if (counts.byteLength < h * 2) throw new Error('the file ends early');
  let at = h * 2;
  for (let y = 0; y < h; y++) {
    const n = counts.getUint16(y * 2);
    unpackBits(data.subarray(at, at + n), out, y * row, row);
    at += n;
  }
  return out;
}

// A channel's samples as 0..255, one a pixel.
function to8(raw, depth, n) {
  if (depth === 8) return raw;
  const out = new Uint8Array(n);
  if (depth === 16) {
    for (let i = 0; i < n; i++) out[i] = raw[i * 2];
  } else if (depth === 32) {
    const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < n; i++) out[i] = Math.round(Math.min(1, Math.max(0, v.getFloat32(i * 4))) * 255);
  } else {
    throw new Error(`${depth}-bit channels are not read`);
  }
  return out;
}

// CIE Lab (Photoshop's 8-bit encoding) to sRGB.
function labToRgb(L8, a8, b8) {
  const L = (L8 / 255) * 100;
  const a = a8 - 128;
  const b = b8 - 128;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const X = 0.95047 * inv(fx);
  const Y = inv(fy);
  const Z = 1.08883 * inv(fz);
  const lin = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z];
  return lin.map((c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  });
}

function readPattern(r) {
  const version = r.u32();
  if (version !== 1) throw new Error(`pattern version ${version}`);
  const mode = r.u32();
  r.u16(); // height and width: the data's own rectangle is what is read
  r.u16();
  const nameLen = r.u32();
  if (nameLen > 1024) throw new Error('a pattern name is too long');
  let name = '';
  for (let i = 0; i < nameLen; i++) name += String.fromCharCode(r.u16());
  name = name.replace(/\0+$/, '').trim();
  r.bytes(r.u8()); // the id
  let palette = null;
  if (mode === INDEXED) {
    palette = r.bytes(256 * 3);
    r.bytes(4);
  }
  // The virtual memory array list. Its length tells where the pattern ends,
  // so a channel we cannot read still leaves the next pattern readable.
  const vmal = r.u32();
  if (vmal !== 3) throw new Error(`pattern data version ${vmal}`);
  const len = r.u32();
  const end = r.at + len;
  r.need(len);
  r.patternEnd = end;
  const body = new Reader(r.b.subarray(r.at, end));
  r.at = end;

  const top = body.u32();
  const left = body.u32();
  const bottom = body.u32();
  const right = body.u32();
  const w = right - left;
  const h = bottom - top;
  if (!(w > 0 && h > 0) || w > PAT_MAX_SIDE || h > PAT_MAX_SIDE) throw new Error(`a ${w} x ${h} pattern`);
  const count = body.u32();
  if (count > 64) throw new Error('too many channels');
  const want = COLOUR_CHANNELS[mode];
  if (!want) throw new Error(`image mode ${mode} is not read`);

  const n = w * h;
  const channels = [];
  for (let i = 0; i < count + 2 && body.at < body.b.length; i++) {
    const written = body.u32();
    if (!written) continue;
    const clen = body.u32();
    if (!clen) continue;
    const start = body.at;
    const depth = body.u32();
    const ct = body.u32();
    const cl = body.u32();
    const cb = body.u32();
    const cr = body.u32();
    body.u16();
    const compression = body.u8();
    const data = body.bytes(clen - (body.at - start));
    const cw = cr - cl;
    const ch = cb - ct;
    if (!(cw > 0 && ch > 0) || cw > PAT_MAX_SIDE || ch > PAT_MAX_SIDE) continue;
    const plane = depth === 1 ? channelBits(data, compression, cw, ch) : to8(channelBytes(data, compression, cw, ch, depth / 8), depth, cw * ch);
    // A channel smaller than the pattern sits at its own rectangle.
    if (cw === w && ch === h && ct === top && cl === left) channels.push(plane);
    else {
      const full = new Uint8Array(n);
      for (let y = 0; y < ch; y++) {
        const ty = ct - top + y;
        if (ty < 0 || ty >= h) continue;
        for (let x = 0; x < cw; x++) {
          const tx = cl - left + x;
          if (tx >= 0 && tx < w) full[ty * w + tx] = plane[y * cw + x];
        }
      }
      channels.push(full);
    }
  }
  if (channels.length < want) throw new Error('the pattern has no pixels');
  const alpha = channels.length > want ? channels[want] : null;

  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    let rr, gg, bb;
    if (mode === RGB) {
      rr = channels[0][i];
      gg = channels[1][i];
      bb = channels[2][i];
    } else if (mode === INDEXED) {
      const k = channels[0][i] * 3;
      rr = palette[k];
      gg = palette[k + 1];
      bb = palette[k + 2];
    } else if (mode === CMYK) {
      // Photoshop keeps CMYK inverted: 255 is no ink.
      const k = channels[3][i] / 255;
      rr = Math.round(channels[0][i] * k);
      gg = Math.round(channels[1][i] * k);
      bb = Math.round(channels[2][i] * k);
    } else if (mode === LAB) {
      [rr, gg, bb] = labToRgb(channels[0][i], channels[1][i], channels[2][i]);
    } else {
      rr = gg = bb = channels[0][i];
    }
    data[i * 4] = rr;
    data[i * 4 + 1] = gg;
    data[i * 4 + 2] = bb;
    data[i * 4 + 3] = alpha ? alpha[i] : 255;
  }
  return { name, width: w, height: h, data };
}

// A bitmap channel: rows of whole bytes, raw or PackBits, read as 8-bit.
function channelBits(data, compression, w, h) {
  const row = Math.ceil(w / 8);
  const packed = channelBytes(data, compression, row, h, 1);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = (packed[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 255;
  }
  return out;
}

// GIMP's .pat, one pattern a file: u32 header size, version (1), width,
// height, bytes a pixel (1 gray, 2 gray + alpha, 3 RGB, 4 RGBA), 'GPAT',
// the name (UTF-8, to the header's end), then the pixels, raw.
function readGimpPattern(b) {
  const r = new Reader(b);
  const header = r.u32();
  const version = r.u32();
  const w = r.u32();
  const h = r.u32();
  const bpp = r.u32();
  r.u32();
  if (version !== 1 || header < 24 || header > b.length) throw new Error(`GIMP pattern version ${version}`);
  if (!(w > 0 && h > 0) || w > PAT_MAX_SIDE || h > PAT_MAX_SIDE) throw new Error(`a ${w} x ${h} pattern`);
  if (bpp < 1 || bpp > 4) throw new Error(`${bpp} bytes a pixel`);
  const name = new TextDecoder().decode(r.bytes(header - 24)).replace(/\0+$/, '').trim();
  const px = r.bytes(w * h * bpp);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = px.subarray(i * bpp, i * bpp + bpp);
    const [rr, gg, bb] = bpp >= 3 ? s : [s[0], s[0], s[0]];
    data.set([rr, gg, bb, bpp === 2 ? s[1] : bpp === 4 ? s[3] : 255], i * 4);
  }
  return { name, width: w, height: h, data };
}

/**
 * Reads a `.pat` file: Photoshop's set, or GIMP's one pattern. Resolves to `{ patterns, skipped }`: each pattern as
 * `{ name, width, height, data }` (straight RGBA8), and for each one that
 * could not be read, `{ index, reason }`. Throws only when the file is not a
 * pattern file at all.
 */
export function readPatFile(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 24 && String.fromCharCode(...b.subarray(20, 24)) === 'GPAT') return { patterns: [readGimpPattern(b)], skipped: [] };
  const r = new Reader(b);
  const sig = String.fromCharCode(...r.bytes(4));
  if (sig !== '8BPT') throw new Error('not a Photoshop pattern file');
  const version = r.u16();
  if (version !== 1) throw new Error(`pattern file version ${version}`);
  const total = Math.min(r.u32(), MAX_PATTERNS);
  const patterns = [];
  const skipped = [];
  for (let i = 0; i < total && r.at < b.length; i++) {
    r.patternEnd = -1;
    try {
      patterns.push(readPattern(r));
    } catch (e) {
      skipped.push({ index: i, reason: e?.message ?? String(e) });
      // Past its data's length the next pattern can still be found; before
      // it, nothing says where that is.
      if (r.patternEnd < 0) break;
      r.at = r.patternEnd;
    }
  }
  return { patterns, skipped };
}
