// Import preparation adapted from Komatose's src/lib/server/pageEdit.ts and
// src/lib/server/spreadGutter.ts, commit d9be51e (MIT).
import { prepCanvas, releasePrepCanvas, withPrepBitmap, prepPngFile } from './prep-images.js';

const WHITE_MIN = 242;
const SOLID_RANGE = 6;
const MARGIN_RANGE = 13;
const fullPage = (image) => ({ x: 0, y: 0, width: image.width, height: image.height });

function lineColour(image, x, y, dx, dy, count, range = SOLID_RANGE) {
  const low = [255, 255, 255];
  const high = [0, 0, 0];
  const sum = [0, 0, 0];
  for (let n = 0; n < count; n++) {
    const i = ((y + n * dy) * image.width + x + n * dx) * 4;
    // Analyse alpha on white, as transparent margins look on the editor's paper.
    const alpha = image.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const value = Math.round(image.data[i + c] * alpha + 255 * (1 - alpha));
      low[c] = Math.min(low[c], value);
      high[c] = Math.max(high[c], value);
      sum[c] += value;
      if (high[c] - low[c] > range) return null;
    }
  }
  return sum.map((value) => Math.round(value / count));
}

export function planSpreadSplit(image, ocrLanguage = 'ja') {
  const { width, height } = image;
  const whole = fullPage(image);
  // A central gutter on a portrait or nearly square page is often artwork.
  if (width < 80 || height < 40 || width < height * 1.2) return [whole];
  const lo = Math.ceil(width * 0.4);
  const hi = Math.floor(width * 0.6);
  const minBand = Math.max(10, Math.round(width * 0.01));
  let run = -1;
  let colour = null;
  let best = null;
  const finish = (right) => {
    if (run < 0 || right - run < minBand) return;
    const x = Math.round((run + right) / 2);
    if (!best || Math.abs(x - width / 2) < Math.abs(best.x - width / 2)) best = { x };
  };
  for (let x = lo; x <= hi; x++) {
    const next = x < hi ? lineColour(image, x, 0, 0, 1, height, MARGIN_RANGE) : null;
    const nearWhite = next?.every((value) => value >= WHITE_MIN);
    const compatible = next && colour && next.every((value, c) =>
      Math.abs(value - colour[c]) <= SOLID_RANGE || (nearWhite && colour.every((v) => v >= WHITE_MIN)));
    if (!next || (run >= 0 && !compatible)) {
      finish(x);
      run = -1;
    }
    if (next && run < 0) { run = x; colour = next; }
  }
  if (!best) return [whole];
  const left = { x: 0, y: 0, width: best.x, height };
  const right = { x: best.x, y: 0, width: width - best.x, height };
  return ocrLanguage === 'ja' ? [right, left] : [left, right];
}

// Split spreads is the one preparation the new-chapter dialog offers; the
// pages come back in reading order, each re-encoded as PNG.
export async function preparePageFiles(files, { splitSpreads = false, ocrLanguage = 'ja' } = {}) {
  if (!splitSpreads) return [...files];
  const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const output = [];
  // One decoded page at a time: the plan is read from the pixels and the
  // halves are drawn from the same bitmap before it is let go.
  for (const file of ordered) {
    await withPrepBitmap(file, async (bitmap) => {
      const canvas = prepCanvas(bitmap.width, bitmap.height);
      let areas;
      try {
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        areas = planSpreadSplit(ctx.getImageData(0, 0, bitmap.width, bitmap.height), ocrLanguage);
      } finally {
        releasePrepCanvas(canvas);
      }
      for (const area of areas) {
        const out = prepCanvas(area.width, area.height);
        try {
          out.getContext('2d').drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
          output.push(await prepPngFile(out, output.length));
        } finally {
          releasePrepCanvas(out);
        }
      }
    });
  }
  return output;
}
