// Import preparation adapted from Komatose's src/lib/server/pageEdit.ts and
// src/lib/server/spreadGutter.ts, commit d9be51e (MIT).
import { prepCanvas, releasePrepCanvas, withPrepBitmap, prepPngFile } from './prep-images.js';

export const CROP_PAD = 4;
export const MAX_CROP_FRACTION = 0.4;
const WHITE_MIN = 242;
const BLACK_MAX = 13;
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

function marginColour(colour) {
  return colour && (colour.every((v) => v >= WHITE_MIN) || colour.every((v) => v <= BLACK_MAX));
}

export function planAutoCrop(image, area = fullPage(image), pad = CROP_PAD) {
  const { x, y, width, height } = area;
  let top = y;
  let bottom = y + height;
  let left = x;
  let right = x + width;
  // Each side follows its original edge colour, so a solid black panel after
  // white paper stops the trim rather than becoming another strip of margin.
  const matches = (a, b) => marginColour(a) && marginColour(b) && a.every((v, c) => Math.abs(v - b[c]) <= MARGIN_RANGE);
  const row = (at) => lineColour(image, x, at, 1, 0, width, MARGIN_RANGE);
  const upper = row(top);
  const lower = row(bottom - 1);
  while (top < bottom && matches(upper, row(top))) top++;
  while (bottom > top && matches(lower, row(bottom - 1))) bottom--;
  if (top === bottom) return { ...area }; // blank sheets stay whole
  const col = (at) => lineColour(image, at, top, 0, 1, bottom - top, MARGIN_RANGE);
  const first = col(left);
  const last = col(right - 1);
  while (left < right && matches(first, col(left))) left++;
  while (right > left && matches(last, col(right - 1))) right--;
  if (left === right) return { ...area };
  const safety = Math.max(0, Math.round(pad));
  top = Math.max(y, top - safety);
  bottom = Math.min(y + height, bottom + safety);
  left = Math.max(x, left - safety);
  right = Math.min(x + width, right + safety);
  // Conservative relative to Komatose's 15% minimum content dimensions: a
  // mostly blank design or a large solid panel is not an invitation to erase it.
  if (right - left < width * (1 - MAX_CROP_FRACTION) || bottom - top < height * (1 - MAX_CROP_FRACTION)) return { ...area };
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function pageBorderColour(image, area = fullPage(image)) {
  const { x, y, width, height } = area;
  // Prefer the longest uniform edge; never average artwork into the padding.
  const edges = [
    { x, y, dx: 1, dy: 0, count: width },
    { x, y: y + height - 1, dx: 1, dy: 0, count: width },
    { x, y, dx: 0, dy: 1, count: height },
    { x: x + width - 1, y, dx: 0, dy: 1, count: height },
  ].sort((a, b) => b.count - a.count);
  for (const edge of edges) {
    const colour = lineColour(image, edge.x, edge.y, edge.dx, edge.dy, edge.count);
    if (colour) return colour;
  }
  return [255, 255, 255];
}

export function planPagePreparation(image, { splitSpreads = false, autoCrop = false, ocrLanguage = 'ja' } = {}) {
  const areas = splitSpreads ? planSpreadSplit(image, ocrLanguage) : [fullPage(image)];
  return areas.map((area) => {
    const crop = autoCrop ? planAutoCrop(image, area) : area;
    return { ...crop, colour: pageBorderColour(image, crop) };
  });
}

export function planPageAlignment(pages) {
  // Komatose's maximum width/height rule, applied to the prepared bounds.
  // Cropping is independent here: auto-align alone only adds padding.
  const width = pages.reduce((max, page) => Math.max(max, page.width), 0);
  const height = pages.reduce((max, page) => Math.max(max, page.height), 0);
  return pages.map((page) => ({ width, height, x: Math.round((width - page.width) / 2), y: Math.round((height - page.height) / 2) }));
}

export async function preparePageFiles(files, options = {}) {
  if (!options.splitSpreads && !options.autoCrop && !options.autoAlign) return [...files];
  const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const sources = [];
  // Keep only small plans between sources, never a chapter of decoded pixels.
  for (const file of ordered) {
    const pages = await withPrepBitmap(file, (bitmap) => {
      const canvas = prepCanvas(bitmap.width, bitmap.height);
      try {
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        return planPagePreparation(ctx.getImageData(0, 0, bitmap.width, bitmap.height), options);
      } finally {
        releasePrepCanvas(canvas);
      }
    });
    sources.push({ file, pages });
  }
  const pages = sources.flatMap((source) => source.pages);
  const aligned = options.autoAlign ? planPageAlignment(pages) : pages.map((page) => ({ width: page.width, height: page.height, x: 0, y: 0 }));
  const output = [];
  for (const source of sources) {
    await withPrepBitmap(source.file, async (bitmap) => {
      for (const page of source.pages) {
        const frame = aligned[output.length];
        const canvas = prepCanvas(frame.width, frame.height);
        try {
          const ctx = canvas.getContext('2d');
          if (options.autoAlign) {
            ctx.fillStyle = `rgb(${page.colour.join(',')})`;
            ctx.fillRect(0, 0, frame.width, frame.height);
          }
          ctx.drawImage(bitmap, page.x, page.y, page.width, page.height, frame.x, frame.y, page.width, page.height);
          output.push(await prepPngFile(canvas, output.length));
        } finally {
          releasePrepCanvas(canvas);
        }
      }
    });
  }
  return output;
}
