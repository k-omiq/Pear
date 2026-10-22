// The SFX sound types through the JS loader: `engine.sfxKinds()`,
// `engine.sfxPick()` and `engine.sfxPlace()` against the wasm in
// js/generated/, and a laid-out word painted as a curved job.
//
//   node text-engine/parity/sfx.mjs        # exits 1 on any failure
//
// The maths itself is checked by `cargo test` (src/sfx/tests_place.rs); this
// checks what only the loader can get wrong: the byte layout of the params,
// UTF-16 ranges, and the records.
import { readFileSync } from 'node:fs'
import { createEngine } from '../js/engine.mjs'
import { paintJob } from '../js/paint.mjs'
import { FONTS, wasmPath } from './common.mjs'

let failed = 0
function check(ok, what) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
}

const engine = await createEngine(readFileSync(wasmPath))
const font = engine.addFont(readFileSync(FONTS.find((f) => f.key === 'ComicNeue').path))
const face = engine.face(font, 24)
check(engine.hasSfxPlace, 'the wasm has the sfx exports')

const { kinds } = engine.sfxKinds()
check(kinds.length === 12 && engine.sfxKinds().kinds === kinds, 'twelve types, parsed once')
check(engine.sfxPick('ゴゴゴゴ').order[0] === 'rumble', 'auto pick reads kana')

const impact = kinds.find((k) => k.id === 'impact')
const params = { ...impact, kind: 'impact', vertical: false, seed: 3, edits: [{ group: 0, index: 1, dx: 0.2, dy: 0, rot: 10, scale: 1.2 }] }
const out = engine.sfxPlace(face, 'B\u{1F600}OM!!', params)
check(out.letters.length === 5, 'five letters: B, the emoji, O, M, and the bangs in one cell')
check(out.letters[1].start === 1 && out.letters[1].end === 3, 'an emoji is two UTF-16 units')
check(JSON.stringify(engine.sfxPlace(face, 'B\u{1F600}OM!!', params)) === JSON.stringify(out), 'the same params lay out the same')
check(out.paths.length === 1 && out.bounds[2] > out.bounds[0], 'one path and real bounds')

const runs = out.letters.map((l) => ({ text: 'B\u{1F600}OM!!'.slice(l.start, l.end), x: 100 + l.x, y: 60 + l.y, rot: l.rot, sx: l.sx, sy: l.sy, skew: l.skew }))
const r = paintJob(engine, { font, size: 24, job: { curved: true, align: 'left', bands: [], fill: { kind: 'solid', color: '#000' }, runs } })
check(r && r.width > 0, 'the layout paints')

if (failed) {
  console.log(`${failed} failed`)
  process.exit(1)
}
