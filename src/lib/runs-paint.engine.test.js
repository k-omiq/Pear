import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo, faceFor } from './measure.js';
import { typeModel, piecePens, linePens } from './type-rows.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// A box set in several faces (runs.js), painted on the Rust engine
// ===========================================================================
// The engine lane, where a bold measures as bold (see runs-layout.engine
// .test.js): each line's stretches go to the painter in the glyph job's face
// table (wire v13), and the painter shapes each in its face. Held for both of
// the engine's ways of painting a box: whole, in one job, and as glyphs under
// the canvas passes.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let engine;
let whole;
let canvasPasses;

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  engine = await rustEngine();
  setTextEngine(engine);
  whole = createRustGlyphPainter(engine);
  canvasPasses = { ...whole, box: false, paintBox: undefined, roughen: false };
  setTypesetEnabled(true);
});
afterAll(() => {
  setTextEngine(before.engine);
  setGlyphPainter(before.painter);
  setTypesetEnabled(before.typeset);
  clearLayoutMemo();
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});
beforeEach(() => {
  clearLayoutMemo();
  setGlyphPainter(whole);
});

const SIZE = 48;
const B = (start, end) => ({ start, end, bold: true, italic: false });
const style = (over = {}) =>
  normalizeStyle({ ...defaultStyle(), strokeEffects: [], font: 'Bangers', size: SIZE, color: '#ff0000', align: 'left', strokes: [], shadows: [], autoHeight: false, ...over });
const LOOK = { strokes: [{ color: '#0000ff', width: 4, opacity: 1 }], shadows: [{ x: 6, y: 5, blur: 0, color: '#00ff00', opacity: 1 }] };
const boxOf = (over = {}, runs = null) => ({ id: 'b', lineN: null, text: 'HELLO WORLD', x: 40, y: 40, w: 520, h: 120, style: style(over), ...(runs ? { runs } : {}) });
const pageOf = (box) => ({ id: 1, w: 600, h: 400, lines: [], boxes: [box] });

function texture(box, painter) {
  setGlyphPainter(painter);
  clearLayoutMemo();
  const r = renderBoxTexture(box, pageOf(box), null, 2);
  setGlyphPainter(whole);
  const { width, height } = r.canvas;
  return { width, height, data: Buffer.from(r.canvas.getContext('2d').getImageData(0, 0, width, height).data) };
}
const same = (a, b) => a.width === b.width && a.height === b.height && a.data.equals(b.data);

describe.each([
  ['painted whole by the engine', () => whole],
  ['painted as glyphs under the canvas passes', () => canvasPasses],
])('a box with runs, %s', (_name, painter) => {
  it.each([
    ['plain', {}],
    ['with a stroke and a shadow', LOOK],
  ])('all in bold is the bold box, %s', (_look, look) => {
    const runs = texture(boxOf(look, [B(0, 11)]), painter());
    const bold = texture(boxOf({ ...look, bold: true }), painter());
    expect(same(runs, bold)).toBe(true);
  });

  it('all in another family is the box set in that family', () => {
    const fam = { start: 0, end: 11, bold: false, italic: false, font: 'Comic Neue' };
    const runs = texture(boxOf(LOOK, [fam]), painter());
    expect(same(runs, texture(boxOf({ ...LOOK, font: 'Comic Neue' }), painter()))).toBe(true);
    expect(same(runs, texture(boxOf(LOOK), painter()))).toBe(false);
  });

  it('with one word bold is neither the plain box nor the bold one', () => {
    const mixed = texture(boxOf(LOOK, [B(0, 5)]), painter());
    expect(same(mixed, texture(boxOf(LOOK), painter()))).toBe(false);
    expect(same(mixed, texture(boxOf({ ...LOOK, bold: true }), painter()))).toBe(false);
  });

  it('with runs in the box face only is the box it was', () => {
    const own = texture(boxOf(LOOK, [{ start: 0, end: 5, bold: false, italic: false }]), painter());
    expect(same(own, texture(boxOf(LOOK), painter()))).toBe(true);
  });
});

describe('the glyph job of a box with runs', () => {
  const jobsOf = (box) => {
    const jobs = [];
    texture(box, { ...canvasPasses, paint: (ctx, job) => (jobs.push(job), canvasPasses.paint(ctx, job)) });
    return jobs;
  };

  it('has no face table and no stretches when the box has no runs', () => {
    const jobs = jobsOf(boxOf(LOOK));
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect('faces' in job).toBe(false);
      for (const run of job.runs) expect('spans' in run).toBe(false);
    }
  });

  it('says each stretch of a line and its face', () => {
    const jobs = jobsOf(boxOf({}, [B(0, 5)]));
    const job = jobs.at(-1);
    expect(job.faces.map((f) => f.key)).toEqual([faceFor(style({ bold: true }), SIZE).key, faceFor(style(), SIZE).key]);
    expect(job.runs.map((r) => r.text)).toEqual(['HELLO WORLD']);
    expect(job.runs[0].spans).toEqual([
      { face: 0, start: 0, end: 5 },
      { face: 1, start: 5, end: 11 },
    ]);
  });
});

describe('carets in a line set in several faces', () => {
  it('stand where each stretch is painted: after a bold word, at its bold width', () => {
    const s = style();
    const boldW = engine.advance(faceFor(style({ bold: true }), SIZE), 'HELLO');
    const plainW = engine.advance(faceFor(s, SIZE), 'HELLO');
    expect(boldW).toBeGreaterThan(plainW);
    const xAt = (box, o) => {
      const row = typeModel(box, box.text, box.runs ?? null).rows[0];
      return row.xs[row.offs.indexOf(o)] - row.xs[row.offs.indexOf(0)];
    };
    expect(xAt(boxOf({}, [B(0, 5)]), 5)).toBeCloseTo(boldW, 9);
    expect(xAt(boxOf(), 5)).toBeCloseTo(plainW, 9);
    // And the line ends where the painter's shaping of it ends.
    const full = engine.advance(faceFor(style({ bold: true }), SIZE), 'HELLO') + engine.advance(faceFor(s, SIZE), ' WORLD');
    expect(xAt(boxOf({}, [B(0, 5)]), 11)).toBeCloseTo(full, 9);
  });

  it('are each stretch\'s own pens, one after another', () => {
    const s = style();
    const pieces = [
      { start: 0, end: 5, style: style({ bold: true }) },
      { start: 5, end: 11, style: s },
    ];
    const pens = piecePens(engine, pieces, 'HELLO WORLD', 0, SIZE);
    const a = linePens(engine, faceFor(pieces[0].style, SIZE), 'HELLO', 0);
    const b = linePens(engine, faceFor(s, SIZE), ' WORLD', 0);
    expect(pens.at).toEqual([...a.at, ...b.at.map((o) => o + 5)]);
    expect(pens.x).toEqual([...a.x, ...b.x.map((x) => x + a.end)]);
    expect(pens.end).toBe(a.end + b.end);
  });
});
