import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../../test/rust-engine.js';
import { PICTURE_DRAG_PX, PICTURE_MAX_PX, PICTURE_SCALE, TURNED_OVERSAMPLE, paintBoxPicture, paintPictureTexture, pictureTexture, presentPicture } from './box-picture.js';
import { renderBoxTexture, warpTexture, boxFootprint } from '../exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from '../text-engine/index.js';
import { createRustGlyphPainter, SCRATCH_KEEP_PX, MAX_RASTER_SIDE } from '../text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo, arcLayout, circleLayout, applyCase } from '../measure.js';
import { boxCandidate, placeBlock } from '../contain.js';
import { defaultStyle, normalizeStyle } from '../data.js';

// ===========================================================================
// The editor's picture of a box, painted by the real engine
// ===========================================================================
// What the editor keeps for a box is what `renderBoxTexture` makes, and "the
// same" is meant as bytes: `paintBoxPicture` adds nothing to it. What it
// shows at the picture's own resolution (100% on a 2x display) is that kept
// picture copied, byte for byte (`presentPicture`). Pinned here with the Rust
// engine and its painter on Skia's canvas (@napi-rs/canvas), for every route
// a box takes through the exporter - straight, finished, curved, masked,
// through the mesh - and at the scales a picture is painted at, whole and
// not. Then the two things the editor adds: the budget, and giving back what
// it borrowed.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
// Every canvas anything asked the document for, and whether its pixels were
// given back (width set to 0). Recorded at the setter: this canvas reports a
// zeroed size as 350 x 150, so it cannot be asked afterwards.
let made = [];
function tracked() {
  const c = createCanvas(300, 150);
  const rec = { c, released: false };
  const width = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c), 'width');
  Object.defineProperty(c, 'width', {
    configurable: true,
    get: () => width.get.call(c),
    set: (v) => {
      rec.released = v === 0;
      width.set.call(c, v);
    },
  });
  made.push(rec);
  return c;
}

beforeAll(async () => {
  globalThis.document = {
    createElement: () => tracked(),
  };
  const rust = await rustEngine();
  setTextEngine(rust);
  setGlyphPainter(createRustGlyphPainter(rust));
  setTypesetEnabled(true);
  clearLayoutMemo();
});
afterAll(() => {
  setTextEngine(before.engine);
  setGlyphPainter(before.painter);
  setTypesetEnabled(before.typeset);
  clearLayoutMemo();
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});
beforeEach(() => {
  made = [];
});

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30, strokes: [], ...over });
const boxOf = (over = {}, text = 'THE EDITOR SHOWS\nWHAT IS EXPORTED', geom = {}) => ({ id: 'b', lineN: null, text, x: 100, y: 100, w: 300, h: 90, ...geom, style: style(over) });
const pageOf = (box) => ({ id: 1, w: 1600, h: 2300, lines: [], boxes: [box] });
const bytes = (c, w = c.width, h = c.height) => c.getContext('2d').getImageData(0, 0, w, h).data;
const unlike = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};
const inked = (data) => {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]) n++;
  return n;
};

// The ring's own words: enough of them to go round.
const RING = 'ROUND AND ROUND IT GOES ';
const KINDS = {
  plain: {},
  finished: {
    strokes: [{ color: '#e11d48', width: 3 }],
    shadows: [{ x: 4, y: 5, blur: 3, color: '#000000', opacity: 0.6 }],
    blur: 0.6,
  },
  smeared: { motionBlur: { on: true, x: 2, y: 1, amount: 5 } },
  arc: { curve: 40 },
  circle: { size: 20, circle: { on: true, angle: 0, inside: false, r: 0 } },
  masked: { clip: { on: true, mode: 'include', shapes: [{ kind: 'ellipse', cx: 150, cy: 45, rx: 120, ry: 34 }] } },
  warped: { warp: { on: true, cols: 1, rows: 1, pts: [[0, 0], [300, 22], [-8, 96], [290, 84]] } },
};

// What a kind is called is the route it takes: `placeBlock` sends a box down
// the ring only for `circle.on`, and a `curve` of any size is an arc. (The
// kind named circle was an arc - `curve: 360` - so the ring was never painted
// here.)
describe('the kinds are the routes their names say', () => {
  const routeOf = (over) => {
    const box = boxOf(over, over.circle ? RING : undefined);
    const place = placeBlock(boxCandidate(box, box.text));
    if (!place.isCurve) return 'straight';
    const s = box.style;
    const same = (a, b) => a.length === b.length && a.every((g, i) => g.x === b[i].x && g.y === b[i].y && g.rot === b[i].rot);
    const text = applyCase(box.text, s);
    if (s.circle?.on) return same(place.layout, circleLayout(text, s, s.size)) ? 'circle' : 'unknown';
    return same(place.layout, arcLayout(text, s, s.size)) ? 'arc' : 'unknown';
  };
  it('circle is a ring and arc is an arc, and they are not the same glyph positions', () => {
    expect(routeOf(KINDS.circle)).toBe('circle');
    expect(routeOf(KINDS.arc)).toBe('arc');
    for (const k of ['plain', 'finished', 'smeared', 'masked', 'warped']) expect(routeOf(KINDS[k]), k).toBe('straight');
    const s = style(KINDS.circle);
    const ring = circleLayout(RING, s, s.size);
    const arc = arcLayout(RING, s, s.size);
    expect(ring.some((g, i) => Math.abs(g.x - arc[i].x) > 1 || Math.abs(g.y - arc[i].y) > 1)).toBe(true);
    // A ring closes: its glyphs go all the way round.
    const turn = ring.at(-1).rot - ring[0].rot;
    expect(Math.abs(turn)).toBeGreaterThan(Math.PI);
  });
});

describe('the picture is renderBoxTexture\'s, byte for byte', () => {
  // The picture's own scale, a turned box's, and two a budget can lower a
  // picture to: one whole, one not.
  for (const [kind, over] of Object.entries(KINDS)) {
    for (const scale of [PICTURE_SCALE, PICTURE_SCALE * TURNED_OVERSAMPLE, 1, 2.74]) {
      it(`${kind} at ${scale}`, () => {
        const box = boxOf(over, kind === 'circle' ? RING : undefined);
        const p = pageOf(box);
        const want = warpTexture(renderBoxTexture(box, p, null, scale, PICTURE_MAX_PX), box);
        const pic = paintBoxPicture(box, p, scale, null);
        expect([pic.canvas.width, pic.canvas.height]).toEqual([want.canvas.width, want.canvas.height]);
        const got = bytes(pic.canvas);
        expect(inked(got)).toBeGreaterThan(500);
        expect(unlike(got, bytes(want.canvas))).toBe(0);
        // And it says where the picture goes, in page px, and that nothing
        // lowered the scale it was asked for.
        expect({ ...pic, canvas: null }).toEqual({ canvas: null, ox: want.ox, oy: want.oy, cw: want.cw, ch: want.ch, ss: scale });
      });
    }
  }

  // Shown at the picture's own resolution the canvas on screen is the kept
  // picture, copied: upright on whole device pixels (100% on a 2x display,
  // 200% on a 1x one), and turned at the turned picture's (100% on a 2x
  // display, twice the screen).
  for (const [kind, over] of Object.entries(KINDS)) {
    it(`${kind}: shown at its own resolution, the canvas on screen is the kept picture byte for byte`, () => {
      const box = boxOf(over, kind === 'circle' ? RING : undefined);
      const p = pageOf(box);
      const pic = paintBoxPicture(box, p, PICTURE_SCALE, null);
      const want = bytes(pic.canvas);
      for (const [z, dpr] of [[1, 2], [2, 1]]) {
        const el = createCanvas(1, 1);
        const g = presentPicture(el, pic, { z, dpr, page: { x: 120.25, y: 88.75 }, at: box });
        expect(g.aligned, `${z} x ${dpr}`).toBe(true);
        expect([g.fx, g.fy]).toEqual([0, 0]);
        // Padded to whole CSS px, so at least the picture's size...
        expect(el.width).toBeGreaterThanOrEqual(pic.canvas.width);
        expect(el.height).toBeGreaterThanOrEqual(pic.canvas.height);
        // ...its own bytes where it is, and nothing in the padding.
        expect(unlike(bytes(el, pic.canvas.width, pic.canvas.height), want), `${z} x ${dpr}`).toBe(0);
        expect(inked(bytes(el))).toBe(inked(want));
      }
      const turned = { ...box, style: { ...box.style, rotation: 7 } };
      const fine = paintBoxPicture(turned, p, PICTURE_SCALE * TURNED_OVERSAMPLE, null);
      const el = createCanvas(1, 1);
      const g = presentPicture(el, fine, { z: 1, dpr: 2, page: { x: 0, y: 0 }, at: null, turned: true });
      expect(g.aligned).toBe(false);
      expect([el.width, el.height]).toEqual([fine.canvas.width, fine.canvas.height]);
      expect(unlike(bytes(el), bytes(fine.canvas))).toBe(0);
    });
  }

  // What the editor watches for a box it is not painting (`boxFootprint`) is
  // the footprint a paint would have told it, for every route.
  for (const [kind, over] of Object.entries(KINDS)) {
    it(`${kind}: the footprint worked out without a paint is the one a paint returns`, () => {
      const box = boxOf(over, kind === 'circle' ? RING : undefined);
      const p = pageOf(box);
      const before = made.length;
      const f = boxFootprint(box, p);
      // Arithmetic: no canvas was asked for.
      expect(made.length).toBe(before);
      for (const scale of [1, 2]) {
        const g = paintBoxPicture(box, p, scale, null);
        expect({ ox: g.ox, oy: g.oy, cw: g.cw, ch: g.ch }, `scale ${scale}`).toEqual(f);
      }
      // At a scale that is not whole the painted one is cut to whole pixels,
      // outwards: never smaller than what was worked out, and under a pixel more.
      if (!over.warp) {
        const g = paintBoxPicture(box, p, 2.74, null);
        expect([g.ox, g.oy]).toEqual([f.ox, f.oy]);
        expect(g.cw - f.cw).toBeGreaterThanOrEqual(0);
        expect(g.cw - f.cw).toBeLessThan(1 / 2.74);
        expect(g.ch - f.ch).toBeGreaterThanOrEqual(0);
        expect(g.ch - f.ch).toBeLessThan(1 / 2.74);
      }
    });
  }

  it('a second picture shown in the same canvas leaves nothing of the first', () => {
    const el = createCanvas(300, 150);
    const first = boxOf({ strokes: [{ color: '#e11d48', width: 6 }] });
    presentPicture(el, paintBoxPicture(first, pageOf(first), PICTURE_SCALE, null), { z: 1, dpr: 2, page: { x: 0, y: 0 }, at: first });
    const second = boxOf({}, 'LESS');
    const pic = paintBoxPicture(second, pageOf(second), PICTURE_SCALE, null);
    presentPicture(el, pic, { z: 1, dpr: 2, page: { x: 0, y: 0 }, at: second });
    const want = renderBoxTexture(second, pageOf(second), null, PICTURE_SCALE);
    expect(unlike(bytes(el, want.canvas.width, want.canvas.height), bytes(want.canvas))).toBe(0);
    expect(inked(bytes(el))).toBe(inked(bytes(want.canvas)));
  });
});

describe('what it holds', () => {
  // The kept pictures are the caller's to let go (TextBox.svelte's
  // `releasePic`), so they are counted apart from the rest.
  const heldBesides = (kept) => made.filter((r) => !r.released && !kept.has(r.c));

  it('nothing but the picture: every canvas made on the way is given back', () => {
    const kept = new Set();
    for (const over of Object.values(KINDS)) {
      const box = boxOf(over, over.circle ? RING : undefined);
      kept.add(paintBoxPicture(box, pageOf(box), PICTURE_SCALE, null).canvas);
    }
    // One picture a box, each its own canvas, all made through the document.
    expect(kept.size).toBe(Object.keys(KINDS).length);
    for (const c of kept) expect(made.some((r) => r.c === c && !r.released)).toBe(true);
    // The painter's one scratch canvas is the painter's, and is bounded
    // (rust-painter.js); nothing else of the box's own size is left.
    // At least one a box: its texture. (A painter that paints the whole box
    // itself makes no others; the canvas passes made several each.)
    expect(made.length).toBeGreaterThanOrEqual(Object.keys(KINDS).length);
    const held = heldBesides(kept);
    expect(held.length).toBeLessThanOrEqual(1);
    for (const r of held) expect(r.c.width * r.c.height).toBeLessThanOrEqual(SCRATCH_KEEP_PX);
  });

  it('and the bound holds for boxes that could break it: one line across a page, then one column down it', () => {
    // The outside review's pair, painted at 6 as the editor once painted
    // them at 300% on a 2x display: past any scale it paints at now, so the
    // bound is held with room to spare. Each raster is small; a scratch
    // raised to the widest and the tallest seen was 8739 x 6306, 210 MB,
    // kept until the engine was switched off.
    const wide = boxOf({ size: 12 }, 'W'.repeat(140), { w: 1600, h: 30 });
    const tall = boxOf({ size: 12 }, Array(80).fill('WWW').join('\n'), { w: 60, h: 1200 });
    const small = boxOf({ size: 12 }, 'W');
    const kept = new Set();
    for (const box of [wide, tall, small]) {
      const pic = paintBoxPicture(box, pageOf(box), 6, null);
      kept.add(pic.canvas);
      expect(inked(bytes(pic.canvas))).toBeGreaterThan(100);
      const held = heldBesides(kept);
      expect(held.length).toBeLessThanOrEqual(1);
      for (const r of held) expect(r.c.width * r.c.height).toBeLessThanOrEqual(SCRATCH_KEEP_PX);
    }
  });

  it('a box over the budget is painted to the budget and still spans its footprint', () => {
    // 1600 x 2300 page px at the picture's scale is 14.7 megapixels.
    const box = boxOf({ size: 120 }, 'A WHOLE\nPAGE OF\nTYPE', { x: 0, y: 0, w: 1600, h: 2300 });
    const p = pageOf(box);
    const g = paintBoxPicture(box, p, PICTURE_SCALE, null);
    const el = g.canvas;
    const uncapped = renderBoxTexture(box, p, null, 1);
    expect(el.width * el.height).toBeLessThanOrEqual(PICTURE_MAX_PX * 1.01);
    expect(el.width * el.height).toBeGreaterThan(PICTURE_MAX_PX * 0.97);
    // The same page px as at any scale: CSS stretches the picture over them.
    expect(g.ox).toBe(uncapped.ox);
    expect(g.oy).toBe(uncapped.oy);
    expect(g.cw).toBeCloseTo(uncapped.cw, 0);
    expect(g.ch).toBeCloseTo(uncapped.ch, 0);
    expect(inked(bytes(el))).toBeGreaterThan(10000);
    // And it says what it came out at: under what was asked for, and the
    // canvas's own pixels over the page px it spans.
    expect(g.ss).toBeLessThan(PICTURE_SCALE);
    expect(g.ss).toBeCloseTo(el.width / g.cw, 2);
  });

  // The budget a resize hands it (TextBox.svelte) is counted on what is
  // painted. The outside review's box: a frame of 100 x 100 and twenty lines of
  // W at size 80 running far below it, asked for at 6 (the scale it was found
  // at, 300% on a 2x display, when the picture followed the zoom). Flat and
  // through a mesh, which is cut down after the mesh is applied.
  for (const [name, over] of [['flat', {}], ['through a mesh', { warp: { on: true, cols: 1, rows: 1, pts: [[0, 0], [100, 12], [-6, 100], [94, 92]] } }]]) {
    it(`a small frame whose lines overflow it is painted within the budget it is handed: ${name}`, () => {
      const box = boxOf({ size: 80, autoHeight: false, valign: 'top', ...over }, Array(20).fill('W').join('\n'), { x: 0, y: 0, w: 100, h: 100 });
      const p = pageOf(box);
      expect(box.w * box.h * 36).toBeLessThan(PICTURE_DRAG_PX);
      const full = paintBoxPicture(box, p, 6, null);
      const rest = full.canvas;
      expect(rest.width * rest.height).toBeGreaterThan(PICTURE_DRAG_PX * 4);
      // (Through the mesh the far lines are thrown wide, and it is over the
      // picture's own budget at rest as well.)
      expect(full.ss).toBeGreaterThan(5);
      expect(full.ss).toBeLessThanOrEqual(6);
      const g = paintBoxPicture(box, p, 6, null, PICTURE_DRAG_PX);
      const el = g.canvas;
      expect(el.width * el.height).toBeLessThanOrEqual(PICTURE_DRAG_PX * 1.02);
      expect(el.width * el.height).toBeGreaterThan(PICTURE_DRAG_PX * 0.9);
      expect(g.ss).toBeLessThan(6);
      expect(g.ss).toBeCloseTo(el.width / g.cw, 1);
      // The same place and span as at rest, to the texel.
      expect(Math.abs(g.ox - full.ox)).toBeLessThan(1 / g.ss);
      expect(Math.abs(g.cw - full.cw)).toBeLessThan(2 / g.ss);
      expect(Math.abs(g.ch - full.ch)).toBeLessThan(2 / g.ss);
      expect(inked(bytes(el))).toBeGreaterThan(10000);
    });
  }

  // The outside review's box: 7000 x 100, a hundred W at size 80, found at
  // 150% on a 2x display (asked for at 3). Under the pixel budget, and 21,000
  // px wide: the engine paints no raster with a side over its limit, and the
  // paint threw.
  const LONG = () => boxOf({ size: 80 }, 'W'.repeat(100), { x: 0, y: 0, w: 7000, h: 100 });

  it('the engine refuses a raster with a side over its limit, which is the limit the painter states', () => {
    const box = LONG();
    expect(glyphPainter().maxSide).toBe(MAX_RASTER_SIDE);
    // Asked for with no side limit, as before: still within the area budget, and it throws.
    expect(() => renderBoxTexture(box, pageOf(box), null, 3, PICTURE_MAX_PX)).toThrow(/larger than the engine allows/);
    // And at 2, where the line is 14,000 px, it does not.
    expect(() => renderBoxTexture(box, pageOf(box), null, 2, PICTURE_MAX_PX)).not.toThrow();
  });

  it('a box longer than the engine\'s side limit is painted at a lower scale and still spans its footprint', () => {
    const box = LONG();
    const p = pageOf(box);
    // At a turned box's scale (`pictureScale`), 28,000 px long.
    const g = paintBoxPicture(box, p, PICTURE_SCALE * TURNED_OVERSAMPLE, null);
    const el = g.canvas;
    expect(el.width).toBeLessThanOrEqual(MAX_RASTER_SIDE);
    expect(el.width).toBeGreaterThan(MAX_RASTER_SIDE - 2);
    expect(inked(bytes(el))).toBeGreaterThan(100000);
    const at2 = renderBoxTexture(box, p, null, 2);
    expect([g.ox, g.oy]).toEqual([at2.ox, at2.oy]);
    expect(g.cw).toBeCloseTo(at2.cw, 0);
    expect(g.ch).toBeCloseTo(at2.ch, 0);
    // The same on its side, turned boxes being painted at twice the scale:
    // 1500 x 44 at 400% on a 2x display, turned, is asked for at 16.
    const turned = boxOf({ size: 30 }, 'W'.repeat(60), { x: 0, y: 0, w: 1500, h: 44 });
    let el2 = null;
    expect(() => (el2 = paintBoxPicture(turned, pageOf(turned), 16, null).canvas)).not.toThrow();
    expect(Math.max(el2.width, el2.height)).toBeLessThanOrEqual(MAX_RASTER_SIDE);
    expect(inked(bytes(el2))).toBeGreaterThan(100000);
  });

  it('and the texture the mesh gizmo holds through a drag is made within the same limits', () => {
    const box = LONG();
    const tex = pictureTexture(box, pageOf(box), null, 3);
    expect(tex.canvas.width).toBeLessThanOrEqual(MAX_RASTER_SIDE);
    expect(tex.ss).toBeLessThan(3);
  });

  it('the mesh gizmo\'s texture is the gesture\'s: painted from again and again, and not released', () => {
    const box = boxOf(KINDS.warped);
    const p = pageOf(box);
    // Asked for unbent (`flat`), as the gesture does: the painter would bend
    // the letters itself, and a drag runs the mesh over this one texture.
    const tex = renderBoxTexture(box, p, null, 2, PICTURE_MAX_PX, Infinity, true);
    expect(tex.warped).toBe(false);
    const size = [tex.canvas.width, tex.canvas.height];
    const a = paintPictureTexture(tex, box);
    // Bent, so a canvas of its own: the box's to keep and let go.
    expect(a.borrowed).toBe(false);
    expect(a.canvas).not.toBe(tex.canvas);
    expect(a.ss).toBe(tex.ss);
    const first = bytes(a.canvas).slice();
    box.style.warp.pts = [[0, 0], [300, 40], [-8, 96], [290, 84]];
    const pic = paintPictureTexture(tex, box);
    const el = pic.canvas;
    expect(unlike(first, bytes(el))).toBeGreaterThan(0);
    expect([tex.canvas.width, tex.canvas.height]).toEqual(size);
    // What it shows is what a texture warp from nothing would: the frames of a
    // drag are the raster warp. (The picture the box settles to when the drag
    // ends is bent by the painter and is a little larger, `meshInJob`.)
    const whole = warpTexture(renderBoxTexture(box, p, null, 2, PICTURE_MAX_PX, Infinity, true), box);
    expect([el.width, el.height]).toEqual([whole.canvas.width, whole.canvas.height]);
    expect(unlike(bytes(el), bytes(whole.canvas))).toBe(0);
    // A mesh that does nothing hands back the gesture's texture itself:
    // borrowed, and not the box's to let go.
    box.style.warp.pts = [[0, 0], [300, 0], [0, 90], [300, 90]];
    const flat = paintPictureTexture(tex, box);
    expect(flat.canvas).toBe(tex.canvas);
    expect(flat.borrowed).toBe(true);
    expect([tex.canvas.width, tex.canvas.height]).toEqual(size);
  });

  it('a frame the GPU draws is the gesture\'s, and leaves the picture the box settles to as it was', () => {
    const box = boxOf(KINDS.warped);
    const p = pageOf(box);
    const settled = bytes(paintBoxPicture(box, p, 2, null).canvas).slice();
    const tex = renderBoxTexture(box, p, null, 2, PICTURE_MAX_PX, Infinity, true);
    const size = [tex.canvas.width, tex.canvas.height];
    // Node has no WebGL: a stand-in warper that says where it drew.
    const own = createCanvas(4, 4);
    const asked = [];
    const gpu = { draw: (o) => (asked.push(o), { canvas: own, ox: 1, oy: 2, cw: 3, ch: 4, ss: o.ss, shared: true }) };
    const pic = paintPictureTexture(tex, box, PICTURE_MAX_PX, gpu);
    expect(pic.canvas).toBe(own);
    expect(pic.borrowed).toBe(true);
    expect([pic.ox, pic.oy, pic.cw, pic.ch, pic.ss]).toEqual([1, 2, 3, 4, tex.ss]);
    expect(asked[0].maxPx).toBe(PICTURE_MAX_PX);
    expect(asked[0].warp).toBe(box.style.warp);
    // Neither the warper's canvas nor the gesture's texture was let go.
    expect([own.width, own.height]).toEqual([4, 4]);
    expect([tex.canvas.width, tex.canvas.height]).toEqual(size);
    // A warper that cannot draw the frame hands it to the canvas path, byte
    // for byte what it would have drawn with no warper at all.
    const none = paintPictureTexture(tex, box, PICTURE_MAX_PX, { draw: () => null });
    expect(none.borrowed).toBe(false);
    expect(unlike(bytes(none.canvas), bytes(paintPictureTexture(tex, box).canvas))).toBe(0);
    // And the picture painted when the pointer comes up is the one it was.
    expect(unlike(bytes(paintBoxPicture(box, p, 2, null).canvas), settled)).toBe(0);
  });
});
