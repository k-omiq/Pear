import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';

// The pictures are the engine's to paint and have their own lane
// (sfx-preview.engine.test.js paints real ones). Here the painters are
// stand-ins that count what they are asked, so these cases are about the
// panel: what it shows under each engine, what a click or a slider writes,
// and how the cards are painted. The engine itself is the real one: the types
// and the auto pick are its.
vi.mock('./sfx-preview.js', async (original) => {
  const mod = await original();
  return {
    ...mod,
    paintCard: vi.fn(() => 'data:image/png;base64,AAAA'),
    paintStage: vi.fn(() => true),
  };
});

import SfxPanel from './SfxPanel.svelte';
import { paintCard, paintStage, clearCardCache } from './sfx-preview.js';
import { loadProjectPages, page } from './store.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { clearLayoutMemo, setTypesetEnabled, typesetEnabled } from './measure.js';
import { sfxKinds, sfxPick, sfxKind } from './sfx.js';
import { installFakeCanvas } from '../test/fake-canvas.js';
import { domRustEngine } from '../test/dom-rust-engine.js';

const original = { engine: textEngine(), typeset: typesetEnabled() };
let rust;
let restoreCanvas;
beforeAll(async () => {
  restoreCanvas = installFakeCanvas();
  setTypesetEnabled(true);
  // jsdom lays nothing out and has no observer for it: the stage's width is
  // read through `bind:clientWidth`, which wants one.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  rust = await domRustEngine();
});
afterAll(() => {
  vi.unstubAllGlobals();
  restoreCanvas();
  setTypesetEnabled(original.typeset);
});
beforeEach(() => {
  clearCardCache();
  clearLayoutMemo();
  paintCard.mockClear();
  paintStage.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setTextEngine(original.engine);
  clearLayoutMemo();
  loadProjectPages([]);
});

// A stand-in for the browser engine: no SFX layout.
function browserEngine() {
  const ink = (face, text) => ({ width: [...text].length * face.size * 0.55, left: 0, right: [...text].length * face.size * 0.55, ascent: face.size * 0.7, descent: face.size * 0.2 });
  return {
    id: 'browser',
    advance: (face, text) => [...text].length * face.size * 0.55,
    fontBox: (face) => ({ ascent: face.size * 0.8, descent: face.size * 0.2 }),
    lineInk: ink,
    glyphInk: ink,
    loading: () => false,
    onFontsChange: () => () => {},
    faceReady: () => true,
  };
}

// The box lives in the store so that what the panel writes is what it then
// reads. Its line says ドーン in Japanese and BOOM in English.
function mounted({ sfx = true, over = {}, props = {}, jp = 'ドーン' } = {}) {
  setTextEngine(sfx ? rust : browserEngine());
  const style = normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 40, ...over });
  loadProjectPages([
    {
      id: 1, w: 800, h: 1200,
      lines: [{ n: 1, type: 'sfx', jp, en: 'BOOM' }],
      boxes: [{ id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style }],
    },
  ]);
  const pg = page();
  const box = pg.boxes[0];
  const touch = vi.fn();
  const arm = vi.fn();
  const view = render(SfxPanel, { props: { box, pg, touch, arm, ...props } });
  return { view, box, touch, arm };
}
const types = (view) => [...view.getByRole('radiogroup', { name: 'Sound type' }).querySelectorAll('[role=radio]')];
const card = (view, id) => types(view).find((r) => r.dataset.kind === id);
const checked = (els) => els.filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.dataset.kind ?? r.getAttribute('aria-label'));

describe('under the browser engine', () => {
  it('says what SFX needs and shows no control', async () => {
    const { view } = mounted({ sfx: false });
    await tick();
    expect(view.container.textContent).toContain('SFX lettering needs the Rust text engine.');
    expect(view.container.querySelectorAll('input, select, [role=radio], canvas')).toHaveLength(0);
    expect(view.queryByRole('button', { name: 'Open settings' })).toBe(null);
    expect(paintStage).not.toHaveBeenCalled();
    expect(paintCard).not.toHaveBeenCalled();
  });

  it('offers Settings when the host can open them', async () => {
    const onSettings = vi.fn();
    const { view } = mounted({ sfx: false, props: { onSettings } });
    await fireEvent.click(view.getByRole('button', { name: 'Open settings' }));
    expect(onSettings).toHaveBeenCalledWith('typesetting');
  });
});

describe('the types', () => {
  it('lists the engine types, none chosen for a plain box, and only the type grid', async () => {
    const { view } = mounted();
    await tick();
    expect(types(view).map((r) => r.dataset.kind)).toEqual(sfxKinds().map((k) => k.id));
    expect(types(view)).toHaveLength(12);
    expect(checked(types(view))).toEqual([]);
    expect(view.container.textContent).toContain('SFX · Off');
    expect(view.queryByRole('button', { name: 'Remove SFX' })).toBe(null);
    expect(view.queryByRole('radiogroup', { name: 'Variations' })).toBe(null);
    expect(view.container.querySelector('input[type=range]')).toBe(null);
  });

  it('marks the auto pick top three, read from the Japanese', async () => {
    const { view } = mounted();
    await tick();
    const top = sfxPick('ドーン').order.slice(0, 3);
    for (const [i, id] of top.entries()) expect(card(view, id).dataset.rank).toBe(String(i + 1));
    expect(types(view).filter((r) => r.dataset.rank)).toHaveLength(3);
  });

  it('applies a type on a click, tells the Inspector, and marks the card', async () => {
    const { view, box, touch } = mounted({ over: { curve: 30 } });
    await fireEvent.click(card(view, 'rumble'));
    expect(box.style.sfx.on).toBe(true);
    expect(box.style.sfx.kind).toBe('rumble');
    // The same rule `enableSfx` has: the arc is switched off with it.
    expect(box.style.curve).toBe(0);
    expect(touch).toHaveBeenCalledTimes(1);
    await tick();
    expect(checked(types(view))).toEqual(['rumble']);
    expect(view.container.textContent).toContain(`SFX · ${sfxKind('rumble').name}`);
    expect(view.queryByRole('button', { name: 'Remove SFX' })).not.toBe(null);
  });

  it('keeps the paths and letter edits across a change of type', async () => {
    const { view, box } = mounted();
    await fireEvent.click(card(view, 'impact'));
    box.style.sfx.paths = [{ a: [-2, 0], b: [2, 1], bend: 0.2 }];
    box.style.sfx.glyphs = { '0:1': { dx: 0.5, dy: 0, rot: 10, s: 1 } };
    await fireEvent.click(card(view, 'slash'));
    expect(box.style.sfx.kind).toBe('slash');
    expect(box.style.sfx.paths).toEqual([{ a: [-2, 0], b: [2, 1], bend: 0.2 }]);
    expect(box.style.sfx.glyphs['0:1'].rot).toBe(10);
  });

  it('Auto pick applies the first pick at its strength', async () => {
    const { view, box, touch } = mounted();
    await fireEvent.click(view.getByRole('button', { name: 'Auto pick' }));
    const pick = sfxPick('ドーン');
    expect(box.style.sfx.kind).toBe(pick.order[0]);
    expect(box.style.sfx.strength).toBeCloseTo(pick.strength, 5);
    expect(touch).toHaveBeenCalledTimes(1);
    await tick();
    expect(checked(types(view))).toEqual([pick.order[0]]);
  });

  it('reads the English when the line has no Japanese', async () => {
    const { view } = mounted({ jp: '' });
    await tick();
    expect(types(view).find((r) => r.dataset.rank === '1').dataset.kind).toBe(sfxPick('BOOM').order[0]);
  });
});

describe('with a type on', () => {
  async function on(opts) {
    const m = mounted(opts);
    await fireEvent.click(card(m.view, 'impact'));
    m.touch.mockClear();
    await tick();
    return m;
  }

  it('picks a variation by its seed, and New shape picks another', async () => {
    const { view, box, touch } = await on();
    const vars = () => [...view.getByRole('radiogroup', { name: 'Variations' }).querySelectorAll('[role=radio]')];
    expect(vars()).toHaveLength(8);
    await fireEvent.click(vars()[2]);
    expect(box.style.sfx.seed).toBe(3);
    await tick();
    expect(checked(vars())).toEqual(['Variation 3']);
    await fireEvent.click(view.getByRole('button', { name: 'New shape' }));
    expect(box.style.sfx.seed).not.toBe(3);
    expect(touch).toHaveBeenCalledTimes(2);
  });

  it('writes the strength', async () => {
    const { view, box, touch } = await on();
    await fireEvent.input(view.getByRole('slider', { name: 'Strength' }), { target: { value: '1.6' } });
    expect(box.style.sfx.strength).toBe(1.6);
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it('keeps Layout closed until asked; a slider shows the type until it is moved, and goes back', async () => {
    const { view, box } = await on();
    expect(view.queryByRole('slider', { name: 'Gap' })).toBe(null);
    await fireEvent.click(view.getByRole('button', { name: 'Layout' }));
    const gap = view.getByRole('slider', { name: 'Gap' });
    expect(+gap.value).toBeCloseTo(sfxKind('impact').gap, 2);
    expect(box.style.sfx.gap).toBe(null);
    await fireEvent.input(gap, { target: { value: '0.4' } });
    expect(box.style.sfx.gap).toBe(0.4);
    await fireEvent.input(view.getByRole('slider', { name: 'Size at end' }), { target: { value: '2' } });
    expect(box.style.sfx.flow).toEqual({ ...sfxKind('impact').flow, to: 2 });
    await fireEvent.click(view.getByRole('button', { name: "Gap: back to the type's" }));
    expect(box.style.sfx.gap).toBe(null);
    await fireEvent.click(view.getByRole('button', { name: 'Back to type' }));
    expect(box.style.sfx.flow).toBe(null);
    await fireEvent.click(view.getByRole('button', { name: 'Down' }));
    expect(box.style.sfx.dir).toBe('v');
  });

  it('resets the paths and the letter edits', async () => {
    const { view, box } = await on();
    box.style.sfx.paths = [{ a: [-2, 0], b: [2, 0], bend: 0 }];
    box.style.sfx.glyphs = { '0:0': { dx: 1, dy: 0, rot: 0, s: 1 } };
    await fireEvent.click(view.getByRole('button', { name: 'Layout' }));
    await fireEvent.click(view.getByRole('button', { name: 'Reset paths' }));
    expect(box.style.sfx.paths).toEqual([]);
    await fireEvent.click(view.getByRole('button', { name: 'Reset letter edits' }));
    expect(box.style.sfx.glyphs).toEqual({});
    await tick();
    expect(view.getByRole('button', { name: 'Reset paths' }).disabled).toBe(true);
  });

  it('has the effects, closed, and only while SFX is on', async () => {
    const { view, box, touch } = await on();
    await fireEvent.click(view.getByRole('button', { name: 'Effects' }));
    await fireEvent.click(view.getByRole('switch', { name: 'Extrude' }));
    expect(box.style.extrude.on).toBe(true);
    await fireEvent.input(view.getByRole('slider', { name: 'Depth' }), { target: { value: '0.8' } });
    expect(box.style.extrude.length).toBe(0.8);
    await fireEvent.click(view.getByRole('button', { name: 'Each letter' }));
    expect(box.style.strokeOrder).toBe('each');
    await fireEvent.click(view.getByRole('button', { name: 'Sharp' }));
    expect(box.style.strokeJoin).toBe('miter');
    expect(touch).toHaveBeenCalledTimes(4);
    await fireEvent.click(view.getByRole('button', { name: 'Remove SFX' }));
    await tick();
    expect(view.queryByRole('switch', { name: 'Extrude' })).toBe(null);
  });

  it('fills the caption from the meaning of the Japanese', async () => {
    const { view, box } = await on({ jp: 'ドキドキ' });
    const fill = view.getByRole('button', { name: 'Fill from meaning' });
    await waitFor(() => expect(fill.disabled).toBe(false), { timeout: 5000 });
    await fireEvent.click(fill);
    expect(box.style.sfx.caption.text.length).toBeGreaterThan(0);
    await tick();
    await fireEvent.click(view.getByRole('button', { name: 'Right' }));
    expect(box.style.sfx.caption.side).toBe('right');
  });

  it('Remove SFX puts the box back as it was, tells the Inspector, and goes away', async () => {
    const m = mounted({ over: { curve: 30, color: '#123456', strokes: [{ color: '#abcdef', width: 5, opacity: 1 }] } });
    const was = JSON.parse(JSON.stringify(m.box.style));
    // Two types in a row: what comes back is the box, not the first type.
    await fireEvent.click(card(m.view, 'impact'));
    await fireEvent.click(card(m.view, 'soft'));
    m.touch.mockClear();
    await tick();
    await fireEvent.click(m.view.getByRole('button', { name: 'Remove SFX' }));
    expect(m.box.style.sfx.on).toBe(false);
    expect(m.box.style.curve).toBe(30);
    expect(m.box.style.color).toBe('#123456');
    expect(JSON.parse(JSON.stringify(m.box.style.strokes))).toEqual(was.strokes);
    expect(m.touch).toHaveBeenCalledTimes(1);
    await tick();
    expect(m.view.queryByRole('button', { name: 'Remove SFX' })).toBe(null);
    expect(m.view.container.textContent).toContain('SFX · Off');
  });
});

describe('painting', () => {
  it('paints the cards a few a frame, and not again for a cached card', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] });
    const { view } = mounted();
    await tick();
    expect(paintCard).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(paintCard).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(200);
    expect(paintCard).toHaveBeenCalledTimes(12);
    await tick();
    expect(view.container.querySelector('.sfx-tile').getAttribute('style')).toContain('data:image/png');
    // A type card is the type's look: the box's colour is not in it.
    page().boxes[0].style.color = '#cc0000';
    await tick();
    vi.advanceTimersByTime(200);
    expect(paintCard).toHaveBeenCalledTimes(12);
  });

  it('paints the variations once a type is on, and the stage on a change of style', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] });
    const { view, box } = mounted();
    await tick();
    vi.advanceTimersByTime(300);
    await tick();
    const stage = paintStage.mock.calls.length;
    expect(stage).toBeGreaterThan(0);
    await fireEvent.click(card(view, 'impact'));
    await tick();
    vi.advanceTimersByTime(300);
    expect(paintCard.mock.calls.filter(([, c]) => c.kind == null).map(([, c]) => c.seed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(paintStage.mock.calls.length).toBeGreaterThan(stage);
    const after = paintStage.mock.calls.length;
    box.style.shadows = [{ x: 3, y: 3, blur: 2, color: '#000000', opacity: 0.5 }];
    await tick();
    vi.advanceTimersByTime(100);
    expect(paintStage.mock.calls.length).toBeGreaterThan(after);
  });
});
