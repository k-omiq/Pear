// Photoshop's twelve contour presets as points, for the PSD writer: an
// effect's contour in a PSD names the curve AND lists its points (`ShpC` ›
// `Crv `), and Photoshop draws the points. The same table as the engine's
// `PRESETS` in text-engine/src/paint/fx/contour.rs (PhotoCraft's `CONTOURS`,
// measured in Photoshop 27.11; Copyright (c) 2026 ArtCraft Team and the
// PhotoCraft contributors, MIT licence, see text-engine/THIRD_PARTY.md), and
// kept equal to it by contour-presets.test.js, which reads the Rust source.
// Data only: the engine alone draws a contour.
//
// Each point is [input, output, corner], both from 0 to 1, in order of input.
export const CONTOUR_PRESET_POINTS = Object.freeze({
  linear: [[0, 0, false], [1, 1, false]],
  cone: [[0, 0, false], [0.172, 0.477, true], [0.195, 0.555, true], [0.266, 0.711, true], [0.383, 0.922, true], [0.43, 0.969, true], [0.477, 0.992, true], [0.523, 0.992, true], [0.57, 0.969, true], [0.664, 0.859, true], [0.703, 0.789, true], [0.742, 0.711, true], [0.836, 0.477, true], [0.859, 0.398, true], [0.914, 0.266, true], [0.945, 0.156, true], [0.977, 0.078, true], [1, 0, false]],
  'cone-inverted': [[0, 1, false], [0.031, 0.922, true], [0.07, 0.789, true], [0.172, 0.523, true], [0.195, 0.445, true], [0.266, 0.289, true], [0.383, 0.078, true], [0.43, 0.031, true], [0.477, 0.008, true], [0.523, 0.008, true], [0.57, 0.031, true], [0.664, 0.141, true], [0.703, 0.211, true], [0.742, 0.289, true], [0.836, 0.523, true], [0.859, 0.602, true], [0.914, 0.734, true], [0.945, 0.844, true], [0.977, 0.922, true], [1, 1, false]],
  'cove-deep': [[0, 0.258, false], [0.344, 0.289, true], [0.383, 0.297, true], [0.477, 0.352, true], [0.57, 0.43, true], [0.617, 0.484, true], [0.664, 0.57, true], [0.703, 0.711, true], [0.742, 0.906, true], [0.773, 1, true], [1, 1, false]],
  'cove-shallow': [[0, 0, false], [0.008, 0.164, true], [0.016, 0.477, true], [0.039, 0.508, true], [0.172, 0.57, true], [0.305, 0.688, true], [0.344, 0.734, true], [0.477, 0.945, true], [0.523, 1, true], [1, 1, false]],
  gaussian: [[0, 0, false], [0.117, 0.023, true], [0.172, 0.055, true], [0.234, 0.117, true], [0.305, 0.234, true], [0.383, 0.414, true], [0.523, 0.688, true], [0.617, 0.812, true], [0.703, 0.891, true], [0.805, 0.953, true], [1, 1, false]],
  'half-round': [[0, 0, false], [0.07, 0.18, true], [0.195, 0.445, true], [0.266, 0.555, true], [0.383, 0.703, true], [0.523, 0.828, true], [0.617, 0.883, true], [0.773, 0.945, true], [1, 1, false]],
  ring: [[0, 0, false], [0.031, 0.078, true], [0.039, 0.117, true], [0.117, 0.383, true], [0.172, 0.609, true], [0.195, 0.734, true], [0.266, 0.953, true], [0.305, 1, true], [0.344, 0.992, true], [0.383, 0.922, true], [0.43, 0.805, true], [0.477, 0.641, true], [0.57, 0.281, true], [0.617, 0.141, true], [0.664, 0.055, true], [0.703, 0.016, true], [0.742, 0.016, true], [0.773, 0.062, true], [0.836, 0.234, true], [0.859, 0.344, true], [0.891, 0.445, true], [0.914, 0.547, true], [0.945, 0.734, true], [0.977, 0.875, true], [1, 1, false]],
  'ring-double': [[0, 0, false], [0.055, 0.086, true], [0.094, 0.172, true], [0.117, 0.242, true], [0.172, 0.477, true], [0.195, 0.625, true], [0.266, 0.891, true], [0.305, 0.945, true], [0.344, 0.891, true], [0.383, 0.695, true], [0.43, 0.367, true], [0.477, 0.07, true], [0.523, 0.047, true], [0.57, 0.32, true], [0.617, 0.648, true], [0.664, 0.867, true], [0.703, 0.93, true], [0.742, 0.852, true], [0.773, 0.641, true], [0.805, 0.375, true], [0.836, 0.156, true], [0.859, 0.031, true], [0.891, 0.023, true], [0.914, 0.109, true], [0.977, 0.703, true], [0.984, 0.82, true], [1, 1, false]],
  'rolling-slope-descending': [[0, 1, false], [0.008, 1, true], [0.031, 0.93, true], [0.039, 0.883, true], [0.07, 0.758, true], [0.141, 0.539, true], [0.195, 0.406, true], [0.266, 0.352, true], [0.305, 0.352, true], [0.523, 0.57, true], [0.57, 0.602, true], [0.617, 0.617, true], [0.703, 0.602, true], [0.742, 0.562, true], [0.836, 0.391, true], [0.914, 0.211, true], [0.945, 0.109, true], [0.977, 0.039, true], [0.984, 0.008, true], [1, 0, false]],
  'rounded-steps': [[0, 0.234, false], [0.031, 0.305, true], [0.039, 0.336, true], [0.094, 0.43, true], [0.141, 0.477, true], [0.234, 0.492, true], [0.266, 0.516, true], [0.305, 0.602, true], [0.344, 0.664, true], [0.383, 0.711, true], [0.477, 0.734, true], [0.523, 0.797, true], [0.57, 0.898, true], [0.617, 0.953, true], [0.664, 0.984, true], [0.773, 0.984, true], [0.836, 0.906, true], [0.891, 0.891, true], [0.914, 0.898, true], [1, 1, false]],
  'sawtooth-1': [[0, 0, false], [0.031, 0.047, true], [0.195, 0.375, true], [0.266, 0.492, true], [0.477, 0.047, true], [0.523, 0.055, true], [0.742, 0.469, true], [0.773, 0.445, true], [0.914, 0.18, true], [0.945, 0.102, true], [1, 0, false]],
});

// The most points Photoshop reads in an effect's contour: a layer whose
// effects carry a longer one fails to load and loses all its effects
// (PhotoCraft #9556, `PSD_CONTOUR_POINTS` in crates/io/src/effects_map.rs).
export const PSD_CONTOUR_POINTS = 16;

/**
 * The indices of a contour's points a PSD keeps, in order (PhotoCraft's
 * `psd_contour_points`, crates/io/src/effects_map.rs, MIT): all of them up to
 * `PSD_CONTOUR_POINTS`, else both ends and then, one at a time, the point
 * farthest (in output) from the line between the kept points around it, so
 * peaks and valleys (Ring - Double's two rings) survive. `pts` are [x, y, ...]
 * in order of x.
 */
export function psdContourPoints(pts, max = PSD_CONTOUR_POINTS) {
  if (pts.length <= max) return pts.map((_, i) => i);
  const kept = [0, pts.length - 1];
  while (kept.length < max) {
    let far = null;
    for (let k = 0; k + 1 < kept.length; k++) {
      const a = kept[k];
      const b = kept[k + 1];
      const [ax, ay] = pts[a];
      const [bx, by] = pts[b];
      const span = bx - ax;
      for (let i = a + 1; i < b; i++) {
        // Only equal inputs (a vertical step) have no span.
        const t = span !== 0 && Number.isFinite(span) ? (pts[i][0] - ax) / span : 0;
        const off = Math.abs(pts[i][1] - (ay + t * (by - ay)));
        if (Number.isFinite(off) && (far === null || off > far[0])) far = [off, i];
      }
    }
    if (!far) break;
    const i = far[1];
    let at = 0;
    while (at < kept.length && kept[at] < i) at++;
    kept.splice(at, 0, i);
  }
  return kept;
}
