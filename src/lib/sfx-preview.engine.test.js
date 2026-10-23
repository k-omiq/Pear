import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { rustEngine, FIXTURE_FACES } from '../test/rust-engine.js';
import { textEngine, setTextEngine, setGlyphPainter, glyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { sfxKinds, applySfxKind } from './sfx.js';
import { renderBoxTexture } from './exporter.js';
import { cardSpec, cardKey, cardKeys, cardText, cardStyle, paintCard, paintStage, CARD_W, CARD_H } from './sfx-preview.js';

// ===========================================================================
// The SFX panel's pictures, painted by the real engine
// ===========================================================================
// The panel's own cases (SfxPanel.dom.test.js) stand the painters in. This is
// the painter: a card for every sound type, the variations and the stage,
// through the exporter's texture, on a real canvas, read back as pixels - and
// the ink rectangle the painter hands back, which the previews cut to
// instead of scanning the pixels.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const defaultEngine = textEngine();
const defaultPainter = glyphPainter();
let rust;
let painter;
beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  for (const [family, , file] of FIXTURE_FACES) {
    GlobalFonts.registerFromPath(fileURLToPath(new URL(`../test/fonts/${file}`, import.meta.url)), family);
  }
  rust = await rustEngine();
  setTextEngine(rust);
  painter = createRustGlyphPainter(rust);
  setGlyphPainter(painter);
  clearLayoutMemo();
});
afterEach(() => {
  setGlyphPainter(painter);
  clearLayoutMemo();
});
afterAll(() => {
  setTextEngine(defaultEngine);
  setGlyphPainter(defaultPainter);
  clearLayoutMemo();
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 40, ...over });
const sfxStyle = (kind = 'impact', over = {}) => {
  const st = style(over);
  applySfxKind(st, kind);
  return st;
};

// Where a canvas's pixels are inked (alpha over 0), scanned: what the
// previews used to do every paint, and the check on what the painter says.
function scan(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const { data } = canvas.getContext('2d').getImageData(0, 0, w, h);
  let n = 0;
  let x0 = w;
  let x1 = -1;
  let y0 = h;
  let y1 = -1;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++)
      if (data[(j * w + i) * 4 + 3] > 0) {
        n++;
        x0 = Math.min(x0, i);
        x1 = Math.max(x1, i);
        y0 = Math.min(y0, j);
        y1 = Math.max(y1, j);
      }
  return { n, x0, y0, x1, y1 };
}

// How many pixels of a PNG data URL are inked, and where the ink spans.
async function ink(url) {
  const img = await loadImage(url);
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return { ...scan(c), width: img.width, height: img.height };
}

const box = (st, text = 'BOOM', w = 240, h = 90) => ({ id: 't', lineN: null, text, x: 0, y: 0, w, h, fit: null, style: st });

// The painter's surface sizes, for what a paint costs in pixels.
function countingPainter() {
  const seen = [];
  setGlyphPainter({
    ...painter,
    paintBox(ctx, spec) {
      seen.push(ctx.canvas.width * ctx.canvas.height);
      return painter.paintBox(ctx, spec);
    },
  });
  return seen;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function timed(fn, n = 15) {
  fn();
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn();
    out.push(performance.now() - t);
  }
  return median(out);
}

describe('the ink rectangle the painter hands back', () => {
  it('is exactly the inked pixels, for plain type, SFX, outlines, shadows and a caption', () => {
    const cases = {
      plain: style(),
      sfx: sfxStyle('explosion'),
      outlined: sfxStyle('impact', { strokes: [{ color: '#ffffff', width: 6, opacity: 1 }, { color: '#000000', width: 3, opacity: 1 }] }),
      shadow: style({ shadows: [{ x: 6, y: 9, blur: 4, color: '#000000', opacity: 0.6 }] }),
      caption: (() => {
        const st = sfxStyle('rumble');
        st.sfx.caption.text = 'rumble';
        return st;
      })(),
    };
    for (const [name, st] of Object.entries(cases)) {
      const tex = renderBoxTexture(box(st), undefined, undefined, 1.5);
      expect(tex.ink, name).toBeTruthy();
      const s = scan(tex.canvas);
      expect(s.n, name).toBeGreaterThan(50);
      // The painter's raster is cut to what it inks: its rectangle holds every
      // inked pixel, and each of its four edges touches one.
      expect([tex.ink.x, tex.ink.y, tex.ink.x + tex.ink.w - 1, tex.ink.y + tex.ink.h - 1], name).toEqual([s.x0, s.y0, s.x1, s.y1]);
      tex.canvas.width = 0;
    }
  });

  it('is null where the canvas painted part of the box (hand-drawn ink)', () => {
    const st = style({ ink: { on: true, strokes: [{ tool: 'brush', color: '#000000', size: 4, opacity: 1, pts: [[0, 0], [40, 40]] }] } });
    const tex = renderBoxTexture(box(st), undefined, undefined, 1);
    expect(tex.ink ?? null).toBe(null);
  });
});

describe('a type card', () => {
  it('is painted for every sound type, inside its tile, with ink in it', async () => {
    const kinds = sfxKinds();
    expect(kinds).toHaveLength(12);
    const spec = cardSpec(style(), 'BOOM');
    for (const k of kinds) {
      const url = paintCard(spec, { kind: k.id, seed: 1 }, 1);
      expect(url, k.id).toMatch(/^data:image\/png;base64,/);
      const r = await ink(url);
      expect([r.width, r.height]).toEqual([CARD_W, CARD_H]);
      expect(r.n, k.id).toBeGreaterThan(20);
      // Cut to its ink and contained: nothing touches the tile's edge.
      expect(r.x0, k.id).toBeGreaterThan(0);
      expect(r.y0, k.id).toBeGreaterThan(0);
      expect(r.x1, k.id).toBeLessThan(CARD_W - 1);
      expect(r.y1, k.id).toBeLessThan(CARD_H - 1);
      // And it fills it: one side of the ink reaches the tile's padding.
      expect(Math.max((r.x1 - r.x0 + 1) / CARD_W, (r.y1 - r.y0 + 1) / CARD_H), k.id).toBeGreaterThan(0.75);
    }
  });

  it('differs from one type to the next', () => {
    const spec = cardSpec(style(), 'BOOM');
    const urls = new Set(sfxKinds().map((k) => paintCard(spec, { kind: k.id, seed: 1 }, 1)));
    expect(urls.size).toBeGreaterThan(6);
  });

  it("is the type's layout in the box's own look: colour and outlines kept", () => {
    const st = cardStyle(cardSpec(style({ color: '#ff0000', strokes: [{ color: '#00ff00', width: 4, opacity: 1 }] }), 'BOOM'), { kind: 'explosion', seed: 7 });
    expect(st.sfx.on).toBe(true);
    expect(st.sfx.kind).toBe('explosion');
    expect(st.sfx.seed).toBe(7);
    expect(st.color).toBe('#ff0000');
    expect(st.strokes[0].color).toBe('#00ff00');
  });

  it('is the type as a click leaves the box: no paths, no hand edits, the numbers and dials the type gives', () => {
    const was = sfxStyle('impact');
    Object.assign(was.sfx, { gap: 0.9, slant: 30, power: 90, rough: 10, momentum: 80, paths: [{ a: [-2, 0], b: [2, 1], bend: 0.3 }], glyphs: { '0:0': { dx: 1, dy: 0, rot: 20, s: 1 } } });
    const st = cardStyle(cardSpec(was, 'BOOM'), { kind: 'rumble', seed: 1 });
    expect(st.sfx.paths).toEqual([]);
    expect(st.sfx.glyphs).toEqual({});
    expect(st.sfx.gap).toBe(null);
    expect(st.sfx.slant).toBe(null);
    for (const d of ['power', 'rough', 'momentum']) if (d in st.sfx) expect(st.sfx[d], d).toBe(50);
  });

  it("has a key that holds the box's look and text, and none of its layout", () => {
    const key = (st, text = 'BOOM') => cardKey(cardSpec(st, text), { kind: 'impact', seed: 1 }, 0, 1);
    expect(key(style({ color: '#ff0000' }))).not.toBe(key(style({ color: '#000000' })));
    expect(key(style())).not.toBe(key(style(), 'BAM'));
    expect(key(style())).not.toBe(key(style({ font: 'Comic Neue' })));
    // The layout is the type's: the box's own type, numbers, dials, paths and
    // hand edits are not in it.
    const moved = sfxStyle('impact');
    Object.assign(moved.sfx, { kind: 'slash', gap: 0.5, power: 80, paths: [{ a: [0, 0], b: [1, 1], bend: 0 }], glyphs: { '0:1': { dx: 1, dy: 0, rot: 0, s: 1 } } });
    expect(key(moved)).toBe(key(sfxStyle('impact')));
  });

  it('paints at twice the pixels on a dense screen', async () => {
    const r = await ink(paintCard(cardSpec(style(), 'BAM'), { kind: 'impact', seed: 1 }, 2));
    expect([r.width, r.height]).toEqual([CARD_W * 2, CARD_H * 2]);
  });
});

describe('a variation', () => {
  it('is the box sound with another seed', async () => {
    const spec = cardSpec(sfxStyle('explosion'), 'BOOM');
    const one = paintCard(spec, { seed: 1 }, 1);
    const two = paintCard(spec, { seed: 2 }, 1);
    expect(one).toMatch(/^data:image\/png;base64,/);
    expect((await ink(one)).n).toBeGreaterThan(20);
    // Explosion jitters: two seeds are two shapes.
    expect(one).not.toBe(two);
  });

  it('has a key that holds the layout, dials, paths and hand edits, and not the caption', () => {
    const vkey = (st) => cardKey(cardSpec(st, 'BOOM'), { kind: null, seed: 1 }, 0, 1);
    const tkey = (st) => cardKey(cardSpec(st, 'BOOM'), { kind: 'drip', seed: 1 }, 0, 1);
    const a = sfxStyle('impact');
    const b = sfxStyle('impact');
    b.sfx.caption.text = 'a note';
    expect(vkey(b)).toBe(vkey(a));
    // A variation is what a click on it leaves the box: its paths and edits.
    b.sfx.paths = [{ a: [-2, 0], b: [2, 1], bend: 0.2 }];
    expect(vkey(b)).not.toBe(vkey(a));
    const e = sfxStyle('impact');
    e.sfx.glyphs = { '0:1': { dx: 0.5, dy: 0, rot: 10, s: 1 } };
    expect(vkey(e)).not.toBe(vkey(a));
    // A type card resets both, so neither is in its key.
    expect(tkey(b)).toBe(tkey(a));
    expect(tkey(e)).toBe(tkey(a));
    const c = sfxStyle('impact');
    c.sfx.gap = 0.4;
    expect(vkey(c)).not.toBe(vkey(a));
    const d = sfxStyle('impact');
    d.sfx.power = 80;
    expect(vkey(d)).not.toBe(vkey(a));
  });

  it('keys every card at once as cardKey keys one', () => {
    const spec = cardSpec(sfxStyle('impact', { color: '#123456' }), 'BOOM');
    const cards = [{ kind: 'impact', seed: 3 }, { kind: 'drip', seed: 3 }, { kind: null, seed: 1 }, { kind: null, seed: 8 }];
    expect(cardKeys(spec, cards, 4, 2)).toEqual(cards.map((c) => cardKey(spec, c, 4, 2)));
  });
});

describe('the card text', () => {
  it('cuts the text to eight code points and falls back to SFX', () => {
    expect(cardText('ABCDEFGHIJ')).toBe('ABCDEFGH');
    // Line breaks count as code points, and a cut that ends on one drops it.
    expect(cardText('GR\nIP!!\nXX')).toBe('GR\nIP!!');
    expect(cardText('ABCDEFG\nHIJ')).toBe('ABCDEFG');
    expect(cardText('')).toBe('SFX');
    expect(cardText('   \n ')).toBe('SFX');
    expect(cardText('😀😀😀😀😀😀😀😀😀')).toBe('😀'.repeat(8));
  });
});

describe('the stage', () => {
  const W = 600;
  const H = 220;
  const grab = (st, text = 'BOOM', hint = null, w = 240, h = 90) => {
    const canvas = createCanvas(W, H);
    const got = paintStage(canvas, { style: st, text, w, h }, 2, hint);
    return { got, canvas, ...scan(canvas) };
  };

  it('paints the box as it is, plain or with a type, cut to its ink and centred', () => {
    const a = grab(style());
    const b = grab(sfxStyle('impact'));
    for (const r of [a, b]) {
      expect(r.got).toBeTruthy();
      expect(r.n).toBeGreaterThan(500);
      // Filled to the padding (20 device px) one way, centred both ways.
      const fillsW = r.x0 <= 22 && r.x1 >= W - 23;
      const fillsH = r.y0 <= 22 && r.y1 >= H - 23;
      expect(fillsW || fillsH).toBe(true);
      expect(Math.abs(r.x0 - (W - 1 - r.x1))).toBeLessThanOrEqual(2);
      expect(Math.abs(r.y0 - (H - 1 - r.y1))).toBeLessThanOrEqual(2);
    }
    expect(a.canvas.toBuffer('image/png').equals(b.canvas.toBuffer('image/png'))).toBe(false);
  });

  it('hands back the ink size in page px, which the next paint fits', () => {
    const st = sfxStyle('rumble');
    const first = grab(st);
    expect(first.got.w).toBeGreaterThan(40);
    expect(first.got.h).toBeGreaterThan(10);
    const again = grab(st, 'BOOM', first.got);
    expect(again.got.w).toBeCloseTo(first.got.w, 0);
    for (const k of ['x0', 'y0', 'x1', 'y1']) expect(Math.abs(again[k] - first[k]), k).toBeLessThanOrEqual(2);
  });

  it('is painted at about the pixels it shows, not at twice the box', () => {
    // A big sound in a big frame: the old stage painted the footprint at
    // 2 x dpr and scanned every pixel of it.
    const st = sfxStyle('impact', { size: 160 });
    const seen = countingPainter();
    const r = grab(st, 'BOOOOM!!', null, 900, 400);
    expect(r.got).toBeTruthy();
    expect(seen.length).toBeGreaterThan(0);
    for (const px of seen) expect(px).toBeLessThan(4 * W * H);
    const hinted = countingPainter();
    grab(st, 'BOOOOM!!', r.got, 900, 400);
    expect(hinted).toHaveLength(1);
    expect(hinted[0]).toBeLessThan(2.5 * W * H);
  });

  it('shows the word SFX for a box with no text', () => {
    const r = grab(style(), '');
    expect(r.got).toBeTruthy();
    expect(r.n).toBeGreaterThan(100);
  });

  it('is quick: a stage-sized paint and no pixel scan', () => {
    const st = sfxStyle('explosion', { size: 120, strokes: [{ color: '#ffffff', width: 8, opacity: 1 }] });
    const canvas = createCanvas(W, H);
    const snap = { style: st, text: 'DOGOOON', w: 600, h: 300 };
    const hint = paintStage(canvas, snap, 2);
    const stage = timed(() => paintStage(canvas, snap, 2, hint));
    const spec = cardSpec(st, 'DOGOOON');
    const card = timed(() => paintCard(spec, { kind: 'impact', seed: 1 }, 2));
    console.info(`sfx-preview: stage ${stage.toFixed(2)} ms, card ${card.toFixed(2)} ms (median of 15, napi canvas)`);
    expect(stage).toBeLessThan(40);
    expect(card).toBeLessThan(20);
  });
});
