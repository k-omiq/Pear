// Loader for the mt-text WebAssembly engine. Plain ESM with no dependencies;
// runs unchanged in node and in a browser.
//
//   const engine = await createEngine(wasmBytes)
//   const font = engine.addFont(fontBytes)
//   const face = engine.face(font, 22.5)
//   engine.advance(face, 'WHAT?!')
//
// Instantiation is the only async step. Every method afterwards is a plain
// synchronous call, which is what the layout code needs.
//
// Units: sizes, advances and ink extents are CSS pixels; `shapeUnits` is the
// raw run in font units. Text offsets are UTF-16 code units, i.e. JS string
// indices.

export const ABI_VERSION = 2

const RESULT_SLOTS = 16
const GLYPH_FIELDS = 6
const STATUS = {
  '-1': 'unreadable font or face index out of range',
  '-2': 'unknown font or chain id',
  '-3': 'text is not valid UTF-8',
  '-4': 'shaping failed',
  '-5': 'malformed paint spec',
}

export const SYNTH_BOLD = 1
export const SYNTH_OBLIQUE = 2
/** A face's `flags` hold the synthetic styles in the low byte and a fallback chain's handle above it. */
export const CHAIN_SHIFT = 8

/** The rules that are switches (`engine.setRule`), and their values. */
export const RULES = {
  boldAdvance: { id: 1, values: { unchanged: 0, webkit: 1 } },
  fontBox: { id: 2, values: { browser: 0, skia: 1 } },
}

/**
 * @param {BufferSource | WebAssembly.Module} source the bytes of mt_text.wasm, or a compiled module
 */
export async function createEngine(source) {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source)
  // The module imports nothing: no env, no wasi, no JS glue.
  const instance = await WebAssembly.instantiate(module, {})
  return wrap(instance)
}

function wrap(instance) {
  const ex = instance.exports
  const memory = ex.memory
  if (!(memory instanceof WebAssembly.Memory)) throw new Error('mt-text: wasm export "memory" is missing')
  const abi = ex.mt_abi_version()
  if (abi !== ABI_VERSION) throw new Error(`mt-text: wasm ABI ${abi}, loader expects ${ABI_VERSION}`)

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  // Views die when linear memory grows (the old ArrayBuffer is detached and
  // its length drops to 0), so they are re-made on demand, never trusted.
  let u8 = new Uint8Array(memory.buffer)
  let f64 = null
  const resultPtr = ex.mt_result_ptr()
  const bytes = () => (u8.byteLength === 0 ? (u8 = new Uint8Array(memory.buffer)) : u8)
  const result = () =>
    f64 === null || f64.byteLength === 0 ? (f64 = new Float64Array(memory.buffer, resultPtr, RESULT_SLOTS)) : f64

  let textPtr = 0
  let textCap = 0
  // The sound types' table, parsed once (`sfxKinds`).
  let sfxKindsCache = null
  // The bytes of each layout's letter quads (`sfxHit`), kept by the layout.
  const quadWires = new WeakMap()
  // Bytes of params last written by `putParams`.
  let paramsLen = 0

  /**
   * @typedef {{ vertical?: boolean | null, joinBars?: boolean, kern?: boolean, seed?: number,
   *   kind?: string | null, power?: number | null, rough?: number | null, momentum?: number | null,
   *   flow?: { from?: number | null, to?: number | null, pow?: number | null } | null,
   *   follow?: number | null, gap?: number | null, bigTighter?: number | null,
   *   slant?: number | null, rise?: number | null,
   *   jitter?: { rot?: number | null, size?: number | null, off?: number | null } | null,
   *   paths?: Array<{ a: [number, number], b: [number, number], bend: number }>,
   *   edits?: Array<{ group: number, index: number, dx: number, dy: number, rot: number, scale: number }> }} SfxParams
   */

  /**
   * Writes the SFX params in their wire form (text-engine/src/sfx/params.rs)
   * into the engine's params buffer. A number left null or out goes as NaN,
   * "unset", which the engine fills from the type: no type default is
   * copied here.
   */
  function putParams(params, what) {
    const { kinds } = engine.sfxKinds()
    const paths = (params.paths ?? []).slice(0, 4)
    const edits = params.edits ?? []
    const kind = params.kind == null ? -1 : kinds.findIndex((k) => k.id === params.kind)
    const wire = new DataView(new ArrayBuffer(12 + 14 * 8 + 4 + paths.length * 40 + 4 + edits.length * 40))
    let at = 0
    const u32 = (v) => {
      wire.setUint32(at, v >>> 0, true)
      at += 4
    }
    const f64 = (v) => {
      wire.setFloat64(at, +v, true)
      at += 8
    }
    const num = (v) => f64(v == null ? NaN : v)
    const dir = params.vertical == null ? 8 : params.vertical ? 1 : 0
    u32(dir | ((params.joinBars ?? true) ? 2 : 0) | ((params.kern ?? true) ? 4 : 0))
    u32(Math.max(0, Math.min(0xffffffff, Math.round(params.seed ?? 1))))
    u32(kind < 0 ? 0xffffffff : kind)
    const flow = params.flow ?? {}
    const jitter = params.jitter ?? {}
    for (const v of [
      params.power, params.rough, params.momentum, flow.from, flow.to, flow.pow, params.follow, params.gap,
      params.bigTighter, params.slant, params.rise, jitter.rot, jitter.size, jitter.off,
    ]) num(v)
    u32(paths.length)
    for (const q of paths) for (const v of [q.a[0], q.a[1], q.b[0], q.b[1], q.bend ?? 0]) f64(v)
    u32(edits.length)
    for (const e of edits) {
      u32(e.group)
      u32(e.index)
      for (const v of [e.dx ?? 0, e.dy ?? 0, e.rot ?? 0, e.scale ?? 1]) f64(v)
    }
    const ptr = ex.mt_sfx_params_reserve(wire.byteLength)
    if (!ptr) throw new Error(`mt-text: ${what}: the engine refused the params buffer`)
    bytes().set(new Uint8Array(wire.buffer), ptr)
    paramsLen = wire.byteLength
  }

  /** Writes `text` as UTF-8 into the engine's text buffer, returns its byte length. */
  function putText(text) {
    const n = text.length
    // A UTF-16 unit is at most 3 UTF-8 bytes.
    if (n * 3 > textCap) {
      textCap = Math.max(256, n * 6)
      textPtr = ex.mt_text_reserve(textCap)
    }
    const mem = bytes()
    // Comic dialogue is almost always ASCII, and a byte loop beats the call
    // into encodeInto for the short strings the breaker measures.
    let i = 0
    for (; i < n; i++) {
      const c = text.charCodeAt(i)
      if (c > 0x7f) break
      mem[textPtr + i] = c
    }
    if (i === n) return n
    return encoder.encodeInto(text, mem.subarray(textPtr, textPtr + textCap)).written
  }

  function check(code, what) {
    if (code < 0) throw new Error(`mt-text: ${what}: ${STATUS[code] ?? `error ${code}`}`)
    return code
  }

  const outBytes = () => {
    const ptr = ex.mt_out_ptr()
    const len = ex.mt_out_len()
    return bytes().subarray(ptr, ptr + len)
  }
  // The out buffer's `f64`s, read through a view of their own: the buffer
  // is bytes and need not sit on an 8-byte boundary.
  const outF64 = () => {
    const view = new DataView(memory.buffer, ex.mt_out_ptr(), ex.mt_out_len())
    return (i) => view.getFloat64(i * 8, true)
  }
  const outU32 = (count) => {
    const ptr = ex.mt_out_ptr()
    // Copied out: the buffer is reused by the next call.
    return new Uint32Array(memory.buffer.slice(ptr, ptr + count * 4))
  }

  function readInk(r) {
    return { width: r[0], left: r[1], right: r[2], ascent: r[3], descent: r[4], hasInk: r[5] === 1 }
  }

  const engine = {
    abiVersion: abi,

    /**
     * Registers one face of a font file (TTF/OTF/TTC). The bytes are copied
     * into wasm memory once and owned by the engine from then on.
     * @returns {number} font id
     */
    addFont(data, faceIndex = 0) {
      const src = data instanceof Uint8Array ? data : new Uint8Array(data)
      const ptr = ex.mt_alloc(src.byteLength)
      if (ptr === 0) throw new Error(`mt-text: could not allocate ${src.byteLength} bytes for a font`)
      bytes().set(src, ptr)
      // mt_font_add owns `ptr` from here, on failure too.
      const id = ex.mt_font_add(ptr, src.byteLength, faceIndex)
      if (id === 0) throw new Error('mt-text: unreadable font or face index out of range')
      return id
    },

    /** Registers another face of an already loaded file (TTC) without a second copy. */
    addSiblingFace(font, faceIndex) {
      const id = ex.mt_font_add_sibling(font, faceIndex)
      if (id === 0) throw new Error('mt-text: unknown font or face index out of range')
      return id
    },

    removeFont(font) {
      return ex.mt_font_remove(font) === 1
    },

    fontInfo(font) {
      check(ex.mt_font_info(font), 'fontInfo')
      const r = result()
      const lines = decoder.decode(outBytes()).split('\n')
      const mask = r[6]
      const line = (bit, i) =>
        mask & bit ? { ascent: r[i], descent: r[i + 1], lineGap: bit === 4 ? 0 : r[i + 2] } : null
      const axisCount = r[2]
      return {
        family: lines[0],
        subfamily: lines[1],
        fullName: lines[2],
        postScriptName: lines[3],
        typographicFamily: lines[4],
        unitsPerEm: r[0],
        glyphCount: r[1],
        isVariable: axisCount > 0,
        axes: lines.slice(5, 5 + axisCount).map((l) => {
          const [tag, min, def, max] = l.split(' ')
          return { tag, min: +min, default: +def, max: +max }
        }),
        facesInFile: r[3],
        byteLength: r[4],
        /** TrueType outlines (`glyf`) rather than CFF. */
        trueType: r[15] === 1,
        vertical: {
          useTypoMetrics: r[5] === 1,
          hhea: line(1, 7),
          typo: line(2, 10),
          win: mask & 4 ? { ascent: r[13], descent: r[14], lineGap: 0 } : null,
        },
      }
    },

    /**
     * A font at a size. `bold`/`italic` ask for the synthesised style;
     * `chain` (from `chainNew`) is where a letter the font lacks is looked for.
     */
    face(font, size, { bold = false, italic = false, chain = 0 } = {}) {
      return Object.freeze({
        font,
        size,
        flags: (bold ? SYNTH_BOLD : 0) | (italic ? SYNTH_OBLIQUE : 0) | (chain << CHAIN_SHIFT),
      })
    },

    /**
     * Sets one of the rules that are switches, e.g. `setRule('boldAdvance', 'webkit')`.
     * Every number measured before the call may be stale after it.
     */
    setRule(name, value) {
      const rule = RULES[name]
      if (!rule || !(value in rule.values)) throw new Error(`mt-text: unknown rule ${name}=${value}`)
      check(ex.mt_rule_set(rule.id, rule.values[value]), 'setRule')
    },

    /** An empty fallback chain; fonts pushed earlier are preferred. */
    chainNew() {
      return ex.mt_chain_new()
    },
    chainPush(chain, font, { bold = false, italic = false } = {}) {
      check(ex.mt_chain_push(chain, font, (bold ? SYNTH_BOLD : 0) | (italic ? SYNTH_OBLIQUE : 0)), 'chainPush')
    },
    chainFree(chain) {
      return ex.mt_chain_free(chain) === 1
    },

    /**
     * Advance of `text`, no letter spacing. Tab, LF, FF and CR are measured
     * as a space, as a canvas measures them.
     */
    advance(face, text) {
      const w = ex.mt_advance(face.font, face.size, face.flags, putText(text))
      if (w !== w) throw new Error('mt-text: advance failed (unknown font or chain, or shaping error)')
      return w
    },

    fontBox(face) {
      check(ex.mt_font_box(face.font, face.size, face.flags), 'fontBox')
      const r = result()
      return { ascent: r[0], descent: r[1] }
    },

    /** Ink extents, left-aligned, alphabetic baseline (canvas actualBoundingBox*). */
    lineInk(face, text) {
      check(ex.mt_line_ink(face.font, face.size, face.flags, putText(text)), 'lineInk')
      return readInk(result())
    },

    /** Ink extents of one glyph anchored at its centre on the `middle` baseline. */
    glyphInk(face, text) {
      check(ex.mt_glyph_ink(face.font, face.size, face.flags, putText(text)), 'glyphInk')
      return readInk(result())
    },

    /**
     * The shaped run in font units: 6 int32 per glyph
     * (glyph id, cluster, xAdvance, yAdvance, xOffset, yOffset).
     * @returns {Int32Array} a copy
     */
    shapeUnits(font, text) {
      const count = check(ex.mt_shape(font, putText(text)), 'shape')
      const ptr = ex.mt_run_ptr()
      return new Int32Array(memory.buffer.slice(ptr, ptr + count * GLYPH_FIELDS * 4))
    },

    /**
     * Glyphs with pen positions in pixels, and one entry per cluster for
     * carets. `x` is where the glyph's origin sits; `advance` is its own.
     */
    shapeLine(face, text) {
      const run = engine.shapeUnits(face.font, text)
      check(ex.mt_font_info(face.font), 'shapeLine')
      const scale = face.size / result()[0]
      const glyphs = []
      const clusters = []
      let pen = 0
      for (let i = 0; i < run.length; i += GLYPH_FIELDS) {
        const cluster = run[i + 1]
        const adv = run[i + 2]
        glyphs.push({
          id: run[i],
          cluster,
          x: (pen + run[i + 4]) * scale,
          y: run[i + 5] * scale,
          advance: adv * scale,
        })
        const last = clusters[clusters.length - 1]
        if (last && last.start === cluster) last.width += adv * scale
        else clusters.push({ start: cluster, x: pen * scale, width: adv * scale })
        pen += adv
      }
      return { advance: pen * scale, glyphs, clusters }
    },

    /** Whether this wasm has `lineCarets` (it is newer than the ABI number). */
    hasLineCarets: typeof ex.mt_line_carets === 'function',

    /**
     * Where a caret stands on a painted line: the pen of every cluster, from
     * the painter's own shaping of the line (`paint::shape_run`), letter
     * spacing included.
     * @returns {{ at: number[], x: number[], length: number, advance: number }}
     *   `at[k]` the UTF-16 offset of cluster k in `text` and `x[k]` its pen in
     *   pixels from the line's start, in drawing order; `advance` what the
     *   painter aligns the line by.
     */
    lineCarets(face, text, letterSpacing = 0) {
      if (!ex.mt_line_carets) throw new Error('mt-text: this wasm has no mt_line_carets; run npm run build:engine')
      const n = check(ex.mt_line_carets(face.font, face.size, face.flags, putText(text), letterSpacing), 'lineCarets')
      const ptr = ex.mt_out_ptr()
      // Read through a view of its own: the out buffer is bytes and need not
      // sit on an 8-byte boundary.
      const view = new DataView(memory.buffer, ptr, (n + 1) * 16)
      const at = new Array(n)
      const x = new Array(n)
      for (let i = 0; i < n; i++) {
        at[i] = view.getFloat64(i * 16, true)
        x[i] = view.getFloat64(i * 16 + 8, true)
      }
      return { at, x, length: view.getFloat64(n * 16, true), advance: view.getFloat64(n * 16 + 8, true) }
    },

    /** Whether this wasm has `lineInks` (it is newer than the ABI number). */
    hasLineInks: typeof ex.mt_line_inks === 'function',

    /**
     * The ink of each cluster of a line shaped whole, as the painter paints
     * a curved line's letters (`Engine::cluster_inks`): per cluster, in
     * drawing order, its UTF-16 offset and its ink from the middle of the
     * room the line gives it, on the `middle` baseline, as `glyphInk`
     * measures a glyph alone. Empty for a line whose clusters do not run
     * forwards. Letter spacing turns the ligatures off, as for the painter.
     * @returns {{ at: number, left: number, right: number, ascent: number, descent: number, hasInk: boolean }[]}
     */
    lineInks(face, text, letterSpacing = 0) {
      if (!ex.mt_line_inks) throw new Error('mt-text: this wasm has no mt_line_inks; run npm run build:engine')
      const n = check(ex.mt_line_inks(face.font, face.size, face.flags, putText(text), letterSpacing), 'lineInks')
      const view = new DataView(memory.buffer, ex.mt_out_ptr(), n * 48)
      const out = new Array(n)
      for (let i = 0; i < n; i++) {
        const f = (k) => view.getFloat64(i * 48 + k * 8, true)
        out[i] = { at: f(0), left: f(1), right: f(2), ascent: f(3), descent: f(4), hasInk: f(5) === 1 }
      }
      return out
    },

    /**
     * Whether this wasm has the sound-type SFX calls (`sfxPlace`, `sfxKinds`,
     * `sfxPick`, `sfxResolve`, `sfxOutline` and the handles' maths). All or
     * none: a wasm older than this loader reads its records differently.
     */
    hasSfxPlace: [
      'mt_sfx_place', 'mt_sfx_kinds', 'mt_sfx_pick', 'mt_sfx_resolve', 'mt_sfx_outline',
      'mt_sfx_hit', 'mt_sfx_turn', 'mt_sfx_scale', 'mt_sfx_move', 'mt_sfx_bend_for', 'mt_sfx_curve',
    ].every((name) => typeof ex[name] === 'function'),

    /**
     * The twelve sound types (text-engine/src/sfx/kinds.rs), parsed once and
     * the same object every time: read it, do not change it. A type is a
     * layout only; it carries no look.
     * @returns {{ kinds: Array<{ id: string, name: string, example: string, tag: string,
     *   dir: 'h' | 'v', flow: { from: number, to: number, pow: number }, follow: number,
     *   gap: number, slant: number, rise: number, jitter: { rot: number, size: number, off: number } }> }}
     *   the type as designed (the macros at 50)
     */
    sfxKinds() {
      if (sfxKindsCache) return sfxKindsCache
      if (!engine.hasSfxPlace) throw new Error('mt-text: this wasm has no mt_sfx_kinds; run npm run build:engine')
      check(ex.mt_sfx_kinds(), 'sfxKinds')
      sfxKindsCache = JSON.parse(decoder.decode(outBytes()))
      return sfxKindsCache
    },

    /**
     * Auto pick (text-engine/src/sfx/pick.rs): every sound type ranked for
     * `text`, best first, and the three macros the sound asks for.
     * @returns {{ order: string[], scores: number[], power: number, rough: number, momentum: number }}
     *   `scores` in `sfxKinds` order; the macros whole numbers 0..100, 50 the type as designed
     */
    sfxPick(text) {
      if (!engine.hasSfxPlace) throw new Error('mt-text: this wasm has no mt_sfx_pick; run npm run build:engine')
      check(ex.mt_sfx_pick(putText(String(text))), 'sfxPick')
      return JSON.parse(decoder.decode(outBytes()))
    },

    /**
     * The numbers an SFX lays out with: every one `params` leaves null or
     * out taken from its type and moved by the macros
     * (text-engine/src/sfx/params.rs), the ones it sets as they are.
     * @param {SfxParams} params as `sfxPlace` takes them (paths and edits are not read)
     * @returns {{ vertical: boolean, flow: { from: number, to: number, pow: number }, follow: number,
     *   gap: number, bigTighter: number, slant: number, rise: number,
     *   jitter: { rot: number, size: number, off: number } }}
     */
    sfxResolve(params = {}) {
      putParams({ ...params, paths: [], edits: [] }, 'sfxResolve')
      check(ex.mt_sfx_resolve(paramsLen), 'sfxResolve')
      const f = outF64()
      return {
        vertical: f(0) === 1,
        flow: { from: f(1), to: f(2), pow: f(3) },
        follow: f(4),
        gap: f(5),
        bigTighter: f(6),
        slant: f(7),
        rise: f(8),
        jitter: { rot: f(9), size: f(10), off: f(11) },
      }
    },

    /**
     * Lays out an SFX of the sound types (text-engine/src/sfx/place.rs): the
     * text's groups (lines, and the sides of a `/`) each along a path, the
     * letters sized, turned, leaned and kerned by their ink.
     *
     * @param {{ font: number, size: number, flags: number }} face from `engine.face`
     * @param {string} text
     * @param {SfxParams} params
     *   lengths in ems of the face's size, angles in degrees. A layout number
     *   left null or out is the type's (`kind`) moved by the macros, or the
     *   plain value with no type; `vertical` null is the type's direction.
     *   `power`, `rough`, `momentum` are 0..100, 50 (and null) the type as designed.
     * @returns {{ paths: Array<{ a: [number, number], b: [number, number], bend: number,
     *     ctrl: [number, number], mid: [number, number] }>,
     *   bounds: [number, number, number, number],
     *   letters: Array<{ x: number, y: number, rot: number, sx: number, sy: number, skew: number,
     *     start: number, end: number, group: number, index: number, dir: [number, number],
     *     em: number, adv: number, unit: number,
     *     quad: [[number, number], [number, number], [number, number], [number, number]],
     *     centre: [number, number], pen: number }>,
     *   cp: number[] }}
     *   pixels from the box's centre for `bounds`, the letters' `x, y`, `quad` and `centre`;
     *   `rot`, `skew` in radians; `start`/`end` the UTF-16 range of the text the letter
     *   draws; `paths` in ems, `ctrl` the curve's control point and `mid` its point at
     *   t = 0.5 (where the bend handle sits); `unit` the letter's px per em of its hand
     *   edit (its em before the edit's scale); `quad` its ink box corners (top left, top
     *   right, bottom right, bottom left of the glyph) through its whole transform, and
     *   `centre` the quad's middle; `pen` how much wider than at the face's size its outlines
     *   are drawn; `cp` per code point of `text` the index of the letter
     *   that draws it, or -1. Feed `x, y, rot, sx, sy, skew` to a curved paint job's run
     *   (`paint.mjs`).
     */
    sfxPlace(face, text, params = {}) {
      const textLen = putText(String(text))
      putParams(params, 'sfxPlace')
      const n = check(ex.mt_sfx_place(face.font, face.size, face.flags, textLen, paramsLen), 'sfxPlace')
      const f = outF64()
      const g = f(0)
      const bounds = [f(1), f(2), f(3), f(4)]
      const out = { paths: [], bounds, letters: [], cp: [] }
      for (let i = 0; i < g; i++) {
        const b = 5 + i * 9
        out.paths.push({
          a: [f(b), f(b + 1)], b: [f(b + 2), f(b + 3)], bend: f(b + 4),
          ctrl: [f(b + 5), f(b + 6)], mid: [f(b + 7), f(b + 8)],
        })
      }
      for (let i = 0; i < n; i++) {
        const b = 5 + g * 9 + i * 26
        out.letters.push({
          x: f(b), y: f(b + 1), rot: f(b + 2), sx: f(b + 3), sy: f(b + 4), skew: f(b + 5),
          start: f(b + 6), end: f(b + 7), group: f(b + 8), index: f(b + 9),
          dir: [f(b + 10), f(b + 11)], em: f(b + 12), adv: f(b + 13), unit: f(b + 14),
          quad: [[f(b + 15), f(b + 16)], [f(b + 17), f(b + 18)], [f(b + 19), f(b + 20)], [f(b + 21), f(b + 22)]],
          centre: [f(b + 23), f(b + 24)], pen: f(b + 25),
        })
      }
      const c0 = 5 + g * 9 + n * 26
      const c = f(c0)
      for (let i = 0; i < c; i++) out.cp.push(f(c0 + 1 + i))
      return out
    },

    /**
     * The outline of letter `index` (into `sfxPlace`'s `letters`) of the
     * layout the same arguments make: an SVG path `d`, one closed contour
     * per `M .. Z`, holes included, px from the box's centre (two decimals).
     */
    sfxOutline(face, text, params, index) {
      const textLen = putText(String(text))
      putParams(params ?? {}, 'sfxOutline')
      const len = check(ex.mt_sfx_outline(face.font, face.size, face.flags, textLen, paramsLen, index >>> 0), 'sfxOutline')
      return decoder.decode(outBytes().subarray(0, len))
    },

    /**
     * The letter at `x, y` (px, the frame `sfxPlace` gave the letters in):
     * the index of the topmost whose `quad` holds the point (later letters
     * are on top), else of the nearest within `slop` px, else -1.
     * @param {Array<{ quad: number[][] }>} letters `sfxPlace`'s, as they came
     */
    sfxHit(letters, x, y, slop = 0) {
      // The quads go over as bytes, made once per layout: a pointer move
      // copies them into the params buffer and nothing else.
      let wire = quadWires.get(letters)
      if (!wire) {
        const view = new DataView(new ArrayBuffer(letters.length * 64))
        letters.forEach((l, i) => l.quad.flat().forEach((v, k) => view.setFloat64(i * 64 + k * 8, v, true)))
        wire = new Uint8Array(view.buffer)
        quadWires.set(letters, wire)
      }
      const ptr = ex.mt_sfx_params_reserve(Math.max(1, wire.byteLength))
      if (!ptr) throw new Error('mt-text: sfxHit: the engine refused the params buffer')
      bytes().set(wire, ptr)
      // -1 is "no letter" here, not a status.
      const i = ex.mt_sfx_hit(letters.length, x, y, +slop || 0)
      return i < -1 ? check(i, 'sfxHit') : i
    },

    /**
     * One pointer move on the ring (Blender style): the angle swept round
     * `centre` from `from` (the previous pointer point) to `to`, added to
     * `total` (the running turn so far, degrees). Call it on every move and
     * hand back the `total` it returns: it counts on past half a turn and is
     * never rounded, so many small moves add up exactly.
     * @returns {{ total: number, shown: number }} `shown` is what the letter's
     *   edit stores: `total` snapped to `snapDeg` when that is above 0 (Shift: 15),
     *   in whole degrees, wrapped to -180..180, positive clockwise on screen
     */
    sfxTurn(centre, from, to, total, snapDeg = 0) {
      ex.mt_sfx_turn(centre[0], centre[1], from[0], from[1], to[0], to[1], +total || 0, +snapDeg || 0)
      const f = outF64()
      return { total: f(0), shown: f(1) }
    },

    /**
     * One pointer move on the scale handle: `startScale` times the pointer's
     * distance from `centre` now over at grab (`start`), 0.2..5, to two
     * decimals, or to steps of 0.05 when `snap`.
     */
    sfxScale(centre, start, now, startScale, snap = false) {
      return ex.mt_sfx_scale(centre[0], centre[1], start[0], start[1], now[0], now[1], +startScale, snap ? 1 : 0)
    },

    /**
     * One pointer move dragging a letter: the hand edit's `[dx, dy]` (ems of
     * the letter, three decimals, -20..20) from its value at grab plus the
     * pointer's travel from `start` to `now` (px).
     * @param {number | { unit: number }} letter the letter from `sfxPlace` (its `unit`
     *   is used), or its px per em of edit; NOT its `em`, which includes its own scale
     */
    sfxMove(letter, start, now, startDx, startDy) {
      const unit = typeof letter === 'number' ? letter : letter.unit
      ex.mt_sfx_move(+unit, start[0], start[1], now[0], now[1], +startDx || 0, +startDy || 0)
      const f = outF64()
      return [f(0), f(1)]
    },

    /**
     * The bend (-2..2, three decimals) that puts the middle of `path`'s curve
     * (its t = 0.5 point) nearest `pt`. In the path's units (ems).
     */
    sfxBendFor(path, pt) {
      return ex.mt_sfx_bend_for(path.a[0], path.a[1], path.b[0], path.b[1], +path.bend || 0, pt[0], pt[1])
    },

    /** `path`'s curve: its control point `ctrl` and its middle `mid` (t = 0.5), in its units. */
    sfxCurve(path) {
      ex.mt_sfx_curve(path.a[0], path.a[1], path.b[0], path.b[1], +path.bend || 0)
      const f = outF64()
      return { ctrl: [f(0), f(1)], mid: [f(2), f(3)] }
    },

    /**
     * Greedy UAX #14 wrapping (CSS `white-space: pre-wrap; overflow-wrap: break-word`).
     * @returns {Array<[number, number]>} [start, end) of every line, end excludes the newline
     */
    wrapPlain(face, text, { width, letterSpacing = 0 }) {
      const n = check(
        ex.mt_wrap_plain(face.font, face.size, face.flags, putText(text), width, letterSpacing),
        'wrapPlain',
      )
      const flat = outU32(n * 2)
      const lines = []
      for (let i = 0; i < n; i++) lines.push([flat[2 * i], flat[2 * i + 1]])
      return lines
    },

    /** UTF-16 offsets of the clusters neither the font nor its fallback chain has a glyph for. */
    missing(face, text) {
      const n = check(ex.mt_missing(face.font, face.flags, putText(text)), 'missing')
      return Array.from(outU32(n))
    },

    /**
     * Paints shaped lines: one round-join stroke of width `stroke.width`
     * (outside the outline; the pen is twice that, as canvas `lineWidth`),
     * unioned over all lines, under a solid fill.
     *
     * @param {{ width: number, height: number, transform?: number[],
     *   lines: Array<{ face: object, text: string, x: number, y: number }>,
     *   stroke?: { width: number, color: number }, fill?: number }} spec
     *   sizes in device pixels, `transform` as canvas setTransform(a..f),
     *   line origins in user space on the alphabetic baseline, colours 0xRRGGBBAA
     * @returns {{ width: number, height: number, data: Uint8ClampedArray }} straight-alpha RGBA8, a copy
     */
    paint(spec) {
      if (!ex.mt_paint_begin) throw new Error('mt-text: this wasm was built without the paint feature')
      const [a, b, c, d, e, f] = spec.transform ?? [1, 0, 0, 1, 0, 0]
      check(ex.mt_paint_begin(spec.width, spec.height, a, b, c, d, e, f), 'paint')
      for (const line of spec.lines) {
        const { face } = line
        check(ex.mt_paint_line(face.font, face.size, face.flags, putText(line.text), line.x, line.y), 'paint')
      }
      if (spec.stroke && spec.stroke.width > 0) {
        check(ex.mt_paint_stroke(spec.stroke.width * 2, spec.stroke.color >>> 0), 'paint')
      }
      if (spec.fill !== undefined) check(ex.mt_paint_fill(spec.fill >>> 0), 'paint')
      const len = check(ex.mt_paint_end(), 'paint')
      const ptr = ex.mt_out_ptr()
      return {
        width: spec.width,
        height: spec.height,
        data: new Uint8ClampedArray(memory.buffer.slice(ptr, ptr + len)),
      }
    },

    /** Bytes the engine holds for one font: the file plus its caches. */
    fontBytesHeld(font) {
      return ex.mt_font_bytes_held(font)
    },

    /** Live heap bytes inside the wasm instance. */
    heapLive() {
      return ex.mt_heap_live()
    },

    /** Size of the instance's linear memory. It only ever grows. */
    memoryBytes() {
      return memory.buffer.byteLength
    },

    /** Raw exports, for benchmarks that want to time the boundary itself. */
    exports: ex,
    putText,
  }
  return engine
}
