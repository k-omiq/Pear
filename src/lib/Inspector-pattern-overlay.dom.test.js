import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// An effect's pattern (Pattern Overlay, pattern stroke, bevel Texture):
// Scale 1 to 1000 % as Photoshop's, Snap to Origin, and a tile taken from
// the page, either picked for the effect or the fill's own.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages, page, settleEdits } from './store.svelte.js';
import { setInspectorTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo, redo } from './editor/history.svelte.js';
import { defaultStyle, normalizeStyle, normalizePattern, patternSrcsUsed, stylePatterns } from './data.js';
import { engineSwitch } from './engine-switch.svelte.js';
import { glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { patternPick, startPatternPick, cancelPatternPick, patternAtPath } from './pattern-pick.svelte.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

const SRC = 'ab'.repeat(8) + '.png';
const CELL = [6, 0, 0, 6];

let restoreCanvas;
const before = glyphPainter();
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
  cancelPatternPick();
});

// A real edit starts with a pointer press, which arms the panel's
// before-snapshot, and a pause ends its burst.
async function press(el) {
  await fireEvent.pointerDown(el);
  await fireEvent.click(el);
  settleEdits();
}

function mounted(over = {}) {
  const style = normalizeStyle({ ...defaultStyle(), ...over });
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'HELLO' }], boxes: [{ id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style }] }]);
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.selectedId = 'b';
  setGlyphPainter({ ...before, box: true, screen: true });
  engineSwitch.painting = true;
  setInspectorTab('fill');
  const view = render(Inspector);
  return { view, box: () => page().boxes[0] };
}

describe('an effect pattern', () => {
  it('keeps a scale from 1 to 1000 %, in the model and the panel', async () => {
    expect(normalizePattern({ scale: 0.01 }).scale).toBe(0.01);
    expect(normalizePattern({ scale: 10 }).scale).toBe(10);
    expect(normalizePattern({ scale: 0.001 }).scale).toBe(0.01);
    expect(normalizePattern({ scale: 40 }).scale).toBe(10);
    const { view, box } = mounted({ patternOverlay: { on: true } });
    await tick();
    const field = view.getByLabelText('Pattern overlay scale, percent');
    await fireEvent.change(field, { target: { value: '1000' } });
    expect(box().style.patternOverlay.pattern.scale).toBe(10);
    await fireEvent.change(field, { target: { value: '1' } });
    expect(box().style.patternOverlay.pattern.scale).toBe(0.01);
    await fireEvent.change(field, { target: { value: '5000' } });
    expect(box().style.patternOverlay.pattern.scale).toBe(10);
    expect(field.value).toBe('1000');
  });

  it('snaps to the origin: the phase goes back to 0, as one undo step', async () => {
    const { view, box } = mounted({ patternOverlay: { on: true, pattern: { ox: 0.3, oy: 0.6 } } });
    await tick();
    const snap = view.getByLabelText('Pattern overlay snap to origin');
    expect(snap.disabled).toBe(false);
    await press(snap);
    expect(box().style.patternOverlay.pattern).toMatchObject({ ox: 0, oy: 0 });
    await tick();
    expect(view.getByLabelText('Pattern overlay snap to origin').disabled).toBe(true);
    undo();
    expect(box().style.patternOverlay.pattern).toMatchObject({ ox: 0.3, oy: 0.6 });
    redo();
    expect(box().style.patternOverlay.pattern).toMatchObject({ ox: 0, oy: 0 });
  });

  it("takes the fill's picked tile, then offers it as a kind, with Tone and Image", async () => {
    const pattern = { on: false, kind: 'picked', src: SRC, cell: CELL, mode: 'image' };
    const { view, box } = mounted({ pattern, patternOverlay: { on: true } });
    await tick();
    const kind = view.getByLabelText('Pattern overlay kind');
    expect([...kind.options].map((o) => o.value)).not.toContain('picked');
    await press(view.getByLabelText("Pattern overlay use the fill's tone"));
    const p = box().style.patternOverlay.pattern;
    expect(p).toMatchObject({ kind: 'picked', src: SRC, cell: CELL, mode: 'image', scale: 1, ox: 0, oy: 0 });
    // Still picked once the style is normalised (it has its tile).
    expect(normalizeStyle(box().style).patternOverlay.pattern.kind).toBe('picked');
    await tick();
    expect([...view.getByLabelText('Pattern overlay kind').options].map((o) => o.value)).toContain('picked');
    await press(view.getByRole('button', { name: 'Tone' }));
    expect(box().style.patternOverlay.pattern.mode).toBe('tone');
    undo();
    expect(box().style.patternOverlay.pattern.mode).toBe('image');
  });

  it('starts a pick for the effect it belongs to', async () => {
    const { view } = mounted({ patternOverlay: { on: true } });
    await tick();
    // The fake painter cannot extract a tile, so the button is shown, off.
    expect(view.getByLabelText('Pattern overlay pick from page').disabled).toBe(true);
    startPatternPick(1, 'b', 'patternOverlay.pattern');
    expect(patternPick.target).toBe('patternOverlay.pattern');
    startPatternPick(1, 'b', 'style.font');
    expect(patternPick.target).toBe('pattern');
  });
});

describe('the patterns a style holds', () => {
  it('finds a picked tile in an overlay, a stroke and a bevel texture', () => {
    const style = normalizeStyle({
      ...defaultStyle(),
      patternOverlay: { on: true, pattern: { kind: 'picked', src: SRC, cell: CELL } },
      strokeEffects: [{ size: 3, fill: 'pattern', pattern: { kind: 'picked', src: 'cd'.repeat(8) + '.png', cell: CELL } }],
    });
    expect(stylePatterns(style)).toHaveLength(4);
    expect([...patternSrcsUsed([{ boxes: [{ style }] }])].sort()).toEqual([SRC, 'cd'.repeat(8) + '.png'].sort());
    expect(patternAtPath(style, 'strokeEffects.0.pattern')).toBe(style.strokeEffects[0].pattern);
    expect(patternAtPath(style, 'strokeEffects.4.pattern')).toBeNull();
    expect(patternAtPath(style, 'font')).toBeNull();
  });
});
