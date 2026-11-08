// Painting a glyph job with the mt-text engine. Plain ESM with no
// dependencies; runs unchanged in node and in a browser.
//
//   const engine = await createEngine(wasmBytes)        // engine.mjs
//   const font = engine.addFont(fontBytes)
//   const raster = paintJob(engine, { job, font, synth: { bold: false, italic: false },
//                                     transform: [2, 0, 0, 2, 0, 0], tiles })
//   // raster: { x, y, width, height, data } or null
//
// `job` is what `glyphJob` in src/lib/exporter.js returns, unchanged: plain
// data that says what to draw for one box. This file's whole work is to put
// that into one buffer the engine reads (the layout is documented at
// `decode` in text-engine/src/paint/job.rs) and to hand back the pixels.
//
// What is resolved here rather than in the engine:
//
// - colours. A job carries CSS colour strings; the engine takes four bytes.
//   Only the forms the app writes are read (see `parseColor`).
// - pattern tiles. A job names a pattern by its style; the caller supplies
//   the tile's pixels through `tiles`.
//
// What is NOT resolved here: which font a job's `face` means. The caller
// passes the font id, the synthetic style and the fallback chain beside the
// job (an engine face's `font` and `flags`).
//
// Where the glyphs go is the engine's business: the painter shapes each run
// as the engine measures it, under whichever rules are set (`engine.setRule`),
// fallback chain included. How a synthesised bold is DRAWN is the painter's,
// and a switch: `boldDraw` (see `BOLD_DRAW`).
//
// Nothing in this file calls a `Math` function whose result an engine may
// round differently (sin, cos, pow, ...): the numbers a job carries are
// passed through as they are and all arithmetic on them happens in the wasm.

import { CHAIN_SHIFT, SYNTH_BOLD, SYNTH_OBLIQUE } from './engine.mjs'

export const WIRE_VERSION = 10
const MAGIC = 0x4a50544d // "MTPJ"

const STATUS = {
  '-1': 'unreadable font or face index out of range',
  '-2': 'unknown font or chain id',
  '-3': 'text is not valid UTF-8',
  '-4': 'shaping failed',
  '-5': 'malformed paint job, a surface larger than the engine allows, or the job is over the painter\'s memory or run limit',
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const NUM = '\\s*([+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?)\\s*'
const RGB = new RegExp(`^rgba?\\(${NUM},${NUM},${NUM}(?:,${NUM})?\\)$`, 'i')

const byte = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v))

/**
 * A CSS colour as the app writes one, to `[r, g, b, a]` bytes, straight alpha.
 *
 * Read: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` and
 * `rgba(r, g, b, a)` with plain numbers. That is everything a style, a stroke,
 * a shadow or `stopColor` produces. Anything else (a colour name, `hsl()`,
 * percentages) throws: a painter that guessed would paint the wrong colour
 * without anyone being told.
 */
export function parseColor(css) {
  const s = String(css).trim()
  let m = HEX.exec(s)
  if (m) {
    let h = m[1]
    if (h.length <= 4) h = [...h].map((c) => c + c).join('')
    const n = parseInt(h.slice(0, 6), 16)
    const a = h.length === 8 ? parseInt(h.slice(6), 16) : 255
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]
  }
  m = RGB.exec(s)
  if (m) {
    const a = m[4] === undefined ? 1 : Number(m[4])
    return [byte(Number(m[1])), byte(Number(m[2])), byte(Number(m[3])), byte(a * 255)]
  }
  throw new Error(`mt-text: cannot read the colour ${JSON.stringify(css)}`)
}

const ALIGN = { left: 0, start: 0, center: 1, right: 2, end: 2 }

/**
 * How a synthesised bold is drawn (`request.boldDraw`):
 * - `rule` (the default): the way that goes with the engine's `boldAdvance`
 *   rule, `outset` for `unchanged` and `smear` for `webkit`. The engine's
 *   ink (`lineInk`) is measured for that drawing, so this is the one that
 *   paints what was measured.
 * - `outset`: the outline grown on every side by the engine's bold pen. Skia's way.
 * - `smear`: the glyph and a second one `size / 36` to its right, as one shape. WebKit's way.
 */
export const BOLD_DRAW = { rule: 0, outset: 1, smear: 2 }

/** The largest `request.weight` the engine accepts, in device pixels. */
export const MAX_WEIGHT = 64

// One buffer for every job, grown when a job does not fit.
let buf = new ArrayBuffer(4096)
let view = new DataView(buf)
let u8 = new Uint8Array(buf)
let at = 0
const encoder = new TextEncoder()

function need(n) {
  if (at + n <= buf.byteLength) return
  const grown = new ArrayBuffer(Math.max(buf.byteLength * 2, at + n))
  new Uint8Array(grown).set(u8.subarray(0, at))
  buf = grown
  view = new DataView(buf)
  u8 = new Uint8Array(buf)
}
function u32(v) {
  need(4)
  view.setUint32(at, v >>> 0, true)
  at += 4
}
function f64(v) {
  need(8)
  view.setFloat64(at, +v, true)
  at += 8
}
function rgba(css, opacity = 1) {
  const c = parseColor(css)
  need(4)
  u8[at] = c[0]
  u8[at + 1] = c[1]
  u8[at + 2] = c[2]
  u8[at + 3] = byte(c[3] * opacity)
  at += 4
}
function stops(list) {
  u32(list.length)
  for (const st of list) {
    f64(st.pos)
    rgba(st.color)
  }
}

/** Writes a fill; `tileIndex(fill)` gives a pattern's tile number or -1. */
function fill(f, tileIndex) {
  if (!f) return u32(0)
  switch (f.kind) {
    case 'solid':
      u32(1)
      return rgba(f.color)
    case 'linear':
      u32(2)
      f64(f.x0)
      f64(f.y0)
      f64(f.x1)
      f64(f.y1)
      return stops(f.stops)
    case 'radial':
      u32(3)
      f64(f.cx)
      f64(f.cy)
      f64(f.r)
      return stops(f.stops)
    case 'pattern': {
      u32(4)
      // No tile: the engine paints the style's flat colour, as the canvas
      // painter does when it cannot make a pattern.
      const i = tileIndex(f)
      u32(i < 0 ? 0xffffffff : i)
      f64(f.px)
      f64(f.ax)
      f64(f.ay)
      return rgba(f.style.color)
    }
    case 'screen': {
      const p = f.pattern ?? {}
      const kind = Object.hasOwn(PATTERN_KIND, p.kind) ? PATTERN_KIND[p.kind] : 0
      u32(5)
      u32(kind)
      // Built-in screens never request or send a tile.
      u32(kind === 255 ? tileIndex(f) : 0xffffffff)
      u32(p.mode === 'image' ? 1 : 0)
      u32(p.seed ?? 1)
      for (const v of f.basis) f64(v)
      f64(f.x)
      f64(f.y)
      f64((p.angle ?? 0) * (Math.PI / 180))
      f64(p.aspect ?? 1)
      f64(p.ox ?? 0)
      f64(p.oy ?? 0)
      f64(p.density ?? 0.5)
      f64(f.line)
      rgba(p.fg ?? '#000000', p.fgOpacity ?? 1)
      rgba(p.bg ?? '#ffffff', p.bgOpacity ?? 1)
      rgba(f.color)
      f64(f.cx)
      f64(f.cy)
      f64(f.reach)
      u32(f.fade ? 1 : 0)
      if (f.fade) {
        f64(f.fade.x0)
        f64(f.fade.y0)
        f64(f.fade.x1)
        f64(f.fade.y1)
      }
      return
    }
    default:
      throw new Error(`mt-text: unknown fill kind ${JSON.stringify(f.kind)}`)
  }
}

/**
 * Writes the box's mesh warp, `{ cols, rows, pts, x, y, w, h }`: `pts` are
 * `style.warp.pts`, `(cols + 1) * (rows + 1)` pairs relative to the corner of
 * the rectangle `x, y, w, h` the mesh is laid over, which is in job space. No
 * mesh, or one whose points do not match its grid, is written as none: the
 * job paints unbent, as every reader of a mesh draws one it cannot read.
 */
function mesh(m) {
  const cols = m?.cols | 0
  const rows = m?.rows | 0
  if (!m || cols < 1 || rows < 1 || !Array.isArray(m.pts) || m.pts.length !== (cols + 1) * (rows + 1)) return u32(0)
  u32(cols)
  u32(rows)
  f64(m.x)
  f64(m.y)
  f64(m.w)
  f64(m.h)
  for (const p of m.pts) {
    f64(p[0])
    f64(p[1])
  }
}

/**
 * Writes the box's roughening, `{ amount, detail, seed, x, y }`: the style's
 * own three numbers and the field's origin in job space. None, or one that
 * moves nothing, is written as none.
 */
function roughen(r) {
  const grit = r?.grit > 0 ? r.grit : 0
  if (!r || !((r.amount !== 0 && r.detail > 0) || grit > 0)) return u32(0)
  u32(1)
  f64(r.amount || 0)
  f64(r.detail > 0 ? r.detail : 0)
  f64(r.seed || 0)
  f64(r.x || 0)
  f64(r.y || 0)
  f64(grit)
}

/** Synthetic styles and fallback chain as an engine face's `flags`. */
function faceFlags(synth) {
  if (typeof synth === 'number') return synth
  if (!synth) return 0
  return (synth.bold ? SYNTH_BOLD : 0) | (synth.italic || synth.oblique ? SYNTH_OBLIQUE : 0)
}

/**
 * A job and what goes with it, as the bytes the engine reads.
 *
 * @param {object} request
 * @param {object} request.job as `glyphJob` returns it
 * @param {number} request.font font id from `engine.addFont`
 * @param {number} [request.size] font size in job units; defaults to `job.face.size`
 * @param {{bold?: boolean, italic?: boolean} | number} [request.synth] styles to synthesise,
 *   or an engine face's `flags`, which hold the fallback chain as well
 * @param {number} [request.chain] fallback chain (`engine.chainNew`) a letter the font
 *   lacks is drawn from; defaults to the one in `synth` when that is a face's flags, else none
 * @param {'rule' | 'outset' | 'smear'} [request.boldDraw] how a synthesised bold is drawn, see `BOLD_DRAW`
 * @param {number} [request.weight] extra weight in device pixels, 0 to `MAX_WEIGHT`: every
 *   filled glyph shape is grown by that much on every side before it is painted. Bands stay
 *   where they are (strokes of the font's own outline), so the heavier fill covers that much
 *   more of them. Default 0: the outline as the font has it.
 * @param {number[]} [request.transform] `[a, b, c, d, e, f]`, job space to device pixels;
 *   the canvas's current transform. Defaults to the identity.
 * @param {(fill: object) => ({width: number, height: number, data: ArrayLike<number>} | null)} [request.tiles]
 *   called for every pattern fill; returns the tile's straight RGBA8 pixels
 *   (`getImageData` of `patternTileCanvas(fill.style, TILE_SS)`), or null to
 *   have the pattern painted in the style's flat colour. The same object
 *   returned twice is sent once.
 * @returns {Uint8Array} a view of a buffer that the next call overwrites
 */
export function encodeJob(request) {
  at = 0
  writeJob(request)
  return u8.subarray(0, at)
}

// Both job and swatch buffers use the same tile table and object identity.
function tileCollector(tiles) {
  const sent = []
  const index = (f) => {
    const tile = tiles ? tiles(f) : null
    if (!tile || !(tile.width > 0) || !(tile.height > 0)) return -1
    if (tile.data.length !== tile.width * tile.height * 4) {
      throw new Error('mt-text: a pattern tile needs width * height * 4 bytes of RGBA')
    }
    const i = sent.indexOf(tile)
    return i >= 0 ? i : sent.push(tile) - 1
  }
  return { sent, index }
}

function writeTiles(sent) {
  u32(sent.length)
  for (const tile of sent) {
    u32(tile.width)
    u32(tile.height)
    need(tile.data.length)
    u8.set(tile.data, at)
    at += tile.data.length
  }
}

// The job's bytes, appended where the buffer stands.
// `collector` is the tile table, given when the box's effects already sent
// tiles into it.
function writeJob({ job, font, size, synth, chain, boldDraw = 'rule', weight = 0, transform, tiles }, collector = tileCollector(tiles)) {
  const { sent, index: tileIndex } = collector
  const m = transform ?? [1, 0, 0, 1, 0, 0]
  u32(MAGIC)
  u32(WIRE_VERSION)
  if (!Object.hasOwn(BOLD_DRAW, boldDraw)) throw new Error(`mt-text: unknown boldDraw ${JSON.stringify(boldDraw)}`)
  if (!(weight >= 0 && weight <= MAX_WEIGHT)) throw new Error(`mt-text: weight is 0 to ${MAX_WEIGHT} device pixels, not ${weight}`)
  const flags = faceFlags(synth)
  u32(font)
  u32(flags & ((1 << CHAIN_SHIFT) - 1))
  u32(chain ?? flags >>> CHAIN_SHIFT)
  u32(BOLD_DRAW[boldDraw])
  f64(size ?? job.face?.size)
  for (let i = 0; i < 6; i++) f64(m[i])
  f64(weight)
  // 4: no fill. The letters are cut out of the bands (or, with 2, out of the
  // silhouette, which is then the widest band's outer half alone).
  // 8: bands and fill letter by letter (`strokeOrder: 'each'`). 16: a
  // negative, the letters grown into one blob the bands go round.
  const negative = job.negative ?? null
  u32(
    (job.curved ? 1 : 0) |
      (job.silhouette ? 2 : 0) |
      (job.noFill ? 4 : 0) |
      (job.strokeOrder === 'each' ? 8 : 0) |
      (negative ? 16 : 0),
  )
  // An alignment the canvas does not know leaves its `textAlign` at "start".
  u32(ALIGN[job.align] ?? 0)
  f64(job.letterSpacing || 0)
  rgba(job.silhouette || '#000000')
  if (job.strokeJoin != null && job.strokeJoin !== 'round' && job.strokeJoin !== 'miter') {
    throw new Error(`mt-text: unknown strokeJoin ${JSON.stringify(job.strokeJoin)}`)
  }
  u32(job.strokeJoin === 'miter' ? 1 : 0)
  rgba(negative?.color || '#000000')
  f64(negative?.grow ?? 0)
  // More weight and lean on every glyph: `embolden` in synthesised bolds
  // (0 to 8), `slant` as an oblique's share of y (within 1.5).
  const embolden = job.embolden ?? 0
  const slant = job.slant ?? 0
  if (!(embolden >= 0 && embolden <= 8)) throw new Error(`mt-text: embolden is 0 to 8, not ${embolden}`)
  if (!(Math.abs(slant) <= 1.5)) throw new Error(`mt-text: slant is within 1.5, not ${slant}`)
  f64(embolden)
  f64(slant)
  u32(job.bands.length)
  for (const band of job.bands) {
    rgba(band.color)
    f64(band.opacity)
    f64(band.line)
  }
  fill(job.fill, tileIndex)
  mesh(job.mesh)
  roughen(job.roughen)
  u32(job.runs.length)
  for (const run of job.runs) {
    f64(run.x)
    f64(run.y)
    f64(run.rot ?? 0)
    // Curved text only: the glyph's own scale and lean (radians, positive
    // leans the top to the right), and its drip (job units its lower half is
    // pulled down by). A straight run is written 1, 1, 0, 0.
    f64(run.sx ?? 1)
    f64(run.sy ?? 1)
    f64(run.skew ?? 0)
    f64(run.drip ?? 0)
    // Curved text only: how many times as wide its bands are (an SFX
    // letter's rims follow its size), and whether it is an afterimage,
    // painted first with its fill alone.
    f64(run.pen ?? 1)
    u32(run.ghost ? 1 : 0)
    fill(run.fill, tileIndex)
    const text = String(run.text)
    // A UTF-16 unit is at most 3 UTF-8 bytes.
    need(4 + text.length * 3)
    const { written } = encoder.encodeInto(text, u8.subarray(at + 4))
    u32(written)
    at += written
  }
  writeTiles(sent)
}

export const BOX_WIRE_VERSION = 12
const BOX_MAGIC = 0x4250544d // "MTPB"
const CLIP_MODE = { include: 1, exclude: 2 }
// Advanced Blending's Channels, in the wire's bit order, and Blend If's
// sliders in the wire's order (`decode_box`).
const BLEND_CHANNELS = ['r', 'g', 'b']
const BLEND_IF_CHANNELS = ['gray', 'red', 'green', 'blue']
const FULL_RANGE = [0, 0, 255, 255]

// The 32 bytes of a Blend If (`style.blending.blendIf`), or null when no
// slider is off its end. A range is [black low, black high, white low, white
// high], whole levels, as `normalizeBlending` keeps it.
function blendIfRanges(blendIf) {
  if (!blendIf) return null
  const out = new Uint8Array(32)
  let any = false
  BLEND_IF_CHANNELS.forEach((ch, i) => {
    ;['this', 'under'].forEach((side, j) => {
      const q = blendIf[ch]?.[side] ?? FULL_RANGE
      for (let k = 0; k < 4; k++) {
        const v = Math.min(255, Math.max(0, Math.round(Number(q[k] ?? FULL_RANGE[k]) || 0)))
        out[(i * 2 + j) * 4 + k] = v
        if (v !== FULL_RANGE[k]) any = true
      }
    })
  })
  return any ? out : null
}

// Photoshop's blend modes by the number the engine reads (`Blend::from_u32`
// in text-engine/src/paint/fx/blend.rs), in its menu's order.
export const BLEND_MODE_IDS = Object.freeze(
  Object.fromEntries(
    [
      'normal', 'dissolve',
      'darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color',
      'lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color',
      'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix',
      'difference', 'exclusion', 'subtract', 'divide',
      'hue', 'saturation', 'color', 'luminosity',
    ].map((name, i) => [name, i]),
  ),
)

// The contour presets by the number the engine reads (`PRESET_NAMES` in
// fx/contour.rs); a curve of points is 255.
export const CONTOUR_IDS = Object.freeze(
  Object.fromEntries(
    [
      'linear', 'cone', 'cone-inverted', 'cove-deep', 'cove-shallow', 'gaussian',
      'half-round', 'ring', 'ring-double', 'rolling-slope-descending', 'rounded-steps', 'sawtooth-1',
    ].map((name, i) => [name, i]),
  ),
)
const CONTOUR_POINTS = 255

function blendId(name) {
  const id = BLEND_MODE_IDS[name ?? 'normal']
  if (id === undefined) throw new Error(`mt-text: unknown blend mode ${JSON.stringify(name)}`)
  return id
}

// One drop shadow (`decode_box`'s shadow record).
function shadowRecord(sh) {
  rgba(sh.color)
  f64(sh.opacity)
  f64(sh.x)
  f64(sh.y)
  f64(sh.size ?? 0)
  f64(sh.grow ?? 0)
  f64(sh.spread ?? 0)
  f64(sh.noise ?? 0)
  u32(blendId(sh.blend))
  // 4 (v11): an SFX copy laid at its exact throw; without it the engine
  // rounds the throw to whole pixels, as Photoshop lays a Drop Shadow.
  u32((sh.knockout ? 1 : 0) | (sh.contour?.aa ? 2 : 0) | (sh.exact ? 4 : 0))
  u32((sh.seed ?? 0) >>> 0)
  contourRecord(sh.contour)
}

// A contour: a preset's number, or 255 and its points.
function contourRecord(contour) {
  const preset = contour?.preset ?? 'linear'
  if (preset === 'custom') {
    const pts = contour.pts ?? []
    u32(CONTOUR_POINTS)
    u32(pts.length)
    for (const q of pts) {
      f64(q[0])
      f64(q[1])
      u32(q[2] ? 1 : 0)
    }
    return
  }
  const id = CONTOUR_IDS[preset]
  if (id === undefined) throw new Error(`mt-text: unknown contour ${JSON.stringify(preset)}`)
  u32(id)
}

const EFFECT_KIND = { outerGlow: 1, innerGlow: 2, innerShadow: 3, colorOverlay: 4, stroke: 5, gradientOverlay: 6, patternOverlay: 7, satin: 8, bevel: 9 }
// Bevel & Emboss's Style and Technique by the number the engine reads
// (`BevelStyle::from_u32`, `BevelTechnique::from_u32` in fx/bevel.rs).
export const BEVEL_STYLE_IDS = Object.freeze({ inner: 0, outer: 1, emboss: 2, pillow: 3, stroke: 4 })
export const BEVEL_TECHNIQUE_IDS = Object.freeze({ smooth: 0, 'chisel-hard': 1, 'chisel-soft': 2 })
const GRADIENT_STYLE = { linear: 0, radial: 1, angle: 2, reflected: 3, diamond: 4, shapeburst: 5 }
const NOISE_MODEL = { rgb: 0, hsb: 1, lab: 2 }
const STROKE_POSITION = { outside: 0, inside: 1, center: 2 }

// An effect gradient (`Reader::gradient`): Photoshop's Style, Angle
// (degrees), Scale (1 is 100 %), Reverse, the centre's offset as a share of
// the frame, then the colour stops and the opacity stops, each by position.
// A stop is `{pos, color, opacity?}`; with every stop opaque no opacity
// stops are sent. `type: 'noise'` sends `noise` (`{seed, roughness, model,
// min: [3], max: [3], restrict, transparency}`) too, whose colours the
// engine paints in place of the stops'.
function gradientRecord(g) {
  const style = GRADIENT_STYLE[g?.style ?? 'linear']
  if (style === undefined) throw new Error(`mt-text: unknown gradient style ${JSON.stringify(g.style)}`)
  u32(style)
  f64(g.angle ?? 90)
  f64(g.scale ?? 1)
  u32(g.reverse ? 1 : 0)
  f64(g.offset?.[0] ?? 0)
  f64(g.offset?.[1] ?? 0)
  const list = [...(g.stops ?? [])].sort((a, b) => a.pos - b.pos)
  u32(list.length)
  for (const st of list) {
    f64(st.pos)
    rgba(st.color)
  }
  const fades = list.some((st) => (st.opacity ?? 1) < 1)
  u32(fades ? list.length : 0)
  if (fades) {
    for (const st of list) {
      f64(st.pos)
      f64(st.opacity ?? 1)
    }
  }
  const n = g.type === 'noise' ? g.noise : null
  u32(n ? 1 : 0)
  if (!n) return
  const model = NOISE_MODEL[n.model ?? 'rgb']
  if (model === undefined) throw new Error(`mt-text: unknown noise colour model ${JSON.stringify(n.model)}`)
  u32((n.seed ?? 0) >>> 0)
  f64(n.roughness ?? 0.5)
  u32(model)
  for (let i = 0; i < 3; i++) {
    f64(n.min?.[i] ?? 0)
    f64(n.max?.[i] ?? 1)
  }
  u32((n.restrict ? 1 : 0) | (n.transparency ? 2 : 0))
}

// What a stroke paints with (`Reader::paint`): a colour, a gradient or a
// glyph job's fill record.
function paintRecord(p, tileIndex) {
  if (p.kind === 'gradient') {
    u32(1)
    return gradientRecord(p.gradient)
  }
  if (p.kind === 'fill') {
    u32(2)
    return fill(p.fill, tileIndex)
  }
  u32(0)
  rgba(p.color)
}

// A bevel's highlight or shadow: colour, opacity, mode.
function shadeRecord(sh, blend, color) {
  rgba(sh?.color ?? color)
  f64(sh?.opacity ?? 0.75)
  u32(blendId(sh?.blend ?? blend))
}

// Bevel & Emboss (`Reader::bevel`): the defaults are Photoshop's dialog's.
// A `contour` turns the Contour element on (its `range` is carried, never
// painted); a `texture` with a `fill` turns the Texture element on.
function bevelRecord(fx, tileIndex) {
  const style = BEVEL_STYLE_IDS[fx.style ?? 'inner']
  if (style === undefined) throw new Error(`mt-text: unknown bevel style ${JSON.stringify(fx.style)}`)
  const technique = BEVEL_TECHNIQUE_IDS[fx.technique ?? 'smooth']
  if (technique === undefined) throw new Error(`mt-text: unknown bevel technique ${JSON.stringify(fx.technique)}`)
  u32(style)
  u32(technique)
  f64(fx.depth ?? 1)
  f64(fx.size ?? 5)
  f64(fx.soften ?? 0)
  f64(fx.angle ?? 120)
  f64(fx.altitude ?? 30)
  shadeRecord(fx.highlight, 'screen', '#ffffff')
  shadeRecord(fx.shadow, 'multiply', '#000000')
  const c = fx.contour ?? null
  const t = fx.texture?.fill ? fx.texture : null
  u32((fx.direction === 'down' ? 0 : 1) | (fx.gloss?.aa ? 2 : 0) | (c ? 4 : 0) | (c?.aa ? 8 : 0) | (t ? 16 : 0) | (t?.invert ? 32 : 0))
  contourRecord(fx.gloss)
  if (c) {
    contourRecord(c)
    f64(c.range ?? 0.5)
  }
  if (t) {
    f64(t.depth ?? 1)
    paintRecord({ kind: 'fill', fill: t.fill }, tileIndex)
  }
}

// One layer effect past the drop shadows (`decode_box`'s effect record).
// `tileIndex` numbers a pattern's tile in the glyph job's table.
function effectRecord(fx, tileIndex) {
  const kind = EFFECT_KIND[fx.kind]
  if (!kind) throw new Error(`mt-text: unknown effect ${JSON.stringify(fx.kind)}`)
  u32(kind)
  if (kind === 9) return bevelRecord(fx, tileIndex)
  if (kind === 5) {
    const position = STROKE_POSITION[fx.position ?? 'outside']
    if (position === undefined) throw new Error(`mt-text: unknown stroke position ${JSON.stringify(fx.position)}`)
    f64(fx.size ?? 0)
    u32(position)
    f64(fx.opacity)
    u32(blendId(fx.blend))
    u32((fx.seed ?? 0) >>> 0)
    return paintRecord(fx.paint ?? { kind: 'color', color: fx.color }, tileIndex)
  }
  if (kind === 6 || kind === 7) {
    f64(fx.opacity)
    u32(blendId(fx.blend))
    return paintRecord(kind === 6 ? { kind: 'gradient', gradient: fx.gradient } : { kind: 'fill', fill: fx.fill }, tileIndex)
  }
  rgba(fx.color)
  f64(fx.opacity)
  u32(blendId(fx.blend))
  if (kind === 4) return
  if (kind === 8) {
    f64(fx.angle ?? 19)
    f64(fx.distance ?? 11)
    f64(fx.size ?? 14)
    u32((fx.invert ? 1 : 0) | (fx.contour?.aa ? 2 : 0))
    contourRecord(fx.contour)
    return
  }
  if (kind === 3) {
    f64(fx.x)
    f64(fx.y)
    f64(fx.size ?? 0)
    f64(fx.choke ?? 0)
    f64(fx.noise ?? 0)
    u32((fx.seed ?? 0) >>> 0)
    contourRecord(fx.contour)
    return
  }
  u32(fx.technique === 'precise' ? 1 : 0)
  f64(fx.size ?? 0)
  f64((kind === 2 ? fx.choke : fx.spread) ?? 0)
  f64(fx.range ?? 0.5)
  f64(fx.noise ?? 0)
  u32((fx.seed ?? 0) >>> 0)
  contourRecord(fx.contour)
  if (kind === 2) u32(fx.source === 'center' ? 1 : 0)
  u32(fx.gradient ? 1 : 0)
  if (fx.gradient) gradientRecord(fx.gradient)
  // Quality > Jitter (v11), 0 to 1: moves each pixel's sample of the
  // gradient; the engine ignores it on a colour glow.
  f64(fx.jitter ?? 0)
}

// The box's brush ink (v12, `decode_box`'s ink record): the strokes as
// `normalizeInkStroke` (src/lib/data.js) keeps them, each number held to the
// range the engine takes. The tip table is empty while only round strokes
// are sent: every stroke and every cycle entry is the round dab.
const ROUND_TIP = 0xffffffff
const INK_FLIP = { off: 0, on: 1, random: 2 }
const INK_ORDER = { repeat: 0, reverse: 1, once: 2, random: 3 }
const MAX_INK_COORD = 65536
const MAX_SEED = 9007199254740991
const held = (v, d, lo, hi) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}
// `aaLevel` (src/lib/brush.js): a switch is the two ends of the grades.
function inkAA(v) {
  if (v === false) return 0
  if (v === true || v === undefined || v === null) return 3
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(3, Math.max(0, n)) : 3
}
const factor = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1)

function inkStroke(k, pts) {
  const tex = k.texture ?? {}
  const tin = k.taperIn ?? {}
  const tout = k.taperOut ?? {}
  const cycle = Array.isArray(k.tips) && k.tips.length > 1 ? k.tips.length : 0
  u32(
    (k.ribbon === true ? 1 : 0) |
      (k.followDir === true ? 2 : 0) |
      (k.darkenTips === true ? 4 : 0) |
      (k.blend === 'density' ? 8 : 0) |
      (k.waterEdge === true ? 16 : 0) |
      (tex.on === true ? 32 : 0) |
      (tex.stress === true ? 64 : 0) |
      (inkAA(k.antialias) << 8) |
      ((INK_FLIP[k.flipX] ?? 0) << 10) |
      ((INK_FLIP[k.flipY] ?? 0) << 12) |
      ((cycle ? (INK_ORDER[k.tipOrder] ?? 0) : 0) << 14) |
      (tin.on ? 1 << 16 : 0) |
      (tin.mode === 'pct' ? 1 << 17 : 0) |
      (tout.on ? 1 << 18 : 0) |
      (tout.mode === 'pct' ? 1 << 19 : 0),
  )
  rgba(k.color ?? '#000000')
  f64(held(k.opacity, 1, 0, 1))
  f64(held(k.size, 24, 0.5, 2000))
  f64(held(k.spacing, 10, 1, 200))
  f64(held(k.hardness, 100, 0, 100))
  f64(held(k.angle, 0, -36000, 36000))
  f64(held(k.angleJitter, 0, 0, 100))
  f64(held(k.flatness, 1, 0.01, 1))
  f64(held(k.corners, 0, 0, 180))
  f64(held(tin.len, 20, 0, 500))
  f64(held(tin.ratio, 60, 0, 100))
  f64(held(tout.len, 20, 0, 500))
  f64(held(tout.ratio, 60, 0, 100))
  f64(held(k.waterEdgeWidth, 4, 1, 20))
  f64(held(k.waterEdgePower, 0.5, 0, 1))
  f64(held(k.waterEdgeDark, 0, 0, 1))
  f64(held(k.waterEdgeBlur, 0, 0, 20))
  f64(held(tex.density, 0.5, 0, 1))
  f64(held(tex.scale, 100, 10, 1000))
  f64(held(k.seed, 1, -MAX_SEED, MAX_SEED))
  u32(ROUND_TIP)
  u32(cycle)
  for (let i = 0; i < cycle; i++) u32(ROUND_TIP)
  const stride = pts.some((p) => p.length > 3) ? 5 : 3
  u32(pts.length)
  u32(stride)
  for (const p of pts) {
    f64(held(p[0], 0, -MAX_INK_COORD, MAX_INK_COORD))
    f64(held(p[1], 0, -MAX_INK_COORD, MAX_INK_COORD))
    f64(factor(p[2]))
    if (stride === 5) {
      f64(factor(p[3]))
      f64(factor(p[4]))
    }
  }
}

function inkRecord(ink) {
  // A point that is not one is dropped, as the normaliser drops it, and a
  // stroke left with none is no stroke.
  const strokes = []
  for (const k of ink?.strokes ?? []) {
    const pts = (Array.isArray(k?.pts) ? k.pts : []).filter((p) => Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1]))
    if (pts.length) strokes.push([k, pts])
  }
  if (!strokes.length) {
    u32(0)
    return
  }
  u32(1)
  f64(held(ink.ox, 0, -MAX_INK_COORD, MAX_INK_COORD))
  f64(held(ink.oy, 0, -MAX_INK_COORD, MAX_INK_COORD))
  u32(0)
  u32(strokes.length)
  for (const [k, pts] of strokes) inkStroke(k, pts)
}

// One mask shape, as `style.clip.shapes` holds it. A shape of a kind this
// does not know, or with nothing to draw, is not written (`drawClipShapes`
// draws nothing for it either).
function clipShape(sh) {
  if (sh?.kind === 'ellipse') {
    u32(1)
    f64(sh.cx)
    f64(sh.cy)
    f64(sh.rx)
    f64(sh.ry)
    return true
  }
  const pts = Array.isArray(sh?.pts) ? sh.pts : []
  if (!pts.length || (sh.kind !== 'poly' && sh.kind !== 'stroke')) return false
  if (sh.kind === 'poly') u32(2)
  else {
    u32(3)
    f64(sh.size || 0)
  }
  u32(pts.length)
  for (const q of pts) {
    f64(q[0])
    f64(q[1])
  }
  return true
}

/**
 * A finished box, as the bytes the engine reads: its glyph job and what is
 * laid over and under it. The layout is documented at `decode_box` in
 * text-engine/src/paint/ and in docs/text-port/FULL_RUST_PAINT.md.
 *
 * Every length here is in the job's own units, and the job's `transform`
 * carries it to device pixels with the glyphs: a shadow's offset turns with a
 * turned box, and a blur grows with the scale.
 *
 * @param {object} request everything `encodeJob` takes for the glyph job, and
 * @param {number} request.width the surface, device pixels; its corner is (0, 0)
 * @param {number} request.height
 * @param {{color: string, opacity: number, x: number, y: number, size: number, grow?: number,
 *   spread?: number, noise?: number, blend?: string, knockout?: boolean, exact?: boolean,
 *   seed?: number, contour?: {preset: string, aa?: boolean, pts?: number[][]}}[]} [request.shadows]
 *   `style.shadows` resolved (`boxShadows`), first on top: Photoshop's Drop Shadow, its
 *   Size, Spread, Noise and Contour, its mode and its knockout, thrown to whole pixels;
 *   `exact` lays an SFX copy at its throw; `grow` widens the silhouette (an extrude's edge). A run of plain shadows alike but for `x`, `y` and
 *   `opacity` paints the silhouette once.
 * @param {number} [request.blur] the whole-box blur, a gaussian's sigma
 * @param {{dx: number, dy: number, w: number}[]} [request.taps] `motionBlurTaps`
 * @param {{mode: 'include' | 'exclude', x: number, y: number, shapes: object[]} | null} [request.clip]
 *   the visibility mask: `style.clip.shapes`, which are box-local, and the
 *   box's corner in job space
 * @param {string} [request.blend] the letters' blend mode (`style.blendMode`)
 * @param {number} [request.fillOpacity] Photoshop's Fill Opacity, 0 to 1; over a backdrop,
 *   in one of the special eight modes (Color Burn, Linear Burn, Color Dodge, Linear Dodge,
 *   Vivid Light, Linear Light, Hard Mix, Difference), part of the blend, as in Photoshop
 * @param {boolean} [request.blendInterior] Blend Interior Effects as Group: Fill Opacity
 *   fades the overlays, the satin and the inner glows with the fill
 * @param {{r?: boolean, g?: boolean, b?: boolean} | null} [request.channels] Advanced
 *   Blending's Channels (`style.blending.channels`): a channel that is false shows the
 *   backdrop's. Painted over a backdrop only
 * @param {{gray?: {this?: number[], under?: number[]}, red?: object, green?: object,
 *   blue?: object} | null} [request.blendIf] Blend If (`style.blending.blendIf`): per
 *   channel, This Layer and Underlying Layer, each [black low, black high, white low,
 *   white high] on 0 to 255, in that order. Painted over a backdrop only
 * @param {{kind: 'outerGlow' | 'innerGlow' | 'innerShadow' | 'colorOverlay' | 'stroke' |
 *   'gradientOverlay' | 'patternOverlay' | 'satin' | 'bevel', color?: string,
 *   opacity: number, blend?: string, technique?: 'softer' | 'precise', source?: 'edge' | 'center',
 *   size?: number, spread?: number, choke?: number, range?: number, noise?: number, jitter?: number,
 *   x?: number, y?: number, seed?: number, contour?: {preset: string, pts?: number[][], aa?: boolean},
 *   angle?: number, distance?: number, invert?: boolean,
 *   gradient?: object, position?: 'outside' | 'inside' | 'center',
 *   paint?: {kind: 'color', color: string} | {kind: 'gradient', gradient: object} | {kind: 'fill', fill: object},
 *   fill?: object, style?: 'inner' | 'outer' | 'emboss' | 'pillow' | 'stroke',
 *   technique?: 'smooth' | 'chisel-hard' | 'chisel-soft', depth?: number, direction?: 'up' | 'down',
 *   soften?: number, altitude?: number, gloss?: {preset: string, pts?: number[][], aa?: boolean},
 *   highlight?: {blend: string, color: string, opacity: number},
 *   shadow?: {blend: string, color: string, opacity: number},
 *   texture?: {depth: number, invert?: boolean, fill: object}}[]} [request.effects]
 *   the layer effects past the drop shadows, resolved: of a kind, first on top. A glow's
 *   `gradient` runs along it in place of its colour, `jitter` (0 to 1) scattering each
 *   pixel's sample of it; a gradient is `{style, angle, scale,
 *   reverse, offset: [x, y], stops: [{pos, color, opacity?}], type?, noise?}` (style
 *   'shapeburst' runs from the painted shape's edge in; type 'noise' paints `noise`). A stroke paints a colour,
 *   a gradient or a fill (a pattern, as a glyph job's fill), and a pattern overlay its
 *   `fill`, in job units. A satin throws two copies `distance` apart along its own
 *   `angle` (degrees; no global light) and lays the gap, `invert`ed or not. A bevel
 *   (`kind: 'bevel'`) is Photoshop's Bevel & Emboss: `style` (Stroke Emboss is
 *   'stroke': it raises the strokes' band), `technique`, `depth` (1 is 100 %),
 *   `direction`, `size` and `soften` in job units, `angle` and `altitude` with Use
 *   Global Light already resolved (the light turns with a turned box), the Gloss
 *   Contour `gloss`, the `highlight` and the `shadow`; a `contour` (a contour and
 *   its `range`, which is carried and not painted) turns the Contour element on, a
 *   `texture` (Texture Depth, Invert and the pattern as a glyph job's `fill`) the
 *   Texture element. Unset fields take Photoshop's defaults: inner, smooth, 100 %,
 *   up, size 5, soften 0, 120 and 30 degrees, Linear, Screen white and Multiply
 *   black at 75 %
 * @param {{ox: number, oy: number, strokes: object[]} | null} [request.ink] the box's
 *   brush ink: its strokes as `normalizeInkStroke` keeps them, stated from the box's
 *   corner (ox, oy) in the job's units. Round dabs only: a stroke's imported tip is
 *   painted round
 * @param {Uint8Array | Uint8ClampedArray | null} [request.backdrop] the page under
 *   the surface, straight RGBA8 of `width * height`, read as opaque: what a blend mode
 *   blends with
 * @returns {Uint8Array} a view of a buffer that the next call overwrites
 */
export function encodeBox(request) {
  const { width, height, shadows = [], blur = 0, taps = [], clip = null, blend = 'normal', fillOpacity = 1, blendInterior = false, channels = null, blendIf = null, effects = [], ink = null, backdrop = null } = request
  at = 0
  u32(BOX_MAGIC)
  u32(BOX_WIRE_VERSION)
  u32(width)
  u32(height)
  u32(shadows.length)
  for (const sh of shadows) shadowRecord(sh)
  f64(blur)
  u32(taps.length)
  for (const t of taps) {
    f64(t.dx)
    f64(t.dy)
    f64(t.w)
  }
  const mode = clip ? CLIP_MODE[clip.mode] : 0
  if (clip && !mode) throw new Error(`mt-text: unknown clip mode ${JSON.stringify(clip.mode)}`)
  u32(mode || 0)
  if (mode) {
    f64(clip.x)
    f64(clip.y)
    // The count is written once the shapes are, less the ones not drawn.
    const countAt = at
    u32(0)
    let n = 0
    for (const sh of clip.shapes ?? []) if (clipShape(sh)) n++
    view.setUint32(countAt, n, true)
  }
  u32(blendId(blend))
  f64(fillOpacity)
  // The blending flags (v9): 1 Blend Interior Effects as Group.
  u32(blendInterior ? 1 : 0)
  // The channels left out (v10): bit 0 R, 1 G, 2 B.
  u32(BLEND_CHANNELS.reduce((m, k, i) => (channels?.[k] === false ? m | (1 << i) : m), 0))
  // Blend If (v10): 0 none, or 1 and Gray, R, G, B, each This Layer then
  // Underlying, each black low, black high, white low, white high.
  const ranges = blendIfRanges(blendIf)
  u32(ranges ? 1 : 0)
  if (ranges) {
    need(ranges.length)
    u8.set(ranges, at)
    at += ranges.length
  }
  // The effects' pattern tiles go in the glyph job's table, ahead of its own.
  const collector = tileCollector(request.tiles)
  u32(effects.length)
  for (const fx of effects) effectRecord(fx, collector.index)
  // The brush ink (v12): 0 none, or 1 and its record.
  if (ink) inkRecord(ink)
  else u32(0)
  if (backdrop) {
    if (backdrop.length !== width * height * 4) throw new Error('mt-text: a backdrop must be the surface, RGBA')
    u32(1)
    need(backdrop.length)
    u8.set(backdrop, at)
    at += backdrop.length
  } else u32(0)
  const lenAt = at
  u32(0)
  writeJob(request, collector)
  view.setUint32(lenAt, at - lenAt - 4, true)
  return u8.subarray(0, at)
}

// What the engine left in its result: where the raster goes and its pixels.
function rasterOf(ex, asView) {
  const [x, y, width, height] = new Float64Array(ex.memory.buffer, ex.mt_paint_job_result(), 4)
  const pixels = ex.mt_paint_job_pixels()
  const len = width * height * 4
  const data = asView
    ? new Uint8ClampedArray(ex.memory.buffer, pixels, len)
    : new Uint8ClampedArray(ex.memory.buffer.slice(pixels, pixels + len))
  return { x, y, width, height, data }
}

// Screen ids from screen.rs; the first eleven also name the legacy tiles.
const PATTERN_KIND = {
  dots: 0,
  halftone: 1,
  stripes: 2,
  hstripes: 3,
  diagonal: 4,
  'diagonal-alt': 5,
  crosshatch: 6,
  checker: 7,
  grid: 8,
  vlines: 9,
  hlines: 10,
  'halftone-fade': 11,
  'square-dots': 12,
  'diamond-dots': 13,
  'line-tone': 14,
  sand: 15,
  stipple: 16,
  'speed-lines': 17,
  burst: 18,
  rings: 19,
  waves: 20,
  zigzag: 21,
  bricks: 22,
  scales: 23,
  hex: 24,
  triangles: 25,
  plus: 26,
  stars: 27,
  hearts: 28,
  kakeami: 29,
  glitch: 30,
  dither: 31,
  'dither-dots': 32,
  picked: 255,
}

/** Whether this wasm draws pattern tiles itself. */
export function drawsPatternTiles(engine) {
  return typeof engine?.exports?.mt_paint_pattern_tile === 'function'
}

/**
 * One tile of a pattern fill, drawn by the engine.
 *
 * @param {object} engine from `createEngine`
 * @param {{kind?: string, fg?: string, bg?: string}} pattern as `style.pattern` holds it
 * @param {number} side the tile's side in pixels
 * @param {number} line the width of a hairline (grid, vlines, hlines) as a share of the tile
 * @returns {{width: number, height: number, data: Uint8ClampedArray} | null} straight
 *   RGBA8, a copy; null for a kind the engine does not know
 */
export function patternTile(engine, pattern, side, line) {
  const ex = engine.exports
  const kind = PATTERN_KIND[pattern?.kind ?? 'dots']
  if (kind === undefined || kind > 10) return null
  const word = (css) => {
    const c = parseColor(css)
    return ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) >>> 0
  }
  const code = ex.mt_paint_pattern_tile(kind, side, word(pattern?.fg ?? '#000000'), word(pattern?.bg ?? '#ffffff'), line)
  if (code < 0) throw new Error(`mt-text: patternTile: ${STATUS[code] ?? `error ${code}`}`)
  const raster = rasterOf(ex, false)
  return { width: raster.width, height: raster.height, data: raster.data }
}

/** Whether this engine supports procedural screen fills and swatches. */
export function drawsScreens(engine) {
  return typeof engine?.exports?.mt_paint_pattern_swatch === 'function'
}

/** Built-in screen names in wire-id order; null for an older engine. */
export function patternKinds(engine) {
  const ex = engine?.exports
  if (typeof ex?.mt_pattern_kinds_ptr !== 'function' || typeof ex?.mt_pattern_kinds_len !== 'function') return null
  const ptr = ex.mt_pattern_kinds_ptr()
  const len = ex.mt_pattern_kinds_len()
  return new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr, len)).split('\n')
}

/** A whole-fill preview in straight RGBA8. The returned pixels are a copy. */
export function patternSwatch(engine, { width, height, fill: f, tiles }) {
  if (!drawsScreens(engine)) return null
  const ex = engine.exports
  const { sent, index } = tileCollector(tiles)
  at = 0
  u32(0x5354504d) // MTPS
  u32(width)
  u32(height)
  fill(f, index)
  writeTiles(sent)
  const bytes = u8.subarray(0, at)
  const ptr = ex.mt_paint_job_reserve(bytes.length)
  if (!ptr) throw new Error(`mt-text: patternSwatch: the engine refused a swatch of ${bytes.length} bytes`)
  new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes)
  const code = ex.mt_paint_pattern_swatch(bytes.length)
  if (code < 0) throw new Error(`mt-text: patternSwatch: ${STATUS[code] ?? `error ${code}`}`)
  if (code === 0) return null
  const raster = rasterOf(ex, false)
  return { width: raster.width, height: raster.height, data: raster.data }
}

/** Whether this wasm paints box jobs of the version this loader writes. */
export function paintsBoxes(engine) {
  const ex = engine?.exports
  return typeof ex?.mt_paint_box === 'function' && ex.mt_paint_box_wire_version?.() === BOX_WIRE_VERSION
}

/**
 * Whether this wasm paints a box's brush ink in its box job, round dabs
 * (box wire v12 and on): one that paints box jobs of this loader's version.
 */
export function paintsInk(engine) {
  return paintsBoxes(engine)
}

/**
 * Paints one finished box.
 *
 * @param {object} engine from `createEngine`
 * @param {object} request see `encodeBox`; also `view`, as for `paintJob`
 * @returns {{x: number, y: number, width: number, height: number, data: Uint8ClampedArray} | null}
 *   straight-alpha RGBA8 and the device pixel of its top-left corner, cut to
 *   what the box inks and to the surface; null when it draws nothing.
 */
export function paintBox(engine, request) {
  const ex = engine.exports
  if (!paintsBoxes(engine)) throw new Error('mt-text: this wasm does not paint box jobs of this version')
  if (ex.mt_paint_wire_version() !== WIRE_VERSION) {
    throw new Error(`mt-text: wasm reads paint jobs v${ex.mt_paint_wire_version()}, loader writes v${WIRE_VERSION}`)
  }
  const bytes = encodeBox(request)
  const ptr = ex.mt_paint_job_reserve(bytes.length)
  if (!ptr) throw new Error(`mt-text: paintBox: the engine refused a job of ${bytes.length} bytes`)
  new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes)
  const code = ex.mt_paint_box(bytes.length)
  if (code < 0) throw new Error(`mt-text: paintBox: ${STATUS[code] ?? `error ${code}`}`)
  if (code === 0) return null
  return rasterOf(ex, request.view)
}

/**
 * Paints one job.
 *
 * @param {object} engine from `createEngine`
 * @param {object} request see `encodeJob`; also
 * @param {boolean} [request.view] return `data` as a view into the engine's
 *   memory instead of a copy. The view is valid only until the next call
 *   into the engine.
 * @returns {{x: number, y: number, width: number, height: number, data: Uint8ClampedArray} | null}
 *   straight-alpha RGBA8 and the device pixel of its top-left corner, cut to
 *   what the job inks (strokes included); null when the job draws nothing.
 */
export function paintJob(engine, request) {
  const ex = engine.exports
  if (!ex.mt_paint_job) throw new Error('mt-text: this wasm was built without the paint feature')
  if (ex.mt_paint_wire_version() !== WIRE_VERSION) {
    throw new Error(`mt-text: wasm reads paint jobs v${ex.mt_paint_wire_version()}, loader writes v${WIRE_VERSION}`)
  }
  const bytes = encodeJob(request)
  const ptr = ex.mt_paint_job_reserve(bytes.length)
  if (!ptr) throw new Error(`mt-text: paintJob: the engine refused a job of ${bytes.length} bytes`)
  // Views over wasm memory are made after the last call that can grow it.
  new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes)
  const code = ex.mt_paint_job(bytes.length)
  if (code < 0) throw new Error(`mt-text: paintJob: ${STATUS[code] ?? `error ${code}`}`)
  if (code === 0) return null
  return rasterOf(ex, request.view)
}

/** Frees the engine's copy of the last raster. The next job would replace it anyway. */
export function releaseRaster(engine) {
  engine.exports.mt_paint_job_release?.()
}

/**
 * A hash of one raster (or of `null`, a job that drew nothing): 16 hex
 * digits over its origin, its size and its bytes. Plain arithmetic on 32-bit
 * integers, so it is the same number in node and in every browser; it is for
 * telling two rasters apart, not for security. The native example
 * (`text-engine/examples/paint_hash.rs`) computes the same.
 */
export function rasterHash(raster) {
  // Two independent 32-bit hashes side by side: FNV-1a, and Jenkins's
  // one-at-a-time.
  let a = 0x811c9dc5
  let b = 0
  const eat = (bytes) => {
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i]
      a = Math.imul(a ^ v, 0x01000193)
      b = (b + v) | 0
      b = (b + (b << 10)) | 0
      b ^= b >>> 6
    }
  }
  if (raster) {
    eat(new Uint8Array(new Int32Array([raster.x, raster.y, raster.width, raster.height]).buffer))
    eat(raster.data)
  }
  b = (b + (b << 3)) | 0
  b ^= b >>> 11
  b = (b + (b << 15)) | 0
  const hex = (v) => (v >>> 0).toString(16).padStart(8, '0')
  return hex(a) + hex(b)
}

/** One hash of a list of hashes, by the same function. */
export function combineHashes(hashes) {
  const text = hashes.join('')
  const codes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) codes[i] = text.charCodeAt(i)
  return rasterHash({ x: 0, y: 0, width: hashes.length, height: 1, data: codes })
}

/**
 * Paints every request and hashes the rasters: one hash each and one of them
 * all. For checking that the painter's bytes are the same in every engine
 * that runs the wasm.
 *
 * @param {object} engine from `createEngine`
 * @param {object[]} requests see `encodeJob`
 * @returns {{hash: string, each: string[]}}
 */
export function hashJobs(engine, requests) {
  const each = requests.map((request) => rasterHash(paintJob(engine, { ...request, view: true })))
  return { hash: combineHashes(each), each }
}
