// ===== What the agent sees: region renders and proof sheets =====
// The `view` tool's pictures (docs/AI_TYPESETTING_PLAN.md sections 1 and 3).
// Two kinds:
//
//   renderRegion  a page, or a rectangle of one, typeset or raw, with marks
//                 drawn on top: box ids, bubble outlines with their points,
//                 rulers in page pixels.
//   proofSheet    each box as a labelled crop with its outline and points,
//                 about twenty to one image. The crop shows the typeset text;
//                 no text is written as a label (page text is untrusted, see
//                 fence.js, and a picture of it is the same text).
//
// And two the other read tools use:
//
//   regionPixels     a rectangle of a page as raw pixels, small, for the
//                    `colors` tool to measure (palette.js); never an image.
//   renderFontSheet  font samples in a grid, each labelled with its exact
//                    family name, for the `font_sheet` tool. The names are the
//                    font lists' own, not page text.
//
// Sizes follow the model's no-resize size: about 1568 px on the long side,
// never more, so the image goes in as drawn.
//
// The pure layout helpers are exported on their own so tests can pin the
// arithmetic without a canvas.

import { renderPageCanvas, pageSpace } from '../exporter.js';
import { withPageImages } from '../page-images.js';
import { outlinePoints, outlineState, fontsSettling } from '../store.svelte.js';
import { ToolError } from './registry.js';

export const MAX_SIDE = 1568;
export const MAX_SCALE = 2;
// Base64 length past which a PNG is re-encoded as JPEG.
export const MAX_PNG_B64 = 1_500_000;
export const JPEG_QUALITY = 0.85;

// Outline colours, by `outlineState`. Said in the tool's note too.
export const OUTLINE_COLORS = {
  user: '#16a34a',
  ai: '#2563eb',
  waiting: '#f59e0b',
  open: '#dc2626',
  none: '#9333ea',
};
export const OUTLINE_KEY =
  'outline colours: green approved by the user, blue approved by the AI, orange waiting for approval, ' +
  'red dashed open (no outline found; the box rectangle is drawn), purple no outline measured.';

// ---------- pure helpers ----------

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// `rect` [x, y, w, h] in page px, clamped to the page and rounded out to whole
// pixels. No rect is the whole page. A rect that misses the page is null.
export function clampRect(rect, W, H) {
  if (rect == null) return [0, 0, W, H];
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(finite)) return null;
  let [x, y, w, h] = rect;
  if (w < 0) [x, w] = [x + w, -w];
  if (h < 0) [y, h] = [y + h, -h];
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W, Math.ceil(x + w));
  const y1 = Math.min(H, Math.ceil(y + h));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return [x0, y0, x1 - x0, y1 - y0];
}

// The scale a crop of w x h page px is drawn at: the given one (never past
// MAX_SCALE, and never so large that the long side passes MAX_SIDE), or the
// largest that keeps the long side within MAX_SIDE, never upscaling past
// MAX_SCALE.
export function chooseScale(w, h, scale, maxSide = MAX_SIDE) {
  const long = Math.max(w, h, 1);
  const fit = maxSide / long;
  const want = finite(scale) && scale > 0 ? scale : fit;
  return Math.min(want, fit, MAX_SCALE);
}

// The image size for a crop at `s`, at least 1 px each way.
export const outSize = (w, h, s) => [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];

// Ruler ticks along one edge, inside [start, start + len): every 10 page px
// when they are at least `minTick` output px apart (else every 50, else 100),
// longer every 50, with a number every 50 page px or the next round step that
// keeps numbers `minGap` output px apart.
export function rulerTicks(start, len, s, { minTick = 6, minGap = 40 } = {}) {
  const step = [10, 50, 100].find((k) => k * s >= minTick) ?? 100;
  const every = [50, 100, 200, 500, 1000, 2000, 5000, 10000].find((k) => k * s >= minGap && k % step === 0) ?? 10000;
  const ticks = [];
  for (let v = Math.ceil(start / step) * step; v < start + len; v += step) {
    ticks.push({ at: v, pos: (v - start) * s, label: v % every === 0 ? String(v) : null, major: v % 50 === 0 });
  }
  return ticks;
}

// The grid of a proof sheet: `n` cells of at most `cell` px, as near square as
// fits, shrunk so the sheet's long side stays within `maxSide`.
export function sheetLayout(n, { cell = 360, maxSide = MAX_SIDE, gap = 8 } = {}) {
  const count = Math.max(0, n | 0);
  if (!count) return { cols: 0, rows: 0, cell: 0, gap, width: 0, height: 0, cells: [] };
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const fit = Math.floor((maxSide - gap * (Math.max(cols, rows) + 1)) / Math.max(cols, rows));
  const size = Math.max(16, Math.min(cell, fit));
  const cells = Array.from({ length: count }, (_, i) => ({
    x: gap + (i % cols) * (size + gap),
    y: gap + Math.floor(i / cols) * (size + gap),
    w: size,
    h: size,
  }));
  return { cols, rows, cell: size, gap, width: gap + cols * (size + gap), height: gap + rows * (size + gap), cells };
}

// `items` cut into sheets of `perSheet`, at most `maxSheets` of them; `left`
// is how many did not fit.
export function splitSheets(items, perSheet = 20, maxSheets = 3) {
  const per = Math.max(1, perSheet | 0);
  const sheets = [];
  for (let i = 0; i < items.length && sheets.length < maxSheets; i += per) sheets.push(items.slice(i, i + per));
  const shown = sheets.reduce((n, s) => n + s.length, 0);
  return { sheets, left: items.length - shown };
}

const isApproved = (state) => state === 'user' || state === 'ai';

// Proof order: unapproved outlines first, lowest confidence first; then the
// approved, in the order given. Stable: ties keep the order given. `boxOf`
// reads the box out of an item (a match, or the box itself).
export function proofOrder(items, boxOf = (it) => it?.box ?? it) {
  const rows = items.map((it, i) => {
    const b = boxOf(it);
    const state = outlineState(b);
    const conf = Number(b?.outline?.confidence);
    return { it, i, approved: isApproved(state), conf: Number.isFinite(conf) ? conf : 0 };
  });
  rows.sort((a, b) => {
    if (a.approved !== b.approved) return a.approved ? 1 : -1;
    if (!a.approved && a.conf !== b.conf) return a.conf - b.conf;
    return a.i - b.i;
  });
  return rows.map((r) => r.it);
}

// Axis-aligned bounds of a box, its rotation included.
export function boxBounds(b) {
  const { x = 0, y = 0, w = 0, h = 0 } = b ?? {};
  const rot = ((Number(b?.style?.rotation) || 0) * Math.PI) / 180;
  if (!rot) return [x, y, w, h];
  const cx = x + w / 2;
  const cy = y + h / 2;
  const c = Math.abs(Math.cos(rot));
  const s = Math.abs(Math.sin(rot));
  const bw = w * c + h * s;
  const bh = w * s + h * c;
  return [cx - bw / 2, cy - bh / 2, bw, bh];
}

const boundsOf = (pts) => {
  if (!pts.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of pts) {
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px);
    y1 = Math.max(y1, py);
  }
  return [x0, y0, x1 - x0, y1 - y0];
};

const union = (a, b) => {
  if (!b) return a;
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  return [x0, y0, Math.max(a[0] + a[2], b[0] + b[2]) - x0, Math.max(a[1] + a[3], b[1] + b[3]) - y0];
};

// A proof cell's crop: the box and its outline, padded by `pad` of each side
// (at least `minPad` px), clamped to the page.
export function cropFor(mark, W, H, { pad = 0.25, minPad = 16 } = {}) {
  const r = union(mark.bounds, boundsOf(mark.points));
  const px = Math.max(minPad, r[2] * pad);
  const py = Math.max(minPad, r[3] * pad);
  return clampRect([r[0] - px, r[1] - py, r[2] + px * 2, r[3] + py * 2], W, H) ?? [0, 0, W, H];
}

// A crop of cw x ch fitted into a cell, centred: its scale (never past
// MAX_SCALE) and its offset inside the cell.
export function fitInCell(cw, ch, cell) {
  const s = Math.min(cell.w / Math.max(cw, 1), cell.h / Math.max(ch, 1), MAX_SCALE);
  const w = cw * s;
  const h = ch * s;
  return { s, x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

// The scale a region is read at for its colours: down so its long side is at
// most `maxSide`, never up - an upscaled pixel holds no colour the page did not.
export const PIXELS_MAX_SIDE = 400;
export const pixelScale = (w, h, maxSide = PIXELS_MAX_SIDE) => Math.min(1, maxSide / Math.max(w, h, 1));

// The grid of a font sheet: `n` fonts, one to a row, in one column up to
// ten and two past that, filled down the first column before the second so it
// reads as a list. Rows share the long side; each row is a small label (the
// number and name) over the sample, whose font size is `sample` px, shrunk at
// drawing time only if a font's sample is wider than its cell.
export const FONT_SHEET_MAX = 40;
export function fontSheetLayout(n, { maxSide = MAX_SIDE, pad = 12, gap = 10 } = {}) {
  const count = Math.min(FONT_SHEET_MAX, Math.max(0, n | 0));
  if (!count) return { cols: 0, rows: 0, width: 0, height: 0, label: 0, sample: 0, cells: [] };
  const cols = count > 10 ? 2 : 1;
  const rows = Math.ceil(count / cols);
  const rowH = Math.max(56, Math.min(140, Math.floor((maxSide - pad * 2) / rows)));
  const cellW = cols === 1 ? 1000 : Math.floor((maxSide - pad * 2 - gap) / 2);
  const label = Math.max(11, Math.min(16, Math.round(rowH * 0.17)));
  const sample = Math.round((rowH - label - 10) * 0.75);
  const cells = Array.from({ length: count }, (_, i) => {
    const col = Math.floor(i / rows);
    const row = i % rows;
    return { row: row + 1, col: col + 1, x: pad + col * (cellW + gap), y: pad + row * rowH, w: cellW, h: rowH };
  });
  return { cols, rows, width: pad * 2 + cols * cellW + (cols - 1) * gap, height: pad * 2 + rows * rowH, label, sample, cells };
}

// The sample's font size in a cell: `size`, or smaller so `width` (measured at
// `size`) fits `room`, never under 8 px.
export const fitSampleSize = (size, width, room) => (width > room && width > 0 ? Math.max(8, Math.floor((size * room) / width)) : size);

// PNG unless its base64 passes `max`, then JPEG.
export const encodingFor = (pngB64Length, max = MAX_PNG_B64) => (pngB64Length > max ? 'image/jpeg' : 'image/png');

// What a mark needs of a box, read once and plain: the live box can change
// while a render awaits, and these are store proxies.
export function markOf(b) {
  const state = outlineState(b);
  const points = b?.fit ? outlinePoints(b.fit).map(([x, y]) => [x, y]) : [];
  const conf = Number(b?.outline?.confidence);
  return {
    id: String(b?.id ?? ''),
    x: b?.x ?? 0,
    y: b?.y ?? 0,
    w: b?.w ?? 0,
    h: b?.h ?? 0,
    rotation: Number(b?.style?.rotation) || 0,
    bounds: boxBounds(b),
    state: state ?? 'none',
    confidence: Number.isFinite(conf) ? conf : null,
    points,
  };
}

// ---------- canvas ----------

function newCanvas(w, h) {
  if (typeof document === 'undefined') throw new Error('rendering needs a canvas, and there is none here');
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Hand a canvas's pixels back now, not when the collector gets to it.
const release = (c) => {
  if (!c) return;
  c.width = 0;
  c.height = 0;
};

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // or the canvas taints and cannot be read
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Fonts and engines settled before a page is drawn, as the export waits.
async function settle(p) {
  const settling = fontsSettling([p]);
  if (settling) await settling;
  if (typeof document !== 'undefined' && document.fonts?.ready) await document.fonts.ready;
}

// The whole page at `s`: typeset; raw (the original scan, its own lettering
// still on it); or clean (the cleaned page with none of our text - where the
// original letters still show, the cleaner left them). The caller holds the
// page's images (withPageImages) and releases the canvas.
async function pageCanvas(p, source, s) {
  if (source === 'raw' || source === 'clean') {
    const src = source === 'raw' ? p.raw : (p.cleaned ?? p.raw);
    if (!src) throw new ToolError(`this page has no ${source === 'raw' ? 'raw' : 'page'} image`, 'use source: "typeset"');
    const { w: W, h: H } = await pageSpace(p);
    const c = newCanvas(Math.round(W * s), Math.round(H * s));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    const img = await loadImage(src);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  await settle(p);
  return renderPageCanvas(p, s);
}

// Canvas to base64 (no data: prefix), PNG unless that is too big.
export function encodeCanvas(c) {
  const png = c.toDataURL('image/png');
  let b64 = png.slice(png.indexOf(',') + 1);
  let mime = 'image/png';
  if (encodingFor(b64.length) === 'image/jpeg') {
    const jpg = c.toDataURL('image/jpeg', JPEG_QUALITY);
    b64 = jpg.slice(jpg.indexOf(',') + 1);
    mime = 'image/jpeg';
  }
  return { png: b64, mime };
}

// A label on a solid tab, top-left at (x, y), kept inside [0, maxW).
function label(ctx, text, x, y, size, color, maxW = Infinity, sub = null) {
  ctx.save();
  ctx.font = `bold ${size}px sans-serif`;
  ctx.textBaseline = 'top';
  const padX = Math.round(size * 0.3);
  const padY = Math.round(size * 0.15);
  const w = ctx.measureText(text).width;
  const subSize = Math.round(size * 0.6);
  let subW = 0;
  if (sub) {
    ctx.font = `bold ${subSize}px sans-serif`;
    subW = ctx.measureText(sub).width + padX;
  }
  const tabW = w + subW + padX * 2;
  const tabH = size + padY * 2;
  const tx = Math.max(0, Math.min(x, maxW - tabW));
  ctx.fillStyle = color;
  ctx.fillRect(tx, y, tabW, tabH);
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${size}px sans-serif`;
  ctx.fillText(text, tx + padX, y + padY);
  if (sub) {
    ctx.font = `bold ${subSize}px sans-serif`;
    ctx.fillText(sub, tx + padX + w + padX, y + padY + (size - subSize));
  }
  ctx.restore();
  return tabH;
}

// One box's outline and points, mapped by `map` from page px to output px.
function drawOutline(ctx, m, map, lw) {
  const color = OUTLINE_COLORS[m.state] ?? OUTLINE_COLORS.none;
  ctx.save();
  ctx.lineWidth = lw;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  // White under-stroke so the line reads on black art too.
  const path = (pts) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const [ox, oy] = map(x, y);
      if (i) ctx.lineTo(ox, oy);
      else ctx.moveTo(ox, oy);
    });
    ctx.closePath();
  };
  let pts = m.points;
  if (!pts.length) {
    // No outline: the box's own rectangle, dashed.
    const cx = m.x + m.w / 2;
    const cy = m.y + m.h / 2;
    const r = (m.rotation * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    pts = [[m.x, m.y], [m.x + m.w, m.y], [m.x + m.w, m.y + m.h], [m.x, m.y + m.h]].map(([x, y]) => [
      cx + (x - cx) * c - (y - cy) * s,
      cy + (x - cx) * s + (y - cy) * c,
    ]);
    ctx.setLineDash([lw * 3, lw * 2]);
  }
  path(pts);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = lw * 2.2;
  ctx.globalAlpha = 0.7;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.stroke();
  ctx.setLineDash([]);
  if (m.points.length) {
    const r = Math.max(2.5, lw * 1.7);
    for (const [x, y] of m.points) {
      const [ox, oy] = map(x, y);
      ctx.beginPath();
      ctx.arc(ox, oy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ox, oy, r * 0.65, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawRulers(ctx, rect, s, W, H) {
  const [rx, ry, rw, rh] = rect;
  const size = 11;
  ctx.save();
  ctx.font = `bold ${size}px sans-serif`;
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;
  const tick = (x0, y0, x1, y1) => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = '#e11d48';
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  const text = (t, x, y) => {
    const w = ctx.measureText(t).width;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x - 1, y - 1, w + 2, size + 2);
    ctx.fillStyle = '#e11d48';
    ctx.fillText(t, x, y);
  };
  for (const t of rulerTicks(rx, rw, s)) {
    const x = Math.round(t.pos) + 0.5;
    tick(x, 0, x, t.label ? 12 : t.major ? 8 : 4);
    if (t.label && t.pos > 0) text(t.label, x + 2, 2);
  }
  for (const t of rulerTicks(ry, rh, s)) {
    const y = Math.round(t.pos) + 0.5;
    tick(0, y, t.label ? 12 : t.major ? 8 : 4, y);
    if (t.label && t.pos > 0) text(t.label, 2, y + 2);
  }
  ctx.restore();
}

const wantsId = (ids, id) => ids === true || (Array.isArray(ids) && ids.includes(id));

const intersects = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

// ---------- renderRegion ----------

// `p` a live page. `rect` [x, y, w, h] in page px (clamped; default the whole
// page). Returns `{ png, mime, width, height, scale, rect, boxes }` where
// `boxes` is each box the crop shows, with its bounds in image px.
export async function renderRegion(p, rect, { scale, marks, source = 'typeset' } = {}) {
  const marksIn = marks ?? {};
  const boxes = (p?.boxes ?? []).map(markOf);
  return withPageImages(p, async () => {
    const { w: W, h: H } = await pageSpace(p);
    const r = clampRect(rect, W, H);
    if (!r) throw new ToolError('the rect is outside the page', `the page is ${W} x ${H} px; rect is [x, y, w, h]`);
    const s = chooseScale(r[2], r[3], scale);
    const [ow, oh] = outSize(r[2], r[3], s);
    const page = await pageCanvas(p, source, s);
    const out = newCanvas(ow, oh);
    try {
      const ctx = out.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, ow, oh);
      ctx.drawImage(page, Math.round(r[0] * s), Math.round(r[1] * s), ow, oh, 0, 0, ow, oh);
      release(page);
      const map = (x, y) => [(x - r[0]) * s, (y - r[1]) * s];
      const shown = boxes.filter((m) => intersects(union(m.bounds, boundsOf(m.points)), r));
      if (marksIn.outlines) for (const m of shown) drawOutline(ctx, m, map, 2);
      if (marksIn.ids) {
        for (const m of shown) {
          if (!wantsId(marksIn.ids, m.id)) continue;
          const [lx, ly] = map(m.bounds[0], m.bounds[1]);
          label(ctx, m.id, Math.max(0, lx), Math.max(0, ly), 14, OUTLINE_COLORS[m.state] ?? '#111827', ow);
        }
      }
      if (marksIn.rulers) drawRulers(ctx, r, s, W, H);
      const img = encodeCanvas(out);
      return {
        ...img,
        width: ow,
        height: oh,
        scale: s,
        rect: r,
        // Each box's cell in the image, cut to it: its rectangle, or, for a
        // box shown only because its outline reaches in, the outline's part.
        boxes: shown.map((m) => {
          const cell = (bx) => {
            const [x0, y0] = map(bx[0], bx[1]);
            const [x1, y1] = map(bx[0] + bx[2], bx[1] + bx[3]);
            const cx = Math.min(ow, Math.max(0, Math.round(x0)));
            const cy = Math.min(oh, Math.max(0, Math.round(y0)));
            const w = Math.min(ow, Math.max(0, Math.round(x1))) - cx;
            const h = Math.min(oh, Math.max(0, Math.round(y1))) - cy;
            return w > 0 && h > 0 ? { x: cx, y: cy, w, h } : null;
          };
          return { id: m.id, ...(cell(m.bounds) ?? cell(union(m.bounds, boundsOf(m.points))) ?? { x: 0, y: 0, w: 0, h: 0 }) };
        }),
      };
    } finally {
      release(page);
      release(out);
    }
  });
}

// ---------- pixels for colour ----------

// `rect` [x, y, w, h] of page `p` (clamped; default the whole page), drawn
// `source` 'raw' (the original scan), 'clean' (the cleaned page, no text of ours) or 'typeset', at the scale
// that keeps its long side within `maxSide`. Returns `{ data, width, height,
// rect, scale }`: an ImageData's RGBA bytes, the size they were read at, and
// the page px rect they cover.
export async function regionPixels(p, rect, { source = 'raw', maxSide = PIXELS_MAX_SIDE } = {}) {
  return withPageImages(p, async () => {
    const { w: W, h: H } = await pageSpace(p);
    const r = clampRect(rect, W, H);
    if (!r) throw new ToolError('the rect is outside the page', `the page is ${W} x ${H} px; rect is [x, y, w, h]`);
    const s = pixelScale(r[2], r[3], maxSide);
    const [ow, oh] = outSize(r[2], r[3], s);
    const page = await pageCanvas(p, source, s);
    const out = newCanvas(ow, oh);
    try {
      const ctx = out.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, ow, oh);
      ctx.drawImage(page, Math.round(r[0] * s), Math.round(r[1] * s), ow, oh, 0, 0, ow, oh);
      const img = ctx.getImageData(0, 0, ow, oh);
      return { data: img.data, width: ow, height: oh, rect: r, scale: s };
    } finally {
      release(page);
      release(out);
    }
  });
}

// ---------- font sheets ----------

// How long a sheet waits for its fonts before drawing what it has: a family
// that never arrives (a file gone, a webfont offline) is drawn in its
// fallback rather than holding the agent up.
export const FONT_LOAD_MS = 4000;

// Every entry's regular face asked for and waited on, as the browser loads a
// face only once something asks for it (the built-ins are webfonts). Where
// there is no font set (the tests' canvas), there is nothing to wait for.
async function loadFaces(entries, text, size) {
  const set = typeof document !== 'undefined' ? document.fonts : null;
  if (!set?.load) return;
  let timer;
  await Promise.race([
    Promise.all(entries.map((e) => set.load(`400 ${size}px ${e.css}`, text).catch(() => null))),
    new Promise((resolve) => {
      timer = setTimeout(resolve, FONT_LOAD_MS);
    }),
  ]);
  clearTimeout(timer);
}

// `entries` [{ n, name, css, missing }] in sheet order: each drawn as its
// number and name in a plain UI face over `text` set in the entry's own CSS
// family. Returns `{ png, mime, width, height, cells: [{ n, name, row, col,
// size }] }`, `size` being the sample's font px after any shrink to fit.
export async function renderFontSheet(entries, { text, maxSide = MAX_SIDE } = {}) {
  const L = fontSheetLayout(entries.length, { maxSide });
  const list = entries.slice(0, L.cells.length);
  await loadFaces(list, text, L.sample);
  const out = newCanvas(Math.max(1, L.width), Math.max(1, L.height));
  try {
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    const cells = list.map((e, i) => {
      const k = L.cells[i];
      ctx.save();
      ctx.beginPath();
      ctx.rect(k.x, k.y, k.w, k.h);
      ctx.clip();
      // Every other row on a faint band, so a sample cannot be read as the
      // next row's.
      if (k.row % 2 === 0) {
        ctx.fillStyle = '#f4f4f5';
        ctx.fillRect(k.x, k.y, k.w, k.h);
      }
      ctx.textBaseline = 'top';
      ctx.font = `bold ${L.label}px sans-serif`;
      ctx.fillStyle = '#52525b';
      const tag = `${e.n}. ${e.name}`;
      ctx.fillText(tag, k.x + 8, k.y + 4);
      if (e.missing) {
        const w = ctx.measureText(tag).width;
        ctx.fillStyle = '#dc2626';
        ctx.fillText('  missing: drawn in a fallback', k.x + 8 + w, k.y + 4);
      }
      // The sample on a baseline under the label, shrunk to fit the cell.
      const room = k.w - 16;
      ctx.font = `400 ${L.sample}px ${e.css}`;
      const size = fitSampleSize(L.sample, ctx.measureText(text).width, room);
      if (size !== L.sample) ctx.font = `400 ${size}px ${e.css}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#111111';
      ctx.fillText(text, k.x + 8, k.y + L.label + 8 + Math.round(L.sample * 0.85));
      ctx.restore();
      return { n: e.n, name: e.name, row: k.row, col: k.col, size };
    });
    const img = encodeCanvas(out);
    return { ...img, width: out.width, height: out.height, cells };
  } finally {
    release(out);
  }
}

// ---------- proof sheets ----------

const stateTag = (m) =>
  m.state === 'waiting' ? `waiting ${m.confidence == null ? '' : m.confidence.toFixed(2)}`.trim() : m.state === 'none' ? 'no outline' : m.state;

// One sheet of `items` ([{ page, box }], in the order given; pages may differ).
// Returns `{ png, mime, width, height, cells: [{ id, x, y, w, h }] }`.
export async function proofSheetOf(items, { cell = 360, source = 'typeset', maxSide = MAX_SIDE } = {}) {
  const L = sheetLayout(items.length, { cell, maxSide });
  const rows = items.map((it, i) => ({ page: it.page, mark: markOf(it.box), cell: L.cells[i] }));
  const out = newCanvas(Math.max(1, L.width), Math.max(1, L.height));
  try {
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#d4d4d8';
    ctx.fillRect(0, 0, out.width, out.height);
    // One page canvas per page, at the largest scale any of its cells needs,
    // drawn into every cell it holds and given back before the next page.
    const pages = [...new Set(rows.map((r) => r.page))];
    for (const p of pages) {
      await withPageImages(p, async () => {
        const { w: W, h: H } = await pageSpace(p);
        const mine = rows.filter((r) => r.page === p);
        for (const r of mine) {
          r.crop = cropFor(r.mark, W, H);
          r.fit = fitInCell(r.crop[2], r.crop[3], r.cell);
        }
        const ps = Math.min(MAX_SCALE, Math.max(...mine.map((r) => r.fit.s)));
        const pc = await pageCanvas(p, source, ps);
        try {
          for (const r of mine) {
            const { crop: c, fit: f, cell: k } = r;
            ctx.save();
            ctx.beginPath();
            ctx.rect(k.x, k.y, k.w, k.h);
            ctx.clip();
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(k.x, k.y, k.w, k.h);
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(pc, c[0] * ps, c[1] * ps, c[2] * ps, c[3] * ps, f.x, f.y, f.w, f.h);
            const map = (x, y) => [f.x + (x - c[0]) * f.s, f.y + (y - c[1]) * f.s];
            drawOutline(ctx, r.mark, map, Math.max(1.5, k.w / 180));
            ctx.restore();
          }
        } finally {
          release(pc);
        }
      });
    }
    // Labels last, over the crops, large.
    for (const r of rows) {
      const k = r.cell;
      const size = Math.max(16, Math.round(k.w * 0.075));
      ctx.save();
      ctx.beginPath();
      ctx.rect(k.x, k.y, k.w, k.h);
      ctx.clip();
      label(ctx, r.mark.id, k.x, k.y, size, OUTLINE_COLORS[r.mark.state] ?? '#111827', k.x + k.w, stateTag(r.mark));
      ctx.restore();
    }
    const img = encodeCanvas(out);
    return {
      ...img,
      width: out.width,
      height: out.height,
      cells: rows.map((r) => ({ id: r.mark.id, x: r.cell.x, y: r.cell.y, w: r.cell.w, h: r.cell.h })),
    };
  } finally {
    release(out);
  }
}

// `boxes` on page `p`, in the order given, cut into sheets of `perSheet`.
// Returns the first sheet; `proofSheets` returns them all.
export async function proofSheet(p, boxes, { cell = 360, perSheet = 20, source = 'typeset' } = {}) {
  const items = boxes.slice(0, Math.max(1, perSheet | 0)).map((box) => ({ page: p, box }));
  return proofSheetOf(items, { cell, source });
}

export async function proofSheets(items, { cell = 360, perSheet = 20, maxSheets = 3, source = 'typeset' } = {}) {
  const { sheets, left } = splitSheets(items, perSheet, maxSheets);
  const out = [];
  for (const sheet of sheets) out.push(await proofSheetOf(sheet, { cell, source }));
  return { sheets: out, left };
}
