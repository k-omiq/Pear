import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';

// The pictures are the engine's to paint and have their own lane
// (sfx-preview.engine.test.js paints real ones). Here the painters are
// stand-ins that count what they are asked, so these cases are about the
// panel: what it shows under each engine, what a click or a slider writes,
// and when the pictures are painted. The engine itself is the real one: the
// types and the auto pick are its.
vi.mock('./sfx-preview.js', async (original) => {
  const mod = await original();
  return {
    ...mod,
    paintCard: vi.fn(() => 'data:image/png;base64,AAAA'),
    paintStage: vi.fn(() => ({ w: 100, h: 40 })),
  };
});

import SfxPanel from './SfxPanel.svelte';
import { paintCard, paintStage, clearCardCache } from './sfx-preview.js';
import { loadProjectPages, page } from './store.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { clearLayoutMemo, setTypesetEnabled, typesetEnabled } from './measure.js';
import { sfxKinds, sfxPick, sfxKind, sfxResolved } from './sfx.js';
import { sfxLive } from './sfx-live.svelte.js';
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
  sfxLive.on = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setTextEngine(original.engine);
  clearLayoutMemo();
  loadProjectPages([]);
  sfxLive.on = false;
});

// Frames by hand: requestAnimationFrame and the timers are the test's.
// One frame is 16 ms of fake time: exactly one frame boundary per step.
// `performance.now` stays real, so a test can time the panel's own work.
const fakeFrames = () => vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] });
const frames = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    vi.advanceTimersByTime(16);
    await tick();
  }
};

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
const vars = (view) => [...view.getByRole('radiogroup', { name: 'Variations' }).querySelectorAll('[role=radio]')];
const checked = (els) => els.filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.dataset.kind ?? r.getAttribute('aria-label'));
const plain = (v) => JSON.parse(JSON.stringify(v));

// A box with a type on, the Inspector's counter cleared.
async function on(opts) {
  const m = mounted(opts);
  await fireEvent.click(card(m.view, 'impact'));
  m.touch.mockClear();
  await tick();
  return m;
}

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
  it('lists the engine types by name, none chosen for a plain box, and only the stage and the grid', async () => {
    const { view } = mounted();
    await tick();
    expect(types(view).map((r) => r.dataset.kind)).toEqual(sfxKinds().map((k) => k.id));
    expect(types(view)).toHaveLength(12);
    expect(types(view).map((r) => r.querySelector('.sfx-name').textContent)).toEqual(sfxKinds().map((k) => k.name));
    expect(checked(types(view))).toEqual([]);
    expect(view.container.textContent).toContain('SFX · Off');
    expect(view.container.querySelector('canvas')).not.toBe(null);
    // New shape has no type to reshape yet: shown, dimmed.
    expect(view.getByRole('button', { name: 'New shape' }).disabled).toBe(true);
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

  it('reads the English when the line has no Japanese', async () => {
    const { view } = mounted({ jp: '' });
    await tick();
    expect(types(view).find((r) => r.dataset.rank === '1').dataset.kind).toBe(sfxPick('BOOM').order[0]);
  });

  it('applies a type on a click, tells the Inspector once, and marks the card', async () => {
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
    expect(view.getByRole('button', { name: 'Remove SFX' })).not.toBe(null);
  });

  it('a type resets the letter edits, the paths, every layout number and the dials, and never the look', async () => {
    const { view, box } = mounted({ over: { color: '#123456', font: 'Comic Neue', strokes: [{ color: '#abcdef', width: 5, opacity: 1 }] } });
    await fireEvent.click(card(view, 'impact'));
    Object.assign(box.style.sfx, {
      paths: [{ a: [-2, 0], b: [2, 1], bend: 0.2 }],
      glyphs: { '0:1': { dx: 0.5, dy: 0, rot: 10, s: 1 } },
      gap: 0.4, slant: 12, dir: 'v', flow: { from: 2, to: 1, pow: 1 }, jitter: { rot: 9, size: 0.1, off: 0.2 },
      power: 80, rough: 20, momentum: 70,
    });
    await fireEvent.click(card(view, 'slash'));
    const s = box.style.sfx;
    expect(s.kind).toBe('slash');
    expect(s.glyphs).toEqual({});
    expect(plain(s.paths)).toEqual([]);
    for (const k of ['gap', 'slant', 'dir', 'flow', 'jitter']) expect(s[k], k).toBe(null);
    expect([s.power, s.rough, s.momentum]).toEqual([50, 50, 50]);
    expect(box.style.color).toBe('#123456');
    expect(box.style.font).toBe('Comic Neue');
    expect(plain(box.style.strokes)).toEqual([{ color: '#abcdef', width: 5, opacity: 1 }]);
  });

  it('Auto pick applies the first pick and sets the three dials from the sound', async () => {
    const { view, box, touch } = mounted();
    await fireEvent.click(view.getByRole('button', { name: 'Auto pick' }));
    const pick = sfxPick('ドーン');
    expect(box.style.sfx.kind).toBe(pick.order[0]);
    for (const d of ['power', 'rough', 'momentum']) expect(box.style.sfx[d], d).toBe(Math.round(pick[d]));
    expect(touch).toHaveBeenCalledTimes(1);
    await tick();
    expect(checked(types(view))).toEqual([pick.order[0]]);
  });
});

describe('with a type on', () => {
  it('picks a variation by its seed, and New shape picks another', async () => {
    const { view, box, touch } = await on();
    expect(vars(view)).toHaveLength(8);
    await fireEvent.click(vars(view)[2]);
    expect(box.style.sfx.seed).toBe(3);
    await tick();
    expect(checked(vars(view))).toEqual(['Variation 3']);
    await fireEvent.click(view.getByRole('button', { name: 'New shape' }));
    expect(box.style.sfx.seed).not.toBe(3);
    expect(touch).toHaveBeenCalledTimes(2);
  });

  it('has the three dials at 50, and a dial writes once a frame with a detent at the middle', async () => {
    fakeFrames();
    const { view, box, touch } = await on();
    const power = view.getByRole('slider', { name: 'Power' });
    expect(['Power', 'Roughness', 'Momentum'].map((n) => +view.getByRole('slider', { name: n }).value)).toEqual([50, 50, 50]);
    expect(view.queryByRole('button', { name: 'Power: as designed' })).toBe(null);
    // Three inputs in one frame are one write, of the last.
    await fireEvent.input(power, { target: { value: '60' } });
    await fireEvent.input(power, { target: { value: '70' } });
    await fireEvent.input(power, { target: { value: '80' } });
    expect(box.style.sfx.power).toBe(50);
    expect(touch).not.toHaveBeenCalled();
    await frames(1);
    expect(box.style.sfx.power).toBe(80);
    expect(touch).toHaveBeenCalledTimes(1);
    // Near the middle lands on it.
    await fireEvent.input(power, { target: { value: '52' } });
    await fireEvent.change(power);
    expect(box.style.sfx.power).toBe(50);
    await fireEvent.input(view.getByRole('slider', { name: 'Momentum' }), { target: { value: '90' } });
    await fireEvent.change(view.getByRole('slider', { name: 'Momentum' }));
    expect(box.style.sfx.momentum).toBe(90);
    await tick();
    await fireEvent.click(view.getByRole('button', { name: 'Momentum: as designed' }));
    expect(box.style.sfx.momentum).toBe(50);
    // Typed: at once, kept inside the range.
    await fireEvent.change(view.getByRole('spinbutton', { name: 'Roughness, amount' }), { target: { value: '140' } });
    expect(box.style.sfx.rough).toBe(100);
  });

  it('keeps Layout closed; a slider shows the type in the reference units, writes ours, and goes back', async () => {
    fakeFrames();
    const { view, box } = await on();
    expect(view.queryByRole('slider', { name: 'Letter spacing %' })).toBe(null);
    await fireEvent.click(view.getByRole('button', { name: 'Layout' }));
    const R = sfxResolved(box.style.sfx);
    const spacing = view.getByRole('slider', { name: 'Letter spacing %' });
    expect(+spacing.value).toBe(Math.round(R.gap * 100));
    expect(+view.getByRole('slider', { name: 'Start size %' }).value).toBe(Math.round(R.flow.from * 100));
    expect(+view.getByRole('slider', { name: 'Lean %' }).value).toBe(Math.round(R.follow * 100));
    expect(box.style.sfx.gap).toBe(null);
    await fireEvent.input(spacing, { target: { value: '40' } });
    await fireEvent.change(spacing);
    expect(box.style.sfx.gap).toBe(0.4);
    await fireEvent.input(view.getByRole('slider', { name: 'End size %' }), { target: { value: '200' } });
    await frames(1);
    expect(plain(box.style.sfx.flow)).toEqual({ ...plain(R.flow), to: 2 });
    await fireEvent.input(view.getByRole('slider', { name: 'Up/down variation' }), { target: { value: '120' } });
    await frames(1);
    expect(box.style.sfx.jitter.off).toBeCloseTo(1.2, 5);
    await fireEvent.input(view.getByRole('slider', { name: 'Slant' }), { target: { value: '-20' } });
    await fireEvent.input(view.getByRole('slider', { name: 'Rise °' }), { target: { value: '15' } });
    await frames(1);
    expect([box.style.sfx.slant, box.style.sfx.rise]).toEqual([-20, 15]);
    await tick();
    await fireEvent.click(view.getByRole('button', { name: 'Letter spacing %: back to the type' }));
    expect(box.style.sfx.gap).toBe(null);
    await fireEvent.click(view.getByRole('button', { name: 'Vertical' }));
    expect(box.style.sfx.dir).toBe('v');
    await fireEvent.click(view.getByRole('switch', { name: 'Optical spacing' }));
    expect(box.style.sfx.kern).toBe(false);
    await fireEvent.click(view.getByRole('switch', { name: 'Join ー' }));
    expect(box.style.sfx.joinBars).toBe(false);
    await tick();
    await fireEvent.click(view.getByRole('button', { name: 'Back to type' }));
    for (const k of ['flow', 'jitter', 'slant', 'rise', 'dir']) expect(box.style.sfx[k], k).toBe(null);
    expect([box.style.sfx.kern, box.style.sfx.joinBars]).toEqual([true, true]);
  });

  it('resets the path and the letter edits', async () => {
    const { view, box } = await on();
    box.style.sfx.paths = [{ a: [-2, 0], b: [2, 0], bend: 0 }];
    box.style.sfx.glyphs = { '0:0': { dx: 1, dy: 0, rot: 0, s: 1 } };
    await fireEvent.click(view.getByRole('button', { name: 'Layout' }));
    await fireEvent.click(view.getByRole('button', { name: 'Reset path' }));
    expect(plain(box.style.sfx.paths)).toEqual([]);
    await fireEvent.click(view.getByRole('button', { name: 'Reset letter edits' }));
    expect(box.style.sfx.glyphs).toEqual({});
    await tick();
    expect(view.getByRole('button', { name: 'Reset path' }).disabled).toBe(true);
    expect(view.getByRole('button', { name: 'Reset letter edits' }).disabled).toBe(true);
  });

  it('has the effects, closed, and only while SFX is on', async () => {
    const { view, box, touch } = await on();
    expect(view.queryByRole('switch', { name: 'Extrude' })).toBe(null);
    await fireEvent.click(view.getByRole('button', { name: 'Effects' }));
    await fireEvent.click(view.getByRole('switch', { name: 'Extrude' }));
    expect(box.style.extrude.on).toBe(true);
    await fireEvent.input(view.getByRole('slider', { name: 'Depth' }), { target: { value: '0.8' } });
    await fireEvent.change(view.getByRole('slider', { name: 'Depth' }));
    expect(box.style.extrude.length).toBe(0.8);
    await fireEvent.click(view.getByRole('button', { name: 'Letter by letter' }));
    expect(box.style.strokeOrder).toBe('each');
    await fireEvent.click(view.getByRole('button', { name: 'Sharp' }));
    expect(box.style.strokeJoin).toBe('miter');
    for (const name of ['Negative', 'Shake', 'Trail']) expect(view.getByRole('switch', { name })).not.toBe(null);
    expect(view.getByRole('slider', { name: 'Shade %' })).not.toBe(null);
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
    expect(view.getByRole('slider', { name: 'Caption size %' })).not.toBe(null);
  });

  it('Remove SFX, last in the pane, puts the box back as it was and goes away', async () => {
    const m = mounted({ over: { curve: 30, color: '#123456', strokes: [{ color: '#abcdef', width: 5, opacity: 1 }] } });
    const was = plain(m.box.style);
    // Two types in a row: what comes back is the box, not the first type.
    await fireEvent.click(card(m.view, 'impact'));
    await fireEvent.click(card(m.view, 'soft'));
    m.touch.mockClear();
    await tick();
    const buttons = [...m.view.container.querySelectorAll('button')];
    expect(buttons.at(-1).textContent).toBe('Remove SFX');
    await fireEvent.click(m.view.getByRole('button', { name: 'Remove SFX' }));
    expect(m.box.style.sfx.on).toBe(false);
    expect(m.box.style.curve).toBe(30);
    expect(m.box.style.color).toBe('#123456');
    expect(plain(m.box.style.strokes)).toEqual(was.strokes);
    expect(m.touch).toHaveBeenCalledTimes(1);
    await tick();
    expect(m.view.queryByRole('button', { name: 'Remove SFX' })).toBe(null);
    expect(m.view.container.textContent).toContain('SFX · Off');
  });
});

describe('painting', () => {
  const settle = async () => {
    await tick();
    await frames(12);
  };

  it('paints the cards three a frame, and not again for a cached card', async () => {
    fakeFrames();
    const { view } = mounted();
    await tick();
    expect(paintCard).not.toHaveBeenCalled();
    await frames(1);
    expect(paintCard).toHaveBeenCalledTimes(3);
    await frames(1);
    expect(paintCard).toHaveBeenCalledTimes(6);
    await settle();
    expect(paintCard).toHaveBeenCalledTimes(12);
    expect(view.container.querySelector('.sfx-tile').getAttribute('style')).toContain('data:image/png');
    // A type card is the box's look laid out as the type: a new colour is
    // twelve new cards, and a colour back is twelve cached ones.
    page().boxes[0].style.color = '#cc0000';
    await settle();
    expect(paintCard).toHaveBeenCalledTimes(24);
    page().boxes[0].style.color = '#000000';
    await settle();
    expect(paintCard).toHaveBeenCalledTimes(24);
  });

  it('keeps each card on its picture until the new one is painted', async () => {
    fakeFrames();
    const { view } = mounted();
    await settle();
    paintCard.mockImplementation(() => 'data:image/png;base64,BBBB');
    page().boxes[0].style.color = '#cc0000';
    await tick();
    await frames(1);
    const tiles = [...view.container.querySelectorAll('.sfx-tile')].map((t) => t.getAttribute('style'));
    expect(tiles.filter((s) => s.includes('BBBB')).length).toBe(3);
    expect(tiles.filter((s) => s.includes('AAAA')).length).toBe(9);
    paintCard.mockImplementation(() => 'data:image/png;base64,AAAA');
  });

  it('waits out a run of changes (a colour dragged) and paints the last', async () => {
    fakeFrames();
    mounted();
    await settle();
    paintCard.mockClear();
    for (let i = 0; i < 10; i++) {
      page().boxes[0].style.color = `#00000${i}`;
      await tick();
      await frames(1);
    }
    // The drag's first change may start a batch; the rest wait.
    expect(paintCard.mock.calls.length).toBeLessThanOrEqual(3);
    await settle();
    expect(paintCard.mock.calls.at(-1)[0].color).toBe('#000009');
  });

  it('paints the variations once a type is on, and the stage on a change of style', async () => {
    fakeFrames();
    const { view, box } = mounted();
    await settle();
    const stage = paintStage.mock.calls.length;
    expect(stage).toBeGreaterThan(0);
    // The stage is painted at its own pixels and handed back what the last
    // paint said of the ink.
    await fireEvent.click(card(view, 'impact'));
    await settle();
    expect(paintCard.mock.calls.filter(([, c]) => c.kind == null).map(([, c]) => c.seed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(paintStage.mock.calls.length).toBeGreaterThan(stage);
    expect(paintStage.mock.calls.at(-1)[3]).toEqual({ w: 100, h: 40 });
    const after = paintStage.mock.calls.length;
    box.style.shadows = [{ x: 3, y: 3, blur: 2, color: '#000000', opacity: 0.5 }];
    await settle();
    expect(paintStage.mock.calls.length).toBe(after + 1);
  });

  it('repaints only the variations for a letter moved by hand or a path drawn', async () => {
    fakeFrames();
    const { box } = await on();
    await settle();
    paintCard.mockClear();
    paintStage.mockClear();
    box.style.sfx.glyphs = { '0:1': { dx: 0.5, dy: 0, rot: 10, s: 1 } };
    box.style.sfx.paths = [{ a: [-2, 0], b: [2, 1], bend: 0.2 }];
    await settle();
    // The 8 variations keep the box's paths and edits; the 12 type cards don't.
    expect(paintCard).toHaveBeenCalledTimes(8);
    expect(paintCard.mock.calls.every(([, card]) => !card?.kind)).toBe(true);
    expect(paintStage).toHaveBeenCalledTimes(1);
  });

  it('holding a slider makes the gesture live: no stage, no card, until it is let go; then one of each', async () => {
    fakeFrames();
    const { view, box, touch } = await on();
    await settle();
    paintCard.mockClear();
    paintStage.mockClear();
    const power = view.getByRole('slider', { name: 'Power' });
    await fireEvent.pointerDown(power);
    expect(sfxLive.on).toBe(true);
    // Sixty frames of dragging: a write and a touch a frame, nothing painted.
    const t0 = performance.now();
    for (let v = 51; v <= 100; v++) {
      await fireEvent.input(power, { target: { value: String(v) } });
      await frames(1);
    }
    const spent = performance.now() - t0;
    expect(box.style.sfx.power).toBe(100);
    expect(touch.mock.calls.length).toBe(50);
    expect(paintStage).not.toHaveBeenCalled();
    expect(paintCard).not.toHaveBeenCalled();
    // The tiles were not keyed out from under the cards either.
    expect([...view.container.querySelectorAll('.sfx-tile')].every((t) => t.getAttribute('style').includes('data:image/png'))).toBe(true);
    await fireEvent.input(power, { target: { value: '90' } });
    await fireEvent.pointerUp(window);
    expect(sfxLive.on).toBe(false);
    // The last value is written on the release, not a frame later.
    expect(box.style.sfx.power).toBe(90);
    await settle();
    expect(paintStage).toHaveBeenCalledTimes(1);
    // The variations hold the dials; the type cards do not.
    expect(paintCard.mock.calls.every(([, c]) => c.kind == null)).toBe(true);
    expect(paintCard).toHaveBeenCalledTimes(8);
    // Fake frames, real work: fifty frames of the panel's own side of a drag.
    console.info(`SfxPanel: 50 held-slider frames in ${spent.toFixed(1)} ms of panel work`);
    expect(spent).toBeLessThan(400);
  });

  it('paints nothing while the canvas handles are dragged, and once after', async () => {
    fakeFrames();
    const { box } = await on();
    await settle();
    paintCard.mockClear();
    paintStage.mockClear();
    sfxLive.on = true;
    for (let i = 0; i < 20; i++) {
      box.style.sfx.glyphs = { '0:1': { dx: i / 10, dy: 0, rot: i, s: 1 } };
      box.style.sfx.gap = i / 40;
      await tick();
      await frames(1);
    }
    expect(paintStage).not.toHaveBeenCalled();
    expect(paintCard).not.toHaveBeenCalled();
    sfxLive.on = false;
    await settle();
    expect(paintStage).toHaveBeenCalledTimes(1);
    // The gap is in the variations: those eight, once.
    expect(paintCard).toHaveBeenCalledTimes(8);
  });

  it('lets the gesture go when the pane goes', async () => {
    const { view } = await on();
    await fireEvent.pointerDown(view.getByRole('slider', { name: 'Power' }));
    expect(sfxLive.on).toBe(true);
    view.unmount();
    expect(sfxLive.on).toBe(false);
  });
});
