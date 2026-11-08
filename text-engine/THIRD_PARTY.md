# Third-party code in mt-text

## PhotoCraft

Parts of the layer-effect maths in `src/paint/fx/` and `src/paint/blur.rs`
are ported from PhotoCraft (https://github.com/storytold/photocraft, commit
dada110, 2026-11-08), which PhotoCraft offers under the MIT licence or the
Apache License 2.0; we take it under the MIT licence. Each ported piece
names its source file in a comment.

- `fx/tent.rs`: the soft edge, two box passes (`crates/compose/src/effects/blur.rs`).
- `fx/distance.rs` `dilate`: Spread and Choke by the 5 x 5 chamfer
  (`crates/compose/src/effects/blur.rs`, `distance.rs`).
- `fx/noise.rs` `grain`: the Noise slider (`crates/compose/src/effects/paint.rs`).
- `fx/contour.rs` `PRESETS`: the twelve contour presets' points
  (`crates/engine/src/layer_style.rs`).
- `fx/mod.rs` `spread_split` (`crates/compose/src/effects/paint.rs`).
- `fx/blend.rs`: Soft Light, Vivid Light, Hard Mix, Color Burn and Dodge
  edges (`crates/compose/src/psblend.rs`, `crates/color/src/blend.rs`).
- `fx/map.rs`: the glow and inner shadow maps, Range, the exact distance
  transform (`crates/compose/src/effects.rs`, `effects/paint.rs`,
  `effects/distance.rs`).
- `fx/effects.rs`: the effects' order, the interior compositing, the
  Stroke effect (`stroke_widths`, the inside band, `outline_share`, the
  outside strokes slid under the letters, `stroke_frame`) and the gradient
  glow (`crates/compose/src/effects/composite.rs`, `effects/paint.rs`).
- `fx/map.rs` `chamfer_outside`, `chamfer_inside`, `local_coverage`,
  `STROKE_CHAMFER_MAX`: the strokes' distance fields
  (`crates/compose/src/effects/distance.rs`, `composite.rs`).
- `fx/gradient.rs`: the five gradient styles, their lengths and the stop
  sampling (`crates/compose/src/effects/paint.rs`).
- `fx/map.rs` `satin`, `fx/contour.rs` `Lut::satin`, `fx/effects.rs`
  `satin_throw`: the Satin map, its mirrored contour table, and its throw
  (Distance 0 drawn as 1 px, rounded to whole pixels)
  (`crates/compose/src/effects/bevel.rs` `satin_map`, `satin_distance`;
  `effects/paint.rs` `satin_lut`, `offset`).

MIT License

Copyright (c) 2026 ArtCraft Team and the PhotoCraft contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
