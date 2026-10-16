import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';

import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, setZoom } from './store.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

// ===========================================================================
// A zoom is one picture scaled: the text holds its place on the page
// ===========================================================================
// Zooming the editor rescales the page art, so every box drawn over it has to
// rescale with it and nothing else. Anything a box works out again at each
// zoom from a measurement taken AT that zoom moves the letters against the art
// whenever the measurement is not exactly in proportion to the zoom - and on a
// pinch, which steps the zoom sixty times a second, that is a shake.
//
// The measuring engine here answers the font's ascent and descent in whole
// pixels, as WebKit's canvas does (23 px at 26 px type, 24 px at 26.26 px),
// while the letters' own ink is in proportion: the shape that made the ink
// centring shake.

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 26, ...over });

const ink = (face, text) => {
  const width = text.length * face.size * 0.5;
  return { width, left: 0, right: width, ascent: face.size * 0.68, descent: face.size * 0.03 };
};
const wholePixelEngine = {
  id: 'browser',
  advance: (face, text) => text.length * face.size * 0.5,
  fontBox: (face) => ({ ascent: Math.round(face.size * 0.9), descent: Math.round(face.size * 0.26) }),
  lineInk: ink,
  glyphInk: ink,
  loading: () => false,
  onFontsChange: () => () => {},
  faceReady: () => true,
};

const typeset = typesetEnabled();
let restoreCanvas;
let was;
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
  setTypesetEnabled(true);
});
afterAll(() => {
  restoreCanvas();
  setTypesetEnabled(typeset);
  clearLayoutMemo();
});
beforeEach(() => {
  was = textEngine();
  setTextEngine(wholePixelEngine);
  clearLayoutMemo();
});
afterEach(() => {
  cleanup();
  setTextEngine(was);
  setZoom(1);
  loadProjectPages([]);
  app.selectedId = null;
});

async function mounted(over = {}) {
  const b = { id: 'b', lineN: null, text: 'PLAIN TEXT HERE\nA FEW WORDS', x: 100, y: 100, w: 250, h: 150, style: style(over) };
  loadProjectPages([{ id: 1, w: 850, h: 1200, lines: [], boxes: [b] }]);
  const pg = page();
  const view = render(TextBox, { box: pg.boxes[0], pageFrameEl: document.createElement('div'), pg });
  await tick();
  return view.container.querySelector('.tbox');
}

const ZOOMS = [0.25, 0.37, 0.5, 0.73, 1, 1.01, 1.37, 2, 3.3];

describe('zooming moves no text against the page', () => {
  it('the ink centring shift is the same number of page px at every zoom', async () => {
    const root = await mounted({ valign: 'middle' });
    const shifts = ZOOMS.map((z) => {
      setZoom(z);
      flushSync();
      const m = /translateY\((-?[\d.e-]+)px\)/.exec(root.querySelector('.stack').style.transform);
      return (m ? parseFloat(m[1]) : 0) / z;
    });
    // There is a shift to hold: the block is not already centred on its ink.
    expect(Math.abs(shifts[4])).toBeGreaterThan(0.1);
    for (const s of shifts) expect(s).toBeCloseTo(shifts[4], 9);
  });

  it('the ink is drawn to the whole pixels its canvas has, which CSS stretches to the zoomed box', async () => {
    const root = await mounted({ ink: { on: true, strokes: [{ size: 8, color: '#000000', opacity: 1, pts: [[20, 20, 1], [80, 40, 1], [160, 30, 1]] }] } });
    const el = root.querySelector('canvas.inkl');
    const ctx = el.getContext('2d');
    for (const z of [0.37, 1.013, 2.71]) {
      ctx.scale = vi.fn();
      setZoom(z);
      flushSync();
      expect(ctx.scale).toHaveBeenCalled();
      const [kx, ky] = ctx.scale.mock.calls[0];
      // The scale the page px are drawn at, times the box's page size, is the
      // canvas's pixel size: the drawing fills the canvas exactly, and the
      // canvas fills its CSS box exactly.
      const pw = parseFloat(el.style.width) / z;
      const ph = parseFloat(el.style.height) / z;
      expect(kx * pw).toBeCloseTo(el.width, 6);
      expect(ky * ph).toBeCloseTo(el.height, 6);
    }
  });
});
