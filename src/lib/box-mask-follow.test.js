import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app, loadProjectPages, page, fitGeom, followGeom, resizeBox, moveBoxTo } from './store.svelte.js';
import { rescaleDoc } from './editor/history-file.svelte.js';
import { initHistory, resetHistory, undo, redo, record } from './editor/history.svelte.js';
import { setMaskFollow, setFadeFollow, clipToBubble } from './box-mask-actions.js';
import { maskInBoxFrame, maskOnPage, modelShapesOnPage, modelShapesFromPage, withFollow, frameKey, pinnedToPage, bubbleLink } from './box-mask.js';
import { fadeInBoxFrame } from './box-fade.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// "Moves with box" on the mask and the fade: the switch converts the shapes
// so nothing moves on screen, the shapes then move, turn and scale with the
// box, the bubble link stays the outline's, undo covers it, and a file keeps
// it (an old one reads as pinned).
// ===========================================================================

const style = (o = {}) => ({ ...normalizeStyle(defaultStyle()), ...o });
const fit = { kind: 'ellipse', cx: 160, cy: 140, rx: 90, ry: 60 };
const mask = (o = {}) => ({
  on: true,
  shapes: [
    { kind: 'poly', op: 'hide', pts: [[110, 110], [150, 110], [150, 140], [110, 140]] },
    { kind: 'stroke', op: 'hide', size: 8, pts: [[120, 160], [180, 170]] },
    { kind: 'ellipse', op: 'hide', cx: 200, cy: 130, rx: 10, ry: 6 },
  ],
  ...o,
});
const fade = (o = {}) => ({ on: true, shapes: [{ kind: 'poly', pts: [[100, 100], [140, 100], [140, 130], [100, 130]], strength: 60, soft: 20 }], ...o });
const box = (o = {}) => ({ id: 'a', lineN: null, text: 'HI', x: 100, y: 100, w: 120, h: 80, style: style(), fit, mask: mask(), fade: fade(), ...o });

const near = (a, b) => expect(JSON.parse(JSON.stringify(a, (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)))).toEqual(JSON.parse(JSON.stringify(b, (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v))));
const b0 = () => page().boxes[0];

beforeEach(() => {
  initHistory();
  resetHistory();
  loadProjectPages([{ id: 1, w: 1000, h: 800, lines: [], boxes: [box({ style: style({ rotation: 30, flipH: true }) })] }]);
});
afterEach(() => {
  app.selectedId = null;
  resetHistory();
});

describe('the switch', () => {
  it('converts the mask on a turned, flipped box so nothing moves on screen, both ways', () => {
    const b = b0();
    const page0 = maskOnPage(b);
    const frame0 = maskInBoxFrame(b);
    expect(setMaskFollow(b, page(), true)).toBe(true);
    expect(b.mask.follow).toBe(true);
    // The turned ellipse is a polygon now, on the same ring.
    near(maskInBoxFrame(b).slice(0, 2), frame0.slice(0, 2));
    near(maskOnPage(b).slice(0, 2), page0.slice(0, 2));
    expect(setMaskFollow(b, page(), false)).toBe(true);
    expect(b.mask.follow).toBeUndefined();
    near(maskInBoxFrame(b).slice(0, 2), frame0.slice(0, 2));
  });

  it('converts the fade the same way', () => {
    const b = b0();
    const before = fadeInBoxFrame(b);
    setFadeFollow(b, page(), true);
    expect(b.fade.follow).toBe(true);
    near(fadeInBoxFrame(b), before);
  });

  it('keeps a long thin soft fade as soft as it was, on the switch and on a turn', () => {
    // A 100 x 10 strip, soft 100: its size is its width, 10, at any turn.
    const strip = { kind: 'poly', pts: [[150, 150], [250, 150], [250, 160], [150, 160]], strength: 50, soft: 100 };
    loadProjectPages([{ id: 1, w: 1000, h: 800, lines: [], boxes: [box({ style: style({ rotation: 45 }), mask: null, fade: { on: true, shapes: [strip] } })] }]);
    const b = b0();
    const sigma = fadeInBoxFrame(b)[0].soft;
    expect(sigma).toBe(2.5);
    setFadeFollow(b, page(), true);
    expect(fadeInBoxFrame(b)[0].soft).toBe(sigma);
    b.style.rotation = 10;
    expect(fadeInBoxFrame(b)[0].soft).toBe(sigma);
  });

  it('is one undo step each, and redo puts it back', () => {
    const b = b0();
    const pinned = JSON.stringify(b.mask);
    setMaskFollow(b, page(), true);
    const followed = JSON.stringify(b.mask);
    setFadeFollow(b, page(), true);
    undo();
    expect(b0().fade.follow).toBeUndefined();
    expect(b0().mask.follow).toBe(true);
    undo();
    expect(JSON.stringify(b0().mask)).toBe(pinned);
    redo();
    expect(JSON.stringify(b0().mask)).toBe(followed);
  });
});

describe('moving with the box', () => {
  it('a move, a turn and a flip leave following shapes where they are on the box', () => {
    const b = b0();
    setMaskFollow(b, page(), true);
    setFadeFollow(b, page(), true);
    const mf = maskInBoxFrame(b);
    const ff = fadeInBoxFrame(b);
    moveBoxTo(b, 300, 250, page());
    expect(fadeInBoxFrame(b)).toEqual(ff);
    b.style.rotation = -45;
    b.style.flipV = true;
    expect(maskInBoxFrame(b)).toEqual(mf);
    // The soft edge too: a shape's size is the same at any turn.
    expect(fadeInBoxFrame(b)).toEqual(ff);
    // A pinned mask on the same move does change in the box's frame.
    const p = { ...b, mask: withFollow(b, b.mask, false) };
    const moved = { ...p, x: p.x + 40 };
    expect(maskInBoxFrame(moved)).not.toEqual(maskInBoxFrame(p));
  });

  it('a move of a box with nothing pinned needs no hold, and its key ignores the place', () => {
    const b = b0();
    expect(pinnedToPage(b)).toBe(true);
    setMaskFollow(b, page(), true);
    setFadeFollow(b, page(), true);
    expect(pinnedToPage(b)).toBe(false);
    const k = frameKey(b, b.mask);
    b.x += 25;
    expect(frameKey(b, b.mask)).toBe(k);
  });

  it('a corner scale scales following shapes about the box corner, and its undo takes them back', () => {
    const b = b0();
    setMaskFollow(b, page(), true);
    setFadeFollow(b, page(), true);
    const before = JSON.stringify([b.mask, b.fade]);
    const stroke = b.mask.shapes[1];
    const o = { ...fitGeom(b), ...followGeom(b) };
    const styleStart = JSON.parse(JSON.stringify(b.style));
    // Two steps of one drag: each from the start, never compounded.
    resizeBox(1, 'a', { scale: 1.5, w: 180, h: 120 }, { w: o.w, h: o.h, style: styleStart });
    resizeBox(1, 'a', { scale: 2, w: 240, h: 160 }, { w: o.w, h: o.h, style: styleStart });
    expect(b0().mask.shapes[1].size).toBeCloseTo(stroke.size * 2);
    expect(b0().mask.shapes[1].pts[0][0]).toBeCloseTo(stroke.pts[0][0] * 2);
    record({ t: 'style', pageId: 1, boxId: 'a', before: styleStart, after: JSON.parse(JSON.stringify(b0().style)), geomBefore: o, geomAfter: { ...fitGeom(b0()), ...followGeom(b0()) } });
    undo();
    expect(JSON.stringify([b0().mask, b0().fade])).toBe(before);
  });

  it('the geometry a scale records holds the mask and fade, and a page rescale of the history scales them', () => {
    const b = b0();
    expect(followGeom(b)).toEqual({});
    setMaskFollow(b, page(), true);
    setFadeFollow(b, page(), true);
    const g = { ...fitGeom(b), ...followGeom(b) };
    expect(fitGeom(b)).not.toHaveProperty('mask');
    const entry = { t: 'style', pageId: 1, boxId: 'a', before: b.style, after: b.style, geomBefore: g, geomAfter: g };
    const doc = rescaleDoc({ version: 1, pages: { 1: { undo: [JSON.parse(JSON.stringify(entry))], redo: [] } } }, [{ pageId: 1, sx: 2, sy: 2 }]);
    const out = doc.pages[1].undo[0].geomBefore;
    expect(out.mask.follow).toBe(true);
    expect(out.mask.shapes[1].pts[0][0]).toBeCloseTo(g.mask.shapes[1].pts[0][0] * 2);
    expect(out.mask.shapes[1].size).toBeCloseTo(g.mask.shapes[1].size * 2);
    expect(out.fade.shapes[0].pts[0][1]).toBeCloseTo(g.fade.shapes[0].pts[0][1] * 2);
  });

  it('a pinned mask does not scale with the box', () => {
    const b = b0();
    const before = JSON.stringify(b.mask);
    const styleStart = JSON.parse(JSON.stringify(b.style));
    resizeBox(1, 'a', { scale: 2, w: 240, h: 160 }, { w: 120, h: 80, style: styleStart });
    expect(JSON.stringify(b0().mask)).toBe(before);
  });

  it('a held move keeps following shapes on the box and pinned ones on the page', () => {
    const b = b0();
    setFadeFollow(b, page(), true);
    // The mask stays pinned, so the box is held; the fade must not slide.
    expect(pinnedToPage(b)).toBe(true);
    const ff = fadeInBoxFrame(b);
    const atNewPlace = maskInBoxFrame({ ...b, x: b.x + 30, y: b.y + 10 });
    const held = { ...b, pinMove: [-30, -10] };
    near(fadeInBoxFrame(held), ff);
    near(maskInBoxFrame(held), atNewPlace);
  });
});

describe('the draw tool', () => {
  it('shows following shapes on the page and stores untouched ones as they were', () => {
    const b = b0();
    setMaskFollow(b, page(), true);
    const shown = modelShapesOnPage(b, b.mask);
    near(shown.slice(0, 2), mask().shapes.slice(0, 2));
    const added = { kind: 'poly', op: 'hide', pts: [[300, 300], [320, 300], [320, 320]] };
    const next = modelShapesFromPage(b, b.mask, [...shown, added]);
    expect(next.slice(0, 3)).toEqual(b.mask.shapes.slice(0, 3));
    near(modelShapesOnPage(b, { ...b.mask, shapes: next })[3], added);
  });
});

describe('Clip to bubble', () => {
  it('works on a following mask and leaves it following; the link stays the outline', () => {
    const b = b0();
    const pinnedLink = (() => {
      clipToBubble(['a']);
      const m = maskInBoxFrame(b0()).find((sh, i, all) => i === all.length - 1);
      undo();
      return m;
    })();
    setMaskFollow(b0(), page(), true);
    expect(clipToBubble(['a'])).toBe(true);
    expect(b0().mask.follow).toBe(true);
    expect(bubbleLink(b0())).toBeTruthy();
    near(maskInBoxFrame(b0()).at(-1), pinnedLink);
    // A move of the box moves the drawn shapes with it, never the link.
    const frame = maskInBoxFrame(b0());
    moveBoxTo(b0(), b0().x + 40, b0().y, page());
    const after = maskInBoxFrame(b0());
    expect(after.slice(0, -1)).toEqual(frame.slice(0, -1));
    expect(after.at(-1)).not.toEqual(frame.at(-1));
    expect(pinnedToPage(b0())).toBe(true);
  });
});

describe('save and load', () => {
  it('keeps the switch, and an old file reads as pinned', () => {
    const b = b0();
    setMaskFollow(b, page(), true);
    setFadeFollow(b, page(), true);
    const saved = JSON.parse(JSON.stringify(page()));
    loadProjectPages([saved]);
    expect(b0().mask.follow).toBe(true);
    expect(b0().fade.follow).toBe(true);
    expect(JSON.stringify(b0().mask.shapes)).toBe(JSON.stringify(saved.boxes[0].mask.shapes));
    loadProjectPages([{ id: 1, w: 1000, h: 800, lines: [], boxes: [box()] }]);
    expect(b0().mask.follow).toBeUndefined();
    expect(b0().fade.follow).toBeUndefined();
  });
});
