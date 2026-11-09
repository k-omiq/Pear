// ===== App seed data =====
// Pages read right-to-left; text lines numbered in RTL reading order.

import { FLIP_MODES, BLEND_MODES, aaLevel, normalizeTexture } from './brush.js';

// Default page dimensions until a real image sets them from its natural size.
export const PAGE_W = 850;
export const PAGE_H = 1200;

// The four faces a family can hold. A style has two independent switches (bold,
// italic) and this is their product; the app has no weight axis beyond it, so
// anything heavier than regular lands in `bold`.
export const FACE_SLOTS = ['regular', 'bold', 'italic', 'boldItalic'];

// A face map with nothing in it. A slot holds a descriptor `{ file }` - the
// name of the file the user dropped, or null for a built-in, whose bytes come
// from Google rather than from disk - and a null slot means "no real face
// exists", which is the app's only licence to let the browser synthesise one.
export function emptyFaces() {
  return { regular: null, bold: null, italic: null, boldItalic: null };
}

const googleFaces = (...slots) => {
  const faces = emptyFaces();
  for (const s of slots) faces[s] = { file: null };
  return faces;
};

// Built-in fonts: real, bundled Google Font families (loaded in index.html).
// Named by their actual family so nothing is misrepresented. Users add their
// own manga fonts via the Font Library (persisted in IndexedDB).
//
// The `faces` map is a claim about reality that the rest of the app trusts: the
// PSD exporter reads it to decide whether Photoshop has to be told to fake a
// face, and the Font Library shows the user which of their four faces are real.
// So it mirrors, face for face, what the Google Fonts URL in index.html
// actually requests - Bangers and the three handwriting families ship regular
// only, so their bold and italic really are synthesised and are recorded as
// absent. Extend one of the two and you must extend the other.
export const BUILTIN_FONTS = [
  { name: 'Bangers', css: "'Bangers', cursive", faces: googleFaces('regular') },
  { name: 'Comic Neue', css: "'Comic Neue', cursive", faces: googleFaces('regular', 'bold', 'italic', 'boldItalic') },
  { name: 'Patrick Hand', css: "'Patrick Hand', cursive", faces: googleFaces('regular') },
  { name: 'Permanent Marker', css: "'Permanent Marker', cursive", faces: googleFaces('regular') },
  { name: 'Architects Daughter', css: "'Architects Daughter', cursive", faces: googleFaces('regular') },
  { name: 'Nunito', css: "'Nunito', sans-serif", faces: googleFaces('regular', 'bold', 'italic', 'boldItalic') },
  { name: 'Playfair Display', css: "'Playfair Display', serif", faces: googleFaces('regular', 'bold', 'italic', 'boldItalic') },
  { name: 'Luckiest Guy', css: "'Luckiest Guy', cursive", faces: googleFaces('regular') },
  { name: 'Creepster', css: "'Creepster', cursive", faces: googleFaces('regular') },
  { name: 'Nosifer', css: "'Nosifer', cursive", faces: googleFaces('regular') },
  { name: 'Eater', css: "'Eater', cursive", faces: googleFaces('regular') },
  { name: 'Special Elite', css: "'Special Elite', cursive", faces: googleFaces('regular') },
  { name: 'Rock Salt', css: "'Rock Salt', cursive", faces: googleFaces('regular') },
  { name: 'Fredericka the Great', css: "'Fredericka the Great', cursive", faces: googleFaces('regular') },
  { name: 'Indie Flower', css: "'Indie Flower', cursive", faces: googleFaces('regular') },
  { name: 'Gloria Hallelujah', css: "'Gloria Hallelujah', cursive", faces: googleFaces('regular') },
  { name: 'Shadows Into Light', css: "'Shadows Into Light', cursive", faces: googleFaces('regular') },
  { name: 'Kalam', css: "'Kalam', cursive", faces: googleFaces('regular', 'bold') },
  { name: 'Caveat', css: "'Caveat', cursive", faces: googleFaces('regular', 'bold') },
  { name: 'Amatic SC', css: "'Amatic SC', cursive", faces: googleFaces('regular', 'bold') },
  { name: 'Bebas Neue', css: "'Bebas Neue', sans-serif", faces: googleFaces('regular') },
  { name: 'Anton', css: "'Anton', sans-serif", faces: googleFaces('regular') },
  { name: 'Oswald', css: "'Oswald', sans-serif", faces: googleFaces('regular', 'bold') },
  { name: 'Black Ops One', css: "'Black Ops One', cursive", faces: googleFaces('regular') },
  { name: 'Bungee', css: "'Bungee', cursive", faces: googleFaces('regular') },
  { name: 'Chewy', css: "'Chewy', cursive", faces: googleFaces('regular') },
  { name: 'Boogaloo', css: "'Boogaloo', cursive", faces: googleFaces('regular') },
  { name: 'Press Start 2P', css: "'Press Start 2P', monospace", faces: googleFaces('regular') },
  { name: 'Cinzel', css: "'Cinzel', serif", faces: googleFaces('regular', 'bold') },
  { name: 'Mansalva', css: "'Mansalva', cursive", faces: googleFaces('regular') },
  { name: 'Sedgwick Ave', css: "'Sedgwick Ave', cursive", faces: googleFaces('regular') },
  { name: 'Grandstander', css: "'Grandstander', cursive", faces: googleFaces('regular', 'bold', 'italic', 'boldItalic') },
  { name: 'Delius', css: "'Delius', cursive", faces: googleFaces('regular') },
  { name: 'Schoolbell', css: "'Schoolbell', cursive", faces: googleFaces('regular') },
  { name: 'Walter Turncoat', css: "'Walter Turncoat', cursive", faces: googleFaces('regular') },
  { name: 'Just Another Hand', css: "'Just Another Hand', cursive", faces: googleFaces('regular') },
  { name: 'Mouse Memoirs', css: "'Mouse Memoirs', sans-serif", faces: googleFaces('regular') },
  { name: 'Lilita One', css: "'Lilita One', cursive", faces: googleFaces('regular') },
  { name: 'Titan One', css: "'Titan One', cursive", faces: googleFaces('regular') },
  { name: 'Sigmar One', css: "'Sigmar One', cursive", faces: googleFaces('regular') },
  { name: 'Rubik Mono One', css: "'Rubik Mono One', monospace", faces: googleFaces('regular') },
];

// User fonts start empty and are populated only by real uploads (restored
// from IndexedDB on launch). No fake entries.
export const USER_FONTS = [];

export function fontCss(name, userFonts = USER_FONTS) {
  const f = [...BUILTIN_FONTS, ...userFonts].find((f) => f.name === name);
  return f ? f.css : "'Comic Neue', cursive";
}

// ===== the chapter's typesetting =====
// Stored in its chapter.json as `typesetting: { mode, version }` (DET-3).
//
//   mode      'smart' or 'plain'. It was once a switch for the whole chapter -
//             the shaped breaker, hyphenation and balloon layout, or the plain
//             wrap every build has - and the line breaking is each box's own
//             now (`style.shape`, `hyphenate`, `balloon`; the defaults are
//             "Hyphenate long words" in Settings). A chapter is created
//             'smart', and one saved 'plain' is opened as 'smart' with every
//             box set to the plain wrap it was drawn with
//             (`openTypesetting`), so nothing on its pages moves.
//   version   which engine last fitted the chapter's boxes: 1, the browser
//             (`LAYOUT_VERSION`, and what a file without the number means), or
//             2, the Rust text engine (`LAYOUT_VERSION_RUST`). The two measure
//             a little differently, so a chapter fitted by one can meet the
//             other with a height to grow or a flag to raise. Read at open,
//             with the Rust engine measuring: a chapter still at 1 is one that
//             engine has not fitted before, and the user is told what it
//             changed (`firstFit` in the store). Written by a save, never by
//             an open, and a save changes it only when an engine has in fact
//             fitted what is being written: 2 with the Rust engine measuring
//             and no box of the chapter still waiting for its font, 1 for a
//             2 with the browser measuring, and the number the file had in
//             every other case (`stampTypesetting`).
//
export const LAYOUT_VERSION = 1;
export const LAYOUT_VERSION_RUST = 2;

export function normalizeTypesetting(raw) {
  const light = normalizeLight(raw?.light);
  return {
    mode: raw?.mode === 'smart' ? 'smart' : 'plain',
    version: Number.isInteger(raw?.version) && raw.version > 0 ? raw.version : LAYOUT_VERSION,
    // Only a light that is not Photoshop's default is kept, so a chapter
    // that never turned it is written as it always was.
    ...(light.angle !== LIGHT_DEF.angle || light.altitude !== LIGHT_DEF.altitude ? { light } : null),
  };
}

// The chapter's Global Light, as Photoshop keeps one per document: the angle
// the light comes from (degrees, counter-clockwise from the right; 120 is
// from the upper left) and its altitude (0 to 90). A shadow with
// `useGlobalLight` is thrown away from it. A chapter with no `light` has
// this one.
export const LIGHT_DEF = Object.freeze({ angle: 120, altitude: 30 });
export function normalizeLight(l) {
  const a = num(l?.angle, LIGHT_DEF.angle);
  return {
    angle: Math.round((((a % 360) + 540) % 360 - 180) * 100) / 100,
    altitude: Math.min(90, Math.max(0, num(l?.altitude, LIGHT_DEF.altitude))),
  };
}

// What a chapter created now is stamped with.
export const newTypesetting = () => ({ mode: 'smart', version: LAYOUT_VERSION });

let legacyMode = 'plain';
export function setLegacyTypeset(mode) {
  legacyMode = mode === 'smart' ? 'smart' : 'plain';
}
// What a chapter with no `typesetting` field was laid out with on this machine.
export const legacyTypesetting = () => ({ mode: legacyMode, version: LAYOUT_VERSION });

// A box's style for the plain wrap: what the 'plain' chapter switch drew, as
// the box's own fields. `shape: 'off'` is the plain wrap (`layoutLines`), and
// hyphenation is read only by the shaped breaker, so it is turned off too and
// the box reads as plain in Bulk style. `balloon` stays as it was: besides the
// rows shaped lines are laid on, it is the limit a solved box grows to inside
// its balloon (`fitLimit`), which the chapter switch never turned off.
export const PLAIN_BREAKS = Object.freeze({ shape: 'off', hyphenate: false });

// A style given the plain wrap. The very object handed in when it already has
// it, or is not a style at all, so a caller can tell by identity whether
// anything changed.
export function plainStyle(s) {
  if (!s || typeof s !== 'object') return s;
  if ((s.shape ?? 'auto') === 'off' && s.hyphenate === false) return s;
  return { ...s, ...PLAIN_BREAKS };
}

// A chapter's typesetting as it is opened, and whether its boxes were laid out
// plain. A chapter saved 'plain' (or, with no field, laid out plain on this
// machine) opens 'smart' with every box given the plain wrap it was drawn with
// - by the load (`loadProjectPages`' `plain`), which owns the solver's records
// a box carries, and by the undo history (`openHistory`) - so the line
// breaking is each box's and nothing on the page moves. The file keeps what it
// had until a save writes the document, and an open writes nothing.
export function openTypesetting(raw) {
  const t = normalizeTypesetting(raw);
  if (t.mode === 'smart') return { typesetting: t, plain: false };
  return { typesetting: { ...t, mode: 'smart' }, plain: true };
}

// ===== typesetting defaults for a NEW box =====
// Five of the style properties below are not really styling at all - they are
// how the layout engine behaves - and they are set once, for the whole app, in
// Settings › Typesetting rather than per box in the Inspector. `prefs.svelte.js`
// owns the preference and mirrors it here with `setBoxDefaults`, because this
// module is a leaf: it imports nothing, which is what lets everyone else
// import it.
//
// The starting values are `defaultStyle()`'s own, so a build with nothing stored
// - and every style ever saved to disk - behaves exactly as it did before this
// existed.
const boxDefaults = {
  autoHeight: true,
  shape: 'auto',
  hyphenate: true,
  // `defaultStyle()`'s, as the rest are. The app starts it off ("Fit text to
  // balloon" is a beta), and says so through `setBoxDefaults` at boot.
  balloon: true,
  minOrphan: 3,
};

export function setBoxDefaults(next) {
  if (!next || typeof next !== 'object') return;
  // Assigned key by key, not swapped wholesale: a partial object from a caller
  // that only knows about four of the five must not delete the fifth.
  for (const k of Object.keys(boxDefaults)) {
    if (next[k] !== undefined) boxDefaults[k] = next[k];
  }
}

// Stamp the defaults onto a style a box is about to be born with.
//
// PRECEDENCE, and this is the whole of it:
//
//   these five flags   always come from the preferences. They are engine
//                      behaviour, they are set in Settings, and a box created
//                      after a switch was flipped honours the switch.
//   everything else    keeps inheriting `app.lastStyle` exactly as before - the
//                      font, size, colour and strokes the user chose by hand on
//                      the last box they touched.
//
// A duplicate is NOT a box born from nothing: `duplicateBox` copies its source's
// style whole, these five included, because a copy that laid its text out
// differently from the box it was copied from would not be a copy. Loading a
// chapter is the same: every saved style is taken as written.
//
// The alternative - letting `lastStyle` carry these five forward too - meant one
// bulk edit turning auto height off somewhere quietly became the default for
// every box placed afterwards, with nothing on screen saying so now that the
// Inspector no longer shows the flag. A box that needs a different answer gets
// it from the Bulk style panel, which still exposes all five.
export function applyBoxDefaults(style) {
  if (!style || typeof style !== 'object') return style;
  Object.assign(style, boxDefaults);
  // A newborn box never inherits the previous box's bezier path, mask shapes
  // or warp mesh: all three are that box's own geometry, and carried onto a box
  // of another size they curve, hide or deform text they were never drawn for.
  // A DUPLICATE keeps them - duplicateBox copies the style whole and does not
  // come through here - which is the same line the comment above draws.
  style.path = { on: false, pts: [] };
  style.clip = { on: false, mode: 'exclude', brushSize: style.clip?.brushSize ?? 20, shapes: [] };
  style.warp = { on: false, cols: WARP_MESH_DEFAULT, rows: WARP_MESH_DEFAULT, pts: [] };
  style.ink = { on: false, strokes: [] };
  // The SFX recipe is the same kind of thing: moves tuned against one box's
  // text and font. A newborn box is plain text until the user asks for one.
  style.sfx = sfxDefault();
  return style;
}

// default style applied to a freshly-dropped text box
// A fill pattern at its defaults (`defaultStyle().pattern`; the fields are
// told there).
function defaultPattern() {
  return {
    on: false,
    kind: 'dots',
    fg: '#000000',
    bg: '#ffffff',
    scale: 1,
    angle: 0,
    density: 0.5,
    aspect: 1,
    ox: 0,
    oy: 0,
    fgOpacity: 1,
    bgOpacity: 1,
    fade: { on: false, angle: 180, from: 0, to: 1 },
    anchor: 'box',
    seed: 1,
    src: '',
    cell: [],
    mode: 'tone',
  };
}

export function defaultStyle() {
  return {
    font: 'Comic Neue',
    size: 26,
    bold: false,
    italic: false,
    // How heavy a bold is (percent: 100 the bold as its face draws it, more
    // grows every letter by more synthesised bolds) and how far an italic
    // leans (degrees: ITALIC_ANGLE_DEF is the italic as drawn, more or less
    // leans it further or back). Each counts only while its switch is on.
    boldWeight: 100,
    italicAngle: 14,
    align: 'center',
    valign: 'middle', // top | middle | bottom
    // Whole-box alpha, applied over everything (fill, strokes, shadows).
    opacity: 1,
    // Photoshop's Blending Options. `fillOpacity` fades the fill alone: the
    // strokes and the shadows stay (the Rust engine paints it; the browser
    // engine does not). `blendMode` is how the letters blend with the page,
    // a LAYER_BLEND_MODES name; the Rust engine blends it with the page art
    // under the box (LAYER_STYLES_PLAN.md phase 6a, `backdrop.js`).
    fillOpacity: 1,
    blendMode: 'normal',
    // Photoshop's Advanced Blending (`normalizeBlending`). `interior` is
    // Blend Interior Effects as Group: Fill Opacity fades the overlays, the
    // satin and the inner glows with the fill. `knockout` is stored and
    // written to the PSD; it paints nothing while the page art is all a box
    // blends with (phase 6c). `channels` are Channels R, G, B: one off keeps
    // the page's. `blendIf` is Blend If, per Gray, Red, Green, Blue, This
    // Layer (the box's own colour) and Underlying Layer (the page art's),
    // each [black low, black high, white low, white high] on 0 to 255; the
    // full range hides nothing. Both are painted over the page art (phase 6b).
    blending: defaultBlending(),
    // ---- fill ----
    // Solid fill colour. Still the single source for the glyph colour when
    // neither gradient nor pattern is on; when one of them is on it is the
    // colour behind the fill layer (and the PSD fallback colour).
    color: '#000000',
    // The bubble picks `color` and the first stroke's colour (LET-3): black or
    // white text, whichever stands out on the bubble, and the stroke the other
    // one. Set on a box born in plain black or white, cleared the moment a
    // colour is set by hand. Absent on a style saved before it existed: off.
    autoContrast: false,
    // Gradient fill. `scope` decides what the gradient spans: 'box' runs once
    // across the whole text block, 'line' restarts on every wrapped line.
    // `kind` is 'linear' or 'radial'.
    // `angle` uses CSS linear-gradient degrees: 0 = bottom→top, 90 = left→right,
    // 180 = top→bottom. `stops` is kept sorted by `pos` (0..1), between
    // GRADIENT_MIN_STOPS and GRADIENT_MAX_STOPS of them, each one a colour, a
    // position and its own `opacity` (0..1) - the alpha the ramp reaches at that
    // point, which is separate from `fillOpacity` (the whole fill layer) and
    // from `opacity` (the whole box).
    // A radial gradient ignores `angle` and reads `cx`/`cy` instead - the centre
    // as a fraction of the fill rect, 0.5/0.5 being the middle - plus `radius`,
    // which multiplies the distance from that centre to the rect's farthest
    // corner (the size CSS calls `farthest-corner`, and the one both renderers
    // compute from the same helper).
    gradient: {
      on: false,
      kind: 'linear', // 'linear' | 'radial'
      angle: 180,
      cx: 0.5,
      cy: 0.5,
      radius: 1,
      scope: 'box', // 'box' | 'line'
      stops: [
        { color: '#ffffff', pos: 0, opacity: 1 },
        { color: '#9a9a9a', pos: 1, opacity: 1 },
      ],
    },
    // Pattern fill, tiled. `kind` is one of PATTERN_KINDS below, or 'picked'
    // (a tile taken from the page, `src` and `cell`). `fg` draws the pattern,
    // `bg` is what shows between. The tile is `size * 0.3 * scale` page px
    // square, so it scales with the font; a picked tile is its own cell times
    // `scale`. Pattern wins over gradient when both are on.
    //
    // Everything after `scale` is painted only by the Rust engine, which shades
    // the pattern per pixel (`Fill::Screen`); the browser engine repeats a
    // canvas tile of the first eleven kinds and reads none of it. Each one's
    // default is the old look:
    //   angle      degrees the pattern is turned by
    //   density    0..1 ink, 0.5 the kind as designed
    //   aspect     stretch along the tile's own x
    //   ox, oy     offset, in tiles (0..1)
    //   fgOpacity, bgOpacity   0 bg = no ground, the letters' own page shows
    //   fade       density ramps to nothing across the fill rect: `angle` as a
    //              gradient's, full ink up to `from`, none from `to` (0..1)
    //   anchor     'box': the tile starts at the box; 'page': at the page's
    //              corner, so tones line up across boxes
    //   seed       the random kinds' arrangement
    //   src, cell  a picked tile: its file in <chapter>/patterns/, and the
    //              lattice cell `[ax, ay, bx, by]` in page px it repeats on
    //   mode       picked: 'tone' recolours it with fg/bg, 'image' keeps it
    pattern: defaultPattern(),
    // No fill at all: the letters are cut out of their own strokes, so what
    // shows is each stroke's visible width and the page through the letter.
    // It wins over the pattern and the gradient, and a box with no stroke
    // either shows only its layer effects. A shadow is then the strokes'
    // shadow. As Photoshop's Fill 0 %, the interior effects, the Photoshop
    // strokes and the bevel are still laid from the letters' shape (Rust).
    noFill: false,
    // ---- strokes ----
    // Ordered innermost first: strokes[0] sits right against the glyph,
    // strokes[1] goes around strokes[0], and so on. Rendered outermost first so
    // each inner one paints over the one outside it. `width` is the VISIBLE
    // width of that band in page px (the renderer draws 2x centred and lets the
    // fill / inner stroke cover the inside half). Empty array = no stroke.
    strokes: [{ color: '#ffffff', width: 3, opacity: 1 }],
    // ---- shadows ----
    // Any number, painted in order under the text (shadows[0] on top of the
    // others). Empty array = no shadow. Each shadow uses the glyph outline plus
    // all strokes as its shape.
    shadows: [],
    // Photoshop's Outer Glow, Inner Glow, Inner Shadow and Color Overlay
    // (`normalizeGlow`, `normalizeInnerShadow`, `normalizeOverlay`). The Rust
    // engine paints them; the browser engine does not. Of the lists, the first
    // is on top.
    outerGlow: glowDefault(false),
    innerGlow: glowDefault(true),
    innerShadows: [],
    colorOverlays: [],
    // Photoshop's Gradient Overlay (a list), Pattern Overlay (one) and Stroke
    // (a list: `strokeEffects`, apart from `strokes`, the outlines above).
    // `normalizeGradientOverlay`, `normalizePatternOverlay`,
    // `normalizeStrokeEffect`. The Rust engine paints them; the browser
    // engine does not.
    gradientOverlays: [],
    patternOverlay: patternOverlayDefault(),
    // Photoshop's Satin (one, `normalizeSatin`). The Rust engine paints it;
    // the browser engine does not.
    satin: satinDefault(),
    // Photoshop's Bevel & Emboss (one, `normalizeBevel`). The Rust engine
    // paints it; the browser engine does not.
    bevel: bevelDefault(),
    strokeEffects: [],
    // How the outlines are laid: 'merged' (one shape under the fill) or
    // 'each' (letter by letter, a later letter's rim over an earlier
    // letter's fill), with 'round' or 'miter' corners. `strokeShade` (0..1)
    // throws a hard copy of the outer outline down-right, a shade side.
    strokeOrder: 'merged',
    strokeJoin: 'round',
    strokeShade: 0,
    // Effects the SFX types use, any box may: a negative (the letters grown
    // into one blob, `grow` ems, the outlines round the blob), an extrude
    // (the letters stacked `length` ems along `angle` degrees, with an edge
    // in `edge` when it is set), a shake (`count` copies each way, `amp`
    // ems apart along `angle`) and a trail (SFX only: `count` fading copies
    // `dist` ems back along each letter's path).
    negative: { on: false, grow: 0.15, color: '#111111' },
    extrude: { on: false, angle: 135, length: 0.3, color: '#111111', edge: '' },
    shake: { on: false, count: 2, amp: 0.06, angle: 0 },
    trail: { on: false, count: 3, dist: 0.25 },
    // Gaussian blur of the whole text (fill + strokes + shadows), page px.
    blur: 0,
    // Directional smear of the whole text, on top of (and after) `blur`.
    // `x`/`y` are the direction vector in pixels per unit step, and `amount` is
    // the iteration count of the Experience-Monks gaussian. Both renderers
    // build the smear from the same tap list - see `motionBlurTaps` in
    // text-paint.js. Direction (0,0) draws nothing.
    motionBlur: { on: false, x: 2, y: 0, amount: 16 },
    // Text on an editable bezier path. `pts` is the path's anchors in
    // box-local page px (origin at the box's top-left, unscaled), each with
    // its in/out handle as an OFFSET from the anchor. Empty until the effect
    // is first switched on, when the editor seeds the default path - a
    // straight three-point line across the box's middle. When `on` and
    // `pts` has at least two anchors, this wins over `curve` below.
    path: { on: false, pts: [] },
    // The visibility mask: shapes the user paints over the box that hide
    // ('exclude') or solely keep ('include') the text's ink under them. Not
    // tied to the box rect or the balloon fit - the shapes are their own
    // geometry, in box-local page px (origin at the box top-left; they may
    // reach outside the box). Three shape kinds, all plain JSON:
    //   { kind: 'ellipse', cx, cy, rx, ry }
    //   { kind: 'poly',    pts: [[x, y], ...] }        (>= 3 points)
    //   { kind: 'stroke',  size, pts: [[x, y], ...] }  (a brush drag)
    // With no shapes the mask does nothing, whichever mode is set - so a box
    // that only flipped the switch looks exactly like the switch is off.
    clip: { on: false, mode: 'exclude', brushSize: 20, shapes: [] },
    // Hand-drawn brush strokes inside the box, in the same box-local page px
    // the mask shapes use. Each stroke is self-describing - every field that
    // decides how it renders is on the stroke, not on the tool - so a stroke
    // drawn last week still draws the same after the brush settings moved on.
    // `pts` is [x, y, w] or [x, y, w, o, f]: w is the point's width factor in
    // 0..1, already resolved from pen pressure, stroke speed or randomness when
    // it was drawn, and o and f are its opacity and thickness factors on the
    // same terms - absent when the dynamics left them at 1 (see `PT_O`,
    // `PT_F` in brush.js).
    // Taper is deliberately NOT baked in: it is cheap at render time and stays
    // adjustable afterwards.
    ink: { on: false, strokes: [] },
    // The mesh the WHOLE box is drawn through - font text and ink together,
    // through one texture. `cols`/`rows` are cells, so 1x1 is the four corner
    // handles CSP calls Free Transform and anything larger is Mesh Transform.
    // `pts` are the grid's control points in box-local page px (origin at the
    // box's top-left, same space `clip.shapes` and `ink` use), row-major,
    // (cols+1) * (rows+1) of them - and EMPTY means identity: a mesh that has
    // never been dragged stores no points at all, and every renderer skips the
    // pass. `warp.js` owns the geometry; this is only its storage.
    // Not to be confused with the Effects panel's `warp` sub-tab, which is the
    // arc/circle/path group - this is the `transform` sub-tab.
    warp: { on: false, cols: WARP_MESH_DEFAULT, rows: WARP_MESH_DEFAULT, pts: [] },
    // Text closed into a full circle (see `circleLayout`): the ring's size
    // comes from the text's own advance, `angle` (degrees, clockwise) turns
    // it, `inside` flips the text onto the inner face - the bottom arc of a
    // badge. Sits between `path` and `curve` in precedence: path > circle >
    // arc. `r` is a chosen radius in page px that replaces the advance-derived
    // one; 0 means auto (the closed ring). With a radius set the text need not
    // reach round - it is an arc centred on `angle`.
    circle: { on: false, angle: 0, inside: false, r: 0 },
    // SFX lettering: one of the engine's twelve sound types (`kind`), its
    // letters laid along a path per text group (a line, or a side of a `/`),
    // sized, turned and kerned by the Rust engine (`sfxPlace`). It is a fourth
    // glyph-by-glyph layout and takes precedence over path, circle and arc,
    // but it exists only while the Rust engine is the text engine: under the
    // browser engine the box is plain text (see `sfxActive`, sfx.js).
    // Every layout number left null is the type's own; a number set is the
    // user's. Lengths are ems of the box's size, angles degrees. `paths` are
    // the box's own (ems from its centre), empty for the type's. `glyphs`
    // holds hand edits by `group:index`. `caption` is small text beside it.
    sfx: sfxDefault(),
    uppercase: false,
    lineHeight: 1.1,
    letterSpacing: 0,
    rotation: 0,
    // mirror flip (applied around the box centre, inside rotation)
    flipH: false, // horizontal mirror (left↔right)
    flipV: false, // vertical mirror (top↔bottom)
    // rough / distressed edges (SVG feDisplacementMap). `grit` is a fine tear
    // over the crumple, page px, drawn only by a painter that roughens the
    // outlines (the Rust engine's): moved pixels tear on their own.
    roughen: { on: false, amount: 4, detail: 0.05, seed: 7, grit: 0 },
    // warp: per-character circular arc, -100..100 (negative = frown, positive = smile)
    curve: 0,
    // ---- typesetting (see typeset.js) ----
    // How lines are broken. 'auto' is the scanlation shaping - square or oval
    // block, no hourglass, no orphaned short words, no word ever split - with
    // each line filling the room its row has. 'oval' and 'rect' are the same
    // shaping aiming for a tapered or an even block within that room (BRK-3;
    // `shape` in typeset.js). 'off' hands the job back to plain greedy CSS
    // wrapping.
    shape: 'auto',
    // A word with fewer letters than this never sits alone on a line.
    minOrphan: 3,
    // Whether a word that fits on no line of this block may be split with a
    // hyphen. On by default: a tall narrow balloon with a name in it is the case
    // the rule was written for, and without it the name simply hangs out of the
    // bubble. `typeset.js` states the conditions - the word has to fit nowhere,
    // the split has to win on price, and the pieces have to be pronounceable -
    // and they are narrow enough that ordinary dialogue never meets them.
    hyphenate: true,
    // Outline fit (outline-fit.js): the air between the glyph ink and the
    // bubble outline, in em. Null is the layout every box had before it: the
    // balloon's safety inset and the shape that explains the outline. A number
    // lays the text out to the outline polygon itself, with this much air on
    // every side, and lets the solver choose the line breaks (`auto.breaks`).
    margin: null,
    // Whether this box lays its text out to the balloon it was fitted to. The
    // shape itself lives on the BOX (`box.fit`) rather than in the style,
    // because it is measured geometry in page coordinates and not a preference;
    // this is the preference, and it is here so a bulk edit can turn balloon
    // layout off across a page of boxes that were fitted to the wrong thing.
    // A box with no `fit` ignores it entirely and lays out rectangular, exactly
    // as every box did before fitting existed.
    balloon: true,
    // The box's HEIGHT follows its text: it grows so the wrapped block fits,
    // anchored by `valign`. Width is never touched automatically - the width is
    // what the user aimed at the bubble.
    autoHeight: true,
    // "Fit to box": the box's width and height are the user's, and the font
    // size is the largest that fills them, no larger than `fitMax` (0: the
    // size the box had when it was switched on). It wins over `autoHeight`.
    // `sizingOf` reads the three sizing modes off these two switches.
    fitText: false,
    fitMax: 0,
  };
}

// The three ways a box is sized, as the Inspector offers them:
//   'auto'   Auto height - the user sets the width and the size; the height
//            follows the text.
//   'fixed'  Fixed - the user sets all three; text that does not fit is
//            flagged, never resized.
//   'fit'    Fit to box - the user sets the width and the height; the size
//            is the largest that fits, up to `fitMax`.
export function sizingOf(style) {
  if (style?.fitText) return 'fit';
  return style?.autoHeight === false ? 'fixed' : 'auto';
}

// The type size the user sets. In Fit to box the size itself is the fit's
// answer, so what the user sets there is the most it may grow to (`fitMax`).
// The Inspector's size field and the bigger/smaller keys both go through these,
// so they agree on which number they change.
export const SIZE_MIN = 6;
export const SIZE_MAX = 200;
export function sizeSetting(style) {
  return style.fitText && style.fitMax > 0 ? style.fitMax : style.size;
}
export function setSizeSetting(style, v) {
  const n = Math.min(SIZE_MAX, Math.max(SIZE_MIN, +v || SIZE_MIN));
  if (style.fitText) style.fitMax = n;
  else style.size = n;
}
// A step bigger or smaller lands on a whole size: autofit leaves fractional
// sizes behind, and 23.4 stepped up should read 24, not 24.4.
export function steppedSize(v, d) {
  const n = d > 0 ? Math.floor(v) + d : Math.ceil(v) + d;
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, n));
}

// merge older/partial styles up to the current schema (back-compat for saved data)
//
// The flat spread is the whole migration for a flat key: a style saved before
// `shape`/`minOrphan`/`autoHeight` existed simply has no such property, so
// `defaultStyle()`'s value stands. Nested groups are merged by name, because a
// spread would otherwise replace the whole group with a partial one.
//
// Two old fields are migrated rather than merged, and this is the only place in
// the app that still knows they existed:
//
//   outline + outlineWidth  ->  strokes[0]   (width 0 / missing -> no stroke)
//   shadow { on, ... }      ->  shadows      ([] when `on` was false)
//
// A style that already carries `strokes` / `shadows` is taken as written; the
// legacy keys are then dropped so nothing downstream can read a stale copy.
const STROKE_DEF = { color: '#ffffff', width: 3, opacity: 1 };
const BLOCK_SHAPES = ['auto', 'oval', 'rect', 'off'];
const SHADOW_DEF = { x: 2, y: 2, size: 2.33, color: '#000000', opacity: 0.6 };

// Photoshop's blend modes, in its menu's order. The index is the number the
// engine reads (`Blend::from_u32` in text-engine/src/paint/fx/blend.rs).
export const LAYER_BLEND_MODES = [
  'normal', 'dissolve',
  'darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color',
  'lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color',
  'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix',
  'difference', 'exclusion', 'subtract', 'divide',
  'hue', 'saturation', 'color', 'luminosity',
];
const blendMode = (v, d) => (LAYER_BLEND_MODES.includes(v) ? v : d);

// Photoshop's Knockout: None, Shallow, Deep.
export const KNOCKOUT_MODES = ['none', 'shallow', 'deep'];

// Blend If's channels, in Photoshop's Blend If menu order, and a slider at
// its ends (black low, black high, white low, white high: nothing hidden).
export const BLEND_IF_CHANNELS = ['gray', 'red', 'green', 'blue'];
export const BLEND_RANGE_FULL = [0, 0, 255, 255];

/** Advanced Blending at Photoshop's defaults (`defaultStyle`'s `blending`). */
export function defaultBlending() {
  return {
    interior: false,
    knockout: 'none',
    channels: { r: true, g: true, b: true },
    blendIf: Object.fromEntries(BLEND_IF_CHANNELS.map((c) => [c, { this: [...BLEND_RANGE_FULL], under: [...BLEND_RANGE_FULL] }])),
  };
}

/**
 * One Blend If slider, as Photoshop keeps it: four whole levels 0 to 255,
 * black low <= black high <= white low <= white high. A handle dragged past
 * the one after it pushes that one along (the dialog's rule: the black point
 * cannot pass the white). Anything unreadable is the full range.
 */
export function normalizeBlendRange(x) {
  if (!Array.isArray(x) || x.length !== 4) return [...BLEND_RANGE_FULL];
  const v = x.map((n, i) => {
    const k = Number(n);
    return Number.isFinite(k) ? Math.min(255, Math.max(0, Math.round(k))) : BLEND_RANGE_FULL[i];
  });
  for (let i = 1; i < 4; i++) v[i] = Math.max(v[i], v[i - 1]);
  return v;
}

/** Whether a Blend If (`blending.blendIf`) hides anything. */
export function blendIfActive(blendIf) {
  return BLEND_IF_CHANNELS.some((c) => ['this', 'under'].some((side) => {
    const q = blendIf?.[c]?.[side];
    return Array.isArray(q) && q.some((v, i) => v !== BLEND_RANGE_FULL[i]);
  }));
}

/** A style's Advanced Blending options, every field present (`defaultStyle`'s `blending`). */
export function normalizeBlending(x) {
  const ch = x?.channels;
  return {
    interior: x?.interior === true,
    knockout: KNOCKOUT_MODES.includes(x?.knockout) ? x.knockout : 'none',
    channels: { r: ch?.r !== false, g: ch?.g !== false, b: ch?.b !== false },
    blendIf: Object.fromEntries(BLEND_IF_CHANNELS.map((c) => [c, {
      this: normalizeBlendRange(x?.blendIf?.[c]?.this),
      under: normalizeBlendRange(x?.blendIf?.[c]?.under),
    }])),
  };
}

// Photoshop's contour presets, in its picker's order (`PRESETS` and
// `preset_name` in text-engine/src/paint/fx/contour.rs), and 'custom' for a curve of points.
export const CONTOUR_PRESETS = [
  'linear', 'cone', 'cone-inverted', 'cove-deep', 'cove-shallow', 'gaussian',
  'half-round', 'ring', 'ring-double', 'rolling-slope-descending', 'rounded-steps', 'sawtooth-1',
];
// Their names as Photoshop's picker shows them.
export const CONTOUR_LABELS = {
  linear: 'Linear',
  cone: 'Cone',
  'cone-inverted': 'Cone - Inverted',
  'cove-deep': 'Cove - Deep',
  'cove-shallow': 'Cove - Shallow',
  gaussian: 'Gaussian',
  'half-round': 'Half Round',
  ring: 'Ring',
  'ring-double': 'Ring - Double',
  'rolling-slope-descending': 'Rolling Slope - Descending',
  'rounded-steps': 'Rounded Steps',
  'sawtooth-1': 'Sawtooth 1',
  custom: 'Custom',
};
// A contour: a preset, or `custom` with points `[x, y, corner]` from 0 to 255
// in order of x; `aa` is Photoshop's Anti-aliased box.
export function normalizeContour(c) {
  const preset = c?.preset === 'custom' || CONTOUR_PRESETS.includes(c?.preset) ? c.preset : 'linear';
  const out = { preset, aa: c?.aa === true };
  if (preset === 'custom') {
    const pts = (Array.isArray(c.pts) ? c.pts : [])
      .filter((q) => Array.isArray(q) && Number.isFinite(+q[0]) && Number.isFinite(+q[1]))
      .map((q) => [Math.min(255, Math.max(0, +q[0])), Math.min(255, Math.max(0, +q[1])), q[2] === true])
      .sort((a, b) => a[0] - b[0])
      // A smooth point that shares its x with another has no curve through it
      // (the spline would floor the gap and run to 0 or 255). At a repeated x
      // the corners stay (two are a vertical step) and the smooth points go,
      // before or after them; with no corner there, the first smooth one
      // stays. The Rust `contour.rs` `points` keeps the same rule.
      .filter((q, i, all) => {
        const twins = all.filter((p) => p[0] === q[0]);
        return twins.some((p) => p[2]) ? q[2] : twins[0] === q;
      })
      .slice(0, 64);
    if (pts.length < 2) return { preset: 'linear', aa: out.aa };
    out.pts = pts;
  }
  return out;
}

// What a canvas shadow's `blur` (twice a gaussian's sigma) is as Photoshop's
// Size, whose tent blurs about as much as a gaussian of `0.4 * size`
// (`shadowSigma`): how a shadow saved before Size existed keeps its softness.
// The old default blur of 4 is Photoshop's default Size of 5.
const sizeFromBlur = (blur) => (blur > 0 ? Math.round(blur * 125) / 100 : 0);
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
// Exactly the lengths CSS reads as hex: 3/4-digit shorthand and 6/8-digit full
// forms. A 5- or 7-digit string is a typo mid-edit, not a colour - accepting it
// would store a value neither renderer can paint.
const hex = (v, d) => (typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : d);

export function normalizeStroke(x) {
  return { color: hex(x?.color, STROKE_DEF.color), width: Math.max(0, num(x?.width, STROKE_DEF.width)), opacity: Math.min(1, Math.max(0, num(x?.opacity, 1))) };
}
// A box's strokes and shadows together, copied and normalised: the finish a
// sound effect's ink wears (see `drawInk`), as the brush tool carries it and
// as `addInkBox` writes it. Zero-width strokes are dropped, as `normalizeStyle`
// drops them.
export function normalizeFinish(finish) {
  return {
    strokes: (Array.isArray(finish?.strokes) ? finish.strokes : [])
      .map(normalizeStroke)
      .filter((k) => k.width > 0),
    shadows: (Array.isArray(finish?.shadows) ? finish.shadows : []).map(normalizeShadow),
  };
}

// A Drop Shadow, as Photoshop's dialog has it:
//   x, y        where it is thrown, page px (Angle and Distance in the panel)
//   size        how far its soft edge reaches, page px, 0 to 250
//   spread      0..1: the share of the size the matte is grown by, not blurred
//   noise       0..1
//   blend       a LAYER_BLEND_MODES name
//   contour     how the edge falls off (`normalizeContour`)
//   knockout    Layer Knocks Out Drop Shadow
//   useGlobalLight  its angle is the chapter's light (`globalLight` in
//               text-paint.js) and only its distance is its own
// A shadow saved before these existed had `blur` (a canvas blur) and is read
// as the same softness, Normal, not knocked out, its own angle: as it looked.
export function normalizeShadow(x) {
  const size = Number.isFinite(+x?.size) ? +x.size : Number.isFinite(+x?.blur) ? sizeFromBlur(Math.max(0, +x.blur)) : SHADOW_DEF.size;
  return {
    x: num(x?.x, SHADOW_DEF.x),
    y: num(x?.y, SHADOW_DEF.y),
    size: Math.min(SHADOW_SIZE_MAX, Math.max(0, size)),
    color: hex(x?.color, SHADOW_DEF.color),
    opacity: Math.min(1, Math.max(0, num(x?.opacity, SHADOW_DEF.opacity))),
    spread: Math.min(1, Math.max(0, num(x?.spread, 0))),
    noise: Math.min(1, Math.max(0, num(x?.noise, 0))),
    blend: blendMode(x?.blend, 'normal'),
    contour: normalizeContour(x?.contour),
    knockout: x?.knockout === true,
    useGlobalLight: x?.useGlobalLight === true,
  };
}
// Photoshop's Size and Distance limits.
export const SHADOW_SIZE_MAX = 250;
export const SHADOW_DISTANCE_MAX = 30000;
// A shadow as Photoshop adds one: Multiply, 75%, the chapter's light, 5 away,
// size 5, knocked out by the letters; or the person's own default for one
// (`fxDefault`, Make Default), thrown from the same light.
export function newShadow(light = { angle: 120 }) {
  return newFx('dropShadow', light);
}
function factoryShadow(light = { angle: 120 }) {
  const a = (light.angle * Math.PI) / 180;
  const r2 = (v) => Math.round(v * 100) / 100;
  return normalizeShadow({
    x: r2(-Math.cos(a) * 5),
    y: r2(Math.sin(a) * 5),
    size: 5,
    color: '#000000',
    opacity: 0.75,
    blend: 'multiply',
    knockout: true,
    useGlobalLight: true,
  });
}
// Outer Glow and Inner Glow, as Photoshop's dialog has them:
//   on          the effect's box in the list
//   blend, opacity, noise, color     Structure
//   fill        'color' | 'gradient': the colour, or `gradient` (an effect
//               gradient, `normalizeFxGradient`) run along the glow, its
//               first stop at the edge
//   technique   'softer' | 'precise'
//   spread      Spread (outer) or Choke (inner), 0..1
//   size        page px, 0 to 250
//   source      inner only: 'edge' | 'center'
//   contour, range   Quality: the falloff's shape, and the share of it the
//               contour is spread over (0.01..1)
//   jitter      Quality > Jitter, 0..1: scatters each pixel's sample of the
//               gradient (a colour glow ignores it)
// The defaults are Photoshop's (PhotoCraft's `fresh_effect`): Screen, 75 %,
// the pale yellow, Softer, size 5, range 50 %.
function glowDefault(inner) {
  const g = { on: false, blend: 'screen', opacity: 0.75, noise: 0, color: '#ffffbe', fill: 'color', gradient: glowGradient('#ffffbe'), technique: 'softer', spread: 0, size: 5, contour: { preset: 'linear', aa: false }, range: 0.5, jitter: 0 };
  if (inner) g.source = 'edge';
  return g;
}
export function normalizeGlow(x, inner = false) {
  const d = glowDefault(inner);
  const g = {
    on: x?.on === true,
    blend: blendMode(x?.blend, d.blend),
    opacity: Math.min(1, Math.max(0, num(x?.opacity, d.opacity))),
    noise: Math.min(1, Math.max(0, num(x?.noise, 0))),
    color: hex(x?.color, d.color),
    fill: x?.fill === 'gradient' ? 'gradient' : 'color',
    gradient: normalizeFxGradient(x?.gradient, glowGradient(hex(x?.color, d.color))),
    technique: x?.technique === 'precise' ? 'precise' : 'softer',
    spread: Math.min(1, Math.max(0, num(x?.spread, 0))),
    size: Math.min(SHADOW_SIZE_MAX, Math.max(0, num(x?.size, d.size))),
    contour: normalizeContour(x?.contour),
    range: Math.min(1, Math.max(0.01, num(x?.range, d.range))),
    jitter: Math.min(1, Math.max(0, num(x?.jitter, 0))),
  };
  if (inner) g.source = x?.source === 'center' ? 'center' : 'edge';
  return g;
}
// An Inner Shadow: a Drop Shadow's fields (`normalizeShadow`) thrown into
// the letters, with Choke where a drop shadow has Spread and no knockout.
export function normalizeInnerShadow(x) {
  const { spread, knockout, ...sh } = normalizeShadow(x);
  return { ...sh, choke: Math.min(1, Math.max(0, num(x?.choke, 0))) };
}
// One as Photoshop adds it: Multiply, black, 75 %, the chapter's light, 5
// away, size 5 (or the person's default, `fxDefault`).
export function newInnerShadow(light = { angle: 120 }) {
  return newFx('innerShadow', light);
}
function factoryInnerShadow(light) {
  const { knockout, ...sh } = factoryShadow(light);
  return normalizeInnerShadow(sh);
}
// A Color Overlay: a flat colour over the letters' fill, in its own mode.
export function normalizeOverlay(x) {
  return {
    color: hex(x?.color, '#ff0000'),
    opacity: Math.min(1, Math.max(0, num(x?.opacity, 1))),
    blend: blendMode(x?.blend, 'normal'),
  };
}
// Photoshop's new one: Normal, red, 100 % (or the person's default).
export function newOverlay() {
  return newFx('colorOverlay');
}

// An effect gradient, as Photoshop's Gradient Overlay, a gradient Stroke and
// a gradient glow take one (PhotoCraft's `Gradient`):
//   style     FX_GRADIENT_STYLES
//   angle     degrees, counter-clockwise from pointing right (90 runs bottom
//             to top), as Photoshop's dial; a turned box turns it with it
//   scale     0.1..1.5, 1 is 100 %
//   reverse   the ramp the other way
//   offset    [x, y], the centre moved by that share of the letters' frame
//             (Photoshop's drag in the dialog)
//   stops     GRADIENT_MIN_STOPS..GRADIENT_MAX_STOPS, each a colour, a
//             position and its own opacity, sorted by position
//   type      FX_GRADIENT_TYPES: 'solid' paints the stops, 'noise' the
//             Rust engine's random ramp from `noise` (the stops are kept for
//             a switch back)
//   noise     Photoshop's noise gradient (`normalizeNoiseGradient`)
// Photoshop's Align with Layer is always on: the gradient spans the letters'
// frame (a stroke's, the frame grown by the stroke). 'shapeburst' runs from
// the painted shape's edge (the letters', or a stroke's outer edge) in to its
// deepest point; Angle and the offset do not move it. A glow's gradient runs
// along the glow whatever its style.
export const FX_GRADIENT_STYLES = ['linear', 'radial', 'angle', 'reflected', 'diamond', 'shapeburst'];
export const FX_GRADIENT_TYPES = ['solid', 'noise'];
// A noise gradient, as Photoshop's Gradient Editor has one:
//   seed          the random seed (Randomize picks a new one), 0..2^32-1
//   roughness     0..1: how many steps and how sharp
//   model         NOISE_MODELS: the channels walk in RGB, HSB or LAB
//   min, max      each channel's Limits, 0..1 of its range, min <= max
//   restrict      Restrict Colors: no oversaturated colours
//   transparency  Add Transparency: a random alpha too
// The defaults are Photoshop's dialog: 50 %, RGB, full limits, Restrict on.
export const NOISE_MODELS = ['rgb', 'hsb', 'lab'];
export function normalizeNoiseGradient(x) {
  const src = x && typeof x === 'object' ? x : {};
  const lim = (a, i, d) => Math.min(1, Math.max(0, num(Array.isArray(a) ? a[i] : undefined, d)));
  const min = [0, 1, 2].map((i) => lim(src.min, i, 0));
  const max = [0, 1, 2].map((i) => Math.max(min[i], lim(src.max, i, 1)));
  const seed = Math.floor(num(src.seed, 1));
  return {
    seed: Number.isFinite(seed) ? seed >>> 0 : 1,
    roughness: Math.min(1, Math.max(0, num(src.roughness, 0.5))),
    model: NOISE_MODELS.includes(src.model) ? src.model : 'rgb',
    min,
    max,
    restrict: src.restrict !== false,
    transparency: src.transparency === true,
  };
}
const FX_BW = [
  { color: '#000000', pos: 0, opacity: 1 },
  { color: '#ffffff', pos: 1, opacity: 1 },
];
function fxGradientDefault(stops = FX_BW) {
  return { style: 'linear', angle: 90, scale: 1, reverse: false, offset: [0, 0], stops: stops.map((st) => ({ ...st })), type: 'solid', noise: normalizeNoiseGradient({}) };
}
// A glow's gradient as Photoshop starts one: its colour, fading out.
function glowGradient(color) {
  return fxGradientDefault([
    { color, pos: 0, opacity: 1 },
    { color, pos: 1, opacity: 0 },
  ]);
}
export function normalizeFxGradient(x, d = fxGradientDefault()) {
  const src = x && typeof x === 'object' ? x : {};
  const off = Array.isArray(src.offset) ? src.offset : d.offset;
  const stops = Array.isArray(src.stops) && src.stops.length >= GRADIENT_MIN_STOPS ? src.stops : d.stops;
  return {
    style: FX_GRADIENT_STYLES.includes(src.style) ? src.style : d.style,
    angle: Math.min(180, Math.max(-180, num(src.angle, d.angle))),
    scale: Math.min(1.5, Math.max(0.1, num(src.scale, d.scale))),
    reverse: src.reverse === true,
    offset: [0, 1].map((i) => Math.min(1, Math.max(-1, num(off[i], 0)))),
    stops: stops
      .map(normalizeStop)
      .sort((a, b) => a.pos - b.pos)
      .slice(0, GRADIENT_MAX_STOPS),
    type: src.type === 'noise' ? 'noise' : 'solid',
    noise: normalizeNoiseGradient(src.noise ?? d.noise),
  };
}
// A Gradient Overlay: an effect gradient over the letters' fill.
export function normalizeGradientOverlay(x) {
  return {
    blend: blendMode(x?.blend, 'normal'),
    opacity: Math.min(1, Math.max(0, num(x?.opacity, 1))),
    gradient: normalizeFxGradient(x?.gradient),
  };
}
// Photoshop's new one: Normal, 100 %, black to white at 90 degrees (or the
// person's default).
export function newGradientOverlay() {
  return newFx('gradientOverlay');
}
// The Pattern Overlay: one of the fill's own patterns (`normalizePattern`)
// over the letters' fill, in its own mode. Its tile follows the box's size
// as the fill's does; `scale`, `angle` and `anchor` are the pattern's.
function patternOverlayDefault() {
  return { on: false, blend: 'normal', opacity: 1, pattern: { ...defaultPattern(), on: true } };
}
export function normalizePatternOverlay(x) {
  const d = patternOverlayDefault();
  return {
    on: x?.on === true,
    blend: blendMode(x?.blend, d.blend),
    opacity: Math.min(1, Math.max(0, num(x?.opacity, d.opacity))),
    pattern: { ...normalizePattern(x?.pattern, d.pattern), on: true },
  };
}
// Photoshop's Satin, as its dialog has it: two softened copies of the
// letters thrown `distance` apart each way along `angle`, the gap between
// them laid inside the letters.
//   on, blend, color, opacity    Structure
//   angle       degrees, the box's own: Satin has no Global Light
//   distance    page px, 0..250 (0 is drawn as 1, as Photoshop does)
//   size        page px, 0..250
//   contour     `normalizeContour`; Satin reads it from its far end
//   invert      lay the inverse of the gap
// The defaults are PhotoCraft's dialog defaults (Photoshop's): Multiply,
// black, 50 %, 19 degrees, 11 px, size 14, Linear, anti-aliased, inverted.
export const SATIN_DISTANCE_MAX = 250;
function satinDefault() {
  return { on: false, blend: 'multiply', color: '#000000', opacity: 0.5, angle: 19, distance: 11, size: 14, contour: { preset: 'linear', aa: true }, invert: true };
}
export function normalizeSatin(x) {
  const d = satinDefault();
  const a = num(x?.angle, d.angle);
  return {
    on: x?.on === true,
    blend: blendMode(x?.blend, d.blend),
    color: hex(x?.color, d.color),
    opacity: Math.min(1, Math.max(0, num(x?.opacity, d.opacity))),
    // -180..180, as Photoshop's dial reads; past it, turned back into it.
    angle: Math.round((Math.abs(a) <= 180 ? a : (((a % 360) + 540) % 360) - 180) * 100) / 100,
    distance: Math.min(SATIN_DISTANCE_MAX, Math.max(0, num(x?.distance, d.distance))),
    size: Math.min(SHADOW_SIZE_MAX, Math.max(0, num(x?.size, d.size))),
    contour: x?.contour ? normalizeContour(x.contour) : { ...d.contour },
    invert: typeof x?.invert === 'boolean' ? x.invert : d.invert,
  };
}

// Photoshop's Bevel & Emboss, as its dialog has it.
// Structure:
//   style       BEVEL_STYLES: Inner Bevel, Outer Bevel, Emboss, Pillow
//               Emboss, Stroke Emboss (a bevel of the Photoshop strokes' band)
//   technique   BEVEL_TECHNIQUES: Smooth, Chisel Hard, Chisel Soft
//   depth       0..10 (1 is Photoshop's 100 %)
//   direction   'up' | 'down'
//   size        page px, 0..250 (0 is drawn as 1 device px)
//   soften      page px, 0..16
// Shading:
//   useGlobalLight  angle and altitude are the chapter's (`light`)
//   angle       degrees, -180..180, its own when off the Global Light
//   altitude    degrees, 0..90
//   gloss       the Gloss Contour (`normalizeContour`)
//   highlight, shadow   { blend, color, opacity }: each half of the shading
// Elements, each with its own switch:
//   contour     { on, curve (`normalizeContour`), range 0..1 }: reshapes the
//               height. Range is carried; the engine does not paint it yet.
//   texture     { on, pattern (as the Pattern Overlay's), scale 0.01..10
//               (Photoshop's 1-1000 %), depth -10..10 (negative carves),
//               invert, link (the pattern moves with the box, else it is
//               fixed to the page) }
// A style saved before it existed has the defaults: Photoshop's (PhotoCraft
// `effect_defaults`), switched off.
export const BEVEL_STYLES = ['inner', 'outer', 'emboss', 'pillow', 'stroke'];
export const BEVEL_TECHNIQUES = ['smooth', 'chisel-hard', 'chisel-soft'];
export const BEVEL_DIRECTIONS = ['up', 'down'];
export const BEVEL_DEPTH_MAX = 10;
export const BEVEL_SOFTEN_MAX = 16;
export const BEVEL_TEXTURE_SCALE_MIN = 0.01;
export const BEVEL_TEXTURE_SCALE_MAX = 10;
function bevelDefault() {
  return {
    on: false,
    style: 'inner',
    technique: 'smooth',
    depth: 1,
    direction: 'up',
    size: 5,
    soften: 0,
    useGlobalLight: true,
    angle: 120,
    altitude: 30,
    gloss: { preset: 'linear', aa: false },
    highlight: { blend: 'screen', color: '#ffffff', opacity: 0.75 },
    shadow: { blend: 'multiply', color: '#000000', opacity: 0.75 },
    contour: { on: false, curve: { preset: 'linear', aa: false }, range: 0.5 },
    texture: { on: false, pattern: { ...defaultPattern(), on: true }, scale: 1, depth: 1, invert: false, link: true },
  };
}
export function normalizeBevel(x) {
  const d = bevelDefault();
  const clamp = (v, lo, hi, def) => Math.min(hi, Math.max(lo, num(v, def)));
  const a = num(x?.angle, d.angle);
  const shade = (v, def) => ({
    blend: blendMode(v?.blend, def.blend),
    color: hex(v?.color, def.color),
    opacity: clamp(v?.opacity, 0, 1, def.opacity),
  });
  const c = x?.contour && typeof x.contour === 'object' ? x.contour : {};
  const t = x?.texture && typeof x.texture === 'object' ? x.texture : {};
  return {
    on: x?.on === true,
    style: BEVEL_STYLES.includes(x?.style) ? x.style : d.style,
    technique: BEVEL_TECHNIQUES.includes(x?.technique) ? x.technique : d.technique,
    depth: clamp(x?.depth, 0, BEVEL_DEPTH_MAX, d.depth),
    direction: BEVEL_DIRECTIONS.includes(x?.direction) ? x.direction : d.direction,
    size: clamp(x?.size, 0, SHADOW_SIZE_MAX, d.size),
    soften: clamp(x?.soften, 0, BEVEL_SOFTEN_MAX, d.soften),
    useGlobalLight: typeof x?.useGlobalLight === 'boolean' ? x.useGlobalLight : d.useGlobalLight,
    // -180..180, as Photoshop's dial reads; past it, turned back into it.
    angle: Math.round((Math.abs(a) <= 180 ? a : (((a % 360) + 540) % 360) - 180) * 100) / 100,
    altitude: clamp(x?.altitude, 0, 90, d.altitude),
    gloss: x?.gloss ? normalizeContour(x.gloss) : { ...d.gloss },
    highlight: shade(x?.highlight, d.highlight),
    shadow: shade(x?.shadow, d.shadow),
    contour: {
      on: c.on === true,
      curve: c.curve ? normalizeContour(c.curve) : { ...d.contour.curve },
      range: clamp(c.range, 0, 1, d.contour.range),
    },
    texture: {
      on: t.on === true,
      pattern: { ...normalizePattern(t.pattern, d.texture.pattern), on: true },
      scale: clamp(t.scale, BEVEL_TEXTURE_SCALE_MIN, BEVEL_TEXTURE_SCALE_MAX, d.texture.scale),
      depth: clamp(t.depth, -BEVEL_DEPTH_MAX, BEVEL_DEPTH_MAX, d.texture.depth),
      invert: t.invert === true,
      link: typeof t.link === 'boolean' ? t.link : d.texture.link,
    },
  };
}

// Photoshop's Stroke effect, apart from the outlines (`strokes`):
//   size       page px, 0..250
//   position   STROKE_POSITIONS: outside the letters' edge, inside it, or
//              half and half
//   blend, opacity
//   fill       STROKE_FILLS: `color`, `gradient` (an effect gradient over the
//              stroke's own frame) or `pattern` (as the fill's)
// Of the list the first is on top: a higher stroke covers the ones under it.
// The defaults are PhotoCraft's: 1 px, Inside, black, Normal, 100 %.
export const STROKE_POSITIONS = ['outside', 'inside', 'center'];
export const STROKE_FILLS = ['color', 'gradient', 'pattern'];
export function normalizeStrokeEffect(x) {
  return {
    size: Math.min(SHADOW_SIZE_MAX, Math.max(0, num(x?.size, 1))),
    position: STROKE_POSITIONS.includes(x?.position) ? x.position : 'inside',
    blend: blendMode(x?.blend, 'normal'),
    opacity: Math.min(1, Math.max(0, num(x?.opacity, 1))),
    fill: STROKE_FILLS.includes(x?.fill) ? x.fill : 'color',
    color: hex(x?.color, '#000000'),
    gradient: normalizeFxGradient(x?.gradient),
    pattern: { ...normalizePattern(x?.pattern, { ...defaultPattern(), on: true }), on: true },
  };
}
export function newStrokeEffect() {
  return newFx('strokeEffect');
}

// ===== Make Default / Reset to Default (LAYER_STYLES_PLAN.md item 12) =====
// Photoshop keeps, for each effect, the values a new one starts from: "Make
// Default" saves an effect's settings as that default, "Reset to Default"
// puts an effect back to it, and the built-in values (the factory) stay under
// both. Ours are per app, the person's, as Photoshop's are: `prefs.svelte.js`
// holds them (`prefs.fxDefaults`) and mirrors them here with `setFxDefaults`,
// the way `setBoxDefaults` works, because this module imports nothing.
//
// A default decides what Add (and switching on an effect never edited) and
// Reset give. It changes no stored box: a stored effect is whole. A new box
// still inherits the last box's effects (`app.lastStyle`).
//
// The stored form is the effect as its normaliser returns it, minus what
// belongs to one instance: `on`, the random seeds (`gradient.noise.seed`,
// a pattern's `seed`) and a tile picked from a page (`src`, `cell`). A
// shadow keeps its distance, its Use Global Light and, off the light, its own
// angle, never its x and y: those would freeze one chapter's light into the
// default.
export const FX_KINDS = ['dropShadow', 'innerShadow', 'outerGlow', 'innerGlow', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'strokeEffect', 'satin', 'bevel', 'blending'];
// The effects a style has one of, each with its own switch (`on`).
const FX_SINGLE = ['outerGlow', 'innerGlow', 'patternOverlay', 'satin', 'bevel'];
const fxDefaults = {};

const wrapAngle = (a) => Math.round((Math.abs(a) <= 180 ? a : (((a % 360) + 540) % 360) - 180) * 100) / 100;
const round2 = (v) => Math.round(v * 100) / 100 || 0;

// The built-in effect of a kind, as a new one is made: a shadow thrown from
// `light`.
function factoryFx(kind, light) {
  switch (kind) {
    case 'dropShadow': return factoryShadow(light);
    case 'innerShadow': return factoryInnerShadow(light);
    default: return normalizeFxKind(kind, {});
  }
}

// Every kind but the two shadows, through its own normaliser.
function normalizeFxKind(kind, x) {
  switch (kind) {
    case 'outerGlow': return normalizeGlow(x, false);
    case 'innerGlow': return normalizeGlow(x, true);
    case 'colorOverlay': return normalizeOverlay(x);
    case 'gradientOverlay': return normalizeGradientOverlay(x);
    case 'patternOverlay': return normalizePatternOverlay(x);
    case 'strokeEffect': return normalizeStrokeEffect(x);
    case 'satin': return normalizeSatin(x);
    case 'bevel': return normalizeBevel(x);
    case 'blending': return normalizeBlending(x);
    default: return null;
  }
}

// Where an effect keeps its gradients and patterns, for the seeds and picked
// tiles that are the instance's own.
const fxGradients = (kind, fx) => (kind === 'outerGlow' || kind === 'innerGlow' || kind === 'gradientOverlay' || kind === 'strokeEffect' ? [fx.gradient] : []).filter(Boolean);
const fxPatterns = (kind, fx) => (kind === 'patternOverlay' || kind === 'strokeEffect' ? [fx.pattern] : kind === 'bevel' ? [fx.texture?.pattern] : []).filter(Boolean);

/**
 * An effect (an instance, or a default as stored) in the stored form, or null
 * when it is not an effect of that kind at all. Anything unreadable in it
 * takes the factory value, as the normalisers do.
 */
export function fxStored(kind, x) {
  if (!FX_KINDS.includes(kind) || !x || typeof x !== 'object' || Array.isArray(x)) return null;
  try {
    if (kind === 'dropShadow' || kind === 'innerShadow') {
      const sh = kind === 'dropShadow' ? normalizeShadow(x) : normalizeInnerShadow(x);
      // A stored default says its distance (and angle); an instance its x, y.
      const stored = Number.isFinite(+x.distance) && x.distance !== null && x.distance !== '';
      const distance = Math.min(SHADOW_DISTANCE_MAX, Math.max(0, stored ? +x.distance : Math.hypot(sh.x, sh.y)));
      const own = stored ? num(x.angle, LIGHT_DEF.angle) : sh.x || sh.y ? (Math.atan2(sh.y, -sh.x) * 180) / Math.PI : LIGHT_DEF.angle;
      const { x: _x, y: _y, ...rest } = sh;
      return { ...rest, distance: round2(distance), ...(rest.useGlobalLight ? null : { angle: wrapAngle(own) }) };
    }
    const fx = normalizeFxKind(kind, x);
    if (FX_SINGLE.includes(kind)) delete fx.on;
    for (const g of fxGradients(kind, fx)) delete g.noise.seed;
    for (const p of fxPatterns(kind, fx)) {
      delete p.seed;
      if (p.kind === 'picked') p.kind = defaultPattern().kind;
      delete p.src;
      delete p.cell;
    }
    return fx;
  } catch {
    return null;
  }
}

// An instance from a stored default: a shadow thrown from `light` when it is
// on the Global Light, else from its own angle.
function fxFromStored(kind, d, light) {
  if (kind === 'dropShadow' || kind === 'innerShadow') {
    const { distance, angle, ...rest } = d;
    const a = rest.useGlobalLight ? num(light?.angle, LIGHT_DEF.angle) : num(angle, LIGHT_DEF.angle);
    const r = (a * Math.PI) / 180;
    const off = { x: round2(-Math.cos(r) * distance), y: round2(Math.sin(r) * distance) };
    return kind === 'dropShadow' ? normalizeShadow({ ...rest, ...off }) : normalizeInnerShadow({ ...rest, ...off });
  }
  return normalizeFxKind(kind, d);
}

/** Every kind's stored default from what was handed in (a stored blob, say); kinds that are not readable are left out. */
export function normalizeFxDefaults(x) {
  const out = {};
  if (!x || typeof x !== 'object' || Array.isArray(x)) return out;
  for (const k of FX_KINDS) {
    const v = fxStored(k, x[k]);
    if (v) out[k] = v;
  }
  return out;
}

/** The person's effect defaults, from prefs.svelte.js: the whole set, replacing the last. */
export function setFxDefaults(next) {
  const clean = normalizeFxDefaults(next);
  for (const k of FX_KINDS) {
    if (clean[k]) fxDefaults[k] = clean[k];
    else delete fxDefaults[k];
  }
}

/** A new effect of `kind` from the person's default (a shadow thrown from `light`), or null when there is none. */
export function fxDefault(kind, light = LIGHT_DEF) {
  const d = fxDefaults[kind];
  return d ? fxFromStored(kind, structuredClone(d), light) : null;
}

/** A new effect of `kind`: the person's default, else the factory's. */
export function newFx(kind, light = LIGHT_DEF) {
  return fxDefault(kind, light) ?? factoryFx(kind, light);
}

/**
 * Reset to Default (or, `factory`, to the built-in values): the values for
 * `inst`, a plain object to assign over it. Its switch and its seeds stay
 * its own.
 */
export function fxReset(kind, inst, light = LIGHT_DEF, factory = false) {
  const next = factory ? factoryFx(kind, light) : newFx(kind, light);
  if (!next) return null;
  if (FX_SINGLE.includes(kind)) next.on = inst?.on === true;
  const ga = fxGradients(kind, inst ?? {});
  fxGradients(kind, next).forEach((g, i) => {
    if (Number.isFinite(ga[i]?.noise?.seed)) g.noise.seed = ga[i].noise.seed;
  });
  const pa = fxPatterns(kind, inst ?? {});
  fxPatterns(kind, next).forEach((p, i) => {
    if (Number.isFinite(pa[i]?.seed)) p.seed = pa[i].seed;
  });
  return next;
}

/** Whether a one-of effect still has the factory's values (its switch and seeds aside): never edited. */
export function fxUntouched(kind, inst) {
  const a = fxStored(kind, inst);
  return !!a && JSON.stringify(a) === JSON.stringify(fxStored(kind, factoryFx(kind)));
}
// One hand-drawn brush stroke, sanitised. Returns null for a stroke that
// cannot be drawn at all - no points, or a size of zero - because a stroke
// that paints nothing is worse than no stroke: it still costs a history slot
// and a bounds pass. Individual unreadable points are dropped, the way a mask
// shape's are, so one bad number does not lose the whole gesture.
//
// There is deliberately no `dyn` here. The size dynamics - source, strength and
// the imported response curve - are CAPTURE-time inputs: `buildStroke` resolves
// them once and bakes the answer into each point's third number, which this
// clamps to 0..1 like any other width. So a saved project reproduces a curved
// stroke exactly without storing the curve, and a stroke drawn with a brush that
// was later re-imported or re-tuned still draws as the ink the letterer
// accepted. A `dyn` on a stroke would be a field nothing ever reads.
export function normalizeInkStroke(src) {
  if (!src || typeof src !== 'object') return null;
  const pts = [];
  for (const q of Array.isArray(src.pts) ? src.pts : []) {
    if (!Array.isArray(q)) continue;
    const x = +q[0];
    const y = +q[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const w = Number.isFinite(+q[2]) ? Math.min(1, Math.max(0, +q[2])) : 1;
    // The opacity and thickness factors ride along only when the point has
    // them, so a stroke drawn without those dynamics stays three numbers.
    if (q.length > 3) {
      const o = Number.isFinite(+q[3]) ? Math.min(1, Math.max(0, +q[3])) : 1;
      const f = Number.isFinite(+q[4]) ? Math.min(1, Math.max(0, +q[4])) : 1;
      pts.push([x, y, w, o, f]);
    } else pts.push([x, y, w]);
  }
  if (!pts.length) return null;
  const size = Math.min(2000, Math.max(0.5, num(src.size, 24)));
  const taper = (t, d) => ({
    on: !!t?.on,
    len: Math.min(500, Math.max(0, num(t?.len, d))),
    ratio: Math.min(100, Math.max(0, num(t?.ratio, 60))),
    // 'pct' reads `len` as a percentage of the size; anything else is px,
    // which is what every stroke saved before the mode existed meant.
    mode: t?.mode === 'pct' ? 'pct' : 'px',
  });
  return {
    brush: typeof src.brush === 'string' && src.brush ? src.brush : 'round',
    size,
    color: hex(src.color, '#000000'),
    opacity: Math.min(1, Math.max(0, num(src.opacity, 1))),
    // Spacing is a percentage of the tip's size. Below 1% the stamp count
    // explodes with no visible gain, so that is the floor.
    spacing: Math.min(200, Math.max(1, num(src.spacing, 10))),
    hardness: Math.min(100, Math.max(0, num(src.hardness, 100))),
    angle: ((num(src.angle, 0) % 360) + 360) % 360,
    angleJitter: Math.min(100, Math.max(0, num(src.angleJitter, 0))),
    // The three tip behaviours read like the watercolour edge below: only a
    // literal true switches one on, so a stroke saved before it existed keeps
    // the fixed, stamped, alpha-over tip it was drawn with.
    followDir: src.followDir === true,
    ribbon: src.ribbon === true,
    darkenTips: src.darkenTips === true,
    // A tip cycle is a list of brush ids; anything that is not one, or that
    // holds fewer than two, is no cycle and the stroke draws its one brush.
    ...(Array.isArray(src.tips) && src.tips.filter((t) => typeof t === 'string' && t).length > 1
      ? {
        tips: src.tips.filter((t) => typeof t === 'string' && t),
        tipOrder: ['repeat', 'reverse', 'once', 'random'].includes(src.tipOrder) ? src.tipOrder : 'repeat',
      }
      : null),
    // The flips: anything but a mode the engine knows is no flip.
    flipX: FLIP_MODES.includes(src.flipX) ? src.flipX : 'off',
    flipY: FLIP_MODES.includes(src.flipY) ? src.flipY : 'off',
    // Flatness squashes the tip across its angle. 1 is round; 0 would be a
    // line with no area, so the floor is a hair above it.
    flatness: Math.min(1, Math.max(0.01, num(src.flatness, 1))),
    // Anti-aliasing is a grade, 0 None to 3 Strong. A stroke saved when it
    // was a switch stored true or false, which are the two ends of the scale;
    // anything else - and junk - keeps the smooth edge it was drawn with.
    antialias: aaLevel(src.antialias),
    blend: BLEND_MODES.includes(src.blend) ? src.blend : 'over',
    texture: normalizeTexture(src.texture),
    // The threshold the pointed corners are found at, degrees; 0 draws none,
    // which is every stroke saved before corners could be pointed.
    corners: Math.min(180, Math.max(0, num(src.corners, 0))),
    // The watercolour edge reads the other way round: only a literal true asks
    // for the rim, so a stroke saved before the pass existed - which is every
    // stroke drawn so far - loads as the plain ink it was drawn as.
    waterEdge: src.waterEdge === true,
    // The band is stated in page px so it comes out the same width at any zoom
    // and any export scale. Past 20 px the rim stops being a rim.
    waterEdgeWidth: Math.min(20, Math.max(1, num(src.waterEdgeWidth, 4))),
    waterEdgePower: Math.min(1, Math.max(0, num(src.waterEdgePower, 0.5))),
    waterEdgeDark: Math.min(1, Math.max(0, num(src.waterEdgeDark, 0))),
    waterEdgeBlur: Math.min(20, Math.max(0, num(src.waterEdgeBlur, 0))),
    taperIn: taper(src.taperIn, 20),
    taperOut: taper(src.taperOut, 20),
    // The seed makes angle jitter repeatable: the same stroke must draw the
    // same picture in the editor and in the export.
    seed: Math.max(1, Math.floor(num(src.seed, 1))),
    pts,
  };
}
// How coarse a warp mesh may get. One cell is the four corner handles (free
// transform) and is the floor because a mesh with no cell is not a mesh.
// Twenty-four is the ceiling: the liquify tool builds meshes far finer than a
// hand would drag, and past this the triangle count per frame stops paying
// for itself. The gizmo shows handles only up to `HANDLE_GRID_MAX` (see
// warp-gizmo.js); a finer mesh draws as hairlines. Stated here, beside the
// sanitiser that enforces them, so the panel's steppers and a hand-edited file
// meet the same limits - `warp.js` itself imposes none, being pure geometry.
export const WARP_MIN_GRID = 1;
export const WARP_MAX_GRID = 24;
// The grid a box starts with, and the one the panel's Mesh mode returns to from
// Free: three cells a side, which is CSP's own lattice default (four points a
// side), coarse enough to drag by hand and fine enough to bend a word.
export const WARP_MESH_DEFAULT = 3;

// The mesh, gated. `pts` is all-or-nothing, unlike a mask shape's points or an
// ink stroke's: a mesh missing one control point is not a coarser mesh, it is a
// torn one, and there is no honest way to guess where the missing handle was.
// So a `pts` that is not exactly (cols+1) * (rows+1) finite pairs is reset to
// the empty array - which every renderer reads as identity, the same as a warp
// that was never dragged.
//
// `on` is taken as given either way. A box whose mesh was lost still knows the
// user had the effect switched on, and switching it back off for them would
// silently drop a state they set; with no points it simply draws unwarped,
// which is what an untouched warp does too.
export function normalizeWarp(src) {
  const grid = (v) => Math.min(WARP_MAX_GRID, Math.max(WARP_MIN_GRID, Math.round(num(v, WARP_MESH_DEFAULT))));
  const cols = grid(src?.cols);
  const rows = grid(src?.rows);
  const want = (cols + 1) * (rows + 1);
  const pts = [];
  if (Array.isArray(src?.pts) && src.pts.length === want) {
    for (const p of src.pts) {
      if (!Array.isArray(p)) break;
      const x = +p[0];
      const y = +p[1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) break;
      pts.push([x, y]);
    }
  }
  return { on: src?.on === true, cols, rows, pts: pts.length === want ? pts : [] };
}

// Every procedural pattern, in the engine's own order (`PATTERN_NAMES` in
// text-engine/src/paint/screen.rs; pattern-screen.engine.test.js holds the
// two lists together). A kind that is not on this list, or 'picked' without a
// tile, is normalized back to the default.
//
// The first eleven are the ones the canvas draws (`drawPatternTile`), for the
// browser engine; it paints any other kind as 'dots'.
// Bold weight, percent, and italic angle, degrees (`boldWeight`,
// `italicAngle`). 14 degrees is the lean of a synthesised italic (a quarter of
// the height), the one an italic is taken to have as drawn.
export const BOLD_WEIGHT_MIN = 100;
export const BOLD_WEIGHT_MAX = 400;
export const ITALIC_ANGLE_MIN = -20;
export const ITALIC_ANGLE_MAX = 45;
export const ITALIC_ANGLE_DEF = 14;

export const PATTERN_KINDS = [
  'dots',
  'halftone',
  'stripes',
  'hstripes',
  'diagonal',
  'diagonal-alt',
  'crosshatch',
  'checker',
  'grid',
  'vlines',
  'hlines',
  'halftone-fade',
  'square-dots',
  'diamond-dots',
  'line-tone',
  'sand',
  'stipple',
  'speed-lines',
  'burst',
  'rings',
  'waves',
  'zigzag',
  'bricks',
  'scales',
  'hex',
  'triangles',
  'plus',
  'stars',
  'hearts',
  'kakeami',
  'glitch',
  'dither',
  'dither-dots',
];
export const CANVAS_PATTERN_KINDS = PATTERN_KINDS.slice(0, 11);
// The kinds whose look a seed changes.
export const SEEDED_PATTERN_KINDS = ['sand', 'stipple', 'speed-lines', 'kakeami', 'glitch'];
export const PATTERN_ANCHORS = ['box', 'page'];
export const PATTERN_MODES = ['tone', 'image'];
// A picked tile's file: its content hash, as `<chapter>/patterns/` names it.
export const PATTERN_SRC = /^[0-9a-f]{16,64}\.png$/;

/** Names of every picked tile `pages` refer to, on or off. */
export function patternSrcsUsed(pages) {
  const out = new Set();
  for (const p of pages ?? []) {
    for (const b of p?.boxes ?? []) {
      const src = b?.style?.pattern?.src;
      if (typeof src === 'string' && PATTERN_SRC.test(src)) out.add(src);
    }
  }
  return out;
}

// A picked tile's lattice cell, `[ax, ay, bx, by]` page px, or [] when it is
// not one (not four finite numbers, or the two edges are parallel).
export function normalizePatternCell(c) {
  if (!Array.isArray(c) || c.length !== 4) return [];
  const v = c.map(Number);
  if (!v.every(Number.isFinite)) return [];
  const area = Math.abs(v[0] * v[3] - v[1] * v[2]);
  return area > 1e-3 ? v : [];
}

export const GRADIENT_KINDS = ['linear', 'radial'];

// How many stops a gradient may carry. Two is the floor because one stop is not
// a gradient, it is a fill; eight is the ceiling because the editor's stop bar
// is 280px of panel wide and past that the handles have nowhere to sit. Both
// renderers cope with any count - the limits are the panel's, stated here so the
// loader and the panel agree on them.
export const GRADIENT_MIN_STOPS = 2;
export const GRADIENT_MAX_STOPS = 8;

// One stop, gated. Everything a stop can arrive missing has an answer: a
// gradient saved before per-stop alpha existed has no `opacity` at all, and 1 is
// what it was painting with, so it keeps painting the same.
function normalizeStop(st) {
  return {
    color: hex(st?.color, '#000000'),
    pos: Math.min(1, Math.max(0, num(st?.pos, 0))),
    opacity: Math.min(1, Math.max(0, num(st?.opacity, 1))),
  };
}

// At most this many text groups: a group past it joins the last.
export const SFX_MAX_GROUPS = 4;
export const SFX_DIRS = ['h', 'v'];
export const SFX_CAPTION_SIDES = ['below', 'above', 'left', 'right'];
export const STROKE_ORDERS = ['merged', 'each'];
export const STROKE_JOINS = ['round', 'miter'];

// What the Layout tab (and the bulk panel) accept for line height and letter
// spacing. Wide enough for SFX lettering, where letters overlap and rows
// crowd: down to half an em of letter gap (page px, so it scales with the
// size) and 0.4 line height. The old -5..40 px and 0.6..3 clamps snapped an
// SFX preset's own values back the first time the field was touched.
export const LINE_HEIGHT_MIN = 0.4;
export const LINE_HEIGHT_MAX = 3;
export function letterSpacingRange(size) {
  const em = Number(size) > 0 ? Number(size) : 0;
  return { min: Math.min(-5, -0.5 * em), max: Math.max(40, em) };
}

function sfxDefault() {
  return {
    on: false,
    kind: null,
    seed: 1,
    // The three intensity dials, 0..100, 50 the type as designed: how big
    // the size flow runs, how rough the letters jitter, how much they lean
    // and climb (the engine applies them to the type's numbers).
    power: 50,
    rough: 50,
    momentum: 50,
    dir: null,
    joinBars: true,
    kern: true,
    flow: null,
    follow: null,
    gap: null,
    bigTighter: null,
    slant: null,
    rise: null,
    jitter: null,
    paths: [],
    glyphs: {},
    caption: { text: '', side: 'below', size: 0.3, color: '#111111' },
    before: null,
  };
}

// The box as it stood before SFX went on, for Remove SFX to put back
// (`clearSfx`, sfx.js): the bends SFX switched off, `look` (the whole style
// but the SFX recipe and the brush ink: size, turn, fill, outlines and the
// rest) and `box` (its width and height). Null while SFX is off. A box made
// SFX by the SFX tool has no `look` or `box`: it was never anything else.
function normalizeSfxBefore(b) {
  if (!b || typeof b !== 'object') return null;
  const out = { curve: num(b.curve, 0), circle: b.circle === true, path: b.path === true };
  if (b.look && typeof b.look === 'object') out.look = JSON.parse(JSON.stringify(b.look));
  const w = num(b.box?.w, 0);
  const h = num(b.box?.h, 0);
  if (w > 0 && h > 0) out.box = { w, h };
  return out;
}

const finiteOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clampOrNull = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const pt = (q) => (Array.isArray(q) && q.length === 2 && q.every((v) => Number.isFinite(v)) ? [q[0], q[1]] : null);

// One text group's path, ems from the box centre, or null when unreadable.
function normalizeSfxPath(q) {
  const a = pt(q?.a);
  const b = pt(q?.b);
  if (!a || !b) return null;
  return { a, b, bend: Math.min(2, Math.max(-2, finiteOr(q.bend, 0))) };
}

// A recipe saved by the move-based SFX (before the sound types): it has
// `moves`, `amount` or a `flow` name. Opened as the closest type, laid out
// fresh; the look the box has stays (decision D4, docs/giongo).
function isOldSfx(x) {
  return Array.isArray(x?.moves) || typeof x?.flow === 'string' || typeof x?.amount === 'number';
}

// The intensity dials. A recipe saved with one `strength` (0..2, 1 the type
// as designed) has all three set from it.
function sfxMacros(x, d) {
  const dial = (v, def) => Math.min(100, Math.max(0, num(v, def)));
  const old = typeof x?.strength === 'number' && Number.isFinite(x.strength) && x.power === undefined
    ? dial(50 + (x.strength - 1) * 50, 50)
    : null;
  return {
    power: old ?? dial(x?.power, d.power),
    rough: old ?? dial(x?.rough, d.rough),
    momentum: old ?? dial(x?.momentum, d.momentum),
  };
}

// The SFX recipe, gated field by field. A type is the engine's to know, so a
// name is only checked to be a name.
export function normalizeSfx(x) {
  const d = sfxDefault();
  if (isOldSfx(x)) {
    return { ...d, on: x.on === true, kind: x.flow === 'stack' ? 'small' : 'impact', seed: Math.min(9999, Math.max(1, Math.round(num(x.seed, 1)))) };
  }
  const paths = [];
  for (const q of Array.isArray(x?.paths) ? x.paths : []) {
    if (paths.length >= SFX_MAX_GROUPS) break;
    const p = normalizeSfxPath(q);
    if (p) paths.push(p);
  }
  const glyphs = {};
  for (const [key, g] of Object.entries(x?.glyphs && typeof x.glyphs === 'object' ? x.glyphs : {})) {
    if (!/^\d+:\d+$/.test(key) || !g || typeof g !== 'object') continue;
    const e = {
      dx: Math.min(20, Math.max(-20, finiteOr(g.dx, 0))),
      dy: Math.min(20, Math.max(-20, finiteOr(g.dy, 0))),
      rot: Math.min(360, Math.max(-360, finiteOr(g.rot, 0))),
      s: Math.min(5, Math.max(0.1, finiteOr(g.s, 1))),
    };
    if (e.dx || e.dy || e.rot || e.s !== 1) glyphs[key] = e;
  }
  const flow = x?.flow && typeof x.flow === 'object'
    ? { from: Math.min(4, Math.max(0.1, finiteOr(x.flow.from, 1))), to: Math.min(4, Math.max(0.1, finiteOr(x.flow.to, 1))), pow: Math.min(5, Math.max(0.2, finiteOr(x.flow.pow, 1))) }
    : null;
  const jitter = x?.jitter && typeof x.jitter === 'object'
    ? { rot: Math.min(45, Math.max(0, finiteOr(x.jitter.rot, 0))), size: Math.min(1, Math.max(0, finiteOr(x.jitter.size, 0))), off: Math.min(1.5, Math.max(0, finiteOr(x.jitter.off, 0))) }
    : null;
  const c = x?.caption && typeof x.caption === 'object' ? x.caption : {};
  return {
    on: x?.on === true,
    kind: typeof x?.kind === 'string' && x.kind ? x.kind : null,
    seed: Math.min(9999, Math.max(1, Math.round(num(x?.seed, d.seed)))),
    ...sfxMacros(x, d),
    dir: SFX_DIRS.includes(x?.dir) ? x.dir : null,
    joinBars: x?.joinBars !== false,
    kern: x?.kern !== false,
    flow,
    follow: clampOrNull(x?.follow, 0, 1),
    gap: clampOrNull(x?.gap, -1, 2),
    bigTighter: clampOrNull(x?.bigTighter, 0, 1),
    slant: clampOrNull(x?.slant, -45, 45),
    rise: clampOrNull(x?.rise, -30, 30),
    jitter,
    paths,
    glyphs,
    caption: {
      text: typeof c.text === 'string' ? c.text : '',
      side: SFX_CAPTION_SIDES.includes(c.side) ? c.side : d.caption.side,
      size: Math.min(1, Math.max(0.1, num(c.size, d.caption.size))),
      color: hex(c.color, d.caption.color),
    },
    before: normalizeSfxBefore(x?.before),
  };
}

// The SFX effects' fields of a style, each checked (see `defaultStyle`).
export function normalizeEffects(src) {
  const d = defaultStyle();
  const o = (v) => (v && typeof v === 'object' ? v : {});
  const neg = o(src?.negative);
  const ex = o(src?.extrude);
  const sh = o(src?.shake);
  const tr = o(src?.trail);
  return {
    strokeOrder: STROKE_ORDERS.includes(src?.strokeOrder) ? src.strokeOrder : d.strokeOrder,
    strokeJoin: STROKE_JOINS.includes(src?.strokeJoin) ? src.strokeJoin : d.strokeJoin,
    strokeShade: Math.min(1, Math.max(0, num(src?.strokeShade, 0))),
    negative: { on: neg.on === true, grow: Math.min(1, Math.max(0, num(neg.grow, d.negative.grow))), color: hex(neg.color, d.negative.color) },
    extrude: {
      on: ex.on === true,
      angle: num(ex.angle, d.extrude.angle),
      length: Math.min(2, Math.max(0, num(ex.length, d.extrude.length))),
      color: hex(ex.color, d.extrude.color),
      edge: ex.edge === '' ? '' : hex(ex.edge, ''),
    },
    shake: {
      on: sh.on === true,
      count: Math.min(4, Math.max(1, Math.round(num(sh.count, d.shake.count)))),
      amp: Math.min(1, Math.max(0, num(sh.amp, d.shake.amp))),
      angle: num(sh.angle, d.shake.angle),
    },
    trail: {
      on: tr.on === true,
      count: Math.min(6, Math.max(1, Math.round(num(tr.count, d.trail.count)))),
      dist: Math.min(2, Math.max(0, num(tr.dist, d.trail.dist))),
    },
  };
}

// A style's pattern, every field checked. A pattern saved before the Rust
// fill had only on/kind/fg/bg/scale, and gets the defaults for the rest,
// which paint what it painted.
export function normalizePattern(p, d = defaultStyle().pattern) {
  const src = p && typeof p === 'object' ? p : {};
  const clamp = (v, lo, hi, def) => Math.min(hi, Math.max(lo, num(v, def)));
  const fade = src.fade && typeof src.fade === 'object' ? src.fade : {};
  const out = {
    on: src.on === true,
    kind: PATTERN_KINDS.includes(src.kind) || src.kind === 'picked' ? src.kind : d.kind,
    // Taken as written, as before this was checked: a colour is the
    // painters' to read, and both read every form the app writes.
    fg: typeof src.fg === 'string' && src.fg ? src.fg : d.fg,
    bg: typeof src.bg === 'string' && src.bg ? src.bg : d.bg,
    scale: clamp(src.scale, 0.25, 4, 1),
    angle: num(src.angle, d.angle) % 360,
    density: clamp(src.density, 0, 1, d.density),
    aspect: clamp(src.aspect, 0.25, 4, d.aspect),
    // An offset is a phase: a whole tile moves nothing, so 0..1 says it all.
    ox: clamp(src.ox, 0, 1, d.ox),
    oy: clamp(src.oy, 0, 1, d.oy),
    fgOpacity: clamp(src.fgOpacity, 0, 1, d.fgOpacity),
    bgOpacity: clamp(src.bgOpacity, 0, 1, d.bgOpacity),
    fade: {
      on: fade.on === true,
      angle: num(fade.angle, d.fade.angle) % 360,
      from: clamp(fade.from, 0, 1, d.fade.from),
      to: clamp(fade.to, 0, 1, d.fade.to),
    },
    anchor: PATTERN_ANCHORS.includes(src.anchor) ? src.anchor : d.anchor,
    seed: Math.min(9999, Math.max(1, Math.round(num(src.seed, d.seed)))),
    src: typeof src.src === 'string' && PATTERN_SRC.test(src.src) ? src.src : '',
    cell: normalizePatternCell(src.cell),
    mode: PATTERN_MODES.includes(src.mode) ? src.mode : d.mode,
  };
  // A picked pattern needs its tile; without one it is the default kind.
  if (out.kind === 'picked' && (!out.src || !out.cell.length)) out.kind = d.kind;
  return out;
}

export function normalizeStyle(s) {
  const d = defaultStyle();
  const src = s || {};
  const { outline, outlineWidth, shadow, ...srcFlat } = src;

  let strokes;
  if (Array.isArray(src.strokes)) strokes = src.strokes.map(normalizeStroke).filter((k) => k.width > 0);
  else if (outline !== undefined || outlineWidth !== undefined) {
    const w = num(outlineWidth, STROKE_DEF.width);
    strokes = w > 0 ? [normalizeStroke({ color: outline, width: w })] : [];
  } else strokes = d.strokes;

  let shadows;
  if (Array.isArray(src.shadows)) shadows = src.shadows.map(normalizeShadow);
  else if (shadow && typeof shadow === 'object') shadows = shadow.on ? [normalizeShadow(shadow)] : [];
  else shadows = d.shadows;

  const g = { ...d.gradient, ...(src.gradient || {}) };
  g.scope = g.scope === 'line' ? 'line' : 'box';
  g.kind = g.kind === 'radial' ? 'radial' : 'linear';
  g.angle = num(g.angle, d.gradient.angle);
  // A gradient saved before radial existed carries none of the three fields
  // below, so the defaults stand and it keeps painting exactly as it did.
  g.cx = Math.min(1, Math.max(0, num(g.cx, d.gradient.cx)));
  g.cy = Math.min(1, Math.max(0, num(g.cy, d.gradient.cy)));
  g.radius = Math.min(4, Math.max(0.1, num(g.radius, d.gradient.radius)));
  // Sorted here rather than trusted, because `pos` is what both renderers walk
  // in order, and clipped to the panel's ceiling so a hand-edited file cannot
  // hand the stop bar more handles than it can draw.
  g.stops = (Array.isArray(g.stops) && g.stops.length >= GRADIENT_MIN_STOPS ? g.stops : d.gradient.stops)
    .map(normalizeStop)
    .sort((a, b) => a.pos - b.pos)
    .slice(0, GRADIENT_MAX_STOPS);
  const pat = normalizePattern(src.pattern, d.pattern);

  // Flat keys are whitelisted to the schema rather than spread as they come, so
  // a style carrying keys this build has never heard of - a future schema read
  // by an older build, a hand-edited file - does not carry them forever: every
  // save would round-trip the junk through every clone and normalise. Unknown
  // in, gone out; the defaults above stand for anything missing.
  const known = new Set(Object.keys(d));
  const flat = {};
  for (const k of Object.keys(srcFlat)) if (known.has(k)) flat[k] = srcFlat[k];

  // The directional smear, gated field by field. Built explicitly rather than
  // spread so a style saved by the short-lived length/angle build arrives with
  // its `on` intact and the dead fields simply gone.
  const mb = {
    on: !!src.motionBlur?.on,
    x: Math.min(50, Math.max(-50, num(src.motionBlur?.x, d.motionBlur.x))),
    y: Math.min(50, Math.max(-50, num(src.motionBlur?.y, d.motionBlur.y))),
    amount: Math.min(32, Math.max(1, Math.round(num(src.motionBlur?.amount, d.motionBlur.amount)))),
  };

  // The bezier path. An anchor that is not finite is dropped rather than
  // repaired; a path left with fewer than two anchors cannot place a glyph,
  // and the renderers treat it as off.
  const pth = { on: !!src.path?.on, pts: [] };
  if (Array.isArray(src.path?.pts)) {
    for (const p of src.path.pts) {
      const x = num(p?.x, NaN);
      const y = num(p?.y, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      pth.pts.push({
        x,
        y,
        ix: num(p?.ix, 0),
        iy: num(p?.iy, 0),
        ox: num(p?.ox, 0),
        oy: num(p?.oy, 0),
      });
    }
  }

  // An early `fillOpacity` (the fill layer's own alpha) left the schema, and a
  // style saved while it existed folds it into the whole-box opacity - not the
  // same picture (strokes used to stay opaque), but the intent it carried,
  // that this box was translucent, survives the migration. Photoshop's Fill
  // Opacity brought the name back with that meaning; a style saved since then
  // also has `blendMode`, which is how the two are told apart.
  const legacyFill = !('blendMode' in src);
  const fo = legacyFill ? Math.min(1, Math.max(0, num(src.fillOpacity, 1))) : 1;

  // The circle, gated like the smear: angle normalized into [0, 360).
  const circ = { ...d.circle, ...(src.circle || {}) };
  circ.on = !!circ.on;
  circ.angle = ((num(circ.angle, 0) % 360) + 360) % 360;
  circ.inside = !!circ.inside;
  // 0 is auto, and anything unreadable becomes auto rather than a wild ring.
  circ.r = Math.min(4000, Math.max(0, num(circ.r, 0)));

  // The mask, shape by shape. A shape that is not one of the three kinds, or
  // whose numbers are not finite, is dropped rather than repaired - a mask
  // with no valid shapes is simply inactive, which every renderer handles.
  const pair = (q) => Array.isArray(q) && Number.isFinite(+q[0]) && Number.isFinite(+q[1]);
  const cl = {
    on: !!src.clip?.on,
    mode: src.clip?.mode === 'include' ? 'include' : 'exclude',
    brushSize: Math.min(200, Math.max(2, num(src.clip?.brushSize, d.clip.brushSize))),
    shapes: [],
  };
  for (const sh of Array.isArray(src.clip?.shapes) ? src.clip.shapes : []) {
    if (sh?.kind === 'ellipse') {
      const e = { kind: 'ellipse', cx: num(sh.cx, NaN), cy: num(sh.cy, NaN), rx: num(sh.rx, 0), ry: num(sh.ry, 0) };
      if (Number.isFinite(e.cx) && Number.isFinite(e.cy) && e.rx > 0 && e.ry > 0) cl.shapes.push(e);
    } else if (sh?.kind === 'poly') {
      const pts = (Array.isArray(sh.pts) ? sh.pts : []).filter(pair).map((q) => [+q[0], +q[1]]);
      if (pts.length >= 3) cl.shapes.push({ kind: 'poly', pts });
    } else if (sh?.kind === 'stroke') {
      const pts = (Array.isArray(sh.pts) ? sh.pts : []).filter(pair).map((q) => [+q[0], +q[1]]);
      const size = num(sh.size, 0);
      if (pts.length >= 1 && size > 0) cl.shapes.push({ kind: 'stroke', size: Math.min(200, size), pts });
    }
  }

  const ink = { on: !!src.ink?.on, strokes: [] };
  for (const k of Array.isArray(src.ink?.strokes) ? src.ink.strokes : []) {
    const norm = normalizeInkStroke(k);
    if (norm) ink.strokes.push(norm);
  }

  const out = {
    ...d,
    ...flat,
    // Anything else - a typo in a hand-edited file, a value from a newer build -
    // is the default, not a string every layout would have to second-guess.
    shape: BLOCK_SHAPES.includes(flat.shape) ? flat.shape : d.shape,
    margin: normalizeMargin(src.margin),
    autoContrast: flat.autoContrast === true,
    boldWeight: Math.min(BOLD_WEIGHT_MAX, Math.max(BOLD_WEIGHT_MIN, num(flat.boldWeight, d.boldWeight))),
    italicAngle: Math.min(ITALIC_ANGLE_MAX, Math.max(ITALIC_ANGLE_MIN, num(flat.italicAngle, d.italicAngle))),
    fitText: flat.fitText === true,
    fitMax: Math.min(200, Math.max(0, num(flat.fitMax, 0))),
    blur: Math.max(0, num(src.blur, 0)),
    fillOpacity: legacyFill ? 1 : Math.min(1, Math.max(0, num(flat.fillOpacity, 1))),
    blendMode: blendMode(flat.blendMode, 'normal'),
    blending: normalizeBlending(src.blending),
    motionBlur: mb,
    path: pth,
    clip: cl,
    ink,
    warp: normalizeWarp(src.warp),
    circle: circ,
    sfx: normalizeSfx(src.sfx),
    ...normalizeEffects(src),
    gradient: g,
    pattern: pat,
    noFill: src.noFill === true,
    strokes,
    shadows,
    outerGlow: normalizeGlow(src.outerGlow),
    innerGlow: normalizeGlow(src.innerGlow, true),
    innerShadows: Array.isArray(src.innerShadows) ? src.innerShadows.map(normalizeInnerShadow) : [],
    colorOverlays: Array.isArray(src.colorOverlays) ? src.colorOverlays.map(normalizeOverlay) : [],
    gradientOverlays: Array.isArray(src.gradientOverlays) ? src.gradientOverlays.map(normalizeGradientOverlay) : [],
    patternOverlay: normalizePatternOverlay(src.patternOverlay),
    satin: normalizeSatin(src.satin),
    bevel: normalizeBevel(src.bevel),
    strokeEffects: Array.isArray(src.strokeEffects) ? src.strokeEffects.map(normalizeStrokeEffect) : [],
    roughen: { ...d.roughen, ...(src.roughen || {}) },
  };
  if (fo < 1) out.opacity = Math.min(1, Math.max(0, num(out.opacity, 1) * fo));
  // A move-based SFX wrote the box's gaps over with its preset's: they go
  // back, and what it switched off stays in `before` for Remove SFX.
  const oldBefore = isOldSfx(src.sfx) && src.sfx.on === true ? src.sfx.before : null;
  if (oldBefore && typeof oldBefore === 'object') {
    out.letterSpacing = num(oldBefore.letterSpacing, out.letterSpacing);
    out.lineHeight = num(oldBefore.lineHeight, out.lineHeight);
    out.sfx.before = normalizeSfxBefore(oldBefore);
  }
  return out;
}

// Outline fit's air, in em, or null for the layout before it.
export const MARGIN_MAX = 2;
export function normalizeMargin(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(MARGIN_MAX, Math.max(0, n)) : null;
}

// The path a box starts with when the effect is switched on: a straight line
// across the box's middle, whose centre anchor carries symmetric horizontal
// handles so one drag bends it. In box-local page px, for a box `w` by `h`.
export function defaultPathPts(w, h) {
  const half = Math.max(10, Math.min(50, (Number(w) || 0) / 4));
  const midY = (Number(h) || 0) / 2;
  return [
    { x: 0, y: midY, ix: 0, iy: 0, ox: 0, oy: 0 },
    { x: (Number(w) || 0) / 2, y: midY, ix: -half, iy: 0, ox: half, oy: 0 },
    { x: Number(w) || 0, y: midY, ix: 0, iy: 0, ox: 0, oy: 0 },
  ];
}

// ---- the balloon a box was fitted to ----
//
// `box.fit` is the shape `balloon.js` recovered from the page's pixels, in page
// coordinates, and it is stored on the box because it has to survive a save: it
// is what the line breaker lays text out inside, and re-deriving it would mean
// re-decoding a page every time a box is drawn. Three kinds, all plain JSON:
//
//   { kind: 'ellipse', cx, cy, rx, ry }
//   { kind: 'rect',    x,  y,  w,  h  }
//   { kind: 'rows',    y0, step, spans: [[l, r] | null, ...] }
//
// The third is a body neither formula matches - a tilted or wobbly balloon -
// kept as bands of its interior (`rowsOf` in balloon.js, GEO-5). Band `i`
// covers page rows `[y0 + i·step, y0 + (i+1)·step)`; a null band has no room.
// It is bounded, like everything else read off disk: at least one band with
// room, `l < r` in each, and no more than `MAX_FIT_BANDS` of them.
//
// This is the gate every reader of that field goes through, and it exists
// because the field arrives from places this build does not control: a
// chapter.json a future version wrote with a fourth kind in it, a PSD's embedded
// project, a hand-edited file. A shape that is not one of the three, or whose
// numbers are not finite, or whose extent is not positive, is not an error to
// throw on - it is a box with no fit, which is a state the whole layout path
// already handles because it is what every box had before fitting existed.
//
// Returns a fresh plain object, so a caller cannot alias the document, and null
// for anything it does not recognise.
const MAX_FIT_BANDS = 1024;
export function normalizeFit(f) {
  if (!f || typeof f !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? Number(v) : NaN);
  if (f.kind === 'ellipse') {
    const cx = n(f.cx);
    const cy = n(f.cy);
    const rx = n(f.rx);
    const ry = n(f.ry);
    if (!Number.isFinite(cx + cy + rx + ry) || !(rx > 0) || !(ry > 0)) return null;
    return { kind: 'ellipse', cx, cy, rx, ry };
  }
  if (f.kind === 'rect') {
    const x = n(f.x);
    const y = n(f.y);
    const w = n(f.w);
    const h = n(f.h);
    if (!Number.isFinite(x + y + w + h) || !(w > 0) || !(h > 0)) return null;
    return { kind: 'rect', x, y, w, h };
  }
  if (f.kind === 'rows') {
    const y0 = n(f.y0);
    const step = n(f.step);
    const src = f.spans;
    if (!Number.isFinite(y0) || !(step > 0) || !Array.isArray(src)) return null;
    if (src.length === 0 || src.length > MAX_FIT_BANDS) return null;
    const spans = [];
    for (const sp of src) {
      if (sp === null) {
        spans.push(null);
        continue;
      }
      if (!Array.isArray(sp) || sp.length !== 2) return null;
      const l = n(sp[0]);
      const r = n(sp[1]);
      if (!Number.isFinite(l + r) || !(r > l)) return null;
      spans.push([l, r]);
    }
    if (!spans.some(Boolean)) return null;
    return { kind: 'rows', y0, step, spans };
  }
  if (f.kind === 'poly') {
    // The bubble outline itself (01-bubble-check.md): the points the finder
    // traced, or the user dragged, in page pixels. Layout never reads it
    // directly - `layoutShape` in balloon.js turns it into one of the three
    // above - so all this gate owes the rest of the app is a polygon that
    // encloses something.
    const src = f.pts;
    if (!Array.isArray(src) || src.length < 3 || src.length > MAX_POLY_POINTS) return null;
    const pts = [];
    for (const p of src) {
      if (!Array.isArray(p) || p.length !== 2) return null;
      const x = n(p[0]);
      const y = n(p[1]);
      if (!Number.isFinite(x + y)) return null;
      pts.push([x, y]);
    }
    let area = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      area += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    }
    if (!(Math.abs(area) / 2 >= 1)) return null;
    return { kind: 'poly', pts };
  }
  return null;
}
export const MAX_POLY_POINTS = 256;

// ---- the bubble outline's record ----
//
// `box.outline` says where a box's `poly` fit came from and whether anyone has
// looked at it (01-bubble-check.md). Absent on every box saved before outlines
// existed, and on a box typed onto the page that was never fitted: both read
// as "no outline record", which is what they are.
//
//   { source,       how it was found - see OUTLINE_SOURCES
//     confidence,   0..1, measured by the finder (edge contrast), not a constant
//     approved,     null | 'ai' | 'user'
//     note?,        why an approver left it unapproved
//     open? }       true: no closed outline was found; the box keeps its rectangle
//
// Any edit to the points, a refit, or a move of the box clears `approved`.
// 'bubble' is the second detector's bubble box read as an oval, for a bubble
// it found whose outline the finder could not close.
export const OUTLINE_SOURCES = Object.freeze(['ring', 'flood', 'dark', 'caption', 'fill', 'bubble', 'manual', 'box']);
const OUTLINE_APPROVERS = ['ai', 'user'];
export function normalizeOutline(o) {
  if (!o || typeof o !== 'object') return null;
  // A source some later build names is still an outline somebody made; the one
  // word that claims nothing about how is 'manual'.
  const source = OUTLINE_SOURCES.includes(o.source) ? o.source : 'manual';
  const c = Number(o.confidence);
  const out = {
    source,
    confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0,
    approved: OUTLINE_APPROVERS.includes(o.approved) ? o.approved : null,
  };
  if (typeof o.note === 'string' && o.note.trim()) out.note = o.note.trim().slice(0, 500);
  if (o.open === true) out.open = true;
  // The text colour the bubble's inside calls for, measured where the pixels
  // were (LET-3): kept so a box placed later, off the page on screen, gets it.
  if (o.ink === '#000000' || o.ink === '#ffffff') out.ink = o.ink;
  return out;
}

// ---- the containment flag ----
//
// `box.review` is the ONE place the app says "this box's text does not fit
// inside its rectangle", and it is absent whenever the text does. The check and
// the ladder that tries to make it fit live in contain.js; this is only the
// field's shape, stated beside `normalizeFit` for the same reason that one is
// here - it is stored on the box, it rides every save, and what comes back off
// disk was written by some build this one does not control.
//
//   { kind: 'overflow', overflow: { l, t, r, b }, reason }
//
// `overflow` is how far the ink reaches past each edge of the box, whole page px
// rounded up, 0 for an edge it stays inside. `reason` is one of the strings
// below - what failed, in words a person can act on, which is what the editor's
// badge and the queue's list show.
//
// A flag with no overflow on any edge is not a flag, and neither is a kind this
// build does not know: both load as "no review", which is what a box that fits
// has. The next containment check writes a fresh one if the box needs it.
export const REVIEW_REASONS = Object.freeze({
  // The ladder ran and nothing between the box's own size and the smallest the
  // text is allowed to shrink to fits inside the balloon.
  minSize: 'cannot fit above minimum size',
  // Ink past the edge the text is anchored to - left edge of left-aligned text,
  // top of top-aligned text - which no amount of growing the box can reach,
  // because the text moves with that edge.
  alignedEdge: 'ink past the aligned edge',
  // A single word wider than everything the balloon can offer it.
  wideWord: 'word wider than balloon',
  // Manual boxes: never resized or shrunk automatically, so the flag says why
  // the tool left it alone.
  manual: 'sized by hand',
  curve: 'text on a curve',
  warp: 'warped',
  // Hand-drawn ink and mask shapes sit at box-local px from the box's corner,
  // which growing the box would slide against its text (contain.js).
  ink: 'hand-drawn ink',
  mask: 'masked',
  // An auto box found overflowing by a pass that only grows heights - a chapter
  // opening, a font arriving - and so has not been refitted yet.
  stale: 'no longer fits',
  // Not an overflow, and never saved: a box whose lines break somewhere else
  // now that the Rust text engine measures it, listed with the flagged boxes
  // until the user has kept what that engine changed (`firstFit` in the store).
  relaid: 'line breaks changed with the new text engine',
});

export function normalizeReview(r) {
  if (!r || typeof r !== 'object' || r.kind !== 'overflow') return null;
  const o = r.overflow && typeof r.overflow === 'object' ? r.overflow : {};
  const px = (v) => (Number.isFinite(+v) && +v > 0 ? Math.ceil(+v) : 0);
  const overflow = { l: px(o.l), t: px(o.t), r: px(o.r), b: px(o.b) };
  if (!(overflow.l || overflow.t || overflow.r || overflow.b)) return null;
  const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason : REVIEW_REASONS.stale;
  return { kind: 'overflow', overflow, reason };
}

// ---- the solver's record ----
//
// `box.auto` marks a box the auto-layout solver (auto-layout.js) manages, and
// holds what it needs to solve it again:
//
//   { on, refSize, minSize?, locks: { size, width, height, pos, breaks }, status, reason, stamp, breaks? }
//
// `breaks` is an outline fit's chosen lines (`normalizeBreaks` below); with
// `locks.breaks` they are the agent's or the user's, and kept through a solve.
//
// `refSize` is the size the user chose - the solver never goes above it, and
// shrinks from it only as far as the balloon needs, so it is kept apart from
// `style.size`, which is the size the solver last settled on. `status` is the
// last solve's answer (`solveLayout`'s), or null for a box not solved yet, and
// `reason` the REVIEW_REASONS string it gave for an overflow. `stamp` is a
// fingerprint of the box that solve laid out (`solveStamp` in the store): the
// status is the box's own only while the box still matches it. One status is
// not an answer: 'pending' is a box placed with text while the face it is set
// in was still loading, so nothing could be solved yet - its stamp is the box
// as placed, and the store solves it when the face arrives, unless an edit has
// made it the user's first (DET-4).
//
// A box without the field is a box the solver has never touched - every box
// saved before it existed - and stays manual: nothing solves it on load.
// Anything unreadable degrades to that same state rather than to a guess.
export const AUTO_STATUSES = Object.freeze(['ok', 'shrunk', 'overflow', 'no-region', 'pending']);
const AUTO_LOCKS = ['size', 'width', 'height', 'pos', 'breaks'];

export function normalizeAuto(a) {
  if (!a || typeof a !== 'object') return null;
  const refSize = Number(a.refSize);
  if (!(Number.isFinite(refSize) && refSize > 0)) return null;
  const minSize = Number(a.minSize);
  const locks = {};
  for (const k of AUTO_LOCKS) locks[k] = a.locks?.[k] === true;
  return {
    on: a.on !== false,
    refSize,
    ...(Number.isFinite(minSize) && minSize > 0 ? { minSize } : null),
    locks,
    status: AUTO_STATUSES.includes(a.status) ? a.status : null,
    reason: typeof a.reason === 'string' && a.reason.trim() ? a.reason : null,
    stamp: typeof a.stamp === 'string' && a.stamp ? a.stamp : null,
    ...(normalizeBreaks(a.breaks) ? { breaks: normalizeBreaks(a.breaks) } : null),
  };
}

// The line starts an outline fit chose (`auto.breaks`): offsets into the cased
// text, rising from 0, the key of the text and face they were chosen for
// (`breaksKey` in measure.js), and the key of the words alone (`textKey`,
// `breaksTextKey`), which lets held lines follow a change of face or size.
// `scaled` marks the lines a corner scale kept (`resizeBox`): drawn on any
// box, outline fit or not, until a side, an edit or a solve breaks them again.
// Anything else is no breaks, and the lines are broken as before.
export function normalizeBreaks(b) {
  if (!b || typeof b !== 'object' || typeof b.key !== 'string' || !b.key || !Array.isArray(b.at)) return null;
  const at = b.at.map(Number);
  if (!at.length || at[0] !== 0 || at.some((v, i) => !Number.isInteger(v) || v < 0 || (i && v <= at[i - 1]))) return null;
  return {
    key: b.key,
    at,
    ...(typeof b.textKey === 'string' && b.textKey ? { textKey: b.textKey } : null),
    ...(b.scaled === true ? { scaled: true } : null),
  };
}
