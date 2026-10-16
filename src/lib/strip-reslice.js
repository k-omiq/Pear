// Gutter rule and tail balancing adapted from Komatose's
// src/lib/server/reslice.ts and src/lib/reslice.ts, commit d9be51e (MIT).
import { SLICE_H_DEFAULT, SLICE_H_MIN, SLICE_H_MAX } from './editor/strip-cuts.js';
import { PREP_CANVAS_SIDE, prepCanvas, releasePrepCanvas, withPrepBitmap, readPrepChunks, prepPngFile } from './prep-images.js';

export const RESLICE_H_DEFAULT = SLICE_H_DEFAULT;
const MAX_RESLICE_RATIO = 1.5;
// Even the furthest gutter in the search window must fit a webview canvas.
export const RESLICE_H_MAX = Math.min(SLICE_H_MAX, Math.floor(PREP_CANVAS_SIDE / MAX_RESLICE_RATIO));
export const SOLID_COLOR_RANGE = 6;
export const MIN_CLEAN_RUN = 10;

export function clampResliceHeight(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0
    ? Math.min(RESLICE_H_MAX, Math.max(SLICE_H_MIN, Math.round(n)))
    : RESLICE_H_DEFAULT;
}

// Inspect every column, including one-pixel ink and the image edges. Most art
// rows fail early, so sampling buys little and could miss a narrow mark. Alpha
// is composited on white, as it will be for strip export.
export function cleanRowFlags({ width, height, data }) {
  const rows = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    const low = [255, 255, 255];
    const high = [0, 0, 0];
    let clean = true;
    for (let x = 0; x < width && clean; x++) {
      const i = (y * width + x) * 4;
      const alpha = data[i + 3] / 255;
      for (let c = 0; c < 3; c++) {
        const v = Math.round(data[i + c] * alpha + 255 * (1 - alpha));
        low[c] = Math.min(low[c], v);
        high[c] = Math.max(high[c], v);
        if (high[c] - low[c] > SOLID_COLOR_RANGE) clean = false;
      }
    }
    rows[y] = clean ? 1 : 0;
  }
  return rows;
}

// Half-open row bands; a minimum run rejects isolated scan/compression lines.
export function cleanRowBands(rows, minRun = MIN_CLEAN_RUN) {
  const bands = [];
  let start = -1;
  for (let y = 0; y <= rows.length; y++) {
    if (y < rows.length && rows[y]) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      if (y - start >= minRun) bands.push({ top: start, bottom: y });
      start = -1;
    }
  }
  return bands;
}

function nearestGutter(bands, ideal, lo, hi) {
  let best = null;
  for (const band of bands) {
    const top = Math.max(lo, band.top);
    const bottom = Math.min(hi, band.bottom - 1);
    if (top > bottom) continue;
    const y = Math.round((top + bottom) / 2);
    if (best === null || Math.abs(y - ideal) < Math.abs(best - ideal)) best = y;
  }
  return best;
}

export function planStripReslice(sources, targetHeight = RESLICE_H_DEFAULT) {
  if (!sources.length) return { cuts: [], warnings: [] };
  const width = sources[0].width;
  if (sources.some((source) => source.width !== width)) {
    throw new Error('Re-cut at clean gutters requires all source images to have the same width.');
  }
  const total = sources.reduce((n, source) => n + source.height, 0);
  const rows = new Uint8Array(total);
  const seams = [];
  let top = 0;
  for (const source of sources) {
    rows.set(source.cleanRows, top);
    top += source.height;
    if (top < total) seams.push(top);
  }
  if (!total) return { cuts: [], warnings: [] };
  const bands = cleanRowBands(rows);
  const target = clampResliceHeight(targetHeight);
  // Half to one-and-a-half targets allows meaningful gutter search without
  // producing slivers or doubling file sizes. A short tail shares its height
  // with its predecessor by aiming at their midpoint instead of the target.
  const min = target * 0.5;
  const max = target * MAX_RESLICE_RATIO;
  const cuts = [0];
  const warnings = [];
  let prev = 0;
  while (total - prev > target) {
    const ideal = total - prev - target < min ? Math.round((prev + total) / 2) : prev + target;
    const lo = Math.ceil(prev + min);
    const hi = Math.floor(Math.min(prev + max, prev + PREP_CANVAS_SIDE, total - min));
    let cut = nearestGutter(bands, ideal, lo, hi);
    if (cut === null) {
      // No detection exists at import: even a uniform row cannot promise to
      // protect text. Prefer an original seam, but if none fits the canvas we
      // must cut at the ideal even through art/text, and warn about that too.
      const remaining = seams.filter((y) => y > prev && y <= prev + PREP_CANVAS_SIDE);
      const inRange = remaining.filter((y) => y >= lo && y <= hi);
      const candidates = inRange.length ? inRange : remaining;
      const seam = candidates.sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0];
      cut = seam ?? ideal;
      warnings.push({ y: cut, reason: seam === undefined ? 'no-clean-gutter-or-seam' : 'no-clean-gutter' });
    }
    cuts.push(cut);
    prev = cut;
  }
  if (prev < total) cuts.push(total);
  return { cuts, warnings };
}

export function resliceWarning(warnings) {
  const seams = warnings.filter((warning) => warning.reason === 'no-clean-gutter').length;
  const forced = warnings.filter((warning) => warning.reason === 'no-clean-gutter-or-seam').length;
  return [
    seams ? `${seams} cuts had no clean gutter and kept the original seam` : '',
    forced ? `${forced} cuts had no clean gutter or source seam within the canvas limit and used the target height` : '',
  ].filter(Boolean).join('; ');
}

export async function resliceStripFiles(files, targetHeight = RESLICE_H_DEFAULT) {
  // Match createChapter's natural filename order before crossing source seams.
  const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const sources = [];
  for (const file of ordered) {
    await withPrepBitmap(file, async (bitmap) => {
      if (sources.length && bitmap.width !== sources[0].width) {
        throw new Error('Re-cut at clean gutters requires all source images to have the same width.');
      }
      const cleanRows = new Uint8Array(bitmap.height);
      await readPrepChunks(bitmap, (pixels, y) => cleanRows.set(cleanRowFlags(pixels), y));
      sources.push({ width: bitmap.width, height: bitmap.height, cleanRows });
    });
  }
  const plan = planStripReslice(sources, targetHeight);
  const output = [];
  let sourceIndex = 0;
  let sourceTop = 0;
  let bitmap = null;
  try {
    for (let i = 0; i < plan.cuts.length - 1; i++) {
      const y0 = plan.cuts[i];
      const y1 = plan.cuts[i + 1];
      const canvas = prepCanvas(sources[0].width, y1 - y0);
      try {
        const ctx = canvas.getContext('2d');
        let y = y0;
        while (y < y1) {
          if (!bitmap) bitmap = await createImageBitmap(ordered[sourceIndex]);
          const height = Math.min(y1 - y, sourceTop + bitmap.height - y);
          ctx.drawImage(bitmap, 0, y - sourceTop, bitmap.width, height, 0, y - y0, bitmap.width, height);
          y += height;
          if (y === sourceTop + bitmap.height) {
            sourceTop = y;
            sourceIndex++;
            bitmap.close();
            bitmap = null;
          }
        }
        output.push(await prepPngFile(canvas, i));
      } finally {
        releasePrepCanvas(canvas);
      }
    }
  } finally {
    bitmap?.close();
  }
  return { files: output, warnings: plan.warnings };
}
