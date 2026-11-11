// ===== Opening what an older build wrote =====
//
// Every fixture in this file is a LITERAL JSON string in the shape a previous
// release actually persisted - not a hand-built object in today's shape with a
// field removed. That is the whole point: the app's promise is that a project
// on somebody's disk keeps working across an update, and the only honest way to
// test it is to feed it the bytes that are on that disk.
//
// Two eras are covered, and they are the two that shipped:
//
//   ERA 1  the oldest chapters. A style is a handful of flat keys - no
//          `shadow` group, no `roughen`, no `shape`/`minOrphan`/`hyphenate`,
//          no `balloon`/`autoHeight`, no `flipH`/`flipV`/`curve`.
//   ERA 2  the last release before this change set. `outline` + `outlineWidth`
//          are the outline, `shadow { on, x, y, blur, color, opacity }` is the
//          shadow, and there is no such thing as a gradient or a pattern.
//
// Anything newer than era 2 has never been written to anyone's disk, so the
// gradient/pattern cases here are gates rather than migrations: they prove that
// a partial or hand-edited group degrades to something both renderers can paint.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { normalizeStyle, defaultStyle, PATTERN_KINDS, openTypesetting, PLAIN_BREAKS, plainStyle, normalizeAuto, normalizeStrokeEffect, outlineBands } from './data.js';

// An old outline band as the stroke it migrates to: Outside, its colour, as
// wide as the bands up to it (`strokesFromBands`).
const outside = (color, size, opacity = 1) => normalizeStrokeEffect({ size, position: 'outside', color, opacity });
import { parsePresets } from './presets.svelte.js';
import { normalizeTranslations } from './importer.js';
import { migrateEntry, migrateDoc } from './editor/history-file.svelte.js';
import { app, loadProjectPages, pageById, byId } from './store.svelte.js';
import { sanitizeGuide, emptyGuide } from './guide.svelte.js';
import { initHistory, loadStack, undo, redo, resetHistory } from './editor/history.svelte.js';

// ---------------------------------------------------------------------------
// the fixtures
// ---------------------------------------------------------------------------

// An era-2 style, exactly as `defaultStyle()` serialised it before strokes.
const ERA2_STYLE = `{
  "font": "Bangers",
  "size": 34,
  "bold": true,
  "italic": false,
  "align": "center",
  "valign": "middle",
  "color": "#1a1a1a",
  "opacity": 1,
  "uppercase": true,
  "outline": "#ff0044",
  "outlineWidth": 5,
  "lineHeight": 1.1,
  "letterSpacing": 0,
  "rotation": 0,
  "flipH": false,
  "flipV": false,
  "shadow": { "on": true, "x": 3, "y": 4, "blur": 6, "color": "#112233", "opacity": 0.5 },
  "roughen": { "on": false, "amount": 4, "detail": 0.05, "seed": 7 },
  "curve": 0,
  "shape": "auto",
  "minOrphan": 3,
  "hyphenate": true,
  "balloon": true,
  "autoHeight": true
}`;

// An era-1 style: the flat keys and nothing else.
const ERA1_STYLE = `{
  "font": "Comic Neue",
  "size": 26,
  "bold": true,
  "align": "left",
  "color": "#101010",
  "outline": "#00ff88",
  "outlineWidth": 2,
  "lineHeight": 1.2
}`;

// A whole chapter.json from era 2, carrying every page shape the loader has to
// survive: an unmeasured page (w/h 0), a page with no `detect` at all, a page
// whose `detect` has panels but no boxes, a box with `lineN: null` (the old
// canvas-only text box), tags on one line and none on another.
const ERA2_CHAPTER = `{
  "schema": 1,
  "id": "ch_abc",
  "number": "12",
  "title": "The Duel",
  "createdAt": "2026-01-04T10:00:00.000Z",
  "updatedAt": "2026-01-09T18:22:13.000Z",
  "pages": [
    {
      "id": 1,
      "file": "001.png",
      "cleaned": "001.png",
      "w": 1200,
      "h": 1700,
      "lines": [
        { "n": 1, "type": "dialogue", "jp": "\\u3042", "en": "Ah.", "tags": ["shout"] },
        { "n": 2, "type": "sfx", "jp": "\\u30c9\\u30f3", "en": "DOOM" }
      ],
      "detect": {
        "panels": [[0, 0, 1200, 850]],
        "boxes": [{ "n": 1, "box": [100, 120, 300, 260], "vertical": true, "font_size": 30 }]
      },
      "boxes": [
        {
          "id": "b1",
          "lineN": 1,
          "text": null,
          "x": 110,
          "y": 130,
          "w": 180,
          "h": 120,
          "style": ${ERA2_STYLE},
          "fit": { "kind": "ellipse", "cx": 200, "cy": 190, "rx": 90, "ry": 60 }
        },
        {
          "id": "b2",
          "lineN": null,
          "text": "hand-typed",
          "x": 400,
          "y": 900,
          "w": 200,
          "h": 60,
          "style": ${ERA1_STYLE}
        }
      ]
    },
    {
      "id": 2,
      "file": "002.png",
      "cleaned": null,
      "w": 0,
      "h": 0,
      "lines": [],
      "detect": { "panels": [[0, 0, 100, 100]] },
      "boxes": []
    },
    {
      "id": 3,
      "file": "003.png",
      "cleaned": null,
      "w": 1200,
      "h": 1700,
      "lines": [{ "n": 1, "type": "narration", "jp": "", "en": "Later." }],
      "boxes": []
    }
  ]
}`;

// A logs/history.json from era 2. Every kind that carries a payload is here,
// and the `place` / `delete` pair carry a whole box - which is the one the
// canvas used to throw on.
const ERA2_HISTORY = `{
  "version": 1,
  "pages": {
    "1": {
      "undo": [
        {
          "t": "place",
          "pageId": 1,
          "boxId": "b9",
          "index": 0,
          "activeBefore": 1,
          "activeAfter": 2,
          "box": {
            "id": "b9",
            "lineN": 1,
            "text": null,
            "x": 10,
            "y": 20,
            "w": 150,
            "h": 90,
            "style": ${ERA2_STYLE}
          }
        },
        {
          "t": "move",
          "pageId": 1,
          "boxId": "b1",
          "before": { "x": 10, "y": 20 },
          "after": { "x": 30, "y": 40 }
        },
        {
          "t": "resize",
          "pageId": 1,
          "boxId": "b1",
          "before": { "w": 100, "h": 40, "size": 20 },
          "after": { "w": 200, "h": 80, "size": 28 }
        },
        {
          "t": "text",
          "pageId": 1,
          "boxId": "b1",
          "before": "old words",
          "after": "new words"
        },
        {
          "t": "style",
          "pageId": 1,
          "boxId": "b1",
          "before": ${ERA1_STYLE},
          "after": ${ERA2_STYLE}
        }
      ],
      "redo": [
        {
          "t": "delete",
          "pageId": 1,
          "boxId": "b7",
          "index": 1,
          "box": {
            "id": "b7",
            "lineN": 2,
            "text": null,
            "x": 1,
            "y": 2,
            "w": 3,
            "h": 4,
            "style": ${ERA1_STYLE}
          }
        }
      ]
    },
    "2": {
      "undo": [
        {
          "t": "bulk",
          "pageId": 2,
          "items": [
            { "pageId": 2, "boxId": "b3", "before": ${ERA1_STYLE}, "after": ${ERA2_STYLE} }
          ]
        }
      ],
      "redo": []
    }
  }
}`;

// A translations.json from era 2: an unmeasured page exported `width`/`height`
// as the app's fallback page size rather than saying it did not know.
const ERA2_TRANSLATIONS = `{
  "pages": [
    {
      "page": 1,
      "width": 1200,
      "height": 1700,
      "panels": [[0, 0, 1200, 850]],
      "lines": [
        { "n": 1, "jp": "\\u3042", "en": "Ah.", "type": "dialogue", "tags": ["shout"],
          "box": [100, 120, 300, 260], "placed": { "x": 110, "y": 130, "w": 180, "h": 120 } },
        { "n": 2, "jp": "\\u30c9\\u30f3", "en": "DOOM", "type": "sfx", "box": null, "placed": null }
      ]
    },
    { "page": 2, "width": 850, "height": 1200, "panels": [], "lines": [] }
  ]
}`;

// The same file as this build writes it: an unmeasured page says `null`.
const NOW_TRANSLATIONS = ERA2_TRANSLATIONS.replace(
  '{ "page": 2, "width": 850, "height": 1200,',
  '{ "page": 2, "width": null, "height": null,',
);

// ---------------------------------------------------------------------------
// 1. chapter.json - the style schema
// ---------------------------------------------------------------------------

describe('a style written before strokes and shadows were lists', () => {
  it('keeps an era-2 outline as the innermost stroke, with its colour and width', () => {
    const s = normalizeStyle(JSON.parse(ERA2_STYLE));
    expect(s.strokeEffects).toEqual([outside('#ff0044', 5)]);
  });

  it('keeps an era-2 shadow, exactly where it was cast', () => {
    const s = normalizeStyle(JSON.parse(ERA2_STYLE));
    // Its blur becomes the Size that blurs as much, and it stays Normal,
    // with no knockout and its own angle: exactly as it looked.
    expect(s.shadows).toEqual([{ x: 3, y: 4, size: 7.5, color: '#112233', opacity: 0.5, spread: 0, noise: 0, blend: 'normal', contour: { preset: 'linear', aa: false }, knockout: false, useGlobalLight: false }]);
  });

  it('reads a switched-off shadow as no shadow rather than as a black one', () => {
    const off = { ...JSON.parse(ERA2_STYLE), shadow: { on: false, x: 9, y: 9, blur: 9, color: '#ff0000', opacity: 1 } };
    expect(normalizeStyle(off).shadows).toEqual([]);
  });

  it('reads outlineWidth 0 as no outline, not as a default one', () => {
    const none = { ...JSON.parse(ERA2_STYLE), outlineWidth: 0 };
    expect(normalizeStyle(none).strokeEffects).toEqual([]);
  });

  it('migrates an era-1 style, whose keys stop well short of the schema', () => {
    const s = normalizeStyle(JSON.parse(ERA1_STYLE));
    const d = defaultStyle();
    expect(s.strokeEffects).toEqual([outside('#00ff88', 2)]);
    expect(s.shadows).toEqual([]);
    // Everything era 1 never heard of answers to today's default, so the
    // chapter opens with shaping, hyphenation and auto-height on.
    expect(s.shape).toBe(d.shape);
    expect(s.minOrphan).toBe(d.minOrphan);
    expect(s.hyphenate).toBe(d.hyphenate);
    expect(s.balloon).toBe(d.balloon);
    expect(s.autoHeight).toBe(d.autoHeight);
    expect(s.roughen).toEqual(d.roughen);
    expect(s.curve).toBe(0);
    expect(s.flipH).toBe(false);
    // …and what it DID say survives untouched.
    expect(s.font).toBe('Comic Neue');
    expect(s.size).toBe(26);
    expect(s.align).toBe('left');
    expect(s.color).toBe('#101010');
    expect(s.lineHeight).toBe(1.2);
  });

  it('leaves no legacy key behind for a later reader to trust', () => {
    const s = normalizeStyle(JSON.parse(ERA2_STYLE));
    expect('outline' in s).toBe(false);
    expect('outlineWidth' in s).toBe(false);
    expect('shadow' in s).toBe(false);
  });

  it('fills the fill fields no old style ever had', () => {
    const s = normalizeStyle(JSON.parse(ERA1_STYLE));
    expect(s.gradient.on).toBe(false);
    expect(s.gradient.stops).toHaveLength(2);
    expect(s.pattern.on).toBe(false);
    expect(PATTERN_KINDS).toContain(s.pattern.kind);
    expect(s.fillOpacity).toBe(1);
    expect(s.blendMode).toBe('normal');
    expect(s.blur).toBe(0);
  });

  it('folds legacy fillOpacity into whole-box opacity', () => {
    const s = normalizeStyle({ fillOpacity: 0.5, opacity: 0.8 });
    expect(s.opacity).toBeCloseTo(0.4);
    // The old field is gone into opacity; today's Fill Opacity starts full.
    expect(s.fillOpacity).toBe(1);
    const full = normalizeStyle({ fillOpacity: 1 });
    expect(full.opacity).toBe(1);
  });

  it('migrates legacy motionBlur by dropping length/angle while keeping on and defaulting x/y/amount', () => {
    const s = normalizeStyle({ motionBlur: { on: true, length: 40, angle: 90 } });
    expect(s.motionBlur).toEqual({ on: true, x: 2, y: 0, amount: 16 });
  });

  // The mask moved out of the style onto the box, pinned to the page
  // (box-mask.js): a style read alone keeps none, and a chapter load carries
  // a saved one to the box, through the box as it was saved.
  it('reads a style mask as none, and a chapter load carries it to the box in page px', () => {
    expect('clip' in normalizeStyle({ clip: { on: true } })).toBe(false);
    loadProjectPages([
      {
        id: 21,
        w: 800,
        h: 600,
        lines: [],
        boxes: [
          { id: 'm1', lineN: null, text: 'A', x: 100, y: 50, w: 200, h: 100, style: { clip: { on: true, mode: 'include', brushSize: 9, shapes: [{ kind: 'poly', pts: [[0, 0], [10, 0], [0, 10]] }] } } },
          { id: 'm2', lineN: null, text: 'B', x: 0, y: 0, w: 40, h: 40, style: { clip: { on: true } } },
          { id: 'm3', lineN: null, text: 'C', x: 0, y: 0, w: 40, h: 40, style: {} },
          { id: 'm4', lineN: null, text: 'D', x: 0, y: 0, w: 40, h: 40, style: { clip: { on: true, mode: 'include', shapes: [{ kind: 'poly', pts: [[0, 0], [1, 0], [0, 1]] }] } }, mask: { on: false, shapes: [] } },
        ],
      },
    ]);
    const p = pageById(21);
    expect(p.boxes[0].mask).toEqual({ on: true, shapes: [{ kind: 'poly', op: 'keep', pts: [[100, 50], [110, 50], [100, 60]] }] });
    expect('clip' in p.boxes[0].style).toBe(false);
    expect(p.boxes[1].mask).toEqual({ on: true, shapes: [] });
    // A box with no mask has no key, so its document reads as it always did.
    expect('mask' in p.boxes[2]).toBe(false);
    // A box saved with its own mask keeps it, whatever its style says.
    expect(p.boxes[3].mask).toEqual({ on: false, shapes: [] });
  });

  it('is idempotent, so a migrated style survives every later save', () => {
    const once = normalizeStyle(JSON.parse(ERA2_STYLE));
    expect(normalizeStyle(once)).toEqual(once);
  });

  it('takes a style that already has strokes as written, ignoring stale legacy keys', () => {
    const mixed = {
      ...JSON.parse(ERA2_STYLE),
      strokes: [{ color: '#000000', width: 1, opacity: 0.5 }, { color: '#ffffff', width: 4, opacity: 1 }],
      shadows: [],
    };
    const s = normalizeStyle(mixed);
    // The bands become strokes as wide as the bands up to them, and lay the
    // same rings; the list has no `strokes` key left.
    expect(s.strokeEffects).toEqual([outside('#000000', 1, 0.5), outside('#ffffff', 5)]);
    expect(outlineBands(s)).toEqual([
      { color: '#000000', width: 1, opacity: 0.5 },
      { color: '#ffffff', width: 4, opacity: 1 },
    ]);
    expect('strokes' in s).toBe(false);
    expect(s.shadows).toEqual([]);
  });

  // Gradients never shipped, so these are gates on a hand-edited or
  // future-written file rather than migrations of anything on a real disk.
  it('gives a two-stop gradient with no per-stop alpha the alpha it was painting with', () => {
    const s = normalizeStyle({
      gradient: { on: true, angle: 90, scope: 'box', stops: [{ color: '#ffffff', pos: 0 }, { color: '#000000', pos: 1 }] },
    });
    expect(s.gradient.stops).toEqual([
      { color: '#ffffff', pos: 0, opacity: 1 },
      { color: '#000000', pos: 1, opacity: 1 },
    ]);
    // Radial arrived after linear; a file with none of its fields keeps painting
    // exactly as it did.
    expect(s.gradient.kind).toBe('linear');
    expect(s.gradient.cx).toBe(0.5);
    expect(s.gradient.cy).toBe(0.5);
    expect(s.gradient.radius).toBe(1);
  });

  it('sorts a gradient’s stops and refuses a one-stop ramp', () => {
    const s = normalizeStyle({
      gradient: { on: true, stops: [{ color: '#111111', pos: 0.9 }, { color: '#222222', pos: 0.1 }] },
    });
    expect(s.gradient.stops.map((x) => x.pos)).toEqual([0.1, 0.9]);
    const one = normalizeStyle({ gradient: { on: true, stops: [{ color: '#111111', pos: 0 }] } });
    expect(one.gradient.stops).toEqual(defaultStyle().gradient.stops);
  });

  it('folds a pattern kind this build cannot draw back to one it can', () => {
    const s = normalizeStyle({ pattern: { on: true, kind: 'moire-of-the-future', fg: '#000000', bg: '#ffffff' } });
    expect(s.pattern.kind).toBe(defaultStyle().pattern.kind);
  });

  // The pattern of the release before the Rust fill: five keys. Every new
  // field takes the default that paints what those five painted.
  it('gives a five-key pattern the new fields at their old look', () => {
    // It is the Pattern Overlay's now, at Normal 100 %, which paints the
    // same (`foldPatternFill`, pattern-fold.engine.test.js).
    const s = normalizeStyle(JSON.parse(`{"pattern": {"on": true, "kind": "halftone", "fg": "#112233", "bg": "#ffffff", "scale": 1.5}}`));
    expect(s.pattern.on).toBe(false);
    expect(s.patternOverlay).toMatchObject({ on: true, blend: 'normal', opacity: 1 });
    const p = s.patternOverlay.pattern;
    expect(p).toEqual({
      ...defaultStyle().pattern,
      on: true,
      kind: 'halftone',
      fg: '#112233',
      scale: 1.5,
    });
    expect(p.density).toBe(0.5);
    expect(p.angle).toBe(0);
    expect(p.aspect).toBe(1);
    expect([p.ox, p.oy]).toEqual([0, 0]);
    expect([p.fgOpacity, p.bgOpacity]).toEqual([1, 1]);
    expect(p.fade.on).toBe(false);
    expect(p.anchor).toBe('box');
    expect(p.src).toBe('');
    expect(p.cell).toEqual([]);
  });

  it('clamps a hand-edited pattern and drops a picked tile it cannot find', () => {
    const s = normalizeStyle({
      pattern: {
        on: true, kind: 'picked', src: '../../etc/passwd', cell: [8, 0, 0, 8],
        density: 3, aspect: 0, ox: -2, fgOpacity: 'x', fade: { on: 1, from: -1, to: 9 },
        anchor: 'sky', seed: 0.2, mode: 'paint',
      },
    }).pattern;
    expect(s.kind).toBe(defaultStyle().pattern.kind);
    expect(s.src).toBe('');
    expect(s.density).toBe(1);
    expect(s.aspect).toBe(0.25);
    expect(s.ox).toBe(0);
    expect(s.fgOpacity).toBe(1);
    expect(s.fade).toEqual({ on: false, angle: 180, from: 0, to: 1 });
    expect(s.anchor).toBe('box');
    expect(s.seed).toBe(1);
    expect(s.mode).toBe('tone');
  });

  it('keeps a picked tile with a file name and a cell', () => {
    const src = '0123456789abcdef.png';
    const s = normalizeStyle({ pattern: { on: true, kind: 'picked', src, cell: [6.5, 0, 3.25, 6.5], mode: 'image' } }).pattern;
    expect(s.kind).toBe('picked');
    expect(s.src).toBe(src);
    expect(s.cell).toEqual([6.5, 0, 3.25, 6.5]);
    expect(s.mode).toBe('image');
    // Two parallel edges are no cell at all.
    expect(normalizeStyle({ pattern: { kind: 'picked', src, cell: [4, 0, 8, 0] } }).pattern.kind).toBe('dots');
  });

  it('keeps every engine pattern kind', () => {
    for (const kind of PATTERN_KINDS) expect(normalizeStyle({ pattern: { kind } }).pattern.kind).toBe(kind);
  });

  it('keeps a block shape it knows and folds any other back to auto', () => {
    for (const shape of ['auto', 'oval', 'rect', 'off']) expect(normalizeStyle({ shape }).shape).toBe(shape);
    expect(normalizeStyle({ shape: 'hexagon' }).shape).toBe('auto');
    expect(normalizeStyle({ shape: 3 }).shape).toBe('auto');
    expect(normalizeStyle({}).shape).toBe(defaultStyle().shape);
  });

  // `margin` turns on the outline fit. A style written before it has none, and
  // must keep the older layout, so its boxes stay where they were.
  it('reads a style with no margin as the older layout, and keeps one it wrote', () => {
    expect(normalizeStyle(JSON.parse(ERA1_STYLE)).margin).toBeNull();
    expect(normalizeStyle({}).margin).toBeNull();
    expect(normalizeStyle({ margin: 0.5 }).margin).toBe(0.5);
    expect(normalizeStyle({ margin: 0 }).margin).toBe(0);
    expect(normalizeStyle({ margin: 9 }).margin).toBe(2);
    expect(normalizeStyle({ margin: 'wide' }).margin).toBeNull();
    expect(normalizeStyle({ margin: true }).margin).toBeNull();
  });
});

// The solver record (`box.auto`) gained `breaks`, the line starts a
// box holds to. A record from before it has none, and a broken one is dropped
// rather than trusted.
describe('a solver record from before kept line breaks', () => {
  const OLD_AUTO = '{"on":true,"refSize":18,"locks":{"size":false,"width":false,"height":false,"pos":false},"status":"ok","reason":null,"stamp":"abc"}';
  it('reads a record with no breaks as none, and no breaks lock', () => {
    const a = normalizeAuto(JSON.parse(OLD_AUTO));
    expect('breaks' in a).toBe(false);
    expect(a.locks.breaks).toBe(false);
    expect(a.refSize).toBe(18);
  });
  it('keeps breaks it wrote and drops ones it cannot use', () => {
    const base = JSON.parse(OLD_AUTO);
    expect(normalizeAuto({ ...base, breaks: { key: 'k1', at: [0, 4, 9] } }).breaks).toEqual({ key: 'k1', at: [0, 4, 9] });
    for (const bad of [{ key: 'k', at: [4, 9] }, { key: 'k', at: [0, 9, 4] }, { key: '', at: [0] }, { at: [0] }, 'k', 3]) {
      expect('breaks' in normalizeAuto({ ...base, breaks: bad })).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. chapter.json - the page records
// ---------------------------------------------------------------------------

describe('a whole chapter.json from the last release', () => {
  let record;
  beforeEach(() => {
    record = JSON.parse(ERA2_CHAPTER);
    loadProjectPages(record.pages);
  });

  it('loads every page, keeping the ids the file gave them', () => {
    expect(app.pages.map((p) => p.id)).toEqual([1, 2, 3]);
  });

  it('keeps the boxes’ persisted ids rather than minting new ones', () => {
    expect(pageById(1).boxes.map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it('leaves an unmeasured page unmeasured rather than inventing a space', () => {
    expect([pageById(2).w, pageById(2).h]).toEqual([0, 0]);
    expect([pageById(1).w, pageById(1).h]).toEqual([1200, 1700]);
  });

  it('reads a detect with panels and no boxes as an empty box list', () => {
    expect(pageById(2).detect).toEqual({ panels: [[0, 0, 100, 100]], boxes: [] });
  });

  it('reads a detect saved before text masks as having no mask, and drops a bad one', () => {
    expect('mask' in pageById(2).detect).toBe(false);
    loadProjectPages([
      { id: 11, w: 0, h: 0, lines: [], boxes: [], detect: { panels: [], boxes: [], mask: { file: '001.jpg.png', w: 800, h: 1200 } } },
      { id: 12, w: 0, h: 0, lines: [], boxes: [], detect: { panels: [], boxes: [], mask: { file: '../x.png', w: 800, h: 1200 } } },
      { id: 13, w: 0, h: 0, lines: [], boxes: [], detect: { panels: [], boxes: [], mask: { file: 'a.png' } } },
    ]);
    expect(pageById(11).detect.mask).toEqual({ file: '001.jpg.png', w: 800, h: 1200 });
    expect('mask' in pageById(12).detect).toBe(false);
    expect('mask' in pageById(13).detect).toBe(false);
  });

  it('keeps the second detector’s kind on a detected box, and an old box has none', () => {
    expect(pageById(2).detect.boxes).toEqual([]);
    loadProjectPages([{ id: 14, w: 0, h: 0, lines: [], boxes: [], detect: { panels: [], boxes: [
      { n: 1, box: [0, 0, 10, 10], vertical: true, font_size: 9 },
      { n: 2, box: [20, 0, 30, 10], vertical: true, font_size: 9, kind: 'free' },
    ] } }]);
    const [a, b] = pageById(14).detect.boxes;
    expect('kind' in a).toBe(false);
    expect(b.kind).toBe('free');
  });

  it('reads a page with no detect at all as having none', () => {
    expect(pageById(3).detect).toBeNull();
  });

  it('reads a record with no needsRespace as a page that needs none', () => {
    expect(app.pages.every((p) => p.needsRespace === false)).toBe(true);
  });

  it('migrates every box’s style on the way in, both eras at once', () => {
    expect(byId('b1').style.strokeEffects).toEqual([outside('#ff0044', 5)]);
    expect(byId('b1').style.shadows).toHaveLength(1);
    expect(byId('b2').style.strokeEffects).toEqual([outside('#00ff88', 2)]);
    // Every style the canvas will read has the groups it reads unguarded.
    for (const p of app.pages) {
      for (const b of p.boxes) {
        expect(b.style.gradient).toBeTruthy();
        expect(b.style.pattern).toBeTruthy();
        expect(Array.isArray(b.style.strokeEffects)).toBe(true);
        expect('strokes' in b.style).toBe(false);
        expect(Array.isArray(b.style.shadows)).toBe(true);
      }
    }
  });

  it('keeps a canvas-only box exactly as it was - lineN null, not renumbered', () => {
    expect(byId('b2').lineN).toBeNull();
    expect(byId('b2').text).toBe('hand-typed');
  });

  it('keeps the balloon a box was fitted to', () => {
    expect(byId('b1').fit).toEqual({ kind: 'ellipse', cx: 200, cy: 190, rx: 90, ry: 60 });
  });

  it('gives a box saved before bubble outlines no outline record', () => {
    expect('outline' in byId('b1')).toBe(false);
    expect('outline' in byId('b2')).toBe(false);
  });

  it('keeps the lines, their tags, and the silence of a line that has none', () => {
    const [l1, l2] = pageById(1).lines;
    expect(l1.tags).toEqual(['shout']);
    expect('tags' in l2).toBe(false);
    expect(l2.type).toBe('sfx');
  });

  it('gives a page saved before page notes an empty note', () => {
    expect(pageById(1).note).toBe('');
    loadProjectPages([{ id: 8, w: 0, h: 0, note: 'Rain all page.', lines: [], boxes: [] }, { id: 7, w: 0, h: 0, note: 3, lines: [], boxes: [] }]);
    expect(pageById(8).note).toBe('Rain all page.');
    expect(pageById(7).note).toBe('');
  });

  it('gives a line saved before speakers no speaker, and drops one of the wrong type', () => {
    const [l1, l2] = pageById(1).lines;
    expect('speaker' in l1).toBe(false);
    expect('speaker' in l2).toBe(false);
    loadProjectPages([{ id: 9, w: 0, h: 0, lines: [{ n: 1, jp: '', en: 'a', speaker: 'g1' }, { n: 2, jp: '', en: 'b', speaker: 7 }], boxes: [] }]);
    const [a, b] = pageById(9).lines;
    expect(a.speaker).toBe('g1');
    expect('speaker' in b).toBe(false);
  });

  it('gives a line saved before the second reader no other reading, and drops one of the wrong type', () => {
    const [l1, l2] = pageById(1).lines;
    expect('jp2' in l1).toBe(false);
    expect('jp2' in l2).toBe(false);
    loadProjectPages([{ id: 10, w: 0, h: 0, lines: [{ n: 1, jp: '猫', en: '', jp2: '描' }, { n: 2, jp: 'a', en: '', jp2: 4 }, { n: 3, jp: 'b', en: '', jp2: '' }], boxes: [] }]);
    const [a, b, c] = pageById(10).lines;
    expect(a.jp2).toBe('描');
    expect('jp2' in b).toBe(false);
    expect('jp2' in c).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. logs/history.json
// ---------------------------------------------------------------------------

describe('an undo history written before the style schema moved', () => {
  const parsed = () => JSON.parse(ERA2_HISTORY);

  it('migrates the style inside a place entry’s box', () => {
    const e = migrateEntry(parsed().pages['1'].undo[0]);
    expect(e.box.style.strokeEffects).toEqual([outside('#ff0044', 5)]);
    expect(e.box.style.gradient).toBeTruthy();
    expect(e.box.style.pattern).toBeTruthy();
    // Everything else about the record is untouched.
    expect(e.t).toBe('place');
    expect(e.index).toBe(0);
    expect(e.activeBefore).toBe(1);
    expect(e.box.x).toBe(10);
  });

  // A place entry recorded after strokes but before the Rust pattern fill:
  // the style is current in every other way, and its pattern has five keys.
  it('migrates a box whose pattern predates the Rust fill', () => {
    const style = normalizeStyle({});
    style.pattern = JSON.parse('{"on": true, "kind": "grid", "fg": "#000000", "bg": "#ffffff", "scale": 2}');
    const e = migrateEntry({ t: 'place', index: 0, box: { id: 'b1', x: 0, y: 0, w: 50, h: 20, text: 'A', style } });
    expect(e.box.style.pattern).toEqual({ ...defaultStyle().pattern, on: false, kind: 'grid', scale: 2 });
    expect(e.box.style.patternOverlay.pattern).toEqual({ ...defaultStyle().pattern, on: true, kind: 'grid', scale: 2 });
  });

  it('migrates a delete entry’s box the same way', () => {
    const e = migrateEntry(parsed().pages['1'].redo[0]);
    expect(e.box.style.strokeEffects).toEqual([outside('#00ff88', 2)]);
  });

  it('migrates both halves of a style entry', () => {
    const e = migrateEntry(parsed().pages['1'].undo[4]);
    expect(e.before.strokeEffects).toEqual([outside('#00ff88', 2)]);
    expect(e.after.strokeEffects).toEqual([outside('#ff0044', 5)]);
  });

  // A delete recorded before the mask left the style: the box comes back
  // with its mask on the page, carried through the box as it was recorded.
  it('carries a delete entry\'s style mask to the page', () => {
    const style = normalizeStyle({});
    const old = { ...style, clip: { on: true, mode: 'exclude', brushSize: 9, shapes: [{ kind: 'poly', pts: [[0, 0], [10, 0], [0, 10]] }] } };
    const e = migrateEntry({ t: 'delete', index: 0, box: { id: 'b1', x: 100, y: 50, w: 50, h: 20, text: 'A', style: old } });
    expect('clip' in e.box.style).toBe(false);
    expect(e.box.mask).toEqual({ on: true, shapes: [{ kind: 'poly', op: 'hide', pts: [[100, 50], [110, 50], [100, 60]] }] });
    // A box with a mask of its own keeps it, and a current box is the same object.
    const own = { id: 'b2', x: 0, y: 0, w: 5, h: 5, text: 'B', style, mask: { on: false, shapes: [] } };
    expect(migrateEntry({ t: 'delete', index: 0, box: own }).box).toBe(own);
  });

  it('migrates each item of a bulk entry, and leaves an absent lastStyle pair absent', () => {
    const e = migrateEntry(parsed().pages['2'].undo[0]);
    expect(e.items[0].before.strokeEffects).toEqual([outside('#00ff88', 2)]);
    expect(e.items[0].after.strokeEffects).toEqual([outside('#ff0044', 5)]);
    expect(e.items[0].boxId).toBe('b3');
    expect('lastStyleBefore' in e).toBe(false);
  });

  // The trap this migration has to step over: `move`/`resize` also carry
  // `before`/`after`, and they are NOT styles - they are the handful of fields
  // that changed. Normalising one would inflate it into a whole style and then
  // write every field of it onto the box.
  it('does not touch a move or resize entry’s geometry pair', () => {
    const mv = parsed().pages['1'].undo[1];
    const rz = parsed().pages['1'].undo[2];
    expect(migrateEntry(mv)).toBe(mv);
    expect(migrateEntry(rz)).toBe(rz);
    expect(migrateEntry(rz).before).toEqual({ w: 100, h: 40, size: 20 });
  });

  it('does not touch a text entry’s strings', () => {
    const tx = parsed().pages['1'].undo[3];
    expect(migrateEntry(tx)).toBe(tx);
    expect(migrateEntry(tx).before).toBe('old words');
  });

  it('hands a document that needs nothing back as the very object it was given', () => {
    const already = migrateDoc(parsed());
    expect(migrateDoc(already)).toBe(already);
  });

  it('leaves a document of an unknown version alone', () => {
    const future = { version: 99, pages: {} };
    expect(migrateDoc(future)).toBe(future);
    expect(migrateDoc(null)).toBeNull();
  });

  it('migrates every page’s stack, on both sides', () => {
    const doc = migrateDoc(parsed());
    expect(doc.pages['1'].undo[0].box.style.strokeEffects).toHaveLength(1);
    expect(doc.pages['1'].redo[0].box.style.strokeEffects).toHaveLength(1);
    expect(doc.pages['2'].undo[0].items[0].after.strokeEffects).toHaveLength(1);
  });
});

// The proof that matters: the entry actually replays. An era-2 `delete` undone
// puts a box back on the page, and what it puts back has to be a style the
// canvas can read - `TextBox.svelte` reads `s.pattern.on` and `s.gradient.on`
// with no guard at all, because everything that reaches it has been normalised.
describe('replaying an era-2 entry against today’s document', () => {
  beforeEach(() => {
    initHistory();
    resetHistory();
    loadProjectPages(JSON.parse(ERA2_CHAPTER).pages);
  });
  afterEach(() => resetHistory());

  const deletion = () => {
    const doc = migrateDoc(JSON.parse(ERA2_HISTORY));
    // Aimed at a box the fixture chapter really has, so the entry describes
    // this document rather than some other one.
    const e = structuredClone(doc.pages['1'].undo[0]);
    e.t = 'delete';
    e.box.id = 'b2';
    e.index = 1;
    return e;
  };

  it('restores a deleted box with a style the renderers can read', () => {
    const before = pageById(1).boxes.length;
    // The box the entry is about, taken away so the undo has somewhere to put it.
    pageById(1).boxes = pageById(1).boxes.filter((b) => b.id !== 'b2');
    loadStack(1, { undo: [deletion()], redo: [] });
    expect(undo()).toBe(true);
    expect(pageById(1).boxes).toHaveLength(before);
    const s = byId('b2').style;
    expect(s.strokeEffects).toEqual([outside('#ff0044', 5)]);
    expect(s.gradient.on).toBe(false);
    expect(s.pattern.on).toBe(false);
    expect(s.shadows).toHaveLength(1);
    expect(s.fillOpacity).toBe(1);
    // And forward again, with nothing corrupted on the way.
    expect(redo()).toBe(true);
    expect(pageById(1).boxes.some((b) => b.id === 'b2')).toBe(false);
  });

  it('replays an era-2 style entry onto a box that is standing in today’s schema', () => {
    const e = {
      t: 'style',
      pageId: 1,
      boxId: 'b1',
      before: JSON.parse(ERA1_STYLE),
      after: JSON.parse(ERA2_STYLE),
    };
    loadStack(1, { undo: [migrateEntry(e)], redo: [] });
    expect(undo()).toBe(true);
    expect(byId('b1').style.strokeEffects).toEqual([outside('#00ff88', 2)]);
    expect(byId('b1').style.pattern).toBeTruthy();
    expect(byId('b1').style.gradient).toBeTruthy();
  });

  it('replays an era-2 move entry without disturbing anything but the geometry', () => {
    const e = {
      t: 'move',
      pageId: 1,
      boxId: 'b1',
      before: { x: 10, y: 20 },
      after: { x: 110, y: 130 },
    };
    const strokes = structuredClone(byId('b1').style.strokeEffects);
    loadStack(1, { undo: [migrateEntry(e)], redo: [] });
    expect(undo()).toBe(true);
    expect([byId('b1').x, byId('b1').y]).toEqual([10, 20]);
    expect(byId('b1').style.strokeEffects).toEqual(strokes);
    expect(byId('b1').style.size).toBe(34);
  });
});

// ---------------------------------------------------------------------------
// 4. translations.json
// ---------------------------------------------------------------------------

describe('a translations file, whichever era wrote it', () => {
  const linesOf = (json) =>
    normalizeTranslations(JSON.parse(json)).map((p) => p.lines.map((l) => [l.n, l.en, l.type]));

  it('reads the same lines out of a numeric-fallback file and a null one', () => {
    expect(linesOf(ERA2_TRANSLATIONS)).toEqual(linesOf(NOW_TRANSLATIONS));
  });

  it('reads the old file the app used to write', () => {
    const pages = normalizeTranslations(JSON.parse(ERA2_TRANSLATIONS));
    expect(pages).toHaveLength(2);
    expect(pages[0].lines.map((l) => l.n)).toEqual([1, 2]);
    expect(pages[0].lines[0].en).toBe('Ah.');
    expect(pages[0].lines[0].tags).toEqual(['shout']);
    expect(pages[1].lines).toEqual([]);
  });

  it('reads a page whose size is null without inventing one or dropping the page', () => {
    const pages = normalizeTranslations(JSON.parse(NOW_TRANSLATIONS));
    expect(pages).toHaveLength(2);
    expect(pages[1].lines).toEqual([]);
  });

  // The two shapes an even older hand-rolled file took.
  it('still reads a bare array of lines and a `texts` page', () => {
    expect(normalizeTranslations(['one', 'two'])[0].lines.map((l) => l.en)).toEqual(['one', 'two']);
    const p = normalizeTranslations({ page: 1, texts: [{ id: 0, text: 'zero' }, { id: 1, text: 'one' }] });
    expect(p[0].lines.map((l) => l.n)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 5. localStorage
// ---------------------------------------------------------------------------

// A project.json from before the series guide: no `guide` key at all.
const PROJECT_BEFORE_GUIDE = `{
  "schema": 1,
  "id": "p_old",
  "name": "Tsukimichi",
  "createdAt": "2026-09-01T10:00:00.000Z",
  "updatedAt": "2026-10-01T10:00:00.000Z",
  "coverChapterId": null,
  "coverPageId": null,
  "layout": "pages",
  "ocrLanguage": "ja",
  "tags": [{ "name": "sfx", "font": "Bangers", "outline": "#ffffff", "outlineWidth": 4, "size": 60 }],
  "tagSizes": { "sfx": 60 }
}`;

describe('a project.json from before the series guide', () => {
  it('reads as the empty guide, with no rule switched on', () => {
    const raw = JSON.parse(PROJECT_BEFORE_GUIDE);
    expect(sanitizeGuide(raw.guide)).toEqual(emptyGuide());
  });

  it('keeps a guide it wrote, and drops the fields of the wrong type', () => {
    const g = sanitizeGuide({
      glossary: [
        { id: 'g1', source: 'ファルツ', target: 'Faltz', aliases: ['ファルツ様', 3], note: 'never Falz' },
        { source: '', target: '' },
        'junk',
      ],
      rules: { dashes: 'ascii', ellipsis: 'sideways' },
      notes: 'Screams tilt with the balloon.',
      typeset: { defaultHyphenate: false, defaultMinOrphan: 'many' },
    });
    expect(g.glossary).toEqual([
      { id: 'g1', source: 'ファルツ', target: 'Faltz', aliases: ['ファルツ様'], note: 'never Falz', locked: true, character: false, tag: null },
    ]);
    expect(g.rules).toEqual({ dashes: 'ascii', ellipsis: 'keep' });
    expect(g.notes).toBe('Screams tilt with the balloon.');
    expect(g.typeset).toEqual({ defaultHyphenate: false });
  });

  // A guide written before the lettering style: not set up, so the AI asks.
  it('reads a guide with no lettering as not set up, and keeps one it wrote', () => {
    expect(sanitizeGuide({ notes: 'x' }).lettering).toEqual({ freedom: null, notes: '' });
    expect(sanitizeGuide({ lettering: { freedom: 'wild', notes: 7 } }).lettering).toEqual({ freedom: null, notes: '' });
    expect(sanitizeGuide({ lettering: { freedom: 'balanced', notes: 'SFX match the art.' } }).lettering)
      .toEqual({ freedom: 'balanced', notes: 'SFX match the art.' });
  });
});

describe('a presets blob from the last release', () => {
  const ERA2_PRESETS = `{"list":[
    {"id":"pr_1","name":"Shout","style":${ERA2_STYLE}},
    {"id":"pr_2","name":"Whisper","style":${ERA1_STYLE}}
  ]}`;

  it('migrates each preset’s style through the one seam every style goes through', () => {
    const list = parsePresets(ERA2_PRESETS);
    expect(list.map((p) => p.name)).toEqual(['Shout', 'Whisper']);
    expect(list[0].style.strokeEffects).toEqual([outside('#ff0044', 5)]);
    expect(list[0].style.shadows).toHaveLength(1);
    expect(list[1].style.strokeEffects).toEqual([outside('#00ff88', 2)]);
    for (const p of list) {
      expect(p.style.gradient).toBeTruthy();
      expect(p.style.pattern).toBeTruthy();
      expect('outline' in p.style).toBe(false);
    }
  });

  it('keeps the ids, so a preset the user saved is the same preset after the update', () => {
    expect(parsePresets(ERA2_PRESETS).map((p) => p.id)).toEqual(['pr_1', 'pr_2']);
  });

  it('gives an old preset no tile, and keeps a picked tile only with the style that names it', () => {
    for (const p of parsePresets(ERA2_PRESETS)) expect('tile' in p).toBe(false);
    const src = '0123456789abcdef0123456789abcdef.png';
    const tile = 'data:image/png;base64,iVBORw0KGgo=';
    const picked = { pattern: { on: true, kind: 'picked', src, cell: [6, 0, 0, 6] } };
    const [a, b, c] = parsePresets({
      list: [
        { id: 'a', name: 'Tone', style: picked, tile },
        { id: 'b', name: 'Plain', style: {}, tile },
        { id: 'c', name: 'Bad', style: picked, tile: 'javascript:alert(1)' },
      ],
    });
    expect(a.tile).toBe(tile);
    expect(a.style.pattern.src).toBe(src);
    expect('tile' in b).toBe(false);
    expect('tile' in c).toBe(false);
  });

  it('drops a blob it cannot read rather than failing the launch', () => {
    expect(parsePresets('{ not json')).toEqual([]);
    expect(parsePresets('{"list":"nope"}')).toEqual([]);
    expect(parsePresets(null)).toEqual([]);
  });
});

describe('a prefs blob from before shortcuts could be rebound', () => {
  // `prefs.svelte.js` applies on import, so the storage it reads has to be in
  // place before the module is. A fresh registry per case is what makes that
  // testable at all - see the dynamic import.
  const withStorage = async (raw) => {
    const map = new Map(raw == null ? [] : [['mt.prefs', raw]]);
    globalThis.localStorage = {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => void map.set(k, String(v)),
      removeItem: (k) => void map.delete(k),
    };
    vi.resetModules();
    const mod = await import('./prefs.svelte.js');
    return { prefs: mod.prefs, setPref: mod.setPref, map };
  };
  const realStorage = globalThis.localStorage;
  afterEach(() => {
    if (realStorage) globalThis.localStorage = realStorage;
    else delete globalThis.localStorage;
  });

  it('reads a blob with no `shortcuts` key and leaves the map empty', async () => {
    const { prefs } = await withStorage('{"typeset":true}');
    expect(prefs.defaultHyphenate).toBe(true);
    expect(prefs.shortcuts).toEqual({});
  });

  it('reads a blob with no keys at all', async () => {
    const { prefs } = await withStorage('{}');
    expect(prefs.defaultHyphenate).toBe(true);
    expect(prefs.shortcuts).toEqual({});
  });

  it('leaves the defaults standing for a corrupt or absent blob', async () => {
    expect((await withStorage('{ not json')).prefs.shortcuts).toEqual({});
    expect((await withStorage(null)).prefs.defaultHyphenate).toBe(true);
  });

  it('refuses a `shortcuts` of the wrong shape rather than handing it to the matcher', async () => {
    const { prefs } = await withStorage('{"typeset":false,"shortcuts":["mod+z"]}');
    expect(prefs.shortcuts).toEqual({});
  });

  // The typesetting defaults moved out of the Inspector and into Settings, so a
  // blob written by any build before that has none of them. Absent has to mean
  // exactly what `defaultStyle()` says, or upgrading would silently change how
  // every box the user places from then on lays its text out.
  it('has no box defaults in it, and every one of them stands at the style default', async () => {
    const { prefs } = await withStorage('{"typeset":true}');
    const d = defaultStyle();
    expect(prefs.defaultAutoHeight).toBe(d.autoHeight);
    // The line breaking's one switch: on is the shaped breaker, hyphenating.
    expect(prefs.defaultHyphenate).toBe(d.hyphenate && d.shape !== 'off');
    expect(prefs.defaultBlockShape).toBe(d.shape);
    // The one that is not: "Fit text to balloon" is a beta and starts off,
    // while a saved style with no `balloon` key still reads as on.
    expect(prefs.defaultBalloon).toBe(false);
    expect(prefs.defaultMinOrphan).toBe(d.minOrphan);
  });

  // Every write stores every key, so a blob from before 2026-10-20 has the old
  // defaults written out: "Fit text to balloon" on, the browser measuring.
  // They move once, to the new ones; a blob written since keeps what it says.
  it('moves a blob written under the old defaults to the new ones, once', async () => {
    const old = await withStorage('{"defaultBalloon":true,"textEngine":"browser"}');
    expect(old.prefs.defaultBalloon).toBe(false);
    expect(old.prefs.textEngine).toBe('rust');
    old.setPref('defaultBalloon', true);
    expect(JSON.parse(old.map.get('mt.prefs')).defaultsRev).toBe(4);
    const since = await withStorage(old.map.get('mt.prefs'));
    expect(since.prefs.defaultBalloon).toBe(true);
    expect(since.prefs.textEngine).toBe('rust');
    const chose = await withStorage('{"defaultBalloon":true,"textEngine":"browser","defaultsRev":1}');
    expect(chose.prefs.defaultBalloon).toBe(true);
    expect(chose.prefs.textEngine).toBe('browser');
  });

  // 2026-11-03: the second detector finds the bubbles placement relies on, so
  // a blob from before turns it on once; one written since keeps what it says.
  it('turns the second detector on once for a blob from before it was the default', async () => {
    const old = await withStorage('{"secondDetector":false,"defaultsRev":1}');
    expect(old.prefs.secondDetector).toBe(true);
    const chose = await withStorage('{"secondDetector":false,"defaultsRev":2}');
    expect(chose.prefs.secondDetector).toBe(false);
  });

  // 2026-11-08 (rev 3): the effects' own defaults. A blob from before has
  // none, which is every effect at the factory's values.
  it('reads a blob from before the effect defaults as none, and keeps one written since', async () => {
    const old = await withStorage('{"defaultsRev":2}');
    expect(old.prefs.fxDefaults).toEqual({});
    const since = await withStorage('{"defaultsRev":3,"fxDefaults":{"colorOverlay":{"color":"#00ff00","opacity":0.5,"blend":"screen"}}}');
    expect(since.prefs.fxDefaults).toEqual({ colorOverlay: { color: '#00ff00', opacity: 0.5, blend: 'screen' } });
  });

  it('takes stored box defaults, and refuses values of the wrong type or range', async () => {
    const a = await withStorage('{"defaultAutoHeight":false,"defaultMinOrphan":6}');
    expect(a.prefs.defaultAutoHeight).toBe(false);
    expect(a.prefs.defaultMinOrphan).toBe(6);
    // A string where a boolean belongs, and a number outside the range the
    // control offers: one is dropped, the other is clamped into it.
    const b = await withStorage('{"defaultBalloon":"yes","defaultMinOrphan":900,"defaultsRev":1}');
    expect(b.prefs.defaultBalloon).toBe(false);
    expect(b.prefs.defaultMinOrphan).toBe(8);
    // A block shape the control does not offer is dropped too (BRK-3).
    const c = await withStorage('{"defaultBlockShape":"rect"}');
    expect(c.prefs.defaultBlockShape).toBe('rect');
    const e = await withStorage('{"defaultBlockShape":"off"}');
    expect(e.prefs.defaultBlockShape).toBe('auto');
  });

  // "Shaped line breaks" off was the plain wrap. It is the one switch off now,
  // and the box it gives is plain whatever the rest say.
  it('reads an old "Shaped line breaks" off as the line breaking switched off', async () => {
    const a = await withStorage('{"defaultShape":false,"defaultHyphenate":true,"defaultBalloon":true,"defaultsRev":1}');
    expect(a.prefs.defaultHyphenate).toBe(false);
    expect(a.prefs.defaultBalloon).toBe(true);
    const b = await withStorage('{"defaultShape":true,"defaultHyphenate":true}');
    expect(b.prefs.defaultHyphenate).toBe(true);
  });
});

// DET-3. A chapter.json from before the `typesetting` field was laid out with
// this machine's beta switch as it stood when the field arrived. That answer is
// read from the stored blob - never from a default, which BRK-1 will change -
// and frozen, so a later flip of the new-chapter preference cannot re-break
// those chapters. roundtrip.realfs.test.js pins the open path that uses it.
describe('a prefs blob from before chapters carried their typesetting', () => {
  const withStorage = async (raw, { broken = false } = {}) => {
    const map = new Map(raw == null ? [] : [['mt.prefs', raw]]);
    globalThis.localStorage = broken
      ? {
          getItem: () => {
            throw new Error('denied');
          },
          setItem: () => {
            throw new Error('denied');
          },
        }
      : {
          getItem: (k) => (map.has(k) ? map.get(k) : null),
          setItem: (k, v) => void map.set(k, String(v)),
          removeItem: (k) => void map.delete(k),
        };
    vi.resetModules();
    const mod = await import('./prefs.svelte.js');
    const data = await import('./data.js');
    return { ...mod, ...data, map };
  };
  const realStorage = globalThis.localStorage;
  afterEach(() => {
    if (realStorage) globalThis.localStorage = realStorage;
    else delete globalThis.localStorage;
  });

  it('reads such a chapter as smart where the beta was saved on', async () => {
    const { legacyTypesetting } = await withStorage('{"typeset":true}');
    expect(legacyTypesetting()).toEqual({ mode: 'smart', version: 1 });
  });

  it('reads it as plain where nothing says the beta was on, while new chapters are smart', async () => {
    for (const raw of [null, '{}', '{"typeset":false}', '{"typeset":"yes"}', '{ not json']) {
      const { legacyTypesetting, newTypesetting } = await withStorage(raw);
      // What a new chapter is made with is not what the old chapters were set with.
      expect(newTypesetting().mode).toBe('smart');
      expect(legacyTypesetting().mode).toBe('plain');
    }
    expect((await withStorage(null, { broken: true })).legacyTypesetting().mode).toBe('plain');
  });

  it('keeps its first answer through every later save of the preferences', async () => {
    // Beta never on: the old chapters stay plain, this launch and every launch after.
    const a = await withStorage('{"typeset":false}');
    a.setPref('defaultAutoHeight', false);
    expect(a.legacyTypesetting().mode).toBe('plain');
    const a2 = await withStorage(a.map.get('mt.prefs'));
    expect(a2.legacyTypesetting().mode).toBe('plain');
    // Beta on: they stay smart.
    const b = await withStorage('{"typeset":true}');
    b.setPref('defaultAutoHeight', false);
    const b2 = await withStorage(b.map.get('mt.prefs'));
    expect(b2.legacyTypesetting().mode).toBe('smart');
    // And the old new-chapter switch is gone: nothing sets it.
    b2.setPref('typeset', false);
    expect('typeset' in b2.prefs).toBe(false);
  });

  it('a new chapter is always smart: there is no switch for it', async () => {
    const { prefs, newTypesetting } = await withStorage('{"typeset":false}');
    expect('typeset' in prefs).toBe(false);
    expect(newTypesetting().mode).toBe('smart');
  });

  it('an old chapter with no typesetting field and no saved pref still opens plain', async () => {
    const { legacyTypesetting } = await withStorage(null);
    expect(legacyTypesetting().mode).toBe('plain');
  });

  it('saved blob with typeset:false and no legacyTypeset derives legacy plain', async () => {
    const { legacyTypesetting } = await withStorage('{"typeset":false}');
    expect(legacyTypesetting().mode).toBe('plain');
  });
});

// The line breaking was one switch for the whole chapter. A chapter laid out
// with it off opens smart with every box given the plain wrap as its own - in
// the document and in the undo history - and one laid out with it on comes
// back as it went in.
describe('a chapter laid out under the old chapter switch', () => {
  it('opens a plain chapter smart, and says its boxes were plain', () => {
    expect(openTypesetting({ mode: 'plain', version: 2 })).toEqual({ typesetting: { mode: 'smart', version: 2 }, plain: true });
    for (const raw of [null, undefined, {}, { mode: 'fancy' }]) expect(openTypesetting(raw).plain).toBe(true);
    expect(openTypesetting({ mode: 'smart', version: 1 })).toEqual({ typesetting: { mode: 'smart', version: 1 }, plain: false });
  });

  it('gives a style the plain wrap and leaves its balloon alone', () => {
    const s = { font: 'X', shape: 'oval', hyphenate: true, balloon: true };
    expect(plainStyle(s)).toEqual({ font: 'X', ...PLAIN_BREAKS, balloon: true });
    expect(s.shape).toBe('oval');
    // Already plain, or not a style: the very value back.
    const plain = { shape: 'off', hyphenate: false, balloon: false };
    expect(plainStyle(plain)).toBe(plain);
    expect(plainStyle(null)).toBeNull();
    expect(plainStyle('words')).toBe('words');
  });

  it('loads every box of a plain chapter with the plain wrap', () => {
    const raw = [
      { id: 1, boxes: [{ id: 'b1', x: 0, y: 0, w: 100, h: 40, style: { font: 'X', shape: 'oval', hyphenate: true, balloon: true } }, { id: 'b2', x: 0, y: 0, w: 100, h: 40 }] },
      { id: 2, boxes: [] },
    ];
    loadProjectPages(raw, { plain: true });
    expect(app.pages[0].boxes[0].style).toMatchObject({ ...PLAIN_BREAKS, balloon: true });
    expect(app.pages[0].boxes[1].style).toMatchObject(PLAIN_BREAKS);
    // The record handed in is not touched.
    expect(raw[0].boxes[0].style.shape).toBe('oval');
    loadProjectPages(raw);
    expect(app.pages[0].boxes[0].style.shape).toBe('oval');
  });

  it('gives the boxes and box styles of a stored stack the plain wrap', () => {
    // A style of this build: since review F2 a style with no Layer Styles
    // fields is one from before them, and goes through normalizeStyle, so the
    // identity checks below need those fields to mean "left as recorded".
    const layerStyles = { innerShadows: [], strokeEffects: [], blendMode: 'normal', bevel: {}, blending: {} };
    const smart = { shape: 'auto', hyphenate: true, balloon: true, shadows: [], gradient: {}, pattern: { fade: {} }, ...layerStyles };
    const entries = [
      { t: 'style', before: { ...smart, color: '#000' }, after: { ...smart, color: '#f00' } },
      { t: 'place', box: { id: 'b1', style: smart } },
      { t: 'placeMany', items: [{ box: { id: 'b2', style: smart } }] },
      { t: 'bulk', items: [{ boxId: 'b1', before: smart, after: smart }], lastStyleBefore: smart },
    ];
    const [st, pl, many, bulk] = entries.map((e) => migrateEntry(e, true));
    for (const s of [st.before, st.after, pl.box.style, many.items[0].box.style, bulk.items[0].before, bulk.items[0].after]) {
      expect(s).toMatchObject({ ...PLAIN_BREAKS, balloon: true });
    }
    expect(st.after.color).toBe('#f00');
    // Not a box's style: the template the next box inherits keeps what it had.
    expect(bulk.lastStyleBefore).toBe(smart);
    // And a chapter that was not plain keeps its stack as recorded.
    for (const e of entries) expect(migrateEntry(e)).toBe(e);
    const doc = { version: 1, pages: { 1: { undo: entries, redo: [] } } };
    expect(migrateDoc(doc)).toBe(doc);
    expect(migrateDoc(doc, true).pages[1].undo[0].before.shape).toBe('off');
  });
});

describe('a tags blob from the last release', () => {
  // An older registry stored an outline as one colour and one width.
  const ERA2_TAGS = `{"list":[
    {"name":"shout","font":"Bangers","outline":"#ff0000","outlineWidth":6},
    {"name":"whisper","font":null,"outline":null,"outlineWidth":null}
  ]}`;

  it('loads, and a tag’s outline reaches a style as the style’s stroke list', async () => {
    const tags = await import('./tags.svelte.js');
    tags.bindTags(ERA2_TAGS);
    expect(tags.tags.list.map((t) => t.name)).toEqual(['shout', 'whisper']);
    const base = normalizeStyle(JSON.parse(ERA1_STYLE));
    const styled = tags.styleForLine({ n: 1, tags: ['shout'] }, base);
    expect(styled.font).toBe('Bangers');
    expect(styled.strokeEffects).toEqual([outside('#ff0000', 6)]);
    // A tag that names nothing changes nothing.
    expect(tags.styleForLine({ n: 2, tags: ['whisper'] }, base).strokeEffects).toEqual(base.strokeEffects);
  });
});

describe('a project tag registry from before tag styles', () => {
  const OLD_TAGS = '[{"name":"sfx","font":"Bangers","outline":"#ffffff","outlineWidth":4,"size":60},{"name":"narration","font":null,"outline":null,"outlineWidth":null,"size":null}]';

  afterEach(async () => {
    const { unbindTags } = await import('./tags.svelte.js');
    unbindTags();
    const { setInheritBoxStyle } = await import('./store.svelte.js');
    setInheritBoxStyle(true);
  });

  it('migrates the registry and gives a placed line its old font and stroke', async () => {
    const { bindTags, tags } = await import('./tags.svelte.js');
    const { app, loadProjectPages, placeActiveAt } = await import('./store.svelte.js');
    bindTags(OLD_TAGS);
    expect(tags.list).toEqual([
      { name: 'sfx', style: { font: 'Bangers', strokeEffects: [outside('#ffffff', 4)] }, size: 60, minSize: null },
      { name: 'narration', style: {}, size: null, minSize: null },
    ]);
    app.chapterRef = null;
    app.lastStyle = defaultStyle();
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'BOOM', tags: ['sfx'] }], boxes: [] }]);
    placeActiveAt(200, 200);
    expect(app.pages[0].boxes[0].style).toMatchObject({ font: 'Bangers', strokeEffects: [outside('#ffffff', 4)], size: 60 });
  });

  it('places narration after sfx with its whole patch whatever the last box was', async () => {
    const { bindTags } = await import('./tags.svelte.js');
    const { app, loadProjectPages, placeActiveAt, activateLine, cloneStyle, setInheritBoxStyle } = await import('./store.svelte.js');
    bindTags({ list: [
      { name: 'sfx', style: { font: 'Bangers', italic: false, color: '#ff0000' } },
      { name: 'narration', style: { font: 'Comic Neue', italic: true, color: '#123456' } },
    ] });
    app.chapterRef = null;
    app.lastStyle = defaultStyle();
    setInheritBoxStyle(true);
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'BOOM', tags: ['sfx'] }, { n: 2, en: 'Later that day', tags: ['narration'] }], boxes: [] }]);
    placeActiveAt(200, 200);
    const first = app.pages[0].boxes[0];
    expect(first.style).toMatchObject({ font: 'Bangers', italic: false, color: '#ff0000' });
    app.lastStyle = cloneStyle(first.style);
    activateLine(2);
    placeActiveAt(400, 400);
    expect(app.pages[0].boxes[1].style).toMatchObject({ font: 'Comic Neue', italic: true, color: '#123456' });
  });
});

// Ink is newer than any release on disk, so these are the gate: a saved project
// has no `ink` key at all, and must come back with the off default rather than
// undefined - every ink call site reads `style.ink` without guarding it.
describe('a project saved before ink existed', () => {
  it('loads a project saved before ink existed and gives it the default block', () => {
    const s = normalizeStyle({ size: 28, color: '#111111' });
    expect(s.ink).toEqual({ on: false, strokes: [] });
  });

  it('round-trips a project with ink through normalizeStyle unchanged', () => {
    const once = normalizeStyle({
      ink: { on: true, strokes: [{ size: 20, pts: [[0, 0, 1], [10, 5, 0.5]] }] },
    });
    expect(normalizeStyle(once)).toEqual(once);
  });
});

// The warp mesh is newer still, and the same gate applies twice over: every
// call site reads `style.warp.pts` without guarding it, and a `pts` array that
// does not match its own grid would have the painter reading past the end of
// the mesh mid-triangle.
describe('a project saved before the warp mesh existed', () => {
  it('loads a project saved before warp existed and gives it the default block', () => {
    const s = normalizeStyle({ size: 28, color: '#111111' });
    expect(s.warp).toEqual({ on: false, cols: 3, rows: 3, pts: [] });
  });

  it('gives a style that pre-dates warp a mesh the engine reads as identity', () => {
    const s = normalizeStyle(JSON.parse(ERA1_STYLE));
    expect(s.warp).toEqual({ on: false, cols: 3, rows: 3, pts: [] });
  });

  it('round-trips a project with a warp mesh through normalizeStyle unchanged', () => {
    const once = normalizeStyle({
      warp: { on: true, cols: 1, rows: 1, pts: [[0, 0], [100, 0], [0, 100], [120, 140]] },
    });
    expect(once.warp.pts).toHaveLength(4);
    expect(normalizeStyle(once)).toEqual(once);
  });

  it('resets a hand-edited mesh whose length does not match its grid', () => {
    const s = normalizeStyle({ warp: { on: true, cols: 4, rows: 4, pts: [[0, 0], [1, 1]] } });
    expect(s.warp).toEqual({ on: true, cols: 4, rows: 4, pts: [] });
  });
});

// A newborn box takes the last box's style as its starting point, but never the
// last box's own geometry: strokes drawn in one box must not appear in the next
// box the letterer places.
describe('a newborn box and the previous box\'s geometry', () => {
  it('starts with no ink, path or warp of its own, and no mask in its style', async () => {
    const { applyBoxDefaults } = await import('./data.js');
    const prev = normalizeStyle({
      ink: { on: true, strokes: [{ pts: [[1, 2, 0.5], [3, 4, 0.5]] }] },
      path: { on: true, pts: [[0, 0], [9, 9]] },
      warp: { on: true, cols: 1, rows: 1, pts: [[0, 0], [1, 0], [0, 1], [1, 1]] },
    });
    const s = applyBoxDefaults(structuredClone(prev));
    expect(s.ink).toEqual({ on: false, strokes: [] });
    expect(s.path).toEqual({ on: false, pts: [] });
    expect(s.warp).toEqual({ on: false, cols: 3, rows: 3, pts: [] });
    // The mask is the box's, not the style's: there is none to carry.
    expect('clip' in s).toBe(false);
  });
});

// Bubble outlines (M2, Bubble A): `box.fit` gained a `poly` kind and the box
// an `outline` record; a detected block measured by a chapter place carries
// the same pair. A file written with them loads as written; a hand-edited or
// future one degrades to "no fit" / "no record" rather than failing the load.
describe('a chapter with bubble outlines', () => {
  const PAGE = (box, det = {}) =>
    JSON.parse(`{
      "id": 7, "file": "007.png", "cleaned": null, "w": 1000, "h": 1400,
      "lines": [{ "n": 1, "type": "dialogue", "jp": "", "en": "Hi." }],
      "detect": { "panels": [], "boxes": [${JSON.stringify({ n: 1, box: [100, 100, 200, 300], ...det })}] },
      "boxes": [${JSON.stringify({ id: 'o1', lineN: 1, text: null, x: 100, y: 120, w: 180, h: 140, style: { font: 'Bangers', size: 30 }, ...box })}]
    }`);
  const POLY = { kind: 'poly', pts: [[80, 100], [300, 100], [320, 200], [300, 300], [80, 300]] };

  it('keeps a poly fit and its outline record as written', () => {
    const outline = { source: 'ring', confidence: 0.93, approved: 'user', note: 'ok' };
    loadProjectPages([PAGE({ fit: POLY, outline })]);
    expect(byId('o1').fit).toEqual(POLY);
    expect(byId('o1').outline).toEqual(outline);
  });

  it('keeps an open outline with no fit', () => {
    loadProjectPages([PAGE({ fit: null, outline: { source: 'box', confidence: 0, approved: null, open: true } })]);
    expect(byId('o1').fit).toBe(null);
    expect(byId('o1').outline).toEqual({ source: 'box', confidence: 0, approved: null, open: true });
  });

  it('reads a broken poly as no fit, and a broken record as a safe one', () => {
    loadProjectPages([
      PAGE({
        fit: { kind: 'poly', pts: [[0, 0], [10, 0]] },
        outline: { source: 'sam9', confidence: 7, approved: 'robot', open: 'yes', note: 3 },
      }),
    ]);
    expect(byId('o1').fit).toBe(null);
    expect(byId('o1').outline).toEqual({ source: 'manual', confidence: 1, approved: null });
  });

  it('keeps a measured block’s outline record, and drops a record with no measurement', () => {
    const outline = { source: 'flood', confidence: 0.8, approved: null };
    loadProjectPages([PAGE({}, { fit: POLY, outline })]);
    expect(pageById(7).detect.boxes[0].fit).toEqual(POLY);
    expect(pageById(7).detect.boxes[0].outline).toEqual(outline);
    loadProjectPages([PAGE({}, { outline })]);
    expect('fit' in pageById(7).detect.boxes[0]).toBe(false);
    expect('outline' in pageById(7).detect.boxes[0]).toBe(false);
  });

  // LET-3: the text colour the bubble called for rides on the outline record,
  // and the box's own flag on its style.
  it('keeps the bubble ink on the record and drops one that is not black or white', () => {
    const outline = { source: 'dark', confidence: 0.9, approved: null, ink: '#ffffff' };
    loadProjectPages([PAGE({ fit: POLY, outline })]);
    expect(byId('o1').outline).toEqual(outline);
    loadProjectPages([PAGE({ fit: POLY, outline: { ...outline, ink: 'red' } })]);
    expect('ink' in byId('o1').outline).toBe(false);
  });

  it('reads a style saved before automatic colour as one that does not pick', () => {
    loadProjectPages([PAGE({ fit: POLY })]);
    expect(byId('o1').style.autoContrast).toBe(false);
    loadProjectPages([PAGE({ fit: POLY, style: { font: 'Bangers', size: 30, autoContrast: true } })]);
    expect(byId('o1').style.autoContrast).toBe(true);
    loadProjectPages([PAGE({ fit: POLY, style: { font: 'Bangers', size: 30, autoContrast: 'yes' } })]);
    expect(byId('o1').style.autoContrast).toBe(false);
  });
});
