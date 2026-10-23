// ===== A box in the editor, as the engine's own picture of it =====
//
// With the Rust engine drawing (engine-switch.svelte.js) a box that is not
// being typed into is shown as ONE canvas, painted by `renderBoxTexture` - the
// function the export, the PSD's rasters and the warped box have always
// called. What is on screen is then the file's picture by construction: one
// painter and two destinations, which is the design `paintWarpedBox` set out
// for a warped box and this makes the rule for every box.
//
// What differs from the export is only the resolution. The export paints at 2
// and lets the composite scale it down; the editor paints at the scale the
// picture is SHOWN at - the zoom times the display's pixel ratio, one texture
// pixel per device pixel - because DOM text was sharp at every zoom and a
// picture painted at 2 is soft above 200% and wasted below.
//
// The canvas itself, its repaint key, its sequence counter and its release
// are TextBox.svelte's, the same ones the warped box had; this file is the
// arithmetic and the two paints, kept out of the component so they can be
// tested without one.
import { renderBoxTexture, warpTexture } from '../exporter.js';
import { glyphPainter } from '../text-engine/index.js';

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
// `at` is where the box's top-left lands on the screen in device px, for a
// picture set on whole device pixels (`renderBoxTexture`'s `phase`).
//
// The texture says where its ink is (`ink`, canvas px, or null when the
// painter could not say): the SFX panel's previews cut to it from there.
export function pictureTexture(box, p, tips, scale, maxPx = PICTURE_MAX_PX, flat = false, at = null) {
  // The editor's smear is the coarse one (`paintBoxJob`): this picture is
  // painted again at every edit.
  return renderBoxTexture(box, p, tips, scale, maxPx, glyphPainter().maxSide ?? Infinity, flat, true, at);
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

/** Device px per page px a box is painted at when nothing caps it. */
export function pictureScale(zoom, dpr, rotation = 0) {
  return zoom * (dpr > 0 ? dpr : 1) * (rotation % 90 ? TURNED_OVERSAMPLE : 1);
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

// The finished bitmap onto the editor's canvas, pixel for pixel, and the
// footprint back. 'copy' rather than a clear and a draw: the canvas then holds
// exactly the bytes the painter made, which is what lets a test say the editor
// and the export are the same picture and mean the same bytes.
//
// A mesh can carry a texture well past the footprint it was budgeted for
// (warp-paint.js allows 64 MP), and this canvas is kept where the texture is
// not - so a warped result over the budget is scaled down into it. Nothing
// else comes in over: `renderBoxTexture` was handed the same budget, and the
// row or column its rounding adds is the slack allowed here.
//
// `unit` is texture pixels per CSS px when the picture is shown one texel to
// the device pixel. The canvas is then padded with transparent pixels to a
// whole number of CSS px each way: WebKit paints a canvas into a rect rounded
// to whole CSS px (two device px on a 2x display), so a canvas a fraction of a
// CSS px wide was stretched by up to one CSS px and landed off its device
// pixels - a letter jump at every zoom (`pictureCss`). 1 pads nothing.
function show(el, r, maxPx, release, unit = 1) {
  let w = r.canvas.width;
  let h = r.canvas.height;
  const over = (w * h) / maxPx;
  // How much of the bitmap's resolution the canvas keeps: all of it, or less.
  let k = 1;
  if (over > 1.02) {
    k = 1 / Math.sqrt(over);
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
  }
  const pw = k === 1 && unit > 1 ? Math.ceil(w / unit) * unit : w;
  const ph = k === 1 && unit > 1 ? Math.ceil(h / unit) * unit : h;
  if (el.width !== pw) el.width = pw;
  if (el.height !== ph) el.height = ph;
  const ctx = el.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // 'copy' replaces what the image covers; the padding is cleared by hand.
  if (pw !== w || ph !== h) ctx.clearRect(0, 0, pw, ph);
  ctx.globalCompositeOperation = 'copy';
  // One to one there is nothing to smooth, and a canvas that filters anyway
  // (Skia's 'high' is a cubic at any scale) would hand back other bytes.
  const same = w === r.canvas.width && h === r.canvas.height;
  ctx.imageSmoothingEnabled = !same;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(r.canvas, 0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  if (release) {
    // The texture is on screen and nothing else holds it. A footprint at the
    // display's scale is megapixels, and there is one of these per box.
    r.canvas.width = 0;
    r.canvas.height = 0;
  }
  // The padding is page px too, at the bitmap's own page px per pixel.
  return { ox: r.ox, oy: r.oy, cw: pw === w ? r.cw : (r.cw * pw) / w, ch: ph === h ? r.ch : (r.ch * ph) / h, k };
}

/**
 * Paints `box` into the editor canvas `el` at `scale` device px per page px
 * (less for a box over the budget `maxPx`), mesh included. Returns where the
 * picture sits: `ox`/`oy` page px left of and above the box's own top-left,
 * and the `cw` x `ch` page px it spans - what `pictureCss` places the canvas
 * by - and `ss`, the device px per page px it was really painted at: `scale`
 * itself where no budget and no limit lowered it, and less where one did.
 *
 * `unit` is `scale` over the zoom - device px per CSS px, times the turned
 * box's oversample - and pads the canvas to whole CSS px (`show`). Only a
 * whole number pads, and only a picture painted at `scale`: one a budget
 * lowered is resampled on screen whatever its size.
 *
 * `corner` is where the box's top-left lands on the screen, device px, for a
 * box `pictureCss` sets on whole device pixels; the fraction of a pixel the
 * picture was painted moved by comes back as `phase` (undefined when none).
 */
export function paintBoxPicture(el, box, p, scale, tips, maxPx = PICTURE_MAX_PX, unit = 1, corner = null) {
  const tex = pictureTexture(box, p, tips, scale, maxPx, false, corner);
  const ss = tex.ss;
  const phase = tex.phase ?? null;
  const whole = ss === scale && Math.abs(unit - Math.round(unit)) < 1e-9 ? Math.round(unit) : 1;
  const { k, ...at } = show(el, warpTexture(tex, box), maxPx, true, whole);
  return { ...at, ss: k === 1 ? ss : ss * k, phase: k === 1 && phase ? phase : undefined };
}

/**
 * The same from a texture the caller is holding on to: the mesh gizmo's drag,
 * which paints the box once when the pointer goes down and then only re-runs
 * the mesh. The texture is the gesture's and is not released; the warped
 * bitmap this call made is.
 */
export function paintPictureTexture(el, tex, box, maxPx = PICTURE_MAX_PX) {
  const r = warpTexture(tex, box, false);
  const { k, ...at } = show(el, r, maxPx, r.canvas !== tex.canvas);
  return at;
}

/**
 * The canvas's inline placement, in zoomed CSS px relative to the box's own
 * top-left (the clip wrapper's origin).
 *
 * `at` is the box's page position when the picture should be set on whole
 * device pixels, and null when it should not. A canvas painted one texture
 * pixel per device pixel is only shown that way if it also STARTS on a device
 * pixel; half a pixel off and the compositor resamples the whole of it, which
 * is the softness painting at the display's scale was for. So the corner is
 * moved to the nearest device pixel - at most half of one, a quarter of a CSS
 * px on a 2x display. Only for a box that is upright and unmirrored: a turned
 * picture is resampled whatever its corner does.
 *
 * `g.page` is where the page's own corner is on the screen (`pageCorner`),
 * which is not a whole pixel either: a page centred in the viewport at 137%
 * starts on a half. Without it the snap is to the page's grid, not the
 * screen's.
 */
export function pictureCss(g, z, dpr = 1, at = null) {
  let left = -g.ox * z;
  let top = -g.oy * z;
  if (at && dpr > 0) {
    const snap = (v) => Math.round(v * dpr) / dpr;
    const px = g.page?.x ?? 0;
    const py = g.page?.y ?? 0;
    // A picture painted moved by a fraction of a pixel (`phase`) is set that
    // much earlier, so the letters - not the canvas - land where they belong.
    const fx = (g.phase?.x ?? 0) / dpr;
    const fy = (g.phase?.y ?? 0) / dpr;
    left = snap(px + (at.x - g.ox) * z - fx) - px - at.x * z;
    top = snap(py + (at.y - g.oy) * z - fy) - py - at.y * z;
  }
  return `left:${left}px;top:${top}px;width:${g.cw * z}px;height:${g.ch * z}px;`;
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
 *   out: where the box is. A move repaints nothing.
 *
 * The ink block is not stringified here - it is the heaviest part of a style
 * and the caller already has a key for it (`inkKey` in TextBox.svelte).
 */
export function pictureKey({ style, inkKey, text, w, h, lines, indents, scale, fonts, tiles = '' }) {
  const drawn = { ...style, ink: 0, rotation: 0, opacity: 1, flipH: false, flipV: false };
  return (
    `e|${JSON.stringify(drawn)}|${inkKey}|${text}|${w}|${h}|` +
    `${lines ? lines.join('\n') : ''}|${indents ? indents.join(',') : ''}|${scale}|${fonts}` +
    (tiles ? `|${tiles}` : '')
  );
}
