import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { rustEngine, FIXTURE_FACES } from '../test/rust-engine.js';
import { textEngine, setTextEngine, setGlyphPainter, glyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeSfx, normalizeStyle } from './data.js';
import { placeBlock, curvedStyle, isAutoBox, boxInkRect } from './contain.js';
import { glyphJob } from './exporter.js';
import { sfxAvailable, sfxLayout, sfxKinds, sfxPick, sfxPlacement, applySfxKind, clearSfx } from './sfx.js';

// ===========================================================================
// SFX lettering against the real Rust engine
// ===========================================================================
// The unit lane (sfx.test.js) pins the JS side against an engine of arithmetic;
// this is the same seam with the real one: the twelve sound types the wasm
// gives, their layout carried through `placeBlock`, and a box painted with it.
//
// Needs a wasm built with `sfxPlace` (npm run build:engine). One that lacks it
// fails the first test, saying so, rather than skipping.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const defaultEngine = textEngine();
const defaultPainter = glyphPainter();
let rust;
beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  for (const [family, , file] of FIXTURE_FACES) {
    GlobalFonts.registerFromPath(fileURLToPath(new URL(`../test/fonts/${file}`, import.meta.url)), family);
  }
  rust = await rustEngine();
});
afterEach(() => {
  setTextEngine(defaultEngine);
  setGlyphPainter(defaultPainter);
  clearLayoutMemo();
});
afterAll(() => {
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});

const style = (over = {}) => ({ ...defaultStyle(), font: 'Bangers', size: 40, strokes: [], lineHeight: 1.1, ...over });
const typed = (id, over = {}) => {
  const s = style(over);
  if (!applySfxKind(s, id)) throw new Error(`the engine has no "${id}" type`);
  return s;
};
const cand = (s, text = 'BOOM') => ({ x: 0, y: 0, w: 500, h: 200, style: s, text, fit: null });
const use = () => {
  setTextEngine(rust);
  clearLayoutMemo();
};

describe('the engine behind the SFX seam', () => {
  it('has the sound-type calls, and twelve types', () => {
    expect(rust.sfxPlace, 'this wasm has no sfxPlace: run npm run build:engine').toBeTypeOf('function');
    use();
    expect(sfxAvailable()).toBe(true);
    const kinds = sfxKinds();
    expect(kinds).toHaveLength(12);
    expect(new Set(kinds.map((k) => k.id)).size).toBe(12);
    for (const k of kinds) {
      expect(['h', 'v'], k.id).toContain(k.dir);
      expect(k.look.fill.type, k.id).toBeTruthy();
      expect(Array.isArray(k.look.outlines), k.id).toBe(true);
    }
  });

  it('ranks every type for a sound, best first', () => {
    use();
    const pick = sfxPick('BOOM!!');
    expect([...pick.order].sort()).toEqual(sfxKinds().map((k) => k.id).sort());
    expect(pick.scores).toHaveLength(12);
    expect(pick.strength).toBeGreaterThan(0);
  });
});

describe('placeBlock with the real engine', () => {
  it('lays every type out, finite, a letter per drawn code point', () => {
    use();
    for (const k of sfxKinds()) {
      const s = typed(k.id);
      const p = placeBlock(cand(s, 'BOOM!'));
      expect(p.isCurve, k.id).toBe(true);
      expect(p.layout, k.id).toHaveLength(5);
      for (const g of p.layout) {
        for (const f of ['x', 'y', 'rot', 'sx', 'sy', 'skew', 'w', 'em', 'pen']) expect(Number.isFinite(g[f]), `${k.id} ${g.ch} ${f}`).toBe(true);
      }
      expect(curvedStyle(s)).toBe(true);
      expect(isAutoBox(cand(s))).toBe(false);
    }
  });

  it('gives each line its own group, and what draws nothing an empty entry', () => {
    use();
    const l = sfxLayout('DO\nKA', typed('impact'), 40);
    expect(l.map((g) => g.ch)).toEqual(['D', 'O', '', 'K', 'A']);
    expect(l[0].group).toBe(0);
    expect(l[3].group).toBe(1);
  });

  it('does not move on a second call, and moves for a new seed', () => {
    use();
    const s = typed('rumble');
    const a = sfxLayout('BOOM', s, 40);
    expect(sfxLayout('BOOM', s, 40)).toEqual(a);
    s.sfx.seed = 2;
    expect(sfxLayout('BOOM', s, 40)).not.toEqual(a);
  });

  it('follows a path the box gives, and a hand edit of one letter', () => {
    use();
    const s = typed('impact');
    const before = sfxPlacement('BOOM', s, 40);
    expect(before.paths.length).toBeGreaterThan(0);
    s.sfx.paths = [{ a: [-2, 1], b: [2, -1], bend: 0 }];
    const tilted = sfxPlacement('BOOM', s, 40);
    expect(tilted.paths[0]).toEqual({ a: [-2, 1], b: [2, -1], bend: 0 });
    expect(tilted.letters[3].y).toBeLessThan(tilted.letters[0].y);
    s.sfx.glyphs = { '0:1': { dx: 1, dy: 0, rot: 0, s: 1 } };
    const moved = sfxPlacement('BOOM', s, 40);
    // An edit is in the letter's own ems (its `em`), not the face's.
    expect(Math.abs(moved.letters[1].x - tilted.letters[1].x - moved.letters[1].em)).toBeLessThan(0.05 * moved.letters[1].em);
    expect(moved.letters[2]).toEqual(tilted.letters[2]);
  });

  it('opens a box of the old SFX as the closest type and lays it out', () => {
    use();
    const s = normalizeStyle({ ...style(), sfx: { on: true, amount: 1, seed: 5, flow: 'row', rowShift: 0, moves: [{ kind: 'grow', a: 1, b: 0 }] } });
    expect(s.sfx.kind).toBe('impact');
    expect(placeBlock(cand(s)).isCurve).toBe(true);
  });

  it('is the plain block once SFX is removed', () => {
    use();
    const s = typed('slash');
    clearSfx(s);
    expect(placeBlock(cand(s)).isCurve).toBe(false);
    expect(normalizeSfx(s.sfx).on).toBe(false);
  });
});

function inkBox(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 128) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

describe('a painted SFX box', () => {
  // The job `renderBoxTexture` would hand the painter, from `placeBlock`'s own
  // place, painted by the Rust painter onto a canvas.
  function painted(s, text) {
    use();
    const c = cand(s, text);
    const p = placeBlock(c);
    const L = p.isCurve
      ? { s, ox: 0, oy: 0, isCurve: true, layout: p.layout }
      : { s, ox: 0, oy: 0, isCurve: false, lines: p.lines, lineX: p.lineX, blockY: p.blockY, lineH: p.lineH, baseY: p.baseY };
    const canvas = createCanvas(500, 200);
    createRustGlyphPainter(rust).paint(canvas.getContext('2d'), glyphJob({ w: 500, h: 200 }, L));
    return inkBox(canvas);
  }

  it('paints every type, with ink', () => {
    use();
    for (const k of sfxKinds()) expect(painted(typed(k.id), 'BOOM'), k.id).not.toBeNull();
  });

  it('is painted inside what boxInkRect says it covers', () => {
    for (const id of ['impact', 'explosion', 'small']) {
      use();
      const s = typed(id);
      const ink = painted(s, 'BOOM');
      const r = boxInkRect(cand(s, 'BOOM'));
      expect(ink.x0, id).toBeGreaterThanOrEqual(Math.floor(r.x) - 1);
      expect(ink.x1, id).toBeLessThanOrEqual(Math.ceil(r.x + r.w) + 1);
      expect(ink.y0, id).toBeGreaterThanOrEqual(Math.floor(r.y) - 1);
      expect(ink.y1, id).toBeLessThanOrEqual(Math.ceil(r.y + r.h) + 1);
    }
  });
});
