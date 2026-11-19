// ===== What a font file says about itself =====
// The family, the style, the weight and the slant, read from the file's own
// tables rather than guessed from its file name. A folder of fonts is named by
// whoever zipped it; the name table is named by the foundry, and that is what
// the Font Library sorts by when it can.
//
// Plain TrueType/OpenType, collections (the first face, which is the one the
// browser draws) and WOFF 1 (zlib, decoded here) are read directly. WOFF 2 is
// Brotli: the caller turns it into a plain font first (font_decode.rs) or
// falls back on the file name.
//
// Pure: no DOM, no store. See font-names.test.js.
import { unzlibSync } from 'fflate';

const TAG = (s) => (s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3);
const T_NAME = TAG('name');
const T_OS2 = TAG('OS/2');
const T_HEAD = TAG('head');
const WANT = [T_NAME, T_OS2, T_HEAD];

function toU8(buf) {
  if (!buf) return null;
  if (buf instanceof Uint8Array) return buf;
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  // An ArrayBuffer, from this window or another (where `instanceof` says no).
  try {
    return typeof buf.byteLength === 'number' ? new Uint8Array(buf) : null;
  } catch {
    return null;
  }
}

// What kind of font file the bytes are, from the first four: 'ttf', 'otf',
// 'ttc', 'woff', 'woff2', or null for anything that is not a font at all.
export function fontKind(buf) {
  const u8 = toU8(buf);
  if (!u8 || u8.byteLength < 12) return null;
  const t = ((u8[0] << 24) | (u8[1] << 16) | (u8[2] << 8) | u8[3]) >>> 0;
  if (t === 0x00010000 || t === 0x74727565) return 'ttf';
  if (t === 0x4f54544f) return 'otf';
  if (t === 0x74746366) return 'ttc';
  if (t === 0x774f4646) return 'woff';
  if (t === 0x774f4632) return 'woff2';
  return null;
}

// The three tables this reads, as byte ranges, or null when the file cannot be
// walked. Anything out of bounds is a broken file, not a crash.
function tablesOf(u8) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const kind = fontKind(u8);
  const out = new Map();
  if (kind === 'woff') {
    if (u8.byteLength < 44) return null;
    const n = view.getUint16(12, false);
    if (44 + n * 20 > u8.byteLength) return null;
    for (let i = 0; i < n; i++) {
      const at = 44 + i * 20;
      const tag = view.getUint32(at, false) | 0;
      if (!WANT.includes(tag)) continue;
      const off = view.getUint32(at + 4, false);
      const comp = view.getUint32(at + 8, false);
      const orig = view.getUint32(at + 12, false);
      if (off + comp > u8.byteLength) return null;
      const raw = u8.subarray(off, off + comp);
      // A table is stored as it is when compressing it did not help.
      if (comp >= orig) out.set(tag, raw);
      else {
        try {
          out.set(tag, unzlibSync(raw));
        } catch {
          return null;
        }
      }
    }
    return out;
  }
  let start = 0;
  if (kind === 'ttc') {
    if (u8.byteLength < 16 || view.getUint32(8, false) < 1) return null;
    start = view.getUint32(12, false);
  } else if (kind !== 'ttf' && kind !== 'otf') {
    return null;
  }
  if (start + 12 > u8.byteLength) return null;
  const n = view.getUint16(start + 4, false);
  if (start + 12 + n * 16 > u8.byteLength) return null;
  for (let i = 0; i < n; i++) {
    const at = start + 12 + i * 16;
    const tag = view.getUint32(at, false) | 0;
    if (!WANT.includes(tag)) continue;
    const off = view.getUint32(at + 8, false);
    const len = view.getUint32(at + 12, false);
    if (off + len > u8.byteLength) return null;
    out.set(tag, u8.subarray(off, off + len));
  }
  return out;
}

function decodeName(bytes, platformID, encodingID) {
  const utf16 = platformID === 0 || platformID === 3 || (bytes.length >= 2 && bytes[0] === 0);
  if (utf16) {
    let s = '';
    for (let k = 0; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
    return s;
  }
  // Mac Roman is close enough to Latin-1 for the names fonts carry.
  if (platformID === 1 && encodingID === 0) return String.fromCharCode(...bytes);
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

// The best record of each name id: Windows Unicode US English first, as the
// PostScript name parser in fonts.js ranks them.
function readNames(t) {
  const names = {};
  if (!t || t.byteLength < 6) return names;
  const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const count = view.getUint16(2, false);
  const base = view.getUint16(4, false);
  const best = {};
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    if (at + 12 > t.byteLength) break;
    const platformID = view.getUint16(at, false);
    const encodingID = view.getUint16(at + 2, false);
    const languageID = view.getUint16(at + 4, false);
    const nameID = view.getUint16(at + 6, false);
    const length = view.getUint16(at + 8, false);
    const offset = view.getUint16(at + 10, false);
    if (![1, 2, 4, 6, 16, 17].includes(nameID) || !length) continue;
    const s = base + offset;
    if (s + length > t.byteLength) continue;
    let rank = 10;
    if (platformID === 3 && encodingID === 1 && languageID === 0x0409) rank = 100;
    else if (platformID === 3 && (encodingID === 1 || encodingID === 10)) rank = 90;
    else if (platformID === 3) rank = 80;
    else if (platformID === 0) rank = 70;
    else if (platformID === 1 && encodingID === 0 && languageID === 0) rank = 60;
    if (best[nameID] && best[nameID].rank >= rank) continue;
    const str = decodeName(t.subarray(s, s + length), platformID, encodingID).replace(/\0/g, '').trim();
    if (str) best[nameID] = { rank, str };
  }
  for (const [id, v] of Object.entries(best)) names[id] = v.str;
  return names;
}

// Family, style and the numbers behind them, or null when the bytes are not a
// font this can read (WOFF 2 included: `{ kind: 'woff2' }` comes back so the
// caller knows to decode it first).
//
//   family / style            name ids 1 and 2: the style-linked family, whose
//                             style is always Regular, Bold, Italic or Bold
//                             Italic. "Foo Light" is a family of its own here.
//   typoFamily / typoStyle    name ids 16 and 17 when the file has them: the
//                             whole typeface ("Foo") and the weight in it
//                             ("Light Italic").
//   weight, width             OS/2 usWeightClass and usWidthClass.
//   bold, italic              the style bits (OS/2 fsSelection, head macStyle).
export function readFontInfo(buf) {
  const u8 = toU8(buf);
  const kind = fontKind(u8);
  if (!kind) return null;
  if (kind === 'woff2') return { kind };
  let tables;
  try {
    tables = tablesOf(u8);
  } catch {
    return null;
  }
  if (!tables) return null;
  const names = readNames(tables.get(T_NAME));
  let weight = 400;
  let width = 5;
  let bold = false;
  let italic = false;
  const os2 = tables.get(T_OS2);
  if (os2 && os2.byteLength >= 64) {
    const v = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
    weight = v.getUint16(4, false) || 400;
    width = v.getUint16(6, false) || 5;
    const sel = v.getUint16(62, false);
    italic = !!(sel & 0x01) || !!(sel & 0x200);
    bold = !!(sel & 0x20);
  }
  const head = tables.get(T_HEAD);
  if (head && head.byteLength >= 46) {
    const mac = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(44, false);
    bold = bold || !!(mac & 0x01);
    italic = italic || !!(mac & 0x02);
  }
  // Some old fonts put 1-9 here (the Windows 3.1 scale).
  if (weight < 10) weight *= 100;
  const style = names[2] || null;
  if (style) {
    if (/bold/i.test(style)) bold = true;
    if (/italic|oblique/i.test(style)) italic = true;
  }
  return {
    kind,
    family: names[1] || null,
    style,
    typoFamily: names[16] || null,
    typoStyle: names[17] || null,
    fullName: names[4] || null,
    postScript: names[6] || null,
    weight,
    width,
    bold,
    italic,
  };
}

// The words in a style name that are not one of the four slots: "Light",
// "Condensed", "Black". What makes a face one the four slots cannot hold
// cleanly, and what the import asks about.
const PLAIN_WORDS = new Set(['regular', 'normal', 'roman', 'book', 'plain', 'standard', 'bold', 'italic', 'oblique', 'it', 'ital', 'upright']);
export function extraStyleWords(style) {
  if (!style) return [];
  return String(style)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter((w) => w && !PLAIN_WORDS.has(w.toLowerCase()));
}

const WIDTH_WORDS = { 1: 'Ultra Condensed', 2: 'Extra Condensed', 3: 'Condensed', 4: 'Semi Condensed', 6: 'Semi Expanded', 7: 'Expanded', 8: 'Extra Expanded', 9: 'Ultra Expanded' };

// The face's style, as the user would say it: the typographic style when the
// file has one ("Light Italic"), else the legacy one, else the bits.
export function styleLabel(info) {
  if (!info) return '';
  const s = info.typoStyle || info.style;
  if (s) return s;
  const parts = [];
  if (info.width && WIDTH_WORDS[info.width]) parts.push(WIDTH_WORDS[info.width]);
  parts.push(info.bold ? 'Bold' : 'Regular');
  if (info.italic) parts.push('Italic');
  return parts.join(' ');
}
