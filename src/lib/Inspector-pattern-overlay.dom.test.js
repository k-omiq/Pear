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
import { loadedPatterns } from './pattern-library.svelte.js';

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

async function openFold(view, name) {
  const b = view.container.querySelector(`button.insp-fold[aria-label="${name}"]`);
  if (b && b.getAttribute('aria-expanded') !== 'true') {
    await fireEvent.click(b);
    await tick();
  }
}

describe('an effect pattern', () => {
  it('keeps a scale from 1 to 1000 %, in the model and the panel', async () => {
    expect(normalizePattern({ scale: 0.01 }).scale).toBe(0.01);
    expect(normalizePattern({ scale: 10 }).scale).toBe(10);
    expect(normalizePattern({ scale: 0.001 }).scale).toBe(0.01);
    expect(normalizePattern({ scale: 40 }).scale).toBe(10);
    const { view, box } = mounted({ patternOverlay: { on: true } });
    await tick();
    await openFold(view, 'Pattern');
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
    await openFold(view, 'Pattern');
    await openFold(view, 'Pattern overlay more options');
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

  it('shows its picked tile as a swatch, with Tone and Image', async () => {
    const { view, box } = mounted({ patternOverlay: { on: true, pattern: { kind: 'picked', src: SRC, cell: CELL, mode: 'image' } } });
    await tick();
    await openFold(view, 'Pattern');
    expect(view.getByRole('radio', { name: 'From page' }).getAttribute('aria-checked')).toBe('true');
    await press(view.getByRole('button', { name: 'Tone' }));
    expect(box().style.patternOverlay.pattern.mode).toBe('tone');
    undo();
    expect(box().style.patternOverlay.pattern.mode).toBe('image');
  });

  it('picks a pattern loaded from a .pat, and takes a set away', async () => {
    loadedPatterns.push({ src: SRC, name: 'Blue weave', set: 'Fabric', w: 12, h: 8, card: '' });
    try {
      const { view, box } = mounted({ patternOverlay: { on: true } });
      await tick();
      await openFold(view, 'Pattern');
      await press(view.getByRole('radio', { name: 'Blue weave' }));
      await vi.waitFor(() => expect(box().style.patternOverlay.pattern).toMatchObject({ kind: 'picked', src: SRC, cell: [12, 0, 0, 8], mode: 'image', scale: 1 }));
      await tick();
      expect(view.getByRole('radio', { name: 'Blue weave' }).getAttribute('aria-checked')).toBe('true');
      await fireEvent.click(view.getByLabelText('Remove the Fabric patterns'));
      await tick();
      expect(view.queryByRole('radio', { name: 'Blue weave' })).toBeNull();
      // The box keeps the pattern it has.
      expect(box().style.patternOverlay.pattern.src).toBe(SRC);
    } finally {
      loadedPatterns.length = 0;
    }
  });

  it('starts a pick for the effect it belongs to', async () => {
    const { view } = mounted({ patternOverlay: { on: true } });
    await tick();
    await openFold(view, 'Pattern');
    // The fake painter cannot extract a tile, so the button is shown, off.
    expect(view.getByLabelText('Pattern overlay pick from page').disabled).toBe(true);
    startPatternPick(1, 'b', 'patternOverlay.pattern');
    expect(patternPick.target).toBe('patternOverlay.pattern');
    startPatternPick(1, 'b', 'style.font');
    expect(patternPick.target).toBe('pattern');
  });
});

describe('the fill tab', () => {
  it('offers no pattern fill: patterns are the overlay\'s', async () => {
    const { view } = mounted();
    await tick();
    const fill = view.getByRole('group', { name: 'Fill' });
    expect([...fill.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean)).toEqual(['Solid', 'Gradient']);
  });

  it('moves an old pattern fill that could not move by itself, as one undo step', async () => {
    const { view, box } = mounted({ pattern: { on: true, kind: 'grid', bgOpacity: 0.5 } });
    await tick();
    expect(box().style.pattern.on).toBe(true);
    await press(view.getByRole('button', { name: 'Move it to the Pattern overlay' }));
    expect(box().style.pattern.on).toBe(false);
    expect(box().style.patternOverlay).toMatchObject({ on: true, blend: 'normal', opacity: 1, pattern: { kind: 'grid', bgOpacity: 0.5 } });
    undo();
    expect(box().style.pattern.on).toBe(true);
    expect(box().style.patternOverlay.on).toBe(false);
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
