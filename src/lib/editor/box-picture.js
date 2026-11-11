// ===== A box in the editor, as the engine's own picture of it =====
//
// With the Rust engine drawing (engine-switch.svelte.js) a box that is not
// being typed into is shown as ONE canvas, painted by `renderBoxTexture` - the
// function the export, the PSD's rasters and the warped box have always
// called. What is on screen is then the file's picture by construction: one
// painter and two destinations, which is the design `paintWarpedBox` set out
// for a warped box and this makes the rule for every box.
//
// PAINTED ONCE, SHOWN AT ANY ZOOM. The picture is painted at one fixed
// resolution, the export's own (`PICTURE_SCALE`: the 2 the export paints at
// and scales down), and never at the zoom. A zoom does not repaint a box: the
// painted picture is KEPT (TextBox.svelte's `warpPic`) and only shown again at
// the new size (`presentPicture`), a resample of a finished bitmap that costs
// about a millisecond where a repaint of a box with layer effects costs
// hundreds. This is how a paint program treats its layers: the pixels are
// made at the document's resolution once, and the view scales them.
//
// The cost is above the picture's own resolution: past 100% on a 2x display
// (past 200% on a 1x one) the picture is stretched and the letters go soft,
// as a raster layer does in any paint program. The file is no sharper there.
//
// The canvas on screen, the kept picture, their keys and their release are
// TextBox.svelte's; this file is the arithmetic and the paints, kept out of
// the component so they can be tested without one.
import { boxInJob, renderBoxTexture, warpTexture } from '../exporter.js';
import { glyphPainter } from '../text-engine/index.js';
import { paintWorkerAllowed } from '../text-engine/paint-mirror.js';
import { inkActive, pageGradients, usesBackdrop } from '../text-paint.js';
import { paintKey } from '../box-paint.js';
import { runsKey } from '../runs.js';

// The most pixels one box's canvas holds: 8 megapixels, 32 MB of RGBA.
//
// It is about one 4K screen (3840 x 2160 is 8.3 MP). A box whose footprint is
// larger than that in device pixels cannot be on screen whole at full
// resolution on nearly any display, so lowering ITS scale costs sharpness only
// on a box that is already bigger than the screen - a full-page sound effect
// at 400% - and costs every ordinary box nothing: a 300 x 200 balloon is under
// 4 MP at 400% on a 2x display. It is also far inside the AREA a canvas may
// have (64 MP: warp-paint.js) and the engine will paint (67 MP).
//
// It says nothing about a SIDE. A box 7000 page px long and 100 high is under
// the budget at 300% and 21,000 px wide, and the engine paints no raster with
// a side over its own limit - it throws. That limit is the painter's to state
// (`maxSide`, text-engine/index.js) and is asked of it where the texture is
// made, below, beside this budget.
export const PICTURE_MAX_PX = 8 * 1024 * 1024;

/**
 * A box's texture as the editor paints it: at `scale`, within the pixel budget
 * and within the longest side the installed painter will paint. Every picture
 * the editor shows is made here, so the two limits are applied in one place.
 */
//
// `flat` asks for the box unbent whatever the painter can do with its mesh
// (`renderBoxTexture`): the gizmo's drag, which holds one texture and re-runs
// the mesh over it every frame.
//
// The texture says where its ink is (`ink`, canvas px, or null when the
// painter could not say): the SFX panel's previews cut to it from there.
//
// `under` is the page art the box is shown over, for a box that blends with
// the page (`backdrop.js`, `usesBackdrop`), or null.
//
// `sheet` is the page the box sits on, `{ w, h }` (`pageSheet`), for a
// gradient with Align with Layer off; null paints it as Align on (an SFX card,
// a page not measured yet).
export function pictureTexture(box, p, tips, scale, maxPx = PICTURE_MAX_PX, flat = false, under = null, sheet = null) {
  // The editor's smear is the coarse one (`paintBoxJob`): this picture is
  // painted again at every edit.
  return renderBoxTexture(box, p, tips, scale, maxPx, glyphPainter().maxSide ?? Infinity, flat, true, under, sheet);
}

// A turned box is painted finer than the screen. Its turn is CSS's, so the
// compositor resamples the picture whatever it is painted at, and a picture
// with one texel to the device pixel comes out of that soft. Measured in
// Chromium on 22px type turned 7 degrees, at 100% on a 1x display: 67% of its
// inked pixels were neither paper nor ink, against 49% for the DOM text and
// for the export. With two texels to the pixel each way the resample is an
// average of four, which is what an antialiased edge is, and the figure is
// 43%. Four times the pixels, for turned boxes only, inside the same budget.
// Quarter turns are left alone: they land texel on pixel.
export const TURNED_OVERSAMPLE = 2;

// Texture px per page px every box picture is painted at: the export's
// supersample (`renderBox` paints at 2), so the editor's picture and the
// file's are made from the same pixels, and the picture is one texel to the
// device pixel at 100% on a 2x display.
export const PICTURE_SCALE = 2;

/** Texture px per page px a box is painted at when nothing caps it: the same at every zoom. */
export function pictureScale(rotation = 0) {
  return PICTURE_SCALE * (rotation % 90 ? TURNED_OVERSAMPLE : 1);
}

// The most pixels a box's picture holds while a handle is resizing the box:
// one megapixel.
//
// A resize changes what the picture is drawn from on every frame of the drag,
// so every frame repaints it, and the paint's time follows its pixels.
// Measured in Chromium on a loaded machine, a frame of the drag to the end of
// its effects: 2 ms for a tenth of a megapixel, 6 to 15 ms for one, 25 ms for
// 2.4, 72 to 87 ms for the 8.4 a box at the budget above holds. A megapixel
// is what fits a frame for type with an outline and a shadow. An ordinary
// balloon is under it at 100% on any display and at 300% on a 1x one, and is
// as sharp in the hand as at rest; a page-wide sound effect is soft while it
// is dragged and is painted in full once, when the handle is let go.
//
// It is a budget like the one above and is applied where that one is: handed
// to the paint in its place (`paintBoxPicture`'s `maxPx`), so it is counted
// on the FOOTPRINT that is painted and not on the box's frame - a small box
// whose lines run far below it is megapixels of picture round a frame of
// none.
//
// It bounds the part of a frame that follows the pixels and no more. A box
// with three bands of outline cost 42 ms a frame at 1.2 megapixels in the same
// measurement, and 10 ms at a tenth of one: that is the bands' own work, and
// this budget does not bring it inside a frame.
export const PICTURE_DRAG_PX = 1024 * 1024;

// THE DRAG BUDGET BY THE CLOCK. The megapixel above fits a frame for type
// with an outline and a shadow, and for nothing heavier: each layer effect (a
// glow, a bevel, satin, an overlay, a Photoshop stroke) is one more pass or
// several over the same surface, and a box with nine of them was measured at
// 64 ms for a QUARTER of a megapixel - 270 ms a megapixel, against 6 to 15.
// No count of effects says what a paint costs (it depends on their sizes, the
// machine, the build), but the last paint of the same box does. So a live
// paint is given the pixels that fit `PICTURE_FRAME_MS` at what the last one
// cost per pixel (`msPerPx`), never more than the megapixel, and never fewer
// than a quarter of the picture's CSS pixels (`cssPx`: one texture pixel to
// two CSS px a side, soft but plainly the same picture) or the floor below.
// A paint that was never timed, or cost nothing, has the megapixel as before.
//
// It settles by itself: a paint has a fixed part and a part per pixel, so a
// smaller paint costs a little more per pixel than a larger one, the next
// budget comes out a little lower, and the series closes on the size whose
// paint takes the frame.
export const PICTURE_FRAME_MS = 20;
export const PICTURE_DRAG_FLOOR_PX = 48 * 1024;
export function pictureDragPx(msPerPx, cssPx = 0) {
  if (!(msPerPx > 0)) return PICTURE_DRAG_PX;
  const floor = Math.max(PICTURE_DRAG_FLOOR_PX, cssPx / 4);
  return Math.round(Math.min(PICTURE_DRAG_PX, Math.max(floor, PICTURE_FRAME_MS / msPerPx)));
}

// The finished bitmap as the picture the box keeps, and its footprint.
//
// A mesh can carry a texture well past the footprint it was budgeted for
// (warp-paint.js allows 64 MP), and the kept picture is held where the
// texture is not - so a warped result over the budget is scaled down into a
// canvas of its own. Nothing else comes in over: `renderBoxTexture` was handed
// the same budget, and the row or column its rounding adds is the slack
// allowed here. `release` hands the warped-from bitmap back when it is not the
// one kept.
function keep(r, maxPx, release) {
  let w = r.canvas.width;
  let h = r.canvas.height;
  const over = (w * h) / maxPx;
  if (!(over > 1.02)) return { canvas: r.canvas, ox: r.ox, oy: r.oy, cw: r.cw, ch: r.ch, k: 1 };
  const k = 1 / Math.sqrt(over);
  w = Math.max(1, Math.round(w * k));
  h = Math.max(1, Math.round(h * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(r.canvas, 0, 0, w, h);
  if (release) {
    r.canvas.width = 0;
    r.canvas.height = 0;
  }
  return { canvas, ox: r.ox, oy: r.oy, cw: r.cw, ch: r.ch, k };
}

/**
 * Paints `box` at `scale` texture px per page px (less for a box over the
 * budget `maxPx`), mesh included, and returns the picture to keep:
 * `{ canvas, ox, oy, cw, ch, ss }` - the bitmap, `ox`/`oy` page px left of
 * and above the box's own top-left, the `cw` x `ch` page px it spans, and
 * `ss`, the texture px per page px it was really painted at: `scale` itself
 * where no budget and no limit lowered it, and less where one did. The canvas
 * is the caller's to show (`presentPicture`) and to let go.
 *
 * `under` is the page art for a box that blends with the page
 * (`pictureTexture`).
 */
export function paintBoxPicture(box, p, scale, tips, maxPx = PICTURE_MAX_PX, under = null, sheet = null) {
  return keepTexture(pictureTexture(box, p, tips, scale, maxPx, false, under, sheet), box, maxPx);
}

// A finished texture of `box` as the picture to keep: the second half of
// `paintBoxPicture`, shared with the worker's paint (`requestBoxPicture`).
function keepTexture(tex, box, maxPx) {
  const { k, ...pic } = keep(warpTexture(tex, box), maxPx, true);
  return { ...pic, ss: tex.ss * k };
}

/**
 * Whether `box` is one the paint worker may paint (`requestBoxPicture` may
 * still say no, for what only the layout shows: a caption).
 */
export function pictureWorkerReady(box) {
  const painter = glyphPainter();
  if (!paintWorkerAllowed() || !painter?.worker?.alive?.() || typeof painter.capture !== 'function') return false;
  return boxInJob(box) && !inkActive(box.style?.ink);
}

// HOW MANY BOXES ARE WITH THE WORKER AT ONCE. A request holds its box's
// texture canvas and its job's bytes (with the page under it, up to 64 MB)
// from the moment it is made until its answer is shown, and the one worker
// paints them one after another: thirty boxes on screen after a zoom settles
// would be thirty of each held at once. So at most `PICTURE_SLOTS` requests
// are made at a time, across every box; a box past them waits as an intent
// (`schedulePicture`: what to call, no canvas, no bytes) in a queue, first
// come first served, and makes its request when a slot frees.
export const PICTURE_SLOTS = 2;
let slotsBusy = 0;
// owner -> nothing: the boxes that hold a slot (one each at most).
const slotOwners = new Set();
// [{ owner, run }], in order.
const slotQueue = [];

/**
 * Runs `run()` for `owner` (a box) when a slot is free. `run` returns a
 * promise that settles when the slot's work is done (the answer shown or
 * let go), or null when it did not need the slot after all (the box went
 * elsewhere, or is no longer wanted). A box already waiting is replaced, in
 * its place: only its newest intent is ever run. A box holding a slot waits
 * for its own first.
 */
export function schedulePicture(owner, run) {
  const at = slotQueue.findIndex((e) => e.owner === owner);
  if (at >= 0) slotQueue[at] = { owner, run };
  else slotQueue.push({ owner, run });
  pumpPictures();
}

/** Takes `owner`'s waiting intent out of the queue, if it has one (the box destroyed, its picture no longer wanted). */
export function unschedulePicture(owner) {
  const at = slotQueue.findIndex((e) => e.owner === owner);
  if (at >= 0) slotQueue.splice(at, 1);
}

function pumpPictures() {
  while (slotsBusy < PICTURE_SLOTS) {
    const at = slotQueue.findIndex((e) => !slotOwners.has(e.owner));
    if (at < 0) return;
    const [{ owner, run }] = slotQueue.splice(at, 1);
    let done = null;
    try {
      done = run();
    } catch {
      done = null;
    }
    if (!done) continue;
    slotsBusy++;
    slotOwners.add(owner);
    // Every way out of a slot frees it and lets the next one in.
    Promise.resolve(done)
      .catch(() => {})
      .finally(() => {
        slotsBusy--;
        slotOwners.delete(owner);
        pumpPictures();
      });
  }
}

/** For tests: the slots in use and the intents waiting. */
export const _pictureSlots = () => ({ busy: slotsBusy, waiting: slotQueue.length });

/**
 * `paintBoxPicture` with the engine's paint in the paint worker
 * (text-engine/paint-worker.js), so the main thread does not wait for it.
 * Everything up to the paint is done here and now, exactly as the
 * synchronous paint does it - the layout, the surface, the page under the
 * box, the tiles, the job's bytes - and the bytes go to the worker.
 *
 * Returns null where the box is not for the worker, and the caller paints it
 * with `paintBoxPicture`: no worker (or the preference off, or it died), a box
 * the engine does not paint whole, one with brush ink (its tips are the main
 * instance's), or anything else the capture saw that was not the one box job
 * (a caption, a canvas pass). Otherwise `{ promise, prepMs, apply, cancel }`:
 *
 *   promise  resolves `{ raster, ms }` from the worker, `{ dead: true }`
 *            when it cannot paint (paint the box synchronously then), or
 *            `{ closed: true }` when it was stopped on purpose (let go);
 *            rejects where the engine refused the job.
 *   apply(result)  the pixels onto the texture through the painter's own
 *            blit, and the picture to keep: what `paintBoxPicture` returns.
 *   cancel() lets go of the texture, for a result nobody wants.
 *   prepMs   what the main thread spent on it, for the drag budget.
 */
export function requestBoxPicture(box, p, scale, tips, maxPx = PICTURE_MAX_PX, under = null, sheet = null) {
  if (!pictureWorkerReady(box)) return null;
  const painter = glyphPainter();
  const worker = painter.worker;
  const t0 = performance.now();
  let cap;
  try {
    cap = painter.capture(() => pictureTexture(box, p, tips, scale, maxPx, false, under, sheet));
  } catch {
    // The synchronous paint will meet the same, and says it as it always has.
    return null;
  }
  const tex = cap.value;
  const cancel = () => {
    tex.canvas.width = 0;
    tex.canvas.height = 0;
  };
  if (cap.spoiled || cap.jobs.length !== 1) {
    cancel();
    return null;
  }
  const job = cap.jobs[0];
  const prepMs = performance.now() - t0;
  return {
    promise: worker.paint(job.bytes),
    prepMs,
    apply(result) {
      let pic = null;
      try {
        painter.finishCaptured(job, result?.raster ?? null);
        pic = keepTexture(tex, box, maxPx);
        return pic;
      } finally {
        // Kept, or not: a texture that is not the kept picture is nobody's now.
        if (pic?.canvas !== tex.canvas) cancel();
      }
    },
    cancel,
  };
}

/**
 * The same from a texture the caller is holding on to: the mesh gizmo's drag,
 * which paints the box once when the pointer goes down and then only re-runs
 * the mesh. The texture is the gesture's: the picture comes back `borrowed`
 * when its canvas is that texture, and must not be let go by the one keeping
 * it.
 */
//
// `gpu` is the gesture's `meshWarper` over the texture (warp-paint.js), or
// null. Its frame is drawn within `maxPx` and onto the warper's own canvas,
// which comes back `borrowed` too: the next frame draws into it again.
export function paintPictureTexture(tex, box, maxPx = PICTURE_MAX_PX, gpu = null) {
  const r = warpTexture(tex, box, false, gpu, maxPx);
  const { k, ...pic } = keep(r, maxPx, r.canvas !== tex.canvas && !r.shared);
  return { ...pic, ss: (r.ss ?? tex.ss) * k, borrowed: pic.canvas === tex.canvas || (!!r.shared && pic.canvas === r.canvas) };
}

// THE KEPT PICTURE ON SCREEN. `presentPicture` draws the kept picture `pic`
// into the canvas `el` at the size the zoom shows it, and says how `el` is
// placed (`pictureCss`). It is a resample of a finished bitmap, never a paint:
// what a zoom costs.
//
// An upright, unmirrored box (`at`, its page position, with `page`, where the
// page's corner is on the screen) shown at or under the picture's own
// resolution gets a canvas of exactly the device pixels it covers, set on
// whole device pixels and drawn moved by the fraction of a pixel its corner
// falls inside one (`fx`, `fy`): one canvas pixel to one device pixel, the
// compositor resamples nothing, and the letters stay where they belong. At the
// picture's own resolution (100% on a 2x display) the corner is moved to the
// nearest device pixel instead - half a device pixel at most - and the bitmap
// is copied byte for byte. The canvas is padded to whole CSS px each way:
// WebKit paints a canvas into a rect rounded to whole CSS px, and one a
// fraction of a CSS px wide was stretched and landed off its device pixels.
//
// Anything else - a turned or mirrored box, whose CSS transform resamples the
// canvas whatever it holds, or a zoom past the picture's resolution - gets the
// picture at the scale it is shown at (a turned box `TURNED_OVERSAMPLE` times
// finer, so the turn's resample is an average), never finer than the picture
// itself, and is stretched over its footprint by CSS.
//
// A shrink by more than half is made in halves, each an exact average of four
// pixels: one bilinear step from far above samples the picture's pixels
// rather than averaging them, and thin strokes break up at a distant zoom.
export function presentPicture(el, pic, { z, dpr = 1, page = null, at = null, turned = false }) {
  const d = dpr > 0 ? dpr : 1;
  const dev = z * d;
  const aligned = !!(at && page && !turned) && dev <= pic.ss + 1e-9;
  const P = Math.min(pic.ss, dev * (turned ? TURNED_OVERSAMPLE : 1));
  const same = Math.abs(P - pic.ss) < 1e-9;
  let fx = 0;
  let fy = 0;
  let w;
  let h;
  if (aligned) {
    const X = (page.x + (at.x - pic.ox) * z) * d;
    const Y = (page.y + (at.y - pic.oy) * z) * d;
    fx = same ? 0 : X - Math.floor(X);
    fy = same ? 0 : Y - Math.floor(Y);
    const unit = Math.abs(d - Math.round(d)) < 1e-9 && d >= 1 ? Math.round(d) : 1;
    w = Math.ceil((fx + pic.cw * P - 1e-6) / unit) * unit;
    h = Math.ceil((fy + pic.ch * P - 1e-6) / unit) * unit;
    if (same) {
      w = Math.max(w, Math.ceil(pic.canvas.width / unit) * unit);
      h = Math.max(h, Math.ceil(pic.canvas.height / unit) * unit);
    }
  } else {
    w = same ? pic.canvas.width : Math.max(1, Math.round(pic.cw * P));
    h = same ? pic.canvas.height : Math.max(1, Math.round(pic.ch * P));
  }
  if (el.width !== w) el.width = w;
  if (el.height !== h) el.height = h;
  const ctx = el.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  if (same) {
    // One to one: the picture's own bytes, unfiltered.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pic.canvas, 0, 0);
  } else {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const src = halved(pic.canvas, P / pic.ss);
    ctx.drawImage(src, fx, fy, pic.cw * P, pic.ch * P);
    if (src !== pic.canvas) {
      src.width = 0;
      src.height = 0;
    }
  }
  return { ox: pic.ox, oy: pic.oy, cw: pic.cw, ch: pic.ch, ss: pic.ss, aligned, fx, fy, pw: w, ph: h, page };
}

// `src` halved while the shrink still to go is under one half: the last step
// is then a shrink of at most two. Each half is a new canvas, let go after
// the next is made; the source is the caller's and is not.
function halved(src, k) {
  let c = src;
  while (k < 0.5 && c.width > 1 && c.height > 1) {
    const n = document.createElement('canvas');
    n.width = Math.max(1, Math.round(c.width / 2));
    n.height = Math.max(1, Math.round(c.height / 2));
    const ctx = n.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, 0, 0, n.width, n.height);
    if (c !== src) {
      c.width = 0;
      c.height = 0;
    }
    c = n;
    k *= 2;
  }
  return c;
}

/**
 * The canvas's inline placement, in zoomed CSS px relative to the box's own
 * top-left (the clip wrapper's origin), from what `presentPicture` made.
 *
 * A device-aligned canvas (`g.aligned`) is `g.pw` x `g.ph` device px and set
 * on whole device pixels, its picture `g.fx`/`g.fy` device px in. `at` is the
 * box's page position NOW: a box moved since the canvas was made is still
 * set on whole device pixels, up to half of one from exact, until it is next
 * presented. `g.page` is where the page's corner was on the screen when it
 * was (`pageCorner`): a page centred in the viewport at 137% starts on a half,
 * and without it the snap is to the page's grid, not the screen's.
 *
 * Anything else is stretched over its footprint.
 */
export function pictureCss(g, z, dpr = 1, at = null) {
  const d = dpr > 0 ? dpr : 1;
  if (g.aligned && at) {
    const snap = (v) => Math.round(v * d) / d;
    const px = g.page?.x ?? 0;
    const py = g.page?.y ?? 0;
    const left = snap(px + (at.x - g.ox) * z - g.fx / d) - px - at.x * z;
    const top = snap(py + (at.y - g.oy) * z - g.fy / d) - py - at.y * z;
    return `left:${left}px;top:${top}px;width:${g.pw / d}px;height:${g.ph / d}px;`;
  }
  return `left:${-g.ox * z}px;top:${-g.oy * z}px;width:${g.cw * z}px;height:${g.ch * z}px;`;
}

// Where a page frame's content corner is in the viewport, CSS px. It is a
// question to the layout, so it is asked once for all the boxes painted in
// one flush and forgotten after it: thirty boxes repainting on a zoom force
// one layout, not thirty. It is read when a picture is painted and not
// watched: a pan and a scroll move the page by whole device pixels
// (Canvas.svelte snaps the pan for its own reasons), and what does not - the
// window resized, a panel opened - leaves the pictures up to half a device
// pixel off until they are next painted.
let corners = new WeakMap();
let forgetting = false;
export function pageCorner(frameEl) {
  if (typeof frameEl?.getBoundingClientRect !== 'function') return null;
  let c = corners.get(frameEl);
  if (!c) {
    const r = frameEl.getBoundingClientRect();
    c = { x: r.left + (frameEl.clientLeft || 0), y: r.top + (frameEl.clientTop || 0) };
    corners.set(frameEl, c);
    if (!forgetting) {
      forgetting = true;
      queueMicrotask(() => {
        corners = new WeakMap();
        forgetting = false;
      });
    }
  }
  return c;
}

/**
 * The part of a picture's key (`pictureKey`'s `under`) that a box blending
 * with the page (`usesBackdrop`) is painted from besides its style: the page
 * art `src` it is shown over and whether it has loaded (`ready`), where the
 * box stands, its turn, its mirror and the page's size. Empty for every
 * other box, whose picture is the same wherever it is.
 */
export function pageUnderKey(box, pg, src, ready) {
  const s = box?.style;
  if (!usesBackdrop(s)) return '';
  return `${src ?? '-'}|${ready ? 1 : 0}|${box.x},${box.y}|${s.rotation || 0}|${s.flipH ? 1 : 0}${s.flipV ? 1 : 0}|${pg?.w ?? 0}x${pg?.h ?? 0}`;
}

/**
 * The page a box sits on as the editor knows it, `{ w, h }` page px, for a
 * gradient with Align with Layer off (`pictureTexture`'s `sheet`): the
 * page's measured size, or the size of its art when that is in hand
 * (`image`). Null before either is known: the gradient then paints as Align
 * on until the page is measured. Null too for a box with no such gradient.
 */
export function pageSheet(box, pg, image = null) {
  if (!pageGradients(box?.style)) return null;
  const w = pg?.w > 0 ? pg.w : image?.naturalWidth;
  const h = pg?.h > 0 ? pg.h : image?.naturalHeight;
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * The part of a picture's key (`pictureKey`'s `page`) a box with a gradient
 * laid over the page (Align with Layer off) is painted from besides its
 * style: where it stands, its turn and its mirror (which `pictureKey` leaves
 * to CSS for every other box) and the page's size. Empty for any other box.
 */
export function pageGradientKey(box, sheet) {
  const s = box?.style;
  if (!sheet || !pageGradients(s)) return '';
  return `${box.x},${box.y}|${s.rotation || 0}|${s.flipH ? 1 : 0}${s.flipV ? 1 : 0}|${sheet.w}x${sheet.h}`;
}

// What a repaint key says for a box that is to hold no pixels: on a hidden
// page, or too far from the viewport to be seen.
export const PICTURE_OFF = 'e|off';

/**
 * Everything the engine's picture of a box is drawn from, as one string.
 *
 *   in:  the style, less what CSS applies to the finished picture (the turn,
 *        the flip, the opacity); the text; the box's size; the lines it broke
 *        into and how far each is set in, which is where a balloon fit, the
 *        typesetting mode and a late font show up; the scale; the font
 *        version.
 *   out: where the box is. A move repaints nothing. (A box with a mask on
 *        is repainted as it moves: TextBox's key adds the mask in the box's
 *        frame, since the mask stays on the page.)
 *
 * Except for a box that blends with the page (`usesBackdrop`): its picture
 * is of the page under it too, so `under` names that page art and where the
 * box stands on it, turned and mirrored (TextBox.svelte's `underKey`), and a
 * move, a turn or another page art repaints it. Likewise a box with a
 * gradient laid over the page (Align with Layer off): `page`
 * (`pageGradientKey`) says where it stands, turned and mirrored, and on how
 * big a page, and a move repaints it as it goes.
 *
 * The ink block is not stringified here - it is the heaviest part of a style
 * and the caller already has a key for it (`inkKey` in TextBox.svelte).
 */
export function pictureKey({ style, inkKey, text, w, h, lines, indents, scale, fonts, tiles = '', light = '', under = '', page = '', edges = '', runs = null }) {
  // The paint's marks by their revision (`paintKey`): a brush's points are
  // never turned to text here.
  const drawn = { ...style, ink: 0, paint: paintKey(style.paint), rotation: 0, opacity: 1, flipH: false, flipV: false };
  return (
    `e|${JSON.stringify(drawn)}|${inkKey}|${text}|${w}|${h}|` +
    `${lines ? lines.join('\n') : ''}|${indents ? indents.join(',') : ''}|${scale}|${fonts}` +
    (tiles ? `|${tiles}` : '') +
    // The chapter's Global Light, for a box with a shadow that follows it.
    (light ? `|L${light}` : '') +
    // The page art under a box that blends with it, and where it stands.
    (under ? `|B${under}` : '') +
    // A gradient laid over the page (Align with Layer off): where the box
    // stands on it, turned and mirrored (`pageGradientKey`).
    (page ? `|P${page}` : '') +
    // Crisp letter edges (text-edges.svelte.js).
    (edges ? `|E${edges}` : '') +
    // The faces of the words (runs.js): a word made bold is a new picture.
    // None is no part at all, so a box without runs has the key it had.
    (runs?.length ? `|R${runsKey(runs)}` : '')
  );
}
