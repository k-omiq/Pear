import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import SfxGizmo from './SfxGizmo.svelte';
import { loadProjectPages, page } from './store.svelte.js';
import { initHistory, resetHistory, undo, history } from './editor/history.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { clearLayoutMemo } from './measure.js';
import { applySfxKind, sfxPlacement, bendHandle } from './sfx.js';
import { domRustEngine } from '../test/dom-rust-engine.js';

// ===========================================================================
// The SFX handles: what a drag on each writes, and that it is one undo step
// ===========================================================================
// With the real engine, so the handles sit where the engine put the paths
// and the letters. The box is at the page's origin and the zoom is 1, so a
// pointer's client px are the box's own page px (`toLocal`).

const original = textEngine();
let rust;
beforeAll(async () => {
  rust = await domRustEngine();
});
afterAll(() => setTextEngine(original));
beforeEach(() => {
  setTextEngine(rust);
  clearLayoutMemo();
  initHistory();
  resetHistory();
});
afterEach(() => {
  cleanup();
  loadProjectPages([]);
  setTextEngine(original);
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
// A handle's centre in box px.
const at = (el) => (el.tagName === 'circle' ? [+el.getAttribute('cx'), +el.getAttribute('cy')] : [+el.getAttribute('x') + 5, +el.getAttribute('y') + 5]);

async function dragFrom(el, [x, y], [dx, dy]) {
  await fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: x, clientY: y });
  await fireEvent.pointerMove(document, { pointerId: 1, clientX: x + dx, clientY: y + dy });
  await fireEvent.pointerUp(document, { pointerId: 1, clientX: x + dx, clientY: y + dy });
  await tick();
}

describe('the paths', () => {
  it('shows the ends and the bend of the path the engine made', async () => {
    const { view, box } = mounted();
    await tick();
    expect(box.style.sfx.paths).toEqual([]);
    const [p] = placed(box).paths;
    const ends = view.container.querySelectorAll('[data-sfx-end]');
    expect(ends).toHaveLength(2);
    expect(at(ends[0])[0]).toBeCloseTo(200 + p.a[0] * 40, 3);
    expect(at(ends[1])[1]).toBeCloseTo(100 + p.b[1] * 40, 3);
    expect(view.container.querySelectorAll('[data-sfx-bend]')).toHaveLength(1);
  });

  it('writes the dragged end into the box, from the engine path, as one undo step', async () => {
    const { view, box } = mounted();
    await tick();
    const [p] = placed(box).paths;
    const end = view.container.querySelector('[data-sfx-end="0:b"]');
    await dragFrom(end, at(end), [40, 20]);
    expect(box.style.sfx.paths).toHaveLength(1);
    expect(box.style.sfx.paths[0].a[0]).toBeCloseTo(p.a[0], 2);
    expect(box.style.sfx.paths[0].b[0]).toBeCloseTo(p.b[0] + 1, 2);
    expect(box.style.sfx.paths[0].b[1]).toBeCloseTo(p.b[1] + 0.5, 2);
    expect(history.canUndo).toBe(true);
    undo();
    expect(page().boxes[0].style.sfx.paths).toEqual([]);
  });

  it('bends the path by its diamond, with the diamond on the curve', async () => {
    const { view, box } = mounted({ paths: [{ a: [-2, 0], b: [2, 0], bend: 0 }] });
    await tick();
    const bend = view.container.querySelector('[data-sfx-bend="0"]');
    expect(at(bend)).toEqual([200, 100]);
    // Down 40 px is one em off a chord four ems long, at the curve's middle:
    // the control point twice that, a bend of 0.5.
    await dragFrom(bend, at(bend), [0, 40]);
    expect(box.style.sfx.paths[0].bend).toBeCloseTo(0.5, 3);
    expect(bendHandle(box.style.sfx.paths[0])[1]).toBeCloseTo(1, 3);
  });

  it('records nothing for a press that moved nothing', async () => {
    const { view } = mounted({ paths: [{ a: [-2, 0], b: [2, 0], bend: 0 }] });
    await tick();
    const end = view.container.querySelector('[data-sfx-end="0:a"]');
    await dragFrom(end, at(end), [0, 0]);
    expect(history.canUndo).toBe(false);
  });
});

describe('a letter', () => {
  const letterEl = (view, key) => view.container.querySelector(`[data-sfx-letter="${key}"]`);
  async function picked(view, key = '0:0') {
    const el = letterEl(view, key);
    await fireEvent.pointerDown(el, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    await fireEvent.pointerUp(document, { pointerId: 2, clientX: 10, clientY: 10 });
    await tick();
    return letterEl(view, key);
  }

  it('is picked by a click, and only then shows its ring and square', async () => {
    const { view } = mounted();
    await tick();
    expect(view.container.querySelectorAll('[data-sfx-letter]')).toHaveLength(4);
    expect(view.container.querySelector('[data-sfx-ring]')).toBe(null);
    const el = await picked(view);
    expect(el.classList.contains('picked')).toBe(true);
    expect(view.container.querySelector('[data-sfx-ring]')).not.toBe(null);
    expect(view.container.querySelector('[data-sfx-scale]')).not.toBe(null);
  });

  it('moves by a drag, in its own ems', async () => {
    const { view, box } = mounted();
    await tick();
    const em = placed(box).letters[0].em;
    const el = await picked(view);
    await dragFrom(el, [50, 50], [30, -12]);
    const g = box.style.sfx.glyphs['0:0'];
    expect(g.dx).toBeCloseTo(30 / em, 2);
    expect(g.dy).toBeCloseTo(-12 / em, 2);
    expect(g.rot).toBe(0);
    expect(g.s).toBe(1);
    undo();
    expect(page().boxes[0].style.sfx.glyphs).toEqual({});
  });

  it('turns by its ring and sizes by its square', async () => {
    const { view, box } = mounted();
    await tick();
    await picked(view);
    const ring = view.container.querySelector('[data-sfx-ring]');
    const c = at(ring);
    const r = +ring.getAttribute('r');
    // From the ring's right to its bottom: a quarter turn, clockwise.
    await fireEvent.pointerDown(ring, { button: 0, pointerId: 3, clientX: c[0] + r, clientY: c[1] });
    await fireEvent.pointerMove(document, { pointerId: 3, clientX: c[0], clientY: c[1] + r });
    await fireEvent.pointerUp(document, { pointerId: 3, clientX: c[0], clientY: c[1] + r });
    await tick();
    expect(box.style.sfx.glyphs['0:0'].rot).toBeCloseTo(90, 1);
    const sq = view.container.querySelector('[data-sfx-scale]');
    const p = at(sq);
    const c2 = at(view.container.querySelector('[data-sfx-ring]'));
    // Twice as far from the centre: twice the size.
    await dragFrom(sq, p, [p[0] - c2[0], p[1] - c2[1]]);
    expect(box.style.sfx.glyphs['0:0'].s).toBeCloseTo(2, 1);
  });

  it('goes back on a double click, and nudges with the arrows', async () => {
    const { view, box } = mounted();
    await tick();
    const el = await picked(view);
    await fireEvent.keyDown(el, { key: 'ArrowRight' });
    await fireEvent.keyDown(el, { key: 'ArrowDown', shiftKey: true });
    expect(box.style.sfx.glyphs['0:0'].dx).toBeCloseTo(0.02, 3);
    expect(box.style.sfx.glyphs['0:0'].dy).toBeCloseTo(0.2, 3);
    await fireEvent.dblClick(letterEl(view, '0:0'));
    expect(box.style.sfx.glyphs).toEqual({});
  });
});
