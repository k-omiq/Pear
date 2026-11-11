import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { boxCandidate, boxInkRect } from './contain.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// Words in several faces (runs.js) with the effects of the engine lane:
// wobble, a stroke and a mask over three faces, a curve (which is laid out
// and painted in the box face), paint marks over the letters, and the ink a
// straight line's footprint is measured by.
// ===========================================================================

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
// Three faces: a bold word, an italic stretch, a stretch in another family.
const THREE = [
  { start: 0, end: 5, bold: true, italic: false },
  { start: 6, end: 8, bold: false, italic: true },
  { start: 8, end: 11, bold: false, italic: false, font: 'Comic Neue' },
];
const STROKE = { strokes: [{ color: '#0000ff', width: 4, opacity: 1 }] };
const WOBBLE = { wobble: { on: true, amount: 10, tilt: 8, seed: 7 } };
const style = (over = {}) =>
  normalizeStyle({ ...defaultStyle(), strokeEffects: [], font: 'Bangers', size: SIZE, color: '#ff0000', align: 'left', strokes: [], shadows: [], autoHeight: false, ...over });
const boxOf = (over = {}, runs = null, extra = {}) => ({ id: 'b', lineN: null, text: 'HELLO WORLD', x: 40, y: 40, w: 520, h: 120, style: style(over), ...(runs ? { runs } : {}), ...extra });
const pageOf = (box) => ({ id: 1, w: 600, h: 400, lines: [], boxes: [box] });

function texture(box, painter = whole) {
  setGlyphPainter(painter);
  clearLayoutMemo();
  const r = renderBoxTexture(box, pageOf(box), null, 2);
  setGlyphPainter(whole);
  const { width, height } = r.canvas;
  return { width, height, ss: width / r.cw, ox: r.ox, oy: r.oy, data: Buffer.from(r.canvas.getContext('2d').getImageData(0, 0, width, height).data) };
}
const same = (a, b) => a.width === b.width && a.height === b.height && a.data.equals(b.data);
// The box-local x of a texture column.
const localX = (t, i) => (i + 0.5) / t.ss - t.ox;

describe('three faces under a wobble, a stroke and a mask', () => {
  const look = { ...STROKE, ...WOBBLE };
  // Hides the box's left 100 px (page x 40..140), across the first word.
  const mask = { on: true, shapes: [{ kind: 'poly', op: 'hide', pts: [[0, 0], [140, 0], [140, 400], [0, 400]] }] };

  it('wobbles the letters of every face, and the faces show', () => {
    const runs = texture(boxOf(look, THREE));
    expect(same(runs, texture(boxOf(look)))).toBe(false);
    expect(same(runs, texture(boxOf(STROKE, THREE)))).toBe(false);
  });

  it('the mask hides its side and leaves the other as it was', () => {
    const open = texture(boxOf(look, THREE));
    const masked = texture(boxOf(look, THREE, { mask }));
    expect(masked.width).toBe(open.width);
    expect(masked.height).toBe(open.height);
    let shownLeft = 0;
    let inkedRight = 0;
    let changedRight = 0;
    for (let j = 0; j < open.height; j++) {
      for (let i = 0; i < open.width; i++) {
        const x = localX(open, i);
        const at = (j * open.width + i) * 4;
        if (x < 100 - 1) shownLeft += masked.data[at + 3] > 0;
        else if (x > 100 + 1) {
          inkedRight += open.data[at + 3] > 0;
          for (let c = 0; c < 4; c++) changedRight += masked.data[at + c] !== open.data[at + c];
        }
      }
    }
    expect(shownLeft).toBe(0);
    expect(inkedRight).toBeGreaterThan(0);
    expect(changedRight).toBe(0);
  });
});

describe('a curved box with runs', () => {
  it.each([
    ['painted whole by the engine', () => whole],
    ['painted as glyphs under the canvas passes', () => canvasPasses],
  ])('is laid out and painted in the box face, %s', (_name, painter) => {
    const curved = { ...STROKE, curve: 30 };
    const runs = texture(boxOf(curved, THREE), painter());
    expect(same(runs, texture(boxOf(curved), painter()))).toBe(true);
    // And the runs do show on the straight box.
    expect(same(texture(boxOf(STROKE, THREE), painter()), texture(boxOf(STROKE), painter()))).toBe(false);
  });
});

describe('paint marks over a box with runs', () => {
  const marks = { paint: { on: true, marks: [{ kind: 'ellipse', cx: 260, cy: 60, rx: 220, ry: 40, color: '#ffff00', opacity: 100, soft: 0 }] } };

  it('colours the letters of every face, and nothing past them', () => {
    const plain = texture(boxOf({}, THREE));
    const painted = texture(boxOf(marks, THREE));
    expect(painted.width).toBe(plain.width);
    let yellow = 0;
    let outside = 0;
    for (let at = 0; at < plain.data.length; at += 4) {
      const [r, g, b, a] = painted.data.subarray(at, at + 4);
      if (a === 255 && r === 255 && g === 255 && b === 0) yellow++;
      if (plain.data[at + 3] === 0 && a > 0) outside++;
    }
    expect(yellow).toBeGreaterThan(100);
    expect(outside).toBe(0);
    // The marks follow the faces' letters, not the box face's.
    expect(same(painted, texture(boxOf(marks)))).toBe(false);
  });
});

describe('the footprint of a straight line in several faces', () => {
  it('holds the ink the engine paints, each stretch in its face', () => {
    const s = { font: 'DejaVu Sans', size: 96, shape: 'off', color: '#000000' };
    const runs = [
      { start: 0, end: 5, bold: true, italic: false },
      { start: 5, end: 11, bold: false, italic: false, font: 'Comic Neue' },
    ];
    const box = boxOf(s, runs, { text: 'AVATAR WAVE', w: 900, h: 180 });
    const t = texture(box);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let j = 0; j < t.height; j++) for (let i = 0; i < t.width; i++) if (t.data[(j * t.width + i) * 4 + 3] > 0) {
      x0 = Math.min(x0, i);
      x1 = Math.max(x1, i + 1);
    }
    const r = boxInkRect(boxCandidate(box, box.text, box.runs));
    expect(Math.abs(r.x - (x0 / t.ss - t.ox))).toBeLessThan(0.75);
    expect(Math.abs(r.x + r.w - (x1 / t.ss - t.ox))).toBeLessThan(0.75);
    // Measured in the box face alone, the right edge is elsewhere.
    const own = boxInkRect(boxCandidate(box, box.text));
    expect(Math.abs(own.x + own.w - (x1 / t.ss - t.ox))).toBeGreaterThan(1);
  });
});
