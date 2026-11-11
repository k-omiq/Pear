import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// Effects ▸ Surface ▸ Special: Crack, Lightning, Splash and Scratches, each a
// switch that opens its settings. Each change is one undo step. Only the
// Rust engine paints them, so under the browser engine the switches are
// dimmed and the group says why.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page, settleEdits } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo, peekStack } from './editor/history.svelte.js';
import { engineSwitch } from './engine-switch.svelte.js';
import { glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

const before = glyphPainter();
let restoreCanvas;
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterAll(() => {
  vi.unstubAllGlobals();
  restoreCanvas();
});
beforeEach(() => {
  initHistory();
  resetHistory();
});
afterEach(() => {
  cleanup();
  app.selectedId = null;
  loadProjectPages([]);
  engineSwitch.painting = false;
  setGlyphPainter(before);
  setEffectsSubTab('stroke');
});

function mounted(rust = true, special = {}, more = {}) {
  const style = normalizeStyle({ ...defaultStyle(), special, ...more });
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'HELLO' }], boxes: [{ id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style }] }]);
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.selectedId = 'b';
  if (rust) {
    setGlyphPainter({ ...before, box: true, special: true });
    engineSwitch.painting = true;
  }
  setInspectorTab('effects');
  setEffectsSubTab('special');
  const view = render(Inspector);
  return { view, box: () => page().boxes[0] };
}
const records = () => peekStack().undo.length;

describe('the Special panel', () => {
  it('is in the Surface group, four rows, each off with its settings shut', async () => {
    const { view } = mounted();
    await tick();
    expect(view.getByRole('tab', { name: 'Surface' }).getAttribute('aria-selected')).toBe('true');
    for (const name of ['Crack', 'Lightning', 'Splash', 'Scratches']) {
      const sw = view.getByRole('switch', { name });
      expect(sw.disabled).toBe(false);
      expect(sw.getAttribute('aria-checked')).toBe('false');
    }
    expect(view.queryByLabelText('Crack seed')).toBe(null);
    expect(view.container.textContent).not.toContain('Special effects need the Rust text engine');
  });

  it('a switch opens the row, and switch, seed and dice are one undo step each', async () => {
    const { view, box } = mounted();
    await tick();
    const base = records();
    const sw = view.getByRole('switch', { name: 'Lightning' });
    await fireEvent.pointerDown(sw);
    await fireEvent.click(sw);
    settleEdits();
    expect(box().style.special.lightning.on).toBe(true);
    expect(records()).toBe(base + 1);
    await tick();
    expect(view.getByLabelText('Lightning core colour hex')).toBeTruthy();
    expect(view.getByLabelText('Lightning glow colour hex')).toBeTruthy();
    expect(view.getByLabelText('Lightning glow size')).toBeTruthy();
    expect(view.queryByLabelText('Lightning angle, degrees')).toBe(null);

    const seed = view.getByLabelText('Lightning seed');
    await fireEvent.pointerDown(seed);
    await fireEvent.change(seed, { target: { value: '41.6' } });
    settleEdits();
    expect(box().style.special.lightning.seed).toBe(42);
    expect(records()).toBe(base + 2);

    const dice = view.getByRole('button', { name: 'New lightning seed' });
    await fireEvent.pointerDown(dice);
    await fireEvent.click(dice);
    settleEdits();
    expect(box().style.special.lightning.seed).not.toBe(42);
    expect(records()).toBe(base + 3);
    undo();
    expect(box().style.special.lightning.seed).toBe(42);
  });

  it('a crack and a splash have a size, a splash a colour, a scratch an angle', async () => {
    const { view } = mounted(true, { crack: { on: true }, splash: { on: true }, scratches: { on: true } });
    await tick();
    expect(view.getByLabelText('Crack size')).toBeTruthy();
    expect(view.getByLabelText('Splash size')).toBeTruthy();
    expect(view.getByLabelText('Splash colour hex')).toBeTruthy();
    expect(view.getByLabelText('Crack focus x')).toBeTruthy();
    expect(view.getByLabelText('Crack focus y')).toBeTruthy();
    expect(view.getByLabelText('Crack spread')).toBeTruthy();
    expect(view.getByLabelText('Crack break off')).toBeTruthy();
    expect(view.getByLabelText('Scratches angle, degrees')).toBeTruthy();
    expect(view.queryByLabelText('Crack angle, degrees')).toBe(null);
  });

  it('Motion shows only past Break off 0, reads Fall by default, and a pick is one undo step', async () => {
    const { view } = mounted(true, { crack: { on: true } });
    await tick();
    expect(view.queryByRole('group', { name: 'Crack motion' })).toBe(null);
    cleanup();
    const again = mounted(true, { crack: { on: true, breakOff: 40 } });
    await tick();
    const group = again.view.getByRole('group', { name: 'Crack motion' });
    const fall = again.view.getByRole('button', { name: 'Fall' });
    const apart = again.view.getByRole('button', { name: 'Apart' });
    expect(group.contains(fall)).toBe(true);
    expect(fall.getAttribute('aria-pressed')).toBe('true');
    const base = records();
    await fireEvent.pointerDown(apart);
    await fireEvent.click(apart);
    settleEdits();
    expect(again.box().style.special.crack.motion).toBe('apart');
    expect(records()).toBe(base + 1);
    undo();
    expect(again.box().style.special.crack.motion).toBe('fall');
  });

  it('Outline shows only with cuts and a box stroke, reads Fills cuts by default, and a pick is one undo step', async () => {
    const k0 = defaultStyle().strokeEffects[0];
    const boxStroke = { strokeEffects: [{ ...k0, on: true, size: 4, opacity: 1, position: 'center' }] };
    const band = { strokeEffects: [{ ...k0, on: true, size: 4, opacity: 1, position: 'outside' }] };
    const cases = [
      [{ crack: { on: true } }, {}, false],
      [{ crack: { on: true } }, band, false],
      [{ lightning: { on: true } }, boxStroke, false],
      [{ scratches: { on: true } }, boxStroke, true],
    ];
    for (const [special, more, shown] of cases) {
      const { view } = mounted(true, special, more);
      await tick();
      expect(!!view.queryByRole('group', { name: 'Special outline' }), JSON.stringify(special)).toBe(shown);
      cleanup();
    }
    const { view, box } = mounted(true, { crack: { on: true } }, boxStroke);
    await tick();
    const fills = view.getByRole('button', { name: 'Fills cuts' });
    const through = view.getByRole('button', { name: 'Cut through' });
    expect(fills.getAttribute('aria-pressed')).toBe('true');
    const base = records();
    await fireEvent.pointerDown(through);
    await fireEvent.click(through);
    settleEdits();
    expect(box().style.special.outline).toBe('cut-through');
    expect(records()).toBe(base + 1);
    undo();
    expect(box().style.special.outline).toBe('fills-cuts');
  });

  it('under the browser engine, the switches are dimmed and the group says why; one on can still go off', async () => {
    const { view, box } = mounted(false, { crack: { on: true } });
    await tick();
    expect(view.container.textContent).toContain('Special effects need the Rust text engine');
    expect(view.getByRole('switch', { name: 'Splash' }).disabled).toBe(true);
    const crack = view.getByRole('switch', { name: 'Crack' });
    expect(crack.disabled).toBe(false);
    expect(view.getByLabelText('Crack seed').disabled).toBe(true);
    await fireEvent.click(crack);
    expect(box().style.special.crack.on).toBe(false);
  });
});
