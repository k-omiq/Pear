import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { arcLayout, circleLayout, clearLayoutMemo, faceFor, glyphInk, lineClusters, setTypesetEnabled, typesetEnabled } from './measure.js';
import { renderBoxTexture } from './exporter.js';
import { boxCandidate, boxInkRect } from './contain.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { encodeBox } from '../../text-engine/js/paint.mjs';

// ===========================================================================
// Curve shaping (plan 5.2, B6): an arc, a circle or a path is one line shaped
// whole and cut into its clusters, so a letter's room on the curve is its
// room in the line, kerning included, and a cluster of several code points
// is drawn once, by its first.
// ===========================================================================

const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
let rust;
let painter;
beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  rust = await rustEngine();
  painter = createRustGlyphPainter(rust);
  setTextEngine(rust);
  setGlyphPainter(painter);
  setTypesetEnabled(true);
  clearLayoutMemo();
});
afterAll(() => {
  setTextEngine(before.engine);
  setGlyphPainter(before.painter);
  setTypesetEnabled(before.typeset);
  clearLayoutMemo();
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
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

// A letter's ink is measured where the line puts it: centred on its room in
// the line (kerning included), as the painter draws it, not on its own width.
describe('a curved letter is measured where it is painted', () => {
  it('each cluster\'s ink is the line\'s: the glyph alone moved by half what kerning took', () => {
    const s = styleOf();
    const text = 'AVATAR WAVE';
    const { chars, widths, inks } = lineClusters(text, s, 64);
    const face = faceFor(s, 64);
    let kerned = 0;
    chars.forEach((ch, i) => {
      if (!/\S/.test(ch)) return expect(inks[i]).toBe(null);
      const alone = glyphInk(ch, s, 64);
      const d = (rust.advance(face, ch) - widths[i]) / 2;
      if (Math.abs(d) > 0.1) kerned++;
      expect(inks[i].left - alone.left).toBeCloseTo(d, 6);
      expect(inks[i].right - alone.right).toBeCloseTo(d, 6);
      expect([inks[i].ascent, inks[i].descent]).toEqual([alone.ascent, alone.descent]);
    });
    expect(kerned).toBeGreaterThan(0);
    // The layouts carry it.
    expect(arcLayout(text, s, 64).map((g) => g.ink)).toEqual(inks);
  });

  it('a character the font does not have is a cluster like any other', () => {
    const s = styleOf();
    const text = 'AV\u{10FFFD}AV';
    const { chars, widths, inks } = lineClusters(text, s, 64);
    expect(chars).toEqual([...text]);
    expect(sum(widths)).toBeCloseTo(rust.advance(faceFor(s, 64), text), 9);
    expect(inks).toHaveLength(chars.length);
    // The missing glyph's box has ink (the font's .notdef) where it falls.
    expect(inks[2]).not.toBe(null);
  });

  // A letter the face lacks that another loaded face has (the heart, which
  // Bangers lacks and DejaVu Sans has) is drawn from that face: its ink is
  // the fallback's glyph, moved by half its kern, never a missing box.
  const withFallback = (f) => {
    const was = rust.fallbacks();
    rust.setFallbacks(['DejaVu Sans']);
    clearLayoutMemo();
    try {
      f();
    } finally {
      rust.setFallbacks(was);
      clearLayoutMemo();
    }
  };
  it('a letter from a fallback font is measured as the fallback draws it', () => withFallback(() => {
    const s = styleOf();
    const text = 'A\u2665V';
    // Bangers has no heart; DejaVu Sans, the fallback, lends it.
    expect(rust.missing(faceFor(s, 64), '\u2665')).toEqual([]);
    const { chars, widths, inks } = lineClusters(text, s, 64);
    expect(chars).toEqual(['A', '\u2665', 'V']);
    // The letter shaped alone in the face, which draws it from the fallback.
    const alone = glyphInk('\u2665', s, 64);
    const d = (rust.advance(faceFor(s, 64), '\u2665') - widths[1]) / 2;
    expect(inks[1].left - alone.left).toBeCloseTo(d, 6);
    expect(inks[1].right - alone.right).toBeCloseTo(d, 6);
    expect([inks[1].ascent, inks[1].descent]).toEqual([alone.ascent, alone.descent]);
    // The fallback's heart, not the face's own missing box.
    const notdef = glyphInk('\u{10FFFD}', s, 64);
    expect(inks[1].right - inks[1].left).not.toBeCloseTo(notdef.right - notdef.left, 1);
    expect(inks[1].ascent).not.toBeCloseTo(notdef.ascent, 1);
  }));

  it('the box job paints a fallback letter where the footprint has it', () => withFallback(() => {
    const s = styleOf({ size: 96, curve: 0.01, strokeEffects: [], strokes: [], autoHeight: false, shape: 'off', color: '#000000' });
    const box = { id: 'b', lineN: null, text: 'A\u2665V\u2665', x: 100, y: 100, w: 400, h: 180, style: s };
    const page = { id: 1, w: 700, h: 500, lines: [], boxes: [box] };
    clearLayoutMemo();
    const t = renderBoxTexture(box, page, null, 2);
    const { width: w, height: h } = t.canvas;
    const px = t.canvas.getContext('2d').getImageData(0, 0, w, h).data;
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (px[(j * w + i) * 4 + 3] > 0) {
      x0 = Math.min(x0, i);
      x1 = Math.max(x1, i + 1);
      y0 = Math.min(y0, j);
      y1 = Math.max(y1, j + 1);
    }
    const ss = w / t.cw;
    const r = boxInkRect(boxCandidate(box, box.text));
    expect(Math.abs(r.x - (x0 / ss - t.ox))).toBeLessThan(0.75);
    expect(Math.abs(r.x + r.w - (x1 / ss - t.ox))).toBeLessThan(0.75);
    expect(Math.abs(r.y - (y0 / ss - t.oy))).toBeLessThan(0.75);
    expect(Math.abs(r.y + r.h - (y1 / ss - t.oy))).toBeLessThan(0.75);
  }));

  // Through the box job with the line flag (box wire v22): the painted
  // letters' ink edges are the footprint's (`boxInkRect`), and a painter that
  // drops the flag paints them elsewhere.
  it('the box job paints the letters where the footprint has them', () => {
    // Bent to nothing, so no letter is turned and its box is its ink's.
    // DejaVu Sans kerns A and V by a good share of an em.
    const s = styleOf({ font: 'DejaVu Sans', size: 96, curve: 0.01, strokeEffects: [], strokes: [], autoHeight: false, shape: 'off', color: '#000000' });
    const box = { id: 'b', lineN: null, text: 'AVATAR WAVE', x: 100, y: 100, w: 800, h: 180, style: s };
    const page = { id: 1, w: 1100, h: 500, lines: [], boxes: [box] };
    const paint = (p) => {
      setGlyphPainter(p);
      const t = renderBoxTexture(box, page, null, 2);
      setGlyphPainter(painter);
      return t;
    };
    // The painted ink's left and right edges, box px.
    const edges = (t) => {
      const { width: w, height: h } = t.canvas;
      const d = t.canvas.getContext('2d').getImageData(0, 0, w, h).data;
      let x0 = Infinity;
      let x1 = -Infinity;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (d[(j * w + i) * 4 + 3] > 0) {
        x0 = Math.min(x0, i);
        x1 = Math.max(x1, i + 1);
      }
      const ss = w / t.cw;
      return [x0 / ss - t.ox, x1 / ss - t.ox];
    };
    const [p0, p1] = edges(paint(painter));
    const r = boxInkRect(boxCandidate(box, box.text));
    // Within an antialiased pixel of the picture's scale.
    expect(Math.abs(r.x - p0)).toBeLessThan(0.75);
    expect(Math.abs(r.x + r.w - p1)).toBeLessThan(0.75);
    // The first letter, measured alone, is off by half its kern.
    const g = arcLayout(box.text, s, s.size)[0];
    const alone = box.w / 2 + g.x + glyphInk(g.ch, s, s.size).left;
    expect(Math.abs(alone - p0)).toBeGreaterThan(1);
    // A painter that drops the flag shapes each letter alone.
    const perLetter = { ...painter, paintBox: (ctx, spec) => painter.paintBox(ctx, { ...spec, job: { ...spec.job, line: undefined } }) };
    expect(Math.abs(edges(paint(perLetter))[0] - p0)).toBeGreaterThan(1);
  });
});

// A line shaped whole is kept, and its inks are asked of the engine only
// when something reads them.
describe('the line is shaped once, its ink when it is read', () => {
  it('reads the same line back, and asks for the inks once, on the first read', () => {
    clearLayoutMemo();
    const s = styleOf();
    const calls = { carets: 0, inks: 0 };
    const carets = rust.lineCarets;
    const inks = rust.lineInks;
    rust.lineCarets = (...a) => (calls.carets++, carets.apply(rust, a));
    rust.lineInks = (...a) => (calls.inks++, inks.apply(rust, a));
    try {
      const a = arcLayout('WAVE', s, 64);
      const b = arcLayout('WAVE', s, 64);
      expect(calls).toEqual({ carets: 1, inks: 0 });
      expect(a.every((g) => g.whole)).toBe(true);
      expect(lineClusters('WAVE', s, 64)).toBe(lineClusters('WAVE', s, 64));
      const ink = a[0].ink;
      expect(ink).not.toBe(null);
      expect(b[1].ink).toEqual(lineClusters('WAVE', s, 64).inks[1]);
      expect(calls).toEqual({ carets: 1, inks: 1 });
    } finally {
      rust.lineCarets = carets;
      rust.lineInks = inks;
    }
  });
});

