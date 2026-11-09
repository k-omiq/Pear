// ===== The page under a box, for the engine to blend with =====
//
// A box in a blend mode (LAYER_STYLES_PLAN.md phase 6, `usesBackdrop`) is
// painted by the engine over the page art under it: the box job's `backdrop`,
// straight RGBA8 of the surface's own size, one page pixel under each surface
// pixel (text-engine/js/paint.mjs `encodeBox`). The engine does the blending
// and hands back a picture that, laid source-over on the page, shows the
// blend; this file only fetches the pixels.
//
// The page is the ART alone (6a): `cleaned ?? raw` as the editor shows it
// (`page-art.svelte.js`), flattened on white, and white where the footprint
// leaves the page. Boxes below are not in it (6c). The editor and the flat
// export build it the same way, through the box's whole transform, so the two
// agree: a surface pixel `q` of the box's picture is shown at the page point
// `A(m^-1(q))`, where `m` is the painter's matrix (layout to the surface's
// device pixels) and `A` the box's place on the page (layout to page,
// `boxToPage`: its position, its turn and its mirror). The crop is the page
// drawn through the inverse of that, so a turned or mirrored box blends with
// the pixels it is really shown over.
//
// The PSD's layers have no backdrop (`renderBoxLayer`): Photoshop blends a
// layer from its own `blendMode`, and pixels blended here would be blended
// twice.

// A guard on the readback: a crop past this is not taken and the box paints
// as if Normal (the engine's own guard is 64 MP; this is a quarter of it, a
// 64 MB crop and its wire copy).
export const BACKDROP_MAX_PX = 16 * 1024 * 1024;

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
function inverse(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const [a, b, c, d, e, f] = m;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * The affine that carries a box's layout coordinates (the painter's user
 * space, the box's top-left at `(L.ox, L.oy)`) to the page as the box is
 * shown: at `(x, y)` (the box's own place unless `at` moves it), turned about
 * its centre by `style.rotation` and mirrored inside the turn, as the editor's
 * CSS and the export's page composite place it. `[a, b, c, d, e, f]`, a
 * canvas matrix.
 */
export function boxToPage(box, L, at = null) {
  const s = box.style ?? {};
  const t = ((Number(s.rotation) || 0) * Math.PI) / 180;
  const fx = s.flipH ? -1 : 1;
  const fy = s.flipV ? -1 : 1;
  const x = at?.x ?? (Number(box.x) || 0);
  const y = at?.y ?? (Number(box.y) || 0);
  const w = Number(box.w) || 0;
  const h = Number(box.h) || 0;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const a = cos * fx;
  const b = sin * fx;
  const c = -sin * fy;
  const d = cos * fy;
  const ux = -(w / 2 + L.ox);
  const uy = -(h / 2 + L.oy);
  return [a, b, c, d, x + w / 2 + a * ux + c * uy, y + h / 2 + b * ux + d * uy];
}

// The last crop of a box the editor painted, by the box: a slider drag
// repaints with the same rectangle and matrix, and pays the engine only.
// Eight boxes, and no more than `HELD_MAX_BYTES` of crops between them: a
// crop can be 64 MB (`BACKDROP_MAX_PX`), and eight of those held for a slider
// that is dragging one is half a gigabyte for nothing. The newest crop is kept
// whatever its size; it is the one the drag repaints.
const MAX_HELD = 8;
export const HELD_MAX_BYTES = 64 * 1024 * 1024;
const held = new Map();
let heldBytes = 0;
function forget(k) {
  const e = held.get(k);
  if (!e) return;
  heldBytes -= e.data.length;
  held.delete(k);
}

/**
 * The page art under a box's surface, or null (no art, a matrix that is not
 * one, a surface past the guard).
 *
 * `under` is `{ image, W, H, src, key }`: the art drawn at `W` x `H` page px
 * (the page's space), `src` naming it for the cache, and `key` (any object,
 * the box) to cache the crop by, or none. `A` is `boxToPage`. `rect` is the
 * surface the painter is about to paint (`rust-painter.js` `paintBox`):
 * `{ x0, y0, width, height, m }`, `m` the canvas matrix layout to device.
 */
export function backdropPixels(under, A, rect) {
  const { x0, y0, width, height, m } = rect;
  if (!under?.image || !(width > 0 && height > 0)) return null;
  if (width * height > BACKDROP_MAX_PX) {
    console.warn(`a box ${width} x ${height} px is past the page backdrop's guard; it is painted without the page`);
    return null;
  }
  const inv = inverse(A);
  if (!inv) return null;
  // Page to the surface: page -> layout -> device -> the surface's own.
  const T = mul([1, 0, 0, 1, -x0, -y0], mul(m, inv));
  if (!T.every(Number.isFinite)) return null;
  const key = `${under.src ?? ''}|${under.W}x${under.H}|${width}x${height}|${T.map((v) => v.toFixed(6)).join(',')}`;
  const hit = under.key ? held.get(under.key) : null;
  if (hit && hit.key === key) {
    held.delete(under.key);
    held.set(under.key, hit);
    return hit.data;
  }
  const cnv = document.createElement('canvas');
  cnv.width = width;
  cnv.height = height;
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  // White under the art and past its edges: the page is read as opaque.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  let data = null;
  try {
    ctx.drawImage(under.image, 0, 0, under.W, under.H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    data = ctx.getImageData(0, 0, width, height).data;
  } catch (err) {
    // A tainted or broken image: paint without the page.
    console.warn('the page art could not be read for a blend; the box is painted without it', err);
  }
  cnv.width = 0;
  cnv.height = 0;
  if (data && under.key) {
    forget(under.key);
    held.set(under.key, { key, data });
    heldBytes += data.length;
    while (held.size > 1 && (held.size > MAX_HELD || heldBytes > HELD_MAX_BYTES)) forget(held.keys().next().value);
  }
  return data;
}

/** How many crops are held (tests). */
export const backdropsHeld = () => held.size;
/** How many bytes the held crops are (tests). */
export const backdropBytesHeld = () => heldBytes;
/** Forget every held crop. */
export function forgetBackdrops() {
  held.clear();
  heldBytes = 0;
}
