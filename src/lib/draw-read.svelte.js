// ===== Draw a kanji to read it (OCR-6) =====
// A letterer who meets a character they cannot type or look up draws it, and
// the project's recognizer (manga-ocr for Japanese) reads the drawing as if it
// were a crop of the page. Komatose sends the drawing to a vision model; ours
// stays local.
//
// `drawRead.open` is the dialog's open flag: the palette opens it, App.svelte
// closes it on Escape. The rest is the pure part the dialog uses.

export const drawRead = $state({ open: false });

// Ink is any pixel darker than this on the white pad.
const INK = 200;

// The tight box around the ink, padded by a share of its longer side, so the
// recognizer sees the character the size a page crop would show it rather
// than a speck in the corner of an empty pad. Null when nothing is drawn.
export function inkCrop({ width, height, data }, pad = 0.15) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dark = data[i + 3] > 0 && Math.min(data[i], data[i + 1], data[i + 2]) < INK;
      if (!dark) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const m = Math.round(Math.max(x1 - x0 + 1, y1 - y0 + 1) * pad);
  return { x: x0 - m, y: y0 - m, w: x1 - x0 + 1 + 2 * m, h: y1 - y0 + 1 + 2 * m };
}
