import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The contour editor: every effect's Contour menu has Custom and an Edit
// button, and the editor draws a curve from 0 to 255 point by point. Each
// edit is the box's style and one undo step.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page, settleEdits } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo, redo } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle, newShadow, CONTOUR_MAX_POINTS } from './data.js';
import { CONTOUR_PRESET_POINTS } from './contour-presets.js';
import { installFakeCanvas } from '../test/fake-canvas.js';
import { openFxFolds } from '../test/inspector-folds.js';

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
});

function mounted(style, sub = 'shadow') {
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'HELLO' }], boxes: [{ id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style: normalizeStyle({ ...defaultStyle(), ...style }) }] }]);
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.selectedId = 'b';
  setInspectorTab('effects');
  setEffectsSubTab(sub);
  const view = render(Inspector);
  return { view, box: () => page().boxes[0] };
}

// A real edit starts with a press (it arms the step) and ends with a pause.
async function edit(el, type, value) {
  await fireEvent.pointerDown(el);
  await fireEvent[type](el, { target: { value } });
  settleEdits();
}
async function press(el) {
  await fireEvent.pointerDown(el);
  await fireEvent.click(el);
  settleEdits();
}

// The plot is 172 units across (160 and a 6 pad each side): laid out at
// that size from the corner, a client pixel is a plot unit.
function plotOf(view, title) {
  const svg = view.getByRole('slider', { name: new RegExp(`^${title} curve`) });
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 172, height: 172, right: 172, bottom: 172 });
  svg.setPointerCapture = () => {};
  return svg;
}
// Client coordinates of the level (x, y).
const at = (x, y) => ({ clientX: 6 + (x / 255) * 160, clientY: 166 - (y / 255) * 160, button: 0, pointerId: 1 });

const shadow = () => ({ shadows: [{ ...newShadow({ angle: 120 }), useGlobalLight: false }] });
const pts = (box) => box().style.shadows[0].contour.pts;

describe('the contour menus', () => {
  it('lists Custom and an Edit button for every effect contour', async () => {
    const { view } = mounted({ ...shadow(), innerShadows: [{ ...newShadow({ angle: 120 }) }] });
    await tick();
    await openFxFolds(view);
    for (const name of ['Shadow 1 contour', 'Inner shadow 1 contour']) {
      expect([...view.getByLabelText(name).options].map((o) => o.value)).toContain('custom');
      expect(view.getByLabelText(`${name}: edit the curve`)).toBeTruthy();
    }
    cleanup();
    const glow = mounted({ outerGlow: { on: true }, innerGlow: { on: true }, satin: { on: true } }, 'glow').view;
    await tick();
    await openFxFolds(glow);
    for (const name of ['Outer glow contour', 'Inner glow contour', 'Satin contour']) expect(glow.getByLabelText(`${name}: edit the curve`).disabled).toBe(false);
    cleanup();
    const bevel = mounted({ bevel: { on: true, contour: { on: true } } }, 'bevel').view;
    await tick();
    await openFxFolds(bevel);
    for (const name of ['Bevel gloss contour', 'Bevel contour curve']) expect(bevel.getByLabelText(`${name}: edit the curve`)).toBeTruthy();
  });

  it('turns a preset into a custom curve through its own points, as one undo step', async () => {
    const { view, box } = mounted({ shadows: [{ ...newShadow({ angle: 120 }), contour: { preset: 'cone', aa: true } }] });
    await tick();
    await openFxFolds(view);
    await edit(view.getByLabelText('Shadow 1 contour'), 'change', 'custom');
    const c = box().style.shadows[0].contour;
    expect(c).toMatchObject({ preset: 'custom', aa: true });
    expect(c.pts.map((p) => p.slice(0, 2))).toEqual(CONTOUR_PRESET_POINTS.cone.map(([x, y]) => [x * 255, y * 255]));
    // And the editor opened on it.
    await tick();
    expect(view.getByRole('dialog', { name: 'Shadow 1 contour editor' })).toBeTruthy();
    undo();
    expect(box().style.shadows[0].contour).toEqual({ preset: 'cone', aa: true });
  });
});

describe('the contour editor', () => {
  it('adds a point where the square is clicked, and the drag moves it, one step', async () => {
    const { view, box } = mounted(shadow());
    await tick();
    await openFxFolds(view);
    await press(view.getByLabelText('Shadow 1 contour: edit the curve'));
    await tick();
    const svg = plotOf(view, 'Shadow 1 contour');
    await fireEvent.pointerDown(svg, at(128, 64));
    expect(pts(box)).toEqual([[0, 0, false], [128, 64, false], [255, 255, false]]);
    await fireEvent.pointerMove(svg, at(100, 200));
    await fireEvent.pointerUp(svg, at(100, 200));
    settleEdits();
    expect(pts(box)[1]).toEqual([100, 200, false]);
    // The square says which point it holds and where.
    await tick();
    expect(svg.getAttribute('aria-valuenow')).toBe('200');
    expect(svg.getAttribute('aria-valuetext')).toBe('Point 2 of 3: input 100, output 200');
    // A drag cannot carry a point past or onto its neighbour's x.
    await fireEvent.pointerDown(svg, at(100, 200));
    await fireEvent.pointerMove(svg, at(300, 200));
    await fireEvent.pointerUp(svg);
    settleEdits();
    expect(pts(box)[1]).toEqual([254, 200, false]);
    undo();
    expect(pts(box)[1]).toEqual([100, 200, false]);
    undo();
    expect(box().style.shadows[0].contour.preset).toBe('linear');
    redo();
    expect(pts(box)[1]).toEqual([100, 200, false]);
  });

  it('edits the chosen point by its fields, makes it a corner, and deletes it', async () => {
    const { view, box } = mounted({ shadows: [{ ...newShadow({ angle: 120 }), contour: { preset: 'custom', pts: [[0, 0], [128, 64], [255, 255]] } }] });
    await tick();
    await openFxFolds(view);
    await press(view.getByLabelText('Shadow 1 contour: edit the curve'));
    await tick();
    const svg = plotOf(view, 'Shadow 1 contour');
    // Pressing on a point chooses it rather than adding one.
    await fireEvent.pointerDown(svg, at(129, 66));
    await fireEvent.pointerUp(svg);
    settleEdits();
    expect(pts(box)).toHaveLength(3);
    await tick();
    expect(view.getByText('Point 2 of 3')).toBeTruthy();
    await edit(view.getByLabelText('Shadow 1 contour point output'), 'change', '180');
    expect(pts(box)[1]).toEqual([128, 180, false]);
    await edit(view.getByLabelText('Shadow 1 contour point input'), 'change', '40');
    expect(pts(box)[1]).toEqual([40, 180, false]);
    const corner = view.getByLabelText('Shadow 1 contour point corner');
    await fireEvent.pointerDown(corner);
    await fireEvent.click(corner);
    settleEdits();
    expect(pts(box)[1]).toEqual([40, 180, true]);
    undo();
    expect(pts(box)[1]).toEqual([40, 180, false]);
    await tick();
    // The undone style is a new shadow, so the editor starts over: choose it again.
    const again = plotOf(view, 'Shadow 1 contour');
    await fireEvent.pointerDown(again, at(40, 180));
    await fireEvent.pointerUp(again);
    settleEdits();
    await tick();
    await press(view.getByLabelText('Shadow 1 contour delete point'));
    expect(pts(box)).toEqual([[0, 0, false], [255, 255, false]]);
    await tick();
    // Two points are the least a curve has.
    expect(view.getByLabelText('Shadow 1 contour delete point').disabled).toBe(true);
    undo();
    expect(pts(box)).toHaveLength(3);
  });

  it('starts from a preset, and stops adding at the most points a contour keeps', async () => {
    const many = Array.from({ length: CONTOUR_MAX_POINTS }, (_, i) => [i * 4, (i * 37) % 256]);
    const { view, box } = mounted({ shadows: [{ ...newShadow({ angle: 120 }), contour: { preset: 'custom', pts: many } }] });
    await tick();
    await openFxFolds(view);
    await press(view.getByLabelText('Shadow 1 contour: edit the curve'));
    await tick();
    const svg = plotOf(view, 'Shadow 1 contour');
    await fireEvent.pointerDown(svg, at(254, 10));
    await fireEvent.pointerUp(svg);
    settleEdits();
    expect(pts(box)).toHaveLength(CONTOUR_MAX_POINTS);
    await edit(view.getByLabelText('Shadow 1 contour start from'), 'change', 'gaussian');
    const c = box().style.shadows[0].contour;
    expect(c.preset).toBe('custom');
    expect(c.pts).toHaveLength(CONTOUR_PRESET_POINTS.gaussian.length);
    expect(c.pts[5]).toEqual([Math.round(0.383 * 2550) / 10, Math.round(0.414 * 2550) / 10, true]);
    undo();
    expect(pts(box)).toHaveLength(CONTOUR_MAX_POINTS);
  });

  it('edits a bevel gloss contour and closes on Done', async () => {
    const { view, box } = mounted({ bevel: { on: true } }, 'bevel');
    await tick();
    await openFxFolds(view);
    await press(view.getByLabelText('Bevel gloss contour: edit the curve'));
    await tick();
    const svg = plotOf(view, 'Bevel gloss contour');
    await fireEvent.pointerDown(svg, at(64, 200));
    await fireEvent.pointerUp(svg);
    settleEdits();
    expect(box().style.bevel.gloss.pts).toEqual([[0, 0, false], [64, 200, false], [255, 255, false]]);
    await press(view.getByLabelText('Bevel gloss contour done'));
    await tick();
    expect(view.queryByRole('dialog', { name: 'Bevel gloss contour editor' })).toBeNull();
  });
});
