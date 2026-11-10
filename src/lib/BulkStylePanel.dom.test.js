import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import BulkStylePanel from './BulkStylePanel.svelte';
import { app, closeBulk, loadProjectPages, openBulk } from './store.svelte.js';
import { FX_INSTANCES_MAX, newShadow } from './data.js';

// ===========================================================================
// The Bulk style panel: where it stays, and what its controls are called
// ===========================================================================

// Every ResizeObserver the panel makes, so a test can say the frame changed.
let observers;
beforeEach(() => {
  observers = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb) { this.cb = cb; this.els = []; observers.push(this); }
    observe(el) { this.els.push(el); }
    disconnect() { this.els = []; }
  });
  loadProjectPages([{ id: 1, w: 1000, h: 1400, lines: [], boxes: [] }]);
  openBulk();
});
afterEach(() => {
  cleanup();
  closeBulk();
  loadProjectPages([]);
  vi.unstubAllGlobals();
});

function sized(el, w, h) {
  Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
}
const at = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
const top = (panel) => parseFloat(panel.style.top);

describe('the panel in a frame that shrinks under it', () => {
  it('is brought back so its head stays on screen', async () => {
    const view = render(BulkStylePanel);
    const frame = view.container;
    sized(frame, 1200, 1000);
    await tick();
    const panel = frame.querySelector('.bulk-panel');
    // Dragged by its head to y = 800 in a 1000px-high frame.
    panel.querySelector('.bulk-head').dispatchEvent(at('pointerdown', 100, 16));
    window.dispatchEvent(at('pointermove', 100, 800));
    window.dispatchEvent(at('pointerup', 100, 800));
    await tick();
    expect(top(panel)).toBe(800);
    // The window shrinks to its 640px floor; the frame with it.
    sized(frame, 1200, 600);
    const ro = observers.find((o) => o.els.includes(frame));
    expect(ro, 'the frame is watched').toBeTruthy();
    ro.cb([]);
    await tick();
    expect(top(panel)).toBe(560);
  });

  it('a frame that grows leaves the panel where it was put', async () => {
    const view = render(BulkStylePanel);
    const frame = view.container;
    sized(frame, 1200, 1000);
    await tick();
    const panel = frame.querySelector('.bulk-panel');
    panel.querySelector('.bulk-head').dispatchEvent(at('pointerdown', 100, 16));
    window.dispatchEvent(at('pointermove', 100, 300));
    window.dispatchEvent(at('pointerup', 100, 300));
    await tick();
    sized(frame, 1400, 1200);
    observers.find((o) => o.els.includes(frame)).cb([]);
    await tick();
    expect(top(panel)).toBe(300);
  });
});

describe('every control in the panel', () => {
  // What a screen reader would announce it as, by the routes this panel uses.
  function nameOf(el) {
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    const own = el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.getAttribute('title');
    if (own) return own.trim();
    return el.matches('button') ? el.textContent.trim() : '';
  }

  it('has a name', async () => {
    app.bulk.style.strokes = [{ color: '#ffffff', width: 3, opacity: 1 }];
    app.bulk.style.shadows = [{ x: 3, y: 3, blur: 4, color: '#000000', opacity: 0.5 }];
    const view = render(BulkStylePanel);
    await tick();
    const controls = [...view.container.querySelectorAll('.bulk-panel :is(input, select, button, [role="switch"])')];
    expect(controls.length).toBeGreaterThan(40);
    const unnamed = controls.filter((el) => !nameOf(el)).map((el) => el.outerHTML.slice(0, 120));
    expect(unnamed).toEqual([]);
  });

  it('names the fields and switches after the label beside them', async () => {
    const view = render(BulkStylePanel);
    await tick();
    const panel = view.container.querySelector('.bulk-panel');
    const rowControl = (label) => {
      const row = [...panel.querySelectorAll('.brow')].find((r) => r.querySelector(':scope > .lbl')?.textContent === label);
      return row.querySelector(':scope > :is(input, select, [role="switch"]):not(.btick)');
    };
    expect(nameOf(rowControl('Size'))).toBe('Size');
    expect(nameOf(rowControl('Hyphenate'))).toBe('Hyphenate');
    expect(nameOf(rowControl('Balloon fit'))).toBe('Balloon fit');
    const sizing = [...panel.querySelectorAll('.brow')].find((r) => r.querySelector(':scope > .lbl')?.textContent === 'Sizing');
    expect(sizing.querySelector('[role="group"]').getAttribute('aria-label')).toBe('Sizing');
    expect([...sizing.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Auto height', 'Fixed', 'Fit to box']);
  });
});

describe('the bulk shadows', () => {
  it('stop at FX_INSTANCES_MAX, as the Inspector and the normaliser keep them', async () => {
    app.bulk.style.shadows = Array.from({ length: FX_INSTANCES_MAX - 1 }, () => newShadow());
    const view = render(BulkStylePanel);
    await tick();
    const add = [...view.container.querySelectorAll('.sub-list-head button')].find((b) => b.textContent.includes('Add') && b.closest('.brow')?.textContent.includes('Shadows'));
    expect(add.disabled).toBe(false);
    await fireEvent.click(add);
    expect(app.bulk.style.shadows).toHaveLength(FX_INSTANCES_MAX);
    expect(add.disabled).toBe(true);
    await fireEvent.click(add);
    expect(app.bulk.style.shadows).toHaveLength(FX_INSTANCES_MAX);
  });

  it('switch each shadow on and off, storing on only when off', async () => {
    app.bulk.style.shadows = [newShadow(), { ...newShadow(), on: false }];
    const view = render(BulkStylePanel);
    await tick();
    const one = view.getByLabelText('Shadow 1 on');
    const two = view.getByLabelText('Shadow 2 on');
    expect([one.checked, two.checked]).toEqual([true, false]);
    one.checked = false;
    await fireEvent.change(one);
    two.checked = true;
    await fireEvent.change(two);
    expect(app.bulk.style.shadows[0].on).toBe(false);
    expect('on' in app.bulk.style.shadows[1]).toBe(false);
  });
});

describe('the pattern', () => {
  it('is edited with the shared pattern editor, and an edit ticks its row', async () => {
    const view = render(BulkStylePanel);
    await tick();
    app.bulk.mask.patternOverlay = false;
    // The swatches are the Inspector's; the list is the panel's narrower form.
    await fireEvent.click(view.getByLabelText('Pattern'));
    expect(app.bulk.style.patternOverlay.on).toBe(true);
    expect(app.bulk.mask.patternOverlay).toBe(true);
    app.bulk.mask.patternOverlay = false;
    const kind = view.getByLabelText('Pattern kind');
    kind.value = 'stripes';
    await fireEvent.change(kind);
    expect(app.bulk.style.patternOverlay.pattern.kind).toBe('stripes');
    expect(app.bulk.mask.patternOverlay).toBe(true);
    app.bulk.mask.patternOverlay = false;
    const scale = view.getByLabelText('Pattern scale, percent');
    scale.value = '200';
    await fireEvent.change(scale);
    expect(app.bulk.style.patternOverlay.pattern.scale).toBe(2);
    expect(app.bulk.mask.patternOverlay).toBe(true);
  });
});
