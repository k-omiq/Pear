// What `strokeStamps` in src/lib/brush.js makes of a fixed set of strokes,
// as JSON the Rust port is held to (`tests/ink.rs`,
// text-engine/src/paint/ink/stamps.rs).
//
//   node text-engine/parity/ink-stamps.mjs           # writes tests/data/ink_stamps.json
//   node text-engine/parity/ink-stamps.mjs --check   # exits 1 when the file is stale
//
// src/lib/ink-stamps-fixture.test.js runs the check with the app's tests, so
// a change to brush.js that moves a stamp fails there until the file is
// written again and the Rust port follows.
//
// Each case is `{ stroke, stamps }`: the fields of the stroke strokeStamps
// reads, as `normalizeInkStroke` (src/lib/data.js) keeps them, and its
// stamps as it lays them.
// Every number is written as JS prints it: the shortest text that reads back
// to the same double.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strokeStamps } from '../../src/lib/brush.js'

const self = fileURLToPath(import.meta.url)
export const FIXTURE = resolve(dirname(self), '../tests/data/ink_stamps.json')

// mulberry32, for the shaken paths: the same numbers in every engine.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const taper = (over = {}) => ({ on: false, len: 20, ratio: 60, mode: 'px', ...over })

// A stroke with normalizeInkStroke's defaults.
function stroke(over = {}) {
  return {
    brush: 'round',
    size: 24,
    color: '#000000',
    opacity: 1,
    spacing: 10,
    hardness: 100,
    angle: 0,
    angleJitter: 0,
    followDir: false,
    ribbon: false,
    darkenTips: false,
    flipX: 'off',
    flipY: 'off',
    flatness: 1,
    antialias: 3,
    blend: 'over',
    texture: { on: false, density: 0.5, scale: 100, stress: false },
    corners: 0,
    waterEdge: false,
    waterEdgeWidth: 4,
    waterEdgePower: 0.5,
    waterEdgeDark: 0,
    waterEdgeBlur: 0,
    taperIn: taper(),
    taperOut: taper(),
    seed: 1,
    pts: [],
    ...over,
  }
}

// A path that wanders, `n` points, seeded; `extra` adds factors per point.
function wander(n, seed, extra = null) {
  const r = rng(seed)
  const pts = []
  let x = 50
  let y = 50
  for (let i = 0; i < n; i++) {
    x += r() * 30 - 8
    y += r() * 30 - 15
    const w = 0.2 + r() * 0.8
    pts.push(extra ? [x, y, w, ...extra(r, i)] : [x, y, w])
  }
  return pts
}
const square = [[10, 10, 1], [110, 10, 1], [110, 110, 1], [10, 110, 1], [10, 12, 1]]
const zigzag = [[0, 0, 1], [40, 60, 1], [80, 0, 1], [120, 60, 1], [160, 0, 1]]

const STROKES = [
  stroke({ pts: [[10, 10, 1], [200, 40, 1]] }),
  stroke({ pts: [[5, 5, 1]] }),
  stroke({ pts: [[5, 5, 1], [5, 5, 1], [5, 5, 0.5]] }),
  stroke({ pts: wander(30, 1) }),
  stroke({ size: 3.7, spacing: 33, pts: wander(15, 2) }),
  stroke({ size: 0.5, spacing: 1, pts: wander(12, 3) }),
  stroke({ size: 120, spacing: 60, pts: wander(10, 4) }),
  stroke({ angleJitter: 37, seed: 98765, pts: wander(25, 5) }),
  stroke({ angle: 213, angleJitter: 100, seed: 4294967290, pts: wander(20, 6) }),
  stroke({ followDir: true, angle: 15, pts: wander(25, 7) }),
  stroke({ ribbon: true, size: 30, pts: wander(20, 8) }),
  stroke({ ribbon: true, size: 9, flipX: 'random', pts: zigzag }),
  stroke({ flipX: 'random', flipY: 'random', seed: 77, pts: wander(20, 9) }),
  stroke({ flipX: 'on', flipY: 'random', seed: 3, pts: wander(15, 10) }),
  stroke({ brush: 'tip', tips: ['a', 'b', 'c'], tipOrder: 'repeat', pts: wander(20, 11) }),
  stroke({ brush: 'tip', tips: ['a', 'b', 'c', 'd'], tipOrder: 'reverse', pts: wander(25, 12) }),
  stroke({ brush: 'tip', tips: ['a', 'b'], tipOrder: 'once', pts: wander(10, 13) }),
  stroke({ brush: 'tip', tips: ['a', 'b', 'c', 'd', 'e'], tipOrder: 'random', seed: 12345, angleJitter: 20, flipY: 'random', pts: wander(30, 14) }),
  stroke({ taperIn: taper({ on: true, len: 40, ratio: 60 }), taperOut: taper({ on: true, len: 25, ratio: 0 }), pts: wander(25, 15) }),
  stroke({ size: 16, taperIn: taper({ on: true, len: 150, ratio: 100, mode: 'pct' }), taperOut: taper({ on: true, len: 80, ratio: 33, mode: 'pct' }), pts: wander(25, 16) }),
  stroke({ taperIn: taper({ on: true, len: 500, ratio: 50 }), pts: [[0, 0, 1], [30, 0, 1]] }),
  stroke({ opacity: 0.7, pts: wander(25, 17, (r) => [r(), 1]) }),
  stroke({ flatness: 0.4, pts: wander(25, 18, (r) => [1, 0.2 + r() * 0.8]) }),
  stroke({ opacity: 0.5, flatness: 0.6, pts: wander(25, 19, (r, i) => (i % 3 ? [r(), r()] : [1, 1])) }),
  stroke({ corners: 45, size: 14, pts: square }),
  stroke({ corners: 30, size: 20, followDir: true, angle: 10, pts: zigzag }),
  stroke({ corners: 90, size: 10, taperIn: taper({ on: true, len: 30, ratio: 60 }), pts: zigzag.map((p, i) => [p[0], p[1], 0.5 + i / 10, 0.8, 0.9]) }),
  stroke({ corners: 170, size: 6, pts: [[0, 0, 1], [50, 0, 1], [0, 3, 1], [50, 6, 1]] }),
  stroke({ corners: 20, size: 30, spacing: 5, pts: wander(18, 20) }),
  stroke({ size: 18, spacing: 7, pts: wander(14, 21).map((p) => [p[0] * 3.3, p[1] * 0.7, p[2]]) }),
]

// The stroke as the Rust test builds it: only the fields it reads.
function wire(k) {
  return {
    ribbon: k.ribbon,
    followDir: k.followDir,
    flipX: k.flipX,
    flipY: k.flipY,
    tipOrder: k.tipOrder ?? 'repeat',
    tips: Array.isArray(k.tips) ? k.tips.length : 0,
    round: k.brush === 'round',
    size: k.size,
    spacing: k.spacing,
    opacity: k.opacity,
    angle: k.angle,
    angleJitter: k.angleJitter,
    flatness: k.flatness,
    corners: k.corners,
    seed: k.seed,
    taperIn: k.taperIn,
    taperOut: k.taperOut,
    pts: k.pts,
  }
}

/** The file's text. */
export function inkStampsFixture() {
  // A stamp as `[x, y, size, angle, alpha, d, len, tip, fx, fy, flat]`,
  // null for what it does not carry.
  const row = (s) => [s.x, s.y, s.size, s.angle, s.alpha, s.d ?? null, s.len ?? null, s.tip ?? null, s.fx ?? null, s.fy ?? null, s.flat ?? null]
  const cases = STROKES.map((k) => ({ stroke: wire(k), stamps: strokeStamps(k).map(row) }))
  return JSON.stringify({ cases }) + '\n'
}

if (process.argv[1] === self) {
  const text = inkStampsFixture()
  if (process.argv.includes('--check')) {
    const same = readFileSync(FIXTURE, 'utf8') === text
    console.log(same ? 'ink_stamps.json is what brush.js gives' : 'ink_stamps.json is STALE: run node text-engine/parity/ink-stamps.mjs')
    process.exit(same ? 0 : 1)
  }
  writeFileSync(FIXTURE, text)
  console.log(`wrote ${FIXTURE}: ${STROKES.length} strokes, ${JSON.parse(text).cases.reduce((n, c) => n + c.stamps.length, 0)} stamps`)
}
