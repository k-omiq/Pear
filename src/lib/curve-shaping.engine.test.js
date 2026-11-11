import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rustEngine } from '../test/rust-engine.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { arcLayout, circleLayout, clearLayoutMemo, faceFor, lineClusters } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { encodeBox } from '../../text-engine/js/paint.mjs';

// ===========================================================================
// Curve shaping (plan 5.2, B6): an arc, a circle or a path is one line shaped
// whole and cut into its clusters, so a letter's room on the curve is its
// room in the line, kerning included, and a cluster of several code points
// is drawn once, by its first.
// ===========================================================================

const before = textEngine();
let rust;
beforeAll(async () => {
  rust = await rustEngine();
  setTextEngine(rust);
  clearLayoutMemo();
});
afterAll(() => {
  setTextEngine(before);
  clearLayoutMemo();
});

const styleOf = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 64, curve: 30, ...over });
const sum = (a) => a.reduce((x, y) => x + y, 0);

describe('a curve is one line, cut into clusters', () => {
  it('gives each letter its room in the line, kerning included', () => {
    const s = styleOf();
    const text = 'AVATAR WAVE';
    const { chars, widths } = lineClusters(text, s, 64);
    expect(chars).toEqual([...text]);
    const face = faceFor(s, 64);
    expect(sum(widths)).toBeCloseTo(rust.advance(face, text), 9);
    // At least one pair is kerned: shaped alone, a letter takes other room.
    const alone = [...text].map((ch) => rust.advance(face, ch));
    expect(widths.some((w, i) => Math.abs(w - alone[i]) > 0.25)).toBe(true);
    // The arc runs over the same room.
    const arc = arcLayout(text, s, 64);
    expect(arc.map((g) => g.w)).toEqual(widths);
  });

  it('draws a cluster of several code points once, by its first', () => {
    const s = styleOf();
    const text = 'CAFÉ!';
    const { chars, widths } = lineClusters(text, s, 64);
    // One entry per code point, so the caret still counts code points.
    expect(chars).toEqual(['C', 'A', 'F', 'É', '', '!']);
    expect(widths[4]).toBe(0);
    expect(sum(widths)).toBeCloseTo(rust.advance(faceFor(s, 64), text), 9);
  });

  it('puts the letter spacing between clusters, not inside one', () => {
    const s = styleOf({ letterSpacing: 10, circle: { ...defaultStyle().circle, on: true } });
    const spaced = lineClusters('ÉA', s, 64, 10);
    const ring = circleLayout('ÉA', s, 64);
    // The closed ring pays one gap per cluster: two, not three.
    const R = Math.hypot(ring[0].x, ring[0].y);
    expect(2 * Math.PI * R).toBeCloseTo(sum(spaced.widths) + 2 * 10, 6);
  });
});

describe('the box wire says so', () => {
  const job = (more) => ({ face: 'x', curved: true, align: 'center', letterSpacing: 0, bands: [], fill: { kind: 'solid', color: '#000000' }, runs: [{ text: 'A', x: 1, y: 2, rot: 0 }], ...more });
  // The flag sits just before the glyph job's length, which sits before
  // the job's own magic.
  const flagOf = (bytes) => {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 8; at + 12 <= bytes.length; at += 4) {
      if (dv.getUint32(at + 8, true) === 0x4a50544d && dv.getUint32(at + 4, true) === bytes.length - at - 8) return dv.getUint32(at, true);
    }
    return null;
  };
  it('writes 1 for a curved line, 0 for anything else', () => {
    const w = (j) => flagOf(encodeBox({ job: j, font: 0, size: 10, width: 4, height: 4 }).slice());
    expect(w(job({ line: true }))).toBe(1);
    expect(w(job({}))).toBe(0);
    expect(w(job({ curved: false, line: true }))).toBe(0);
  });
});
