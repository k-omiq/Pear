// A finished page as a JPEG or WebP file, encoded by the engine
// (src/abi_encode.rs) instead of the webview: JPEG keeps colour at full
// resolution (4:4:4), where a canvas's JPEG halves it each way and smears
// coloured lettering, and WebP is written lossless where WebKit cannot write
// WebP at all. The bytes are copied out, so another encode or wasm memory
// growth cannot change a file already handed back.

/** Whether this engine can encode pages. */
export function encodesPages(engine) {
  return typeof engine?.exports?.mt_encode_jpeg === 'function'
}

/**
 * @param {object} engine from createEngine
 * @param {{width: number, height: number, data: Uint8Array | Uint8ClampedArray}} image straight RGBA8
 * @param {'jpeg' | 'webp-lossless'} format
 * @param {number} [quality] 0..1, JPEG only
 * @returns {Uint8Array} the file
 */
export function encodePage(engine, { width, height, data }, format, quality = 0.95) {
  if (!encodesPages(engine)) throw new Error('mt-text: this wasm does not encode pages')
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)
      || data.length !== width * height * 4) {
    throw new Error('mt-text: encodePage needs straight RGBA8 of its width and height')
  }
  const ex = engine.exports
  try {
    const input = ex.mt_encode_input_reserve(data.length)
    if (!input) throw new Error('mt-text: encodePage: the engine refused the input buffer')
    new Uint8Array(ex.memory.buffer, input, data.length).set(data)
    const code = format === 'jpeg'
      ? ex.mt_encode_jpeg(width, height, Math.min(100, Math.max(1, Math.round(quality * 100))))
      : format === 'webp-lossless'
        ? ex.mt_encode_webp_lossless(width, height)
        : -5
    if (code !== 1) throw new Error(`mt-text: encodePage: ${code === -5 ? 'a page this format cannot hold, or the allocation limit' : `error ${code}`}`)
    return new Uint8Array(ex.memory.buffer, ex.mt_encode_output_ptr(), ex.mt_encode_output_len()).slice()
  } finally {
    // A page is megabytes: neither buffer is kept for the next one.
    ex.mt_encode_release()
  }
}
