import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanRowFlags, cleanRowBands, planStripReslice, clampResliceHeight, resliceWarning, resliceStripFiles, RESLICE_H_DEFAULT, RESLICE_H_MAX } from './strip-reslice.js';
import { SLICE_H_DEFAULT } from './editor/strip-cuts.js';
import { PREP_CANVAS_SIDE } from './prep-images.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';

function pixels(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, data };
}
const source = (height, bands = [], width = 8) => {
  const cleanRows = new Uint8Array(height);
  for (const [top, bottom] of bands) cleanRows.fill(1, top, bottom);
  return { width, height, cleanRows };
};

afterEach(() => vi.unstubAllGlobals());

describe('strip row analysis', () => {
  it('accepts white, black and coloured solid rows with a range of at most six', () => {
    expect([...cleanRowFlags(pixels(8, 4, (x, y) => [y * 50 + (x === 7 ? 6 : 0), y * 30, y * 10, 255]))]).toEqual([1, 1, 1, 1]);
  });
  it('rejects even one pixel of ink at an edge or between sampled columns', () => {
    expect([...cleanRowFlags(pixels(1031, 2, (x, y) => x === (y ? 513 : 1030) ? [0, 0, 0, 255] : [255, 255, 255, 255]))]).toEqual([0, 0]);
  });
  it('treats transparent pixels as white and ignores runs under ten rows', () => {
    expect([...cleanRowFlags(pixels(2, 1, (x) => [x * 255, 0, 0, 0]))]).toEqual([1]);
    expect(cleanRowBands(Uint8Array.from([0, ...Array(9).fill(1), 0, ...Array(10).fill(1)]))).toEqual([{ top: 11, bottom: 21 }]);
  });
});

describe('import strip cuts', () => {
  it('joins clean flags across source seams and cuts at the band midpoint', () => {
    const plan = planStripReslice([source(1000, [[990, 1000]]), source(1000, [[0, 11]])], 1000);
    expect(plan).toEqual({ cuts: [0, 1000, 2000], warnings: [] });
  });
  it('chooses the nearest gutter in the half to one-and-a-half target window', () => {
    expect(planStripReslice([source(3000, [[390, 411], [1190, 1211], [2290, 2311]])], 1000).cuts).toEqual([0, 1200, 2300, 3000]);
  });
  it('balances a short tail with the preceding slice', () => {
    expect(planStripReslice([source(2200, [[990, 1011], [1590, 1611], [1990, 2011]])], 1000).cuts).toEqual([0, 1000, 1600, 2200]);
  });
  it('uses the middle of the usable window in an extensive flat band', () => {
    const { cuts, warnings } = planStripReslice([source(100000, [[0, 100000]])], 1000);
    expect(cuts).toHaveLength(101);
    expect(cuts.every((y, i) => !i || y - cuts[i - 1] === 1000)).toBe(true);
    expect(warnings).toEqual([]);
  });
  it('keeps source seams with a visible warning when no gutter is available', () => {
    const plan = planStripReslice([source(900), source(1100), source(1000)], 1000);
    expect(plan.cuts).toEqual([0, 900, 2000, 3000]);
    expect(resliceWarning(plan.warnings)).toBe('2 cuts had no clean gutter and kept the original seam');
  });
  it('cuts at the ideal and warns when no gutter or source seam is available', () => {
    expect(planStripReslice([source(2500)], 1000)).toEqual({
      cuts: [0, 1000, 2000, 2500],
      warnings: [1000, 2000].map((y) => ({ y, reason: 'no-clean-gutter-or-seam' })),
    });
  });
  it('refuses mismatched widths and handles empty and short inputs', () => {
    expect(() => planStripReslice([source(1000), source(1000, [], 9)])).toThrow('same width');
    expect(planStripReslice([]).cuts).toEqual([]);
    expect(planStripReslice([source(900)], 1000)).toEqual({ cuts: [0, 900], warnings: [] });
  });
  it('uses the export default and clamps targets so the entire search window fits', () => {
    expect(RESLICE_H_DEFAULT).toBe(8000);
    expect(RESLICE_H_DEFAULT).toBe(SLICE_H_DEFAULT);
    expect(RESLICE_H_MAX).toBe(10666);
    expect(RESLICE_H_MAX * 1.5).toBeLessThanOrEqual(PREP_CANVAS_SIDE);
    expect([20, 20001, NaN, undefined, 1234.8].map(clampResliceHeight)).toEqual([1000, 10666, 8000, 8000, 1235]);
  });
  it('keeps all slices under the canvas limit at default and excessive targets', () => {
    for (const target of [undefined, 16000, 20000]) {
      const { cuts } = planStripReslice([source(100000, [[17000, 17021], [50000, 50021]])], target);
      expect(cuts.at(-1)).toBe(100000);
      for (let i = 1; i < cuts.length; i++) {
        expect(cuts[i] - cuts[i - 1]).toBeGreaterThan(0);
        expect(cuts[i] - cuts[i - 1]).toBeLessThanOrEqual(PREP_CANVAS_SIDE);
      }
    }
  });
  it('never falls back to a source seam beyond the canvas cap', () => {
    const { cuts, warnings } = planStripReslice([source(20000), source(20000)]);
    expect(cuts[1]).toBe(8000);
    expect(warnings[0]).toEqual({ y: 8000, reason: 'no-clean-gutter-or-seam' });
    expect(warnings).toContainEqual({ y: 20000, reason: 'no-clean-gutter' });
    for (let i = 1; i < cuts.length; i++) expect(cuts[i] - cuts[i - 1]).toBeLessThanOrEqual(PREP_CANVAS_SIDE);
  });
  it('explains both preserved seams and forced target cuts in the dialog warning', () => {
    const forced = { y: 8000, reason: 'no-clean-gutter-or-seam' };
    expect(resliceWarning([forced])).toBe('1 cuts had no clean gutter or source seam within the canvas limit and used the target height');
    expect(resliceWarning([{ y: 20000, reason: 'no-clean-gutter' }, forced])).toBe('1 cuts had no clean gutter and kept the original seam; 1 cuts had no clean gutter or source seam within the canvas limit and used the target height');
    expect(resliceWarning([])).toBe('');
  });
});

// Real pixels through the thin webview wrapper: source order and crossing a
// seam must preserve every row, not just produce a plausible list of heights.
it('composes PNG slices in natural order without a source-height canvas', async () => {
  const allocated = [];
  vi.stubGlobal('document', { createElement: () => {
    const c = createCanvas(1, 1);
    c.toBlob = (cb) => { allocated.push([c.width, c.height]); cb(new Blob([c.toBuffer('image/png')])); };
    return c;
  } });
  let open = 0;
  let peak = 0;
  vi.stubGlobal('createImageBitmap', async (file) => {
    const image = await loadImage(new Uint8Array(await file.arrayBuffer()));
    open++;
    peak = Math.max(peak, open);
    image.close = () => { open--; };
    return image;
  });
  const file = (name, height, colour) => {
    const c = createCanvas(8, height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 8, height);
    return new File([c.toBuffer('image/png')], name);
  };
  const result = await resliceStripFiles([file('10.png', 700, 'blue'), file('2.png', 500, 'red')], 1000);
  expect(result.files.map((f) => f.name)).toEqual(['001.png', '002.png']);
  const a = await loadImage(new Uint8Array(await result.files[0].arrayBuffer()));
  const b = await loadImage(new Uint8Array(await result.files[1].arrayBuffer()));
  expect([a.height, b.height]).toEqual([600, 600]);
  const c = createCanvas(8, 600);
  const ctx = c.getContext('2d');
  ctx.drawImage(a, 0, 0);
  expect([...ctx.getImageData(0, 0, 1, 1).data]).toEqual([255, 0, 0, 255]);
  expect([...ctx.getImageData(0, 550, 1, 1).data]).toEqual([0, 0, 255, 255]);
  ctx.drawImage(b, 0, 0);
  expect([...ctx.getImageData(0, 0, 1, 1).data]).toEqual([0, 0, 255, 255]);
  expect(allocated.every(([w, h]) => w <= 16000 && h <= 16000)).toBe(true);
  expect(open).toBe(0);
  expect(peak).toBe(1);
});

it('reads a 100,000px source in bounded chunks and releases its bitmaps', async () => {
  const canvases = [];
  const reads = [];
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', async () => ({ width: 8, height: 100000, close }));
  vi.stubGlobal('document', { createElement: () => {
    const canvas = {
      width: 0, height: 0,
      getContext: () => ({
        clearRect() {}, drawImage() {},
        getImageData(_x, _y, width, height) {
          reads.push(height);
          return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
        },
      }),
      toBlob(cb) {
        expect(canvas.height).toBeLessThanOrEqual(16000);
        cb(new Blob(['png']));
      },
    };
    canvases.push(canvas);
    return canvas;
  } });
  const result = await resliceStripFiles([new File(['source'], 'tall.png')], 1000);
  expect(result.files).toHaveLength(100);
  expect(result.warnings).toEqual([]);
  expect(Math.max(...reads)).toBe(1024);
  expect(reads.reduce((sum, h) => sum + h, 0)).toBe(100000);
  expect(close).toHaveBeenCalledTimes(2);
  expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
});

it('refuses unsafe output dimensions and closes the decoded source on failure', async () => {
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', async () => ({ width: 16001, height: 2, close }));
  await expect(resliceStripFiles([new File(['source'], 'wide.png')])).rejects.toThrow('16,000 pixels per side');
  expect(close).toHaveBeenCalledOnce();
});
