// Ported from manga-cleaner's navigation tests; the empty canvas here is the
// space around the pages (a press on a page is the tool's).
import { describe, expect, it } from 'vitest';
import {
  NAVIGATION_PRESETS,
  defaultNavigation,
  navigationPreset,
  normalizeNavigation,
  panStart,
  wheelZooms,
} from './navigation.js';

const trackpad = NAVIGATION_PRESETS.trackpad;
const mouse = NAVIGATION_PRESETS.mouse;

describe('normalizeNavigation', () => {
  it('starts on the trackpad preset', () => {
    expect(defaultNavigation()).toEqual(trackpad);
    expect(normalizeNavigation(undefined)).toEqual(trackpad);
    expect(normalizeNavigation('mouse')).toEqual(trackpad);
  });

  it('keeps each good field and replaces each bad one on its own', () => {
    expect(normalizeNavigation({ wheel: 'zoom', middlePan: 'yes', emptyPan: true })).toEqual({ wheel: 'zoom', middlePan: true, emptyPan: true });
    expect(normalizeNavigation({ wheel: 'spin', middlePan: false })).toEqual({ wheel: 'scroll', middlePan: false, emptyPan: false });
  });
});

describe('navigationPreset', () => {
  it('names a preset only while every row matches it', () => {
    expect(navigationPreset(trackpad)).toBe('trackpad');
    expect(navigationPreset(mouse)).toBe('mouse');
    expect(navigationPreset({ ...mouse, middlePan: false })).toBeNull();
  });
});

describe('wheelZooms', () => {
  it('zooms on a pinch or a modifier turn whatever the wheel is set to', () => {
    for (const nav of [trackpad, mouse]) {
      expect(wheelZooms({ deltaY: 4, ctrlKey: true }, nav)).toBe(true);
      expect(wheelZooms({ deltaY: 4, metaKey: true }, nav)).toBe(true);
    }
  });

  it('scrolls on a plain turn unless the wheel is set to zoom', () => {
    expect(wheelZooms({ deltaY: 100 }, trackpad)).toBe(false);
    expect(wheelZooms({ deltaY: 100 }, mouse)).toBe(true);
  });

  it('hands a zooming wheel back to the scroller with Shift or Alt, and never zooms sideways', () => {
    expect(wheelZooms({ deltaY: 100, shiftKey: true }, mouse)).toBe(false);
    expect(wheelZooms({ deltaY: 100, altKey: true }, mouse)).toBe(false);
    expect(wheelZooms({ deltaX: 100, deltaY: 0 }, mouse)).toBe(false);
    expect(wheelZooms({ deltaX: 100, deltaY: 20 }, mouse)).toBe(false);
  });
});

describe('panStart', () => {
  // A target inside the page (or a control), or out on the empty canvas.
  const on = (inside) => ({ closest: () => (inside ? {} : null) });

  it('grabs a middle press while the middle button pans', () => {
    expect(panStart({ button: 1, target: on(true) }, { nav: trackpad, held: false })).toBe('grab');
    expect(panStart({ button: 1 }, { nav: { ...trackpad, middlePan: false }, held: false })).toBeNull();
  });

  it('grabs a left press on anything while Space is held', () => {
    expect(panStart({ button: 0, target: on(true) }, { nav: trackpad, held: true })).toBe('grab');
  });

  it('pans a left drag on the empty canvas only when asked to, and never one on the page or a control', () => {
    expect(panStart({ button: 0, target: on(false) }, { nav: trackpad, held: false })).toBeNull();
    expect(panStart({ button: 0, target: on(false) }, { nav: mouse, held: false })).toBe('empty');
    expect(panStart({ button: 0, target: on(true) }, { nav: mouse, held: false })).toBeNull();
  });

  it('leaves the right button to its menu', () => {
    expect(panStart({ button: 2, target: on(false) }, { nav: mouse, held: true })).toBeNull();
  });
});
