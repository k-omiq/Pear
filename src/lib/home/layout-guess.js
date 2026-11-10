// Which layout a set of page images reads as (plan 2.3): a long strip when
// the median page is more than 2.5 times as tall as it is wide, pages
// otherwise. A project's layout cannot be changed later, so the guess is
// only the preselected answer; comics use sees it and can change it.
export const STRIP_RATIO = 2.5;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// A PNG's size from its header: the first 24 bytes hold the signature and the
// IHDR chunk's width and height. The picker has already made every page a
// PNG, so a chapter of hundreds of pages is guessed without decoding one.
// Null for anything that is not a PNG with a sane size.
export async function pngSize(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 24).arrayBuffer());
    if (head.length < 24 || !PNG_MAGIC.every((b, i) => head[i] === b)) return null;
    const view = new DataView(head.buffer);
    const w = view.getUint32(16);
    const h = view.getUint32(20);
    return w > 0 && h > 0 ? { w, h } : null;
  } catch {
    return null;
  }
}

export async function guessLayout(files) {
  const sizes = await Promise.all([...files].map(pngSize));
  const ratios = sizes.filter(Boolean).map((s) => s.h / s.w).sort((a, b) => a - b);
  if (!ratios.length) return 'pages';
  const mid = ratios.length >> 1;
  const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return median > STRIP_RATIO ? 'longstrip' : 'pages';
}
