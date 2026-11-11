import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { app, loadProjectPages, setFontSource } from './store.svelte.js';
import { exportImages, scaleBlock, scaledFits, stripSliceBlock, stripSliceLimit, CANVAS_MAX_AREA } from './exporter.js';
import { SLICE_H_DEFAULT } from './editor/strip-cuts.js';
import { scaleTypeLayer } from './psd.js';
import { releaseAllPageImages } from './page-images.js';
import { jobs } from './jobs.svelte.js';

// ===========================================================================
// Size 2x: what a file can hold, and an export that cannot be written
// ===========================================================================
// WebKit makes a canvas past 16384 x 16384 px of area at the size asked and
// draws nothing on it (measured in WKWebView, 2026-11-10), and the engine's
// encoders hold a JPEG up to 65,535 px a side and a WebP up to 16,384. A page
// whose 2x size passes one is refused, by name, before anything is drawn.

describe('what a 2x file can hold', () => {
  it('is WebKit’s canvas area, and each format’s side', () => {
    expect(CANVAS_MAX_AREA).toBe(16384 * 16384);
    expect(scaledFits(8192, 8192, 2, 'PNG')).toBe(true);
    expect(scaledFits(8192, 8193, 2, 'PNG')).toBe(false);
    // A long thin page has the area but not a WebP's side.
    expect(scaledFits(1000, 9000, 2, 'PNG')).toBe(true);
    expect(scaledFits(1000, 8192, 2, 'WebP')).toBe(true);
    expect(scaledFits(1000, 8193, 2, 'WebP')).toBe(false);
    expect(scaledFits(1000, 32767, 2, 'JPG')).toBe(true);
    expect(scaledFits(1000, 32768, 2, 'JPG')).toBe(false);
  });

  it('names the first page past it, as the user counts pages', () => {
    const pages = [{ w: 800, h: 1200 }, { w: 800, h: 1200 }, { w: 9000, h: 9000 }, { w: 9000, h: 9000 }];
    expect(scaleBlock(pages, 'PNG', 2)).toBe('Page 3 is too large for 2x');
    expect(scaleBlock(pages.slice(2), 'PNG', 2, { first: 3 })).toBe('Page 3 is too large for 2x');
    expect(scaleBlock(pages.slice(0, 2), 'PNG', 2)).toBe(null);
    // The PSD's layers are page-size canvases: the same area.
    expect(scaleBlock(pages, 'PSD', 2)).toBe('Page 3 is too large for 2x');
  });

  it('judges nothing at the page’s own size, nor for JSON, nor a page not measured yet', () => {
    const big = [{ w: 30000, h: 30000 }];
    expect(scaleBlock(big, 'PNG', 1)).toBe(null);
    expect(scaleBlock(big, 'JSON', 2)).toBe(null);
    expect(scaleBlock([{ w: 0, h: 0 }], 'PNG', 2)).toBe(null);
  });

  it('judges a strip’s pages by the column’s width, not their own', () => {
    expect(scaleBlock([{ w: 400, h: 8000 }], 'PNG', 2)).toBe(null);
    expect(scaleBlock([{ w: 400, h: 8000 }], 'PNG', 2, { strip: { width: 9000 } })).toBe('Page 1 is too large for 2x');
    // A page of the strip that fits is let go, whatever Slice height says:
    // the slices are the whole chapter's, judged apart.
    expect(scaleBlock([{ w: 800, h: 3000 }], 'WebP', 2, { strip: { width: 800 } })).toBe(null);
  });
});

describe('what a 2x strip’s slices can hold', () => {
  const pages = Array.from({ length: 10 }, () => ({ w: 800, h: 3000 }));

  it('is its column width and the tallest slice its Slice height can cut', () => {
    // Slices of 4000 can be cut up to 8000 tall: 16,000 px at 2x, inside
    // a PNG and a WebP.
    expect(stripSliceBlock(pages, 'PNG', 2, 800, 4000)).toBe(null);
    expect(stripSliceBlock(pages, 'WebP', 2, 800, 4000)).toBe(null);
    // Up to 10,000 tall: past a WebP's side at 2x, not a PNG's. The reason
    // names a height that works: 16,384 / 2 / 2.
    expect(stripSliceBlock(pages, 'WebP', 2, 800, 5000)).toBe('At 2x, set Slice height to 4096 or less');
    expect(stripSliceBlock(pages, 'PNG', 2, 800, 5000)).toBe(null);
    expect(stripSliceLimit(800, 2, 'WebP')).toBe(4096);
    // The default height, 8000, in a WebP.
    expect(stripSliceBlock(pages, 'WebP', 2, 800, SLICE_H_DEFAULT)).toBe('At 2x, set Slice height to 4096 or less');
  });

  it('judges a short strip by its own height, not the height a slice could be', () => {
    // One page, 3000 tall: no cut can be taller than the strip.
    expect(stripSliceBlock([{ w: 800, h: 3000 }], 'WebP', 2, 800, SLICE_H_DEFAULT)).toBe(null);
  });

  it('says so when no Slice height can fit the column’s width', () => {
    // 40,000 wide is 80,000 at 2x: under 3,356 rows fit WebKit's area, under
    // the shortest Slice height can cut.
    expect(stripSliceBlock(pages, 'PNG', 2, 40000, SLICE_H_DEFAULT)).toBe('This strip is too wide for 2x');
  });

  it('judges nothing at the page’s own size, nor for a PSD', () => {
    expect(stripSliceBlock(pages, 'WebP', 1, 800, 5000)).toBe(null);
    expect(stripSliceBlock(pages, 'PSD', 2, 800, 5000)).toBe(null);
  });
});

// The export itself, with a canvas that answers to anything and records its
// size: what is under test is the size asked for and the refusal.
let made;
let downloaded;
const real = { document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
const anything = () =>
  new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => undefined), set: (t, k, v) => ((t[k] = v), true) });

beforeEach(() => {
  jobs.items = [];
  app.exportDir = '';
  made = [];
  downloaded = [];
  globalThis.document = {
    fonts: { ready: Promise.resolve() },
    createElement: (tag) => {
      if (tag !== 'canvas') return { click() { downloaded.push(this.download); } };
      const canvas = { width: 0, height: 0, getContext: anything, toBlob: (cb) => cb(new Blob(['x'])) };
      made.push(canvas);
      return canvas;
    },
  };
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => {};
  app.exportName = 'ch01';
  app.projectLayout = 'pages';
  setFontSource(null);
});
afterEach(() => {
  releaseAllPageImages();
  app.projectLayout = 'pages';
  loadProjectPages([]);
  globalThis.document = real.document;
  URL.createObjectURL = real.create;
  URL.revokeObjectURL = real.revoke;
  vi.restoreAllMocks();
});

// The page canvases an export drew on, by the size they were made at. Each is
// handed back (0 x 0) after its file is made, so the size is caught on the
// way in.
function sizes() {
  const seen = [];
  const create = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const c = create(tag);
    if (tag !== 'canvas') return c;
    let w = 0;
    let h = 0;
    return Object.defineProperties(c, {
      width: { get: () => w, set: (v) => void (w = v) },
      height: { get: () => h, set: (v) => { h = v; if (w && v) seen.push([w, v]); } },
    });
  };
  return seen;
}

describe('an export at 2x', () => {
  it('draws each page twice its size each way', async () => {
    loadProjectPages([{ id: 11, w: 801, h: 1203, lines: [], boxes: [] }]);
    const seen = sizes();
    expect(await exportImages('PNG', 'current', 2)).toBe(true);
    expect(seen).toEqual([[1602, 2406]]);
    expect(downloaded).toEqual(['ch01-11.png']);
  });

  it('at Original is the page’s own size, as before', async () => {
    loadProjectPages([{ id: 11, w: 801, h: 1203, lines: [], boxes: [] }]);
    const seen = sizes();
    expect(await exportImages('PNG', 'current')).toBe(true);
    expect(seen).toEqual([[801, 1203]]);
  });

  it('refuses a chapter with a page too large for it, by name, and writes nothing', async () => {
    loadProjectPages([
      { id: 11, w: 800, h: 1200, lines: [], boxes: [] },
      { id: 22, w: 9000, h: 9000, lines: [], boxes: [] },
    ]);
    const seen = sizes();
    expect(await exportImages('PNG', 'all', 2)).toBe(false);
    expect(seen).toEqual([]);
    expect(downloaded).toEqual([]);
    expect(app.toast.msg).toMatch(/^Export failed: Page 2 is too large for 2x\. 0 files were written\.$/);
    expect(app.exporting).toBe(false);
  });

  it('refuses that page alone too, and lets the page beside it go', async () => {
    loadProjectPages([
      { id: 11, w: 800, h: 1200, lines: [], boxes: [] },
      { id: 22, w: 9000, h: 9000, lines: [], boxes: [] },
    ]);
    app.pageIndex = 1;
    expect(await exportImages('JPG', 'current', 2)).toBe(false);
    expect(app.toast.msg).toMatch(/Page 2 is too large for 2x/);
    app.pageIndex = 0;
    expect(await exportImages('JPG', 'current', 2)).toBe(true);
    expect(downloaded).toEqual(['ch01-11.jpg']);
  });
});

describe('a strip export at 2x', () => {
  const strip = () => Array.from({ length: 4 }, (_, i) => ({ id: i + 1, w: 800, h: 3000, lines: [], boxes: [] }));
  afterEach(() => {
    app.stripSliceH = SLICE_H_DEFAULT;
  });

  it('writes one page of a strip at the default Slice height in a WebP', async () => {
    app.projectLayout = 'longstrip';
    loadProjectPages(strip());
    app.pageIndex = 1;
    const seen = sizes();
    expect(await exportImages('WebP', 'current', 2)).toBe(true);
    // The page, at twice the strip's width and its own height twice.
    expect(seen[0]).toEqual([1600, 6000]);
    expect(downloaded).toEqual(['ch01-2.webp']);
  });

  it('refuses a whole strip whose cut slice is past a WebP at 2x, naming a Slice height that works', async () => {
    app.projectLayout = 'longstrip';
    // Cut about every 9,000 px: 18,000 at 2x, past a WebP's side.
    app.stripSliceH = 9000;
    loadProjectPages(strip());
    const seen = sizes();
    expect(await exportImages('WebP', 'all', 2)).toBe(false);
    expect(seen).toEqual([]);
    expect(app.toast.msg).toMatch(/^Export failed: Slice 1 is too large for 2x\. Set Slice height to 4096 or less\. 0 files were written\.$/);
  });
});

describe('a type layer stated in a 2x document', () => {
  const px = (value) => ({ units: 'Pixels', value });
  const layer = {
    name: 'HI',
    left: 10, top: 20, right: 110, bottom: 60,
    effects: {
      stroke: [{ size: px(3), position: 'outside' }, { size: px(1.5) }],
      dropShadow: [{ size: px(5), distance: px(4), choke: px(20), angle: 120 }],
      innerShadow: [{ size: px(2), distance: px(1), choke: px(10) }],
      outerGlow: { size: px(6), choke: px(30), range: 0.5 },
      innerGlow: { size: px(7), choke: px(0) },
      satin: { size: px(8), distance: px(9), angle: 19 },
      bevel: { size: px(4), soften: px(2), strength: 1, angle: 120 },
      gradientOverlay: [{ scale: 1, offset: { x: 0.1, y: 0.2 }, angle: 90 }],
    },
    text: {
      text: 'HI',
      transform: [0.9, 0.1, -0.1, 0.9, 50, 70],
      boxBounds: [0, 0, 120, 44],
      style: { fontSize: 22, leading: 24.2, tracking: 50, font: { name: 'X' } },
      styleRuns: [{ length: 1, style: {} }, { length: 1, style: { font: { name: 'Y' } } }],
      paragraphStyleRuns: [{ length: 3, style: { startIndent: 6, autoHyphenate: false } }],
    },
  };

  it('doubles every length Photoshop reads in document pixels, and nothing else', () => {
    const out = scaleTypeLayer(layer, 2);
    const fx = out.effects;
    expect(fx.stroke.map((e) => e.size.value)).toEqual([6, 3]);
    expect([fx.dropShadow[0].size.value, fx.dropShadow[0].distance.value]).toEqual([10, 8]);
    expect([fx.innerShadow[0].size.value, fx.innerShadow[0].distance.value]).toEqual([4, 2]);
    expect(fx.outerGlow.size.value).toBe(12);
    expect(fx.innerGlow.size.value).toBe(14);
    expect([fx.satin.size.value, fx.satin.distance.value]).toEqual([16, 18]);
    expect([fx.bevel.size.value, fx.bevel.soften.value]).toEqual([8, 4]);
    // Choke is a percent in a Pixels wrapper; angles, range, strength,
    // gradient scale and offset are not lengths.
    expect([fx.dropShadow[0].choke.value, fx.innerShadow[0].choke.value, fx.outerGlow.choke.value]).toEqual([20, 10, 30]);
    expect([fx.dropShadow[0].angle, fx.outerGlow.range, fx.bevel.strength, fx.satin.angle]).toEqual([120, 0.5, 1, 19]);
    expect(fx.gradientOverlay[0]).toEqual(layer.effects.gradientOverlay[0]);
    const t = out.text;
    expect(t.transform).toEqual([0.9, 0.1, -0.1, 0.9, 100, 140]);
    expect(t.boxBounds).toEqual([0, 0, 240, 88]);
    expect([t.style.fontSize, t.style.leading, t.style.tracking]).toEqual([44, 48.4, 50]);
    expect(t.styleRuns).toEqual(layer.text.styleRuns);
    expect(t.paragraphStyleRuns[0].style).toEqual({ startIndent: 12, autoHyphenate: false });
    // The raster's bounds are the document's already; the box's own are not.
    expect([out.left, out.top, out.right, out.bottom]).toEqual([10, 20, 110, 60]);
    const boxed = scaleTypeLayer(layer, 2, true);
    expect([boxed.left, boxed.top, boxed.right, boxed.bottom]).toEqual([20, 40, 220, 120]);
    // The layer handed in is left as it was.
    expect(layer.effects.stroke[0].size.value).toBe(3);
    expect(layer.text.style.fontSize).toBe(22);
  });
});
