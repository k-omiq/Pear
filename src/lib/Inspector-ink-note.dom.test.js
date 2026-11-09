import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The ink note (review Gaps, Decision A2): a box whose brush ink the engine's
// box job cannot take yet (`inkJobGap`: a mesh, roughening, an old engine)
// is painted by the canvas, with none of its layer effects, Fill Opacity,
// blend mode, Channels or Blend If. The Inspector says so on the Fill and
// Effects tabs instead of showing them as live; a box of round or imported
// tips says nothing, as a box of type does.
import Inspector from './Inspector.svelte';
import { app, loadProjectPages } from './store.svelte.js';
import { setInspectorTab, setEffectsSubTab } from './inspector-tabs.svelte.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { engineSwitch } from './engine-switch.svelte.js';
import { glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

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
afterEach(() => {
  cleanup();
  app.selectedId = null;
  loadProjectPages([]);
  engineSwitch.painting = false;
  setGlyphPainter(before);
});

const stroke = (over = {}) => ({ size: 12, pts: [[10, 10, 1], [110, 10, 1]], ...over });

function mounted(over, tab, { rust = true, ink = true } = {}) {
  const style = normalizeStyle({ ...defaultStyle(), outerGlow: { on: true }, ...over });
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'HELLO' }], boxes: [{ id: 'b', lineN: 1, text: null, x: 100, y: 100, w: 240, h: 90, style }] }]);
  app.selectedId = 'b';
  setGlyphPainter(rust ? { ...before, box: true, ink } : before);
  engineSwitch.painting = rust;
  setInspectorTab(tab);
  if (tab === 'effects') setEffectsSubTab('glow');
  return render(Inspector);
}
const note = (view) => view.container.querySelector('.ink-gap-note')?.textContent ?? null;

describe('the ink note', () => {
  it('says roughening keeps the effects and blending off the box, on both tabs', async () => {
    for (const tab of ['fill', 'effects']) {
      const view = mounted({ ink: { on: true, strokes: [stroke()] }, roughen: { on: true, amount: 3 } }, tab);
      await tick();
      expect(note(view), tab).toContain('Not painted on this box: layer effects, Fill opacity, blend mode, Channels and Blend If');
      expect(note(view), tab).toContain('roughen');
      cleanup();
    }
  });

  it('names roughening and an engine without ink', async () => {
    const cases = [
      [{ ink: { on: true, strokes: [stroke()] }, roughen: { on: true, amount: 3 } }, {}, 'roughen'],
      [{ ink: { on: true, strokes: [stroke()] } }, { ink: false }, 'paints no brush ink'],
    ];
    for (const [over, opts, word] of cases) {
      const view = mounted(over, 'fill', opts);
      await tick();
      expect(note(view), word).toContain(word);
      cleanup();
    }
  });

  it('says nothing for round ink, type, or the browser engine', async () => {
    for (const [over, opts] of [
      [{ ink: { on: true, strokes: [stroke()] } }, {}],
      [{ ink: { on: true, strokes: [stroke({ brush: 'tip:chalk' })] } }, {}],
      [{ ink: { on: true, strokes: [stroke({ tips: ['tip:a', 'tip:b'] })] } }, {}],
      [{}, {}],
      [{ ink: { on: true, strokes: [stroke({ brush: 'tip:chalk' })] } }, { rust: false }],
    ]) {
      const view = mounted(over, 'effects', opts);
      await tick();
      expect(note(view)).toBeNull();
      cleanup();
    }
  });
});
