import {
  GRADIENT_KINDS, GRADIENT_MIN_STOPS, GRADIENT_MAX_STOPS, PATTERN_KINDS, PATTERN_ANCHORS, PATTERN_MODES,
  WARP_MIN_GRID, WARP_MAX_GRID, SFX_MAX_GROUPS, SFX_DIRS, SFX_CAPTION_SIDES, STROKE_ORDERS, STROKE_JOINS,
  LAYER_BLEND_MODES, CONTOUR_PRESETS, SHADOW_SIZE_MAX, SATIN_DISTANCE_MAX, FX_GRADIENT_STYLES, FX_GRADIENT_TYPES, FX_GRADIENT_METHODS, GRADIENT_MID_MIN, GRADIENT_MID_MAX, NOISE_MODELS,
  STROKE_POSITIONS, STROKE_FILLS, BEVEL_STYLES, BEVEL_TECHNIQUES, BEVEL_DIRECTIONS, BEVEL_DEPTH_MAX,
  BEVEL_SOFTEN_MAX, BEVEL_TEXTURE_SCALE_MIN, BEVEL_TEXTURE_SCALE_MAX, KNOCKOUT_MODES, FX_INSTANCES_MAX,
  PATTERN_SCALE_MIN, PATTERN_SCALE_MAX,
} from '../data.js';

const number = (desc, min, max) => ({ type: 'number', desc, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) });
const integer = (desc, min, max) => ({ ...number(desc, min, max), type: 'integer' });
const boolean = (desc) => ({ type: 'boolean', desc });
const string = (desc) => ({ type: 'string', desc });
const color = (desc) => ({ type: 'color', desc });
const choice = (desc, values) => ({ type: 'enum', desc, values });
// A choice whose values are a list several fields share, printed once by
// `styleSchemaText` under its name.
const listed = (name, desc, values) => ({ ...choice(desc, values), list: name });
// `required` names the fields an item must carry when it arrives in a whole
// list (a new item has nothing to fall back on); an index patch over an item
// that exists may still give any part of it.
const object = (desc, fields, required) => ({ type: 'object', desc, fields, ...(required ? { required } : {}) });
const array = (desc, items, limits = {}) => ({ type: 'array', desc, items, ...limits });
// A Photoshop effect that comes more than once: at most FX_INSTANCES_MAX,
// each with its own switch in the list.
const instanceOn = () => ({ ...boolean('false=off, kept'), optional: true });
const instances = (desc, item) => array(desc, item, { maxItems: FX_INSTANCES_MAX });
// A list item that is one of several shapes, told apart by one field (`key`),
// which every item names, also when an index patch changes one: the validator
// cannot see which kind the stored item is. Each variant is an `object`; the
// key is added to its fields as a one-value enum.
const union = (desc, key, variants) => ({
  type: 'union',
  desc,
  key,
  variants: Object.fromEntries(Object.entries(variants).map(([name, v]) => [
    name,
    { ...v, fields: { [key]: choice(`${key} ${name}`, [name]), ...v.fields } },
  ])),
});
// An object several fields take whole: `styleSchemaText` prints its fields
// the first time and points back to that path after.
const shared = (name, entry) => ({ ...entry, shape: name });
// `same` is what a stored read-only field may be sent back as (an empty pick).
const readOnly = (desc, same) => ({ type: 'any', readOnly: true, desc, ...(same === undefined ? {} : { same }) });
const alpha = (desc) => number(desc, 0, 1);
// A shadow's own angle off the light, kept where x/y cannot hold it (data.js
// `storedShadowAngle`): at distance 0. x/y win when they disagree.
const shadowAngleField = () => ({ ...number('own angle at distance 0', -180, 180), optional: true });
const point = (desc) => array(desc, number('px'), { minItems: 2, maxItems: 2 });

// Geometry the agent writes, all in box-local page px: the origin is the box's
// top-left corner, x runs right and y down, the same space normalizeStyle and
// the renderers read `path.pts` and `clip.shapes` in. Coordinates are not
// clamped (a path or a mask may reach past the box) and have no bounds here.
// The caps on list lengths are only there to stop a runaway list.
const contourField = () => shared('contour', object('edge falloff (Rust)', {
  preset: listed('CONTOUR', 'contour', [...CONTOUR_PRESETS, 'custom']),
  aa: boolean('anti-aliased contour'),
  pts: { ...array('custom: points [x, y, corner?], 0..255', { type: 'contourPoint', desc: '[x, y, corner?]' }, { minItems: 2, maxItems: 64 }), optional: true },
}));
// A gradient stop's midpoint: of the segment from the stop before it.
const gradientMid = () => ({ ...number('half-way of the span it ends', GRADIENT_MID_MIN, GRADIENT_MID_MAX), optional: true });
// An effect gradient (Photoshop's, as Gradient Overlay and Stroke take it).
const fxGradient = (desc) => shared('gradient', object(desc, {
  style: choice('shapeburst: edge in', FX_GRADIENT_STYLES),
  angle: number('PS degrees, 90=up', -180, 180),
  scale: number('1=100%', 0.1, 1.5),
  reverse: boolean('flip the ramp'),
  offset: array('centre shift, frame share', number('share', -1, 1), { minItems: 2, maxItems: 2 }),
  stops: array('colour stops', object('stop', {
    color: color('stop colour'),
    pos: alpha('position'),
    mid: gradientMid(),
  }), { minItems: GRADIENT_MIN_STOPS, maxItems: GRADIENT_MAX_STOPS }),
  opacityStops: array('alpha stops', object('stop', {
    opacity: alpha('alpha'),
    pos: alpha('position'),
    mid: gradientMid(),
  }), { minItems: GRADIENT_MIN_STOPS, maxItems: GRADIENT_MAX_STOPS }),
  smoothness: alpha('1 eases'),
  method: choice('blend space', FX_GRADIENT_METHODS),
  dither: boolean('no banding'),
  type: choice('solid=stops, noise=random ramp (Rust)', FX_GRADIENT_TYPES),
  noise: object('noise gradient', {
    seed: integer('random seed', 0, 4294967295),
    roughness: alpha('steps, 0 smooth'),
    model: choice('channels walk in', NOISE_MODELS),
    min: array('per-channel low limit', alpha('share'), { minItems: 3, maxItems: 3 }),
    max: array('per-channel high limit', alpha('share'), { minItems: 3, maxItems: 3 }),
    restrict: boolean('no oversaturated colours'),
    transparency: boolean('random alpha too'),
  }),
}));
// One Blend If channel: its This Layer and Underlying Layer sliders, printed
// whole once (`shared`).
const blendIfPair = () => shared('blendRange', object('sliders', {
  this: array('This Layer, by box colour: [black lo, black hi, white lo, white hi], each >= the one before', integer('level', 0, 255), { minItems: 4, maxItems: 4 }),
  under: array('Underlying, by page art', integer('level', 0, 255), { minItems: 4, maxItems: 4 }),
}));
// An Outer or Inner Glow's fields; `spread` is Choke on an inner one.
// A bevel's Highlight or Shadow: its mode, colour and opacity.
const bevelShade = () => ({
  blend: listed('BLEND', 'blend mode', LAYER_BLEND_MODES),
  color: color('colour'),
  opacity: alpha('alpha'),
});
const glowFields = (spreadKey, spreadDesc) => ({
  on: boolean('enable glow'),
  blend: listed('BLEND', 'blend mode', LAYER_BLEND_MODES),
  opacity: alpha('glow alpha'),
  noise: alpha('grain'),
  color: color('glow colour'),
  fill: choice('colour or gradient', ['color', 'gradient']),
  gradient: fxGradient('along the glow, first stop at the edge; ignores style/angle/scale/reverse/offset'),
  technique: choice('soft blur or exact distance', ['softer', 'precise']),
  [spreadKey]: alpha(spreadDesc),
  size: number('reach px (Photoshop Size)', 0, SHADOW_SIZE_MAX),
  contour: contourField(),
  range: number('share of the falloff the contour spans', 0.01, 1),
  jitter: alpha('gradient scatter'),
});
// A fill pattern's fields: the fill's own and an effect's.
const patternFields = () => ({
  on: boolean('enable pattern'),
  kind: choice('tile kind', PATTERN_KINDS),
  fg: color('tile ink'),
  bg: color('tile background'),
  scale: number('tile/font scale', PATTERN_SCALE_MIN, PATTERN_SCALE_MAX),
  angle: number('turn degrees'),
  density: alpha('ink; 0.5=designed'),
  aspect: number('x stretch', 0.25, 4),
  ox: alpha('x offset, tiles'),
  oy: alpha('y offset, tiles'),
  fgOpacity: alpha('ink alpha'),
  bgOpacity: alpha('ground alpha'),
  fade: object('ink fades across box', {
    on: boolean('enable fade'),
    angle: number('CSS degrees'),
    from: alpha('full until'),
    to: alpha('none from'),
  }),
  anchor: choice('tile origin', PATTERN_ANCHORS),
  seed: integer('random kinds seed', 1, 9999),
  src: readOnly('set through Pick from page', ''),
  cell: readOnly('set through Pick from page', []),
  mode: choice('picked: recolour or keep', PATTERN_MODES),
});
// An effect's pattern is always on: `on` is read only, true as stored.
const effectPatternFields = () => ({ ...patternFields(), on: readOnly('set through the effect; always on here', true) });
const PATH_MAX_ANCHORS = 64;
const MASK_MAX_SHAPES = 64;
const MASK_MAX_POINTS = 256;

// Bounds and choices mirror normalizeStyle and its helpers, not Inspector
// sliders. Flat fields (lineHeight, curve, roughen, etc.) are passed through
// there without clamps and have none here; size, opacity, align and valign
// are the exceptions, marked where they are.
// Circle angles wrap rather than clamp, so have no min/max. The path's anchors
// and the mask's shapes are plain enough to write by hand; the warp mesh, the
// ink strokes and the SFX restoration snapshot belong to the editors that
// create them (a warp comes from edit's "warp:<kind>" action instead).
export const STYLE_SCHEMA = {
  font: string('font family'),
  // Not clamped by normalizeStyle; the range is what a box can sensibly be
  // asked for, so a model's slip ("size: 2600") is refused, not drawn.
  size: number('font size px', 4, 400),
  bold: boolean('bold face'),
  italic: boolean('italic face'),
  boldWeight: number('bold weight %, 100 as drawn (with bold)', 100, 400),
  italicAngle: number('italic lean degrees, 14 as drawn (with italic)', -20, 45),
  // Plain strings to normalizeStyle; these are the values the layout reads.
  align: choice('horizontal alignment', ['left', 'center', 'right']),
  valign: choice('vertical alignment', ['top', 'middle', 'bottom']),
  opacity: alpha('whole-box alpha'),
  color: color('solid glyph fill'),
  autoContrast: boolean('bubble-picked fill/stroke'),
  gradient: object('gradient fill', {
    on: boolean('enable gradient'),
    kind: choice('ramp kind', GRADIENT_KINDS),
    angle: number('CSS gradient degrees'),
    cx: alpha('radial centre x'),
    cy: alpha('radial centre y'),
    radius: number('radial scale', 0.1, 4),
    scope: choice('ramp span', ['box', 'line']),
    stops: array('sorted colour stops', object('stop', {
      color: color('stop colour'),
      pos: alpha('ramp position'),
      opacity: alpha('stop alpha'),
    }), { minItems: GRADIENT_MIN_STOPS, maxItems: GRADIENT_MAX_STOPS }),
  }),
  pattern: shared('pattern', object('tiled fill beats gradient', patternFields())),
  noFill: boolean('hollow glyphs; overrides fills'),
  strokes: array('bands, inner first', object('stroke', {
    color: color('band colour'),
    width: number('band px; 0=remove', 0),
    opacity: alpha('band alpha'),
  })),
  shadows: instances('drop shadows, top first (Photoshop Drop Shadow)', object('shadow', {
    on: instanceOn(),
    x: number('x offset px'),
    y: number('y offset px'),
    size: number('soft edge reach px (Photoshop Size)', 0, SHADOW_SIZE_MAX),
    color: color('shadow colour'),
    opacity: alpha('shadow alpha'),
    spread: alpha('share of size that is a hard edge (Rust)'),
    noise: alpha('grain (Rust)'),
    blend: listed('BLEND', 'blend mode', LAYER_BLEND_MODES),
    contour: contourField(),
    knockout: boolean('letters knock the shadow out (Rust)'),
    useGlobalLight: boolean('angle follows the chapter light; x/y give the distance'),
    angle: shadowAngleField(),
  })),
  gradientOverlays: instances('gradients over the fill, top first (Photoshop Gradient Overlay; Rust)', object('gradient overlay', {
    on: instanceOn(),
    blend: listed('BLEND', 'blend mode', LAYER_BLEND_MODES),
    opacity: alpha('overlay alpha'),
    gradient: fxGradient('over the letters'),
  })),
  outerGlow: object('glow round the letters (Photoshop Outer Glow; Rust)', glowFields('spread', 'share of size that is solid')),
  innerGlow: object('glow inside the letters (Photoshop Inner Glow; Rust)', {
    ...glowFields('spread', 'choke: share of size that is solid'),
    source: choice('glow from the edge or the centre', ['edge', 'center']),
  }),
  innerShadows: instances('shadows inside the letters, top first (Photoshop Inner Shadow; Rust)', object('inner shadow', {
    on: instanceOn(),
    x: number('x offset px'),
    y: number('y offset px'),
    size: number('soft edge reach px', 0, SHADOW_SIZE_MAX),
    color: color('shadow colour'),
    opacity: alpha('shadow alpha'),
    choke: alpha('share of size that is a hard edge'),
    noise: alpha('grain'),
    blend: listed('BLEND', 'blend mode', LAYER_BLEND_MODES),
    contour: contourField(),
    useGlobalLight: boolean('angle follows the chapter light; x/y give the distance'),
    angle: shadowAngleField(),
  })),
  colorOverlays: instances('flat colours over the fill, top first (Photoshop Color Overlay; Rust)', object('colour overlay', {
    on: instanceOn(),
    color: color('overlay colour'),
    opacity: alpha('overlay alpha'),
    blend: listed('BLEND', 'blend mode', LAYER_BLEND_MODES),
  })),
  patternOverlay: object('pattern over the fill (Photoshop Pattern Overlay; Rust)', {
    on: boolean('enable overlay'),
    blend: listed('BLEND', 'blend mode', LAYER_BLEND_MODES),
    opacity: alpha('overlay alpha'),
    pattern: shared('pattern', object('as the fill pattern', effectPatternFields())),
  }),
  satin: object('silky inner sheen (Photoshop Satin; Rust)', {
    on: boolean('enable satin'),
    blend: listed('BLEND', 'blend mode', LAYER_BLEND_MODES),
    color: color('satin colour'),
    opacity: alpha('satin alpha'),
    angle: number('deg, own (no global light)', -180, 180),
    distance: number('px each copy is thrown', 0, SATIN_DISTANCE_MAX),
    size: number('soft edge px', 0, SHADOW_SIZE_MAX),
    contour: contourField(),
    invert: boolean('lay the inverse'),
  }),
  bevel: object('Photoshop Bevel & Emboss (Rust)', {
    on: boolean('enable bevel'),
    style: choice('stroke=bevel of the Stroke effects', BEVEL_STYLES),
    technique: choice('edge shape', BEVEL_TECHNIQUES),
    depth: number('1=100%', 0, BEVEL_DEPTH_MAX),
    direction: choice('light side', BEVEL_DIRECTIONS),
    size: number('px', 0, SHADOW_SIZE_MAX),
    soften: number('px', 0, BEVEL_SOFTEN_MAX),
    useGlobalLight: boolean('angle+altitude are the chapter light'),
    angle: number('deg', -180, 180),
    altitude: number('deg', 0, 90),
    gloss: contourField(),
    highlight: shared('bevelShade', object('lit half', bevelShade())),
    shadow: shared('bevelShade', object('dark half', bevelShade())),
    contour: object('height contour', {
      on: boolean('enable'),
      curve: contourField(),
      range: alpha('carried, not painted'),
    }),
    texture: object('pattern in the height', {
      on: boolean('enable'),
      pattern: shared('pattern', object('as the fill pattern', patternFields())),
      scale: number('1=100%', BEVEL_TEXTURE_SCALE_MIN, BEVEL_TEXTURE_SCALE_MAX),
      depth: number('1=100%, <0 carves', -BEVEL_DEPTH_MAX, BEVEL_DEPTH_MAX),
      invert: boolean('invert'),
      link: boolean('moves with the box'),
    }),
  }),
  strokeEffects: instances('Photoshop Stroke effects, top first, apart from strokes (Rust)', object('stroke effect', {
    on: instanceOn(),
    size: number('px', 0, SHADOW_SIZE_MAX),
    position: choice('on the letters edge', STROKE_POSITIONS),
    blend: listed('BLEND', 'blend mode', LAYER_BLEND_MODES),
    opacity: alpha('stroke alpha'),
    overprint: { ...boolean('PSD only, not painted'), optional: true },
    fill: choice('paint', STROKE_FILLS),
    color: color('fill color'),
    gradient: fxGradient('fill gradient, over the stroke'),
    pattern: shared('pattern', object('fill pattern', effectPatternFields())),
  })),
  fillOpacity: alpha('fill alpha only; strokes and shadows stay (Rust)'),
  blendMode: listed('BLEND', 'how the box mixes with the page art (Photoshop layer blend, Rust)', LAYER_BLEND_MODES),
  blending: object('Photoshop advanced blending', {
    interior: boolean('Fill also fades overlays, satin, inner glow (Rust)'),
    knockout: choice('stored and in the PSD, not painted', KNOCKOUT_MODES),
    blendClipped: { ...boolean('default true; stored+PSD'), optional: true },
    transparencyShapes: { ...boolean('default true; false: special-eight fill blends its alpha (Rust)'), optional: true },
    vectorMaskHidesEffects: { ...boolean('default false; stored'), optional: true },
    channels: object('false keeps the page art channel (Rust)', { r: boolean('R'), g: boolean('G'), b: boolean('B') }),
    blendIf: object('Blend If (Rust)', Object.fromEntries(['gray', 'red', 'green', 'blue'].map((c) => [c, blendIfPair()]))),
  }),
  blur: number('whole-text blur px', 0),
  motionBlur: object('directional smear', {
    on: boolean('enable smear'),
    x: number('x px/step', -50, 50),
    y: number('y px/step', -50, 50),
    amount: integer('smear iterations', 1, 32),
  }),
  // A cubic bezier through the anchors, first to last; the text runs along it
  // left to right. Segment A->B is A, A+out, B+in, B. The example is the
  // rainbow arch in a box w by h (swap y 0 and h for a smile).
  path: object('bezier text path, needs 2+ pts', {
    on: boolean('enable path'),
    pts: array('anchors in box px from its top-left; ix,iy/ox,oy = in/out handle offsets. Arch: [{x:0,y:h},{x:w/2,y:0,ix:-w/4,ox:w/4},{x:w,y:h}]', object('anchor', {
      x: number('anchor x'),
      y: number('anchor y'),
      ix: number('in handle dx'),
      iy: number('in handle dy'),
      ox: number('out handle dx'),
      oy: number('out handle dy'),
    }, ['x', 'y']), { minItems: 2, maxItems: PATH_MAX_ANCHORS }),
  }),
  clip: object('painted visibility mask', {
    on: boolean('enable mask'),
    mode: choice('hide/keep painted areas', ['exclude', 'include']),
    brushSize: number('mask brush page px', 2, 200),
    shapes: array('painted areas, box px', union('area', 'kind', {
      ellipse: object('ellipse', {
        cx: number('centre x'),
        cy: number('centre y'),
        rx: number('x radius', 1),
        ry: number('y radius', 1),
      }, ['cx', 'cy', 'rx', 'ry']),
      poly: object('closed polygon', {
        pts: array('corners', point('[x, y]'), { minItems: 3, maxItems: MASK_MAX_POINTS }),
      }, ['pts']),
      stroke: object('brush line', {
        size: number('brush px', 1, 200),
        pts: array('line points', point('[x, y]'), { minItems: 1, maxItems: MASK_MAX_POINTS }),
      }, ['size', 'pts']),
    }), { maxItems: MASK_MAX_SHAPES }),
  }),
  ink: object('hand-drawn box-local ink', {
    on: boolean('enable ink'),
    strokes: readOnly('set through the ink brush tool'),
  }),
  warp: object('whole-box mesh transform', {
    on: boolean('enable mesh'),
    cols: integer('mesh columns', WARP_MIN_GRID, WARP_MAX_GRID),
    rows: integer('mesh rows', WARP_MIN_GRID, WARP_MAX_GRID),
    pts: readOnly('set through transform/liquify tools'),
  }),
  circle: object('circular text', {
    on: boolean('enable circle'),
    angle: number('clockwise degrees; wraps at 360'),
    inside: boolean('text on inner face'),
    r: number('radius px; 0=auto', 0, 4000),
  }),
  sfx: object('sound-effect lettering (Rust); null layout fields follow the type', {
    on: boolean('on via sfx_kind/sfx_pick, off via clear_sfx'),
    kind: { ...string('sound type id from sfx_kinds; applied by sfx_kind:<id>'), minLength: 1 },
    seed: integer('arrangement seed', 1, 9999),
    power: number('size flow; 50=type', 0, 100),
    rough: number('jitter; 50=type', 0, 100),
    momentum: number('lean; 50=type', 0, 100),
    dir: { ...choice('h=across, v=down; null=type', SFX_DIRS), nullable: true },
    joinBars: boolean('join runs of long bars into one'),
    kern: boolean('kern letters by their ink'),
    flow: { ...object('letter size along the path: first, last, curve', {
      from: number('first letter scale', 0.1, 4),
      to: number('last letter scale', 0.1, 4),
      pow: number('curve power', 0.2, 5),
    }), nullable: true },
    follow: { ...number('how much letters turn with the path', 0, 1), nullable: true },
    gap: { ...number('gap between letters in em', -1, 2), nullable: true },
    bigTighter: { ...number('how much closer big letters sit', 0, 1), nullable: true },
    slant: { ...number('lean degrees', -45, 45), nullable: true },
    rise: { ...number('each letter climbs this many degrees', -30, 30), nullable: true },
    jitter: { ...object('random turn/size/offset', {
      rot: number('turn degrees', 0, 45),
      size: number('size share', 0, 1),
      off: number('offset in em', 0, 1),
    }), nullable: true },
    paths: array('one path per text group, em from box centre', object('path', {
      a: point('start [x,y] em'),
      b: point('end [x,y] em'),
      bend: number('bend, + bows left of a->b', -2, 2),
    }, ['a', 'b']), { maxItems: SFX_MAX_GROUPS }),
    glyphs: readOnly('set through the SFX gizmo'),
    caption: object('small translation beside the SFX', {
      text: string('caption text; empty=none'),
      side: choice('side of the SFX', SFX_CAPTION_SIDES),
      size: number('size share of the SFX size', 0.1, 1),
      color: color('caption colour'),
    }),
    before: readOnly('set through sfx_kind and clear_sfx'),
  }),
  strokeOrder: choice('SFX only: merged=one rim under all fills; each=letter by letter', STROKE_ORDERS),
  strokeJoin: choice('SFX only: rim corners', STROKE_JOINS),
  strokeShade: number('SFX only: drop shade of the outer rim', 0, 1),
  negative: object('SFX only: letters cut out of a blob', {
    on: boolean('enable negative'),
    grow: number('blob reach in em', 0, 1),
    color: color('blob colour'),
  }),
  extrude: object('SFX only: 3D depth behind the letters', {
    on: boolean('enable extrude'),
    angle: number('direction degrees, 0=right, 90=down'),
    length: number('depth in em', 0, 2),
    color: color('depth colour'),
    edge: string('edge colour hex; empty=none'),
  }),
  shake: object('SFX only: vibration copies', {
    on: boolean('enable shake'),
    count: integer('copies each side', 1, 4),
    amp: number('reach in em', 0, 1),
    angle: number('shake direction degrees'),
  }),
  trail: object('SFX only: afterimages behind each letter', {
    on: boolean('enable trail'),
    count: integer('afterimages', 1, 6),
    dist: number('step in em', 0, 2),
  }),
  uppercase: boolean('display uppercase'),
  lineHeight: number('line multiplier'),
  letterSpacing: number('letter gap px'),
  rotation: number('box rotation degrees'),
  flipH: boolean('horizontal mirror'),
  flipV: boolean('vertical mirror'),
  roughen: object('distressed edges', {
    on: boolean('enable rough edges'),
    amount: number('crumple in page px'),
    detail: number('grain frequency'),
    seed: number('distortion seed'),
    grit: number('fine tear in page px'),
  }),
  curve: number('arc: negative=frown, positive=smile'),
  shape: choice('line-breaking shape', ['auto', 'oval', 'rect', 'off']),
  minOrphan: number('minimum solo-word letters'),
  hyphenate: boolean('split words that fit no line'),
  margin: { ...number('outline fit: air from ink to the bubble outline in em (0.5 is a letter); null is the older layout', 0, 2), nullable: true },
  balloon: boolean('lay out to box.fit balloon'),
  autoHeight: boolean('text height at valign'),
  fitText: boolean('size fills w x h'),
  fitMax: number('fitText ceiling, 0 = size', 0, 200),
};

const RELATIVE = /^[+\-*]\d+(\.\d+)?$/;
// The same four CSS hex lengths accepted by data.js's hex().
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const INDEX = /^(0|[1-9]\d*)$/;
const isObject = (v) => v !== null && typeof v === 'object' &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const at = (path, key) => path ? `${path}.${key}` : key;

function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) {
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
    }
    row = next;
  }
  return row[b.length];
}

/** Validate a partial style without coercing, applying, or mutating it.
 * Objects are partial, including array items (normalizers fill omitted fields),
 * except that an item in a list given whole must carry its object's `required`
 * fields: a path anchor with no x, or a mask shape with no points, would be
 * dropped by normalizeStyle without a word. Arrays replace the list; index
 * objects patch items. Relative operands are checked here; the applying tool
 * checks results against the current style.
 *
 * `stored` (optional): the style, or a list of styles, the patch lands on
 * (every target box's). A field then also passes when it is sent back as it
 * is stored on every one of them (F53): a picked pattern's `kind`, `src` and
 * `cell` echoed from the box tool are no edit, though the agent cannot set
 * them itself. In a list given whole an
 * item may sit at another index than it is stored at (one was added or
 * removed before it), so there it matches the same field of any stored item
 * of that list; an index patch matches the item at its own index.
 */
export function validateStylePatch(patch, stored = null) {
  const errors = [];
  const fail = (path, error, hint) => errors.push({ path: path || '$', error, ...(hint ? { hint } : {}) });
  // Per target style, the stored values the value at hand may echo (null:
  // nothing stored was given).
  const root = stored == null ? null : (Array.isArray(stored) ? stored : [stored]).map((st) => [st]);
  const down = (ctx, key) => ctx && ctx.map((vs) => vs.map((v) => (isObject(v) || Array.isArray(v) ? v[key] : undefined)).filter((v) => v !== undefined));
  const itemsOf = (ctx) => ctx && ctx.map((vs) => vs.flatMap((v) => (Array.isArray(v) ? v : [])));
  const echoes = (ctx, value) => {
    if (!ctx?.length) return false;
    const j = JSON.stringify(value);
    return ctx.every((vs) => vs.some((v) => JSON.stringify(v) === j));
  };

  // `required` is the object's list when the value is an item of a list
  // given whole, else null.
  function fields(value, schema, path, required = null, ctx = null) {
    if (!isObject(value)) return fail(path, 'expected an object');
    for (const key of required ?? []) if (!Object.hasOwn(value, key)) fail(at(path, key), 'required in a new item');
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema, key)) {
        const nearest = Object.keys(schema)
          .map((k) => [k, editDistance(key, k)])
          .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
          .slice(0, 3).map(([k]) => k);
        fail(at(path, key), 'unknown key', `nearest keys: ${nearest.join(', ')}`);
      } else {
        check(value[key], schema[key], at(path, key), false, down(ctx, key));
      }
    }
  }

  // `whole`: the value is an item of a list given whole (see `required`).
  // `ctx`: the stored values this one may echo (see `stored`). A value every
  // target already holds is no edit, whatever the agent could not set itself
  // (a read-only tile, the `picked` kind that goes with it): its errors go.
  function check(value, entry, path, whole = false, ctx = null) {
    const n = errors.length;
    checkEntry(value, entry, path, whole, ctx);
    if (errors.length > n && echoes(ctx, value)) errors.length = n;
  }
  function checkEntry(value, entry, path, whole, ctx) {
    if (entry.readOnly) {
      // The unset value sent back whole (a stored list echoed) is no edit.
      if (Object.hasOwn(entry, 'same') && JSON.stringify(value) === JSON.stringify(entry.same)) return;
      return fail(path, entry.desc);
    }
    if (value === null && entry.nullable) return;
    switch (entry.type) {
      case 'number':
      case 'integer': {
        if (typeof value === 'string' && RELATIVE.test(value) && Number.isFinite(Number(value.slice(1)))) return;
        if (typeof value !== 'number' || !Number.isFinite(value)) return fail(path, 'expected a finite number or relative string (+2, -2, *1.1)');
        if (entry.type === 'integer' && !Number.isInteger(value)) return fail(path, 'expected an integer');
        if ((entry.min !== undefined && value < entry.min) || (entry.max !== undefined && value > entry.max)) {
          fail(path, `expected range ${entry.min ?? '-Infinity'}..${entry.max ?? 'Infinity'}`);
        }
        return;
      }
      case 'boolean':
        if (typeof value !== 'boolean') fail(path, 'expected a boolean');
        return;
      case 'string':
        if (typeof value !== 'string') fail(path, 'expected a string');
        else if (entry.minLength !== undefined && value.length < entry.minLength) fail(path, `expected at least ${entry.minLength} characters`);
        return;
      case 'contourPoint':
        if (!Array.isArray(value) || value.length < 2 || value.length > 3 || !value.slice(0, 2).every((n) => typeof n === 'number' && n >= 0 && n <= 255) || (value.length === 3 && typeof value[2] !== 'boolean')) {
          fail(path, 'expected [x, y] or [x, y, corner] with x and y 0..255');
        }
        return;
      case 'enum':
        if (!entry.values.includes(value)) fail(path, `expected one of: ${entry.values.join(', ')}`);
        return;
      case 'color':
        if (typeof value !== 'string' || !HEX.test(value)) fail(path, 'expected hex colour: #rgb, #rgba, #rrggbb or #rrggbbaa');
        return;
      case 'object':
        return fields(value, entry.fields, path, whole ? entry.required : null, ctx);
      case 'union': {
        if (!isObject(value)) return fail(path, 'expected an object');
        const kinds = Object.keys(entry.variants);
        const kind = value[entry.key];
        if (!Object.hasOwn(value, entry.key)) return fail(at(path, entry.key), `expected one of: ${kinds.join(', ')}`, `every item names its ${entry.key}, also in an index patch`);
        if (!kinds.includes(kind)) return fail(at(path, entry.key), `expected one of: ${kinds.join(', ')}`);
        return check(value, entry.variants[kind], path, whole, ctx);
      }
      case 'array':
        if (Array.isArray(value)) {
          if (entry.minItems !== undefined && value.length < entry.minItems) fail(path, `expected at least ${entry.minItems} items`);
          if (entry.maxItems !== undefined && value.length > entry.maxItems) fail(path, `expected at most ${entry.maxItems} items`);
          const items = itemsOf(ctx);
          for (let i = 0; i < value.length; i++) check(value[i], entry.items, `${path}[${i}]`, true, items);
        } else if (isObject(value)) {
          for (const key of Object.keys(value)) {
            const index = Number(key);
            const itemPath = `${path}[${key}]`;
            if (!INDEX.test(key) || !Number.isSafeInteger(index)) fail(itemPath, 'expected a non-negative integer index');
            else if (entry.maxItems !== undefined && index >= entry.maxItems) fail(itemPath, `index must be below ${entry.maxItems}`);
            else check(value[key], entry.items, itemPath, false, down(ctx, key));
          }
        } else fail(path, 'expected an array or an object of item indexes');
        return;
    }
  }

  // Orders the normaliser would otherwise repair without a word: Blend If
  // levels rising, a noise gradient's min below its max. Whole arrays only
  // (an index patch does not carry the other half).
  function order(node, path = '') {
    if (Array.isArray(node)) return node.forEach((v, i) => order(v, `${path}[${i}]`));
    if (!isObject(node)) return;
    const q = node.blendIf;
    if (isObject(q)) {
      for (const [ch, pair] of Object.entries(q)) {
        for (const side of ['this', 'under']) {
          const v = pair?.[side];
          if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number') && v.some((n, i) => i && n < v[i - 1])) {
            fail(at(at(at(path, 'blendIf'), ch), side), `levels must not fall: [${v.join(', ')}]`, 'black low <= black high <= white low <= white high');
          }
        }
      }
    }
    const { min, max } = node;
    if (Array.isArray(min) && Array.isArray(max) && min.some((n, i) => typeof n === 'number' && typeof max[i] === 'number' && n > max[i])) {
      fail(at(path, 'min'), `noise min must not pass max: min [${min.join(', ')}], max [${max.join(', ')}]`);
    }
    for (const [k, v] of Object.entries(node)) if (k !== 'blendIf') order(v, at(path, k));
  }

  // No JSON input can recurse beyond the finite schema. Catch unreadable JS
  // objects too (throwing getters, revoked proxies), without inspecting them.
  try {
    fields(patch, STYLE_SCHEMA, '', null, root);
    if (!errors.length) order(patch);
  } catch {
    fail('', 'invalid or unreadable patch');
  }
  return errors;
}

/** Compact dotted paths for embedding directly in an AI tool description.
 * A union's variants print under `path[kind=name]`; a field a new item must
 * carry says `required`; a list of plain values (a point) says what it holds
 * on its own line rather than a line per value.
 */
export function styleSchemaText() {
  const lines = [];
  const lists = new Map();
  // Where each shared object was printed whole.
  const shapes = new Map();
  const scalar = (e) => !e.fields && !e.items && !e.variants;
  function walk(entry, path, required = false) {
    if (entry.shape && shapes.has(entry.shape)) {
      lines.push(`${path}: ${entry.type} like ${shapes.get(entry.shape)} - ${entry.desc}`);
      return;
    }
    if (entry.shape) shapes.set(entry.shape, path);
    let type = entry.type;
    if (entry.list) {
      type += ` ${entry.list}`;
      lists.set(entry.list, entry.values);
    } else if (entry.type === 'enum') type += ` ${entry.values.join('|')}`;
    if (entry.type === 'union') type += ` by ${entry.key}: ${Object.keys(entry.variants).join('|')}`;
    if (entry.min !== undefined || entry.max !== undefined) type += ` ${entry.min ?? '-inf'}..${entry.max ?? 'inf'}`;
    if (entry.type === 'array' && (entry.minItems !== undefined || entry.maxItems !== undefined)) {
      type += ` ${entry.minItems ?? 0}..${entry.maxItems ?? 'inf'} items`;
    }
    if (entry.type === 'array' && scalar(entry.items)) type += ` of ${entry.items.type}`;
    if (required) type += ' required';
    if (entry.readOnly) type += ' readOnly';
    lines.push(`${path}: ${type} - ${entry.desc}`);
    const children = (e, base) => {
      for (const [key, field] of Object.entries(e.fields)) walk(field, at(base, key), !!e.required?.includes(key));
    };
    if (entry.fields) children(entry, path);
    if (entry.variants) {
      for (const [name, v] of Object.entries(entry.variants)) {
        const base = `${path.replace(/\[\]$/, '')}[${entry.key}=${name}]`;
        children({ ...v, fields: Object.fromEntries(Object.entries(v.fields).filter(([k]) => k !== entry.key)) }, base);
      }
    }
    if (entry.items && !scalar(entry.items)) {
      const itemPath = `${path}[]`;
      if (entry.items.fields) children(entry.items, itemPath);
      else walk(entry.items, itemPath);
    }
  }
  for (const [key, entry] of Object.entries(STYLE_SCHEMA)) walk(entry, key);
  const legend = [...lists].map(([name, values]) => `${name} = ${values.join('|')}`);
  return [...legend, ...lines].join('\n');
}
