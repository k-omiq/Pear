import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { glyphJob } from './exporter.js';
import { boxCandidate, placeBlock } from './contain.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { applySfxKind } from './sfx.js';

// ===========================================================================
// An SFX trail under a wobble: the engine numbers the afterimages in blocks
// of one count behind each letter, in the letters' order, so the writer must
// give every letter that is a run its block - a letter that cannot trail
// gets copies that draw nothing - or the next letters' copies take the
// wrong letter's move.
// ===========================================================================

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  const rust = await rustEngine();
  setTextEngine(rust);
  setGlyphPainter(createRustGlyphPainter(rust));
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

const COUNT = 3;
function trailBox() {
  const style = normalizeStyle({ ...defaultStyle(), strokeEffects: [], font: 'Bangers', size: 90, strokes: [], autoHeight: false, shape: 'off' });
  const box = { id: 'b', lineN: null, text: 'BOOM', x: 50, y: 50, w: 260, h: 140, style };
  if (!applySfxKind(box.style, 'explosion')) throw new Error('the engine has no "explosion" type');
  box.style.trail = { on: true, count: COUNT, dist: 0.4 };
  box.style.wobble = { on: true, amount: 40, tilt: 25, seed: 11 };
  return box;
}
const layoutOf = (box) => ({ ...placeBlock(boxCandidate(box, box.text)), ox: 200, oy: 160 });
const letters = (job) => job.runs.filter((r) => !r.ghost);
const ghosts = (job) => job.runs.filter((r) => r.ghost);
function bytes(job) {
  const c = createCanvas(600, 420);
  glyphPainter().paint(c.getContext('2d'), job);
  return Buffer.from(c.getContext('2d').getImageData(0, 0, 600, 420).data);
}

describe('the afterimages of a wobbled trail', () => {
  it('every letter has its block of copies, in the letters\' order', () => {
    const box = trailBox();
    const job = glyphJob(box, layoutOf(box));
    const ls = letters(job);
    expect(ls.length).toBe(4);
    expect(ghosts(job).map((g) => g.text)).toEqual(ls.flatMap((l) => Array(COUNT).fill(l.text)));
  });

  it('a letter that cannot trail keeps its block, drawing nothing, and the others wobble as their own letters', () => {
    const box = trailBox();
    const L = layoutOf(box);
    // The second letter with no path to go back along.
    const at = L.layout.findIndex((g, i) => g.ch && i > 0);
    const stuck = { ...L, layout: L.layout.map((g, i) => (i === at ? { ...g, em: 0 } : g)) };
    const job = glyphJob(box, stuck);
    const gs = ghosts(job);
    expect(gs.length).toBe(COUNT * letters(job).length);
    const mine = gs.slice(COUNT, 2 * COUNT);
    for (const g of mine) expect(g.fill.color.endsWith('00')).toBe(true);
    // The same as the trail laid in full with that letter's copies made
    // invisible: the visible copies take the same moves.
    const full = glyphJob(box, L);
    const hidden = { ...full, runs: full.runs.map((r, i) => (i >= COUNT && i < 2 * COUNT ? { ...r, fill: { kind: 'solid', color: '#88888800' } } : r)) };
    expect(bytes(job).equals(bytes(hidden))).toBe(true);
    // Dropping that block instead, as the writer once did, moves the others.
    const dropped = { ...hidden, runs: hidden.runs.filter((_, i) => i < COUNT || i >= 2 * COUNT) };
    expect(bytes(dropped).equals(bytes(hidden))).toBe(false);
  });
});
