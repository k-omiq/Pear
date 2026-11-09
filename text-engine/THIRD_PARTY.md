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
- `fx/gradient.rs` `sample`, `sample_at`, `dither`, `dither_noise`: colour
  and opacity stops with midpoints, and Dither
  (`crates/compose/src/gradient_fill.rs` `Ramp::sample`, `sample_color`,
  `sample_opacity`, `dither`; `crates/color/src/lib.rs` `dither_noise`);
  `fx/gradient_bake.rs`: Smoothness and the Interpolation Method (Classic,
  Perceptual, Linear, Smooth) baked into dense stops, with its Photoshop
  samples as tests (`crates/io/src/gradient_bake.rs` `Method`, `eval`,
  `bake`, `bake_opacity`, `SMOOTH_EASE`, `OPACITY_RESPONSE`;
  `crates/compose/src/gradient_fill.rs` `midpoint_remap`). The app's
  `src/lib/gradient-ramp.js` is a JS copy of the same maths.
- `fx/map.rs` `satin`, `fx/contour.rs` `Lut::satin`, `fx/effects.rs`
  `satin_throw`: the Satin map, its mirrored contour table, and its throw
  (Distance 0 drawn as 1 px, rounded to whole pixels)
  (`crates/compose/src/effects/bevel.rs` `satin_map`, `satin_distance`;
  `effects/paint.rs` `satin_lut`, `offset`).
- `fx/effects.rs` `whole_throw`: a drop or inner shadow's throw, rounded to
  whole pixels in job units and then in device pixels
  (`crates/compose/src/effects/paint.rs` `offset`, which rounds each axis).
  The half-pixel snap under it, `whole`, is ours, not PhotoCraft's.
- `fx/bevel.rs`: Bevel & Emboss, its geometry, height map, chisel ramps and
  shading (`crates/compose/src/effects/bevel.rs` `BevelPaint`,
  `BEVEL_H_EPS`, `BevelGeom`, `bevel_geom`, `bevel_height`,
  `bevel_chisel_h`, `bevel_maps`); `fx/contour.rs` `Table`, the contour as
  4096 floats (`effects/paint.rs` `bevel_contour_lut`, `lut_at`;
  `adjust/tone.rs` `contour_curve_lut`).
- `fx/edges.rs`: the chisel's distances with the edge placed by its
  anti-aliased pixels (`crates/compose/src/effects/distance.rs`
  `edge_offset`, `SharpEdge`, `SharpEdges`, `sharp_edges`,
  `refine_edge_normals`, `edge_distance`, `bevel_dist_inside`,
  `bevel_dist_outside`, `bevel_dists`), and their tests
  (`effects/tests.rs`).
- `fx/blend.rs` `Blend::fill_is_special`, `Blend::mix_fill`, `lay_fill`:
  Fill Opacity in Photoshop's special eight modes, and its measured test
  (`crates/compose/src/psblend.rs` `fill_is_special`, `blend_rgb_fill`,
  `composite_fill`, `special_eight_fill_matches_photoshop`).
- `fx/blend.rs` `lay_fill_shapeless`, `fx/blending.rs`
  `Blending::shapeless`: Transparency Shapes Layer off, the layer's own
  transparency blending as Fill in the special eight, and its test of
  Photoshop's measured pixels (`crates/compose/src/composite.rs`
  `blend_layer_into`; `crates/doc/src/advanced.rs` `AdvancedBlending`;
  `crates/compose/src/advanced_tests.rs`
  `transparency_shapes_off_blends_alpha_as_fill`).
- `fx/blending.rs` `shadow_see_through`: how far a knocked-out drop shadow
  shows through the letters; `fx/effects.rs` `interior`'s `group`: Blend
  Interior Effects as Group (`crates/compose/src/effects/composite.rs`
  `shadow_see_through`, `knock_out_exterior`, `interior_group`,
  `layer_pixels`, `paint_interior`; the group test after
  `crates/compose/src/advanced_tests.rs`).
- `fx/blending.rs` `Range`, `BlendIf::weight`, `level`, `gray`,
  `restrict`: Blend If (This Layer and Underlying Layer, split points,
  Gray and R, G, B) and Channels (`crates/doc/src/blend_if.rs`
  `BlendRange`; `crates/compose/src/composite.rs` `blend_if_weight`,
  `blend_if_level`, `blend_if_gray`, `apply_blend_if`, `composite_layer`;
  `crates/compose/src/content.rs` `channel_weights`, `restore_channels`),
  and their tests (`crates/doc/src/blend_if.rs` tests,
  `crates/compose/src/tests.rs` `channel_restrictions_keep_the_backdrop`
  and the `blend_if_*` tests).
- `ink/tips.rs` `level_sizes`, `halve`, `Level::sample`, `TipCache`: an
  imported brush tip's halvings, the bilinear read of a level, and the
  byte-bounded least-recently-used cache of tips (`crates/paint/src/tile.rs`
  `Mips::new`, `Mips::sample_clamped`; `crates/paint/src/mip_cache.rs`
  `MipCache`, `purge_mip_cache`).

Outside the engine, for the PSD writer (`src/lib/`):

- `contour-presets.js` `CONTOUR_PRESET_POINTS`: a copy of `fx/contour.rs`
  `PRESETS` (above), checked against it by `contour-presets.test.js`;
  `psdContourPoints`, `PSD_CONTOUR_POINTS`: a contour thinned to the 16
  points Photoshop reads (`crates/io/src/effects_map.rs`
  `psd_contour_points`, `PSD_CONTOUR_POINTS`).
- `psd.js`: the effect keys and units as PhotoCraft writes them
  (`crates/io/src/effects_map.rs` `with_common`, `gradient_keys`,
  `write_one`): `present` and `showInDialog`, a glow's gradient without a
  colour, Jitter and Overprint written as 0 / off.
- `psd-knockout.js`: the walk over a written or read PSD's layer records
  that sets and reads Knockout Deep (`knko` 2): the record layout
  (`crates/psd/src/layer.rs` `LayerRecord::read`, `MAX_LAYER_CHANNELS`), the
  Pascal name's padding (`crates/psd/src/io.rs` `read_pascal`), and the
  block list with its padding found by where the next signature starts
  (`crates/psd/src/tagged.rs` `read_blocks_with`, `is_sig`); the `knko`
  values 0 / 1 / 2 (`tagged.rs` `BlockData::Knockout`). The PSB long-length
  rule there is ag-psd's, not PhotoCraft's.

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
