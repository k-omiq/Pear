// ===== How letter edges are laid on the pixel grid =====
//
// 'smooth' paints each letter exactly where its outline falls, as it always
// has. 'crisp' moves each straight line's baseline, x-height and cap height
// onto whole page pixels (the engine's grid fit, `Glyphs::fit_to_grid`), so the
// flat bottoms and tops of letters are one solid row of pixels in the export
// instead of two grey ones. Only the Rust engine paints it.
//
// A machine preference (`prefs.textEdges`), mirrored here by the one function
// that writes preferences, so the painter and the picture key can read it
// without importing the preferences. Reactive: a box's picture key reads it, so
// changing it repaints every box.
export const textEdges = $state({ crisp: false });

export function setTextEdges(value) {
  textEdges.crisp = value === 'crisp';
}

/**
 * Whether a box's glyph job asks for Crisp. Only an upright box with no
 * vertical mirror: the export paints a turned or upside-down box at its angle,
 * where a grid fit means nothing, and the editor's picture of it must be the
 * same picture.
 */
export function crispFor(style) {
  if (!textEdges.crisp) return false;
  const rot = (((Number(style?.rotation) || 0) % 360) + 360) % 360;
  return rot === 0 && !style?.flipV;
}
