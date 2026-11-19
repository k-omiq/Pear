import { describe, expect, it } from 'vitest';
import { fitInsets, PAGE_MIN, DOCK_FLOOR, SIDE_FLOOR } from './insets.js';

const page = (vw, rail, r) => vw - rail - r.side - r.dock;

describe('fitInsets', () => {
  it('keeps the user widths while the page has room', () => {
    expect(fitInsets({ vw: 1600, rail: 44, side: 300, dock: 500 })).toEqual({ side: 300, dock: 500 });
  });
  it('shrinks the dock first, so the page keeps its minimum', () => {
    const r = fitInsets({ vw: 1200, rail: 44, side: 300, dock: 700 });
    expect(r.side).toBe(300);
    expect(page(1200, 44, r)).toBe(PAGE_MIN);
  });
  it('then the sidebar, once the dock is at its floor', () => {
    const r = fitInsets({ vw: 1000, rail: 44, side: 460, dock: 500 });
    expect(r.dock).toBe(DOCK_FLOOR);
    expect(page(1000, 44, r)).toBe(PAGE_MIN);
  });
  it('never puts the page below zero in a tiny window', () => {
    for (const vw of [300, 500, 700]) {
      const r = fitInsets({ vw, rail: 44, side: 460, dock: 800 });
      expect(r.side).toBeGreaterThanOrEqual(0);
      expect(r.dock).toBeGreaterThanOrEqual(0);
      expect(page(vw, 44, r)).toBeGreaterThan(0);
    }
    const r = fitInsets({ vw: 800, rail: 44, side: 460, dock: 800 });
    expect(r.side).toBe(SIDE_FLOOR);
    expect(r.dock).toBe(DOCK_FLOOR);
  });
  it('leaves an absent pane at zero', () => {
    expect(fitInsets({ vw: 600, rail: 44, side: 0, dock: 500 })).toEqual({ side: 0, dock: DOCK_FLOOR });
    expect(fitInsets({ vw: 900, rail: 44, side: 300, dock: 0 })).toEqual({ side: 300, dock: 0 });
  });
});
