import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { rustEngine } from '../test/rust-engine.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { app } from './store.svelte.js';
import { boxCandidate, placeBlock } from './contain.js';
import { editLines } from './edit-lines.js';
import { layoutLines, lineWidth, lineWidthAt, sliceWidth, casedRuns, setTypesetEnabled, typesetEnabled, clearLayoutMemo, faceFor, layoutMemoSize, lineFaces } from './measure.js';
import { solveLayout } from './auto-layout.js';
import { systemFontEntry } from './fonts.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// A box set in several faces (runs.js), laid out on the Rust engine
// ===========================================================================
// The engine lane, because this is where a bold measures as bold: the fixture
// families have no bold file, and the Rust engine synthesises one the WebKit
// way (`boldAdvance: 'webkit'`, the app's default), a 36th of the size wider
// a glyph. Skia's synthetic bold - the realfont lane - keeps the advances, so
// a bold run there could not be told from none.

const before = { engine: textEngine(), typeset: typesetEnabled(), system: app.fonts.system };
let engine;
beforeAll(async () => {
  engine = await rustEngine();
  setTextEngine(engine);
  setTypesetEnabled(true);
  app.fonts.system = [systemFontEntry({ name: 'DejaVu Sans', faces: { regular: true, italic: true } })];
});
afterAll(() => {
  setTextEngine(before.engine);
  setTypesetEnabled(before.typeset);
  app.fonts.system = before.system;
});
beforeEach(() => clearLayoutMemo());

const SIZE = 40;
const styleFor = (extra = {}) => normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: SIZE, bold: false, italic: false, ...extra });
const B = (start, end) => ({ start, end, bold: true, italic: false });
const adv = (style, str) => engine.advance(faceFor(style, SIZE), str);
const WIDE = 2000;

// Every line is the text's own slice at its offsets, plus an added hyphen.
function expectSpansHold(lines, text) {
  expect(lines.spans).toHaveLength(lines.length);
  lines.forEach((line, k) => {
    const [s, e] = lines.spans[k];
    const slice = text.slice(s, e);
    expect(line === slice || line === slice + '-', `line ${k} "${line}" vs "${slice}"`).toBe(true);
  });
}

describe('measuring a text in several faces', () => {
  it('a bold run widens its line by what the bold face adds, and no more', () => {
    const s = styleFor();
    const text = 'HELLO WORLD';
    const lines = layoutLines(text, s, SIZE, WIDE, null, { runs: [B(0, 5)] });
    expect([...lines]).toEqual(['HELLO WORLD']);
    expectSpansHold(lines, text);
    const want = adv({ ...s, bold: true }, 'HELLO') + adv(s, ' WORLD');
    expect(lineWidthAt(lines, 0, s, SIZE)).toBe(want);
    const plain = lineWidth(text, s, SIZE);
    // A synthesised bold is a 36th of the size wider a glyph (WebKit).
    expect(want - plain).toBeCloseTo((5 * SIZE) / 36, 6);
  });

  it('is one engine measure: the slice set in its faces, as the engine cuts it', () => {
    const s = styleFor();
    const text = 'A BOLD WORD';
    const runs = [B(2, 6)];
    const faces = [faceFor(s, SIZE), faceFor({ ...s, bold: true }, SIZE), faceFor(s, SIZE)];
    const spans = [{ start: 0, end: 2 }, { start: 2, end: 6 }, { start: 6, end: 11 }];
    expect(sliceWidth(text, runs, s, SIZE, 0, 11)).toBe(engine.advanceRuns(faces, text, spans));
  });

  it('with no runs, and with runs only in the box face, lays out as today', () => {
    const s = styleFor();
    const text = 'WHEN THE RAIN STOPS WE WALK HOME TOGETHER';
    const today = layoutLines(text, s, SIZE, 260, null);
    expect(today.spans).toBeUndefined();
    // The same memo entry: the key with no runs is today's key.
    const size = layoutMemoSize();
    expect(layoutLines(text, s, SIZE, 260, null, { runs: null })).toBe(today);
    expect(layoutMemoSize()).toBe(size);
    // A run in the box's own face says nothing (`casedRuns` drops it).
    const cased = casedRuns(text, [{ start: 0, end: 4, bold: false, italic: false }], s);
    expect(cased.runs).toBe(null);
    const bold = styleFor({ bold: true });
    expect(casedRuns(text, [B(0, 4)], bold).runs).toBe(null);
  });

  it('breaks differently only where the widths differ', () => {
    const s = styleFor();
    const text = 'WHEN THE RAIN STOPS WE WALK HOME TOGETHER AT LAST';
    const runs = [B(14, 19)]; // STOPS
    for (let w = 120; w <= 700; w += 7) {
      const plain = layoutLines(text, s, SIZE, w, null);
      const mixed = layoutLines(text, s, SIZE, w, null, { runs });
      expectSpansHold(mixed, text);
      // Every line fits as measured in its faces (a single word may not).
      mixed.forEach((line, k) => {
        if (/\s/.test(line.trim())) expect(lineWidthAt(mixed, k, s, SIZE)).toBeLessThanOrEqual(w + 0.01);
      });
      if ([...mixed].join('\n') === [...plain].join('\n')) continue;
      // Where they differ, the plain breaking does not hold in the faces: one
      // of its lines is wider than the room once STOPS is bold - or the bold
      // made a breaking that was dearer before cheaper now, which only a line
      // holding STOPS can do.
      const at = plain.findIndex((l) => l.includes('STOPS'));
      expect(at).toBeGreaterThanOrEqual(0);
    }
    // And at a width that holds every line either way, nothing moves.
    expect([...layoutLines(text, s, SIZE, WIDE, null, { runs })]).toEqual([...layoutLines(text, s, SIZE, WIDE, null)]);
  });

  it('a run across a line break is measured in its face on both lines', () => {
    const s = styleFor();
    const text = 'BRAVE HEARTS NEVER FALL';
    const runs = [B(6, 18)]; // HEARTS NEVER
    const lines = layoutLines(text, s, SIZE, adv(s, 'BRAVE HEARTS') + 6, null, { runs });
    expectSpansHold(lines, text);
    expect(lines.length).toBeGreaterThan(1);
    const inRun = lines.findIndex((l) => l.includes('HEARTS'));
    const next = lines.findIndex((l) => l.includes('NEVER'));
    expect(next).toBeGreaterThan(inRun);
    // Each line is its faces' pieces summed.
    lines.forEach((line, k) => {
      const [a, e] = lines.spans[k];
      let want = 0;
      let at = a;
      for (const cut of [6, 18, e]) {
        if (cut <= at || at >= e) continue;
        const end = Math.min(cut, e);
        const bold = at >= 6 && at < 18;
        want += adv(bold ? { ...s, bold: true } : s, text.slice(at, end));
        at = end;
      }
      if (lines[k].length > e - a) throw new Error('no hyphen expected here');
      expect(lineWidthAt(lines, k, s, SIZE)).toBe(engine.advanceRuns(
        piecesOf(text, a, e, s, runs).map((p) => faceFor(p.style, SIZE)),
        text.slice(a, e),
        piecesOf(text, a, e, s, runs).map((p) => ({ start: p.start - a, end: p.end - a })),
      ));
      expect(Math.abs(lineWidthAt(lines, k, s, SIZE) - want)).toBeLessThan(1e-9);
    });
  });

  it('a run across a hyphenation point: the hyphen is set in the face before it', () => {
    const s = styleFor({ hyphenate: true });
    const text = 'UNBELIEVABLE';
    const runs = [B(0, 12)];
    const lines = layoutLines(text, s, SIZE, adv(s, 'UNBELIEV'), null, { runs, breakWords: true });
    expectSpansHold(lines, text);
    expect(lines.length).toBeGreaterThan(1);
    const [a, e] = lines.spans[0];
    expect(lines[0].endsWith('-')).toBe(true);
    const bold = { ...s, bold: true };
    expect(lineWidthAt(lines, 0, s, SIZE)).toBe(adv(bold, text.slice(a, e) + '-'));
    // And the plain text at the same width hyphenates as its own widths say.
    const plain = layoutLines(text, s, SIZE, adv(s, 'UNBELIEV'), null, { breakWords: true });
    expect(lineWidth(plain[0], s, SIZE)).toBeLessThanOrEqual(adv(s, 'UNBELIEV') + 0.01);
  });
});

function piecesOf(text, a, e, s, runs) {
  const out = [];
  const cuts = [...new Set([a, ...runs.flatMap((r) => [r.start, r.end]).filter((v) => v > a && v < e), e])].sort((x, y) => x - y);
  for (let i = 1; i < cuts.length; i++) {
    const bold = runs.some((r) => r.start <= cuts[i - 1] && r.end >= cuts[i]);
    out.push({ start: cuts[i - 1], end: cuts[i], style: bold ? { ...s, bold: true } : s });
  }
  return out;
}

describe('upper case with runs', () => {
  it('maps the runs through a case change that changes the length (ß to SS)', () => {
    const s = styleFor({ uppercase: true });
    // A run after the ß moves one on; a run over the ß covers both letters.
    expect(casedRuns('straße bold', [B(7, 11)], s)).toEqual({ text: 'STRASSE BOLD', runs: [B(8, 12)] });
    expect(casedRuns('aßb', [B(1, 2)], s)).toEqual({ text: 'ASSB', runs: [B(1, 3)] });
  });

  it('lays the cased text out with the runs where their letters went', () => {
    const s = styleFor({ uppercase: true });
    const cand = boxCandidate({ x: 0, y: 0, w: WIDE, h: 200, style: s }, 'straße bold', [B(7, 11)]);
    const place = placeBlock(cand);
    expect([...place.lines]).toEqual(['STRASSE BOLD']);
    expect(place.lines.runs).toEqual([B(8, 12)]);
    // Close, not equal: the engine adds its pieces in its own order.
    expect(lineWidthAt(place.lines, 0, s, SIZE)).toBeCloseTo(adv(s, 'STRASSE ') + adv({ ...s, bold: true }, 'BOLD'), 9);
    // The editor cannot lay these lines over the raw text (the length
    // changed), as without runs.
    expect(editLines('straße bold', place.text, place.lines)).toBe(null);
  });
});

describe('the readers of a layout', () => {
  it('the editor lays the lines over the raw text by their offsets', () => {
    const s = styleFor();
    const text = 'ONE  TWO\nTHREE FOUR';
    const cand = boxCandidate({ x: 0, y: 0, w: adv(s, 'THREE') + 12, h: 400, style: s }, text, [B(5, 8)]);
    const place = placeBlock(cand);
    expectSpansHold(place.lines, place.text);
    const segs = editLines(text, place.text, place.lines);
    expect(segs.map((g) => g.head + g.body + g.tail).join('')).toBe(text);
    expect(segs.map((g) => g.body)).toEqual([...place.lines]);
  });

  it('the solver sets words all in a bold run as it sets a bold box', () => {
    const s = styleFor();
    const text = 'WE HAVE TO GO RIGHT NOW BEFORE THEY FIND US';
    const region = { kind: 'ellipse', cx: 300, cy: 300, rx: 150, ry: 110 };
    const plain = solveLayout({ text, style: s, refSize: SIZE, region, opts: {} });
    const bold = solveLayout({ text, style: s, refSize: SIZE, region, runs: [B(0, text.length)], opts: {} });
    const boxBold = solveLayout({ text, style: { ...s, bold: true }, refSize: SIZE, region, opts: {} });
    expect(plain && bold && boxBold).toBeTruthy();
    // Every width the solver weighs is the bold face's either way, so the
    // answer is the same one. (Not "no larger than plain": the wider words
    // can take one more line and so a larger size.)
    const pick = (r) => ({ size: r.size, w: r.w, h: r.h, lines: [...r.lines] });
    expect(pick(bold)).toEqual(pick(boxBold));
    expect(pick(bold)).not.toEqual(pick(plain));
    const widest = (r, runs) => {
      const lines = layoutLines(text, { ...s, size: r.size }, r.size, r.w, null, runs ? { runs } : undefined);
      return Math.max(...lines.map((_, k) => lineWidthAt(lines, k, { ...s, size: r.size }, r.size)));
    };
    expect(widest(bold, [B(0, text.length)])).toBeLessThanOrEqual(bold.w);
  });
});

describe('a run the engine cannot cut at', () => {
  it('measures the pieces one at a time rather than throw', () => {
    const s = styleFor();
    // A run that ends inside the emoji, as no normalised list can, but a
    // caller could still hand in.
    const text = 'x\u{1F600}y';
    expect(() => engine.advanceRuns([faceFor({ ...s, bold: true }, SIZE), faceFor(s, SIZE)], text, [{ start: 0, end: 2 }, { start: 2, end: 4 }])).toThrow();
    const w = sliceWidth(text, [B(0, 2)], s, SIZE, 0, 4);
    expect(Number.isFinite(w) && w > 0).toBe(true);
  });

  it('lays out a run that ends between a letter and its mark', () => {
    const s = styleFor();
    const text = 'CAFÉ NOIR';
    const lines = layoutLines(text, s, SIZE, WIDE, null, { runs: [B(0, 4)] });
    expectSpansHold(lines, text);
    expect([...lines]).toEqual([text]);
  });
});

describe('plain wrapping with runs', () => {
  it('breaks a word too wide for the box between letters, as the plain path does', () => {
    const s = styleFor({ shape: 'off' });
    const text = 'GO UNBELIEVABLY FAR';
    const w = adv({ ...s, bold: true }, 'UNBELI');
    const lines = layoutLines(text, s, SIZE, w, null, { runs: [B(3, 15)], breakWords: true });
    expectSpansHold(lines, text);
    lines.forEach((_, k) => expect(lineWidthAt(lines, k, s, SIZE)).toBeLessThanOrEqual(w + 0.01));
    expect(lines.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });
});

describe('a run in a family of its own (C4)', () => {
  it('measures its letters in that family, and the line carries it to the painters', () => {
    const s = styleFor();
    const text = 'HELLO WORLD';
    const F = { start: 0, end: 5, bold: false, italic: false, font: 'Comic Neue' };
    const lines = layoutLines(text, s, SIZE, WIDE, null, { runs: [F] });
    expect([...lines]).toEqual(['HELLO WORLD']);
    const want = adv({ ...s, font: 'Comic Neue' }, 'HELLO') + adv(s, ' WORLD');
    expect(adv({ ...s, font: 'Comic Neue' }, 'HELLO')).not.toBe(adv(s, 'HELLO'));
    expect(lineWidthAt(lines, 0, s, SIZE)).toBe(want);
    const cuts = lineFaces(lines, 0, s);
    expect(cuts.map((c) => [c.start, c.end, c.style.font])).toEqual([[0, 5, 'Comic Neue'], [5, 11, 'Bangers']]);
    // A run naming the box's own family is the box's face: no cut.
    const same = layoutLines(text, s, SIZE, WIDE, null, { runs: [{ ...F, font: 'Bangers' }] });
    expect(lineFaces(same, 0, s)).toBe(null);
    expect(lineWidthAt(same, 0, s, SIZE)).toBe(adv(s, 'HELLO WORLD'));
  });
});
