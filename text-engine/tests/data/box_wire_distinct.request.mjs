// A box request in which every field has a value of its own, so a swap of
// two fields of the wire (spread and range, say, both once 0.5) shows. The
// bytes `encodeBox` writes for it are kept in `box_wire_distinct.hex`; the
// Rust test `paint_wire.rs` decodes them and states what each field must
// read as, and `src/lib/text-engine/box-wire-fixture.test.js` checks that
// the fixture is what `encodeBox` writes now. To write it again (after a
// wire change, with the version bumped):
//
//   node text-engine/tests/data/box_wire_distinct.request.mjs
//
// then change the Rust test's expectations to match, on purpose.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { encodeBox } from '../../js/paint.mjs'

const noiseGradient = {
  type: 'noise',
  style: 'diamond',
  angle: 33.5,
  scale: 0.875,
  reverse: true,
  offset: [0.0625, -0.1875],
  stops: [
    { pos: 0.125, color: '#102030', opacity: 0.5 },
    { pos: 0.875, color: '#405060', opacity: 0.25 },
  ],
  noise: { seed: 31415, roughness: 0.3125, model: 'lab', min: [0.0625, 0.125, 0.1875], max: [0.6875, 0.8125, 0.9375], restrict: true, transparency: true },
}

// The colour and the opacity stops apart (v14), with their midpoints (each
// on the stop that ends its segment), Dither, the Method and Smoothness.
// The noise gradient above keeps the old shape, one opacity per colour
// stop, which is sent as opacity stops at the same places.
const stopsGradient = (style, angle, scale, offset, interp) => ({
  style,
  angle,
  scale,
  reverse: false,
  offset,
  stops: [
    { pos: 0.0625, color: '#aa0011' },
    { pos: 0.5, color: '#22bb33', mid: 0.3125 },
    { pos: 0.9375, color: '#4455cc', mid: 0.8125 },
  ],
  opacityStops: [
    { pos: 0.125, opacity: 1 },
    { pos: 0.4375, opacity: 0.625, mid: 0.6875 },
    { pos: 0.75, opacity: 0.375 },
    { pos: 0.875, opacity: 0.1875, mid: 0.1875 },
  ],
  ...interp,
})

export const request = {
  // The glyph job.
  font: 7,
  size: 53.5,
  weight: 1.5,
  transform: [1.25, 0.5, -0.25, 1.5, 11, 13],
  job: {
    curved: true,
    align: 'center',
    letterSpacing: 1.75,
    silhouette: null,
    noFill: false,
    bands: [{ color: '#112233', opacity: 0.6875, line: 3.5 }],
    fill: { kind: 'solid', color: '#778899' },
    runs: [
      { text: 'AB', x: 14.5, y: 21.5, rot: 0.375, sx: 1.125, sy: 0.875, skew: 0.0625, drip: 0.5, pen: 1.25, ghost: true, fill: { kind: 'solid', color: '#334455' } },
      { text: 'C', x: 33.5, y: 41.25, rot: -0.1875, sx: 0.9375, sy: 1.0625, skew: -0.03125, drip: 0.25, pen: 1.5 },
    ],
  },
  // The box.
  width: 211,
  height: 137,
  shadows: [
    { color: '#102030', opacity: 0.3125, x: 1.5, y: -2.5, size: 3.25, grow: 0.75, spread: 0.125, noise: 0.4375, blend: 'multiply', knockout: true, exact: true, seed: 90210, contour: { preset: 'ring' } },
    { color: '#a0b0c0', opacity: 0.8125, x: -3.75, y: 4.25, size: 5.5, grow: 1.25, spread: 0.375, noise: 0.0625, blend: 'screen', knockout: false, exact: false, seed: 1357, contour: { preset: 'sawtooth-1' } },
  ],
  blur: 0.8125,
  taps: [
    { dx: 1.5, dy: -0.5, w: 0.3125 },
    { dx: -2.5, dy: 3.5, w: 0.625 },
  ],
  clip: {
    mode: 'exclude',
    x: 13.5,
    y: 17.25,
    shapes: [
      { kind: 'ellipse', cx: 21.5, cy: 22.5, rx: 5.5, ry: 6.5 },
      { kind: 'poly', pts: [[1.5, 2.5], [30.5, 3.5], [4.5, 29.5]] },
      { kind: 'stroke', size: 3.5, pts: [[7.5, 8.5], [9.5, 12.5]] },
    ],
  },
  blend: 'color-burn',
  fillOpacity: 0.6875,
  blendInterior: true,
  transparencyShapes: false,
  channels: { r: true, g: false, b: true },
  // Eight sliders, each four different levels in order.
  blendIf: {
    gray: { this: [1, 11, 201, 221], under: [2, 12, 202, 222] },
    red: { this: [3, 13, 203, 223], under: [4, 14, 204, 224] },
    green: { this: [5, 15, 205, 225], under: [6, 16, 206, 226] },
    blue: { this: [7, 17, 207, 227], under: [8, 18, 208, 228] },
  },
  effects: [
    { kind: 'outerGlow', color: '#aabbcc', opacity: 0.71875, blend: 'screen', technique: 'precise', size: 6.5, spread: 0.1875, range: 0.8125, noise: 0.34375, seed: 12345, contour: { preset: 'cove-deep' }, gradient: noiseGradient, jitter: 0.40625 },
    { kind: 'innerGlow', color: '#ddeeff', opacity: 0.59375, blend: 'linear-dodge', technique: 'softer', size: 4.75, choke: 0.21875, range: 0.65625, noise: 0.15625, seed: 23456, contour: { preset: 'half-round' }, source: 'center', jitter: 0.53125 },
    { kind: 'innerShadow', color: '#010203', opacity: 0.84375, blend: 'linear-burn', x: 2.25, y: -3.75, size: 4.5, choke: 0.28125, noise: 0.46875, seed: 777, contour: { preset: 'rounded-steps' } },
    { kind: 'colorOverlay', color: '#0f1e2d', opacity: 0.90625, blend: 'hard-light' },
    { kind: 'gradientOverlay', opacity: 0.78125, blend: 'soft-light', gradient: stopsGradient('radial', 71.5, 1.375, [0.3125, -0.4375], { dither: true, method: 'classic', smoothness: 0 }) },
    { kind: 'patternOverlay', opacity: 0.53125, blend: 'lighten', fill: { kind: 'solid', color: '#456789' } },
    { kind: 'stroke', size: 5.5, position: 'center', opacity: 0.4375, blend: 'difference', seed: 4242, paint: { kind: 'gradient', gradient: stopsGradient('angle', 12.5, 0.625, [-0.0625, 0.125], { method: 'perceptual', smoothness: 0.4375 }) } },
    { kind: 'satin', color: '#f0e0d0', opacity: 0.46875, blend: 'darken', angle: 47.5, distance: 9.5, size: 12.25, invert: true, contour: { preset: 'rolling-slope-descending' } },
    {
      kind: 'bevel',
      style: 'pillow',
      technique: 'chisel-hard',
      depth: 2.5,
      size: 7.5,
      soften: 1.75,
      angle: 133.5,
      altitude: 41.5,
      direction: 'down',
      highlight: { color: '#fafbfc', opacity: 0.6875, blend: 'overlay' },
      shadow: { color: '#050607', opacity: 0.3125, blend: 'exclusion' },
      gloss: { preset: 'ring-double', aa: true },
      contour: { preset: 'cone-inverted', aa: true, range: 0.5625 },
      texture: { depth: 3.5, invert: true, fill: { kind: 'solid', color: '#13579b' } },
    },
  ],
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hex = Buffer.from(encodeBox(request)).toString('hex')
  writeFileSync(fileURLToPath(new URL('./box_wire_distinct.hex', import.meta.url)), hex.replace(/(.{96})/g, '$1\n').trimEnd() + '\n')
  console.log(hex.length / 2, 'bytes')
}
