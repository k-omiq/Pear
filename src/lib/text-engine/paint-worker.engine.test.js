import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, Image } from '@napi-rs/canvas';
import { engineWasm, fixtureFont, FIXTURE_FACES } from '../../test/rust-engine.js';
import { createRustTextEngine } from './rust.js';
import { createRustGlyphPainter } from './rust-painter.js';
import { createPaintHandler } from './paint-worker.js';
import { createPaintMirror } from './paint-mirror.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './index.js';
import { paintBoxPicture, requestBoxPicture, PICTURE_MAX_PX } from '../editor/box-picture.js';
import { boxInJob } from '../exporter.js';
import { forgetBackdrops } from '../backdrop.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from '../measure.js';
import { defaultStyle, normalizeInnerShadow, normalizeOverlay, normalizeStyle } from '../data.js';

// ===========================================================================
// The paint worker paints what the main thread paints
// ===========================================================================
// The worker's instance is a second engine kept in step by the mirror
// (paint-mirror.js): every call that changes the main instance is replayed
// into it, and each id is checked. Here the worker's handler runs in-process
// (`createPaintHandler`, the same function the worker queues its messages
// through), and a box is painted both ways: synchronously on the main
// instance (`paintBoxPicture`) and through the worker (`requestBoxPicture`).
// The two canvases must be the same, pixel for pixel, and placed the same.

// The worker's side of the line, in-process: messages handled one at a time,
// in order, replies delivered as the worker's would be.
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
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let main;
let painter;
let handler;
let transport;
let mirror;

async function mirrored() {
  const module = await WebAssembly.compile(engineWasm());
  const h = createPaintHandler();
  const t = inProcess(h);
  const m = createPaintMirror(t, { warn: () => {} });
  t.send({ op: 'init', module });
  const engine = await createRustTextEngine(module, { mirror: m });
  for (const [family, slot, file] of FIXTURE_FACES) engine.addFace(family, slot, fixtureFont(file));
  return { engine, handler: h, transport: t, mirror: m };
}

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  ({ engine: main, handler, transport, mirror } = await mirrored());
  setTextEngine(main);
  painter = createRustGlyphPainter(main);
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
  setGlyphPainter(painter);
  forgetBackdrops();
});

const W = 600;
const H = 400;
const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 56, color: '#cc2200', autoHeight: false, ...over });
const boxOf = (over = {}, text = 'WORKER\nPAINT') => ({ id: 'w', lineN: null, text, x: 120, y: 110, w: 300, h: 150, style: style(over) });
const pageOf = (box) => ({ id: 1, w: W, h: H, lines: [], boxes: [box] });

function art() {
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#2050c0');
  g.addColorStop(1, '#f0d040');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  return c;
}

const pixels = (el) => el.getContext('2d').getImageData(0, 0, el.width, el.height).data;

// The box painted both ways at `scale`, compared.
async function both(box, { scale = 2, under = null, corner = null } = {}) {
  const p = pageOf(box);
  expect(boxInJob(box)).toBe(true);
  const sync = createCanvas(1, 1);
  const g = paintBoxPicture(sync, box, p, scale, null, PICTURE_MAX_PX, 1, corner, under);
  forgetBackdrops();
  const req = requestBoxPicture(box, p, scale, null, PICTURE_MAX_PX, 1, corner, under);
  expect(req, 'the box goes to the worker').not.toBeNull();
  const res = await req.promise;
  expect(res.dead).toBeUndefined();
  const off = createCanvas(1, 1);
  const h = req.apply(off, res);
  expect(h).toEqual(g);
  expect([off.width, off.height]).toEqual([sync.width, sync.height]);
  const a = pixels(sync);
  const b = pixels(off);
  let inked = 0;
  for (let i = 3; i < a.length; i += 4) if (a[i]) inked++;
  expect(inked, 'the picture has ink').toBeGreaterThan(100);
  expect(Buffer.from(b).equals(Buffer.from(a)), 'the same pixels').toBe(true);
  expect(mirror.alive()).toBe(true);
  return { g, inked };
}

describe('a box painted in the paint worker', () => {
  it('is the painter the engine was made with', () => {
    expect(painter.worker).toBe(mirror);
  });

  it('a plain box: the same pixels in the same place', async () => {
    await both(boxOf());
  });

  it('at a scale that is not whole, set on the pixel grid (a phase)', async () => {
    await both(boxOf(), { scale: 1.37, corner: { x: 211.3, y: 97.6 } });
  });

  it('a box with a stack of layer effects', async () => {
    const d = defaultStyle();
    await both(
      boxOf({
        strokes: [{ color: '#ffffff', width: 6 }, { color: '#111111', width: 3 }],
        shadows: [{ x: 6, y: 5, blur: 4, color: '#1d4ed8', opacity: 0.8 }],
        outerGlow: { ...d.outerGlow, on: true, size: 10 },
        innerGlow: { ...d.innerGlow, on: true, size: 6 },
        innerShadows: [normalizeInnerShadow({ on: true, size: 5 })],
        colorOverlays: [normalizeOverlay({ on: true, color: '#00aa44', opacity: 0.4 })],
        satin: { ...d.satin, on: true },
        bevel: { ...d.bevel, on: true },
        blur: 0.6,
      }),
    );
  });

  it('a box that blends with the page under it', async () => {
    const image = art();
    const under = { image, W, H, src: 'art', key: {} };
    await both(boxOf({ blendMode: 'multiply' }), { under });
  });

  it('after a font is taken out and others take its id', async () => {
    const was = main.handle({ key: 'k', name: 'Bangers', bold: false, italic: false, size: 56 }).font;
    main.removeFamily('Bangers');
    // The freed id goes to the next font in: another family's.
    main.addFace('Reused', 'regular', fixtureFont('DejaVuSans.ttf'));
    expect(main.handle({ key: 'r', name: 'Reused', bold: false, italic: false, size: 56 }).font).toBe(was);
    main.addFace('Bangers', 'regular', fixtureFont('Bangers-Regular.ttf'));
    main.setFallbacks(['DejaVu Sans']);
    clearLayoutMemo();
    await both(boxOf({}, 'BACK ★ AGAIN'));
    await both(boxOf({ font: 'Reused' }, 'Reused ★'));
    await transport.idle();
    expect(handler.dead()).toBeNull();
  });
});

describe('the mirror going wrong', () => {
  it('a different id ends the worker for the session, and boxes go back to the main thread', async () => {
    const m = await mirrored();
    const warn = vi.fn();
    // A call the worker's instance answers otherwise: the worker stops.
    const own = createPaintMirror(m.transport, { warn });
    m.transport.send({ op: 'removeFont', font: 999, expect: { v: true } });
    await m.transport.idle();
    expect(m.handler.dead()).toMatch(/removeFont/);
    expect(own.alive()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    // A paint asked for after it is answered `dead`.
    expect(await own.paint(new Uint8Array(8))).toEqual({ dead: true });
    // And the editor's request says "paint it here".
    setTextEngine(m.engine);
    setGlyphPainter({ ...createRustGlyphPainter(m.engine), worker: own });
    try {
      expect(requestBoxPicture(boxOf(), pageOf(boxOf()), 2, null)).toBeNull();
    } finally {
      setTextEngine(main);
      setGlyphPainter(painter);
    }
  });

  it('no Worker here: the engine switch starts none', async () => {
    const { startPaintMirror } = await import('./paint-mirror.js');
    expect(typeof Worker).toBe('undefined');
    expect(startPaintMirror(await WebAssembly.compile(engineWasm()))).toBeNull();
  });
});
