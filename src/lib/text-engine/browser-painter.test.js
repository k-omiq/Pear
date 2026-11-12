import { describe, expect, it } from 'vitest';
import { createBrowserGlyphPainter } from './browser-painter.js';

// The canvas painter, on a context that records what it is told: a line set
// in several faces is drawn a stretch at a time, each in its own font, at the
// pen its own measure gives, and placed by its whole width as `textAlign`
// would place it. A line in one face is the one call it always was.

// A face's letters are as wide as its font says: regular 10, bold 12.
const widthOf = (font, text) => text.length * (font.startsWith('bold') ? 12 : 10);

function recorder() {
  const calls = [];
  const ctx = {
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    letterSpacing: '0px',
    canvas: { width: 100, height: 100 },
    save() {},
    restore() {},
    measureText(text) {
      return { width: widthOf(this.font, text) };
    },
    fillText(text, x, y) {
      calls.push({ op: 'fill', text, x, y, font: this.font, align: this.textAlign });
    },
    strokeText(text, x, y) {
      calls.push({ op: 'stroke', text, x, y, font: this.font, align: this.textAlign });
    },
  };
  return { ctx, calls };
}

const regular = { key: '40px Face' };
const bold = { key: 'bold 40px Face' };
const job = (over = {}) => ({
  curved: false,
  noFill: false,
  silhouette: null,
  align: 'left',
  letterSpacing: 0,
  bands: [],
  fill: { kind: 'solid', color: '#000' },
  face: regular,
  runs: [{ text: 'HI THERE', x: 50, y: 30 }],
  ...over,
});
const twoFaces = (align) =>
  job({
    align,
    faces: [bold, regular],
    runs: [{ text: 'HI THERE', x: 50, y: 30, spans: [{ face: 0, start: 0, end: 2 }, { face: 1, start: 2, end: 8 }] }],
  });

describe('the canvas painter, a line in several faces', () => {
  it('draws a line in one face in one call, as before', () => {
    const { ctx, calls } = recorder();
    createBrowserGlyphPainter().paint(ctx, job());
    expect(calls).toEqual([{ op: 'fill', text: 'HI THERE', x: 50, y: 30, font: '40px Face', align: 'left' }]);
  });

  it.each([
    ['left', 50],
    ['center', 50 - (24 + 60) / 2],
    ['right', 50 - (24 + 60)],
  ])('draws each stretch in its face from where the %s-aligned line starts', (align, x0) => {
    const { ctx, calls } = recorder();
    createBrowserGlyphPainter().paint(ctx, twoFaces(align));
    expect(calls).toEqual([
      { op: 'fill', text: 'HI', x: x0, y: 30, font: 'bold 40px Face', align: 'left' },
      { op: 'fill', text: ' THERE', x: x0 + 24, y: 30, font: '40px Face', align: 'left' },
    ]);
  });

  it('strokes the stretches where it fills them', () => {
    const { ctx, calls } = recorder();
    createBrowserGlyphPainter().paint(ctx, { ...twoFaces('left'), bands: [{ color: '#fff', line: 4, opacity: 1 }] });
    const at = (op) => calls.filter((c) => c.op === op).map((c) => [c.text, c.x, c.font]);
    expect(at('stroke')).toEqual(at('fill'));
    expect(at('stroke')).toHaveLength(2);
  });

  it('leaves a line without stretches in the job as one call', () => {
    const { ctx, calls } = recorder();
    const j = twoFaces('left');
    j.runs.push({ text: 'NEXT', x: 50, y: 70 });
    createBrowserGlyphPainter().paint(ctx, j);
    expect(calls.at(-1)).toEqual({ op: 'fill', text: 'NEXT', x: 50, y: 70, font: '40px Face', align: 'left' });
  });
});
