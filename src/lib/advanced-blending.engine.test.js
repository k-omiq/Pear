import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas, Image } from '@napi-rs/canvas';
import { engineWasm, fixtureFont, FIXTURE_FACES } from '../test/rust-engine.js';
import { createRustTextEngine } from './text-engine/rust.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { createPaintHandler } from './text-engine/paint-worker.js';
import { createPaintMirror } from './text-engine/paint-mirror.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { renderPageCanvas, boxInJob } from './exporter.js';
import { paintBoxPicture, requestBoxPicture, pictureKey, pageUnderKey, PICTURE_MAX_PX } from './editor/box-picture.js';
import { forgetBackdrops } from './backdrop.js';
import { usesBackdrop } from './text-paint.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle, normalizeOverlay, normalizeGradientOverlay, normalizeStrokeEffect, normalizeBlending } from './data.js';

// ===========================================================================
// Advanced Blending, every painted control, over busy page art
// ===========================================================================
// The Fill tab's "Advanced blending" fold: Channels R/G/B, Blend Interior
// Effects as Group, Transparency Shapes Layer and Blend If (This Layer and
// Underlying, Gray/R/G/B, split or not). Each control is set on a box in a
// matrix of other options (fill opacity, blend modes, overlays, satin, inner
// and outer glow, outlines, Photoshop strokes, a drop shadow, no fill, a
// gradient fill) and the whole page is exported over art whose colour and
// luminance vary across it. Each cell says whether the control changed the
// page, against what Photoshop's rules say it should. Then the direction of
// the change for the ones that have a clear one, and the editor's route: the
// picture reads the page for a blending-only box, its key moves with every
// field, and the paint worker paints what the main thread does.

function inProcess(handler) {
  let listener = null;
  let queue = Promise.resolve();
  return {
    send(msg) {
      queue = queue.then(async () => {
        const reply = await handler.handle(msg);
        if (reply) listener?.(reply);
      });
    },
    onMessage: (cb) => (listener = cb),
    close() {},
    idle: () => queue,
  };
}

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const hadImage = 'Image' in globalThis;
const oldImage = globalThis.Image;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let painter;
let mirror;

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  globalThis.Image = Image;
  const module = await WebAssembly.compile(engineWasm());
  const h = createPaintHandler();
  const t = inProcess(h);
  mirror = createPaintMirror(t, { warn: () => {} });
  t.send({ op: 'init', module });
  const engine = await createRustTextEngine(module, { mirror });
  for (const [family, slot, file] of FIXTURE_FACES) engine.addFace(family, slot, fixtureFont(file));
  setTextEngine(engine);
  painter = createRustGlyphPainter(engine);
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
  if (hadImage) globalThis.Image = oldImage;
  else delete globalThis.Image;
});
beforeEach(() => {
  setGlyphPainter(painter);
  forgetBackdrops();
});

const W = 600;
const H = 400;
// Letters of gray 98 (30 R + 59 G + 11 B): R 192, G 48, B 112.
const FILL = '#c03070';
const style = (over = {}) => normalizeStyle({ ...defaultStyle(), strokeEffects: [], font: 'Bangers', size: 72, color: FILL, strokes: [], shadows: [], autoHeight: false, ...over });
const boxOf = (over = {}) => ({ id: 'ab', lineN: null, text: 'BLEND IF', x: 90, y: 120, w: 420, h: 130, style: style(over) });

// Page art: red runs with x, green with y, blue in bands, so the luminance
// and every channel vary under the letters.
const art = (() => {
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  const img = x.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let k = 0; k < W; k++) {
      const i = (y * W + k) * 4;
      img.data[i] = Math.round((255 * k) / (W - 1));
      img.data[i + 1] = Math.round((255 * y) / (H - 1));
      img.data[i + 2] = Math.round(128 + 127 * Math.sin(k / 23 + y / 31));
      img.data[i + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  return { canvas: c, data: img.data, url: c.toDataURL('image/png') };
})();
const grayOf = (d, i) => (30 * d[i] + 59 * d[i + 1] + 11 * d[i + 2]) / 100;

const pageOf = (box) => ({ id: 1, w: W, h: H, lines: [], boxes: [box], cleaned: art.url });
async function exported(over) {
  const canvas = await renderPageCanvas(pageOf(boxOf(over)));
  return canvas.getContext('2d').getImageData(0, 0, W, H).data;
}
// Pixels where two RGBA buffers differ by more than `tol` in any channel.
function changed(a, b, tol = 2) {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > tol || Math.abs(a[i + 1] - b[i + 1]) > tol || Math.abs(a[i + 2] - b[i + 2]) > tol) n++;
  }
  return n;
}

const d = defaultStyle();
const OUTLINE = [{ color: '#ffffff', width: 4, opacity: 1 }];
const GREEN_OVERLAY = [normalizeOverlay({ on: true, color: '#20c040', opacity: 1, blend: 'normal' })];
const GRAD_OVERLAY = [normalizeGradientOverlay({ on: true, gradient: { stops: [{ color: '#0000ff', pos: 0, opacity: 1 }, { color: '#ffff00', pos: 1, opacity: 1 }] } })];
const PATTERN_OVERLAY = { on: true, blend: 'normal', opacity: 1, pattern: { kind: 'dots', fg: '#000000', bg: '#ffff00', scale: 1 } };
const SATIN = { ...d.satin, on: true, blend: 'normal', color: '#ffff00', opacity: 1 };
const INNER_GLOW = { ...d.innerGlow, on: true, size: 8, color: '#ffff00', blend: 'normal', opacity: 1 };
const OUTER_GLOW = { ...d.outerGlow, on: true, size: 10, color: '#ffff00', blend: 'normal', opacity: 1 };
const SHADOW = [{ x: 6, y: 6, size: 3, color: '#000000', opacity: 0.8 }];
const STROKE_FX = [normalizeStrokeEffect({ on: true, size: 4, position: 'outside', color: '#10a0a0' })];
const GRAD_FILL = { ...d.gradient, on: true, angle: 90, stops: [{ color: FILL, pos: 0, opacity: 1 }, { color: '#3070c0', pos: 1, opacity: 1 }] };

// The other options a control is tried with.
const BASES = {
  plain: {},
  'fill 50%': { fillOpacity: 0.5 },
  multiply: { blendMode: 'multiply' },
  screen: { blendMode: 'screen' },
  'color-dodge': { blendMode: 'color-dodge' },
  'color-dodge fill 60%': { blendMode: 'color-dodge', fillOpacity: 0.6 },
  'colour overlay': { colorOverlays: GREEN_OVERLAY },
  'colour overlay fill 50%': { colorOverlays: GREEN_OVERLAY, fillOpacity: 0.5 },
  'gradient overlay': { gradientOverlays: GRAD_OVERLAY },
  'gradient overlay fill 50%': { gradientOverlays: GRAD_OVERLAY, fillOpacity: 0.5 },
  'pattern overlay': { patternOverlay: PATTERN_OVERLAY },
  'pattern overlay fill 50%': { patternOverlay: PATTERN_OVERLAY, fillOpacity: 0.5 },
  satin: { satin: SATIN },
  'satin fill 50%': { satin: SATIN, fillOpacity: 0.5 },
  'inner glow': { innerGlow: INNER_GLOW },
  'inner glow fill 50%': { innerGlow: INNER_GLOW, fillOpacity: 0.5 },
  outline: { strokes: OUTLINE },
  'stroke effect': { strokeEffects: STROKE_FX },
  'drop shadow': { shadows: SHADOW },
  'outer glow': { outerGlow: OUTER_GLOW },
  'no fill + outline': { noFill: true, strokes: OUTLINE },
  'no fill + outline + overlay': { noFill: true, strokes: OUTLINE, colorOverlays: GREEN_OVERLAY },
  'gradient fill': { gradient: GRAD_FILL },
  'multiply fill 50% + everything': {
    blendMode: 'multiply',
    fillOpacity: 0.5,
    colorOverlays: GREEN_OVERLAY,
    satin: SATIN,
    innerGlow: INNER_GLOW,
    strokes: OUTLINE,
    shadows: SHADOW,
    outerGlow: OUTER_GLOW,
  },
};

const R = (b0, b1, w0, w1) => [b0, b1, w0, w1];
// The controls, each as the `blending` the Inspector would leave.
const CONTROLS = {
  'channel R off': { channels: { r: false, g: true, b: true } },
  'channel G off': { channels: { r: true, g: false, b: true } },
  'channel B off': { channels: { r: true, g: true, b: false } },
  'this gray black 150': { blendIf: { gray: { this: R(150, 150, 255, 255) } } },
  'this gray black split 60/200': { blendIf: { gray: { this: R(60, 200, 255, 255) } } },
  'this gray white 60': { blendIf: { gray: { this: R(0, 0, 60, 60) } } },
  'this red black 200': { blendIf: { red: { this: R(200, 200, 255, 255) } } },
  'this green white 30': { blendIf: { green: { this: R(0, 0, 30, 30) } } },
  'this blue black 150': { blendIf: { blue: { this: R(150, 150, 255, 255) } } },
  'under gray black 128': { blendIf: { gray: { under: R(128, 128, 255, 255) } } },
  'under gray black split 64/192': { blendIf: { gray: { under: R(64, 192, 255, 255) } } },
  'under gray white 128': { blendIf: { gray: { under: R(0, 0, 128, 128) } } },
  'under red white 128': { blendIf: { red: { under: R(0, 0, 128, 128) } } },
  'under green black 128': { blendIf: { green: { under: R(128, 128, 255, 255) } } },
  'under blue white split 100/200': { blendIf: { blue: { under: R(0, 0, 100, 200) } } },
  interior: { interior: true },
  'transparency shapes off': { transparencyShapes: false },
};

const SPECIAL = ['color-burn', 'linear-burn', 'color-dodge', 'linear-dodge', 'vivid-light', 'linear-light', 'hard-mix', 'difference'];
const innerFx = (o) => !!(o.colorOverlays?.length || o.gradientOverlays?.length || o.patternOverlay?.on || o.satin?.on || o.innerGlow?.on);
// Whether Photoshop's rules say the control changes the page for this box.
function shouldChange(base, control) {
  if (control === 'interior') return innerFx(base) && ((base.fillOpacity ?? 1) < 1 || base.noFill === true);
  if (control === 'transparency shapes off') return SPECIAL.includes(base.blendMode);
  // A No Fill box shows its white outline alone: a This Layer black point
  // under 255 passes it whole, so nothing hides but a few pixels where its
  // inner edge meets the hidden fill (This Layer sees that fill, user
  // decision 2026-11-09). Either is right.
  if (base.noFill && !innerFx(base) && /^this .* black/.test(control)) return null;
  return true;
}

describe('every painted Advanced Blending control, with every other option', () => {
  const rows = [];
  afterAll(() => {
    // The matrix, for whoever reads the run: changed pixels per cell.
    const names = Object.keys(CONTROLS);
    console.log(['base \\ control', ...names].join(' | '));
    for (const r of rows) console.log([r.base, ...names.map((n) => r.cells[n])].join(' | '));
  });

  for (const [bname, base] of Object.entries(BASES)) {
    it(bname, async () => {
      const ref = await exported(base);
      // The box shows on the page at all.
      expect(changed(ref, art.data), 'the box shows').toBeGreaterThan(1000);
      const cells = {};
      const wrong = [];
      for (const [cname, blending] of Object.entries(CONTROLS)) {
        const got = await exported({ ...base, blending });
        const n = changed(got, ref);
        const want = shouldChange(base, cname);
        cells[cname] = `${n}${want === null || want === n > 20 ? '' : ' !'}`;
        if (want === null) continue;
        // A change is a real one (more than a few stray edge pixels); no
        // change is none at all.
        if (want && n <= 20) wrong.push(`${cname}: no change (${n} px)`);
        if (!want && n > 0) wrong.push(`${cname}: changed ${n} px where Photoshop changes nothing`);
      }
      rows.push({ base: bname, cells });
      expect(wrong).toEqual([]);
    });
  }
});

describe('which way each control moves the page', () => {
  it('a channel left out is the art\'s channel wherever the box is, effects and all', async () => {
    // The export lays the box's texture (painted at 2) on the page with a
    // high-quality downscale, which rings a level or few at the letters'
    // edges: a few hundred edge pixels miss by up to that, none by more.
    for (const base of [{}, { blendMode: 'multiply' }, BASES['multiply fill 50% + everything'], { blendMode: 'color-dodge' }]) {
      for (const [k, c] of [['r', 0], ['g', 1], ['b', 2]]) {
        const ref = await exported(base);
        const got = await exported({ ...base, blending: { channels: { r: true, g: true, b: true, [k]: false } } });
        let box = 0;
        let off = 0;
        let worst = 0;
        let others = 0;
        for (let i = 0; i < got.length; i += 4) {
          const e = Math.abs(got[i + c] - art.data[i + c]);
          if (Math.abs(ref[i + c] - art.data[i + c]) > 2) box++;
          if (e > 2) off++;
          worst = Math.max(worst, e);
          for (const o of [0, 1, 2]) if (o !== c && Math.abs(got[i + o] - ref[i + o]) > 2) others++;
        }
        const at = `${k} off over ${JSON.stringify(base).slice(0, 40)}`;
        expect(box, at).toBeGreaterThan(3000);
        expect(off / box, `${at}: its channel is the art's`).toBeLessThan(0.05);
        expect(worst, `${at}: and never far from it`).toBeLessThanOrEqual(8);
        expect(others, `${at}: the other channels are the box's`).toBe(0);
      }
    }
  });

  it('This Layer black past the letters\' gray hides them, and leaves a white outline', async () => {
    const hide = { blendIf: { gray: { this: R(150, 150, 255, 255) } } };
    expect(changed(await exported({ blending: hide }), art.data)).toBe(0);
    // The outline's white is past the black point: it stays where it was.
    const ref = await exported({ strokes: OUTLINE });
    const got = await exported({ strokes: OUTLINE, blending: hide });
    let white = 0;
    let whiteKept = 0;
    for (let i = 0; i < ref.length; i += 4) {
      if (ref[i] === 255 && ref[i + 1] === 255 && ref[i + 2] === 255) {
        white++;
        if (got[i] === 255 && got[i + 1] === 255 && got[i + 2] === 255) whiteKept++;
      }
    }
    expect(white).toBeGreaterThan(500);
    expect(whiteKept / white).toBeGreaterThan(0.9);
  });

  it('This Layer reads a No Fill box by the fill it hides: an overlay laid there goes, the outline stays', async () => {
    const base = { noFill: true, strokes: OUTLINE, colorOverlays: GREEN_OVERLAY };
    const ref = await exported(base);
    const got = await exported({ ...base, blending: { blendIf: { gray: { this: R(150, 150, 255, 255) } } } });
    let green = 0;
    let greenGone = 0;
    let white = 0;
    let whiteKept = 0;
    for (let i = 0; i < ref.length; i += 4) {
      const px = ref.subarray(i, i + 4);
      if (px[0] === 0x20 && px[1] === 0xc0 && px[2] === 0x40) {
        green++;
        if (!changed(got.subarray(i, i + 4), art.data.subarray(i, i + 4))) greenGone++;
      } else if (px[0] === 255 && px[1] === 255 && px[2] === 255) {
        white++;
        if (!changed(got.subarray(i, i + 4), px)) whiteKept++;
      }
    }
    expect(green).toBeGreaterThan(1000);
    expect(white).toBeGreaterThan(500);
    expect(greenGone / green).toBeGreaterThan(0.95);
    expect(whiteKept / white).toBeGreaterThan(0.9);
  });

  it('Underlying black at 128 hides the letters over darker art and keeps them over lighter', async () => {
    const ref = await exported({});
    const got = await exported({ blending: { blendIf: { gray: { under: R(128, 128, 255, 255) } } } });
    let darkWrong = 0;
    let lightWrong = 0;
    let dark = 0;
    let light = 0;
    for (let i = 0; i < got.length; i += 4) {
      const g = grayOf(art.data, i);
      if (Math.abs(ref[i] - art.data[i]) + Math.abs(ref[i + 1] - art.data[i + 1]) < 30) continue; // not under the letters
      if (g < 126) {
        dark++;
        if (changed(got.subarray(i, i + 4), art.data.subarray(i, i + 4))) darkWrong++;
      } else if (g > 130) {
        light++;
        if (changed(got.subarray(i, i + 4), ref.subarray(i, i + 4))) lightWrong++;
      }
    }
    expect(dark).toBeGreaterThan(300);
    expect(light).toBeGreaterThan(300);
    expect(darkWrong).toBe(0);
    expect(lightWrong).toBe(0);
  });

  it('Blend Interior Effects as Group fades an overlay with Fill: toward the art', async () => {
    const base = { colorOverlays: GREEN_OVERLAY, fillOpacity: 0.5 };
    const off = await exported(base);
    const on = await exported({ ...base, blending: { interior: true } });
    // Where the overlay paints solid green with the group off, it is half
    // way to the art with it on.
    let n = 0;
    let err = 0;
    for (let i = 0; i < off.length; i += 4) {
      if (!(off[i] === 0x20 && off[i + 1] === 0xc0 && off[i + 2] === 0x40)) continue;
      n++;
      for (const k of [0, 1, 2]) err = Math.max(err, Math.abs(on[i + k] - (0.5 * [0x20, 0xc0, 0x40][k] + 0.5 * art.data[i + k])));
    }
    expect(n).toBeGreaterThan(1000);
    expect(err).toBeLessThanOrEqual(3);
  });

  it('Transparency Shapes Layer off changes a Color Dodge box at its edges only, at a whole Fill', async () => {
    const base = { blendMode: 'color-dodge' };
    const on = await exported(base);
    const off = await exported({ ...base, blending: { transparencyShapes: false } });
    const n = changed(on, off);
    expect(n).toBeGreaterThan(20);
    // A pixel the letters cover whole is the same either way.
    const box = boxOf(base);
    let core = 0;
    let coreChanged = 0;
    const plain = await exported({});
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let x = box.x; x < box.x + box.w; x++) {
        const i = (y * W + x) * 4;
        // A whole letter pixel: the Normal box's own colour exactly.
        if (plain[i] === 0xc0 && plain[i + 1] === 0x30 && plain[i + 2] === 0x70) {
          core++;
          if (changed(on.subarray(i, i + 4), off.subarray(i, i + 4))) coreChanged++;
        }
      }
    }
    expect(core).toBeGreaterThan(1000);
    expect(coreChanged / core).toBeLessThan(0.02);
  });
});

describe('the editor picture', () => {
  const under = () => ({ image: art.canvas, W, H, src: 'art', key: 'ab' });
  const ed = (over) => {
    const box = boxOf(over);
    return paintBoxPicture(box, { id: 1, w: W, h: H, lines: [], boxes: [box] }, 2, null, PICTURE_MAX_PX, usesBackdrop(box.style) ? under() : null);
  };
  const px = (pic) => pic.canvas.getContext('2d').getImageData(0, 0, pic.canvas.width, pic.canvas.height).data;

  it('reads the page for a box whose only page-reading option is Channels or Blend If', () => {
    for (const [name, blending] of Object.entries(CONTROLS)) {
      const s = style({ blending });
      const reads = !['interior', 'transparency shapes off'].includes(name);
      expect(usesBackdrop(s), name).toBe(reads);
      expect(pageUnderKey({ x: 1, y: 2, style: s }, { w: W, h: H }, 'art', true) !== '', name).toBe(reads);
    }
    // At the defaults, a Normal box reads nothing.
    expect(usesBackdrop(style({ blending: normalizeBlending({}) }))).toBe(false);
  });

  it('is keyed on every blending field: a change paints again', () => {
    const key = (blending) => pictureKey({ style: style({ blending }), inkKey: '', text: 'BLEND IF', w: 420, h: 130, lines: ['BLEND IF'], indents: [0], scale: 2, fonts: 0 });
    const plain = key(undefined);
    const seen = new Set([plain]);
    for (const [name, blending] of Object.entries(CONTROLS)) {
      const k = key(blending);
      expect(k, name).not.toBe(plain);
      seen.add(k);
    }
    expect(seen.size).toBe(Object.keys(CONTROLS).length + 1);
  });

  it('changes with every Channels and Blend If control, as the export does', () => {
    const ref = px(ed({}));
    for (const [name, blending] of Object.entries(CONTROLS)) {
      if (name === 'interior' || name === 'transparency shapes off') continue;
      const got = ed({ blending });
      const a = px(got);
      // The picture's size may differ (a box that reads the page is painted
      // on a surface cut to the page): compare by what shows at all.
      const differs = a.length !== ref.length || changed(a, ref) > 20;
      expect(differs, name).toBe(true);
    }
    // And interior with Fill under 100 % and an overlay.
    const base = { colorOverlays: GREEN_OVERLAY, fillOpacity: 0.5 };
    expect(changed(px(ed({ ...base, blending: { interior: true } })), px(ed(base)))).toBeGreaterThan(1000);
    // Transparency Shapes off on a Color Dodge box.
    const dodge = { blendMode: 'color-dodge' };
    expect(changed(px(ed({ ...dodge, blending: { transparencyShapes: false } })), px(ed(dodge)))).toBeGreaterThan(20);
  });

  it('the paint worker paints the same picture for a blending-only box', async () => {
    for (const blending of [CONTROLS['channel R off'], CONTROLS['under gray black 128'], CONTROLS['this gray black 150']]) {
      const box = boxOf({ blending, strokes: OUTLINE });
      expect(boxInJob(box)).toBe(true);
      const p = { id: 1, w: W, h: H, lines: [], boxes: [box] };
      const g = paintBoxPicture(box, p, 2, null, PICTURE_MAX_PX, under());
      forgetBackdrops();
      const req = requestBoxPicture(box, p, 2, null, PICTURE_MAX_PX, under());
      expect(req, 'the box goes to the worker').not.toBeNull();
      const res = await req.promise;
      expect(res.dead).toBeUndefined();
      const h = req.apply(res);
      expect(Buffer.from(px(h)).equals(Buffer.from(px(g)))).toBe(true);
    }
    expect(mirror.alive()).toBe(true);
  });
});
