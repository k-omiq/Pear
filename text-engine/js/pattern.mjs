// A page crop turned into a repeating cell. The vectors are in crop pixels;
// the texture's axes are lattice coordinates. Use the crop centre as origin
// when mapping page points through the inverse cell matrix. Output bytes are
// copied so another extraction or wasm memory growth cannot change the tile.

/** Whether this engine can extract lattice cells from RGBA crops. */
export function extractsTiles(engine) {
  return typeof engine?.exports?.mt_pattern_extract === 'function'
}

/**
 * @param {object} engine from createEngine
 * @param {{width: number, height: number, data: Uint8Array | Uint8ClampedArray}} crop
 * @returns {{tile: {width: number, height: number, data: Uint8ClampedArray},
 *   cell: number[], periodic: boolean, confidence: number, period: number, angle: number}}
 */
export function extractTile(engine, { width, height, data }) {
  if (!extractsTiles(engine)) throw new Error('mt-text: this wasm does not extract pattern tiles')
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > 1024 || height > 1024
      || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)
      || data.length !== width * height * 4) {
    throw new Error('mt-text: extractTile needs a 1..1024 by 1..1024 crop of straight RGBA8')
  }
  const ex = engine.exports
  // The input may itself be a view into wasm; reserve can detach that view.
  const bytes = data.buffer === ex.memory.buffer ? new Uint8Array(data) : data
  const input = ex.mt_pattern_input_reserve(bytes.length)
  if (!input) throw new Error('mt-text: extractTile: the engine refused the input buffer')
  new Uint8Array(ex.memory.buffer, input, bytes.length).set(bytes)
  const code = ex.mt_pattern_extract(width, height)
  if (code !== 1) throw new Error(`mt-text: extractTile: ${code === -5 ? 'malformed crop or allocation limit' : `error ${code}`}`)
  const [periodic, confidence, period, angle, ax, ay, bx, by, side] =
    new Float64Array(ex.memory.buffer, ex.mt_pattern_output_info(), 9)
  const ptr = ex.mt_pattern_output_pixels()
  const pixels = new Uint8ClampedArray(ex.memory.buffer, ptr, side * side * 4).slice()
  return {
    tile: { width: side, height: side, data: pixels },
    cell: [ax, ay, bx, by], periodic: periodic === 1, confidence, period, angle,
  }
}
