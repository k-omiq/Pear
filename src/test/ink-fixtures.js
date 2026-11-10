// The brush ink fixtures the ink engine tests share (ink-rust, ink-bend and
// ink-pairs, all `*.engine.test.js`): the box, its strokes, the imported
// tips, the meshes, and the measure of two pictures. Node only: the tips are
// drawn on @napi-rs/canvas.
import { expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { defaultStyle, normalizeStyle } from '../lib/data.js';
import { identityMesh } from '../lib/warp.js';

// The box: 260 x 130 at (120, 110) on a 600 x 400 page, Bangers at 48, no
// outlines unless a case gives them.
export const INK_W = 260;
export const INK_H = 130;
export const inkStyle = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 48, strokeEffects: [], autoHeight: false, ...over });
export const inkBox = (over = {}, text = 'INK') => ({ id: 'b', lineN: null, text, x: 120, y: 110, w: INK_W, h: INK_H, style: inkStyle(over) });
export const inkPage = (box) => ({ id: 1, w: 600, h: 400, lines: [], boxes: [box] });

// A wavy line across the box, `n` points, factors `extra` per point.
export function wave(n = 24, extra = () => []) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push([20 + t * 220, 65 + Math.sin(t * Math.PI * 2) * 35, 1, ...extra(t)]);
  }
  return pts;
}
export const zigzag = [[30, 30, 1], [90, 100, 1], [150, 30, 1], [210, 100, 1]];
export const ink = (...strokes) => ({ on: true, strokes: strokes.map((k, i) => ({ id: `s${i}`, size: 14, color: '#111111', pts: wave(), ...k })) });

// A seeded stream, for the noisy tip.
export function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// The tips, made as the library hands them on: `{ id, width, height, image }`,
// grey ink at 255 on opaque black.
export function tipOf(id, w, h, draw) {
  const image = createCanvas(w, h);
  const ctx = image.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  draw(ctx, w, h);
  return { id, width: w, height: h, image };
}

const TIP_DRAW = {
  // A soft disc: full in the middle, clear at the rim.
  disc: [128, 128, (ctx, w) => {
    const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.4, '#ffffff');
    g.addColorStop(1, '#000000');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, w);
  }],
  // A tall strip, soft at its sides.
  strip: [48, 200, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#000000');
    g.addColorStop(0.3, '#ffffff');
    g.addColorStop(0.7, '#ffffff');
    g.addColorStop(1, '#000000');
    ctx.fillStyle = g;
    ctx.fillRect(0, 8, w, h - 16);
  }],
  // Grain in a disc: every pixel its own grey.
  noise: [96, 96, (ctx, w, h) => {
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
  }],
  // Bars across, for a ribbon: the tip comes round every pass of its height.
  bars: [64, 160, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff';
    for (let y = 0; y < h; y += 40) ctx.fillRect(0, y, w, 22);
    ctx.fillStyle = '#808080';
    ctx.fillRect(16, 0, 8, h);
  }],
  // Bigger than a tint is made at (2048): capped before it goes in.
  big: [2400, 600, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, h / 2);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#000000');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }],
};

// The tips by id, all five or the ones named.
export function makeTips(ids = Object.keys(TIP_DRAW)) {
  return new Map(ids.map((id) => [id, tipOf(id, ...TIP_DRAW[id])]));
}

// The meshes. A 3 x 3 grid with its inner nodes moved 5 to 10 px; one cell
// with a corner pulled (the homography); one cell that is a parallelogram
// (one affine map).
export function bumpy() {
  const pts = identityMesh(3, 3, INK_W, INK_H);
  const at = (i, j) => j * 4 + i;
  const move = (i, j, dx, dy) => (pts[at(i, j)] = [pts[at(i, j)][0] + dx, pts[at(i, j)][1] + dy]);
  move(1, 1, -6, -9);
  move(2, 1, 8, 5);
  move(1, 2, 5, 7);
  move(2, 2, -10, -6);
  return { on: true, cols: 3, rows: 3, pts };
}
export const perspective = () => ({ on: true, cols: 1, rows: 1, pts: [[0, 0], [INK_W, 22], [-8, INK_H], [INK_W - 10, INK_H - 12]] });
export const parallel = () => ({ on: true, cols: 1, rows: 1, pts: [[0, 0], [INK_W + 10, 18], [-20, INK_H], [INK_W - 10, INK_H + 18]] });

// Two pictures of one size, premultiplied: the mean and the worst difference
// of any channel (of 255) over the pixels either inked, and the ratio of
// their total ink.
export function against(a, b) {
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

// Two textures laid box corner on box corner on one grid of `ss` px a page
// px: each texture's own pixel is `canvas.width / cw` of a page px (a warped
// one's is not exactly `ss`), so a picture whose scale or corner is off the
// grid is drawn to it, and that resample is part of what is measured.
export function laid(a, b, ss) {
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
