import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { normalizeSpecial, specialJob } from './special.js';
import { encodeJob } from '../../text-engine/js/paint.mjs';
import { isRasterOnly } from './psd.js';

// ===========================================================================
// Special effects (plan 8.2, B4): Crack, Lightning, Splash and Scratches,
// made by the engine from their numbers (glyph wire v15).
// ===========================================================================

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let engine;
let whole;

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  engine = await rustEngine();
  setTextEngine(engine);
  whole = createRustGlyphPainter(engine);
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

const SIZE = 56;
const ON = {
  crack: { on: true, amount: 80, size: 100, x: 50, y: 50, spread: 100, seed: 3 },
  lightning: { on: true, amount: 70, core: '#ffffff', glow: '#1e90ff', glowSize: 100, seed: 4 },
  splash: { on: true, amount: 60, size: 80, color: '#e63946', seed: 5 },
  scratches: { on: true, amount: 60, angle: -20, seed: 6 },
};
const LOOK = { strokes: [{ color: '#000000', width: 4, opacity: 1 }], shadows: [{ x: 6, y: 5, blur: 0, color: '#00ff00', opacity: 1 }] };
const style = (over = {}) =>
  normalizeStyle({ ...defaultStyle(), strokeEffects: [], font: 'Bangers', size: SIZE, color: '#ff0000', strokes: [], shadows: [], autoHeight: false, ...over });
const boxOf = (over = {}, extra = {}) => ({ id: 'b', lineN: null, text: 'KABOOM!', x: 40, y: 60, w: 360, h: 120, style: style(over), ...extra });
const pageOf = (box) => ({ id: 1, w: 800, h: 500, lines: [], boxes: [box] });

function texture(box) {
  clearLayoutMemo();
  const r = renderBoxTexture(box, pageOf(box), null, 2);
  const { width, height } = r.canvas;
  return { width, height, ox: r.ox, oy: r.oy, cw: r.cw, data: Buffer.from(r.canvas.getContext('2d').getImageData(0, 0, width, height).data) };
}
const same = (a, b) => a.width === b.width && a.height === b.height && a.data.equals(b.data);

describe('the model', () => {
  it('reads anything as four rows, off, in range', () => {
    const n = normalizeSpecial({ crack: { on: true, amount: 300, size: 1, seed: -4 }, lightning: { core: 'blue', glowSize: 999 }, splash: { color: '#ABCDEF' } });
    expect(n.crack).toEqual({ on: true, amount: 100, size: 10, x: 50, y: 50, spread: 100, seed: 0 });
    expect(n.lightning.on).toBe(false);
    expect(n.lightning.core).toBe('#ffffff');
    expect(n.lightning.glowSize).toBe(300);
    expect(n.splash.color).toBe('#abcdef');
    // A lightning saved with one colour keeps it as its glow.
    expect(normalizeSpecial({ lightning: { color: '#FF0000' } }).lightning.glow).toBe('#ff0000');
    expect(Object.keys(n)).toEqual(['crack', 'lightning', 'splash', 'scratches']);
    expect(style().special).toEqual(normalizeSpecial(undefined));
  });

  it('sends shares and radians, and only what is on', () => {
    const s = style({ special: { ...ON, splash: { ...ON.splash, on: false } } });
    const j = specialJob(s, { x: 1, y: 2, w: 3, h: 4 });
    expect(j.rect).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(j.crack).toEqual({ amount: 0.8, size: 1, x: 0.5, y: 0.5, spread: 1, seed: 3 });
    expect(j.lightning).toEqual({ amount: 0.7, core: '#ffffff', glow: '#1e90ff', glowSize: 1, seed: 4 });
    expect('splash' in j).toBe(false);
    expect(specialJob(style(), { x: 0, y: 0, w: 1, h: 1 })).toBe(null);
  });

  it('is pixels in a PSD', () => {
    expect(isRasterOnly(style({ special: { crack: ON.crack } }))).toBe(true);
    expect(isRasterOnly(style())).toBe(false);
  });
});

describe('the glyph wire (v15)', () => {
  const job = { runs: [{ text: 'HI', x: 0, y: 40 }], bands: [], fill: { kind: 'solid', color: '#000' } };
  const req = (j) => ({ job: j, font: 0, size: 40, width: 10, height: 10 });
  it('writes a job with none as it was, and the block last under flag 256', () => {
    const plain = Buffer.from(encodeJob(req(job)));
    const sp = { rect: { x: 0, y: 0, w: 100, h: 60 }, crack: { amount: 0.5, size: 1, x: 0.5, y: 0.5, spread: 1, seed: 2 } };
    const withSp = Buffer.from(encodeJob(req({ ...job, special: sp })));
    // Only the flags word and the block at the end differ.
    // Magic, version, font, synth, chain, bold draw (u32), size, 6 x transform, weight (f64).
    const FLAGS = 6 * 4 + 8 * 8;
    expect(withSp.readUInt32LE(FLAGS) & 256).toBe(256);
    expect(plain.readUInt32LE(FLAGS) & 256).toBe(0);
    // The rect, which are on, then amount, size, x, y, spread and seed.
    const tail = 8 * 4 + 4 + 8 * 5 + 4;
    expect(withSp.length).toBe(plain.length + tail);
    const a = Buffer.from(withSp.subarray(0, plain.length));
    a.writeUInt32LE(a.readUInt32LE(FLAGS) & ~256, FLAGS);
    expect(a.equals(plain)).toBe(true);
  });
});

describe('painted over the whole box', () => {
  it.each(Object.keys(ON))('%s changes the picture, with a stroke and a shadow', (k) => {
    const plain = texture(boxOf(LOOK));
    const fx = texture(boxOf({ ...LOOK, special: { [k]: ON[k] } }));
    expect(same(plain, fx)).toBe(false);
  });

  it('is the same picture wherever the box stands', () => {
    const look = { ...LOOK, special: ON };
    const here = texture(boxOf(look));
    const there = texture(boxOf(look, { x: 213, y: 171 }));
    expect(same(here, there)).toBe(true);
  });

  it('a splash stays on the letters: the footprint does not grow and no ink lands outside the plain box', () => {
    const plain = texture(boxOf());
    const sp = texture(boxOf({ special: { splash: ON.splash } }));
    expect([sp.width, sp.height, sp.cw]).toEqual([plain.width, plain.height, plain.cw]);
    expect(same(plain, sp)).toBe(false);
    let outside = 0;
    for (let i = 3; i < sp.data.length; i += 4) outside += plain.data[i] === 0 && sp.data[i] !== 0;
    expect(outside).toBe(0);
  });

  it.each([
    ['in several faces', {}, { runs: [{ start: 0, end: 3, bold: true, italic: false }, { start: 3, end: 7, bold: false, italic: false, font: 'Comic Neue' }] }],
    ['under a wobble', { wobble: { on: true, amount: 10, tilt: 8, seed: 7 } }, {}],
    ['on a curve', { curve: 30 }, {}],
    ['under a mask and a fade', {}, {
      mask: { on: true, shapes: [{ kind: 'poly', op: 'hide', pts: [[0, 0], [140, 0], [140, 500], [0, 500]] }] },
      fade: { on: true, shapes: [{ kind: 'ellipse', cx: 300, cy: 120, rx: 60, ry: 60, strength: 70, soft: 30 }] },
    }],
  ])('every effect paints %s', (_name, over, extra) => {
    const base = texture(boxOf({ ...LOOK, ...over }, extra));
    const all = texture(boxOf({ ...LOOK, ...over, special: ON }, extra));
    expect(same(base, all)).toBe(false);
    let ink = 0;
    for (let i = 3; i < all.data.length; i += 4) ink += all.data[i] > 0;
    expect(ink).toBeGreaterThan(1000);
  });

  it('under a mask, hides what the mask hides', () => {
    const mask = { on: true, shapes: [{ kind: 'poly', op: 'hide', pts: [[0, 0], [160, 0], [160, 500], [0, 500]] }] };
    const t = texture(boxOf({ special: ON }, { mask }));
    const ss = t.width / t.cw;
    let shown = 0;
    for (let j = 0; j < t.height; j++) {
      for (let i = 0; i < t.width; i++) {
        // Page x of the column: the box's x plus its box-local x.
        if (40 + (i + 0.5) / ss - t.ox < 160 - 1) shown += t.data[(j * t.width + i) * 4 + 3] > 0;
      }
    }
    expect(shown).toBe(0);
  });

  it('a crack focused on the first letter cuts only there, spread out it reaches the end', () => {
    const at = (spread) => ({ special: { crack: { ...ON.crack, amount: 60, x: 5, y: 50, spread } } });
    const plain = texture(boxOf());
    const cutCols = (t) => {
      const cols = [];
      for (let i = 0; i < t.width; i++) {
        for (let j = 0; j < t.height; j++) {
          const k = (j * t.width + i) * 4 + 3;
          if (plain.data[k] === 255 && t.data[k] < 128) { cols.push(i); break; }
        }
      }
      return cols;
    };
    const near = cutCols(texture(boxOf(at(10))));
    const wide = cutCols(texture(boxOf(at(100))));
    expect(near.length).toBeGreaterThan(0);
    // The arms still reach about a letter and a half from the focus.
    expect(Math.max(...near)).toBeLessThan(plain.width / 2);
    expect(Math.max(...wide)).toBeGreaterThan((plain.width * 2) / 3);
  });

  it('is not drawn by a painter that cannot, and the box is what it was', () => {
    setGlyphPainter({ ...whole, special: false });
    const off = texture(boxOf({ special: ON }));
    const plain = texture(boxOf());
    expect(same(off, plain)).toBe(true);
  });
});
