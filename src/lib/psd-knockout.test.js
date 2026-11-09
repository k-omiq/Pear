// Knockout Deep in the PSD (fin-5).
//
// REFERENCE. Photoshop's documented file format (Adobe PSD spec: layer
// records, their extra data, additional layer info blocks; `knko` is one
// knockout byte and three zero bytes) and PhotoCraft's PSD crate, which
// reads that byte as 0 None, 1 Shallow, 2 Deep
// (external/photocraft/crates/psd/src/tagged.rs:119,187) and pins the decode
// with `TaggedBlock::knockout(2).parsed() == Knockout(2)`, block data
// [2, 0, 0, 0] (tagged.rs:596, simple_typed_blocks). Its TIFF round-trip
// input list carries the same two blocks, `knko` [1,0,0,0] and [2,0,0,0]
// (crates/psd/src/tiff/tests.rs:492-493). ag-psd 31.0.2 writes the byte as
// `knockout ? 1 : 0` (additionalInfo.ts:663-674), so Deep needs a pass over
// the bytes it wrote (psd-knockout.js; the user said no ag-psd patch).
//
// The oracles here do not use our walker: the file we write is compared with
// ag-psd's own output for the same document, byte for byte. They may differ
// only in the Deep layers' knockout bytes, 1 -> 2, each sitting right after
// `8BIM knko 00000004` with three zero bytes behind it. A one-off read of the
// same files by PhotoCraft's crate (scratch, not committed) is in the fin-5
// claims file.
//
// TOLERANCE: exact. There are no pixels in this item, only bytes.
import { describe, expect, it, vi } from 'vitest';
import { writePsd, readPsd } from 'ag-psd';

import { pagePsdDocument, textLayerFor, writePagePsd, parsePagePsd, reconstructForeign } from './psd.js';
import { markDeepKnockout, readDeepKnockout, psdLayerRecords, flatLayers } from './psd-knockout.js';
import { defaultStyle, normalizeStyle, normalizeBlending } from './data.js';

const READ = { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true };
const rendered = { imageData: { width: 10, height: 6, data: new Uint8ClampedArray(10 * 6 * 4).fill(128) }, left: 3, top: 4, right: 13, bottom: 10, opacity: 1 };
const plain = { ...defaultStyle(), strokes: [], shadows: [] };
const box = (text, knockout, extra = {}) => ({
  lineN: null,
  text,
  x: 0,
  y: 0,
  w: 40,
  h: 20,
  style: normalizeStyle({ ...plain, blending: normalizeBlending({ knockout }), ...extra }),
});
// Bottom first, as the file stores them: None, Deep (live type), Shallow,
// Deep (raster-only: a curved box).
const KNOCKOUTS = ['none', 'deep', 'shallow', 'deep'];
const boxes = () => [box('none', 'none'), box('deep live', 'deep'), box('shallow', 'shallow'), box('deep raster', 'deep', { curve: 30 })];

// A page document: Base (one art layer) and Text, so group dividers sit
// between the records, as on a real export. Built fresh for every write.
function pageDoc({ w = 32, h = 32, list = boxes() } = {}) {
  const textLayers = list.map((b) => textLayerFor({ lines: [] }, b, rendered));
  const art = { name: 'Raw', left: 0, top: 0, right: w, bottom: h, imageData: { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) } };
  return pagePsdDocument({ w, h, textLayers, baseLayers: [art], project: { key: 'mt:project', schema: 1, page: { boxes: list } } });
}

// What ag-psd alone writes for the same document (writePagePsd's options).
const agPsdBytes = (doc) => new Uint8Array(writePsd(doc, { noBackground: true, psb: doc.width > 30000 || doc.height > 30000 }));

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const KNKO_HEAD = [...ascii('8BIMknko'), 0, 0, 0, 4];
// Every `8BIM knko 00000004` block in the file, as the offset of its byte.
// A byte scan is fine here, in the test: the layer names cannot spell it.
function knkoBytes(u8) {
  const out = [];
  for (let i = 0; i + KNKO_HEAD.length + 4 <= u8.length; i++) {
    if (KNKO_HEAD.every((v, k) => u8[i + k] === v)) out.push(i + KNKO_HEAD.length);
  }
  return out;
}
function diffs(a, b) {
  expect(a.length).toBe(b.length);
  const out = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

function expectOnlyDeepBytesChanged(ours, theirs) {
  const at = knkoBytes(theirs);
  // ag-psd writes the three knockouts (None writes no block) as 1, 1, 1.
  expect(at.map((i) => theirs[i])).toEqual([1, 1, 1]);
  // Ours: Deep, Shallow, Deep, each block [v, 0, 0, 0].
  expect(knkoBytes(ours)).toEqual(at);
  expect(at.map((i) => [...ours.subarray(i, i + 4)])).toEqual([[2, 0, 0, 0], [1, 0, 0, 0], [2, 0, 0, 0]]);
  // And nothing else moved.
  expect(diffs(ours, theirs)).toEqual([at[0], at[2]]);
}

describe('Knockout Deep is written as knko 2', () => {
  it('a PSD: only the Deep layers knockout bytes differ from ag-psd, 1 -> 2', () => {
    const ours = new Uint8Array(writePagePsd(pageDoc()));
    expectOnlyDeepBytesChanged(ours, agPsdBytes(pageDoc()));
  });

  it('a PSB (8-byte lengths): the same', () => {
    const ours = new Uint8Array(writePagePsd(pageDoc({ w: 30001, h: 4 })));
    expect(ours[5]).toBe(2); // version 2: PSB
    expectOnlyDeepBytesChanged(ours, agPsdBytes(pageDoc({ w: 30001, h: 4 })));
  });

  it('no Deep layer: the file is ag-psd output exactly', () => {
    const list = () => [box('none', 'none'), box('shallow', 'shallow')];
    const ours = new Uint8Array(writePagePsd(pageDoc({ list: list() })));
    expect(diffs(ours, agPsdBytes(pageDoc({ list: list() })))).toEqual([]);
  });

  it('an empty Text group still lines up (its divider and group are records)', () => {
    const doc = pageDoc({ list: [] });
    expect(flatLayers(doc.children).map((f) => f.kind)).toEqual(['divider', 'layer', 'group', 'divider', 'group']);
  });
});

describe('Knockout Deep comes back on import', () => {
  it('through parsePagePsd: the lossless project and the foreign path both give Deep', async () => {
    const bytes = new Uint8Array(writePagePsd(pageDoc()));
    const { project, psd } = parsePagePsd(bytes, READ);
    expect(project.page.boxes.map((b) => b.style.blending.knockout)).toEqual(KNOCKOUTS);
    // With the embedded project gone, as after Photoshop rewrites the XMP.
    const text = psd.children.find((c) => c.name === 'Text').children;
    expect(text.map((n) => n.knockoutDeep === true)).toEqual([false, true, false, true]);
    const page = await reconstructForeign(psd);
    // The live type layers bring their blending back; a raster-only layer
    // comes in with no style at all (reconstructForeign, unchanged here).
    expect(page.boxes.map((b) => b.style.blending?.knockout)).toEqual([undefined, 'deep', 'shallow', undefined]);
  });

  it('a PSB reads back the same', () => {
    const bytes = new Uint8Array(writePagePsd(pageDoc({ w: 30001, h: 4 })));
    const { psd } = parsePagePsd(bytes, READ);
    const text = psd.children.find((c) => c.name === 'Text').children;
    expect(text.map((n) => n.knockoutDeep === true)).toEqual([false, true, false, true]);
  });

  it('a Shallow-only file marks nothing', () => {
    const bytes = agPsdBytes(pageDoc());
    const psd = readPsd(bytes.buffer, READ);
    expect(readDeepKnockout(bytes, psd)).toBe(0);
  });
});

describe('a file the pass does not understand is left alone', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  // The same three breaks of a file: its layer count 9 -> 10 (the int16
  // right before the first record), the first knko block's signature
  // 8BIM -> 8BIX, and a cut inside the layer records.
  function broken(good) {
    const at = knkoBytes(good);
    const count = good.slice();
    const i = findCount(count);
    const dv = new DataView(count.buffer);
    expect(Math.abs(dv.getInt16(i))).toBe(9);
    dv.setInt16(i, dv.getInt16(i) < 0 ? -10 : 10);
    const sig = good.slice();
    sig[at[0] - 12 + 3] = 'X'.charCodeAt(0);
    return [count, sig, good.slice(0, at[1])];
  }

  it('writing: a broken layer count, a broken block signature, a truncated file: unchanged, no throw', () => {
    const warn = quiet();
    const good = agPsdBytes(pageDoc());
    expect(psdLayerRecords(good).records).toHaveLength(9);
    // The good file takes the Deep bytes.
    expect(markDeepKnockout(good.slice(), pageDoc().children)).toBe(2);
    for (const u8 of broken(good)) {
      const before = u8.slice();
      expect(() => markDeepKnockout(u8, pageDoc().children)).not.toThrow();
      expect(diffs(u8, before)).toEqual([]);
    }
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('reading: the same breaks of a file with Deep layers mark nothing, no throw', () => {
    const good = new Uint8Array(writePagePsd(pageDoc()));
    // The good file marks its two Deep layers.
    expect(readDeepKnockout(good, readPsd(good.slice().buffer, READ))).toBe(2);
    for (const u8 of broken(good)) {
      // ag-psd's read of these bytes, or (where it gives up) its read of the
      // good file, which would line up with every record the walk could see.
      let psd = null;
      try {
        psd = readPsd(u8.slice().buffer, READ);
      } catch {
        psd = readPsd(good.slice().buffer, READ);
      }
      expect(() => readDeepKnockout(u8, psd)).not.toThrow();
      expect(readDeepKnockout(u8, psd)).toBe(0);
      expect(JSON.stringify(psd.children ?? []).includes('knockoutDeep')).toBe(false);
    }
  });

  it('a document that does not match the file (one layer more): unchanged', () => {
    const warn = quiet();
    const u8 = agPsdBytes(pageDoc());
    const before = u8.slice();
    const doc = pageDoc();
    doc.children[1].children.push({ name: 'extra' });
    expect(markDeepKnockout(u8, doc.children)).toBe(0);
    expect(diffs(u8, before)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  // Write the file from `writeDoc`, check it against `checkDoc`: nothing may
  // change, and the refusal is said once.
  function refused(writeDoc, checkDoc) {
    const warn = quiet();
    const u8 = agPsdBytes(writeDoc);
    const before = u8.slice();
    let n;
    expect(() => (n = markDeepKnockout(u8, checkDoc.children))).not.toThrow();
    expect(n).toBe(0);
    expect(diffs(u8, before)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  }
  const withTop = (doc) => {
    doc.children.push({ name: 'top', left: 0, top: 0, right: 2, bottom: 2, imageData: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(9) } });
    return doc;
  };
  const textOf = (doc) => doc.children.find((c) => c.name === 'Text');

  it('a document with one layer fewer than the file (the rest lines up): unchanged', () => {
    refused(withTop(pageDoc()), pageDoc());
  });

  it('a closed group in the file, an open one in the document: unchanged', () => {
    const closed = pageDoc();
    textOf(closed).opened = false;
    refused(closed, pageDoc());
  });

  it('a Deep layer without Knockout: unchanged', () => {
    // Knockout off (byte 0) with Deep.
    const off = () => {
      const doc = pageDoc();
      Object.assign(textOf(doc).children[1], { knockout: false });
      return doc;
    };
    refused(off(), off());
    // No Knockout at all (no block) with Deep.
    const none = () => {
      const doc = pageDoc();
      delete textOf(doc).children[1].knockout;
      return doc;
    };
    refused(none(), none());
  });

  it('a knockout byte that is not what the document says: unchanged', () => {
    // The file has Shallow off (0); the document says on.
    const file = pageDoc();
    textOf(file).children[2].knockout = false;
    refused(file, pageDoc());
  });

  it('no Deep layer: the bytes are not read at all', () => {
    const warn = quiet();
    // Not a PSD: reading it would be refused (and said).
    const junk = new Uint8Array(64).fill(7);
    const list = [box('none', 'none'), box('shallow', 'shallow')];
    expect(markDeepKnockout(junk, pageDoc({ list }).children)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    // With a Deep layer the same bytes are read, refused and said.
    expect(markDeepKnockout(junk, pageDoc().children)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect([...junk]).toEqual(new Array(64).fill(7));
    warn.mockRestore();
  });
});

describe('the read pass refuses what does not line up', () => {
  const deep = [block('knko', [2, 0, 0, 0])];
  it('a file with one record more than the tree: nothing marked', () => {
    const tree = () => ({ children: [{ name: 'a', knockout: true }] });
    expect(readDeepKnockout(handFile([deep]), tree())).toBe(1);
    const psd = tree();
    expect(readDeepKnockout(handFile([deep, []]), psd)).toBe(0);
    expect(psd.children[0].knockoutDeep).toBeUndefined();
  });

  it('a knko block of length 5: nothing marked', () => {
    const tree = () => ({ children: [{ name: 'a', knockout: true }] });
    expect(readDeepKnockout(handFile([[block('knko', [2, 0, 0, 0, 0])]]), tree())).toBe(0);
  });

  it('a group whose divider record has no lsct 3: nothing marked', () => {
    const tree = () => ({ children: [{ name: 'g', opened: true, children: [{ name: 'a', knockout: true }] }] });
    const group = [block('lsct', u32(1))];
    // Divider, layer, group: bottom first.
    expect(readDeepKnockout(handFile([[block('lsct', u32(3))], deep, group]), tree())).toBe(1);
    expect(readDeepKnockout(handFile([[], deep, group]), tree())).toBe(0);
    expect(readDeepKnockout(handFile([[block('lsct', u32(0))], deep, group]), tree())).toBe(0);
  });
});

// Ported from PhotoCraft's block reader (tagged.rs read_blocks_with): the pad
// after a block is found by where the next signature starts. ag-psd writes
// Txt2, cinf, extn, `CAI ` and OCIO with a 4-byte pad its length leaves out
// (psdWriter.ts:499-501); none of them is on our layer records, so this checks
// the port, not a live path in our files.
describe('the block walk', () => {
  it('finds knko after a block whose 4-byte pad its length leaves out', () => {
    const u8 = handPsd([block('cinf', [1, 2, 3, 4, 5, 6], 2), block('knko', [2, 0, 0, 0])]);
    const recs = psdLayerRecords(u8);
    expect(recs.records).toHaveLength(1);
    expect(recs.records[0].knko.value).toBe(2);
    expect(u8[recs.records[0].knko.at]).toBe(2);
  });

  it('decodes PhotoCraft knko vectors: [1,0,0,0] is 1, [2,0,0,0] is 2, the last block wins', () => {
    expect(psdLayerRecords(handPsd([block('knko', [1, 0, 0, 0])])).records[0].knko.value).toBe(1);
    expect(psdLayerRecords(handPsd([block('knko', [2, 0, 0, 0])])).records[0].knko.value).toBe(2);
    expect(psdLayerRecords(handPsd([block('knko', [1, 0, 0, 0]), block('knko', [2, 0, 0, 0])])).records[0].knko.value).toBe(2);
  });

  it('reading: a plain layer may carry lsct type 0, and the last lsct wins, as in ag-psd', () => {
    const tree = () => ({ children: [{ name: 'a', knockout: true }] });
    let psd = tree();
    expect(readDeepKnockout(handPsd([block('lsct', u32(0)), block('knko', [2, 0, 0, 0])]), psd)).toBe(1);
    expect(psd.children[0].knockoutDeep).toBe(true);
    // A divider type first, then 0: ag-psd keeps the 0, a plain layer.
    psd = tree();
    expect(readDeepKnockout(handPsd([block('lsct', u32(3)), block('lsdk', u32(0)), block('knko', [2, 0, 0, 0])]), psd)).toBe(1);
    // The other way round it is a divider, which this tree does not have.
    psd = tree();
    expect(readDeepKnockout(handPsd([block('lsdk', u32(0)), block('lsct', u32(3)), block('knko', [2, 0, 0, 0])]), psd)).toBe(0);
    // A tree that says the layer has no knockout disagrees with the byte.
    expect(readDeepKnockout(handPsd([block('knko', [2, 0, 0, 0])]), { children: [{ name: 'a' }] })).toBe(0);
  });

  it("a PSB: a block with an 8-byte length (8B64, or one of ag-psd's long keys) before knko", () => {
    // ag-psd's reader rule (psdReader.ts:850): `8B64`, or a long key in a PSB.
    for (const b of [block64('FMsk', [1, 2, 3, 4, 5, 6]), block64('cinf', [1, 2, 3, 4], '8BIM')]) {
      const recs = psdLayerRecords(handPsd([b, block('knko', [2, 0, 0, 0])], { psb: true }));
      expect(recs.psb).toBe(true);
      expect(recs.records).toHaveLength(1);
      expect(recs.records[0].knko.value).toBe(2);
    }
    // The same `cinf` with a 4-byte length in a PSD.
    expect(psdLayerRecords(handPsd([block('cinf', [1, 2, 3, 4]), block('knko', [2, 0, 0, 0])])).records[0].knko.value).toBe(2);
  });

  it('a layer info of length 0 is no records', () => {
    const u8 = handPsd(null);
    expect(psdLayerRecords(u8).records).toEqual([]);
  });
});

// The offset of the int16 layer count `n` in an ag-psd PSD: after the header
// (26), colour mode data, image resources, layer and mask info length and
// layer info length (4 + 4 in a PSD).
function findCount(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 26;
  o += 4 + dv.getUint32(o);
  o += 4 + dv.getUint32(o);
  return o + 8;
}

// One additional layer info block: signature, key, length, data, then `pad`
// zero bytes the length does not count (default: to even).
function block(key, data, pad = data.length % 2) {
  return [...ascii('8BIM'), ...ascii(key), ...u32(data.length), ...data, ...new Array(pad).fill(0)];
}
function u32(v) {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}
// A 64-bit-length block (PSB): `8B64` or `8BIM`, key, an 8-byte length, data.
function block64(key, data, sig = '8B64') {
  return [...ascii(sig), ...ascii(key), ...u32(0), ...u32(data.length), ...data, ...new Array(data.length % 2).fill(0)];
}
// A minimal PSD by hand: one layer record with no channels whose extra data
// holds `blocks` (or no layer info at all when `blocks` is null).
function handPsd(blocks, opts) {
  return handFile(blocks ? [blocks] : null, opts);
}
// The same with one record per entry of `records` (each a list of blocks).
// A PSB (`psb`) gets version 2, 8-byte layer and mask info and layer info
// lengths, and one channel per record with an 8-byte length.
function handFile(records, { psb = false } = {}) {
  const len = (n) => (psb ? [...u32(0), ...u32(n)] : u32(n));
  const header = [...ascii('8BPS'), 0, psb ? 2 : 1, 0, 0, 0, 0, 0, 0, 0, 3, ...u32(1), ...u32(1), 0, 8, 0, 3];
  const name = [1, ...ascii('a'), 0, 0]; // pascal, padded to 4
  let layerInfo = [];
  if (records) {
    const body = [0, records.length];
    for (const blocks of records) {
      const extra = [...u32(0), ...u32(0), ...name, ...blocks.flat()];
      const channels = psb ? [0, 1, 0, 0, ...len(0)] : [0, 0];
      body.push(...u32(0), ...u32(0), ...u32(1), ...u32(1), ...channels, ...ascii('8BIMnorm'), 255, 0, 8, 0, ...u32(extra.length), ...extra);
    }
    while (body.length % 4) body.push(0);
    layerInfo = [...len(body.length), ...body];
  } else {
    layerInfo = len(0);
  }
  const lmi = [...layerInfo, ...u32(0)];
  return new Uint8Array([...header, ...u32(0), ...u32(0), ...len(lmi.length), ...lmi]);
}
