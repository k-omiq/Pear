import { createBrowserGlyphPainter } from './browser-painter.js';
import { specialActive } from '../special.js';

// Engines are plain objects, and every method is synchronous:
//   id: string
//   advance(face, text): number, one shaped run without letter spacing
//   fontBox(face): { ascent, descent }, unvalidated font metrics
//   lineInk(face, text): { width, left, right, ascent, descent }, left/alphabetic
//   glyphInk(face, text): the same metrics, anchored centre/middle
//   wrapPlain(face, text, { width, lineHeight, letterSpacing, align }): string[]
//     Optional: without it, use the live browser DOM or the greedy breaker.
//   loading(): boolean, fallback measurements must not be kept while true
//   onFontsChange(cb): called when usable faces change; may return an unsubscribe
//   faceReady(face, { matched }?): boolean, may start loading the face;
//     `matched` (the store fitting a box) refuses a face the browser found
//     nothing for
// A face is { key, name, bold, italic, size, css }. The key stays the CSS font
// shorthand so swapping the implementation does not change the memo's identity.
// Ink left/right are the engine's bounding-box distances from the anchor;
// measure.js applies the left sign, spacing and alignment as it always has.
let engine = null;
const listeners = new Set();
export function textEngine() {
  return engine;
}
export function setTextEngine(e) {
  engine = e;
  for (const cb of listeners) cb(e);
}
export function onTextEngineChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Painting needs only the context it is handed, even where measurement has no
// engine. Jobs carry plain data; the painter owns the platform's paint objects.
// A painter is `{ paint(ctx, job) }`, and may say `maxSide`: the longest side,
// in device pixels, of what it will paint for one job. One that says nothing
// has no such limit (a canvas draws text of any extent); the Rust engine's
// does (rust-painter.js), and a canvas sized for it must be within it.
let painter = createBrowserGlyphPainter();
export function glyphPainter() {
  return painter;
}
export function setGlyphPainter(p) {
  painter = p;
}

// Lets go of whatever copies of brush tips the painter keeps of its own (the
// Rust engine's tip cache, rust-painter.js), at the moment the brush library
// closes its decoded tips (`forgetBrushTips`): the library calls this rather
// than reaching for a painter. A painter that keeps none has nothing to do.
export function forgetPainterTips() {
  painter?.forgetTips?.();
}

// Whether ONE engine both measures and paints: the painter says which engine
// it paints with (`engine`, the Rust painter's), and that engine is the one
// installed for measuring. Then a line's measured ink is exactly the ink that
// will be painted, and a canvas can be sized by it.
//
// This is the gate for what is right in the Rust engine and would change the
// browser path's output if it were done there too:
//
//   - the footprint grown to hold ink past the advances (`layoutBox`,
//     exporter.js). The browser path has the same defect and keeps it, byte
//     for byte, until it is removed;
//   - what a PSD type layer says of its font: the name in the file that was
//     drawn, the engine's own faux flags, the fonts of borrowed letters, a
//     missing font said in the layer name (psd.js);
//   - what an export waits for: the engine's registry and not the browser's
//     font set (`exportImages` in exporter.js, `buildPagePsd` in psd.js).
//
// AT CUT-OVER this function and its calls go, and what each call guards
// becomes unconditional.
export function engineDraws() {
  return engine != null && painter.engine === engine;
}

// Whether a style's wobble is painted: switched on, moving something, and
// drawn by a painter that moves the letters in the job (the Rust one). A
// wobble of no amount and no tilt is none, so the job is one without it and
// Crisp stays on. Under the browser engine nothing moves, so nothing grows.
export function wobbleDrawn(style) {
  const w = style?.wobble;
  return w?.on === true && (w.amount > 0 || w.tilt > 0) && engineDraws() && painter.wobble === true;
}

// Whether a style's special effects (special.js) are painted: one is on with
// an amount, and the painter makes them from their numbers (the Rust one).
export function specialDrawn(style) {
  return specialActive(style) && engineDraws() && painter.special === true;
}

// ONE EXPORT, ONE ENGINE. Which engine measures and which painter draws can
// change between two awaits (the switch is flipped; a font lands and the
// engine has, or no longer has, something to draw with; it fails and the
// browser takes over). An export paints across many awaits, so it keeps what
// was installed when its font waits ended (`enginesNow`) and asks, when a
// file's pixels are finished, whether that is still what is installed
// (`enginesAre`). Told by identity: turning the switch off and on makes a new
// engine, and a painter is made new each time it goes in.
export function enginesNow() {
  return { engine, painter };
}
export function enginesAre(held) {
  return held.engine === engine && held.painter === painter;
}
