import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Canvas from './editor/Canvas.svelte';
import RailTools from './editor/RailTools.svelte';
import { app, loadProjectPages, page, setTool, addSfxBox } from './store.svelte.js';
import { setPref, prefs } from './prefs.svelte.js';
import { inspectorTab, effectsSubTab } from './inspector-tabs.svelte.js';
import { initHistory, resetHistory, undo } from './editor/history.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { clearLayoutMemo, setTypesetEnabled, typesetEnabled } from './measure.js';
import { sfxPick, sfxKinds } from './sfx.js';
import { domRustEngine } from '../test/dom-rust-engine.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

// ===========================================================================
// The SFX tool: the rail button, and a drag on the page that makes a sound
// ===========================================================================
// With the real engine, so the type is the auto pick's and the box is sized
// from the letters the engine places.

const original = { engine: textEngine(), typeset: typesetEnabled(), inherit: prefs.inheritBoxStyle };
let rust;
let restoreCanvas;
beforeAll(async () => {
  restoreCanvas = installFakeCanvas();
  setTypesetEnabled(true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  rust = await domRustEngine();
});
afterAll(() => {
  vi.unstubAllGlobals();
  restoreCanvas();
  setTypesetEnabled(original.typeset);
});
beforeEach(() => {
  setTextEngine(rust);
  clearLayoutMemo();
  setPref('inheritBoxStyle', true);
  app.lastStyle = normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 20 });
  initHistory();
  resetHistory();
});
afterEach(() => {
  cleanup();
  setTool('place');
  setPref('sfxTool', true);
  setPref('inheritBoxStyle', original.inherit);
  setTextEngine(original.engine);
  clearLayoutMemo();
  loadProjectPages([]);
});

const open = (lines = []) => loadProjectPages([{ id: 1, w: 800, h: 1200, lines, boxes: [] }]);

describe('the rail', () => {
  it('has the SFX tool under Text, and it arms the tool', async () => {
    open();
    const view = render(RailTools);
    await tick();
    const names = [...view.container.querySelectorAll('.ed-rail-tools button[aria-label$="tool"]')].map((b) => b.getAttribute('aria-label'));
    expect(names.slice(0, 3)).toEqual(['Place tool', 'Text tool', 'SFX tool']);
    await fireEvent.click(view.getByRole('button', { name: 'SFX tool' }));
    expect(app.tool).toBe('sfx');
  });

  it('has no SFX tool while Settings has it off, and drops it when turned off', async () => {
    open();
    setTool('sfx');
    setPref('sfxTool', false);
    expect(app.tool).toBe('place');
    setTool('sfx');
    expect(app.tool).toBe('place');
    const view = render(RailTools);
    await tick();
    expect(view.queryByRole('button', { name: 'SFX tool' })).toBe(null);
  });

  it('is off under the browser engine, and refused', async () => {
    open();
    setTextEngine(original.engine);
    const view = render(RailTools);
    await tick();
    expect(view.getByRole('button', { name: 'SFX tool' }).disabled).toBe(true);
    setTool('sfx');
    expect(app.tool).toBe('place');
  });
});

describe('a drag on the page', () => {
  async function drag(from, to) {
    const view = render(Canvas);
    await tick();
    const layer = view.container.querySelector('.boxlayer');
    expect(layer).not.toBe(null);
    await fireEvent.pointerDown(layer, { button: 0, pointerId: 1, clientX: from[0], clientY: from[1] });
    await fireEvent.pointerMove(document, { pointerId: 1, clientX: to[0], clientY: to[1] });
    await fireEvent.pointerUp(document, { pointerId: 1, clientX: to[0], clientY: to[1] });
    await tick();
    return view;
  }

  it('makes one box with one path along the drag, of the auto-picked type', async () => {
    open();
    setTool('sfx');
    await drag([100, 200], [400, 260]);
    const boxes = page().boxes;
    expect(boxes).toHaveLength(1);
    const b = boxes[0];
    const sfx = b.style.sfx;
    expect(sfx.on).toBe(true);
    // No Japanese on the page and a project not read as Japanese: the stock
    // English sound.
    expect(page().lines.find((l) => l.n === b.lineN).en).toBe(app.projectOcrLanguage === 'ja' ? 'ドン!!' : 'BOOM!!');
    expect(sfx.kind).toBe(sfxPick(page().lines.find((l) => l.n === b.lineN).en).order[0]);
    expect(sfxKinds().map((k) => k.id)).toContain(sfx.kind);
    // The drag, in ems of the box's size from the box's centre.
    expect(sfx.paths).toHaveLength(1);
    const [p] = sfx.paths;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const em = b.style.size;
    expect(cx + p.a[0] * em).toBeCloseTo(100, 0);
    expect(cy + p.a[1] * em).toBeCloseTo(200, 0);
    expect(cx + p.b[0] * em).toBeCloseTo(400, 0);
    expect(cy + p.b[1] * em).toBeCloseTo(260, 0);
    // Selected, and the Inspector on its controls.
    expect(app.selectedId).toBe(b.id);
    expect(inspectorTab.id).toBe('effects');
    expect(effectsSubTab.id).toBe('sfx');
  });

  it('is one undo step, line and all', async () => {
    open();
    setTool('sfx');
    await drag([100, 200], [400, 200]);
    expect(page().boxes).toHaveLength(1);
    expect(page().lines).toHaveLength(1);
    undo();
    expect(page().boxes).toHaveLength(0);
    expect(page().lines).toHaveLength(0);
  });

  it('takes the queue line on show, picks its type from the Japanese, and moves the queue on', async () => {
    open([
      { n: 1, type: 'sfx', jp: 'ゴゴゴゴ', en: 'RUMBLE' },
      { n: 2, type: 'dialogue', jp: 'はい', en: 'Yes.' },
    ]);
    page().activeLineN = 1;
    setTool('sfx');
    await drag([100, 200], [500, 200]);
    const b = page().boxes[0];
    expect(b.lineN).toBe(1);
    expect(b.style.sfx.kind).toBe(sfxPick('ゴゴゴゴ').order[0]);
    expect(page().activeLineN).toBe(2);
  });

  it('says ドン!! over a Japanese page', () => {
    open([{ n: 1, type: 'dialogue', jp: 'はい', en: 'Yes.' }]);
    page().activeLineN = null;
    setTool('sfx');
    const id = addSfxBox({ x: 100, y: 100 }, { x: 300, y: 100 });
    const b = page().boxes.find((x) => x.id === id);
    expect(page().lines.find((l) => l.n === b.lineN).en).toBe('ドン!!');
  });

  it('makes nothing of a click', async () => {
    open();
    setTool('sfx');
    await drag([100, 200], [102, 201]);
    expect(page().boxes).toHaveLength(0);
  });
});
