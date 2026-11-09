import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The one gradient editor: its flat mode edits the text fill's gradient
// (`style.gradient`: one list of stops, each with its own opacity), its
// default mode an effect gradient (opacity stops apart, midpoints).
import FxGradientEditor from './FxGradientEditor.svelte';
import { app, loadProjectPages, page } from './store.svelte.js';
import { defaultStyle, normalizeStyle, GRADIENT_MAX_STOPS, GRADIENT_MIN_STOPS } from './data.js';

afterEach(() => {
  cleanup();
  app.selectedId = null;
  loadProjectPages([]);
});

const T = 'Fill gradient';

// The box's fill gradient as the app holds it (a deep `$state` proxy, so the
// editor re-renders on its own edits), behind a window that counts every
// read or write of `opacityStops`.
function flatEditor(stops) {
  const style = normalizeStyle({ ...defaultStyle(), gradient: { ...defaultStyle().gradient, on: true, stops } });
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [{ id: 'b', lineN: 1, text: null, x: 0, y: 0, w: 100, h: 100, style }] }]);
  const real = page().boxes[0].style.gradient;
  const touched = { opacityStops: 0 };
  const g = new Proxy(real, {
    get(t, k) {
      if (k === 'opacityStops') touched.opacityStops++;
      return Reflect.get(t, k);
    },
    set(t, k, v) {
      if (k === 'opacityStops') touched.opacityStops++;
      return Reflect.set(t, k, v);
    },
    has(t, k) {
      if (k === 'opacityStops') touched.opacityStops++;
      return Reflect.has(t, k);
    },
  });
  const onchange = vi.fn();
  const oncolour = vi.fn((st, key, hex) => {
    st[key] = hex;
    onchange();
  });
  const view = render(FxGradientEditor, { props: { flat: true, g, title: T, onchange, oncolour } });
  const ramp = view.container.querySelector('.fxg-ramp');
  ramp.getBoundingClientRect = () => /** @type {DOMRect} */ ({ left: 0, top: 0, width: 200, height: 24, right: 200, bottom: 24, x: 0, y: 0, toJSON() {} });
  return { view, g: real, onchange, oncolour, touched, rail: view.container.querySelector('.fxg-rail') };
}

const two = () => [
  { color: '#000000', pos: 0, opacity: 1 },
  { color: '#ffffff', pos: 1, opacity: 0 },
];
const stops = (g) => g.stops.map((st) => ({ ...st }));
const noMids = (g) => g.stops.every((st) => !('mid' in st));
const field = (view, name) => /** @type {HTMLInputElement} */ (view.getByRole(name === 'hex' ? 'textbox' : 'spinbutton', { name: `${T} stop ${name === 'hex' ? 'hex colour' : name}` }));

describe('the gradient editor, flat', () => {
  it('has one rail of stops, no opacity rail and no midpoints', async () => {
    const { view, touched } = flatEditor(two());
    await tick();
    expect(view.getAllByRole('button', { name: new RegExp(`^${T} stop \\d`) })).toHaveLength(2);
    expect(view.getByRole('button', { name: `${T} stop 2 at 100 percent` })).toBeTruthy();
    expect(view.container.querySelectorAll('.fxg-rail')).toHaveLength(1);
    expect(view.container.querySelector('.fxg-mid')).toBeNull();
    expect(view.queryByRole('button', { name: /opacity stop|midpoint/ })).toBeNull();
    // The ramp shows each stop's opacity.
    const css = view.container.querySelector('.fxg-ramp').style.backgroundImage;
    expect(css).toMatch(/rgba?\(0, 0, 0(, 1)?\) 0%.*rgba\(255, 255, 255, 0\) 100%/);
    expect(view.getByText('Stop 1 of 2')).toBeTruthy();
    expect(touched.opacityStops).toBe(0);
  });

  it('adds a stop where the rail is clicked, in the colour and opacity already there', async () => {
    const { view, g, onchange, touched, rail } = flatEditor(two());
    await tick();
    await fireEvent.pointerDown(rail, { clientX: 100 });
    await tick();
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(stops(g).map((s) => s.pos)).toEqual([0, 0.5, 1]);
    expect(g.stops[1].color).toBe('#808080');
    expect(g.stops[1].opacity).toBeCloseTo(0.5);
    // The new one is selected.
    expect(field(view, 'position').value).toBe('50');
    expect(field(view, 'opacity').value).toBe('50');
    expect(view.getByText('Stop 2 of 3')).toBeTruthy();
    expect(touched.opacityStops).toBe(0);
    expect(noMids(g)).toBe(true);
  });

  it('moves the focused stop with the arrow keys, Shift for 10 %, re-sorted, the selection following', async () => {
    const { view, g, onchange } = flatEditor([
      { color: '#000000', pos: 0, opacity: 1 },
      { color: '#ff0000', pos: 0.4, opacity: 1 },
      { color: '#ffffff', pos: 0.45, opacity: 1 },
    ]);
    await tick();
    const red = view.getByRole('button', { name: `${T} stop 2 at 40 percent` });
    await fireEvent.keyDown(red, { key: 'ArrowRight' });
    await tick();
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(g.stops[1].pos).toBe(0.41);
    await fireEvent.keyDown(view.getByRole('button', { name: `${T} stop 2 at 41 percent` }), { key: 'ArrowRight', shiftKey: true });
    await tick();
    expect(onchange).toHaveBeenCalledTimes(2);
    // Past its neighbour: sorted, and the red stop is still the selected one.
    expect(stops(g).map((s) => [s.color, s.pos])).toEqual([
      ['#000000', 0],
      ['#ffffff', 0.45],
      ['#ff0000', 0.51],
    ]);
    expect(field(view, 'hex').value).toBe('#ff0000');
    expect(view.getByRole('button', { name: `${T} stop 3 at 51 percent` }).getAttribute('aria-pressed')).toBe('true');
  });

  it('drags a stop along the rail, sorting it when let go', async () => {
    const { view, g, onchange } = flatEditor([
      { color: '#000000', pos: 0.1, opacity: 1 },
      { color: '#ff0000', pos: 0.2, opacity: 1 },
      { color: '#ffffff', pos: 1, opacity: 1 },
    ]);
    await tick();
    const red = view.getByRole('button', { name: `${T} stop 2 at 20 percent` });
    await fireEvent.pointerDown(red, { clientX: 40 });
    expect(g.stops).toHaveLength(3);
    await fireEvent.pointerMove(red, { clientX: 100 });
    await fireEvent.pointerMove(red, { clientX: 100 });
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(g.stops[1].pos).toBe(0.5);
    await fireEvent.pointerUp(red);
    // Still in order: nothing to sort, no extra step.
    expect(onchange).toHaveBeenCalledTimes(1);
    const again = view.getByRole('button', { name: `${T} stop 2 at 50 percent` });
    await fireEvent.pointerDown(again);
    await fireEvent.pointerMove(again, { clientX: 0 });
    await fireEvent.pointerUp(again);
    await tick();
    expect(onchange).toHaveBeenCalledTimes(3);
    expect(stops(g).map((s) => s.color)).toEqual(['#ff0000', '#000000', '#ffffff']);
    expect(field(view, 'hex').value).toBe('#ff0000');
  });

  it('deletes a stop by key or button, never below the minimum', async () => {
    const { view, g, onchange } = flatEditor([
      { color: '#000000', pos: 0, opacity: 1 },
      { color: '#ff0000', pos: 0.5, opacity: 1 },
      { color: '#ffffff', pos: 1, opacity: 1 },
    ]);
    await tick();
    await fireEvent.keyDown(view.getByRole('button', { name: `${T} stop 2 at 50 percent` }), { key: 'Delete' });
    await tick();
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(stops(g).map((s) => s.color)).toEqual(['#000000', '#ffffff']);
    expect(g.stops).toHaveLength(GRADIENT_MIN_STOPS);
    const del = view.getByRole('button', { name: `${T} delete stop` });
    expect(del.disabled).toBe(true);
    await fireEvent.keyDown(view.getByRole('button', { name: `${T} stop 1 at 0 percent` }), { key: 'Backspace' });
    await fireEvent.click(del);
    expect(g.stops).toHaveLength(GRADIENT_MIN_STOPS);
    expect(onchange).toHaveBeenCalledTimes(1);
  });

  it('adds stops up to the maximum and no further', async () => {
    const { view, g, onchange, rail } = flatEditor(two());
    await tick();
    const add = view.getByRole('button', { name: `${T} add stop` });
    for (let k = g.stops.length; k < GRADIENT_MAX_STOPS; k++) {
      await fireEvent.click(add);
      await tick();
    }
    expect(g.stops).toHaveLength(GRADIENT_MAX_STOPS);
    expect(onchange).toHaveBeenCalledTimes(GRADIENT_MAX_STOPS - 2);
    // The first lands in the widest gap: the middle.
    expect(g.stops.map((s) => s.pos)).toContain(0.5);
    expect(g.stops.map((s) => s.pos)).toEqual([...g.stops.map((s) => s.pos)].sort((a, b) => a - b));
    expect(add.disabled).toBe(true);
    await fireEvent.pointerDown(rail, { clientX: 10 });
    expect(g.stops).toHaveLength(GRADIENT_MAX_STOPS);
    expect(onchange).toHaveBeenCalledTimes(GRADIENT_MAX_STOPS - 2);
  });

  it('edits position and opacity on change, clamped, the field showing the clamped value', async () => {
    const { view, g, onchange, touched } = flatEditor([
      { color: '#000000', pos: 0, opacity: 1 },
      { color: '#ff0000', pos: 0.3, opacity: 1 },
      { color: '#ffffff', pos: 0.6, opacity: 1 },
    ]);
    await tick();
    await fireEvent.pointerDown(view.getByRole('button', { name: `${T} stop 2 at 30 percent` }));
    await fireEvent.pointerUp(view.getByRole('button', { name: `${T} stop 2 at 30 percent` }));
    await tick();
    const op = field(view, 'opacity');
    await fireEvent.input(op, { target: { value: '40' } });
    expect(onchange).not.toHaveBeenCalled();
    await fireEvent.change(op, { target: { value: '140' } });
    expect(op.value).toBe('100');
    expect(onchange).not.toHaveBeenCalled(); // it was 100 already
    await fireEvent.change(op, { target: { value: '-5' } });
    expect(op.value).toBe('0');
    expect(g.stops[1].opacity).toBe(0);
    expect(onchange).toHaveBeenCalledTimes(1);
    const pos = field(view, 'position');
    await fireEvent.change(pos, { target: { value: '250' } });
    await tick();
    expect(onchange).toHaveBeenCalledTimes(2);
    expect(stops(g).map((s) => [s.color, s.pos])).toEqual([
      ['#000000', 0],
      ['#ffffff', 0.6],
      ['#ff0000', 1],
    ]);
    expect(field(view, 'position').value).toBe('100');
    expect(field(view, 'hex').value).toBe('#ff0000');
    expect(view.getByText('Stop 3 of 3')).toBeTruthy();
    expect(touched.opacityStops).toBe(0);
    expect(noMids(g)).toBe(true);
  });

  it('sets a colour through oncolour from the hex field, and flags a bad one', async () => {
    const { view, g, oncolour } = flatEditor(two());
    await tick();
    const hex = field(view, 'hex');
    await fireEvent.change(hex, { target: { value: 'zz' } });
    expect(hex.classList.contains('hex-bad')).toBe(true);
    expect(oncolour).not.toHaveBeenCalled();
    await fireEvent.change(hex, { target: { value: '3366ff' } });
    expect(oncolour).toHaveBeenCalledTimes(1);
    expect(oncolour.mock.calls[0][1]).toBe('color');
    expect(oncolour.mock.calls[0][2]).toBe('#3366ff');
    expect(g.stops[0].color).toBe('#3366ff');
    expect(hex.classList.contains('hex-bad')).toBe(false);
  });
});

describe('the gradient editor, not flat', () => {
  it('still has its opacity rail and midpoint diamonds', async () => {
    const g = {
      stops: [
        { color: '#000000', pos: 0 },
        { color: '#ffffff', pos: 1 },
      ],
      opacityStops: [
        { opacity: 1, pos: 0 },
        { opacity: 0, pos: 1 },
      ],
    };
    const view = render(FxGradientEditor, { props: { g, title: 'Overlay', onchange: vi.fn(), oncolour: vi.fn() } });
    await tick();
    expect(view.container.querySelectorAll('.fxg-rail')).toHaveLength(2);
    expect(view.getAllByRole('button', { name: /^Overlay opacity stop/ })).toHaveLength(2);
    expect(view.getAllByRole('button', { name: /^Overlay colour stop/ })).toHaveLength(2);
    expect(view.getByRole('button', { name: 'Overlay colour midpoint 1 at 50 percent' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Overlay opacity midpoint 1 at 50 percent' })).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Overlay add stop' })).toBeNull();
  });
});
