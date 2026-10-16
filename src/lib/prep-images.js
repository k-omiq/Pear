// Import preparation deliberately avoids the editor's page-pixels cache: these
// files have no page ids yet, and a 100,000px source needs bounded canvas reads.
export const PREP_CANVAS_SIDE = 16000;
export const PREP_CHUNK_H = 1024;

export function prepCanvas(width, height) {
  if (!(width > 0 && height > 0) || width > PREP_CANVAS_SIDE || height > PREP_CANVAS_SIDE) {
    throw new Error('Prepared images must fit within 16,000 pixels per side. Choose a smaller slice height or shorter source slices.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  if (!canvas.getContext('2d')) {
    releasePrepCanvas(canvas);
    throw new Error('Could not allocate the page preparation canvas.');
  }
  return canvas;
}

export function releasePrepCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

export async function withPrepBitmap(file, fn) {
  const bitmap = await createImageBitmap(file);
  try {
    return await fn(bitmap);
  } finally {
    bitmap.close();
  }
}

// Read every row at native resolution, but never allocate a source-sized canvas.
export async function readPrepChunks(bitmap, visit) {
  const canvas = prepCanvas(bitmap.width, Math.min(bitmap.height, PREP_CHUNK_H));
  try {
    const ctx = canvas.getContext('2d');
    for (let y = 0; y < bitmap.height; y += PREP_CHUNK_H) {
      const height = Math.min(PREP_CHUNK_H, bitmap.height - y);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, y, bitmap.width, height, 0, 0, bitmap.width, height);
      visit(ctx.getImageData(0, 0, bitmap.width, height), y);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    releasePrepCanvas(canvas);
  }
}

export async function prepPngFile(canvas, index) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not encode the prepared page as PNG. Try a smaller page size.');
  return new File([blob], `${String(index + 1).padStart(3, '0')}.png`, { type: 'image/png' });
}
