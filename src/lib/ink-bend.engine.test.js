import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture, renderBoxLayer, warpTexture, boxFootprint, boxInJob, meshInJob, roughenInJob } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { identityMesh, warpPoint } from './warp.js';
import { warpBoxCanvas, WARP_SUB_MAX } from './warp-paint.js';

// ===========================================================================
// Brush ink bent by the box's mesh and roughened by its field, in the box
// job (layer styles phase 8c)
// ===========================================================================
// THE REFERENCE is the canvas path: the same Rust painter with `ink: false`,
// which sends an inked box down the canvas passes. Its letters are the
// engine's, flat; its ink is `drawInk` on @napi-rs/canvas (Skia); and then
// - a mesh: `warpTexture` resamples the finished texture (its triangles,
//   bilinear);
// - a roughening: `roughenPixels` copies every pixel of the finished texture
//   from `p + round(d(p))`, the nearest pixel.
// The engine instead bends each dab: a stamp's outline goes through the
// letters' own map (roughen, then mesh) exactly, and what is inside it (a
// tip, a ribbon's slice) is read back through the mesh's tangent over the
// stamp and the roughening's first-order inverse `p + d(p)`; a soft round
// dab's ramp is read through the mesh itself (its tangent and one Newton
// step), so round dabs are exact, hard and soft.
//
// So the two are two renderings of one map and not the same pixels, and the
// test breaks the difference into its causes, case by case:
// - FLAT: what the same ink differs by with no mesh (ink-rust.engine.test.js:
//   Skia's four-row circle cover against exact area, its 'high' tip sampling
//   against bilinear);
// - A: bend against resample alone, the engine's ink both sides (painted
//   flat in the job, then `warpTexture`, against bent in the job);
// - FLOOR: A under a mesh that is one affine map (a parallelogram cell),
//   where bending a dab and carrying a tip by the tangent are both exact:
//   what the resample alone costs that ink;
// - B: the same mesh on letters alone, bent in the job against the texture
//   warp: the spread already accepted when letters moved into the job
//   (mesh-in-job.engine.test.js).
//
// What is not the same by design, and is measured, not tuned:
// - grain is looked up through the transform alone (the user's rule), so it
//   is not bent; the canvas's grain was bent with its texture;
// - the box's outlines round the ink and the watercolour edge are made on the
//   bent ink at their page width, so they are not stretched where the mesh
//   stretches; the reference's (and the letters' own outlines) are. The
//   bumpy mesh stretches 0.55 to 1.57 times, the perspective cell 0.68 to
//   1.36 (pinned below), so an outline of width w differs along its edge by
//   up to |stretch - 1| w.
//   That look point goes to the user with the 8d PNG pairs.
//
//   MT_INK_MEASURE=1 npx vitest run --project engine ink-bend
//
// prints every number; MT_INK_COMPARE=dir writes the pairs as PNGs.

const OUT = process.env.MT_INK_COMPARE;
const MEASURE = process.env.MT_INK_MEASURE === '1';
const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let whole;
let canvasInk;
let rust;

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  rust = await rustEngine();
  setTextEngine(rust);
  whole = createRustGlyphPainter(rust);
  canvasInk = { ...whole, ink: false };
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
beforeEach(() => setGlyphPainter(whole));

const W = 260;
const H = 130;
const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 48, strokes: [], autoHeight: false, ...over });
const boxOf = (over = {}, text = 'INK') => ({ id: 'b', lineN: null, text, x: 120, y: 110, w: W, h: H, style: style(over) });
const pageOf = (box) => ({ id: 1, w: 600, h: 400, lines: [], boxes: [box] });

function wave(n = 24) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push([20 + t * 220, 65 + Math.sin(t * Math.PI * 2) * 35, 1]);
  }
  return pts;
}
const ink = (...strokes) => ({ on: true, strokes: strokes.map((k, i) => ({ id: `s${i}`, size: 14, color: '#111111', pts: wave(), ...k })) });

// The meshes. A 3 x 3 grid with its inner nodes moved 5 to 10 px; one cell
// with a corner pulled (the homography); one cell that is a parallelogram
// (one affine map: the floor). The 3 x 3 is half of mesh-in-job's: that one
// folds the surface over itself between its inner nodes (a fold has no one
// picture, and the two routes lay its layers in their own orders), and the
// stroke here crosses the fold.
function bumpy() {
  const pts = identityMesh(3, 3, W, H);
  const at = (i, j) => j * 4 + i;
  const move = (i, j, dx, dy) => (pts[at(i, j)] = [pts[at(i, j)][0] + dx, pts[at(i, j)][1] + dy]);
  move(1, 1, -6, -9);
  move(2, 1, 8, 5);
  move(1, 2, 5, 7);
  move(2, 2, -10, -6);
  return { on: true, cols: 3, rows: 3, pts };
}
const perspective = () => ({ on: true, cols: 1, rows: 1, pts: [[0, 0], [W, 22], [-8, H], [W - 10, H - 12]] });
const parallel = () => ({ on: true, cols: 1, rows: 1, pts: [[0, 0], [W + 10, 18], [-20, H], [W - 10, H + 18]] });
const MESHES = { bumpy, perspective, parallel };

// The most the bumpy mesh lengthens a short piece, read as MeshMap::stretch
// reads it (warp.rs): the slope at every node, cell middle and side middle,
// across a sixteenth of a cell.
function stretchOf(mesh) {
  const { pts, cols, rows } = mesh;
  const cw = W / Math.max(cols, 3);
  const ch = H / Math.max(rows, 3);
  const at = (x, y) => warpPoint(pts, cols, rows, W, H, x, y);
  const n = Math.max(cols, 3);
  const m = Math.max(rows, 3);
  let most = 0;
  let least = Infinity;
  for (let j = 0; j <= 2 * m; j++) {
    for (let i = 0; i <= 2 * n; i++) {
      const x = (cw * i) / 2;
      const y = (ch * j) / 2;
      const hx = cw / 16;
      const hy = ch / 16;
      const [ax, ay] = at(x + hx, y);
      const [bx, by] = at(x - hx, y);
      const [cx, cy] = at(x, y + hy);
      const [dx, dy] = at(x, y - hy);
      const m = [(ax - bx) / (2 * hx), (ay - by) / (2 * hx), (cx - dx) / (2 * hy), (cy - dy) / (2 * hy)];
      // The largest singular value of [[a c] [b d]].
      const [a, b, c, d] = m;
      const s1 = a * a + b * b + c * c + d * d;
      const s2 = Math.sqrt((a * a + b * b - c * c - d * d) ** 2 + 4 * (a * c + b * d) ** 2);
      most = Math.max(most, Math.sqrt((s1 + s2) / 2));
      least = Math.min(least, Math.sqrt(Math.max(0, (s1 - s2) / 2)));
    }
  }
  return { most, least };
}

function texture(box, painter, scale, tips = null, flat = false) {
  setGlyphPainter(painter);
  const r = renderBoxTexture(box, pageOf(box), tips, scale, Infinity, Infinity, flat);
  setGlyphPainter(whole);
  return r;
}
// The box as the page composite gets it: warped where the painter did not
// bend it.
function finished(box, painter, scale, tips = null, flat = false) {
  const t = texture(box, painter, scale, tips, flat);
  setGlyphPainter(painter);
  const w = warpTexture(t, box);
  setGlyphPainter(whole);
  return w;
}

// The box painted flat and warped as `warpTexture` warps it, but with the
// finest subdivision the warp has (`WARP_SUB_MAX` virtual cells a side, where
// the app's is `subdivisionFor` the box: 8 here). The texture warp lays the
// mesh's surface as flat triangles between points it places exactly; inside
// a triangle the picture is off the surface by up to its sag. Finer
// triangles are the surface more nearly, so this is the resample alone,
// nearly without the triangles.
function fine(box, painter, scale, tips = null) {
  const t = texture(box, painter, scale, tips, true);
  const s = box.style;
  const w = warpBoxCanvas(t.canvas, { warp: s.warp, w: box.w, h: box.h, ox: t.ox, oy: t.oy, cw: t.cw, ch: t.ch, ss: t.ss, sub: WARP_SUB_MAX });
  return w ?? t;
}

// Two pictures laid box corner on box corner on one grid of `ss` px a page
// px: each texture's own pixel is `canvas.width / cw` of a page px (a warped
// one's is not exactly `ss`), so a picture whose scale or corner is off the
// grid is drawn to it, and that resample is part of what is measured (see
// `offGrid`).
function laid(a, b, ss) {
  const left = Math.max(a.ox, b.ox);
  const top = Math.max(a.oy, b.oy);
  const right = Math.max(a.cw - a.ox, b.cw - b.ox);
  const bottom = Math.max(a.ch - a.oy, b.ch - b.oy);
  const w = Math.ceil((left + right) * ss);
  const h = Math.ceil((top + bottom) * ss);
  const one = (t) => {
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const x = (left - t.ox) * ss;
    const y = (top - t.oy) * ss;
    const dw = t.cw * ss;
    const dh = t.ch * ss;
    if (Number.isInteger(x) && Number.isInteger(y) && t.canvas.width === dw && t.canvas.height === dh) ctx.drawImage(t.canvas, x, y);
    else ctx.drawImage(t.canvas, x, y, dw, dh);
    return ctx.getImageData(0, 0, w, h);
  };
  return [one(a), one(b)];
}
const offGrid = (t, ss) => Math.abs(t.canvas.width / t.cw - ss) + Math.abs(t.ox * ss - Math.round(t.ox * ss));

// As ink-rust.engine.test.js: premultiplied, the mean and the worst
// difference of any channel (of 255) over the pixels either inked, and the
// ratio of their total ink.
function against(a, b) {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let sum = 0;
  let n = 0;
  let worst = 0;
  let inkA = 0;
  let inkB = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const aa = a.data[i + 3];
    const ba = b.data[i + 3];
    if (!aa && !ba) continue;
    let d = Math.abs(aa - ba);
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs((a.data[i + c] * aa - b.data[i + c] * ba) / 255));
    sum += d;
    n++;
    if (d > worst) worst = d;
    inkA += aa;
    inkB += ba;
  }
  return { mean: n ? sum / n : 0, worst, ink: inkB ? inkA / inkB : 0, n };
}
const compare = (a, b, ss) => against(...laid(a, b, ss));

// The length of the ink's outline: its alpha averaged over 7 x 7 pixels (so
// a grain, a noisy tip's speckle or the bars inside a ribbon are not edges of
// their own), and the pixels at half of that or more with a 4-neighbour
// under it.
function perimeter(img) {
  const { width: w, height: h, data } = img;
  const R = 3;
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += data[(y * w + x) * 4 + 3];
      sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
    }
  }
  const a = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    const x0 = Math.max(0, x - R);
    const y0 = Math.max(0, y - R);
    const x1 = Math.min(w, x + R + 1);
    const y1 = Math.min(h, y + R + 1);
    const t = sum[y1 * (w + 1) + x1] - sum[y0 * (w + 1) + x1] - sum[y1 * (w + 1) + x0] + sum[y0 * (w + 1) + x0];
    return t / ((2 * R + 1) * (2 * R + 1));
  };
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a(x, y) < 128) continue;
      if (a(x - 1, y) < 128 || a(x + 1, y) < 128 || a(x, y - 1) < 128 || a(x, y + 1) < 128) n++;
    }
  }
  return n;
}
const imageOf = (t) => t.canvas.getContext('2d').getImageData(0, 0, t.canvas.width, t.canvas.height);

function png(name, img) {
  if (!OUT) return;
  const dir = resolve(OUT);
  mkdirSync(dir, { recursive: true });
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, img.width, img.height);
  const top = createCanvas(img.width, img.height);
  top.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(top, 0, 0);
  writeFileSync(resolve(dir, name), c.toBuffer('image/png'));
}
const fileOf = (name) => name.replace(/[^a-z0-9]+/gi, '-');
const log = (...a) => MEASURE && console.log('MEASURE', ...a);
// The limits below are not held while they are measured.
const NONE = { toBeLessThan() {}, toBeGreaterThan() {}, toBeLessThanOrEqual() {} };
const want = MEASURE ? () => NONE : expect;
const f = (d) => `mean ${d.mean.toFixed(3)} worst ${d.worst.toFixed(1)} ink ${d.ink.toFixed(4)}`;

// ---------------------------------------------------------------------------
// The tips, as ink-rust.engine.test.js makes them.

function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function tipOf(id, w, h, draw) {
  const image = createCanvas(w, h);
  const ctx = image.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  draw(ctx, w, h);
  return { id, width: w, height: h, image };
}
function makeTips() {
  const strip = tipOf('strip', 48, 200, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#000000');
    g.addColorStop(0.3, '#ffffff');
    g.addColorStop(0.7, '#ffffff');
    g.addColorStop(1, '#000000');
    ctx.fillStyle = g;
    ctx.fillRect(0, 8, w, h - 16);
  });
  const noise = tipOf('noise', 96, 96, (ctx, w, h) => {
    const img = ctx.getImageData(0, 0, w, h);
    const r = rng(7);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) / (w / 2);
        const v = d < 1 ? Math.round(255 * r() * Math.min(1, (1 - d) * 3)) : 0;
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  const bars = tipOf('bars', 64, 160, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff';
    for (let y = 0; y < h; y += 40) ctx.fillRect(0, y, w, 22);
    ctx.fillStyle = '#808080';
    ctx.fillRect(16, 0, 8, h);
  });
  return new Map([strip, noise, bars].map((t) => [t.id, t]));
}
let TIPS;
beforeAll(() => {
  TIPS = makeTips();
});

// ---------------------------------------------------------------------------

describe('the gate', () => {
  it('lets a meshed or roughened inked box into the job where the painter paints ink, and nowhere else', () => {
    const meshed = boxOf({ ink: ink({}), warp: bumpy() });
    const rough = boxOf({ ink: ink({}), roughen: { on: true, amount: 6, detail: 0.07, seed: 7 } });
    for (const box of [meshed, rough]) expect(boxInJob(box)).toBe(true);
    expect(meshInJob(meshed)).toBe(true);
    expect(roughenInJob(rough)).toBe(true);
    // A wasm that paints no ink: the canvas draws the ink, so the letters are
    // not bent or roughened in the job either, and the texture warp and the
    // pixel pass take the whole picture.
    setGlyphPainter(canvasInk);
    expect(boxInJob(meshed)).toBe(false);
    expect(meshInJob(meshed)).toBe(false);
    expect(roughenInJob(rough)).toBe(false);
    expect(texture(meshed, canvasInk, 2).warped).toBe(false);
  });

  it('paints a mesh that moves nothing and a roughening that is off as no bend at all, to the byte', () => {
    const plain = boxOf({ ink: ink({}) });
    const same = boxOf({ ink: ink({}), warp: { on: true, cols: 1, rows: 1, pts: identityMesh(1, 1, W, H) } });
    const off = boxOf({ ink: ink({}), roughen: { on: false, amount: 6, detail: 0.07, seed: 7 } });
    const a = imageOf(texture(plain, whole, 2));
    for (const box of [same, off]) {
      const b = imageOf(texture(box, whole, 2));
      expect([b.width, b.height]).toEqual([a.width, a.height]);
      expect(Buffer.compare(Buffer.from(a.data), Buffer.from(b.data))).toBe(0);
    }
  });
});

describe('the footprint of a bent inked box', () => {
  it('is the one worked out without a paint, and holds all of the ink', () => {
    for (const mesh of [bumpy, perspective]) {
      for (const text of ['INK', '']) {
        const box = boxOf({ ink: ink({ size: 20 }), warp: mesh() }, text);
        const tex = texture(box, whole, 2);
        expect(tex.warped).toBe(true);
        const fp = boxFootprint(box, pageOf(box));
        expect([fp.ox, fp.oy]).toEqual([tex.ox, tex.oy]);
        expect(Math.abs(fp.cw - tex.cw)).toBeLessThanOrEqual(1 / 2);
        expect(Math.abs(fp.ch - tex.ch)).toBeLessThanOrEqual(1 / 2);
        // Nothing at the texture's edge: the bent ink is inside.
        const img = imageOf(tex);
        let rim = 0;
        for (let x = 0; x < img.width; x++) rim += img.data[x * 4 + 3] + img.data[((img.height - 1) * img.width + x) * 4 + 3];
        for (let y = 0; y < img.height; y++) rim += img.data[y * img.width * 4 + 3] + img.data[(y * img.width + img.width - 1) * 4 + 3];
        expect(rim).toBe(0);
      }
    }
  });
});

// Each case: the style over the defaults, and its limits, of 255, set from
// the first measured run (`MT_INK_MEASURE=1`, 2026-11-09) over the three
// meshes, three scales, with and without letters:
// - `mean` and `worst`: the reference compare, the largest measured mean and
//   a third more, the largest worst and one more (256 where a pixel flips
//   whole, which every edge a pixel off does);
// - `ink`: the total ink against the reference's, the measured range and
//   half a percent either way;
// - `over`: how far A (bend against a fine resample) may sit over the same
//   ink's FLOOR (the parallelogram), the largest measured and a third more,
//   and half a level.
//
// What the numbers are made of, beyond FLAT (ink-rust's own per-case limits):
// - The app's texture warp lays the surface as triangles, 3 a mesh cell on a
//   side here: on the bumpy mesh its picture is off the surface by about a
//   device pixel, so every edge is a pixel off (A at the app's subdivision:
//   11 to 15 on round ink, against 3 to 5 at the finest). The letters have
//   the same, and more: B is 28.8 on the bumpy mesh, 12.3 on the perspective.
//   That is the reference's error, not the bend's, and it is the bulk of
//   every bumpy `mean` below.
// - Round dabs are exact, hard and soft (a soft dab's ramp is read through
//   the mesh itself, one Newton step from its tangent): A sits under 2.1
//   over its floor on the bumpy mesh, 1.6 on the perspective cell.
// - A tip, a ribbon's slice: its outline is bent, what is inside it is
//   carried by the mesh's tangent over the stamp (the user's rule), so on the
//   bumpy mesh, which stretches 0.55 to 1.57 times, a 28 to 30 px tip's
//   inside is up to a device pixel or two off the surface at its far side: A
//   sits 11 to 16 over its floor there, 1.6 to 2.8 on the perspective cell.
// - Grain is not bent (the user's rule): the canvas sheared and stretched its
//   cells with the texture, so no cell lines up under any mesh, the
//   parallelogram included (mean 40 to 48 everywhere, its floor too).
// - The outlines round the ink and the watercolour edge keep their page
//   width on the bent ink: the perspective cell squeezes to 0.68 and
//   stretches to 1.36, the bumpy mesh 0.55 to 1.57, where the reference's are
//   squeezed and stretched with the texture. A band of width w is off by up
//   to (stretch - 1) w along its edge, so outlined ink sits 9 (bumpy) and 16
//   (perspective) over its floor and is up to 5.6 % heavier where the cell
//   squeezes; the watercolour edge 6 and 7, and up to 3.8 % heavier.
const MESH_CASES = {
  'round hard': [{ ink: ink({}) }, { mean: 20.8, worst: 256, ink: [0.995, 1.015], over: 3.2 }],
  'soft red at hardness 30': [{ ink: ink({ color: '#dc2626', hardness: 30, size: 24 }) }, { mean: 13.6, worst: 256, ink: [0.993, 1.015], over: 3.1 }],
  'flat and turned': [{ ink: ink({ flatness: 0.3, angle: 40, size: 22 }) }, { mean: 18.2, worst: 256, ink: [0.997, 1.015], over: 2.9 }],
  'a tall strip tip, following the line': [{ ink: ink({ brush: 'strip', size: 28, followDir: true }) }, { mean: 27, worst: 256, ink: [0.984, 1.006], over: 19.4 }],
  'a noisy tip': [{ ink: ink({ brush: 'noise', size: 30, spacing: 25 }) }, { mean: 33.4, worst: 254, ink: [0.993, 1.007], over: 15.4 }],
  'a ribbon of bars': [{ ink: ink({ brush: 'bars', size: 24, ribbon: true }) }, { mean: 48.7, worst: 256, ink: [0.999, 1.025], over: 21.4 }],
  'grain': [{ ink: ink({ size: 26, texture: { on: true, density: 0.6, scale: 300 } }) }, { mean: 64.4, worst: 256, ink: [0.988, 1.009], over: 0.5 }],
  'watercolour edge': [{ ink: ink({ size: 20, color: '#16a34a', waterEdge: true, waterEdgeWidth: 4, waterEdgePower: 0.7 }) }, { mean: 16.6, worst: 251, ink: [0.99, 1.038], over: 10.1 }],
  'outlined, two bands': [{ ink: ink({ size: 12, color: '#000000' }), strokes: [{ color: '#ffffff', width: 3, opacity: 1 }, { color: '#1d4ed8', width: 2, opacity: 0.8 }] }, { mean: 45, worst: 256, ink: [0.987, 1.061], over: 22.4 }],
};
const SCALES = [1, 2, 2.74];

describe('a mesh bends the ink as the texture warp bent it', () => {
  it('the meshes stretch and squeeze as the header says', () => {
    for (const [name, mesh] of Object.entries(MESHES)) {
      const { most, least } = stretchOf(mesh());
      log(`${name} stretch ${least.toFixed(4)} to ${most.toFixed(4)}`);
    }
    const b = stretchOf(bumpy());
    expect(b.most).toBeCloseTo(1.57, 2);
    expect(b.least).toBeCloseTo(0.545, 2);
    const p = stretchOf(perspective());
    expect(p.most).toBeCloseTo(1.362, 2);
    expect(p.least).toBeCloseTo(0.676, 2);
  });

  // B: the letters alone, the same mesh, in the job against the texture warp.
  const glyphB = {};
  beforeAll(() => {
    for (const name of ['bumpy', 'perspective']) {
      const box = boxOf({ warp: MESHES[name]() });
      glyphB[name] = compare(finished(box, whole, 2), finished(box, whole, 2, null, true), 2);
      log(`B letters | ${name} | ${f(glyphB[name])}`);
    }
  });

  for (const [name, [over, lim]] of Object.entries(MESH_CASES)) {
    it(name, () => {
      const tips = TIPS;
      for (const scale of SCALES) {
        for (const text of ['INK', '']) {
          const floor = {};
          for (const mesh of ['parallel', 'bumpy', 'perspective']) {
            const box = boxOf({ ...over, warp: MESHES[mesh]() }, text);
            expect(boxInJob(box)).toBe(true);
            const bent = finished(box, whole, scale, tips);
            const ref = finished(box, canvasInk, scale, tips);
            const flat = finished(box, whole, scale, tips, true);
            const d = compare(bent, ref, scale);
            const a8 = compare(bent, flat, scale);
            const a = compare(bent, fine(box, whole, scale, tips), scale);
            if (mesh === 'parallel') Object.assign(floor, a);
            log(`${name} | ${mesh} | ${scale} | ${text || 'empty'} | ref ${f(d)} | A at the app's subdivision ${f(a8)} | A ${f(a)} | offgrid ${offGrid(ref, scale).toFixed(4)}`);
            if (scale === 2 && text === 'INK') {
              const [x, y] = laid(bent, ref, scale);
              png(`mesh-${mesh}-${fileOf(name)}.rust.png`, x);
              png(`mesh-${mesh}-${fileOf(name)}.js.png`, y);
            }
            const at = `${mesh}, scale ${scale}, ${text ? 'over letters' : 'alone'}`;
            want(d.n, at).toBeGreaterThan(1000);
            want(d.mean, `${at}: mean`).toBeLessThan(lim.mean);
            want(d.worst, `${at}: worst`).toBeLessThan(lim.worst);
            want(d.ink, `${at}: ink`).toBeGreaterThan(lim.ink[0]);
            want(d.ink, `${at}: ink`).toBeLessThan(lim.ink[1]);
            if (mesh !== 'parallel') want(a.mean - floor.mean, `${at}: A ${a.mean} over its floor ${floor.mean}`).toBeLessThan(lim.over + 0.5);
            // Hard round ink is all edge, as letters are: the bend is no
            // further from the resample than the letters' bend is.
            if (name === 'round hard' && mesh !== 'parallel' && scale === 2 && text === '') want(a8.mean, `${at}: A against B ${glyphB[mesh].mean}`).toBeLessThanOrEqual(glyphB[mesh].mean);
          }
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Roughening.

// A roughening: the reference copies every pixel of the finished texture from
// the nearest pixel to `p + d(p)` and tears every edge a pixel at a time; the
// engine moves each stamp's outline by the field and reads inside it back by
// `p + d(p)`, as it moves the letters' outlines. So single pixels differ
// whole (worst up to 255) and the holds are those of box-job's 'a roughened
// box', made two-sided (review, Gate 1):
// - S, ours against the reference, is under 0.6 of O (ours with another seed
//   against it) AND under 0.6 of U (ours unroughened against it): nearer the
//   pixel pass's crumple than to no crumple at all;
// - the crumple is there: the ink's outline (`perimeter`, of the alpha
//   averaged over 7 x 7) grows under the roughening by at least `share` of
//   what the pixel pass grows it by (measured: round and soft dabs 0.93 to
//   1.02, the noisy tip 0.58 to 1.05, the ribbon 0.40 to 0.55 (the bars
//   inside it are torn by the pass and not by the outline), outlined 0.68
//   to 0.74, grit 1.13 to 1.24; the limit is three quarters of the least);
// - `mean`: the largest measured S and a third more; the total ink within 5 %.
const ROUGH = { on: true, amount: 6, detail: 0.07, seed: 7 };
const ROUGH_CASES = {
  'round hard': [{ ink: ink({}) }, { mean: 8.9, share: 0.73 }],
  'soft, hardness 40': [{ ink: ink({ hardness: 40, size: 22 }) }, { mean: 4.9, share: 0.7 }],
  'a noisy tip': [{ ink: ink({ brush: 'noise', size: 30, spacing: 25 }) }, { mean: 16.7, share: 0.43 }],
  'a ribbon of bars': [{ ink: ink({ brush: 'bars', size: 24, ribbon: true }) }, { mean: 22, share: 0.3 }],
  'outlined': [{ ink: ink({ size: 12, color: '#000000' }), strokes: [{ color: '#fde047', width: 4, opacity: 1 }] }, { mean: 19, share: 0.5 }],
  'with grit': [{ ink: ink({}), roughen: { ...ROUGH, grit: 2 } }, { mean: 12.7, share: 0.85 }],
};

describe('a roughening moves the ink edge as it moves the letters', () => {
  for (const [name, [over, lim]] of Object.entries(ROUGH_CASES)) {
    it(name, () => {
      const roughen = over.roughen ?? ROUGH;
      for (const scale of [2, 2.74]) {
        for (const text of ['INK', '']) {
          const box = boxOf({ ...over, roughen }, text);
          const other = boxOf({ ...over, roughen: { ...roughen, seed: 8 } }, text);
          const plain = boxOf({ ...over, roughen: { ...roughen, on: false } }, text);
          expect(roughenInJob(box)).toBe(true);
          const ref = texture(box, canvasInk, scale, TIPS);
          const ours = texture(box, whole, scale, TIPS);
          const S = compare(ours, ref, scale);
          const O = compare(texture(other, whole, scale, TIPS), ref, scale);
          const unrough = texture(plain, whole, scale, TIPS);
          const U = compare(unrough, ref, scale);
          // The crumple is there: the edge is longer roughened than plain,
          // by a share of what the pixel pass made it longer by.
          const ourGrowth = perimeter(imageOf(ours)) - perimeter(imageOf(unrough));
          const refGrowth = perimeter(imageOf(ref)) - perimeter(imageOf(texture(plain, canvasInk, scale, TIPS)));
          const share = ourGrowth / refGrowth;
          log(`rough ${name} | ${scale} | ${text || 'empty'} | S ${f(S)} | O ${f(O)} | U ${f(U)} | edge share ${share.toFixed(3)} (${ourGrowth} of ${refGrowth})`);
          if (scale === 2 && text === 'INK') {
            const [x, y] = laid(ours, ref, scale);
            png(`rough-${fileOf(name)}.rust.png`, x);
            png(`rough-${fileOf(name)}.js.png`, y);
          }
          const at = `scale ${scale}, ${text ? 'over letters' : 'alone'}`;
          want(S.mean, `${at}: against another seed's ${O.mean}`).toBeLessThan(0.6 * O.mean);
          want(S.mean, `${at}: against the unroughened ${U.mean}`).toBeLessThan(0.6 * U.mean);
          want(S.mean, `${at}: mean`).toBeLessThan(lim.mean);
          want(S.ink, `${at}: ink`).toBeGreaterThan(0.95);
          want(S.ink, `${at}: ink`).toBeLessThan(1.05);
          want(share, `${at}: the edge grew by ${ourGrowth}, the reference's by ${refGrowth}`).toBeGreaterThan(lim.share);
        }
      }
    });
  }

  it('meshed and roughened: roughened first, then bent, as the reference does both', () => {
    for (const scale of [2, 2.74]) {
      const box = boxOf({ ink: ink({ size: 18 }), warp: bumpy(), roughen: ROUGH }, '');
      const swapped = boxOf({ ink: ink({ size: 18 }), warp: bumpy(), roughen: { ...ROUGH, seed: 8 } }, '');
      const ref = finished(box, canvasInk, scale);
      const S = compare(finished(box, whole, scale), ref, scale);
      const O = compare(finished(swapped, whole, scale), ref, scale);
      log(`mesh and rough | ${scale} | S ${f(S)} | O ${f(O)}`);
      want(S.mean).toBeLessThan(0.6 * O.mean);
      want(S.ink).toBeGreaterThan(0.95);
      want(S.ink).toBeLessThan(1.05);
    }
  });
});

describe('a turned box of bent ink', () => {
  const layer = (box, painter, scale) => {
    setGlyphPainter(painter);
    const p = pageOf(box);
    const r = renderBoxLayer(box, p.w, p.h, null, p, scale, TIPS);
    setGlyphPainter(whole);
    return r;
  };
  const onPage = (l, w, h) => {
    const c = createCanvas(w, h);
    c.getContext('2d').putImageData(l.imageData, l.left, l.top);
    return c.getContext('2d').getImageData(0, 0, w, h);
  };
  it('lands where the turned, warped bitmap landed', () => {
    for (const scale of [1, 2]) {
      const box = boxOf({ rotation: 17, ink: ink({ size: 18 }), warp: bumpy() });
      const a = layer(box, whole, scale);
      const b = layer(box, canvasInk, scale);
      for (const k of ['left', 'top', 'right', 'bottom']) want(Math.abs(a[k] - b[k]), `${k} at ${scale}`).toBeLessThanOrEqual(3 * scale);
      const d = against(onPage(a, 600 * scale, 400 * scale), onPage(b, 600 * scale, 400 * scale));
      log(`turned | ${scale} | ${f(d)}`);
      // On the page, turned, at the app's subdivision: the bumpy mesh's
      // pixel (measured 10.4 and 10.8; a third more).
      want(d.ink).toBeGreaterThan(0.98);
      want(d.ink).toBeLessThan(1.02);
      want(d.mean).toBeLessThan(14.5);
    }
  });
});
