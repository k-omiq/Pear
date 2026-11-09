import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture, warpTexture, boxInJob } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { inkBox, inkPage, ink, bumpy, perspective, against, laid, makeTips } from '../test/ink-fixtures.js';

// ===========================================================================
// Brush ink, canvas against engine, as pictures for a person to look at
// (layer styles phase 8d)
// ===========================================================================
// Not a test: nothing here can fail on a picture. It paints each case twice
// at scale 2 through `renderBoxTexture` (and `warpTexture`, as the page
// composite gets the box), once with the Rust painter as it is (the ink in
// the box job) and once with `ink: false`, which sends an inked box down the
// canvas passes: the reference of ink-rust and ink-bend, and what the app
// showed before the ink went into the job.
//
// - Ink cases: canvas | engine | |difference| x 4 (the worst channel,
//   premultiplied, as `against` measures it).
// - Effects on ink: canvas (the ink as the app showed it, the effect set;
//   of these the canvas path painted only the Drop Shadow, its own way, and
//   pairs.md says per case whether it changed) | engine, ink with the effect
//   | engine, letters alone with the same effect.
//
// Each sheet is a PNG, with a contact sheet of them all and pairs.md, which
// lists every file with its worst pixel and mean difference.
//
//   MT_INK_PAIRS=dir npx vitest run --project engine ink-pairs
//
// Without the variable it does nothing.

const OUT = process.env.MT_INK_PAIRS;
const SCALE = 2;
const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let whole;
let canvasInk;
let tips;

beforeAll(async () => {
  if (!OUT) return;
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  const rust = await rustEngine();
  setTextEngine(rust);
  whole = createRustGlyphPainter(rust);
  canvasInk = { ...whole, ink: false };
  setGlyphPainter(whole);
  setTypesetEnabled(true);
  clearLayoutMemo();
  tips = makeTips(['disc', 'strip', 'noise', 'bars']);
});
afterAll(() => {
  if (!OUT) return;
  setTextEngine(before.engine);
  setGlyphPainter(before.painter);
  setTypesetEnabled(before.typeset);
  clearLayoutMemo();
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});

const ROUGH = { on: true, amount: 6, detail: 0.07, seed: 7 };

const INK_CASES = [
  ['round hard', { ink: ink({}) }],
  ['round soft', { ink: ink({ color: '#dc2626', hardness: 30, size: 24 }) }],
  ['imported tip, noisy', { ink: ink({ brush: 'noise', size: 30, spacing: 25 }) }],
  ['tip cycle', { ink: ink({ brush: 'disc', tips: ['disc', 'strip', 'noise'], tipOrder: 'repeat', size: 28, spacing: 30 }) }],
  ['ribbon, round', { ink: ink({ size: 16, ribbon: true, flatness: 0.5 }) }],
  ['ribbon of a bars tip', { ink: ink({ brush: 'bars', size: 24, ribbon: true }) }],
  ['anti-aliasing none', { ink: ink({ antialias: 0 }) }],
  ['darken tips', { ink: ink({ brush: 'noise', size: 30, spacing: 15, darkenTips: true }) }],
  ['mesh, bumpy', { ink: ink({}), warp: bumpy() }],
  ['roughen', { ink: ink({}), roughen: ROUGH }],
  ['mesh and roughen', { ink: ink({ size: 18 }), warp: bumpy(), roughen: ROUGH }],
  // Point B: the outline round the ink keeps its page width on the bent ink;
  // the canvas stretched it with the texture (as it does the letters' own).
  ['outlined ink, bumpy mesh (point B)', { ink: ink({ size: 12, color: '#000000' }), strokes: [{ color: '#1d4ed8', width: 4, opacity: 1 }], warp: bumpy() }],
  ['outlined ink, perspective mesh (point B)', { ink: ink({ size: 12, color: '#000000' }), strokes: [{ color: '#1d4ed8', width: 4, opacity: 1 }], warp: perspective() }],
  ['grain under a mesh', { ink: ink({ size: 26, texture: { on: true, density: 0.6, scale: 300 } }), warp: bumpy() }],
];

// The effects, on blue ink and blue letters, so a dark shadow or a light
// glow shows on both.
const BLUE = '#2563eb';
const RED = '#ff0000';
const OUTSIDE = { size: 3, position: 'outside', color: RED, opacity: 1, blend: 'normal' };
const FX_CASES = [
  ['Drop Shadow', { shadows: [{ x: 6, y: 6, size: 6, color: '#000000', opacity: 0.75 }] }],
  ['Inner Shadow', { innerShadows: [{ x: 4, y: 4, size: 5, color: '#000000', opacity: 0.9, blend: 'multiply' }] }],
  ['Outer Glow', { outerGlow: { on: true, color: RED, opacity: 1, size: 12, spread: 0.3, blend: 'normal' } }],
  ['Inner Glow', { innerGlow: { on: true, color: '#ffffbe', opacity: 1, size: 8 } }],
  ['Satin', { satin: { on: true, opacity: 0.8 } }],
  ['Bevel and Emboss', { bevel: { on: true, size: 6 } }],
  ['Colour Overlay', { colorOverlays: [{ color: RED, opacity: 1, blend: 'normal' }] }],
  ['Gradient Overlay', { gradientOverlays: [{ opacity: 1, gradient: { angle: 0, stops: [{ pos: 0, color: '#ff3b30' }, { pos: 1, color: '#facc15' }] } }] }],
  ['Pattern Overlay', { patternOverlay: { on: true, pattern: { kind: 'diagonal', fg: '#000000', bg: '#ffffff', scale: 1 } } }],
  ['Stroke effect', { strokeEffects: [OUTSIDE] }],
  ['Fill Opacity 0, with an outside Stroke effect', { fillOpacity: 0, strokeEffects: [OUTSIDE] }],
];

// The box as the page composite gets it: the texture, warped where the
// painter did not bend it.
function finished(box, painter) {
  setGlyphPainter(painter);
  clearLayoutMemo();
  const t = renderBoxTexture(box, inkPage(box), tips, SCALE);
  const w = warpTexture(t, box);
  setGlyphPainter(whole);
  return w;
}
const imageOf = (t) => t.canvas.getContext('2d').getImageData(0, 0, t.canvas.width, t.canvas.height);

// |a - b| x 4, the worst channel premultiplied (as `against`), grey on black.
function difference(a, b) {
  const c = createCanvas(a.width, a.height);
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(a.width, a.height);
  for (let i = 0; i < a.data.length; i += 4) {
    const aa = a.data[i + 3];
    const ba = b.data[i + 3];
    let d = Math.abs(aa - ba);
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs((a.data[i + k] * aa - b.data[i + k] * ba) / 255));
    const v = Math.min(255, Math.round(d * 4));
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  return out;
}

const PAD = 16;
const HEAD = 70;
function checker(ctx, x, y, w, h) {
  const n = 10;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#e4e4e4';
  for (let j = 0; j * n < h; j++) for (let i = (j % 2); i * n < w; i += 2) ctx.fillRect(x + i * n, y + j * n, Math.min(n, w - i * n), Math.min(n, h - j * n));
}
// Panels side by side: each `{ label, img, plain }` (`plain`: drawn as it
// is, not over the checker).
function sheet(title, panels) {
  const w = panels.reduce((s, p) => s + p.img.width, 0) + PAD * (panels.length + 1);
  const h = HEAD + Math.max(...panels.map((p) => p.img.height)) + PAD;
  const cnv = createCanvas(w, h);
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#222222';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(title, PAD, 28);
  ctx.font = '16px sans-serif';
  let x = PAD;
  for (const p of panels) {
    ctx.fillStyle = '#555555';
    ctx.fillText(p.label, x, 58);
    if (!p.plain) checker(ctx, x, HEAD, p.img.width, p.img.height);
    const top = createCanvas(p.img.width, p.img.height);
    top.getContext('2d').putImageData(p.img, 0, 0);
    ctx.drawImage(top, x, HEAD);
    ctx.strokeStyle = '#bbbbbb';
    ctx.strokeRect(x - 0.5, HEAD - 0.5, p.img.width + 1, p.img.height + 1);
    x += p.img.width + PAD;
  }
  return cnv;
}

const fileOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const f = (d) => `worst ${d.worst.toFixed(1)}, mean ${d.mean.toFixed(3)}, ink ${d.ink.toFixed(4)}`;

describe.skipIf(!OUT)('ink pairs, canvas against engine', () => {
  it('are written', { timeout: 600_000 }, () => {
    const dir = resolve(OUT);
    mkdirSync(dir, { recursive: true });
    const rows = [];
    const sheets = [];
    const write = (file, cnv) => {
      writeFileSync(resolve(dir, file), cnv.toBuffer('image/png'));
      sheets.push([file, cnv]);
    };

    for (const [name, over] of INK_CASES) {
      const box = inkBox(over, 'INK');
      // The engine's picture against the canvas's, not the canvas's twice.
      expect(boxInJob(box), name).toBe(true);
      const ours = finished(box, whole);
      const ref = finished(box, canvasInk);
      const [a, b] = laid(ours, ref, SCALE);
      const d = against(a, b);
      const file = `ink-${fileOf(name)}.png`;
      write(file, sheet(`${name}  (${f(d)})`, [
        { label: 'canvas (ink: false)', img: b },
        { label: 'engine (box job)', img: a },
        { label: '|difference| x4', img: difference(a, b), plain: true },
      ]));
      rows.push(`| ${file} | ${name} | canvas / engine / diff x4 | ${d.worst.toFixed(1)} | ${d.mean.toFixed(3)} | ${d.ink.toFixed(4)} | |`);
    }

    for (const [name, fx] of FX_CASES) {
      const inked = { color: BLUE, ink: ink({ color: BLUE, size: 22 }) };
      const box = inkBox({ ...inked, ...fx }, '');
      const bare = inkBox(inked, '');
      const letters = inkBox({ color: BLUE, ...fx }, 'INK');
      expect(boxInJob(box), name).toBe(true);
      const ref = finished(box, canvasInk);
      const ours = finished(box, whole);
      const [a, b] = laid(ours, ref, SCALE);
      const d = against(a, b);
      // Did the canvas path paint any of the effect? Its ink box with the
      // effect against the same box without it.
      const [r1, r0] = laid(ref, finished(bare, canvasInk), SCALE);
      const canvasFx = against(r1, r0);
      const file = `fx-${fileOf(name)}.png`;
      write(file, sheet(`${name} on ink  (engine against canvas: ${f(d)})`, [
        { label: canvasFx.worst === 0 ? 'canvas (before: ink, no effect)' : 'canvas (before: its own ink effect)', img: b },
        { label: 'engine: ink with the effect', img: a },
        { label: 'engine: letters with the effect', img: imageOf(finished(letters, whole)) },
      ]));
      const note = canvasFx.worst === 0 ? 'canvas painted none of the effect' : `canvas changed with the effect: ${f(canvasFx)}`;
      rows.push(`| ${file} | ${name} | canvas / engine ink / engine letters | ${d.worst.toFixed(1)} | ${d.mean.toFixed(3)} | ${d.ink.toFixed(4)} | ${note} |`);
    }

    // The contact sheet: every sheet at a third, four a row.
    const CELL = 520;
    const cols = 4;
    const cells = sheets.map(([, c]) => ({ c, k: Math.min(1, CELL / c.width) }));
    const rowH = [];
    for (let i = 0; i < cells.length; i += cols) rowH.push(Math.max(...cells.slice(i, i + cols).map(({ c, k }) => c.height * k)));
    const contact = createCanvas(cols * (CELL + PAD) + PAD, rowH.reduce((s, h) => s + h + PAD, PAD));
    const ctx = contact.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, contact.width, contact.height);
    let y = PAD;
    cells.forEach(({ c, k }, i) => {
      if (i && i % cols === 0) y += rowH[i / cols - 1] + PAD;
      ctx.drawImage(c, PAD + (i % cols) * (CELL + PAD), y, c.width * k, c.height * k);
    });
    writeFileSync(resolve(dir, 'contact-sheet.png'), contact.toBuffer('image/png'));

    const md = [
      '# Ink pairs: canvas against engine',
      '',
      `Scale ${SCALE}. Worst and mean: the most one pixel differs and the mean difference, of 255, of any channel premultiplied, over the pixels either picture inked (\`against\`, src/test/ink-fixtures.js). Ink: the engine's total alpha over the canvas's.`,
      '',
      'Ink cases: the box with letters (INK) and one wavy stroke. Effect cases: the ink box alone (no letters); the numbers are the engine with the effect against the canvas, so where the canvas painted none of the effect (the Note says) they are mostly the effect itself.',
      '',
      '| File | Case | Panels | Worst | Mean | Ink | Note |',
      '|---|---|---|---|---|---|---|',
      ...rows,
      '',
      '`contact-sheet.png`: every sheet, small.',
      '',
    ].join('\n');
    writeFileSync(resolve(dir, 'pairs.md'), md);
  });
});
