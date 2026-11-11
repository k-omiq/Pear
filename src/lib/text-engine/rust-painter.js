// The Rust text engine behind the glyph-painter seam.
//
//   const rust = await createRustTextEngine(wasm)
//   setTextEngine(rust)
//   setGlyphPainter(createRustGlyphPainter(rust))
//
// The engine turns a job into pixels (text-engine/js/paint.mjs); this file's
// whole work is to hand it what only the page has - the canvas's transform and
// the pattern tiles - and to put the pixels it gives back onto the canvas.
import { drawsPatternTiles, drawsScreens, encodeBox, releaseWire, forgetInkTips, hasInkTip, paintBox as paintBoxJob, paintJob, paintsBoxes, paintsInk, patternTile, putInkTip } from '../../../text-engine/js/paint.mjs';
import { canvasPatternKind, patternTileCanvas, patternTilePx, tipCoverage, TILE_SS } from '../text-paint.js';
import { pickedTile } from '../pattern-tiles.svelte.js';

// A synthesised bold is drawn the way it is measured (text-engine/RULES.md):
// WebKit's wider advance belongs to WebKit's second glyph a step to the right,
// and an unchanged advance to a glyph grown on every side. The engine's
// `boldAdvance` rule decides both, in the engine: its ink box is measured for
// the drawing its painter makes, so nothing is chosen here.

// The longest side of a raster the engine will paint: `MAX_SIDE` in
// text-engine/src/paint/mod.rs. A job whose ink is wider or taller than this
// in device pixels is refused (`paintJob` throws), and the engine does not say
// the number over the wire, so it is stated here, once, for the page - the
// painter carries it as `maxSide` and whoever sizes a canvas for it asks the
// painter. rust-painter-limit.test.js reads the Rust source and holds the two
// together.
export const MAX_RASTER_SIDE = 16384;

// Which put of an engine's tips a library wrapper's pixels went in with
// (`tip.rust`): one token per engine, new each time its tips are let go. A
// wrapper of a brush loaded again (an import over it, a chapter reopened) is
// a new wrapper, unmarked, and is put again over the old key.
const tipEpochs = new WeakMap();
const tipEpoch = (rust) => {
  let e = tipEpochs.get(rust);
  if (!e) {
    e = {};
    tipEpochs.set(rust, e);
  }
  return e;
};

/**
 * @param {object} rust the engine `createRustTextEngine` made; it holds the faces a job names
 * @param {{ boldDraw?: 'outset' | 'smear', weight?: number }} [options]
 *   `boldDraw` names a drawing outright, against the rule above, for looking at the other one.
 *   `weight` grows every filled glyph shape by that many device pixels on every side before it
 *   is painted (bands stay strokes of the font's own outline); 0, the default, paints the
 *   font's outline.
 */
export function createRustGlyphPainter(rust, options = {}) {
  // A tile is the engine's own drawing, at the size `patternTileCanvas` gives
  // one: `TILE_SS` pixels to a page px, and a hairline a page px wide or more.
  // A wasm built before the engine drew them has the canvas draw it.
  const ownTiles = drawsPatternTiles(rust.low);
  const tilePixels = (style) => {
    if (ownTiles) {
      const tile = patternTilePx(style);
      const pattern = { ...style?.pattern, kind: canvasPatternKind(style?.pattern?.kind) };
      return patternTile(rust.low, pattern, Math.max(2, Math.round(tile * TILE_SS)), Math.max(1, tile * 0.12) / tile);
    }
    const cnv = patternTileCanvas(style, TILE_SS);
    return cnv ? cnv.getContext('2d').getImageData(0, 0, cnv.width, cnv.height) : null;
  };

  // One tile's pixels per pattern, so a job that fills every line with the
  // same pattern sends it once and the next job does not draw it again.
  const tiles = new Map();
  const tile = (fill) => {
    // A picked tile of a procedural fill: the page's own pixels, read from the
    // chapter's patterns/ folder once and held decoded (`pickedTile`).
    if (fill.kind === 'screen') return pickedTile(fill.pattern?.src);
    const key = `${patternTilePx(fill.style)}|${JSON.stringify(fill.style?.pattern ?? null)}`;
    if (tiles.has(key)) return tiles.get(key);
    const pixels = tilePixels(fill.style);
    if (tiles.size >= 64) tiles.clear();
    tiles.set(key, pixels);
    return pixels;
  };

  // A job as the engine is asked for it: the face it names, resolved, and
  // what only this painter knows.
  // `corner` is where the canvas's own corner is on the surface the
  // transform paints, device px: a Crisp job's page pixel grid is counted
  // from it (the canvas is a box's picture, set on whole page pixels).
  function request(job, transform, corner = [0, 0]) {
    const face = rust.handle(job.face);
    return {
      job: job.crisp ? { ...job, crisp: { x: corner[0], y: corner[1] } } : job,
      font: face.font,
      size: face.size,
      synth: face.flags,
      boldDraw: options.boldDraw ?? 'rule',
      weight: options.weight ?? 0,
      transform,
      tiles: tile,
      // Copied out (`blit`) before anything else calls the engine.
      view: true,
    };
  }

  // Both paints hand back where their pixels landed, in the canvas's device
  // pixels: the engine's raster is cut to what the job inks (strokes, shadows
  // and the smear included), so this is the ink's rectangle, and a caller that
  // wants the picture cut to its ink (the SFX panel's previews) reads it here
  // instead of scanning the pixels back. Null when the job drew nothing.
  function paint(ctx, job) {
    if (capture) {
      capture.spoiled = true;
      return null;
    }
    const m = ctx.getTransform();
    const raster = paintJob(rust.low, request(job, [m.a, m.b, m.c, m.d, m.e, m.f]));
    if (!raster) return null;
    blit(ctx, raster, raster.x, raster.y);
    return { x: raster.x, y: raster.y, w: raster.width, h: raster.height };
  }

  // A finished box in one job: its glyphs, and the shadows, the blur, the
  // smear and the mask the canvas used to lay over and under them
  // (`boxInJob`, exporter.js). `spec.rect` is the box's footprint in the
  // job's own coordinates; every pixel the box can ink is inside it, and it
  // is the surface the engine paints, wherever the canvas's transform puts
  // it - scaled, turned or mirrored. Nothing is resampled on the way: the
  // letters, the shadow's throw and the mask are all stated in the job's
  // units and carried by the transform, and the pixels land one to one.
  // The ink's tips into the engine before the job that names them: each
  // wrapper's coverage read once (`tipCoverage`) and put, and asked after
  // again for every job, which names it for that job, so the engine keeps it
  // until the job is painted and puts it back if it let go of it since. A tip
  // the engine refuses is not marked: its strokes paint round.
  function sendTips(ink) {
    const epoch = tipEpoch(rust);
    (ink?.keys ?? []).forEach((key, i) => {
      const tip = ink.tips?.[i];
      if (!tip) return;
      if (tip.rust === epoch && hasInkTip(rust.low, key)) return;
      const cov = tipCoverage(tip);
      if (cov && putInkTip(rust.low, key, cov)) tip.rust = epoch;
    });
  }

  // The surface a box job paints, in the canvas's device pixels: the corners
  // of `spec.rect` carried by the canvas's matrix, cut outwards to whole
  // pixels. Null when it covers no pixel.
  function surfaceOf(ctx, spec) {
    const m = ctx.getTransform();
    const r = spec.rect;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [px, py] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
      const dx = m.a * px + m.c * py + m.e;
      const dy = m.b * px + m.d * py + m.f;
      x0 = Math.min(x0, dx);
      y0 = Math.min(y0, dy);
      x1 = Math.max(x1, dx);
      y1 = Math.max(y1, dy);
    }
    // Whole pixels, outwards, less the dust a product of two scales leaves.
    const EPS = 1e-6;
    x0 = Math.floor(x0 + EPS);
    y0 = Math.floor(y0 + EPS);
    const width = Math.ceil(x1 - EPS) - x0;
    const height = Math.ceil(y1 - EPS) - y0;
    if (!(width > 0 && height > 0)) return null;
    return { m, x0, y0, width, height };
  }

  // The box job as the engine is asked for it, on the surface `surfaceOf` cut.
  function boxRequest(spec, { m, x0, y0, width, height }) {
    return {
      ...request(spec.job, [m.a, m.b, m.c, m.d, m.e - x0, m.f - y0], [-x0, -y0]),
      width,
      height,
      grain: grainOrigin(spec.toPage, m, x0, y0),
      // The page under the box, for a gradient with Align with Layer off:
      // the layout onto it and its size (`paintBoxJob`'s `sheet`). The
      // engine carries it onto this surface with the job's own matrix.
      page: spec.page ?? null,
      shadows: spec.shadows,
      blur: spec.blur,
      taps: spec.taps,
      clip: spec.clip,
      fade: spec.fade ?? null,
      pinShift: spec.pinShift ?? null,
      blend: spec.blend,
      fillOpacity: spec.fillOpacity,
      blendInterior: spec.blendInterior === true,
      transparencyShapes: spec.transparencyShapes !== false,
      channels: spec.channels ?? null,
      blendIf: spec.blendIf ?? null,
      effects: spec.effects ?? [],
      // The box's brush ink (`inkSpec`, exporter.js), painted with the
      // letters, and the keys of the tips it stamps with, sent above.
      ink: spec.ink ? { ox: spec.ink.ox, oy: spec.ink.oy, strokes: spec.ink.strokes, keys: spec.ink.keys, refs: spec.ink.refs } : null,
      // The page under the surface: given, or asked for now the surface is
      // known (`backdrop.js`), with the matrix that carries the job onto it.
      // Null paints without the page.
      backdrop:
        typeof spec.backdrop === 'function'
          ? spec.backdrop({ x0, y0, width, height, m: [m.a, m.b, m.c, m.d, m.e, m.f] })
          : (spec.backdrop ?? null),
    };
  }

  function paintBox(ctx, spec) {
    const at = surfaceOf(ctx, spec);
    if (!at) return null;
    // Captured for the paint worker (`capture`): the job encoded exactly as
    // below, and not painted. A box with brush ink is not (its tips are the
    // main instance's): the capture is spoiled and the caller paints here.
    if (capture) {
      if (spec.ink) {
        capture.spoiled = true;
        return null;
      }
      const bytes = encodeBox(boxRequest(spec, at)).slice();
      // The copy is the job's now: a buffer a backdrop grew goes, as the
      // synchronous paint lets it go.
      releaseWire();
      capture.jobs.push({ ctx, bytes, x0: at.x0, y0: at.y0 });
      return undefined;
    }
    if (spec.ink) sendTips(spec.ink);
    const raster = paintBoxJob(rust.low, boxRequest(spec, at));
    if (!raster) return null;
    blit(ctx, raster, at.x0 + raster.x, at.y0 + raster.y);
    return { x: at.x0 + raster.x, y: at.y0 + raster.y, w: raster.width, h: raster.height };
  }

  // THE PAINT WORKER (paint-worker.js, editor/box-picture.js). While `fn`
  // runs, a box job is encoded and kept rather than painted, and any other
  // paint spoils the capture (a caption, a canvas pass): what `fn` made is
  // then the caller's to throw away, and it paints the box here instead.
  // Returns `{ value, jobs, spoiled }`, `value` what `fn` returned.
  let capture = null;
  function capturePaints(fn) {
    const was = capture;
    const cap = { jobs: [], spoiled: false };
    capture = cap;
    try {
      return { value: fn(), jobs: cap.jobs, spoiled: cap.spoiled };
    } finally {
      capture = was;
    }
  }
  // A captured job's pixels, painted elsewhere, onto the canvas it was
  // captured from: the same blit, at the same place, as `paintBox` makes.
  function finishCaptured(job, raster) {
    if (!raster) return null;
    blit(job.ctx, raster, job.x0 + raster.x, job.y0 + raster.y);
    return { x: job.x0 + raster.x, y: job.y0 + raster.y, w: raster.width, h: raster.height };
  }

  // Where the surface's corner (x0, y0), canvas device px, is on the page, in
  // device px of the page (its page px times the canvas's device px to one):
  // the engine hashes each grain from a surface pixel plus it (box wire v15).
  // `A` is the layout onto the page (`boxToPage`), `m` the canvas matrix from
  // the layout. Rounded to whole pixels: a surface cut a whole pixel wider
  // moves its corner a whole pixel, and its grain stays on the page. With no
  // page matrix the canvas's own corner is the anchor.
  function grainOrigin(A, m, x0, y0) {
    const det = m.a * m.d - m.b * m.c;
    const detA = Array.isArray(A) ? A[0] * A[3] - A[1] * A[2] : 0;
    if (!det || !detA || !Number.isFinite(det) || !Number.isFinite(detA)) return [x0, y0];
    // The corner in the layout's units, then on the page.
    const ux = x0 - m.e;
    const uy = y0 - m.f;
    const jx = (m.d * ux - m.c * uy) / det;
    const jy = (-m.b * ux + m.a * uy) / det;
    const px = A[0] * jx + A[2] * jy + A[4];
    const py = A[1] * jx + A[3] * jy + A[5];
    const k = Math.sqrt(Math.abs(det / detA));
    // A hair over the half rounds up whichever way the float error falls.
    return [Math.round(px * k + 1e-9), Math.round(py * k + 1e-9)];
  }

  // The engine's pixels onto the canvas at device pixel (x, y).
  //
  // Through a canvas of the raster's own, made here and given back once it
  // has been drawn: never one kept from paint to paint. The system WebKit
  // (the app's window on macOS) carries a canvas's drawing over to its GPU
  // process later than it carries a `putImageData`, so a `drawImage` from a
  // kept canvas can be played after the next raster has been put into it:
  // the box drawn first then shows the next one's letters inside its own
  // outline. That is what an export did to every box painted straight onto
  // the page (a turned one), and a canvas the box next on the page was laid
  // through afterwards. A canvas given a new size is a new backing store, and
  // a draw already made from the old one keeps the old one's pixels: giving
  // this canvas back after the draw is safe, writing into it again is not.
  function blit(ctx, raster, x, y) {
    const { width, height } = raster;
    const cnv = document.createElement('canvas');
    cnv.width = width;
    cnv.height = height;
    const cctx = cnv.getContext('2d');
    const image = cctx.createImageData(width, height);
    image.data.set(raster.data);
    cctx.putImageData(image, 0, 0);
    // The raster is already in device pixels: drawn through the identity it
    // lands pixel for pixel, and the canvas's own alpha, blending and clip
    // still apply to it as they would to drawn text.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Pixel for pixel means unfiltered. The exporter's canvases ask for
    // `imageSmoothingQuality = 'high'`, and Skia then resamples even a
    // one-to-one copy with a cubic that reaches one pixel to each side, and
    // every edge is softened.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cnv, 0, 0, width, height, x, y, width, height);
    ctx.restore();
    cnv.width = 0;
    cnv.height = 0;
  }

  // `engine` says whose ink this painter paints (`engineDraws`, index.js).
  // `mesh` says a job's mesh is bent by this painter, in the outlines
  // (`meshInJob`, exporter.js): the canvas painter has no such thing.
  // `roughen` says the same of a job's roughening (`roughenInJob`), and
  // `wobble` of a job's wobble (`wobbleInJob`).
  // `box` says this painter paints a whole box in one job (`boxInJob`), which
  // it does when the wasm it was handed has that call.
  // `screen` says a pattern is painted per pixel from its kind and controls
  // (`screenInJob`), which this wasm does when it has the call.
  // `ink` says a box's brush ink, round dabs and imported tips, is painted in
  // its box job (`boxInJob`), as letters are: a wasm of box wire v12 with
  // the tip cache. `forgetTips` lets go of the engine's tips
  // (`forgetPainterTips`, index.js), when the library closes its own.
  const box = paintsBoxes(rust.low);
  const screen = drawsScreens(rust.low);
  const ink = box && paintsInk(rust.low);
  const forgetTips = () => {
    forgetInkTips(rust.low);
    tipEpochs.delete(rust);
  };
  // `worker` is the engine's paint worker (paint-mirror.js) or null; `capture`
  // and `finishCaptured` are how a box job goes to it and comes back.
  return {
    id: 'rust', paint, paintBox: box ? paintBox : undefined, maxSide: MAX_RASTER_SIDE, engine: rust, mesh: true, roughen: true, wobble: true, box, screen, ink, forgetTips,
    worker: box ? (rust.paintMirror ?? null) : null,
    capture: capturePaints,
    finishCaptured,
  };
}
