// Knockout Deep in a PSD, on bytes ag-psd wrote or will read.
//
// Photoshop's `knko` layer block is one byte, 0 None, 1 Shallow, 2 Deep, and
// three zero bytes (PhotoCraft crates/psd/src/tagged.rs:119,187). ag-psd 31
// writes it as `knockout ? 1 : 0` and reads it back as `!!byte`
// (additionalInfo.ts:663-674), and the user said no ag-psd patch. So:
//
// - writing: `markDeepKnockout` walks the file ag-psd returned, finds the
//   `knko` block of each layer that has our `knockoutDeep` key and sets its
//   byte from 1 to 2, in place. The length of nothing changes and no other
//   byte is touched.
// - reading: `readDeepKnockout` walks the input bytes the same way and sets
//   `knockoutDeep` on each ag-psd layer whose byte is 2.
//
// The walk follows the file's structure (header, colour mode data, image
// resources, layer and mask info, layer info, layer records and their extra
// data and blocks), PSD or PSB. It never searches for bytes. Records map to
// layers by replaying ag-psd's own flattening (`flatLayers`), and every record
// is checked against its layer before anything is written or marked. Any
// mismatch and the file is left as it is: Deep stays Shallow, nothing throws.

// ag-psd's keys whose block length is 8 bytes in a PSB (ag-psd 31.0.2
// src/helpers.ts:46-51, copied: its internals are not imported). Its writer
// gives exactly these the `8B64` signature (psdWriter.ts:494-497), and its
// reader takes an 8-byte length on `8B64` or on these keys in a PSB
// (psdReader.ts:850); the walk uses that same rule. PhotoCraft's longer list
// (tagged.rs:20-23) is not used: ag-psd writes seven of its keys (pths, extn,
// artd, lnkE, ...) with a 4-byte length in a PSB.
const AG_PSD_LARGE_KEYS = new Set(['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD', 'cinf']);

// PhotoCraft layer.rs:22 MAX_LAYER_CHANNELS.
const MAX_LAYER_CHANNELS = 64;

const SECTION_OPEN = 1;
const SECTION_CLOSED = 2;
const SECTION_DIVIDER = 3;

class Bad extends Error {}

/**
 * The layer records of a PSD or PSB, in file order (bottom first): for each,
 * its last `knko` block (`{ at, len, value }`, `at` the offset of the byte)
 * and the type of its last `lsct`/`lsdk` block, or null. Null when the bytes
 * are not a file this walk understands.
 */
export function psdLayerRecords(bytes) {
  try {
    return walk(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch {
    return null;
  }
}

function walk(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 0;
  const need = (n, end) => {
    if (!(n >= 0) || o + n > end) throw new Bad();
  };
  const u32 = (end) => {
    need(4, end);
    const v = dv.getUint32(o, false);
    o += 4;
    return v;
  };
  // A length that is 8 bytes in a PSB; past 4 GB is not ours.
  const len = (long, end) => {
    if (!long) return u32(end);
    if (u32(end) !== 0) throw new Bad();
    return u32(end);
  };
  const sigAt = (i, end) => i + 4 <= end && u8[i] === 0x38 && u8[i + 1] === 0x42 && ((u8[i + 2] === 0x49 && u8[i + 3] === 0x4d) || (u8[i + 2] === 0x36 && u8[i + 3] === 0x34)); // 8BIM or 8B64
  const str4 = (i) => String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);

  const fileEnd = u8.length;
  // Header: 8BPS, version 1 (PSD) or 2 (PSB), 26 bytes.
  need(26, fileEnd);
  if (str4(0) !== '8BPS') throw new Bad();
  const version = dv.getUint16(4, false);
  if (version !== 1 && version !== 2) throw new Bad();
  const psb = version === 2;
  o = 26;
  // Colour mode data and image resources: 4-byte lengths in both.
  for (let k = 0; k < 2; k++) {
    const n = u32(fileEnd);
    need(n, fileEnd);
    o += n;
  }
  // Layer and mask info, then layer info: 8-byte lengths in a PSB.
  const lmLen = len(psb, fileEnd);
  need(lmLen, fileEnd);
  const lmEnd = o + lmLen;
  if (lmLen === 0) return { psb, records: [] };
  const liLen = len(psb, lmEnd);
  need(liLen, lmEnd);
  const liEnd = o + liLen;
  // A layer info of length 0 is no layers (count not read).
  if (liLen === 0) return { psb, records: [] };
  need(2, liEnd);
  const count = Math.abs(dv.getInt16(o, false));
  o += 2;

  const records = [];
  for (let r = 0; r < count; r++) {
    // Ported from PhotoCraft crates/psd/src/layer.rs:610-649 (LayerRecord::read).
    need(16, liEnd);
    o += 16; // rect
    need(2, liEnd);
    const nch = dv.getUint16(o, false);
    o += 2;
    if (nch > MAX_LAYER_CHANNELS) throw new Bad();
    const ch = 2 + (psb ? 8 : 4); // i16 id, then a 4- or 8-byte length
    need(nch * ch, liEnd);
    o += nch * ch;
    need(12, liEnd);
    if (str4(o) !== '8BIM') throw new Bad();
    o += 12; // signature, blend key, opacity, clipping, flags, filler
    const extraLen = u32(liEnd); // 4 bytes in a PSB too
    need(extraLen, liEnd);
    const xEnd = o + extraLen;
    for (let k = 0; k < 2; k++) {
      // layer mask data, blending ranges
      const n = u32(xEnd);
      need(n, xEnd);
      o += n;
    }
    // Pascal name padded to 4 (PhotoCraft io.rs:392-399 read_pascal).
    need(1, xEnd);
    const nameLen = 1 + u8[o];
    const padded = nameLen + ((4 - (nameLen % 4)) % 4);
    need(padded, xEnd);
    o += padded;

    // Blocks, ported from PhotoCraft tagged.rs:464-500 (read_blocks_with,
    // alignment 2 for a layer record): a block is `8BIM`/`8B64` (is_sig,
    // without its TIFF markers), key, length, data; the pad after it is the
    // smallest k in 0..=3 at which the next signature (or the end) starts,
    // else the default even pad if it is zeros, else none. Bytes that do not
    // start a block end the list (PhotoCraft keeps them as trailing data).
    let knko = null;
    let section = null;
    while (xEnd - o >= 12 && sigAt(o, xEnd)) {
      const long = str4(o) === '8B64' || (psb && AG_PSD_LARGE_KEYS.has(str4(o + 4)));
      const key = str4(o + 4);
      o += 8;
      const n = len(long, xEnd);
      need(n, xEnd);
      const at = o;
      o += n;
      const rest = xEnd - o;
      let pad = null;
      for (let k = 0; k <= 3; k++) {
        if (k === rest || (k < rest && sigAt(o + k, xEnd))) {
          pad = k;
          break;
        }
      }
      if (pad === null) {
        const def = n % 2;
        pad = rest >= def && u8.subarray(o, o + def).every((b) => b === 0) ? def : 0;
      }
      o += pad;
      // The last of each wins, as ag-psd's reader overwrites.
      if (key === 'knko') knko = { at, len: n, value: n >= 1 ? u8[at] : null };
      else if (key === 'lsct' || key === 'lsdk') section = n >= 4 ? dv.getUint32(at, false) : null;
    }
    o = xEnd;
    records.push({ knko, section });
  }
  return { psb, records };
}

/**
 * ag-psd's layer records in file order, from a layer tree: its writer's
 * `addChildren` (psdWriter.ts:513-552) replayed. A child with `children`
 * (an empty array too) is a group: its bounding divider, its children, then
 * the group record. `{ kind, node }`, node null for a divider.
 */
export function flatLayers(children) {
  const out = [];
  const add = (list) => {
    for (const c of list ?? []) {
      if (c?.children) {
        out.push({ kind: 'divider', node: null });
        add(c.children);
        out.push({ kind: 'group', node: c });
      } else {
        out.push({ kind: 'layer', node: c });
      }
    }
  };
  add(children);
  return out;
}

// A Deep layer the file would not take is said, not lost in silence.
function refuse(why) {
  console.warn(`PSD export: Knockout Deep written as Shallow (${why})`);
  return 0;
}

/**
 * Set the `knko` byte of every Deep layer (`knockoutDeep`) to 2 in a file
 * ag-psd wrote from `children`, in place. Returns how many it set. Every
 * record must be what ag-psd writes for its layer, or nothing is changed.
 */
export function markDeepKnockout(buf, children) {
  const flat = flatLayers(children);
  // ag-psd writes one empty record for a file with no layers.
  if (!flat.length) flat.push({ kind: 'layer', node: {} });
  // Nothing Deep: the bytes are not even read.
  if (!flat.some((f) => f.node?.knockoutDeep)) return 0;
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const walked = psdLayerRecords(u8);
  if (!walked) return refuse('file not understood');
  const { records } = walked;
  if (records.length !== flat.length) return refuse('layer count');
  const deep = [];
  for (let i = 0; i < flat.length; i++) {
    const { kind, node } = flat[i];
    const r = records[i];
    const section = kind === 'divider' ? SECTION_DIVIDER : kind === 'group' ? (node.opened === false ? SECTION_CLOSED : SECTION_OPEN) : (node?.sectionDivider?.type ?? null);
    if (r.section !== section) return refuse('layer order');
    const knockout = node?.knockout;
    if (!!r.knko !== (knockout !== undefined)) return refuse('knockout blocks');
    if (r.knko && (r.knko.len !== 4 || r.knko.value !== (knockout ? 1 : 0))) return refuse('knockout bytes');
    if (node?.knockoutDeep) {
      if (!knockout) return refuse('Deep without Knockout');
      deep.push(r.knko.at);
    }
  }
  for (const at of deep) u8[at] = 2;
  return deep.length;
}

/**
 * Mark the layers of `psd` (ag-psd's read of `buf`) whose `knko` byte is 2
 * with `knockoutDeep`. Returns how many it marked. Every record must agree
 * with ag-psd's layer for it, or nothing is marked.
 *
 * It trusts `psd` to be ag-psd's read of these same bytes (as parsePagePsd
 * hands it). Given a tree from another file of the same shape and knockout
 * flags, it would mark by position.
 */
export function readDeepKnockout(buf, psd) {
  try {
    const walked = psdLayerRecords(buf);
    if (!walked || !psd) return 0;
    const flat = flatLayers(psd.children);
    const { records } = walked;
    if (records.length !== flat.length) return 0;
    const marks = [];
    for (let i = 0; i < flat.length; i++) {
      const { kind, node } = flat[i];
      const r = records[i];
      if (kind === 'divider' ? r.section !== SECTION_DIVIDER : kind === 'group' ? r.section !== (node.opened === false ? SECTION_CLOSED : SECTION_OPEN) : r.section !== null && r.section !== 0) return 0;
      if (r.knko && r.knko.len !== 4) return 0;
      const on = !!r.knko && r.knko.value !== 0;
      if (on !== (kind === 'divider' ? false : !!node.knockout)) return 0;
      if (on && r.knko.value === 2) marks.push(node);
    }
    for (const n of marks) n.knockoutDeep = true;
    return marks.length;
  } catch {
    return 0;
  }
}
