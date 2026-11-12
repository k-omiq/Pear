import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { planSpreadSplit, preparePageFiles } from './page-prep.js';

const art = (x, y) => (x + y) % 2 ? [40, 50, 60, 255] : [150, 160, 170, 255];
function pixels(width, height, at) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(at(x, y), (y * width + x) * 4);
  return { width, height, data };
}
const whole = (image) => ({ x: 0, y: 0, width: image.width, height: image.height });

afterEach(() => vi.unstubAllGlobals());

describe('spread split planner', () => {
  const spread = (colour = [255, 255, 255, 255]) => pixels(200, 120, (x, y) => x >= 94 && x < 106 ? colour : art(x, y));
  it('puts the right half first for Japanese and the left first for Chinese and Korean', () => {
    expect(planSpreadSplit(spread(), 'ja').map((p) => p.x)).toEqual([100, 0]);
    for (const language of ['zh', 'ko']) expect(planSpreadSplit(spread(), language).map((p) => p.x)).toEqual([0, 100]);
  });
  it('accepts near-white, transparent and coloured single-colour gutters', () => {
    for (const colour of [[244, 244, 244, 255], [0, 0, 0, 0], [80, 120, 140, 255]]) {
      expect(planSpreadSplit(spread(colour))).toHaveLength(2);
    }
  });
  it('leaves portrait, nearly square, thin-gutter and off-centre pages whole', () => {
    for (const [width, height, lo, hi] of [[200, 250, 94, 106], [200, 180, 94, 106], [200, 120, 98, 102], [200, 120, 44, 56]]) {
      const image = pixels(width, height, (x, y) => x >= lo && x < hi ? [255, 255, 255, 255] : art(x, y));
      expect(planSpreadSplit(image)).toEqual([whole(image)]);
    }
  });
  it('requires a full-height gutter and keeps every pixel across odd-width splits', () => {
    const interrupted = pixels(200, 120, (x, y) => x >= 94 && x < 106 && y !== 50 ? [255, 255, 255, 255] : art(x, y));
    expect(planSpreadSplit(interrupted)).toEqual([whole(interrupted)]);
    const odd = pixels(201, 120, (x, y) => x >= 94 && x < 107 ? [255, 255, 255, 255] : art(x, y));
    const [left, right] = planSpreadSplit(odd, 'ko');
    expect(left.x).toBe(0);
    expect(left.width).toBe(right.x);
    expect(left.width + right.width).toBe(201);
  });
});

function webview() {
  let open = 0;
  let peak = 0;
  let closed = 0;
  vi.stubGlobal('document', { createElement: () => {
    const canvas = createCanvas(1, 1);
    canvas.toBlob = (cb) => cb(new Blob([canvas.toBuffer('image/png')]));
    return canvas;
  } });
  vi.stubGlobal('createImageBitmap', async (file) => {
    const image = await loadImage(new Uint8Array(await file.arrayBuffer()));
    open++;
    peak = Math.max(peak, open);
    image.close = () => { open--; closed++; };
    return image;
  });
  return () => ({ open, peak, closed });
}
function file(name, width, height, paint) {
  const canvas = createCanvas(width, height);
  paint(canvas.getContext('2d'));
  return new File([canvas.toBuffer('image/png')], name);
}
async function outputPixels(output) {
  const image = await loadImage(new Uint8Array(await output.arrayBuffer()));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, at: (x, y) => [...ctx.getImageData(x, y, 1, 1).data] };
}

it('passes original Files through without decoding when all options are off', async () => {
  const decode = vi.fn();
  vi.stubGlobal('createImageBitmap', decode);
  const original = new File(['unchanged'], 'raw.jpg');
  expect(await preparePageFiles([original])).toEqual([original]);
  expect(decode).not.toHaveBeenCalled();
});

it('encodes naturally ordered Japanese halves and leaves a single page its own size', async () => {
  const held = webview();
  const spread = file('2.png', 200, 120, (ctx) => {
    ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 100, 120);
    ctx.fillStyle = 'blue'; ctx.fillRect(100, 0, 100, 120);
    ctx.fillStyle = 'white'; ctx.fillRect(94, 0, 12, 120);
  });
  const small = file('10.png', 80, 100, (ctx) => { ctx.fillStyle = '#101112'; ctx.fillRect(0, 0, 80, 100); });
  const result = await preparePageFiles([small, spread], { splitSpreads: true, ocrLanguage: 'ja' });
  expect(result.map((page) => page.name)).toEqual(['001.png', '002.png', '003.png']);
  const pages = await Promise.all(result.map(outputPixels));
  expect(pages.map((p) => [p.width, p.height])).toEqual([[100, 120], [100, 120], [80, 100]]);
  expect(pages[0].at(50, 50)).toEqual([0, 0, 255, 255]);
  expect(pages[1].at(50, 50)).toEqual([255, 0, 0, 255]);
  expect(pages[2].at(0, 0)).toEqual([16, 17, 18, 255]);
  // Each source is decoded once and let go before the next.
  expect(held()).toEqual({ open: 0, peak: 1, closed: 2 });
});
