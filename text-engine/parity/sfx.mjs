// The SFX sound types through the JS loader: `engine.sfxKinds()`,
// `engine.sfxPick()`, `engine.sfxResolve()`, `engine.sfxPlace()`,
// `engine.sfxOutline()` and the handles' maths against the wasm in
// js/generated/, and a laid-out word painted as a curved job.
//
//   node text-engine/parity/sfx.mjs        # exits 1 on any failure
//
// The maths itself is checked by `cargo test` (src/sfx/tests_place.rs); this
// checks what only the loader can get wrong: the byte layout of the params
// (unset numbers included), UTF-16 ranges, the records, and the quads going
// back in for the hit test.
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
const pick = engine.sfxPick('ゴゴゴゴ')
check(pick.order[0] === 'rumble', 'auto pick reads kana')
check(['power', 'rough', 'momentum'].every((m) => pick[m] >= 0 && pick[m] <= 100) && !('strength' in pick), 'auto pick gives the three macros')
check(kinds.every((k) => !('look' in k)), 'a type carries no look')

const impact = kinds.find((k) => k.id === 'impact')
// Unset numbers are the type's: null and left out alike.
const res = engine.sfxResolve({ kind: 'impact', gap: 0.5, follow: null })
check(res.gap === 0.5 && res.follow === impact.follow && res.flow.from === impact.flow.from && res.vertical === false, 'resolve fills what is unset from the type')
const strong = engine.sfxResolve({ kind: 'impact', power: 100 })
check(Math.round(strong.flow.from * 100) === 64 && Math.round(strong.flow.to * 100) === 153, 'power 100 on Impact is 64 % .. 153 %')
check(engine.sfxResolve({ kind: 'glare' }).vertical === true && engine.sfxResolve({ kind: 'glare', vertical: false }).vertical === false, 'the direction is the type\'s unless set')

const params = { kind: 'impact', seed: 3, edits: [{ group: 0, index: 1, dx: 0.2, dy: 0, rot: 10, scale: 1.2 }] }
const text = 'B\u{1F600}OM!!'
const out = engine.sfxPlace(face, text, params)
check(out.letters.length === 5, 'five letters: B, the emoji, O, M, and the bangs in one cell')
check(out.letters[1].start === 1 && out.letters[1].end === 3, 'an emoji is two UTF-16 units')
check(JSON.stringify(engine.sfxPlace(face, text, params)) === JSON.stringify(out), 'the same params lay out the same')
check(out.paths.length === 1 && out.bounds[2] > out.bounds[0], 'one path and real bounds')
check(JSON.stringify(out.cp) === JSON.stringify([0, 1, 2, 3, 4, -1]), 'a letter per code point it starts, -1 for the second bang')
const p0 = out.paths[0]
const curve = engine.sfxCurve(p0)
check(curve.mid[0] === p0.mid[0] && curve.ctrl[1] === p0.ctrl[1], 'a path comes with its control point and middle')
check(Math.abs(engine.sfxBendFor(p0, p0.mid) - p0.bend) < 1e-3, 'the bend for the middle is the bend')
const emoji = out.letters[1]
check(Math.abs(emoji.unit * 1.2 - emoji.em) < 1e-9, 'an edited letter moves in its em before its own scale')
check(out.letters.every((l, i) => engine.sfxHit(out.letters, l.centre[0], l.centre[1]) === i), 'every letter is hit at its centre')
check(engine.sfxHit(out.letters, 1e6, 1e6) === -1, 'nothing is hit far away')
const d = engine.sfxOutline(face, text, params, 2)
check(/^M[-\d.]+ [-\d.]+(L[-\d.]+ [-\d.]+)+Z(M.*Z)?$/.test(d) && d.split('M').length === 3, 'the O\'s outline is two closed contours')
const t = engine.sfxTurn([0, 0], [10, 0], [0, 10], 170, 0)
check(Math.abs(t.total - 260) < 1e-9 && t.shown === -100, 'a turn counts past half a turn and stores it wrapped')
check(engine.sfxScale([0, 0], [10, 0], [25, 0], 1, false) === 2.5, 'scale by the distance from the centre')
check(JSON.stringify(engine.sfxMove(emoji, [0, 0], [emoji.unit, 0], 0.2, 0)) === '[1.2,0]', 'a move in the letter\'s ems')

const runs = out.letters.map((l) => ({ text: text.slice(l.start, l.end), x: 100 + l.x, y: 60 + l.y, rot: l.rot, sx: l.sx, sy: l.sy, skew: l.skew }))
const r = paintJob(engine, { font, size: 24, job: { curved: true, align: 'left', bands: [], fill: { kind: 'solid', color: '#000' }, runs } })
check(r && r.width > 0, 'the layout paints')

if (failed) {
  console.log(`${failed} failed`)
  process.exit(1)
}
