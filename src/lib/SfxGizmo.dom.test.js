import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import SfxGizmo, { gizmoUi } from './SfxGizmo.svelte';
import { loadProjectPages, page } from './store.svelte.js';
import { initHistory, resetHistory, undo, history } from './editor/history.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { clearLayoutMemo } from './measure.js';
import { applySfxKind, sfxPlacement, sfxCurve } from './sfx.js';
import { sfxLive } from './sfx-live.svelte.js';
import { domRustEngine } from '../test/dom-rust-engine.js';

// ===========================================================================
// The SFX handles: the reference's letter gizmo and path handles
// (docs/giongo/04-reference-controls.md 2 and 3)
// ===========================================================================
// With the real engine, so the handles sit where the engine put the paths
// and the letters and every number a drag writes is the engine's. The box is
// at the page's origin and the zoom is 1, so a pointer's client px are the
// overlay's px (`toLocal`). Animation frames are run by hand: a drag writes
// the box once a frame.

const original = textEngine();
let rust;
let frames = [];
const runFrames = () => {
  const due = frames;
  frames = [];
  for (const cb of due) cb?.(0);
};
beforeAll(async () => {
  rust = await domRustEngine();
});
afterAll(() => setTextEngine(original));
beforeEach(() => {
  setTextEngine(rust);
  clearLayoutMemo();
  initHistory();
  resetHistory();
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', (id) => {
    frames[id - 1] = null;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  loadProjectPages([]);
  setTextEngine(original);
  sfxLive.on = false;
});

const TEXT = 'BOOM';
function mounted(sfx = {}) {
  const style = normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 40 });
  applySfxKind(style, 'impact');
  Object.assign(style.sfx, sfx);
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [{ id: 'b', lineN: null, text: TEXT, x: 0, y: 0, w: 400, h: 200, style }] }]);
  const box = page().boxes[0];
  const view = render(SfxGizmo, { box, pageId: 1, z: 1, text: TEXT, toLocal: (e) => [e.clientX, e.clientY] });
  return { view, box };
}
const placed = (box) => sfxPlacement(TEXT, box.style, box.style.size);
const q = (view, sel) => view.container.querySelector(sel);
// A letter's centre on the overlay (box px).
const centreOf = (box, i = 0) => {
  const l = placed(box).letters[i];
  return [200 + l.centre[0], 100 + l.centre[1]];
};
const glyph = (box, key = '0:0') => box.style.sfx.glyphs[key];
// The point at `deg` (clockwise from 3 o'clock) on a circle of `r` round `c`.
const round = (c, r, deg) => [c[0] + r * Math.cos((deg * Math.PI) / 180), c[1] + r * Math.sin((deg * Math.PI) / 180)];

let pid = 10;
// A press on `el` at `from`, a move to each of `to` (each in its own frame),
// and the release.
async function drag(el, from, to, { shiftKey = false } = {}) {
  const id = ++pid;
  await fireEvent.pointerDown(el, { button: 0, pointerId: id, clientX: from[0], clientY: from[1] });
  for (const p of to) {
    await fireEvent.pointerMove(document, { pointerId: id, clientX: p[0], clientY: p[1], shiftKey });
    runFrames();
  }
  const last = to.at(-1) ?? from;
  await fireEvent.pointerUp(document, { pointerId: id, clientX: last[0], clientY: last[1] });
  await tick();
}
const click = (el, at) => drag(el, at, []);
// Picks letter `key` by a press on its body.
async function pick(view, box, key = '0:0', i = 0) {
  await click(q(view, `[data-sfx-letter="${key}"]`), centreOf(box, i));
}

describe('the paths', () => {
  it('shows the ends, the end arrow and the bend of the path the engine made', async () => {
    const { view, box } = mounted();
    await tick();
    expect(box.style.sfx.paths).toEqual([]);
    const [p] = placed(box).paths;
    const a = q(view, '[data-sfx-end="0:a"]');
    const b = q(view, '[data-sfx-end="0:b"]');
    expect(+a.getAttribute('cx')).toBeCloseTo(200 + p.a[0] * 40, 3);
    expect(+b.getAttribute('cy')).toBeCloseTo(100 + p.b[1] * 40, 3);
    expect(+a.getAttribute('r')).toBe(7);
    expect(q(view, '.end-arrow')).not.toBe(null);
    // The diamond sits on the curve's middle.
    const [mx, my] = q(view, '[data-sfx-bend="0"]').getAttribute('data-at').split(',').map(Number);
    expect(mx).toBeCloseTo(200 + p.mid[0] * 40, 3);
    expect(my).toBeCloseTo(100 + p.mid[1] * 40, 3);
  });

  it('moves a dragged end by the drag from where it was grabbed, as one undo step', async () => {
    const { view, box } = mounted();
    await tick();
    const [p] = placed(box).paths;
    const end = q(view, '[data-sfx-end="0:b"]');
    // Grabbed a few px off its centre: the end does not jump to the pointer.
    const grab = [200 + p.b[0] * 40 + 4, 100 + p.b[1] * 40 - 3];
    await drag(end, grab, [[grab[0] + 20, grab[1] + 10], [grab[0] + 40, grab[1] + 20]]);
    expect(box.style.sfx.paths).toHaveLength(1);
    expect(box.style.sfx.paths[0].a[0]).toBeCloseTo(p.a[0], 2);
    expect(box.style.sfx.paths[0].b[0]).toBeCloseTo(p.b[0] + 1, 2);
    expect(box.style.sfx.paths[0].b[1]).toBeCloseTo(p.b[1] + 0.5, 2);
    undo();
    expect(page().boxes[0].style.sfx.paths).toEqual([]);
    expect(history.canUndo).toBe(false);
  });

  it('bends by the drag across the chord only, with the diamond on the curve', async () => {
    const { view, box } = mounted({ paths: [{ a: [-2, 0], b: [2, 0], bend: 0 }] });
    await tick();
    const bend = q(view, '[data-sfx-bend="0"]');
    expect(bend.getAttribute('data-at')).toBe('200,100');
    // Along the chord 30 px (ignored), across it 40 px: one em off a chord
    // four ems long at the curve's middle, a bend of 0.5.
    await drag(bend, [203, 101], [[233, 141]]);
    expect(box.style.sfx.paths[0].bend).toBeCloseTo(0.5, 3);
    expect(sfxCurve(box.style.sfx.paths[0]).mid[1]).toBeCloseTo(1, 3);
    expect(sfxCurve(box.style.sfx.paths[0]).mid[0]).toBeCloseTo(0, 3);
  });

  it('records nothing for a press that moved nothing', async () => {
    const { view } = mounted({ paths: [{ a: [-2, 0], b: [2, 0], bend: 0 }] });
    await tick();
    await click(q(view, '[data-sfx-end="0:a"]'), [120, 100]);
    expect(history.canUndo).toBe(false);
  });
});

describe('a letter', () => {
  it('is picked by a press on its body, which shows its outline, the gizmo and the legend', async () => {
    const { view, box } = mounted();
    await tick();
    expect(view.container.querySelectorAll('[data-sfx-letter]')).toHaveLength(4);
    expect(q(view, '[data-sfx-ring]')).toBe(null);
    expect(gizmoUi.letter).toBe(false);
    await pick(view, box);
    expect(q(view, '[data-sfx-ring]')).not.toBe(null);
    expect(q(view, '[data-sfx-scale]')).not.toBe(null);
    expect(q(view, '[data-sfx-arrow="x"]')).not.toBe(null);
    expect(q(view, '[data-sfx-arrow="y"]')).not.toBe(null);
    expect(q(view, '[data-sfx-plane]')).not.toBe(null);
    expect(q(view, '[data-sfx-centre]')).not.toBe(null);
    expect(q(view, '[data-sfx-outline] path').getAttribute('d')).toMatch(/^M/);
    expect(+q(view, '[data-sfx-ring]').getAttribute('r')).toBeCloseTo(104, 6);
    expect(gizmoUi.letter).toBe(true);
    // A press with no travel changed nothing.
    expect(box.style.sfx.glyphs).toEqual({});
    expect(history.canUndo).toBe(false);
  });

  it('moves freely at once from a press on its body, in its own ems', async () => {
    const { view, box } = mounted();
    await tick();
    const l = placed(box).letters[0];
    const c = centreOf(box);
    await drag(q(view, '[data-sfx-letter="0:0"]'), c, [[c[0] + 30, c[1] - 12]]);
    expect(glyph(box).dx).toBeCloseTo(30 / l.unit, 3);
    expect(glyph(box).dy).toBeCloseTo(-12 / l.unit, 3);
    expect(glyph(box).rot).toBe(0);
    expect(glyph(box).s).toBe(1);
    expect(q(view, '[data-sfx-ring]')).not.toBe(null);
    undo();
    expect(page().boxes[0].style.sfx.glyphs).toEqual({});
  });

  it('moves freely by the square and by the centre', async () => {
    const { view, box } = mounted();
    await tick();
    const l = placed(box).letters[1];
    await pick(view, box, '0:1', 1);
    const c = centreOf(box, 1);
    await drag(q(view, '[data-sfx-plane]'), [c[0] + 30, c[1] - 30], [[c[0] + 50, c[1] - 20]]);
    expect(glyph(box, '0:1').dx).toBeCloseTo(20 / l.unit, 3);
    expect(glyph(box, '0:1').dy).toBeCloseTo(10 / l.unit, 3);
    const c2 = centreOf(box, 1);
    await drag(q(view, '[data-sfx-centre]'), c2, [[c2[0] - 20, c2[1] - 10]]);
    expect(box.style.sfx.glyphs['0:1']?.dx ?? 0).toBeCloseTo(0, 2);
    expect(box.style.sfx.glyphs['0:1']?.dy ?? 0).toBeCloseTo(0, 2);
  });

  it('turns by the ring by the angle swept, not to the pointer, and Shift snaps to 15°', async () => {
    const { view, box } = mounted();
    await tick();
    await pick(view, box);
    const c = centreOf(box);
    // Grabbed at -135°, dragged to -75°: 60° clockwise, from a turn of 0.
    await drag(q(view, '[data-sfx-ring]'), round(c, 104, -135), [round(c, 104, -115), round(c, 104, -95), round(c, 104, -75)]);
    expect(glyph(box).rot).toBe(60);
    // Again, from 30° to 90°: the letter does not jump to the grab.
    const c1 = centreOf(box);
    await drag(q(view, '[data-sfx-ring]'), round(c1, 104, 30), [round(c1, 104, 60), round(c1, 104, 90)]);
    expect(glyph(box).rot).toBe(120);
    // 50° more with Shift: 170°, snapped to 165°.
    const c2 = centreOf(box);
    await drag(q(view, '[data-sfx-ring]'), round(c2, 104, 0), [round(c2, 104, 25), round(c2, 104, 50)], { shiftKey: true });
    expect(glyph(box).rot).toBe(165);
  });

  it('sizes by the arm: twice as far from the centre is twice the size', async () => {
    const { view, box } = mounted();
    await tick();
    await pick(view, box);
    const c = centreOf(box);
    const d = 62 * Math.SQRT1_2;
    await drag(q(view, '[data-sfx-scale]'), [c[0] + d, c[1] + d], [[c[0] + 1.5 * d, c[1] + 1.5 * d], [c[0] + 2 * d, c[1] + 2 * d]]);
    expect(glyph(box).s).toBeCloseTo(2, 2);
  });

  it('moves along the screen x only by the sideways arrow, and y only by the up/down one', async () => {
    const { view, box } = mounted();
    await tick();
    const l = placed(box).letters[0];
    await pick(view, box);
    const c = centreOf(box);
    await drag(q(view, '[data-sfx-arrow="x"]'), [c[0] + 50, c[1]], [[c[0] + 80, c[1] + 25]]);
    expect(glyph(box).dx).toBeCloseTo(30 / l.unit, 3);
    expect(glyph(box).dy).toBe(0);
    const c2 = centreOf(box);
    await drag(q(view, '[data-sfx-arrow="y"]'), [c2[0], c2[1] - 50], [[c2[0] + 30, c2[1] - 75]]);
    expect(glyph(box).dx).toBeCloseTo(30 / l.unit, 3);
    expect(glyph(box).dy).toBeCloseTo(-25 / l.unit, 3);
  });

  it('puts back what a part changes on a double press of that part', async () => {
    const { view, box } = mounted({ glyphs: { '0:3': { dx: 0.5, dy: 0.3, rot: 20, s: 1.5 } } });
    await tick();
    await pick(view, box, '0:3', 3);
    const c = () => centreOf(box, 3);
    const twice = async (sel, at) => {
      await click(q(view, sel), at);
      await click(q(view, sel), at);
    };
    await twice('[data-sfx-ring]', round(c(), 104 * 1, -90));
    expect(glyph(box, '0:3')).toEqual({ dx: 0.5, dy: 0.3, rot: 0, s: 1.5 });
    await twice('[data-sfx-scale]', [c()[0] + 44, c()[1] + 44]);
    expect(glyph(box, '0:3')).toEqual({ dx: 0.5, dy: 0.3, rot: 0, s: 1 });
    await twice('[data-sfx-arrow="x"]', [c()[0] + 50, c()[1]]);
    expect(glyph(box, '0:3')).toEqual({ dx: 0, dy: 0.3, rot: 0, s: 1 });
    await twice('[data-sfx-arrow="y"]', [c()[0], c()[1] - 50]);
    expect(box.style.sfx.glyphs).toEqual({});
    // The square, the centre and the body.
    box.style.sfx.glyphs = { '0:3': { dx: 0.5, dy: 0.3, rot: 20, s: 1.5 } };
    await tick();
    await twice('[data-sfx-plane]', [c()[0] + 30, c()[1] - 30]);
    expect(glyph(box, '0:3')).toEqual({ dx: 0, dy: 0, rot: 20, s: 1.5 });
    box.style.sfx.glyphs = { '0:3': { dx: 0.5, dy: 0.3, rot: 20, s: 1.5 } };
    await tick();
    await twice('[data-sfx-centre]', c());
    expect(glyph(box, '0:3')).toEqual({ dx: 0, dy: 0, rot: 20, s: 1.5 });
    await twice('[data-sfx-letter="0:3"]', c());
    expect(box.style.sfx.glyphs).toEqual({});
  });

  it('is no double when the second press is far or late', async () => {
    const { view, box } = mounted({ glyphs: { '0:3': { dx: 0, dy: 0, rot: 20, s: 1 } } });
    await tick();
    await pick(view, box, '0:3', 3);
    const ring = round(centreOf(box, 3), 104, -90);
    await click(q(view, '[data-sfx-ring]'), ring);
    await click(q(view, '[data-sfx-ring]'), [ring[0] + 13, ring[1]]);
    expect(glyph(box, '0:3').rot).toBe(20);
    const now = performance.now();
    const spy = vi.spyOn(performance, 'now');
    spy.mockReturnValue(now + 1000);
    await click(q(view, '[data-sfx-ring]'), ring);
    spy.mockReturnValue(now + 1500);
    await click(q(view, '[data-sfx-ring]'), ring);
    spy.mockRestore();
    expect(glyph(box, '0:3').rot).toBe(20);
  });

  it('is put back by Delete or Backspace, and the box stays', async () => {
    const { view, box } = mounted({ glyphs: { '0:3': { dx: 0.5, dy: 0.3, rot: 20, s: 1.5 } } });
    await tick();
    await pick(view, box, '0:3', 3);
    const heard = vi.fn();
    window.addEventListener('keydown', heard);
    await fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(box.style.sfx.glyphs).toEqual({});
    expect(page().boxes).toHaveLength(1);
    box.style.sfx.glyphs = { '0:3': { dx: 0.5, dy: 0, rot: 0, s: 1 } };
    await fireEvent.keyDown(document.body, { key: 'Backspace' });
    expect(box.style.sfx.glyphs).toEqual({});
    expect(heard).not.toHaveBeenCalled();
    window.removeEventListener('keydown', heard);
    // One undo step each.
    undo();
    expect(page().boxes[0].style.sfx.glyphs).toEqual({ '0:3': { dx: 0.5, dy: 0, rot: 0, s: 1 } });
  });

  it('is let go by Escape, and the arrow keys do nothing', async () => {
    const { view, box } = mounted();
    await tick();
    await pick(view, box);
    const heard = vi.fn();
    window.addEventListener('keydown', heard);
    await fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    await fireEvent.keyDown(document.body, { key: 'ArrowUp', shiftKey: true });
    expect(box.style.sfx.glyphs).toEqual({});
    expect(q(view, '[data-sfx-ring]')).not.toBe(null);
    await fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(q(view, '[data-sfx-ring]')).toBe(null);
    expect(gizmoUi.letter).toBe(false);
    expect(heard).not.toHaveBeenCalled();
    // With nothing picked the keys are the app's again.
    await fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(heard).toHaveBeenCalled();
    window.removeEventListener('keydown', heard);
  });

  it('is let go by a press off the handles', async () => {
    const { view, box } = mounted();
    await tick();
    await pick(view, box);
    await fireEvent.pointerDown(document.body, { button: 0, pointerId: 99 });
    await tick();
    expect(q(view, '[data-sfx-ring]')).toBe(null);
  });
});

describe('a gesture', () => {
  it('is one history step however many frames it writes', async () => {
    const { view, box } = mounted();
    await tick();
    await pick(view, box);
    const c = centreOf(box);
    const steps = Array.from({ length: 8 }, (_, i) => round(c, 104, -90 + (i + 1) * 10));
    await drag(q(view, '[data-sfx-ring]'), round(c, 104, -90), steps);
    expect(glyph(box).rot).toBe(80);
    expect(history.canUndo).toBe(true);
    undo();
    expect(page().boxes[0].style.sfx.glyphs).toEqual({});
    expect(history.canUndo).toBe(false);
  });

  it('says it is live from the press to the release', async () => {
    const { view, box } = mounted();
    await tick();
    const c = centreOf(box);
    const el = q(view, '[data-sfx-letter="0:0"]');
    expect(sfxLive.on).toBe(false);
    await fireEvent.pointerDown(el, { button: 0, pointerId: 50, clientX: c[0], clientY: c[1] });
    expect(sfxLive.on).toBe(true);
    await fireEvent.pointerMove(document, { pointerId: 50, clientX: c[0] + 10, clientY: c[1] });
    runFrames();
    expect(sfxLive.on).toBe(true);
    await fireEvent.pointerUp(document, { pointerId: 50, clientX: c[0] + 10, clientY: c[1] });
    expect(sfxLive.on).toBe(false);
    // A cancelled one too, and it is put back.
    const before = glyph(box).dx;
    await fireEvent.pointerDown(el, { button: 0, pointerId: 51, clientX: c[0], clientY: c[1] });
    await fireEvent.pointerMove(document, { pointerId: 51, clientX: c[0] + 40, clientY: c[1] });
    runFrames();
    expect(sfxLive.on).toBe(true);
    expect(glyph(box).dx).toBeGreaterThan(before);
    await fireEvent.pointerCancel(document, { pointerId: 51 });
    expect(sfxLive.on).toBe(false);
    expect(glyph(box).dx).toBe(before);
  });

  it('writes the box at most once an animation frame, the latest move', async () => {
    const { view, box } = mounted();
    await tick();
    const l = placed(box).letters[0];
    const c = centreOf(box);
    const el = q(view, '[data-sfx-letter="0:0"]');
    await fireEvent.pointerDown(el, { button: 0, pointerId: 60, clientX: c[0], clientY: c[1] });
    for (let i = 1; i <= 5; i++) await fireEvent.pointerMove(document, { pointerId: 60, clientX: c[0] + i * 6, clientY: c[1] });
    // Five moves, one frame asked for, nothing written yet.
    expect(frames.filter(Boolean)).toHaveLength(1);
    expect(box.style.sfx.glyphs).toEqual({});
    runFrames();
    // The frame wrote the last of the five.
    expect(glyph(box).dx).toBeCloseTo(30 / l.unit, 3);
    expect(frames.filter(Boolean)).toHaveLength(0);
    // A move left waiting when the pointer comes up is written then.
    await fireEvent.pointerMove(document, { pointerId: 60, clientX: c[0] + 42, clientY: c[1] });
    expect(frames.filter(Boolean)).toHaveLength(1);
    await fireEvent.pointerUp(document, { pointerId: 60, clientX: c[0] + 42, clientY: c[1] });
    expect(glyph(box).dx).toBeCloseTo(42 / l.unit, 3);
    expect(frames.filter(Boolean)).toHaveLength(0);
    expect(history.canUndo).toBe(true);
  });
});
