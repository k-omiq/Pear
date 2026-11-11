import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { normalizeSpecial, specialJob, breakReach, BREAK_SIDE, BREAK_DROP, dragHandle, dragArm, armEnd, handleFrame, handlePoint, handlePercents, outlineKinds } from './special.js';
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
  it('reads anything as four rows, off, in range, and the box stroke at the cuts', () => {
    const n = normalizeSpecial({ crack: { on: true, amount: 300, size: 1, seed: -4 }, lightning: { core: 'blue', glowSize: 999 }, splash: { color: '#ABCDEF' } });
    expect(n.crack).toEqual({ on: true, amount: 100, size: 10, x: 50, y: 50, spread: 100, breakOff: 0, motion: 'fall', seed: 0 });
    expect(normalizeSpecial({ crack: { motion: 'apart' } }).crack.motion).toBe('apart');
    expect(normalizeSpecial({ crack: { motion: 'spin' } }).crack.motion).toBe('fall');
    expect(n.outline).toBe('fills-cuts');
    expect(normalizeSpecial({ outline: 'cut-through' }).outline).toBe('cut-through');
    expect(normalizeSpecial({ outline: 'over' }).outline).toBe('fills-cuts');
    expect(n.lightning.on).toBe(false);
    expect(n.lightning.core).toBe('#ffffff');
    expect(n.lightning.glowSize).toBe(300);
    expect(n.splash.color).toBe('#abcdef');
    // A lightning saved with one colour keeps it as its glow.
    expect(normalizeSpecial({ lightning: { color: '#FF0000' } }).lightning.glow).toBe('#ff0000');
    expect(Object.keys(n)).toEqual(['crack', 'lightning', 'splash', 'scratches', 'outline', 'bandOutline']);
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

describe('the glyph wire (v16)', () => {
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

  it('writes a crack with no break off as v15 did, and kind 16 with its share and motion after the crack', () => {
    const crack = { amount: 0.5, size: 1, x: 0.5, y: 0.5, spread: 1, seed: 2 };
    const rect = { x: 0, y: 0, w: 100, h: 60 };
    const none = Buffer.from(encodeJob(req({ ...job, special: { rect, crack } })));
    const brk = Buffer.from(encodeJob(req({ ...job, special: { rect, crack: { ...crack, breakOff: { share: 0.5, motion: 1 } } } })));
    expect(brk.length).toBe(none.length + 12);
    // The kinds word after the rect: 1 alone, then 1 | 16.
    const KINDS = none.length - (8 * 5 + 4) - 4;
    expect(none.readUInt32LE(KINDS)).toBe(1);
    expect(brk.readUInt32LE(KINDS)).toBe(17);
    expect(brk.readDoubleLE(none.length)).toBe(0.5);
    expect(brk.readUInt32LE(none.length + 8)).toBe(1);
    // 32: the box's strokes cut through, no payload; only with cuts.
    const cut = Buffer.from(encodeJob(req({ ...job, special: { rect, crack, cutStrokes: true } })));
    expect(cut.length).toBe(none.length);
    expect(cut.readUInt32LE(KINDS)).toBe(33);
    expect(() => encodeJob(req({ ...job, special: { rect, lightning: { amount: 0.5, core: [255, 255, 255, 255], glow: [0, 0, 255, 255], glowSize: 1, seed: 1 }, cutStrokes: true } }))).toThrow(/crack or scratches/);
    // At 0 the style sends no break off at all.
    const s0 = style({ special: { crack: { ...ON.crack, breakOff: 0 } } });
    expect('breakOff' in specialJob(s0, rect).crack).toBe(false);
    const s5 = style({ special: { crack: { ...ON.crack, breakOff: 50 } } });
    expect(specialJob(s5, rect).crack.breakOff).toEqual({ share: 0.5, motion: 1 });
    const apart = style({ special: { crack: { ...ON.crack, breakOff: 50, motion: 'apart' } } });
    expect(specialJob(apart, rect).crack.breakOff).toEqual({ share: 0.5, motion: 0 });
    // The box stroke at the cuts: on the wire only when cut through, and
    // only with cuts.
    expect('cutStrokes' in specialJob(s5, rect)).toBe(false);
    const through = style({ special: { crack: ON.crack, outline: 'cut-through' } });
    expect(specialJob(through, rect).cutStrokes).toBe(true);
    const bolt = style({ special: { lightning: ON.lightning, outline: 'cut-through' } });
    expect('cutStrokes' in specialJob(bolt, rect)).toBe(false);
  });
});

describe('painted over the whole box', () => {
  it.each(Object.keys(ON))('%s changes the picture, with a stroke and a shadow', (k) => {
    const plain = texture(boxOf(LOOK));
    const fx = texture(boxOf({ ...LOOK, special: { [k]: ON[k] } }));
    expect(same(plain, fx)).toBe(false);
  });

  it('a box stroke outlines the cuts or is cut through, each its own picture, and a switch misses the kept one', () => {
    const k0 = defaultStyle().strokeEffects[0];
    const stroked = (outline, kind = 'crack') => ({ strokeEffects: [{ ...k0, on: true, size: 4, opacity: 1, color: '#000000', position: 'center' }], special: { [kind]: ON[kind], outline } });
    for (const kind of ['crack', 'scratches']) {
      const fills = texture(boxOf(stroked('fills-cuts', kind)));
      const through = texture(boxOf(stroked('cut-through', kind)));
      const again = texture(boxOf(stroked('fills-cuts', kind)));
      expect(same(fills, through), kind).toBe(false);
      expect(same(fills, again), kind).toBe(true);
      // Cut through, the stroke loses ink at the cuts.
      const ink = (t) => { let n = 0; for (let i = 3; i < t.data.length; i += 4) n += t.data[i]; return n; };
      expect(ink(through), kind).toBeLessThan(ink(fills));
    }
    // Without a box stroke the choice changes nothing.
    const bare = (outline) => texture(boxOf({ special: { crack: ON.crack, outline } }));
    expect(same(bare('fills-cuts'), bare('cut-through'))).toBe(true);
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

  describe('break off (B5)', () => {
    const at = (breakOff, motion = 'fall') => ({ ...LOOK, special: { crack: { ...ON.crack, breakOff, motion } } });

    it('pads the paint by the farthest a piece travels, and only the paint', () => {
      expect(breakReach(style(at(0)))).toBe(null);
      expect(breakReach(style(at(50, 'apart')))).toEqual({ x: BREAK_SIDE * SIZE, top: BREAK_SIDE * SIZE, bottom: BREAK_SIDE * SIZE });
      expect(breakReach(style(at(50))).bottom).toBe(BREAK_DROP * SIZE);
      const plain = texture(boxOf(at(0)));
      const fall = texture(boxOf(at(80)));
      expect(fall.height).toBeGreaterThan(plain.height + 2 * 120);
    });

    it.each(['apart', 'fall'])('%s: moves pieces, the same picture each time and wherever the box stands', (m) => {
      const crack = texture(boxOf(at(0, m)));
      const a = texture(boxOf(at(75, m)));
      const b = texture(boxOf(at(75, m)));
      expect(same(a, b)).toBe(true);
      const there = texture(boxOf(at(75, m), { x: 213, y: 171 }));
      expect(same(a, there)).toBe(true);
      // Ink where the cracked box has none, the two lined up on the box's
      // corner: a piece moved there.
      const dx = (crack.ox - a.ox) * 2;
      const dy = (crack.oy - a.oy) * 2;
      let landed = 0;
      for (let j = 0; j < a.height; j++) {
        for (let i = 0; i < a.width; i++) {
          const ci = i + dx, cj = j + dy;
          const was = ci >= 0 && cj >= 0 && ci < crack.width && cj < crack.height ? crack.data[(cj * crack.width + ci) * 4 + 3] : 0;
          if (a.data[(j * a.width + i) * 4 + 3] > 128 && was === 0) landed++;
        }
      }
      // Falling, some of it lies below the letters' lowest ink.
      if (m === 'fall') {
        let low = 0;
        for (let j = 0; j < crack.height; j++) for (let i = 0; i < crack.width; i++) if (crack.data[(j * crack.width + i) * 4 + 3] > 0) low = j;
        let below = 0;
        for (let j = low - dy + 4; j < a.height; j++) for (let i = 0; i < a.width; i++) below += a.data[(j * a.width + i) * 4 + 3] > 128;
        expect(below).toBeGreaterThan(20);
      }
      expect(landed).toBeGreaterThan(50);
    });

    it('a new seed breaks other pieces, and 0 is the crack alone', () => {
      const plain = texture(boxOf({ ...LOOK, special: { crack: ON.crack } }));
      expect(same(texture(boxOf(at(0))), plain)).toBe(true);
      expect(same(texture(boxOf(at(0, 'apart'))), plain)).toBe(true);
      const a = texture(boxOf(at(75)));
      const b = texture(boxOf({ ...LOOK, special: { crack: { ...ON.crack, seed: 4, breakOff: 75 } } }));
      expect(same(a, b)).toBe(false);
      // The two motions move the same pieces to other places.
      expect(same(a, texture(boxOf(at(75, 'apart'))))).toBe(false);
    });
  });

  it('is not drawn by a painter that cannot, and the box is what it was', () => {
    setGlyphPainter({ ...whole, special: false });
    const off = texture(boxOf({ special: ON }));
    const plain = texture(boxOf());
    expect(same(off, plain)).toBe(true);
  });
});

// ===========================================================================
// Fix round 1 (2026-11-11): the Outline choice for the text's own outline
// (glyph wire v18, kind 64), an aimed lightning (128) and a placed splash
// (256), and the on-page handles' numbers.
// ===========================================================================

describe('the new keys', () => {
  it('read as the first-built look when missing, and send nothing new at their defaults', () => {
    const n = normalizeSpecial({});
    expect(n.bandOutline).toBe('cut-through');
    expect(n.lightning).toMatchObject({ aim: 'across', x: 0, y: 50, angle: 0 });
    expect(n.splash).toMatchObject({ x: 50, y: 50, spread: 100 });
    expect(normalizeSpecial({ bandOutline: 'fills-cuts' }).bandOutline).toBe('fills-cuts');
    expect(normalizeSpecial({ bandOutline: 'over' }).bandOutline).toBe('cut-through');
    expect(normalizeSpecial({ lightning: { aim: 'spin', x: 400, angle: 900 } }).lightning).toMatchObject({ aim: 'across', x: 100, angle: 180 });
    const rect = { x: 0, y: 0, w: 10, h: 10 };
    const j = specialJob(style({ special: { ...ON, splash: { ...ON.splash, x: 10, y: 90 } } }), rect);
    expect('aim' in j.lightning).toBe(false);
    expect('at' in j.splash).toBe(false);
    expect('fillBands' in j).toBe(false);
  });

  it('sends an aim, a placing and bands filling the cuts only when set', () => {
    const rect = { x: 0, y: 0, w: 10, h: 10 };
    const aimed = specialJob(style({ special: { lightning: { ...ON.lightning, aim: 'point', x: 25, y: 75, angle: 90 } } }), rect);
    // The dial's 90 is up: the engine's heading is clockwise, so -90.
    expect(aimed.lightning.aim).toEqual({ x: 0.25, y: 0.75, angle: -Math.PI / 2 });
    const placed = specialJob(style({ special: { splash: { ...ON.splash, x: 20, y: 40, spread: 30 } } }), rect);
    expect(placed.splash.at).toEqual({ x: 0.2, y: 0.4, spread: 0.3 });
    expect(specialJob(style({ special: { crack: ON.crack, bandOutline: 'fills-cuts' } }), rect).fillBands).toBe(true);
    // Only with cuts.
    expect('fillBands' in specialJob(style({ special: { lightning: ON.lightning, bandOutline: 'fills-cuts' } }), rect)).toBe(false);
  });
});

describe('the glyph wire (v18)', () => {
  const job = { runs: [{ text: 'HI', x: 0, y: 40 }], bands: [], fill: { kind: 'solid', color: '#000' } };
  const req = (j) => ({ job: j, font: 0, size: 40, width: 10, height: 10 });
  const rect = { x: 0, y: 0, w: 100, h: 60 };
  const crack = { amount: 0.5, size: 1, x: 0.5, y: 0.5, spread: 1, seed: 2 };
  const bolt = { amount: 0.5, core: '#ffffff', glow: '#0000ff', glowSize: 1, seed: 1 };
  const splash = { amount: 0.5, size: 1, color: '#ff0000', seed: 1 };
  const kindsOf = (b, tail) => b.readUInt32LE(b.length - tail - 4);

  it('kind 64: bands fill the cuts, no payload, only with cuts', () => {
    const none = Buffer.from(encodeJob(req({ ...job, special: { rect, crack } })));
    const fills = Buffer.from(encodeJob(req({ ...job, special: { rect, crack, fillBands: true } })));
    expect(fills.length).toBe(none.length);
    expect(kindsOf(fills, 8 * 5 + 4)).toBe(1 | 64);
    expect(() => encodeJob(req({ ...job, special: { rect, lightning: bolt, fillBands: true } }))).toThrow(/crack or scratches/);
  });

  it('kind 128: an aimed lightning, x, y and angle after its seed', () => {
    const across = Buffer.from(encodeJob(req({ ...job, special: { rect, lightning: bolt } })));
    const aimed = Buffer.from(encodeJob(req({ ...job, special: { rect, lightning: { ...bolt, aim: { x: 0.25, y: 0.5, angle: 1 } } } })));
    expect(aimed.length).toBe(across.length + 24);
    expect(aimed.readDoubleLE(across.length)).toBe(0.25);
    expect(aimed.readDoubleLE(across.length + 16)).toBe(1);
    expect(kindsOf(aimed, 24 + 8 + 4 + 4 + 8 + 4)).toBe(2 | 128);
  });

  it('kind 256: a placed splash, x, y and spread after its seed', () => {
    const even = Buffer.from(encodeJob(req({ ...job, special: { rect, splash } })));
    const placed = Buffer.from(encodeJob(req({ ...job, special: { rect, splash: { ...splash, at: { x: 0.1, y: 0.2, spread: 0.3 } } } })));
    expect(placed.length).toBe(even.length + 24);
    expect(placed.readDoubleLE(even.length + 16)).toBe(0.3);
    expect(() => encodeJob(req({ ...job, special: { rect, splash: { ...splash, at: { x: 2, y: 0, spread: 0 } } } }))).toThrow(/splash x/);
  });
});

describe('painted (fix round 1)', () => {
  const k0 = () => defaultStyle().strokeEffects[0];
  // The text's own outline: an Outside stroke is a glyph band.
  const band = () => ({ strokeEffects: [{ ...k0(), on: true, size: 5, opacity: 1, color: '#000000', position: 'outside' }] });
  const ink = (t) => { let n = 0; for (let i = 3; i < t.data.length; i += 4) n += t.data[i]; return n; };
  // The ink's middle, box-local x.
  const middleX = (t) => {
    let sx = 0, n = 0;
    for (let j = 0; j < t.height; j++) for (let i = 0; i < t.width; i++) {
      const k = (j * t.width + i) * 4;
      // Red is the letters; the splash and bolts paint in other colours.
      const a = t.data[k + 3];
      if (a > 0 && !(t.data[k] > 200 && t.data[k + 1] < 60 && t.data[k + 2] < 60)) { sx += i; n++; }
    }
    return sx / n;
  };

  it('a text outline fills the cuts or is cut through, cut through by default, as before', () => {
    for (const kind of ['crack', 'scratches']) {
      const look = (bandOutline) => ({ ...band(), special: { [kind]: ON[kind], ...(bandOutline ? { bandOutline } : {}) } });
      const before = texture(boxOf(look(null)));
      const through = texture(boxOf(look('cut-through')));
      const fills = texture(boxOf(look('fills-cuts')));
      expect(same(before, through), kind).toBe(true);
      expect(same(fills, through), kind).toBe(false);
      // Filled, the outline lays ink in the cuts.
      expect(ink(fills), kind).toBeGreaterThan(ink(through));
      // And never past where the outline reaches.
      expect([fills.width, fills.height]).toEqual([through.width, through.height]);
    }
    // Without an outline the choice changes nothing.
    const bare = (bandOutline) => texture(boxOf({ special: { crack: ON.crack, bandOutline } }));
    expect(same(bare('fills-cuts'), bare('cut-through'))).toBe(true);
  });

  it('the filled cuts are in the outline colour, on the letters only', () => {
    const look = (bandOutline) => ({ ...band(), special: { crack: { ...ON.crack, amount: 60 }, bandOutline } });
    const through = texture(boxOf(look('cut-through')));
    const fills = texture(boxOf(look('fills-cuts')));
    let added = 0, black = 0;
    for (let i = 0; i < fills.data.length; i += 4) {
      if (fills.data[i + 3] > through.data[i + 3] + 64) {
        added++;
        black += fills.data[i] < 40 && fills.data[i + 1] < 40 && fills.data[i + 2] < 40;
      }
    }
    expect(added).toBeGreaterThan(50);
    expect(black / added).toBeGreaterThan(0.9);
  });

  it('a lightning across is the first-built one wherever x, y and angle stand; aimed, each direction its own picture', () => {
    const at = (over) => texture(boxOf({ special: { lightning: { ...ON.lightning, ...over } } }));
    expect(same(at({}), at({ x: 80, y: 10, angle: 45 }))).toBe(true);
    const dirs = [0, 90, -135].map((angle) => at({ aim: 'point', x: 50, y: 50, angle }));
    expect(same(dirs[0], dirs[1])).toBe(false);
    expect(same(dirs[1], dirs[2])).toBe(false);
    expect(same(dirs[0], at({}))).toBe(false);
    // From the left middle, heading right, the bolts lie right of the start.
    const right = at({ aim: 'point', x: 0, y: 50, angle: 0 });
    const left = at({ aim: 'point', x: 100, y: 50, angle: 180 });
    expect(same(right, left)).toBe(false);
  });

  it('a splash spread over the box is the first-built one wherever it lands; pulled in, it lands where it is put', () => {
    const at = (over) => texture(boxOf({ special: { splash: { ...ON.splash, ...over } } }));
    expect(same(at({}), at({ x: 5, y: 95 }))).toBe(true);
    const left = at({ x: 10, y: 50, spread: 20 });
    const right = at({ x: 90, y: 50, spread: 20 });
    expect(same(left, right)).toBe(false);
    expect(middleX(left)).toBeLessThan(middleX(right));
  });

  it('a crack at two origins: each its own picture', () => {
    const at = (x) => texture(boxOf({ special: { crack: { ...ON.crack, x, y: 50, spread: 40 } } }));
    expect(same(at(15), at(85))).toBe(false);
  });
});

describe('the handles', () => {
  const box = { w: 200, h: 100 };
  it('state a crack in the letters, the others in the box', () => {
    const ink = { x0: 20, y0: 30, x1: 120, y1: 70 };
    expect(handleFrame('crack', box, ink)).toEqual({ x: 20, y: 30, w: 100, h: 40 });
    expect(handleFrame('crack', box, null)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(handleFrame('splash', box, ink)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    const f = handleFrame('crack', box, ink);
    expect(handlePoint({ x: 50, y: 50 }, f)).toEqual({ x: 70, y: 50 });
    expect(handlePercents({ x: 500, y: -9 }, f)).toEqual({ x: 100, y: 0 });
  });

  it('a drag sets x and y, pulls a spread-out crack or splash in, and aims a lightning', () => {
    const f = handleFrame('splash', box, null);
    const sp = { x: 50, y: 50, spread: 100 };
    dragHandle('splash', sp, { x: 50, y: 25 }, f);
    expect(sp).toEqual({ x: 25, y: 25, spread: 50 });
    const kept = { x: 50, y: 50, spread: 30 };
    dragHandle('crack', kept, { x: 100, y: 50 }, f);
    expect(kept.spread).toBe(30);
    const bolt = { aim: 'across', x: 0, y: 50, angle: 0 };
    dragHandle('lightning', bolt, { x: 20, y: 10 }, f);
    expect(bolt).toMatchObject({ aim: 'point', x: 10, y: 10 });
    // The arm: 90 is up, as the dial reads it.
    dragArm(bolt, { x: 20, y: 10 }, { x: 20, y: -30 });
    expect(bolt.angle).toBe(90);
    const end = armEnd(bolt, { x: 20, y: 10 }, 10);
    expect(end.x).toBeCloseTo(20);
    expect(end.y).toBeCloseTo(0);
  });

  it('the Outline row reads the outlines there', () => {
    const st = (special) => ({ special });
    expect(outlineKinds(st({}), false, false).any).toBe(false);
    expect(outlineKinds(st({}), true, false).current).toBe('cut-through');
    expect(outlineKinds(st({}), false, true).current).toBe('fills-cuts');
    expect(outlineKinds(st({}), true, true)).toMatchObject({ any: true, both: true, band: 'cut-through', stroke: 'fills-cuts' });
    expect(outlineKinds(st({ outline: 'cut-through', bandOutline: 'fills-cuts' }), true, true)).toMatchObject({ band: 'fills-cuts', stroke: 'cut-through' });
    expect(outlineKinds(st({}), true, false).both).toBe(false);
  });
});
