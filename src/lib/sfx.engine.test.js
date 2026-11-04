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
import {
  sfxAvailable, sfxLayout, sfxKinds, sfxPick, sfxPlacement, applySfxKind, clearSfx, sfxResolved, sfxParams,
  sfxHit, sfxTurn, sfxScale, sfxMove, sfxBendFor, sfxCurve, bendHandle, sfxOutline,
} from './sfx.js';

// ===========================================================================
// SFX lettering against the real Rust engine
// ===========================================================================
// The unit lane (sfx.test.js) pins the JS side against an engine of arithmetic;
// this is the same seam with the real one: the sound types the wasm
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
  it('has the sound-type calls, and nineteen types', () => {
    expect(rust.sfxPlace, 'this wasm has no sfxPlace: run npm run build:engine').toBeTypeOf('function');
    use();
    expect(sfxAvailable()).toBe(true);
    const kinds = sfxKinds();
    expect(kinds).toHaveLength(19);
    expect(new Set(kinds.map((k) => k.id)).size).toBe(19);
    for (const k of kinds) {
      expect(['h', 'v'], k.id).toContain(k.dir);
      // A type is a layout only.
      expect(k.look, k.id).toBe(undefined);
    }
  });

  it('ranks every type for a sound, best first', () => {
    use();
    const pick = sfxPick('BOOM!!');
    expect([...pick.order].sort()).toEqual(sfxKinds().map((k) => k.id).sort());
    expect(pick.scores).toHaveLength(19);
    for (const m of ['power', 'rough', 'momentum']) {
      expect(pick[m], m).toBeGreaterThanOrEqual(0);
      expect(pick[m], m).toBeLessThanOrEqual(100);
    }
  });

  it('resolves what the box leaves null from the type, moved by the macros', () => {
    use();
    const s = typed('impact');
    const impact = sfxKinds().find((k) => k.id === 'impact');
    const r = sfxResolved(s.sfx);
    expect(r).toMatchObject({ vertical: false, follow: impact.follow, gap: impact.gap, flow: impact.flow, bigTighter: 0.5 });
    s.sfx.power = 100;
    expect(Math.round(sfxResolved(s.sfx).flow.from * 100)).toBe(64);
    s.sfx.gap = 0.4;
    expect(sfxResolved(s.sfx).gap).toBe(0.4);
    // The layout reads the same numbers.
    expect(sfxParams(s.sfx).gap).toBe(0.4);
    expect(sfxResolved(typed('small').sfx).vertical).toBe(true);
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
    expect(tilted.paths[0]).toMatchObject({ a: [-2, 1], b: [2, -1], bend: 0, ctrl: [0, 0], mid: [0, 0] });
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

describe('the handles against the real engine', () => {
  it('hits each letter by its ink quad and turns, scales, moves and bends by the engine', () => {
    use();
    const s = typed('impact');
    const p = sfxPlacement('BOOM', s, 40);
    const { letters, paths } = p;
    expect(p.cp).toEqual([0, 1, 2, 3]);
    letters.forEach((l, i) => {
      expect(l.quad).toHaveLength(4);
      expect(sfxHit(letters, l.centre[0], l.centre[1])).toBe(i);
    });
    expect(sfxHit(letters, 1e5, 1e5)).toBe(-1);
    // Blender style: the total keeps counting, what is stored wraps.
    const t = sfxTurn([0, 0], [10, 0], [0, 10], 170);
    expect(t.total).toBeCloseTo(260, 9);
    expect(t.shown).toBe(-100);
    expect(sfxTurn([0, 0], [10, 0], [10, 1], 0, 15).shown).toBe(0);
    expect(sfxScale([0, 0], [10, 0], [20, 0], 1)).toBe(2);
    expect(sfxScale([0, 0], [10, 0], [100, 0], 1)).toBe(5);
    const l = letters[1];
    expect(sfxMove(l, [0, 0], [l.unit / 2, 0], 0, 0)).toEqual([0.5, 0]);
    // The bend handle sits on the curve's middle, and dragging it there
    // keeps the bend.
    const q = paths[0];
    expect(sfxCurve(q)).toEqual({ ctrl: q.ctrl, mid: q.mid });
    expect(bendHandle(q)).toEqual(q.mid);
    expect(sfxBendFor(q, q.mid)).toBeCloseTo(q.bend, 3);
  });

  it('a hand edit moves the letter by its unit, and its outline goes with it', () => {
    use();
    const s = typed('impact');
    const before = sfxPlacement('BOOM', s, 40).letters[1];
    s.sfx.glyphs = { '0:1': { dx: 1, dy: 0, rot: 0, s: 2 } };
    const after = sfxPlacement('BOOM', s, 40).letters[1];
    expect(after.unit * 2).toBeCloseTo(after.em, 9);
    expect(Math.abs(after.x - before.x - after.unit)).toBeLessThan(0.05 * after.unit);
    const d = sfxOutline('BOOM', s, 40, 1);
    // An O: two closed contours, round the moved letter.
    expect(d.match(/M/g)).toHaveLength(2);
    const xs = [...d.matchAll(/[ML](-?[\d.]+) /g)].map((m) => +m[1]);
    expect(Math.min(...xs)).toBeLessThan(after.x);
    expect(Math.max(...xs)).toBeGreaterThan(after.x);
    expect(sfxOutline('BOOM', s, 40, 9)).toBe('');
  });
});
