<script>
  import {
    app,
    byId,
    boxText,
    deleteBox,
    beginEdit,
    cloneStyle,
    page,
    previewBoxFont,
    endFontPreview,
    setBoxText,
    isFreeBox,
    refitBalloon,
    approveOutline,
    approvePageOutlines,
    centreTextInOutline,
    boxTagName,
    resetBoxToTagStyle,
    saveBoxStyleAsTag,
    outlineToBox,
    outlineState,
    toast,
    resizeBox,
    setBoxSizing,
    boxLocked,
    setBoxLocked,
    setChapterLight,
  } from './store.svelte.js';

  import { editBurst } from './edit-burst.js';
  import FontPicker from './FontPicker.svelte';
  import { sizingOf, sizeSetting, setSizeSetting, steppedSize, SIZE_MIN, SIZE_MAX } from './data.js';
  import { comboFor, formatCombo } from './shortcuts.svelte.js';
  import { modKey } from './format.js';
  import {
    PATTERN_KINDS,
    CANVAS_PATTERN_KINDS,
    SEEDED_PATTERN_KINDS,
    PATTERN_SCALE_MIN,
    PATTERN_SCALE_MAX,
    GRADIENT_MAX_STOPS,
    defaultPathPts,
    WARP_MIN_GRID,
    WARP_MAX_GRID,
    WARP_MESH_DEFAULT,
    LINE_HEIGHT_MIN,
    LINE_HEIGHT_MAX,
    letterSpacingRange,
    normalizeFit,
    BOLD_WEIGHT_MIN,
    BOLD_WEIGHT_MAX,
    ITALIC_ANGLE_MIN,
    ITALIC_ANGLE_MAX,
    ITALIC_ANGLE_DEF,
    CONTOUR_PRESETS,
    CONTOUR_LABELS,
    normalizeContour,
    SHADOW_SIZE_MAX,
    SHADOW_DISTANCE_MAX,
    SATIN_DISTANCE_MAX,
    newShadow,
    newInnerShadow,
    newOverlay,
    newGradientOverlay,
    newStrokeEffect,
    FX_GRADIENT_STYLES,
    NOISE_MODELS,
    STROKE_POSITIONS,
    GRADIENT_MIN_STOPS,
    LAYER_BLEND_MODES,
    LIGHT_DEF,
    BEVEL_DEPTH_MAX,
    BEVEL_SOFTEN_MAX,
    BLEND_IF_CHANNELS,
    BLEND_RANGE_FULL,
    fxDefault,
    fxReset,
    fxUntouched,
    storedShadowAngle,
    FX_INSTANCES_MAX,
    KNOCKOUT_MODES,
    BLENDING_SWITCHES,
    instanceOn,
    blendingSwitch,
  } from './data.js';
  import FxMenu from './FxMenu.svelte';
  import { setFxDefault, clearFxDefault } from './prefs.svelte.js';
  import { layoutShape } from './balloon.js';
  import { gradientCss, patternTileCanvas, sampleStops, shadowAngle, shadowDistance, shadowOffset, usesBackdrop, FILL_SPECIAL_MODES } from './text-paint.js';
  import { insertPathAnchor } from './measure.js';
  import { maskTool, setMaskTool } from './mask-tool.svelte.js';
  import { regridWarp } from './warp-gizmo.js';
  import { liquifyTool, setLiquifyMode, LIQUIFY_RADIUS_MIN, LIQUIFY_RADIUS_MAX } from './liquify-tool.svelte.js';
  import { LIQUIFY_MODES } from './liquify.js';
  import BrushPanel from './BrushPanel.svelte';
  import { clearSfx } from './sfx.js';
  import { engineSwitch } from './engine-switch.svelte.js';
  import { glyphPainter } from './text-engine/index.js';
  import { patternCard } from './pattern-cards.js';
  import { patternTiles, restorePickedTile } from './pattern-tiles.svelte.js';
  import { patternPick, startPatternPick, canPickPattern } from './pattern-pick.svelte.js';
  import ColorPicker from './ColorPicker.svelte';
  import BlendRangeSlider from './BlendRangeSlider.svelte';
  import ContourEditor from './ContourEditor.svelte';
  import { contourPoints } from './contour-curve.js';
  import { brushArmed } from './brush-tool.svelte.js';
  // Which tab is open is session state shared with the keyboard - see
  // inspector-tabs.svelte.js. The panel is one of two writers, not the owner.
  import {
    inspectorTab,
    setInspectorTab,
    effectsSubTab,
    setEffectsSubTab,
  } from './inspector-tabs.svelte.js';
  import { presets, savePreset, removePreset } from './presets.svelte.js';
  import {
    tabIcons,
    effectsSubTabIcons,
    iconRotate,
    iconGradientLinear,
    iconGradientRadial,
    iconNoFill,
    iconArrowUp,
  } from './tab-icons.js';
  import {
    createFieldUndo,
    recordFieldEdit,
    resyncField,
    undoField,
    redoField,
    caretAfter,
    isAtomicInput,
  } from './editor/field-undo.svelte.js';
  import { onDestroy } from 'svelte';

  const box = $derived(app.selectedId ? byId(app.selectedId) : null);
  // A locked box shows its settings and takes no change to them.
  const locked = $derived(boxLocked(box));
  // The tag this box's style answers to (LET-1), for the Tag style section.
  const tagName = $derived(box ? boxTagName(box.id) : null);

  // Four tabs across the top, one job each. What used to be five stacked
  // accordions in one scroll is now four panels the height of the panel: the
  // controls did not change, only how many of them are in front of you at once.
  const TABS = [
    ['text', 'Text'],
    ['fill', 'Fill'],
    ['effects', 'Effects'],
    ['layout', 'Layout'],
  ];
  const tab = $derived(inspectorTab.id);
  const setTab = setInspectorTab;

  // WAI-ARIA tabs: roving tabindex, Left/Right move and activate, Home/End
  // jump to the ends. The pane takes role=tabpanel and is named by its tab.
  function onTabKey(e, id) {
    const i = TABS.findIndex(([t]) => t === id);
    let n = null;
    if (e.key === 'ArrowLeft') n = (i + TABS.length - 1) % TABS.length;
    else if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    if (n == null) return;
    e.preventDefault();
    // The window's keydown handler reads a bare arrow as a nudge of the
    // selected box; a tab press must not also move it.
    e.stopPropagation();
    const next = TABS[n][0];
    setTab(next);
    document.getElementById(`insp-tab-${next}`)?.focus();
  }

  // SFX is not here: it has its own window (SfxWindow.svelte).
  const EFFECTS_TABS = [
    ['stroke', 'Stroke'],
    ['shadow', 'Shadow'],
    ['glow', 'Glow'],
    ['bevel', 'Bevel & Emboss'],
    ['warp', 'Warp'],
    // Not the same thing as the one above it, and the two labels are the only
    // place that says so to the user: `warp` bends the BASELINE (arc, circle,
    // bezier path), `transform` deforms the whole finished box through a mesh.
    ['transform', 'Transform'],
    // The same mesh as `transform`, pushed with a round tool instead of dragged
    // by its handles - which is why it works on type and ink alike.
    ['liquify', 'Liquify'],
    ['blur', 'Blur'],
    ['edges', 'Edges'],
    ['mask', 'Mask'],
  ];
  const effectsTab = $derived(effectsSubTab.id);

  function onSubTabKey(e, id) {
    const i = EFFECTS_TABS.findIndex(([t]) => t === id);
    let n = null;
    if (e.key === 'ArrowLeft') n = (i + EFFECTS_TABS.length - 1) % EFFECTS_TABS.length;
    else if (e.key === 'ArrowRight') n = (i + 1) % EFFECTS_TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = EFFECTS_TABS.length - 1;
    if (n == null) return;
    e.preventDefault();
    e.stopPropagation();
    const next = EFFECTS_TABS[n][0];
    setEffectsSubTab(next);
    document.getElementById(`insp-subtab-${next}`)?.focus();
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  // SFX is laid out before the path, the ring and the arc (`curvedStyle`), so a
  // bend asked for while it is on would be ignored without a word. Asking for
  // one switches SFX off, as switching SFX on switches them off (`enableSfx`),
  // and the look the sound type wrote goes back to the box's own.
  function sfxOff(st) {
    if (st.sfx?.on) clearSfx(st, true);
  }

  // Percentages are what the panel shows for every 0..1 alpha; the style keeps
  // the fraction.
  const pct = (v) => Math.round((v ?? 0) * 100);

  // Debounce history recording during continuous adjustments: a burst of
  // edits is one undo step (edit-burst.js, which the SFX window shares).
  // `armSnap` runs capture-phase on the panel, before any control writes.
  const burst = editBurst(() => box);
  const armSnap = burst.arm;
  const touch = burst.touch;
  const settle = burst.settle;

  // The family a font picker settled on. Whatever it was showing goes back
  // first, so the snapshot the edit is recorded against is the box as it was.
  function pickFont(name) {
    endFontPreview();
    armSnap();
    box.style.font = name;
    touch();
  }

  onDestroy(() => {
    burst.dispose();
    // The delete-preset arming timer too. It is one 2.5s timer rather than a
    // leak that grows, but it holds this component's closure past its unmount
    // and then writes `delArm` - state belonging to an Inspector that is no
    // longer on screen.
    clearTimeout(delArmT);
  });

  // One setter for every plain numeric field: clamp, write, touch. Saves the
  // panel from spelling the same three lines out forty times.
  // The fold under B and I (bold weight, italic angle): closed until asked.
  let styleMore = $state(false);
  const styleTuned = (st) => (st.bold && st.boldWeight !== BOLD_WEIGHT_MIN) || (st.italic && st.italicAngle !== ITALIC_ANGLE_DEF);

  function setNum(obj, key, v, lo, hi, round = false) {
    let n = +v;
    if (!Number.isFinite(n)) n = 0;
    n = clamp(n, lo, hi);
    obj[key] = round ? Math.round(n) : n;
    touch();
  }

  // Typed entry into a number field commits on change/blur rather than on
  // every keystroke: live coercion would turn a half-typed "-" or a cleared
  // field into 0 under the caret mid-entry (the NaN→0 above), which is what
  // makes negative values untypable. Spinner clicks and arrow keys fire
  // change per step, so scrubbing stays live. The field is rewritten from the
  // style afterwards, so a clamped or rejected edit never lingers in it.
  function commitNum(obj, key, e, lo, hi, round = false) {
    const el = e.target;
    let n = +el.value;
    if (!Number.isFinite(n)) n = 0;
    n = clamp(n, lo, hi);
    obj[key] = round ? Math.round(n) : n;
    el.value = String(obj[key]);
    touch();
  }
  // A mesh grid stepper, which cannot be `commitNum`: writing `cols` on its own
  // would leave `pts` the wrong length for the grid it now names, and the
  // sanitiser's answer to that is to throw the whole mesh away (it has to be -
  // a mesh missing a control point is torn, not coarse). So the block is
  // replaced whole, with the deformation carried onto the new grid by
  // `regridWarp`. One history step per change, through the panel's own settle.
  function setGrid(st, key, e) {
    const el = e.target;
    const now = st.warp[key];
    let n = Math.round(+el.value);
    if (!Number.isFinite(n)) n = now;
    n = clamp(n, WARP_MIN_GRID, WARP_MAX_GRID);
    el.value = String(n);
    if (!box || n === now) return;
    st.warp = regridWarp(st.warp, key === 'cols' ? n : st.warp.cols, key === 'rows' ? n : st.warp.rows, box.w, box.h);
    touch();
  }
  // Free is the one-cell mesh - four corner handles and a perspective map -
  // and Mesh is any grid. The two are one setting read two ways, so switching
  // is a regrid: Free keeps the corners of whatever grid it came from, Mesh
  // comes up at the default lattice with the perspective carried onto it.
  const warpIsFree = (st) => st.warp.cols === 1 && st.warp.rows === 1;
  function setWarpMode(st, free) {
    if (!box || warpIsFree(st) === free) return;
    const n = free ? 1 : WARP_MESH_DEFAULT;
    st.warp = regridWarp(st.warp, n, n, box.w, box.h);
    touch();
  }

  // The same commit-on-change for the placement fields, which write the box's
  // own geometry rather than its style.
  function commitGeom(key, e, lo, hi, fallback) {
    const el = e.target;
    let n = +el.value;
    if (!Number.isFinite(n)) n = fallback ?? lo;
    const val = clamp(n, lo, hi);
    resizeBox(page().id, box.id, { [key]: val });
    el.value = String(Math.round(box[key]));
    touch({ geom: true });
  }

  // And for alpha fields, which read percent and store a fraction.
  function commitAlpha(obj, key, e) {
    const el = e.target;
    obj[key] = clamp((+el.value || 0) / 100, 0, 1);
    el.value = String(Math.round(obj[key] * 100));
    touch();
  }
  // Alpha fields are edited in percent and stored as a fraction.
  function setAlpha(obj, key, v) {
    obj[key] = clamp((+v || 0) / 100, 0, 1);
    touch();
  }

  // The size field: typed and committed on change, or stepped by the − and +
  // either side of it, the arrow keys (Shift for 10), or the bigger/smaller
  // shortcuts from anywhere (App.svelte). In Fit to box the number is the most
  // the fit may grow to, and the size it settled on shows under the field.
  function setSize(v) {
    setSizeSetting(box.style, v);
    touch();
  }
  function commitSize(e) {
    setSize(e.target.value);
    e.target.value = String(sizeNow);
  }
  const stepSize = (d) => setSize(steppedSize(sizeNow, d));
  function sizeKey(e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    stepSize((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
  }
  const sizeNow = $derived(box ? Math.round(sizeSetting(box.style) * 10) / 10 : 0);
  const sizeKeys = $derived({ up: formatCombo(comboFor('box.sizeUp')), down: formatCombo(comboFor('box.sizeDown')) });
  const sizing = $derived(box ? sizingOf(box.style) : 'auto');
  const SIZINGS = [
    ['auto', 'Auto height', 'The height follows the text. You set the width and the size.'],
    ['fixed', 'Fixed', 'You set the width, the height and the size. Text that does not fit is flagged.'],
    ['fit', 'Fit to box', 'You set the width and the height. The size is the largest that fits.'],
  ];

  function wrap180(v) {
    return (((v + 180) % 360) + 360) % 360 - 180;
  }
  function setRotation(v) {
    box.style.rotation = clamp(Math.round(+v || 0), -180, 180);
    touch();
  }
  function rotateBy(d) {
    box.style.rotation = wrap180(Math.round(box.style.rotation + d));
    touch();
  }
  // The text alone, then `touch`, whose `boxEdited` fits the box for it. With
  // `setBoxText`'s own fit as well, every keystroke here solved the box twice,
  // the second time to the answer the first had just written.
  function setText(v) {
    setBoxText(box, v, page(), { fit: false });
    touch();
  }

  // Text field maintains its own undo stack.
  const fieldUndo = createFieldUndo();

  let fieldOwner = null;

  // Resync undo stack when box or text changes externally.
  $effect(() => {
    const id = box?.id ?? null;
    const v = box ? boxText(box) : '';
    if (id === fieldOwner && v === fieldUndo.stack[fieldUndo.i]) return;
    fieldOwner = id;
    resyncField(fieldUndo, v);
  });

  function onTextInput(e) {
    recordFieldEdit(fieldUndo, e.target.value, { atomic: isAtomicInput(e.inputType) });
    setText(e.target.value);
  }

  function onTextKey(e) {
    if (!(e.metaKey || e.ctrlKey) || (e.key !== 'z' && e.key !== 'Z')) return;
    // Intercept Cmd+Z/Shift+Cmd+Z for field undo.
    e.preventDefault();
    const next = e.shiftKey ? redoField(fieldUndo) : undoField(fieldUndo);
    if (next == null) return;
    const el = e.currentTarget;
    const caret = caretAfter(el.value, next);

    el.value = next;
    el.setSelectionRange(caret, caret);

    setText(next);
  }

  // Validate CSS hex color strings.
  const HEX = /^#?(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const HEX_MSG = 'Not a hex colour - use 3, 4, 6 or 8 hex digits, like #ff00aa';

  // An invalid value is flagged in place, not reverted: silently putting the
  // old colour back reads as the field eating your text. The warning wears
  // off on the next valid value.
  function hexFlag(el, bad) {
    if (!el) return;
    el.classList.toggle('hex-bad', !!bad);
    if (bad) el.title = HEX_MSG;
    else el.removeAttribute('title');
  }
  // Live while typing, so the border turns as soon as the text stops being a
  // colour and turns back the moment it is one again.
  function hexInput(e) {
    const el = e.target;
    hexFlag(el, el.value !== '' && !HEX.test(el.value));
  }

  // A colour picker's change. The picker's popover floats in <body>, outside
  // `.insp`, so the capture-phase pointerdown/keydown that arms the undo
  // snapshot never sees a press on its square or its fields: the snapshot is
  // armed here instead, before the write, or a pick made after a pause would
  // record before === after and be lost to undo.
  // A colour set by hand is the box's colour from here on: its bubble stops
  // picking black or white for it (LET-3).
  function handColour() {
    if (box?.style) box.style.autoContrast = false;
  }

  function setColour(obj, key, hex) {
    armSnap();
    obj[key] = hex;
    handColour();
    touch();
  }

  function setHex(obj, key, v, el) {
    const raw = String(v ?? '').trim();
    if (HEX.test(raw)) {
      obj[key] = raw.startsWith('#') ? raw : '#' + raw;
      handColour();
      touch();
      hexFlag(el, false);
    } else {
      hexFlag(el, true);
    }
  }

  // ---- fill mode ----
  // Four exclusive looks over three independent flags, because the renderer
  // needs them all (no fill beats pattern beats gradient when more than one
  // is on) and the user needs one choice.
  const fillMode = $derived(
    box ? (box.style.noFill ? 'none' : box.style.pattern.on ? 'pattern' : box.style.gradient.on ? 'gradient' : 'solid') : 'solid',
  );
  function setFillMode(m) {
    box.style.noFill = m === 'none';
    box.style.gradient.on = m === 'gradient';
    box.style.pattern.on = m === 'pattern';
    touch();
  }

  // ---- gradient ----
  function setGradKind(k) {
    box.style.gradient.kind = k;
    touch();
  }

  // The eight-way pad, laid out as it reads: the cell's position IS the
  // direction. Angles are the style's own CSS degrees (0 = bottom→top), so
  // picking a cell writes the same field the number beside it does.
  const DIRS = [
    { a: 315, n: 'Up left' },
    { a: 0, n: 'Up' },
    { a: 45, n: 'Up right' },
    { a: 270, n: 'Left' },
    null,
    { a: 90, n: 'Right' },
    { a: 225, n: 'Down left' },
    { a: 180, n: 'Down' },
    { a: 135, n: 'Down right' },
  ];
  function setAngle(a) {
    box.style.gradient.angle = ((Math.round(a) % 360) + 360) % 360;
    touch();
  }

  // The same nine cells for a radial centre, with the corners left out: a
  // gradient centred on a corner of a line of text is a look nobody has asked
  // for, and the five that are here are the ones a highlight is built from.
  const CENTRES = [
    null,
    { cx: 0.5, cy: 0, n: 'Top' },
    null,
    { cx: 0, cy: 0.5, n: 'Left' },
    { cx: 0.5, cy: 0.5, n: 'Centre' },
    { cx: 1, cy: 0.5, n: 'Right' },
    null,
    { cx: 0.5, cy: 1, n: 'Bottom' },
    null,
  ];
  function setCentre(c) {
    box.style.gradient.cx = c.cx;
    box.style.gradient.cy = c.cy;
    touch();
  }
  const near = (a, b) => Math.abs((a ?? 0) - b) < 0.02;

  // ---- gradient stops ----
  //
  // The stop bar: the ramp drawn left to right, a handle per stop under it, and
  // one row of controls for whichever handle is selected. It is a bar rather
  // than a list because a stop's whole meaning is WHERE it is, and a column of
  // percentages says that worse than a handle sitting at the place it means.
  //
  // The arrays here are `$state` proxies reached through `box.style`, so every
  // push/splice below mutates in place and the render follows; `touch()` is
  // what turns it into one undo entry.

  // Which handle the controls under the bar are talking about, by index. The
  // list is kept sorted, so an index is a stable enough name for it: the only
  // thing that reorders the list is a drag or a nudge, and both of those carry
  // the selection across the sort themselves.
  let stopIdx = $state(0);
  // The bar element, which is what a pointer position is measured against - the
  // handles sit on a rail of the same width below it. `$state` only because
  // `bind:this` writes it; nothing renders from either of these.
  let barEl = $state(null);
  // The colour picker behind the selected stop's swatch, so a double-click on
  // a handle can open the same picker the swatch opens.
  let stopPicker = $state(null);
  // The index being dragged, or null. Not `$state`: nothing renders from it.
  let dragging = null;

  const gradStops = $derived(box?.style.gradient.stops ?? []);
  const selStop = $derived(gradStops[Math.min(stopIdx, gradStops.length - 1)] ?? null);
  // The bar shows the RAMP, not the gradient's direction: left to right whatever
  // the angle is, and flat whether the fill is linear or radial. The pad above
  // it is where direction is decided; asking the bar to say both at once would
  // leave a radial one as a bullseye you cannot read stop positions off.
  const barCss = $derived(gradientCss({ kind: 'linear', angle: 90, stops: gradStops }));

  // Selection belongs to the box, not to the panel: a different box's gradient
  // has different stops and the old index would name one of them.
  $effect(() => {
    box?.id;
    stopIdx = 0;
  });

  // Where along the bar a pointer is, 0..1.
  function posOf(e) {
    const r = barEl?.getBoundingClientRect();
    if (!r?.width) return 0;
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  }

  // Sorting reassigns the array from a plain snapshot rather than sorting the
  // proxy in place, so the selected stop can be found again afterwards by
  // identity - the proxies do not survive the swap, the plain objects they
  // snapshot to do. The sort is a real edit to the style - it changes which
  // colour the gradient starts at - so it has to touch() like every other
  // mutation, or a reorder that lands after the debounce has already fired is
  // never recorded and never marks the document unsaved.
  function sortStops(keep = stopIdx) {
    const raw = $state.snapshot(box.style.gradient.stops);
    const sel = raw[keep] ?? null;
    raw.sort((a, b) => a.pos - b.pos);
    box.style.gradient.stops = raw;
    if (sel) stopIdx = raw.indexOf(sel);
    touch();
  }

  // A click on an empty part of the bar adds a handle there, in the colour the
  // ramp was already showing at that spot - so the gesture gives the gradient a
  // control point without changing what it looks like.
  function addStopAt(p) {
    const stops = box.style.gradient.stops;
    if (stops.length >= GRADIENT_MAX_STOPS) return;
    const { color, opacity } = sampleStops($state.snapshot(stops), p);
    // Inserted in place rather than appended and sorted, so the list stays
    // ordered and the new stop's index is known without a search.
    let i = stops.findIndex((st) => st.pos > p);
    if (i < 0) i = stops.length;
    stops.splice(i, 0, { color, pos: p, opacity: Math.min(1, Math.max(0, opacity)) });
    stopIdx = i;
    touch();
  }
  function onBarDown(e) {
    // A handle is a button inside the same box and takes its own pointerdown;
    // anything else that lands here is the bar itself.
    if (e.target.closest('.gstop')) return;
    addStopAt(posOf(e));
  }

  // Midpoint of the widest quiet stretch of the ramp, rail ends included -
  // where a new stop has the most room to mean something. This is what the
  // add-stop button inserts at: the keyboard's answer to clicking an empty
  // part of the bar.
  function addStopWidestGap() {
    if (!box) return;
    const pts = box.style.gradient.stops
      .map((st) => clamp(Number(st.pos) || 0, 0, 1))
      .sort((a, b) => a - b);
    let gap = -1;
    let p = 0.5;
    const edges = [0, ...pts, 1];
    for (let i = 0; i < edges.length - 1; i++) {
      const w = edges[i + 1] - edges[i];
      if (w > gap) {
        gap = w;
        p = (edges[i] + edges[i + 1]) / 2;
      }
    }
    addStopAt(p);
  }

  function onStopDown(e, i) {
    // Selecting and dragging a handle is not clicking the bar under it.
    e.stopPropagation();
    e.preventDefault();
    stopIdx = i;
    dragging = i;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus();
  }
  // Live while the pointer moves, unsorted: a stop dragged past its neighbour
  // keeps its index until the pointer comes up, or the handle would swap out
  // from under the finger holding it. The ramp itself is correct either way -
  // both renderers read `pos`, not array order.
  function onStopMove(e) {
    if (dragging == null) return;
    const st = box.style.gradient.stops[dragging];
    if (!st) return;
    st.pos = posOf(e);
    touch();
  }
  function onStopUp(e) {
    if (dragging == null) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const was = dragging;
    dragging = null;
    sortStops(was);
  }
  // Arrow keys nudge the selected stop by a percent. The propagation stops here
  // because the canvas' own arrow keys nudge the whole BOX, and a handle with
  // focus is not an input the global shortcuts already stand back from.
  function onStopKey(e, i) {
    // Enter on a focused handle opens the colour picker, matching the
    // double-click - the one stop gesture pointer users had that keyboard
    // users did not.
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      openStopColour(e, i);
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const st = box.style.gradient.stops[i];
    if (!st) return;
    stopIdx = i;
    st.pos = clamp((Number(st.pos) || 0) + (e.key === 'ArrowRight' ? 0.01 : -0.01), 0, 1);
    sortStops(i);
  }
  // A double-click on a handle is the shortest way to the thing a stop is
  // mostly about, so it opens the colour picker the swatch below opens.
  function openStopColour(e, i) {
    e.stopPropagation();
    stopIdx = i;
    stopPicker?.show();
  }

  function removeStop(i) {
    // Two stops is the floor: one stop is not a gradient, it is a fill.
    const stops = box.style.gradient.stops;
    if (stops.length <= 2) return;
    stops.splice(i, 1);
    if (stopIdx >= stops.length) stopIdx = stops.length - 1;
    touch();
  }

  // ---- patterns ----
  // A pattern is picked by looking at it. Each card draws the real tile through
  // the same painter the editor and the exporter use, in the box's own two
  // colours, so what is on the card is what lands on the glyphs.
  const PATTERN_LABELS = {
    dots: 'Dots',
    halftone: 'Halftone',
    stripes: 'Stripes',
    hstripes: 'Bands',
    diagonal: 'Diagonal',
    'diagonal-alt': 'Diagonal 2',
    crosshatch: 'Crosshatch',
    checker: 'Checker',
    grid: 'Grid',
    vlines: 'Hairline',
    hlines: 'Hairline 2',
    'halftone-fade': 'Tone fade',
    'square-dots': 'Squares',
    'diamond-dots': 'Diamonds',
    'line-tone': 'Line tone',
    sand: 'Sand',
    stipple: 'Stipple',
    'speed-lines': 'Speed lines',
    burst: 'Burst',
    rings: 'Rings',
    waves: 'Waves',
    zigzag: 'Zigzag',
    bricks: 'Bricks',
    scales: 'Scales',
    hex: 'Hex',
    triangles: 'Triangles',
    plus: 'Plus',
    stars: 'Stars',
    hearts: 'Hearts',
    kakeami: 'Kakeami',
    glitch: 'Glitch',
    dither: 'Dither',
    'dither-dots': 'Dither dots',
    picked: 'From page',
  };
  const patLabel = (k) => PATTERN_LABELS[k] ?? k;
  // The picker's groups, so thirty-three cards are not one long wall.
  const PATTERN_GROUPS = {
    tone: ['dots', 'halftone', 'halftone-fade', 'dither', 'dither-dots', 'square-dots', 'diamond-dots', 'stipple', 'sand'],
    lines: ['stripes', 'hstripes', 'diagonal', 'diagonal-alt', 'crosshatch', 'vlines', 'hlines', 'line-tone', 'waves', 'zigzag', 'kakeami'],
    action: ['speed-lines', 'burst', 'rings', 'glitch'],
    shapes: ['checker', 'grid', 'bricks', 'scales', 'hex', 'triangles', 'plus', 'stars', 'hearts'],
  };
  let patGroup = $state('all');
  // The Rust engine shades a pattern per pixel and paints every kind and
  // control; the browser engine repeats one of the eleven canvas tiles.
  const rustPatterns = $derived(engineSwitch.painting && glyphPainter().screen === true);
  // The engine paints whole boxes: Fill Opacity, and a shadow's Spread,
  // Contour, Noise and knockout (the browser engine paints none of them).
  const rustBoxes = $derived(engineSwitch.painting && glyphPainter().box === true);
  // Blend If's channel menu (Gray, Red, Green, Blue), as Photoshop's dialog
  // shows one channel's two sliders at a time.
  let blendIfChannel = $state('gray');
  const BLEND_IF_LABEL = { gray: 'Gray', red: 'Red', green: 'Green', blue: 'Blue' };
  function setBlendIf(s, channel, side, range) {
    const bi = s.blending?.blendIf ?? {};
    s.blending = { ...s.blending, blendIf: { ...bi, [channel]: { ...bi[channel], [side]: range } } };
    touch();
  }
  function setChannel(s, key, on) {
    s.blending = { ...s.blending, channels: { r: true, g: true, b: true, ...s.blending?.channels, [key]: on } };
    touch();
  }
  // Knockout, and the Advanced Blending switches past it (`BLENDING_SWITCHES`):
  // a switch back at its Photoshop default is not stored.
  const KNOCKOUT_LABEL = { none: 'None', shallow: 'Shallow', deep: 'Deep' };
  function setKnockout(s, v) {
    s.blending = { ...s.blending, knockout: KNOCKOUT_MODES.includes(v) ? v : 'none' };
    touch();
  }
  function setBlendingSwitch(s, key, on) {
    const { [key]: _was, ...rest } = s.blending ?? {};
    s.blending = on === BLENDING_SWITCHES[key] ? rest : { ...rest, [key]: on };
    touch();
  }
  const shownKinds = $derived.by(() => {
    if (!rustPatterns) return CANVAS_PATTERN_KINDS;
    return patGroup === 'all' ? PATTERN_KINDS : PATTERN_GROUPS[patGroup];
  });
  // The card's tile is a fixed size rather than the box's, so the cards are
  // comparable with each other; `scale` is the slider under them.
  const CARD_SIZE = 44;
  const CARD_TILE = CARD_SIZE * 0.3;
  const CARD_W = 70;
  const CARD_H = 30;
  const patternCards = $derived.by(() => {
    const pat = box?.style.pattern;
    const fg = pat?.fg ?? '#000000';
    const bg = pat?.bg ?? '#ffffff';
    const out = {};
    if (rustPatterns && pat) {
      // The engine's own fill, in this box's colours, density, turn and
      // stretch: the card is what lands on the letters.
      const dpr = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1);
      const look = $state.snapshot(pat);
      for (const k of shownKinds) out[k] = patternCard({ ...look, kind: k }, CARD_W, CARD_H, dpr);
      // The picked tile's card waits on its file being read.
      patternTiles.version;
      if (look.src && look.cell.length) out.picked = patternCard({ ...look, kind: 'picked' }, CARD_W, CARD_H, dpr);
      return out;
    }
    for (const k of CANVAS_PATTERN_KINDS) {
      const cnv = patternTileCanvas({ size: CARD_SIZE, pattern: { kind: k, fg, bg, scale: 1 } }, 2);
      out[k] = cnv ? cnv.toDataURL() : '';
    }
    return out;
  });
  function setPatternKind(k) {
    box.style.pattern.kind = k;
    touch();
  }
  // Pattern from page: the next drag on the page is read (pattern-pick.svelte.js),
  // which records its own style step, so the panel's pending one lands first.
  function pickFromPage(target = 'pattern') {
    if (!box) return;
    settle();
    startPatternPick(page().id, box.id, target);
  }
  // An effect's pattern takes the tile the fill already took from the page,
  // at the page's own size and lie, as a pick does.
  function usePickedTile(p, from) {
    Object.assign(p, { kind: 'picked', src: from.src, cell: [...from.cell], mode: from.mode, scale: 1, angle: 0, aspect: 1, density: 0.5, ox: 0, oy: 0 });
    touch();
  }

  // ---- strokes ----
  function addStroke() {
    const ks = box.style.strokes;
    // A new band goes OUTSIDE the ones already there (the array is innermost
    // first), which is the only place a second stroke is ever wanted.
    ks.push({ color: ks.length ? '#000000' : '#ffffff', width: 3, opacity: 1 });
    touch();
  }
  function removeStroke(i) {
    box.style.strokes.splice(i, 1);
    touch();
  }

  // ---- Make Default / Reset to Default (LAYER_STYLES_PLAN.md item 12) ----
  // Each effect's "…" menu (FxMenu). Make Default saves a copy for the
  // person (prefs.svelte.js strips what is this instance's own); Reset puts
  // the saved default (or the factory's) back over the effect, keeping its
  // switch and seeds, as ONE undo step: the burst before it is closed, the box
  // as it is now is the step's start, and the step is closed straight after.
  function fxPick(kind, fx, name, id) {
    if (!box || !fx) return;
    if (id === 'make') {
      setFxDefault(kind, $state.snapshot(fx));
      toast(`${name}: saved as the default.`);
      return;
    }
    if (id === 'factory') clearFxDefault(kind);
    const next = fxReset(kind, $state.snapshot(fx), app.typesetting.light ?? LIGHT_DEF, id === 'factory');
    if (!next) return;
    settle();
    armSnap();
    Object.assign(fx, next);
    // What the reset leaves out goes: a switch at its default is not stored
    // (`on` of an instance, an Advanced Blending switch), and a shadow's kept
    // angle is only what `next` says (`storedShadowAngle`).
    for (const k of Object.keys(fx)) if (!Object.hasOwn(next, k)) delete fx[k];
    touch();
    settle();
  }
  // Switching on a one-of effect (a glow, the Satin, the Bevel, the Pattern
  // Overlay) that was never edited is Photoshop's Add: it starts from the
  // person's default when there is one.
  function switchFx(kind, fx) {
    if (!fx.on && fxDefault(kind) && fxUntouched(kind, $state.snapshot(fx))) {
      Object.assign(fx, fxReset(kind, $state.snapshot(fx), app.typesetting.light ?? LIGHT_DEF));
    }
    fx.on = !fx.on;
    touch();
  }

  // ---- a multi effect's instances ----
  // Drop Shadow, Inner Shadow, Colour Overlay, Gradient Overlay and the
  // Photoshop Stroke come up to FX_INSTANCES_MAX of a kind, the first on top.
  // Each has its own switch (`on`, stored only when off), moves up or down
  // its list, and is duplicated in place, the copy over it, as Photoshop's +
  // does. PhotoCraft's dialog does the same (`move_instance`,
  // `add_instance` in crates/ui-egui/src/dialogs/layer_style.rs).
  function setInstanceOn(item, on) {
    if (on) delete item.on;
    else item.on = false;
    touch();
  }
  function moveInstance(list, i, by) {
    const j = i + by;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    touch();
  }
  function duplicateInstance(list, i) {
    if (list.length >= FX_INSTANCES_MAX || !list[i]) return;
    list.splice(i, 0, $state.snapshot(list[i]));
    touch();
  }
  const roomFor = (list) => list.length < FX_INSTANCES_MAX;

  // ---- shadows ----
  // Photoshop's Drop Shadow: a new one is Photoshop's, on the chapter's light.
  function addShadow() {
    if (!roomFor(box.style.shadows)) return;
    box.style.shadows.push(newShadow(app.typesetting.light));
    touch();
  }
  // Angle and Distance are how the panel states a shadow's offset. The angle of
  // one on the Global Light is the chapter's: turning it turns every shadow
  // that follows the light, as in Photoshop.
  // At Distance 0 the offset holds no direction, so a shadow off the light
  // keeps its angle in the style (`angle`, `storedShadowAngle` in data.js),
  // as Photoshop stores Angle and Distance: it is saved, undone and redone
  // with the rest, and used when the distance comes back.
  const angleOf = (sh) => shadowAngle(sh);
  function keepShadowAngle(sh, a) {
    const keep = storedShadowAngle(sh, a);
    if (keep === undefined) delete sh.angle;
    else sh.angle = keep;
  }
  function setShadowAngle(sh, e) {
    const el = e.target;
    let a = +el.value;
    if (!Number.isFinite(a)) a = angleOf(sh);
    a = clamp(a, -180, 180);
    if (sh.useGlobalLight) setChapterLight({ angle: a });
    else {
      Object.assign(sh, shadowOffset(a, shadowDistance(sh)));
      keepShadowAngle(sh, a);
      touch();
    }
    el.value = String(angleOf(sh));
  }
  function setShadowDistance(sh, e) {
    const el = e.target;
    let d = +el.value;
    if (!Number.isFinite(d)) d = 0;
    d = clamp(d, 0, SHADOW_DISTANCE_MAX);
    const a = angleOf(sh);
    Object.assign(sh, shadowOffset(a, d));
    if (!sh.useGlobalLight) keepShadowAngle(sh, a);
    el.value = String(Math.round(shadowDistance(sh) * 100) / 100);
    touch();
  }
  // Off the light, a shadow keeps the angle it had from it.
  function setShadowGlobal(sh, on) {
    const a = angleOf(sh);
    Object.assign(sh, shadowOffset(a, shadowDistance(sh)));
    sh.useGlobalLight = on;
    keepShadowAngle(sh, a);
    touch();
  }
  // A gradient overlay's Offset: % of the box, -100 to 100.
  function setFxGradientOffset(g, i, e) {
    const v = clamp(Math.round(+e.target.value || 0), -100, 100);
    g.offset = i === 0 ? [v / 100, g.offset?.[1] ?? 0] : [g.offset?.[0] ?? 0, v / 100];
    e.target.value = String(v);
    touch();
  }
  function setShadowContour(sh, preset) {
    sh.contour = { preset, aa: sh.contour?.aa === true };
    touch();
  }
  // ---- custom contours (ContourEditor) ----
  // The one contour editor open, by its title; a press on the panel arms
  // the step, so a drag in the editor is one undo step and a field edit
  // another.
  let contourOpen = $state(null);
  // A contour picked from its menu. Custom starts from the curve it was
  // and opens the editor on it.
  function pickContour(owner, key, value, id) {
    const was = owner[key];
    if (value === 'custom') {
      if (was?.preset !== 'custom') owner[key] = normalizeContour({ preset: 'custom', aa: was?.aa === true, pts: contourPoints(was) });
      contourOpen = id;
    } else {
      owner[key] = { preset: value, aa: was?.aa === true };
    }
    touch();
  }
  function setContour(owner, key, next) {
    owner[key] = next;
    touch();
  }

  // ---- bevel ----
  // Style and Technique as Photoshop's dialog names them.
  const BEVEL_STYLE_OPTIONS = [['outer', 'Outer Bevel'], ['inner', 'Inner Bevel'], ['emboss', 'Emboss'], ['pillow', 'Pillow Emboss'], ['stroke', 'Stroke Emboss']];
  const BEVEL_TECHNIQUE_OPTIONS = [['smooth', 'Smooth'], ['chisel-hard', 'Chisel Hard'], ['chisel-soft', 'Chisel Soft']];
  // The light a bevel is shaded from: the chapter's on the Global Light, its
  // own when not. Turning or raising one on the light turns or raises the
  // chapter's, as in Photoshop, and every shadow and bevel on it follows.
  const bevelLight = (bv) => (bv.useGlobalLight ? (app.typesetting.light ?? LIGHT_DEF) : bv);
  function setBevelLight(bv, key, e, lo, hi) {
    const el = e.target;
    let v = +el.value;
    if (!Number.isFinite(v)) v = bevelLight(bv)[key];
    v = clamp(v, lo, hi);
    if (bv.useGlobalLight) setChapterLight({ [key]: v });
    else {
      bv[key] = v;
      touch();
    }
    el.value = String(bevelLight(bv)[key]);
  }
  // Off the light, a bevel keeps the angle and altitude it had from it.
  function setBevelGlobal(bv, on) {
    if (!on && bv.useGlobalLight) {
      const l = bevelLight(bv);
      bv.angle = l.angle;
      bv.altitude = l.altitude;
    }
    bv.useGlobalLight = on;
    touch();
  }
  // A percent field over a fraction: Depth and the Texture's Scale and Depth.
  function commitPct(obj, key, e, lo, hi) {
    const el = e.target;
    let v = +el.value;
    if (!Number.isFinite(v)) v = obj[key] * 100;
    v = clamp(v, lo, hi);
    obj[key] = v / 100;
    el.value = String(Math.round(v));
    touch();
  }
  function removeShadow(i) {
    box.style.shadows.splice(i, 1);
    touch();
  }
  // Inner Shadow: a drop shadow's controls, thrown into the letters.
  function addInnerShadow() {
    if (!roomFor(box.style.innerShadows)) return;
    box.style.innerShadows.push(newInnerShadow(app.typesetting.light));
    touch();
  }
  function removeInnerShadow(i) {
    box.style.innerShadows.splice(i, 1);
    touch();
  }
  // Color Overlay.
  function addOverlay() {
    if (!roomFor(box.style.colorOverlays)) return;
    box.style.colorOverlays.push(newOverlay());
    touch();
  }
  function removeOverlay(i) {
    box.style.colorOverlays.splice(i, 1);
    touch();
  }
  // Gradient Overlay, and Photoshop's Stroke effect: lists, first on top.
  function addGradientOverlay() {
    if (!roomFor(box.style.gradientOverlays)) return;
    box.style.gradientOverlays.push(newGradientOverlay());
    touch();
  }
  function removeGradientOverlay(i) {
    box.style.gradientOverlays.splice(i, 1);
    touch();
  }
  function addStrokeEffect() {
    if (!roomFor(box.style.strokeEffects)) return;
    box.style.strokeEffects.push(newStrokeEffect());
    touch();
  }
  function removeStrokeEffect(i) {
    box.style.strokeEffects.splice(i, 1);
    touch();
  }
  // An effect gradient's stops: added in the widest gap, removed down to two,
  // kept in order.
  function addFxStop(g) {
    const st = g.stops;
    let at = 0;
    let gap = -1;
    for (let i = 0; i + 1 < st.length; i++) {
      if (st[i + 1].pos - st[i].pos > gap) {
        gap = st[i + 1].pos - st[i].pos;
        at = i;
      }
    }
    const pos = st.length > 1 ? (st[at].pos + st[at + 1].pos) / 2 : 0.5;
    st.splice(at + 1, 0, { color: st[at]?.color ?? '#000000', pos, opacity: 1 });
    touch();
  }
  function removeFxStop(g, i) {
    if (g.stops.length <= GRADIENT_MIN_STOPS) return;
    g.stops.splice(i, 1);
    touch();
  }
  function sortFxStops(g) {
    g.stops.sort((a, b) => a.pos - b.pos);
    touch();
  }
  // The ramp as CSS, for the strip over an effect gradient's stops.
  const fxRamp = (g) => `linear-gradient(90deg, ${g.stops.map((st) => `color-mix(in srgb, ${st.color} ${pct(st.opacity)}%, transparent) ${pct(st.pos)}%`).join(', ')})`;
  const FX_STYLE_LABELS = { linear: 'Linear', radial: 'Radial', angle: 'Angle', reflected: 'Reflected', diamond: 'Diamond', shapeburst: 'Shape Burst' };
  // A noise gradient's colour models and their channels, as Photoshop's
  // Gradient Editor names them.
  const NOISE_MODEL_LABELS = { rgb: 'RGB', hsb: 'HSB', lab: 'LAB' };
  const NOISE_CHANNELS = { rgb: ['R', 'G', 'B'], hsb: ['H', 'S', 'B'], lab: ['L', 'a', 'b'] };
  // One channel's Limits, in %: a low past the high pushes the high up, and
  // the other way.
  function setNoiseLimit(n, side, i, e) {
    const v = clamp(Math.round(+e.target.value || 0), 0, 100) / 100;
    n[side][i] = v;
    if (side === 'min' && n.max[i] < v) n.max[i] = v;
    if (side === 'max' && n.min[i] > v) n.min[i] = v;
    e.target.value = String(pct(v));
    touch();
  }
  // Randomize: a new seed, so a new ramp from the same settings.
  function randomizeNoise(n) {
    let seed = n.seed;
    while (seed === n.seed) seed = Math.floor(Math.random() * 2 ** 32) >>> 0;
    n.seed = seed;
    touch();
  }
  const POSITION_LABELS = { outside: 'Outside', inside: 'Inside', center: 'Center' };
  // A blend mode's name as Photoshop's menu shows it.
  const blendLabel = (m) => m.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

  // ---- presets ----
  let presetId = $state('');

  // Save runs through an inline name field rather than window.prompt: the
  // native dialog blocks the page and looks like nothing else in the app.
  let naming = $state(false);
  let presetName = $state('');
  let presetNameEl = $state(null);
  // Delete is two-step: the first press arms it ('Sure?'), the second
  // confirms, and arming wears off on its own so a parked click cannot fire.
  let delArm = $state(false);
  let delArmT;

  // Reset selected preset dropdown when switching to a different box - which
  // also stands down any half-finished save or armed delete.
  $effect(() => {
    box?.id;
    presetId = '';
    naming = false;
    delArm = false;
    clearTimeout(delArmT);
  });
  // The name field takes focus as it appears, so typing a name starts at once.
  $effect(() => {
    if (naming && presetNameEl) presetNameEl.focus();
  });
  // A preset is a look, not a placement: the same three keys paste-style leaves
  // alone stay alone here too, or picking a preset silently un-rotates and
  // un-mirrors a box that was placed by hand.
  const PRESET_SKIP = ['rotation', 'flipH', 'flipV'];
  function applyPreset(id) {
    presetId = id;
    const p = presets.list.find((x) => x.id === id);
    if (!p) return;
    const next = cloneStyle(p.style);
    for (const k of PRESET_SKIP) delete next[k];
    Object.assign(box.style, next);
    touch();
    // A picked tile from another chapter is written into this one.
    if (next.pattern.src && p.tile) void restorePickedTile(next.pattern.src, p.tile);
  }
  function startSavePreset() {
    presetName = presets.list.find((p) => p.id === presetId)?.name ?? '';
    delArm = false;
    clearTimeout(delArmT);
    naming = true;
  }
  function cancelSavePreset() {
    naming = false;
  }
  function confirmSavePreset() {
    const name = presetName.trim();
    if (!name) return;
    const entry = savePreset(name, box.style);
    if (entry) presetId = entry.id;
    naming = false;
  }
  function onPresetNameKey(e) {
    if (e.key === 'Enter') confirmSavePreset();
    else if (e.key === 'Escape') cancelSavePreset();
  }
  function onDeletePreset() {
    if (!presetId) return;
    if (!delArm) {
      delArm = true;
      clearTimeout(delArmT);
      delArmT = setTimeout(() => (delArm = false), 2500);
      return;
    }
    clearTimeout(delArmT);
    delArm = false;
    removePreset(presetId);
    presetId = '';
  }

  // What the box's text is laid out to, in words.
  function fitLabel(b) {
    // What layout reads: a found outline is laid out as the formula that
    // explains it (`layoutShape`).
    const f = layoutShape(normalizeFit(b.fit));
    if (!f) return 'Not fitted · rectangular layout';
    if (b.outline?.source === 'caption' || f.kind === 'rect') return 'Fitted · rectangular panel';
    if (f.kind === 'ellipse') return 'Fitted · oval balloon';
    return 'Fitted · balloon outline';
  }

  // The outline record, in words: who approved it, or how it was found and how
  // sure the finder was.
  const SOURCE_WORDS = {
    ring: 'inked outline',
    flood: 'filled interior',
    dark: 'dark bubble',
    caption: 'caption frame',
    fill: 'balloon fit',
    manual: 'drawn by hand',
    box: 'the box',
  };
  function outlineWords(b) {
    const st = outlineState(b);
    if (st === 'open') return 'No closed outline found';
    const o = b.outline;
    const how = o ? SOURCE_WORDS[o.source] ?? o.source : 'balloon fit';
    if (st === 'user') return `Approved · ${how}`;
    if (st === 'ai') return `Approved by AI · ${how}`;
    const sure = o && o.source !== 'manual' && o.source !== 'box' ? ` · ${Math.round(o.confidence * 100)}%` : '';
    return `Not approved · ${how}${sure}`;
  }

  // Deletion itself stays instant; the toast says how to take it back, which
  // is the feedback the silent undo record alone never gave a newcomer.
  function onDeleteBox() {
    const b = box;
    deleteBox(b.id);
    toast(
      isFreeBox(b)
        ? `Text box deleted · ${modKey()}Z to undo`
        : `Box deleted · line ${b.lineN} back to queue · ${modKey()}Z to undo`,
    );
  }

  const alignIcons = {
    left: ['M3 6h18', 'M3 12h12', 'M3 18h15'],
    center: ['M3 6h18', 'M6 12h12', 'M5 18h14'],
    right: ['M3 6h18', 'M9 12h12', 'M6 18h15'],
  };
  const valignIcons = {
    top: ['M4 6h16', 'M9 10h6v8h-6z'],
    middle: ['M4 12h16', 'M9 8h6v8h-6z'],
    bottom: ['M4 18h16', 'M9 6h6v8h-6z'],
  };
</script>

<!-- A heading inside a tab. Not a button any more - there is nothing left to
     collapse, because the tab already did the collapsing. -->
{#snippet shadowRows(list, inner)}
  {@const name = inner ? 'Inner shadow' : 'Shadow'}
  <div class="insp-list k-shadow">
    {#if list.length}
      <div class="insp-cap"><span></span><span>Angle</span><span>Dist</span><span>Size</span><span>Op %</span><span></span><span></span></div>
    {/if}
    {#each list as sh, i (sh)}
      <!-- The Global Light is read here so a turn of it shows. -->
      {@const angle = (app.typesetting.light?.angle, angleOf(sh))}
      {@const key = inner ? 'choke' : 'spread'}
      <div class="insp-row" class:inst-off={!instanceOn(sh)}>
        {@render swatchCell(sh, 'color', `${name} ${i + 1} colour`)}
        <input type="number" min="-180" max="180" step="1" value={angle} aria-label="{name} {i + 1} angle" title={sh.useGlobalLight ? 'Angle of the chapter\'s light, degrees: turns every shadow on it' : 'Angle the light comes from, degrees'} onchange={(e) => setShadowAngle(sh, e)} />
        <input type="number" min="0" max={SHADOW_DISTANCE_MAX} step="1" value={Math.round(shadowDistance(sh) * 100) / 100} aria-label="{name} {i + 1} distance" title="Distance, page px" onchange={(e) => setShadowDistance(sh, e)} />
        <input type="number" min="0" max={SHADOW_SIZE_MAX} step="1" value={sh.size} aria-label="{name} {i + 1} size" title="Size: how far the soft edge reaches, page px" onchange={(e) => commitNum(sh, 'size', e, 0, SHADOW_SIZE_MAX)} />
        <input type="number" min="0" max="100" step="1" value={pct(sh.opacity)} aria-label="{name} {i + 1} opacity" title="Opacity, %" oninput={(e) => setAlpha(sh, 'opacity', e.target.value)} />
        <FxMenu kind={inner ? 'innerShadow' : 'dropShadow'} name="{name} {i + 1}" onpick={(id) => fxPick(inner ? 'innerShadow' : 'dropShadow', sh, `${name} ${i + 1}`, id)} />
        {@render rmBtn(`${name.toLowerCase()} ${i + 1}`, () => (inner ? removeInnerShadow(i) : removeShadow(i)))}
      </div>
      {@render instanceBar(list, i, `${name} ${i + 1}`)}
      <div class="sh-more">
        <label class="sh-num" title="{inner ? 'Choke' : 'Spread'}: how much of the size is a hard edge, %">
          <span>{inner ? 'Choke' : 'Spread'}</span>
          <input type="number" min="0" max="100" step="1" value={pct(sh[key])} aria-label="{name} {i + 1} {key}, percent" onchange={(e) => commitAlpha(sh, key, e)} />
        </label>
        <label class="sh-num" title="Noise: grain in the shadow, %">
          <span>Noise</span>
          <input type="number" min="0" max="100" step="1" value={pct(sh.noise)} aria-label="{name} {i + 1} noise, percent" onchange={(e) => commitAlpha(sh, 'noise', e)} />
        </label>
        <label class="sh-contour" title="Contour: how the soft edge falls off">
          <span>Contour</span>
          <select value={sh.contour?.preset ?? 'linear'} aria-label="{name} {i + 1} contour" onchange={(e) => pickContour(sh, 'contour', e.target.value, `${name} ${i + 1} contour`)}>
            {#each CONTOUR_PRESETS as id (id)}
              <option value={id}>{CONTOUR_LABELS[id]}</option>
            {/each}
            <option value="custom">{CONTOUR_LABELS.custom}</option>
          </select>
          {@render contourEditBtn(`${name} ${i + 1} contour`, false)}
        </label>
        <label class="sh-check" title="Anti-aliased: carried to Photoshop; the engine does not paint it">
          <input type="checkbox" checked={sh.contour?.aa === true} aria-label="{name} {i + 1} contour anti-aliased" onchange={(e) => { sh.contour = { ...sh.contour, aa: e.target.checked }; touch(); }} />
          <span>Anti-aliased</span>
        </label>
        {@render contourPanel(sh, 'contour', `${name} ${i + 1} contour`)}
        <label class="sh-check" title="Use Global Light: the angle is the chapter's, shared by every shadow that uses it">
          <input type="checkbox" checked={sh.useGlobalLight} aria-label="{name} {i + 1} uses the global light" onchange={(e) => setShadowGlobal(sh, e.target.checked)} />
          <span>Global light</span>
        </label>
        {#if !inner}
          <label class="sh-check" title="Layer Knocks Out Drop Shadow: the shadow does not show through see-through letters">
            <input type="checkbox" checked={sh.knockout} aria-label="{name} {i + 1} knocked out by the letters" onchange={(e) => { sh.knockout = e.target.checked; touch(); }} />
            <span>Knock out</span>
          </label>
        {/if}
        <label class="sh-contour" title="Blend mode">
          <span>Mode</span>
          <select value={sh.blend} aria-label="{name} {i + 1} blend mode" onchange={(e) => { sh.blend = e.target.value; touch(); }}>
            {#each LAYER_BLEND_MODES as m (m)}
              <option value={m}>{blendLabel(m)}</option>
            {/each}
          </select>
        </label>
      </div>
    {/each}
  </div>
{/snippet}

<!-- Outer Glow or Inner Glow, as Photoshop's dialog has it: Structure, then
     Elements, then Quality. A colour, or a gradient run along the glow. -->
{#snippet glowControls(g, title, inner)}
  <div class="switch-row">
    <button
      type="button"
      class="switch"
      class:on={g.on}
      role="switch"
      aria-checked={g.on}
      aria-label={title}
      onclick={() => switchFx(inner ? 'innerGlow' : 'outerGlow', g)}
    ><span class="knob"></span></button>
    <span class="lbl2">{title}</span>
    <span class="fx-menu-end"><FxMenu kind={inner ? 'innerGlow' : 'outerGlow'} name={title} onpick={(id) => fxPick(inner ? 'innerGlow' : 'outerGlow', g, title, id)} /></span>
  </div>
  <div class="insp-sub-body" class:disabled={!g.on} style="padding:0;border:none;gap:11px">
    <div class="grp">
      <span class="lbl">Fill</span>
      <div class="seg">
        <button type="button" class:on={g.fill !== 'gradient'} aria-pressed={g.fill !== 'gradient'} disabled={!g.on} onclick={() => { g.fill = 'color'; touch(); }}>Colour</button>
        <button type="button" class:on={g.fill === 'gradient'} aria-pressed={g.fill === 'gradient'} disabled={!g.on} title="A gradient along the glow: its first stop at the letters' edge" onclick={() => { g.fill = 'gradient'; touch(); }}>Gradient</button>
      </div>
    </div>
    {#if g.fill === 'gradient'}
      {@render fxGradientControls(g.gradient, `${title} gradient`, false)}
    {:else}
      <div class="grp">
        <span class="lbl">Colour</span>
        {@render colorField(g, 'color', `${title} colour`)}
      </div>
    {/if}
    <div class="grp">
      <span class="lbl">Opacity</span>
      <div class="slider-row">
        <input type="range" min="0" max="100" step="1" value={pct(g.opacity)} disabled={!g.on} aria-label="{title} opacity" oninput={(e) => setAlpha(g, 'opacity', e.target.value)} />
        <input class="num-s" type="number" min="0" max="100" step="1" value={pct(g.opacity)} disabled={!g.on} title="Opacity, %" aria-label="{title} opacity, percent" onchange={(e) => commitAlpha(g, 'opacity', e)} />
      </div>
    </div>
    <div class="grp">
      <span class="lbl">Size</span>
      <div class="slider-row">
        <input type="range" min="0" max={SHADOW_SIZE_MAX} step="1" value={g.size} disabled={!g.on} aria-label="{title} size" oninput={(e) => setNum(g, 'size', e.target.value, 0, SHADOW_SIZE_MAX)} />
        <input class="num-s" type="number" min="0" max={SHADOW_SIZE_MAX} step="1" value={g.size} disabled={!g.on} title="How far the glow reaches, page px" aria-label="{title} size, page px" onchange={(e) => commitNum(g, 'size', e, 0, SHADOW_SIZE_MAX)} />
      </div>
    </div>
    <div class="sh-more" style="margin:0">
      <label class="sh-num" title="{inner ? 'Choke' : 'Spread'}: how much of the size is solid, %">
        <span>{inner ? 'Choke' : 'Spread'}</span>
        <input type="number" min="0" max="100" step="1" value={pct(g.spread)} disabled={!g.on} aria-label="{title} {inner ? 'choke' : 'spread'}, percent" onchange={(e) => commitAlpha(g, 'spread', e)} />
      </label>
      <label class="sh-num" title="Range: how much of the falloff the contour spans, %">
        <span>Range</span>
        <input type="number" min="1" max="100" step="1" value={pct(g.range)} disabled={!g.on} aria-label="{title} range, percent" onchange={(e) => { commitAlpha(g, 'range', e); if (g.range < 0.01) { g.range = 0.01; e.target.value = '1'; } }} />
      </label>
      <label class="sh-num" title="Noise: grain in the glow, %">
        <span>Noise</span>
        <input type="number" min="0" max="100" step="1" value={pct(g.noise)} disabled={!g.on} aria-label="{title} noise, percent" onchange={(e) => commitAlpha(g, 'noise', e)} />
      </label>
      <label class="sh-num" title="Softer blurs the edge; Precise keeps its shape">
        <span>Technique</span>
        <select value={g.technique} disabled={!g.on} aria-label="{title} technique" onchange={(e) => { g.technique = e.target.value; touch(); }}>
          <option value="softer">Softer</option>
          <option value="precise">Precise</option>
        </select>
      </label>
      {#if inner}
        <label class="sh-num" title="Glow from the letters' edge, or from their centre out">
          <span>Source</span>
          <select value={g.source} disabled={!g.on} aria-label="{title} source" onchange={(e) => { g.source = e.target.value; touch(); }}>
            <option value="edge">Edge</option>
            <option value="center">Center</option>
          </select>
        </label>
      {/if}
      <label class="sh-contour" title="Blend mode">
        <span>Mode</span>
        <select value={g.blend} disabled={!g.on} aria-label="{title} blend mode" onchange={(e) => { g.blend = e.target.value; touch(); }}>
          {#each LAYER_BLEND_MODES as m (m)}
            <option value={m}>{blendLabel(m)}</option>
          {/each}
        </select>
      </label>
      <label class="sh-contour" title="Contour: how the glow falls off">
        <span>Contour</span>
        <select value={g.contour?.preset ?? 'linear'} disabled={!g.on} aria-label="{title} contour" onchange={(e) => pickContour(g, 'contour', e.target.value, `${title} contour`)}>
          {#each CONTOUR_PRESETS as id (id)}
            <option value={id}>{CONTOUR_LABELS[id]}</option>
          {/each}
          <option value="custom">{CONTOUR_LABELS.custom}</option>
        </select>
        {@render contourEditBtn(`${title} contour`, !g.on)}
      </label>
      <label class="sh-check" title="Anti-aliased: carried to Photoshop; the engine does not paint it">
        <input type="checkbox" checked={g.contour?.aa === true} disabled={!g.on} aria-label="{title} contour anti-aliased" onchange={(e) => { g.contour = { ...g.contour, aa: e.target.checked }; touch(); }} />
        <span>Anti-aliased</span>
      </label>
      {@render contourPanel(g, 'contour', `${title} contour`)}
    </div>
    <!-- Quality > Jitter: scatters each pixel's colour along the gradient, so
         only a gradient glow has it (Photoshop greys it out on a colour). -->
    <div class="grp" title="Jitter: scatters the gradient's colours pixel by pixel, %">
      <span class="lbl">Jitter</span>
      <div class="slider-row">
        <input type="range" min="0" max="100" step="1" value={pct(g.jitter ?? 0)} disabled={!g.on || g.fill !== 'gradient'} aria-label="{title} jitter" oninput={(e) => setAlpha(g, 'jitter', e.target.value)} />
        <input class="num-s" type="number" min="0" max="100" step="1" value={pct(g.jitter ?? 0)} disabled={!g.on || g.fill !== 'gradient'} title="Jitter, % (gradient glows only)" aria-label="{title} jitter, percent" onchange={(e) => commitAlpha(g, 'jitter', e)} />
      </div>
    </div>
  </div>
{/snippet}

<!-- Photoshop's Satin, in its dialog's order: Blend Mode and colour,
     Opacity, Angle (its own: no Global Light), Distance, Size, Contour with
     Anti-aliased, Invert. The Rust engine paints it. -->
{#snippet satinControls(sa)}
  <div class="switch-row">
    <button
      type="button"
      class="switch"
      class:on={sa.on}
      role="switch"
      aria-checked={sa.on}
      aria-label="Satin"
      onclick={() => switchFx('satin', sa)}
    ><span class="knob"></span></button>
    <span class="lbl2">Satin</span>
    <span class="fx-menu-end"><FxMenu kind="satin" name="Satin" onpick={(id) => fxPick('satin', sa, 'Satin', id)} /></span>
  </div>
  <div class="insp-sub-body" class:disabled={!sa.on} style="padding:0;border:none;gap:11px">
    <div class="sh-more" style="margin:0">
      <label class="sh-contour" title="Blend mode">
        <span>Mode</span>
        <select value={sa.blend} disabled={!sa.on} aria-label="Satin blend mode" onchange={(e) => { sa.blend = e.target.value; touch(); }}>
          {#each LAYER_BLEND_MODES as m (m)}
            <option value={m}>{blendLabel(m)}</option>
          {/each}
        </select>
      </label>
    </div>
    <div class="grp">
      <span class="lbl">Colour</span>
      {@render colorField(sa, 'color', 'Satin colour')}
    </div>
    <div class="grp">
      <span class="lbl">Opacity</span>
      <div class="slider-row">
        <input type="range" min="0" max="100" step="1" value={pct(sa.opacity)} disabled={!sa.on} aria-label="Satin opacity" oninput={(e) => setAlpha(sa, 'opacity', e.target.value)} />
        <input class="num-s" type="number" min="0" max="100" step="1" value={pct(sa.opacity)} disabled={!sa.on} title="Opacity, %" aria-label="Satin opacity, percent" onchange={(e) => commitAlpha(sa, 'opacity', e)} />
      </div>
    </div>
    <div class="grp">
      <span class="lbl">Angle</span>
      <div class="slider-row">
        <input type="range" min="-180" max="180" step="1" value={sa.angle} disabled={!sa.on} aria-label="Satin angle" oninput={(e) => setNum(sa, 'angle', e.target.value, -180, 180)} />
        <input class="num-s" type="number" min="-180" max="180" step="1" value={sa.angle} disabled={!sa.on} title="Angle the two copies are thrown along, degrees: the box's own, not the chapter's light" aria-label="Satin angle, degrees" onchange={(e) => commitNum(sa, 'angle', e, -180, 180)} />
      </div>
    </div>
    <div class="grp">
      <span class="lbl">Distance</span>
      <div class="slider-row">
        <input type="range" min="0" max={SATIN_DISTANCE_MAX} step="1" value={sa.distance} disabled={!sa.on} aria-label="Satin distance" oninput={(e) => setNum(sa, 'distance', e.target.value, 0, SATIN_DISTANCE_MAX)} />
        <input class="num-s" type="number" min="0" max={SATIN_DISTANCE_MAX} step="1" value={sa.distance} disabled={!sa.on} title="How far each copy is thrown, page px (0 draws as 1, as Photoshop does)" aria-label="Satin distance, page px" onchange={(e) => commitNum(sa, 'distance', e, 0, SATIN_DISTANCE_MAX)} />
      </div>
    </div>
    <div class="grp">
      <span class="lbl">Size</span>
      <div class="slider-row">
        <input type="range" min="0" max={SHADOW_SIZE_MAX} step="1" value={sa.size} disabled={!sa.on} aria-label="Satin size" oninput={(e) => setNum(sa, 'size', e.target.value, 0, SHADOW_SIZE_MAX)} />
        <input class="num-s" type="number" min="0" max={SHADOW_SIZE_MAX} step="1" value={sa.size} disabled={!sa.on} title="How soft the copies are, page px" aria-label="Satin size, page px" onchange={(e) => commitNum(sa, 'size', e, 0, SHADOW_SIZE_MAX)} />
      </div>
    </div>
    <div class="sh-more" style="margin:0">
      <label class="sh-contour" title="Contour: Satin reads it from its far end, as Photoshop does">
        <span>Contour</span>
        <select value={sa.contour?.preset ?? 'linear'} disabled={!sa.on} aria-label="Satin contour" onchange={(e) => pickContour(sa, 'contour', e.target.value, 'Satin contour')}>
          {#each CONTOUR_PRESETS as id (id)}
            <option value={id}>{CONTOUR_LABELS[id]}</option>
          {/each}
          <option value="custom">{CONTOUR_LABELS.custom}</option>
        </select>
        {@render contourEditBtn('Satin contour', !sa.on)}
      </label>
      <label class="sh-check" title="Anti-aliased: carried to Photoshop; the engine does not paint it">
        <input type="checkbox" checked={sa.contour?.aa === true} disabled={!sa.on} aria-label="Satin contour anti-aliased" onchange={(e) => { sa.contour = { ...sa.contour, aa: e.target.checked }; touch(); }} />
        <span>Anti-aliased</span>
      </label>
      {@render contourPanel(sa, 'contour', 'Satin contour')}
      <label class="sh-check" title="Invert: lay the inverse of the gap between the copies">
        <input type="checkbox" checked={sa.invert} disabled={!sa.on} aria-label="Satin invert" onchange={(e) => { sa.invert = e.target.checked; touch(); }} />
        <span>Invert</span>
      </label>
    </div>
  </div>
{/snippet}

<!-- Photoshop's Bevel & Emboss, in its dialog's order: Structure (Style,
     Technique, Depth, Direction, Size, Soften), Shading (Angle and Altitude,
     on the Global Light or the box's own, Gloss Contour, Highlight and Shadow),
     then the Contour and Texture elements, each with its own switch. The Rust
     engine paints it. -->
{#snippet bevelControls(bv)}
  {@const lit = (app.typesetting.light, bevelLight(bv))}
  <div class="switch-row">
    <button
      type="button"
      class="switch"
      class:on={bv.on}
      role="switch"
      aria-checked={bv.on}
      aria-label="Bevel & Emboss"
      onclick={() => switchFx('bevel', bv)}
    ><span class="knob"></span></button>
    <span class="lbl2">Bevel & Emboss</span>
    <span class="fx-menu-end"><FxMenu kind="bevel" name="Bevel & Emboss" onpick={(id) => fxPick('bevel', bv, 'Bevel & Emboss', id)} /></span>
  </div>
  <div class="insp-sub-body" class:disabled={!bv.on} style="padding:0;border:none;gap:11px">
    {@render secHead('Structure')}
    <div class="sh-more" style="margin:0">
      <label class="sh-contour" title="Style: where the bevel is laid">
        <span>Style</span>
        <select value={bv.style} disabled={!bv.on} aria-label="Bevel style" onchange={(e) => { bv.style = e.target.value; touch(); }}>
          {#each BEVEL_STYLE_OPTIONS as [id, label] (id)}
            <option value={id}>{label}</option>
          {/each}
        </select>
      </label>
      <label class="sh-contour" title="Technique: a soft slope, or a cut edge">
        <span>Technique</span>
        <select value={bv.technique} disabled={!bv.on} aria-label="Bevel technique" onchange={(e) => { bv.technique = e.target.value; touch(); }}>
          {#each BEVEL_TECHNIQUE_OPTIONS as [id, label] (id)}
            <option value={id}>{label}</option>
          {/each}
        </select>
      </label>
    </div>
    {#if bv.style === 'stroke' && !box.style.strokeEffects?.length}
      <p class="nofill-note">Stroke Emboss bevels the Photoshop strokes (Stroke tab); this box has none.</p>
    {/if}
    <div class="grp">
      <span class="lbl">Depth</span>
      <div class="slider-row">
        <input type="range" min="0" max={BEVEL_DEPTH_MAX * 100} step="1" value={pct(bv.depth)} disabled={!bv.on} aria-label="Bevel depth" oninput={(e) => setNum(bv, 'depth', e.target.value / 100, 0, BEVEL_DEPTH_MAX)} />
        <input class="num-s" type="number" min="0" max={BEVEL_DEPTH_MAX * 100} step="1" value={pct(bv.depth)} disabled={!bv.on} title="Depth, %: how steep the slope is shaded" aria-label="Bevel depth, percent" onchange={(e) => commitPct(bv, 'depth', e, 0, BEVEL_DEPTH_MAX * 100)} />
      </div>
    </div>
    <div class="grp" role="radiogroup" aria-label="Bevel direction">
      <span class="lbl">Direction</span>
      <div class="sh-more" style="margin:0">
        {#each [['up', 'Up'], ['down', 'Down']] as [id, label] (id)}
          <label class="sh-check" title="Direction: {label}, which side the light falls on">
            <input type="radio" name="bevel-direction" value={id} checked={bv.direction === id} disabled={!bv.on} aria-label="Bevel direction {label}" onchange={() => { bv.direction = id; touch(); }} />
            <span>{label}</span>
          </label>
        {/each}
      </div>
    </div>
    <div class="grp">
      <span class="lbl">Size</span>
      <div class="slider-row">
        <input type="range" min="0" max={SHADOW_SIZE_MAX} step="1" value={bv.size} disabled={!bv.on} aria-label="Bevel size" oninput={(e) => setNum(bv, 'size', e.target.value, 0, SHADOW_SIZE_MAX)} />
        <input class="num-s" type="number" min="0" max={SHADOW_SIZE_MAX} step="1" value={bv.size} disabled={!bv.on} title="How wide the slope is, page px (0 draws as 1, as Photoshop does)" aria-label="Bevel size, page px" onchange={(e) => commitNum(bv, 'size', e, 0, SHADOW_SIZE_MAX)} />
      </div>
    </div>
    <div class="grp">
      <span class="lbl">Soften</span>
      <div class="slider-row">
        <input type="range" min="0" max={BEVEL_SOFTEN_MAX} step="1" value={bv.soften} disabled={!bv.on} aria-label="Bevel soften" oninput={(e) => setNum(bv, 'soften', e.target.value, 0, BEVEL_SOFTEN_MAX)} />
        <input class="num-s" type="number" min="0" max={BEVEL_SOFTEN_MAX} step="1" value={bv.soften} disabled={!bv.on} title="Blurs the shading, page px" aria-label="Bevel soften, page px" onchange={(e) => commitNum(bv, 'soften', e, 0, BEVEL_SOFTEN_MAX)} />
      </div>
    </div>

    {@render secHead('Shading')}
    <div class="sh-more" style="margin:0">
      <label class="sh-num" title={bv.useGlobalLight ? "Angle of the chapter's light, degrees: turns every shadow and bevel on it" : 'Angle the light comes from, degrees'}>
        <span>Angle</span>
        <input type="number" min="-180" max="180" step="1" value={lit.angle} disabled={!bv.on} aria-label="Bevel angle" onchange={(e) => setBevelLight(bv, 'angle', e, -180, 180)} />
      </label>
      <label class="sh-num" title={bv.useGlobalLight ? "Altitude of the chapter's light, degrees" : 'How high the light is, degrees: 90 is straight above'}>
        <span>Altitude</span>
        <input type="number" min="0" max="90" step="1" value={lit.altitude} disabled={!bv.on} aria-label="Bevel altitude" onchange={(e) => setBevelLight(bv, 'altitude', e, 0, 90)} />
      </label>
      <label class="sh-check" title="Use Global Light: the angle and altitude are the chapter's, shared by every shadow and bevel that uses it">
        <input type="checkbox" checked={bv.useGlobalLight} disabled={!bv.on} aria-label="Bevel uses the global light" onchange={(e) => setBevelGlobal(bv, e.target.checked)} />
        <span>Global light</span>
      </label>
    </div>
    <p class="nofill-note">The light turns with a turned or mirrored box, as the shadows do.</p>
    <div class="sh-more" style="margin:0">
      <label class="sh-contour" title="Gloss Contour: reshapes the shading">
        <span>Gloss</span>
        <select value={bv.gloss?.preset ?? 'linear'} disabled={!bv.on} aria-label="Bevel gloss contour" onchange={(e) => pickContour(bv, 'gloss', e.target.value, 'Bevel gloss contour')}>
          {#each CONTOUR_PRESETS as id (id)}
            <option value={id}>{CONTOUR_LABELS[id]}</option>
          {/each}
          <option value="custom">{CONTOUR_LABELS.custom}</option>
        </select>
        {@render contourEditBtn('Bevel gloss contour', !bv.on)}
      </label>
      <label class="sh-check" title="Anti-aliased gloss: carried to Photoshop; the engine does not paint it">
        <input type="checkbox" checked={bv.gloss?.aa === true} disabled={!bv.on} aria-label="Bevel gloss anti-aliased" onchange={(e) => { bv.gloss = { ...bv.gloss, aa: e.target.checked }; touch(); }} />
        <span>Anti-aliased</span>
      </label>
      {@render contourPanel(bv, 'gloss', 'Bevel gloss contour')}
    </div>
    {#each [['highlight', 'Highlight'], ['shadow', 'Shadow']] as [key, label] (key)}
      {@const sh = bv[key]}
      <div class="insp-row k-goverlay">
        {@render swatchCell(sh, 'color', `Bevel ${label.toLowerCase()} colour`)}
        <select value={sh.blend} disabled={!bv.on} aria-label="Bevel {label.toLowerCase()} mode" title="{label} mode" onchange={(e) => { sh.blend = e.target.value; touch(); }}>
          {#each LAYER_BLEND_MODES as m (m)}
            <option value={m}>{blendLabel(m)}</option>
          {/each}
        </select>
        <input type="number" min="0" max="100" step="1" value={pct(sh.opacity)} disabled={!bv.on} aria-label="Bevel {label.toLowerCase()} opacity" title="{label} opacity, %" onchange={(e) => commitAlpha(sh, 'opacity', e)} />
      </div>
    {/each}

    <div class="insp-rule"></div>
    <div class="switch-row">
      <button
        type="button"
        class="switch"
        class:on={bv.contour.on}
        role="switch"
        aria-checked={bv.contour.on}
        aria-label="Bevel contour"
        disabled={!bv.on}
        onclick={() => { bv.contour.on = !bv.contour.on; touch(); }}
      ><span class="knob"></span></button>
      <span class="lbl2">Contour</span>
    </div>
    {#if bv.contour.on}
      <div class="sh-more" style="margin:0">
        <label class="sh-contour" title="Contour: reshapes the bevel's slope">
          <span>Contour</span>
          <select value={bv.contour.curve?.preset ?? 'linear'} disabled={!bv.on} aria-label="Bevel contour curve" onchange={(e) => pickContour(bv.contour, 'curve', e.target.value, 'Bevel contour curve')}>
            {#each CONTOUR_PRESETS as id (id)}
              <option value={id}>{CONTOUR_LABELS[id]}</option>
            {/each}
            <option value="custom">{CONTOUR_LABELS.custom}</option>
          </select>
          {@render contourEditBtn('Bevel contour curve', !bv.on)}
        </label>
        <label class="sh-check" title="Anti-aliased: carried to Photoshop; the engine does not paint it">
          <input type="checkbox" checked={bv.contour.curve?.aa === true} disabled={!bv.on} aria-label="Bevel contour anti-aliased" onchange={(e) => { bv.contour.curve = { ...bv.contour.curve, aa: e.target.checked }; touch(); }} />
          <span>Anti-aliased</span>
        </label>
        {@render contourPanel(bv.contour, 'curve', 'Bevel contour curve')}
        <label class="sh-num" title="Range, %: kept and written to Photoshop; the engine does not paint it yet">
          <span>Range (not painted yet)</span>
          <input type="number" min="0" max="100" step="1" value={pct(bv.contour.range)} disabled={!bv.on} aria-label="Bevel contour range, percent" onchange={(e) => commitAlpha(bv.contour, 'range', e)} />
        </label>
      </div>
      <p class="nofill-note">In a PSD this curve is not written (Photoshop shows Linear); Range and Anti-aliased are.</p>
    {/if}

    <div class="switch-row">
      <button
        type="button"
        class="switch"
        class:on={bv.texture.on}
        role="switch"
        aria-checked={bv.texture.on}
        aria-label="Bevel texture"
        disabled={!bv.on}
        onclick={() => { bv.texture.on = !bv.texture.on; touch(); }}
      ><span class="knob"></span></button>
      <span class="lbl2">Texture</span>
    </div>
    {#if bv.texture.on}
      <div class="fx-block">
        {@render fxPatternControls(bv.texture.pattern, 'Bevel texture', 'bevel.texture.pattern')}
        <div class="sh-more" style="margin:0">
          <label class="sh-num" title="Scale, %: over the pattern's own">
            <span>Scale</span>
            <input type="number" min="1" max="1000" step="1" value={pct(bv.texture.scale)} disabled={!bv.on} aria-label="Bevel texture scale, percent" onchange={(e) => commitPct(bv.texture, 'scale', e, 1, 1000)} />
          </label>
          <label class="sh-num" title="Depth, %: how much the pattern raises the slope; below 0 it carves">
            <span>Depth</span>
            <input type="number" min={-BEVEL_DEPTH_MAX * 100} max={BEVEL_DEPTH_MAX * 100} step="1" value={pct(bv.texture.depth)} disabled={!bv.on} aria-label="Bevel texture depth, percent" onchange={(e) => commitPct(bv.texture, 'depth', e, -BEVEL_DEPTH_MAX * 100, BEVEL_DEPTH_MAX * 100)} />
          </label>
          <label class="sh-check" title="Invert: the pattern's light parts carve instead of raise">
            <input type="checkbox" checked={bv.texture.invert} disabled={!bv.on} aria-label="Bevel texture invert" onchange={(e) => { bv.texture.invert = e.target.checked; touch(); }} />
            <span>Invert</span>
          </label>
          <label class="sh-check" title="Link with Layer: the pattern moves with the box; off, it is fixed to the page">
            <input type="checkbox" checked={bv.texture.link} disabled={!bv.on} aria-label="Bevel texture linked with the box" onchange={(e) => { bv.texture.link = e.target.checked; touch(); }} />
            <span>Link with layer</span>
          </label>
        </div>
        <p class="nofill-note">A textured bevel goes into a PSD as pixels: Photoshop's pattern table cannot be written.</p>
      </div>
    {/if}
  </div>
{/snippet}

<!-- An effect gradient, as Photoshop's Gradient Overlay and Stroke take one:
     Style, Angle, Scale, Reverse, and its stops. `placed` false hides what a
     glow's gradient does not read (it runs along the glow). -->
{#snippet fxGradientControls(g, title, placed = true)}
  <div class="sh-more" style="margin:0">
    <label class="sh-contour" title="Gradient Type: Solid paints the stops; Noise paints a random ramp made from a seed">
      <span>Gradient Type</span>
      <select value={g.type} aria-label="{title} type" onchange={(e) => { g.type = e.target.value; touch(); }}>
        <option value="solid">Solid</option>
        <option value="noise">Noise</option>
      </select>
    </label>
  </div>
  {#if g.type === 'noise'}
    {@const n = g.noise}
    <div class="sh-more" style="margin:0">
      <label class="sh-num" title="Roughness, %: how many colour steps, and how sharp">
        <span>Roughness</span>
        <input type="number" min="0" max="100" step="1" value={pct(n.roughness)} aria-label="{title} roughness, percent" onchange={(e) => { const v = clamp(Math.round(+e.target.value || 0), 0, 100); n.roughness = v / 100; e.target.value = String(v); touch(); }} />
      </label>
      <label class="sh-num" title="Color Model: the channels the colours walk in">
        <span>Model</span>
        <select value={n.model} aria-label="{title} colour model" onchange={(e) => { n.model = e.target.value; touch(); }}>
          {#each NOISE_MODELS as m (m)}
            <option value={m}>{NOISE_MODEL_LABELS[m]}</option>
          {/each}
        </select>
      </label>
      {#each NOISE_CHANNELS[n.model] as ch, i (i)}
        <label class="sh-num" title="{ch} limit, low end, %">
          <span>{ch} min</span>
          <input type="number" min="0" max="100" step="1" value={pct(n.min[i])} aria-label="{title} {ch} limit low, percent" onchange={(e) => setNoiseLimit(n, 'min', i, e)} />
        </label>
        <label class="sh-num" title="{ch} limit, high end, %">
          <span>max</span>
          <input type="number" min="0" max="100" step="1" value={pct(n.max[i])} aria-label="{title} {ch} limit high, percent" onchange={(e) => setNoiseLimit(n, 'max', i, e)} />
        </label>
      {/each}
      <label class="sh-check" title="Restrict Colors: no oversaturated colours">
        <input type="checkbox" checked={n.restrict} aria-label="{title} restrict colours" onchange={(e) => { n.restrict = e.target.checked; touch(); }} />
        <span>Restrict Colors</span>
      </label>
      <label class="sh-check" title="Add Transparency: a random opacity too">
        <input type="checkbox" checked={n.transparency} aria-label="{title} add transparency" onchange={(e) => { n.transparency = e.target.checked; touch(); }} />
        <span>Add Transparency</span>
      </label>
    </div>
    <button type="button" class="add-btn" title="A new random seed: a new ramp from the same settings" aria-label="{title} randomize" onclick={() => randomizeNoise(n)}>Randomize</button>
  {:else}
    <div class="fx-ramp" style="background:{fxRamp(g)}" aria-hidden="true"></div>
    <div class="insp-list k-fxstop">
      {#each g.stops as st, i (st)}
        <div class="insp-row">
          {@render swatchCell(st, 'color', `${title} stop ${i + 1} colour`)}
          <input type="number" min="0" max="100" step="1" value={pct(st.pos)} aria-label="{title} stop {i + 1} position" title="Position along the gradient, %" oninput={(e) => setAlpha(st, 'pos', e.target.value)} onchange={() => sortFxStops(g)} />
          <input type="number" min="0" max="100" step="1" value={pct(st.opacity)} aria-label="{title} stop {i + 1} opacity" title="Opacity of this stop, %" oninput={(e) => setAlpha(st, 'opacity', e.target.value)} />
          {@render rmBtn(`${title.toLowerCase()} stop ${i + 1}`, () => removeFxStop(g, i), g.stops.length > GRADIENT_MIN_STOPS)}
        </div>
      {/each}
    </div>
    {#if g.stops.length < GRADIENT_MAX_STOPS}
      {@render addBtn('Add stop', () => addFxStop(g))}
    {/if}
  {/if}
  {#if placed}
    <div class="sh-more" style="margin:0">
      <label class="sh-contour" title="Style: the gradient's shape. Shape Burst runs from the edge in">
        <span>Style</span>
        <select value={g.style} aria-label="{title} style" onchange={(e) => { g.style = e.target.value; touch(); }}>
          {#each FX_GRADIENT_STYLES as st (st)}
            <option value={st}>{FX_STYLE_LABELS[st]}</option>
          {/each}
        </select>
      </label>
      <label class="sh-num" title="Angle, degrees: 90 runs bottom to top, as Photoshop's dial">
        <span>Angle</span>
        <input type="number" min="-180" max="180" step="1" value={g.angle} aria-label="{title} angle" onchange={(e) => commitNum(g, 'angle', e, -180, 180)} />
      </label>
      <label class="sh-num" title="Scale, %">
        <span>Scale</span>
        <input type="number" min="10" max="150" step="1" value={pct(g.scale)} aria-label="{title} scale, percent" onchange={(e) => { const v = clamp(+e.target.value || 100, 10, 150); g.scale = v / 100; e.target.value = String(v); touch(); }} />
      </label>
      <label class="sh-check" title="Reverse: the ramp the other way">
        <input type="checkbox" checked={g.reverse} aria-label="{title} reversed" onchange={(e) => { g.reverse = e.target.checked; touch(); }} />
        <span>Reverse</span>
      </label>
      <!-- Photoshop's Offset: moves the gradient's centre, % of the box. -->
      <label class="sh-num" title="Offset X: moves the gradient's centre sideways, % of the box">
        <span>Offset X</span>
        <input type="number" min="-100" max="100" step="1" value={pct(g.offset?.[0] ?? 0)} aria-label="{title} offset X, percent" onchange={(e) => setFxGradientOffset(g, 0, e)} />
      </label>
      <label class="sh-num" title="Offset Y: moves the gradient's centre down, % of the box">
        <span>Offset Y</span>
        <input type="number" min="-100" max="100" step="1" value={pct(g.offset?.[1] ?? 0)} aria-label="{title} offset Y, percent" onchange={(e) => setFxGradientOffset(g, 1, e)} />
      </label>
      <button type="button" class="add-btn" title="Put the gradient's centre back in the middle" aria-label="{title} reset offset" disabled={!g.offset?.[0] && !g.offset?.[1]} onclick={() => { g.offset = [0, 0]; touch(); }}>Reset</button>
    </div>
  {/if}
{/snippet}

<!-- A contour menu's Edit button, and the editor it opens under the row
     (ContourEditor): a custom curve drawn point by point. -->
{#snippet contourEditBtn(id, off)}
  <button type="button" class="ce-open" class:on={contourOpen === id} disabled={off} aria-label="{id}: edit the curve" aria-expanded={contourOpen === id} title="Edit the curve" onclick={() => (contourOpen = contourOpen === id ? null : id)}>Edit</button>
{/snippet}
{#snippet contourPanel(owner, key, id)}
  {#if contourOpen === id}
    <div class="ce-span">
      <ContourEditor contour={owner[key]} title={id[0].toUpperCase() + id.slice(1)} onchange={(c) => setContour(owner, key, c)} onclose={() => (contourOpen = null)} />
    </div>
  {/if}
{/snippet}

<!-- An effect's pattern: the fill's patterns, its two colours, its size and
     its turn. The finer controls stay the fill's own. -->
{#snippet fxPatternControls(p, title, path)}
  {@const pickable = rustPatterns && !!p.src && p.cell?.length > 0}
  <div class="sh-more" style="margin:0">
    <label class="sh-contour" title="Pattern">
      <span>Pattern</span>
      <select value={p.kind} aria-label="{title} kind" onchange={(e) => { p.kind = e.target.value; touch(); }}>
        {#each pickable ? [...PATTERN_KINDS, 'picked'] : PATTERN_KINDS as k (k)}
          <option value={k}>{patLabel(k)}</option>
        {/each}
      </select>
    </label>
    <label class="sh-num" title="Scale: the tile against the font size, % (Photoshop's 1 to 1000)">
      <span>Scale</span>
      <input type="number" min={PATTERN_SCALE_MIN * 100} max={PATTERN_SCALE_MAX * 100} step="1" value={pct(p.scale)} aria-label="{title} scale, percent" onchange={(e) => { const v = clamp(Math.round(+e.target.value) || 100, PATTERN_SCALE_MIN * 100, PATTERN_SCALE_MAX * 100); p.scale = v / 100; e.target.value = String(v); touch(); }} />
    </label>
    <label class="sh-num" title="Turns the pattern, degrees">
      <span>Angle</span>
      <input type="number" min="-180" max="180" step="1" value={p.angle} aria-label="{title} angle" onchange={(e) => commitNum(p, 'angle', e, -180, 180)} />
    </label>
    <label class="sh-num" title="Moves the tiles sideways, % of a tile (Phase)">
      <span>Offset X</span>
      <input type="number" min="0" max="100" step="1" value={pct(p.ox)} aria-label="{title} offset X, percent of a tile" onchange={(e) => commitAlpha(p, 'ox', e)} />
    </label>
    <label class="sh-num" title="Moves the tiles down, % of a tile (Phase)">
      <span>Offset Y</span>
      <input type="number" min="0" max="100" step="1" value={pct(p.oy)} aria-label="{title} offset Y, percent of a tile" onchange={(e) => commitAlpha(p, 'oy', e)} />
    </label>
    <span class="seg" role="group" aria-label="{title} tiles start at">
      <button type="button" class:on={p.anchor !== 'page'} aria-pressed={p.anchor !== 'page'} title="Each box starts its own tiles" onclick={() => { p.anchor = 'box'; touch(); }}>Box</button>
      <button type="button" class:on={p.anchor === 'page'} aria-pressed={p.anchor === 'page'} title="Tiles line up across boxes, from the page's corner (Link with Layer off)" onclick={() => { p.anchor = 'page'; touch(); }}>Page</button>
    </span>
    <!-- Photoshop's Snap to Origin: the tiles start on the box's corner, or
         the page's with Page on; the offset (Phase) goes back to 0. -->
    <button type="button" class="add-btn" title="Start the tiles on the {p.anchor === 'page' ? "page's" : "box's"} corner (Snap to Origin)" aria-label="{title} snap to origin" disabled={!p.ox && !p.oy} onclick={() => { p.ox = 0; p.oy = 0; touch(); }}>Snap to origin</button>
  </div>
  {#if rustPatterns && path}
    <div class="pat-pick">
      <button
        type="button"
        class="add-btn"
        class:on={patternPick.active && patternPick.target === path}
        disabled={patternPick.busy || !canPickPattern()}
        title="Drag over a tone on the page; it becomes this effect's pattern"
        aria-label="{title} pick from page"
        onclick={() => pickFromPage(path)}
      >{patternPick.busy ? 'Reading…' : patternPick.active && patternPick.target === path ? 'Drag on the page…' : 'Pick from page'}</button>
      {#if !pickable && box?.style.pattern?.src && box.style.pattern.cell?.length}
        <button type="button" class="add-btn" title="Use the tone the fill took from the page" aria-label="{title} use the fill's tone" onclick={() => usePickedTile(p, box.style.pattern)}>Use the fill's tone</button>
      {/if}
    </div>
    {#if p.kind === 'picked'}
      <div class="seg">
        <button type="button" class:on={p.mode === 'tone'} aria-pressed={p.mode === 'tone'} title="Recolour the tone with the two colours below" onclick={() => { p.mode = 'tone'; touch(); }}>Tone</button>
        <button type="button" class:on={p.mode === 'image'} aria-pressed={p.mode === 'image'} title="Keep the page's own greys" onclick={() => { p.mode = 'image'; touch(); }}>Image</button>
      </div>
    {/if}
  {/if}
  <div class="insp-row fx-pat-colours">
    {@render swatchCell(p, 'fg', `${title} ink`)}
    <span class="lbl">Ink</span>
    {@render swatchCell(p, 'bg', `${title} ground`)}
    <span class="lbl">Ground</span>
    <input type="number" min="0" max="100" step="1" value={pct(p.bgOpacity)} aria-label="{title} ground opacity" title="Ground opacity, %; 0 lets the letters show between" oninput={(e) => setAlpha(p, 'bgOpacity', e.target.value)} />
  </div>
{/snippet}

<!-- One Photoshop Stroke effect: Size, Position, Mode, Opacity, and what it
     is filled with. -->
{#snippet strokeEffectRows(k, i)}
  {@const name = `Photoshop stroke ${i + 1}`}
  <div class="fx-block" class:inst-off={!instanceOn(k)}>
    <div class="fx-head">
      <span class="lbl">Stroke {i + 1}</span>
      <span class="fx-head-end">
        <FxMenu kind="strokeEffect" name={name} onpick={(id) => fxPick('strokeEffect', k, name, id)} />
        {@render rmBtn(name.toLowerCase(), () => removeStrokeEffect(i))}
      </span>
    </div>
    {@render instanceBar(box.style.strokeEffects, i, name, true)}
    <div class="sh-more" style="margin:0">
      <label class="sh-num" title="Size, page px">
        <span>Size</span>
        <input type="number" min="0" max={SHADOW_SIZE_MAX} step="0.5" value={k.size} aria-label="{name} size" onchange={(e) => commitNum(k, 'size', e, 0, SHADOW_SIZE_MAX)} />
      </label>
      <label class="sh-contour" title="Position: outside the letters' edge, inside it, or half and half">
        <span>Position</span>
        <select value={k.position} aria-label="{name} position" onchange={(e) => { k.position = e.target.value; touch(); }}>
          {#each STROKE_POSITIONS as pos (pos)}
            <option value={pos}>{POSITION_LABELS[pos]}</option>
          {/each}
        </select>
      </label>
      <label class="sh-num" title="Opacity, %">
        <span>Opacity</span>
        <input type="number" min="0" max="100" step="1" value={pct(k.opacity)} aria-label="{name} opacity" oninput={(e) => setAlpha(k, 'opacity', e.target.value)} />
      </label>
      <label class="sh-contour" title="Blend mode">
        <span>Mode</span>
        <select value={k.blend} aria-label="{name} blend mode" onchange={(e) => { k.blend = e.target.value; touch(); }}>
          {#each LAYER_BLEND_MODES as m (m)}
            <option value={m}>{blendLabel(m)}</option>
          {/each}
        </select>
      </label>
    </div>
    <div class="seg">
      {#each [['color', 'Colour'], ['gradient', 'Gradient'], ['pattern', 'Pattern']] as [f, label] (f)}
        <button type="button" class:on={k.fill === f} aria-pressed={k.fill === f} aria-label="{name} fill: {label}" onclick={() => { k.fill = f; touch(); }}>{label}</button>
      {/each}
    </div>
    {#if k.fill === 'gradient'}
      {@render fxGradientControls(k.gradient, `${name} gradient`)}
    {:else if k.fill === 'pattern'}
      {@render fxPatternControls(k.pattern, `${name} pattern`, `strokeEffects.${i}.pattern`)}
    {:else}
      {@render colorField(k, 'color', `${name} colour`)}
    {/if}
  </div>
{/snippet}

{#snippet secHead(title)}
  <div class="insp-sec">{title}</div>
{/snippet}

<!-- Swatch + hex, the one colour idiom in the panel. The label is named by
     the caller, as `swatchCell` does for the list rows - three identical
     "Colour" inputs are three identical names to a screen reader. -->
<!-- The Rust pattern's controls (Fill::Screen). Every one defaults to the old
     look; the browser engine reads none of them, so they are shown only while
     the Rust engine paints. -->
{#snippet patternControls(s)}
  {@const p = s.pattern}
  <div class="grp">
    <span class="lbl">Ink</span>
    <div class="slider-row">
      <input type="range" min="0" max="100" step="1" value={pct(p.fgOpacity)} aria-label="Pattern opacity" oninput={(e) => setAlpha(p, 'fgOpacity', e.target.value)} />
      <input class="num-s" type="number" min="0" max="100" step="1" value={pct(p.fgOpacity)} title="Pattern opacity, %" aria-label="Pattern opacity, percent" onchange={(e) => commitAlpha(p, 'fgOpacity', e)} />
    </div>
  </div>
  <div class="grp">
    <span class="lbl">Ground</span>
    <div class="slider-row">
      <input type="range" min="0" max="100" step="1" value={pct(p.bgOpacity)} aria-label="Background opacity" oninput={(e) => setAlpha(p, 'bgOpacity', e.target.value)} />
      <input class="num-s" type="number" min="0" max="100" step="1" value={pct(p.bgOpacity)} title="Background opacity, %; 0 lets the page show between" aria-label="Background opacity, percent" onchange={(e) => commitAlpha(p, 'bgOpacity', e)} />
    </div>
  </div>
  <div class="grp">
    <span class="lbl">Density · {pct(p.density)}%</span>
    <div class="slider-row">
      <input type="range" min="0" max="100" step="1" value={pct(p.density)} aria-label="Pattern density" oninput={(e) => setAlpha(p, 'density', e.target.value)} />
      <input class="num-s" type="number" min="0" max="100" step="1" value={pct(p.density)} title="How much ink; 50% is the pattern as designed" aria-label="Pattern density, percent" onchange={(e) => commitAlpha(p, 'density', e)} />
    </div>
  </div>
  <div class="grp">
    <span class="lbl">Angle</span>
    <div class="slider-row">
      <input type="range" min="-180" max="180" step="1" value={p.angle} aria-label="Pattern angle" oninput={(e) => setNum(p, 'angle', e.target.value, -180, 180)} />
      <input class="num-s" type="number" min="-180" max="180" step="1" value={p.angle} title="Turns the pattern, degrees" aria-label="Pattern angle, degrees" onchange={(e) => commitNum(p, 'angle', e, -180, 180)} />
    </div>
  </div>
  <div class="grp">
    <span class="lbl">Stretch · {Number(p.aspect).toFixed(2)}×</span>
    <div class="slider-row">
      <input type="range" min="0.25" max="4" step="0.05" value={p.aspect} aria-label="Pattern stretch" oninput={(e) => setNum(p, 'aspect', e.target.value, 0.25, 4)} />
      <input class="num-s" type="number" min="0.25" max="4" step="0.05" value={p.aspect} title="Stretches the tile along its own width" aria-label="Pattern stretch, multiple" onchange={(e) => commitNum(p, 'aspect', e, 0.25, 4)} />
    </div>
  </div>
  <div class="grp">
    <span class="lbl">Offset X</span>
    <div class="slider-row">
      <input type="range" min="0" max="100" step="1" value={pct(p.ox)} aria-label="Pattern offset X" oninput={(e) => setAlpha(p, 'ox', e.target.value)} />
      <input class="num-s" type="number" min="0" max="100" step="1" value={pct(p.ox)} title="Moves the tiles sideways, % of a tile" aria-label="Pattern offset X, percent of a tile" onchange={(e) => commitAlpha(p, 'ox', e)} />
    </div>
  </div>
  <div class="grp">
    <span class="lbl">Offset Y</span>
    <div class="slider-row">
      <input type="range" min="0" max="100" step="1" value={pct(p.oy)} aria-label="Pattern offset Y" oninput={(e) => setAlpha(p, 'oy', e.target.value)} />
      <input class="num-s" type="number" min="0" max="100" step="1" value={pct(p.oy)} title="Moves the tiles down, % of a tile" aria-label="Pattern offset Y, percent of a tile" onchange={(e) => commitAlpha(p, 'oy', e)} />
    </div>
  </div>
  <div class="grp">
    <span class="lbl">Tiles start at</span>
    <div class="seg">
      <button type="button" class:on={p.anchor === 'box'} aria-pressed={p.anchor === 'box'} title="Each box starts its own tiles" onclick={() => { p.anchor = 'box'; touch(); }}>Box</button>
      <button type="button" class:on={p.anchor === 'page'} aria-pressed={p.anchor === 'page'} title="Tiles line up across boxes, from the page's corner" onclick={() => { p.anchor = 'page'; touch(); }}>Page</button>
    </div>
  </div>
  {#if SEEDED_PATTERN_KINDS.includes(p.kind)}
    <div class="grp">
      <label class="lbl" for="insp-pat-seed">Seed</label>
      <div class="slider-row">
        <input id="insp-pat-seed" class="num-s" type="number" min="1" max="9999" step="1" value={p.seed} title="Picks the random arrangement; same seed, same pattern" onchange={(e) => commitNum(p, 'seed', e, 1, 9999, true)} />
        <button type="button" class="add-btn" onclick={() => { p.seed = 1 + Math.floor(Math.random() * 9999); touch(); }}>Reshuffle</button>
      </div>
    </div>
  {/if}
  <div class="switch-row">
    <button
      type="button"
      class="switch"
      class:on={p.fade.on}
      role="switch"
      aria-checked={p.fade.on}
      aria-label="Fade"
      onclick={() => { p.fade.on = !p.fade.on; touch(); }}
    ><span class="knob"></span></button>
    <span class="lbl2">Fade</span>
  </div>
  <div class="insp-sub-body" class:disabled={!p.fade.on} style="padding:0;border:none;gap:11px">
    <div class="grp">
      <span class="lbl">Direction</span>
      <div class="slider-row">
        <input type="range" min="0" max="359" step="1" value={((p.fade.angle % 360) + 360) % 360} disabled={!p.fade.on} aria-label="Fade direction" oninput={(e) => setNum(p.fade, 'angle', e.target.value, 0, 359)} />
        <input class="num-s" type="number" min="0" max="359" step="1" value={((p.fade.angle % 360) + 360) % 360} disabled={!p.fade.on} title="Degrees, as a gradient's: 180 fades top to bottom" aria-label="Fade direction, degrees" onchange={(e) => commitNum(p.fade, 'angle', e, 0, 359)} />
      </div>
    </div>
    <div class="grp">
      <span class="lbl">Start</span>
      <div class="slider-row">
        <input type="range" min="0" max="100" step="1" value={pct(p.fade.from)} disabled={!p.fade.on} aria-label="Fade start" oninput={(e) => setAlpha(p.fade, 'from', e.target.value)} />
        <input class="num-s" type="number" min="0" max="100" step="1" value={pct(p.fade.from)} disabled={!p.fade.on} title="Full ink up to here, % across the box" aria-label="Fade start, percent" onchange={(e) => commitAlpha(p.fade, 'from', e)} />
      </div>
    </div>
    <div class="grp">
      <span class="lbl">End</span>
      <div class="slider-row">
        <input type="range" min="0" max="100" step="1" value={pct(p.fade.to)} disabled={!p.fade.on} aria-label="Fade end" oninput={(e) => setAlpha(p.fade, 'to', e.target.value)} />
        <input class="num-s" type="number" min="0" max="100" step="1" value={pct(p.fade.to)} disabled={!p.fade.on} title="No ink from here, % across the box" aria-label="Fade end, percent" onchange={(e) => commitAlpha(p.fade, 'to', e)} />
      </div>
    </div>
  </div>
{/snippet}

{#snippet colorField(obj, key, label = 'Colour')}
  <div class="color-field">
    <ColorPicker value={obj[key]} {label} size={24} unclipped onchange={(hex) => setColour(obj, key, hex)} />
    <input type="text" class="hex" value={obj[key]} aria-label="{label} hex" oninput={hexInput} onchange={(e) => setHex(obj, key, e.target.value, e.target)} />
  </div>
{/snippet}

<!-- The swatch on its own, for the compact list rows where the swatch and the
     hex field are two cells of the row's grid rather than a nested pair. -->
{#snippet swatchCell(obj, key, label)}
  <ColorPicker value={obj[key]} {label} size={24} unclipped onchange={(hex) => setColour(obj, key, hex)} />
{/snippet}

<!-- The one control that removes a list item. It closes every row, so the ×
     column is in the same place down the whole list. -->
{#snippet rmBtn(label, onRemove, canRemove = true)}
  <button type="button" class="icon-btn" title="Remove {label}" aria-label="Remove {label}" disabled={!canRemove} onclick={onRemove}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
  </button>
{/snippet}

<!-- One instance of a multi effect: its switch, then up, down and duplicate. -->
{#snippet instanceBar(list, i, name, flush = false)}
  {@const item = list[i]}
  <div class="fx-inst" class:flush>
    <label class="sh-check" title="On: switched off, it is kept and paints nothing">
      <input type="checkbox" checked={instanceOn(item)} aria-label="{name} on" onchange={(e) => setInstanceOn(item, e.target.checked)} />
      <span>On</span>
    </label>
    <span class="fx-inst-end">
      <button type="button" class="inst-btn" title="Move up: paints over the one above" aria-label="Move {name} up" disabled={i === 0} onclick={() => moveInstance(list, i, -1)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 15l6-6 6 6" /></svg>
      </button>
      <button type="button" class="inst-btn" title="Move down: paints under the one below" aria-label="Move {name} down" disabled={i >= list.length - 1} onclick={() => moveInstance(list, i, 1)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <button type="button" class="inst-btn" title={roomFor(list) ? 'Duplicate: the copy goes over it' : `At most ${FX_INSTANCES_MAX} of a kind`} aria-label="Duplicate {name}" disabled={!roomFor(list)} onclick={() => duplicateInstance(list, i)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
      </button>
    </span>
  </div>
{/snippet}

{#snippet addBtn(label, onAdd, canAdd = true)}
  <button type="button" class="add-btn" onclick={onAdd} disabled={!canAdd} title={canAdd ? null : `At most ${FX_INSTANCES_MAX} of a kind`}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
    {label}
  </button>
{/snippet}

<!-- The brush takes the whole body, ahead of the selection check: while the tool
     is armed the panel is the tool's options, and a letterer who has not clicked
     a box yet still needs the size slider. `.insp` is the frame the shared
     controls are laid out inside, so the panel keeps it. -->
{#if brushArmed()}
  <div class="insp"><BrushPanel /></div>
{:else if !box}
  <div class="insp-empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><path d="M12 4v16" /><path d="M9 20h6" /></svg>
    <div>No text box selected.<br />Click a box, or use the Text tool to add one.</div>
  </div>
{:else}
  {@const s = box.style}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- Capture phase, so the snapshot lands before any control's own handler
       mutates the style - see armSnap. -->
  <div class="insp" onpointerdowncapture={armSnap} onkeydowncapture={armSnap}>
    <div class="insp-tabs" role="tablist" aria-label="Text box options">
      {#each TABS as [id, label] (id)}
        <button
          type="button"
          role="tab"
          id="insp-tab-{id}"
          class="insp-tab"
          class:on={tab === id}
          aria-selected={tab === id}
          aria-controls="insp-pane-{id}"
          tabindex={tab === id ? 0 : -1}
          title={label}
          onclick={() => setTab(id)}
          onkeydown={(e) => onTabKey(e, id)}
        >
          {@html tabIcons[id]}
          <span>{label}</span>
        </button>
      {/each}
    </div>

    <!-- A locked box: said once, at the top, with the way out beside it. The
         tabs still switch, so its settings can be read; nothing below them
         can be changed (`inert`) until it is unlocked. -->
    {#if locked}
      <div class="insp-locked" role="status">
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
        <span>Locked. Unlock it to change anything.</span>
        <button type="button" class="rbtn" onclick={() => setBoxLocked(box.id, false)}>Unlock</button>
      </div>
    {/if}

    <div class="insp-body" class:locked inert={locked}>
    <!-- ===== Text ===== -->
    {#if tab === 'text'}
      <div class="insp-pane" role="tabpanel" id="insp-pane-text" aria-labelledby="insp-tab-text">
        <div class="grp">
          <label class="lbl" for="insp-text">Content {isFreeBox(box) ? '· free' : `· line ${box.lineN}`}</label>
          <textarea id="insp-text" value={boxText(box)} oninput={onTextInput} onkeydown={onTextKey} ondblclick={() => beginEdit(box.id)}></textarea>
        </div>
        <div class="grp">
          <label class="lbl" for="insp-font">Font</label>
          <!-- Moving through the list shows each family on the box; nothing is
               an edit until a click or Enter (FontPicker.svelte). -->
          <FontPicker
            id="insp-font"
            value={app.fontPreview?.boxId === box.id ? app.fontPreview.was : s.font}
            label="Font"
            onpreview={(name) => (name ? previewBoxFont(box, name) : endFontPreview())}
            onpick={pickFont}
          />
        </div>
        <!-- Size and the weight it is set in, side by side: they are one
             decision about the face, and they were three rows apart. -->
        <div class="row-size">
          <div class="field">
            <label class="lbl" for="insp-size">{sizing === 'fit' ? 'Max size' : 'Size'}</label>
            <div class="size-step">
              <button type="button" aria-label="Smaller" title="Smaller ({sizeKeys.down})" disabled={sizeNow <= SIZE_MIN} onclick={() => stepSize(-1)}>−</button>
              <input id="insp-size" type="number" min={SIZE_MIN} max={SIZE_MAX} step="1" value={sizeNow} title={sizing === 'fit' ? 'The most Fit to box may grow the text to, page px' : 'Type size, page px'} onchange={commitSize} onkeydown={sizeKey} />
              <span class="unit" aria-hidden="true">px</span>
              <button type="button" aria-label="Bigger" title="Bigger ({sizeKeys.up})" disabled={sizeNow >= SIZE_MAX} onclick={() => stepSize(1)}>+</button>
            </div>
            {#if sizing === 'fit'}<span class="size-now">Fits at {Math.round(s.size * 10) / 10} px</span>{/if}
          </div>
          <div class="field">
            <span class="lbl">Style</span>
            <div class="seg">
              <button type="button" class:on={s.bold} aria-pressed={s.bold} title="Bold" onclick={() => { s.bold = !s.bold; touch(); }}><b>B</b></button>
              <button type="button" class:on={s.italic} aria-pressed={s.italic} title="Italic" onclick={() => { s.italic = !s.italic; touch(); }}><i>I</i></button>
              <button type="button" class:on={s.uppercase} aria-pressed={s.uppercase} title="Uppercase" onclick={() => { s.uppercase = !s.uppercase; touch(); }}>TT</button>
              {#if engineSwitch.painting}
                <button type="button" class="more" class:on={styleMore} class:set={styleTuned(s)} aria-expanded={styleMore} aria-controls="insp-style-more" title={styleTuned(s) ? 'Bold weight and italic angle (set)' : 'Bold weight and italic angle'} onclick={() => (styleMore = !styleMore)}>⋯</button>
              {/if}
            </div>
          </div>
        </div>
        <!-- The fine end of B and I, folded away: how heavy the bold, how far
             the italic leans. Only the Rust painter draws them. A row shows
             while its switch is on; the fold's button carries a dot while a
             value is off its default, so nothing is set out of sight. -->
        {#if engineSwitch.painting && styleMore}
          <div class="style-more" id="insp-style-more">
            {#if s.bold}
              <div class="grp">
                <span class="lbl">Bold weight · {Math.round(s.boldWeight)}%</span>
                <div class="slider-row">
                  <input type="range" min={BOLD_WEIGHT_MIN} max={BOLD_WEIGHT_MAX} step="5" value={s.boldWeight} aria-label="Bold weight" oninput={(e) => setNum(s, 'boldWeight', e.target.value, BOLD_WEIGHT_MIN, BOLD_WEIGHT_MAX, true)} />
                  <input class="num-s" type="number" min={BOLD_WEIGHT_MIN} max={BOLD_WEIGHT_MAX} step="5" value={Math.round(s.boldWeight)} title="100% is the bold as the font draws it" aria-label="Bold weight, percent" onchange={(e) => commitNum(s, 'boldWeight', e, BOLD_WEIGHT_MIN, BOLD_WEIGHT_MAX, true)} />
                </div>
              </div>
            {/if}
            {#if s.italic}
              <div class="grp">
                <span class="lbl">Italic angle · {Math.round(s.italicAngle)}°</span>
                <div class="slider-row">
                  <input type="range" min={ITALIC_ANGLE_MIN} max={ITALIC_ANGLE_MAX} step="1" value={s.italicAngle} aria-label="Italic angle" oninput={(e) => setNum(s, 'italicAngle', e.target.value, ITALIC_ANGLE_MIN, ITALIC_ANGLE_MAX, true)} />
                  <input class="num-s" type="number" min={ITALIC_ANGLE_MIN} max={ITALIC_ANGLE_MAX} step="1" value={Math.round(s.italicAngle)} title="{ITALIC_ANGLE_DEF}° is the italic as the font draws it" aria-label="Italic angle, degrees" onchange={(e) => commitNum(s, 'italicAngle', e, ITALIC_ANGLE_MIN, ITALIC_ANGLE_MAX, true)} />
                </div>
              </div>
            {/if}
            {#if !s.bold && !s.italic}
              <p class="nofill-note">Turn on B or I to set its weight or angle.</p>
            {/if}
          </div>
        {/if}

        <div class="insp-rule"></div>

        <!-- The exact angle is typed, not read off the header, so the row keeps
             only the two quarter-turns and the reset. ±15 went: six buttons and
             a slider do not fit a 280px panel, and the number field does that
             job better than a button that only steps one way. -->
        <div class="grp">
          <span class="lbl ico">{@html iconRotate} Rotation</span>
          <div class="rot-row">
            <button type="button" class="rbtn" title="Rotate −90°" onclick={() => rotateBy(-90)}>−90</button>
            <input type="range" min="-180" max="180" step="1" value={s.rotation} aria-label="Rotation" oninput={(e) => setRotation(e.target.value)} />
            <button type="button" class="rbtn" title="Rotate +90°" onclick={() => rotateBy(90)}>+90</button>
            <input class="deg" type="number" min="-180" max="180" step="1" value={Math.round(s.rotation)} aria-label="Rotation, degrees" title="Rotation in degrees" onchange={(e) => commitNum(s, 'rotation', e, -180, 180, true)} />
            <button type="button" class="rbtn reset" title="Reset to 0°" onclick={() => setRotation(0)} disabled={Math.round(s.rotation) === 0}>0°</button>
          </div>
        </div>
      </div>
    {/if}

    <!-- ===== Fill ===== -->
    {#if tab === 'fill'}
      <div class="insp-pane" role="tabpanel" id="insp-pane-fill" aria-labelledby="insp-tab-fill">
        <div class="grp">
          <span class="lbl">Fill</span>
          <div class="seg">
            <button type="button" class="nofill" class:on={fillMode === 'none'} aria-pressed={fillMode === 'none'} title="No fill" aria-label="No fill" onclick={() => setFillMode('none')}>{@html iconNoFill}</button>
            {#each [['solid', 'Solid'], ['gradient', 'Gradient'], ['pattern', 'Pattern']] as [m, label] (m)}
              <button type="button" class:on={fillMode === m} aria-pressed={fillMode === m} onclick={() => setFillMode(m)}>{label}</button>
            {/each}
          </div>
        </div>

        {#if fillMode !== 'none'}
          <!-- Photoshop's Fill Opacity: the fill fades, the strokes and the
               shadows stay. The Rust engine paints it. -->
          <div class="grp">
            <span class="lbl" title="Fades the fill only: strokes and shadows stay">Fill opacity</span>
            {#if rustBoxes}
              <div class="slider-row">
                <input type="range" min="0" max="100" step="1" value={pct(s.fillOpacity)} aria-label="Fill opacity" oninput={(e) => setAlpha(s, 'fillOpacity', e.target.value)} />
                <input class="num-s" type="number" min="0" max="100" step="1" value={pct(s.fillOpacity)} title="Fill opacity, %" aria-label="Fill opacity, percent" onchange={(e) => commitAlpha(s, 'fillOpacity', e)} />
              </div>
            {:else}
              <p class="nofill-note">Needs the Rust text engine (Settings).</p>
            {/if}
          </div>
        {/if}
        {#if true}
          <!-- Photoshop's Color Overlay: a flat colour over the fill, in its
               own mode, under the strokes. The Rust engine paints it. -->
          {@render secHead('Colour overlays · first on top')}
          <div class="grp">
            {#if !s.colorOverlays.length}
              <div class="insp-none">No colour overlay.</div>
            {/if}
            <div class="insp-list k-overlay">
              {#each s.colorOverlays as o, i (o)}
                <div class="insp-row" class:inst-off={!instanceOn(o)}>
                  {@render swatchCell(o, 'color', `Overlay ${i + 1} colour`)}
                  <select value={o.blend} aria-label="Overlay {i + 1} blend mode" title="Blend mode" onchange={(e) => { o.blend = e.target.value; touch(); }}>
                    {#each LAYER_BLEND_MODES as m (m)}
                      <option value={m}>{blendLabel(m)}</option>
                    {/each}
                  </select>
                  <input type="number" min="0" max="100" step="1" value={pct(o.opacity)} aria-label="Overlay {i + 1} opacity" title="Opacity, %" oninput={(e) => setAlpha(o, 'opacity', e.target.value)} />
                  <FxMenu kind="colorOverlay" name="Overlay {i + 1}" onpick={(id) => fxPick('colorOverlay', o, `Overlay ${i + 1}`, id)} />
                  {@render rmBtn(`overlay ${i + 1}`, () => removeOverlay(i))}
                </div>
                {@render instanceBar(s.colorOverlays, i, `Overlay ${i + 1}`, true)}
              {/each}
            </div>
            {#if s.colorOverlays.length && !rustBoxes}
              <p class="nofill-note">Colour overlays need the Rust text engine (Settings).</p>
            {/if}
            {@render addBtn('Add colour overlay', addOverlay, roomFor(s.colorOverlays))}
          </div>
          <!-- Photoshop's Gradient Overlay and Pattern Overlay: under the
               colour overlays, over the fill. The Rust engine paints them. -->
          {@render secHead('Gradient overlays · first on top')}
          <div class="grp">
            {#if !s.gradientOverlays.length}
              <div class="insp-none">No gradient overlay.</div>
            {/if}
            {#each s.gradientOverlays as o, i (o)}
              <div class="fx-block" class:inst-off={!instanceOn(o)}>
                <div class="insp-row k-fxrow">
                  <select value={o.blend} aria-label="Gradient overlay {i + 1} blend mode" title="Blend mode" onchange={(e) => { o.blend = e.target.value; touch(); }}>
                    {#each LAYER_BLEND_MODES as m (m)}
                      <option value={m}>{blendLabel(m)}</option>
                    {/each}
                  </select>
                  <input type="number" min="0" max="100" step="1" value={pct(o.opacity)} aria-label="Gradient overlay {i + 1} opacity" title="Opacity, %" oninput={(e) => setAlpha(o, 'opacity', e.target.value)} />
                  <FxMenu kind="gradientOverlay" name="Gradient overlay {i + 1}" onpick={(id) => fxPick('gradientOverlay', o, `Gradient overlay ${i + 1}`, id)} />
                  {@render rmBtn(`gradient overlay ${i + 1}`, () => removeGradientOverlay(i))}
                </div>
                {@render instanceBar(s.gradientOverlays, i, `Gradient overlay ${i + 1}`, true)}
                {@render fxGradientControls(o.gradient, `Gradient overlay ${i + 1}`)}
              </div>
            {/each}
            {#if s.gradientOverlays.length && !rustBoxes}
              <p class="nofill-note">Gradient overlays need the Rust text engine (Settings).</p>
            {/if}
            {@render addBtn('Add gradient overlay', addGradientOverlay, roomFor(s.gradientOverlays))}
          </div>
          {@const po = s.patternOverlay}
          <div class="switch-row">
            <button
              type="button"
              class="switch"
              class:on={po.on}
              role="switch"
              aria-checked={po.on}
              aria-label="Pattern overlay"
              onclick={() => switchFx('patternOverlay', po)}
            ><span class="knob"></span></button>
            <span class="lbl2">Pattern overlay</span>
            <span class="fx-menu-end"><FxMenu kind="patternOverlay" name="Pattern overlay" onpick={(id) => fxPick('patternOverlay', po, 'Pattern overlay', id)} /></span>
          </div>
          {#if po.on}
            <div class="fx-block">
              <div class="insp-row k-goverlay">
                <select value={po.blend} aria-label="Pattern overlay blend mode" title="Blend mode" onchange={(e) => { po.blend = e.target.value; touch(); }}>
                  {#each LAYER_BLEND_MODES as m (m)}
                    <option value={m}>{blendLabel(m)}</option>
                  {/each}
                </select>
                <input type="number" min="0" max="100" step="1" value={pct(po.opacity)} aria-label="Pattern overlay opacity" title="Opacity, %" oninput={(e) => setAlpha(po, 'opacity', e.target.value)} />
              </div>
              {@render fxPatternControls(po.pattern, 'Pattern overlay', 'patternOverlay.pattern')}
              {#if !rustBoxes}
                <p class="nofill-note">The pattern overlay needs the Rust text engine (Settings).</p>
              {/if}
            </div>
          {/if}
        {/if}
        {#if fillMode === 'none'}
          <p class="nofill-note">{s.strokes.length ? 'The letters are see-through: their outlines and layer effects show, as a Photoshop layer at Fill 0 % does.' : 'No fill and no stroke: only the layer effects show. Add a stroke or an effect.'}</p>
        {:else if fillMode === 'solid'}
          <div class="grp">
            <span class="lbl">Colour</span>
            {@render colorField(s, 'color', 'Fill colour')}
          </div>
        {:else if fillMode === 'gradient'}
          <!-- The gradient, top to bottom in the order it is built: what shape
               it is, where it runs, where it stops, and what it looks like
               while you do it. -->
          <div class="seg">
            <button type="button" class="kbtn" class:on={s.gradient.kind !== 'radial'} aria-pressed={s.gradient.kind !== 'radial'} title="Linear gradient" onclick={() => setGradKind('linear')}>
              {@html iconGradientLinear}<span>Linear</span>
            </button>
            <button type="button" class="kbtn" class:on={s.gradient.kind === 'radial'} aria-pressed={s.gradient.kind === 'radial'} title="Radial gradient" onclick={() => setGradKind('radial')}>
              {@html iconGradientRadial}<span>Radial</span>
            </button>
          </div>

          <!-- The stop bar. The ramp, the handles that set it, and the one
               handle that is selected - and clicking anywhere on the bar that
               is not a handle puts a new one there. -->
          <div class="grad-edit" role="presentation" onpointerdown={onBarDown}>
            <div class="grad-bar">
              <!-- The ramp, not the bar around it, is what a pointer position is
                   measured against: it is the box the rail's handles are laid
                   out in, so the two are the same ruler down to the pixel. -->
              <div class="grad-ramp" bind:this={barEl} style="background-image:{barCss}"></div>
            </div>
            <div class="grad-rail">
              {#each s.gradient.stops as st, i (i)}
                <button
                  type="button"
                  class="gstop"
                  class:on={i === stopIdx}
                  style="left:{clamp(Number(st.pos) || 0, 0, 1) * 100}%;--stop-c:{st.color}"
                  title="Stop {i + 1} · {pct(st.pos)}% · drag to move, double-click or press Enter for colour"
                  aria-label="Stop {i + 1} at {pct(st.pos)} percent"
                  aria-pressed={i === stopIdx}
                  onpointerdown={(e) => onStopDown(e, i)}
                  onpointermove={onStopMove}
                  onpointerup={onStopUp}
                  onpointercancel={onStopUp}
                  ondblclick={(e) => openStopColour(e, i)}
                  onkeydown={(e) => onStopKey(e, i)}
                ></button>
              {/each}
            </div>
          </div>

          <!-- One stop's own fields. The list used to be here in full; a stop
               that is not selected has nothing to say that its handle is not
               already saying by sitting where it sits. -->
          {#if selStop}
            <!-- The caption sits above its fields, as it does in the Effects
                 lists; the columns are shared with the row below it. -->
            <div class="insp-cap grad-cap"><span></span><span></span><span class="left">Colour</span><span>Pos %</span><span>Op %</span><span></span><span></span></div>
            <div class="grad-sel">
              <span class="grad-n">{Math.min(stopIdx, s.gradient.stops.length - 1) + 1}/{s.gradient.stops.length}</span>
              <!-- The swatch snippet's own markup, spelled out here because this
                   one needs a handle on the picker: a double-click on a stop
                   opens it. -->
              <ColorPicker bind:this={stopPicker} value={selStop.color} label="Stop colour" size={24} unclipped onchange={(hex) => setColour(selStop, 'color', hex)} />
              <input type="text" class="hex" value={selStop.color} aria-label="Stop hex colour" oninput={hexInput} onchange={(e) => setHex(selStop, 'color', e.target.value, e.target)} />
              <input type="number" min="0" max="100" step="1" value={pct(selStop.pos)} aria-label="Stop position" title="Position along the gradient, %" oninput={(e) => setAlpha(selStop, 'pos', e.target.value)} onchange={() => sortStops()} />
              <input type="number" min="0" max="100" step="1" value={pct(selStop.opacity)} aria-label="Stop opacity" title="Opacity of this stop, %" oninput={(e) => setAlpha(selStop, 'opacity', e.target.value)} />
              <!-- The keyboard's add-a-stop, for whoever never found
                   click-the-empty-bar. It lands in the widest gap. -->
              <button
                type="button"
                class="icon-btn"
                title={s.gradient.stops.length >= GRADIENT_MAX_STOPS ? `At most ${GRADIENT_MAX_STOPS} stops` : 'Add a stop in the widest gap'}
                aria-label="Add gradient stop"
                disabled={s.gradient.stops.length >= GRADIENT_MAX_STOPS}
                onclick={addStopWidestGap}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              <button
                type="button"
                class="icon-btn"
                title={s.gradient.stops.length > 2 ? 'Delete this stop' : 'A gradient needs two stops'}
                aria-label="Delete stop"
                disabled={s.gradient.stops.length <= 2}
                onclick={() => removeStop(Math.min(stopIdx, s.gradient.stops.length - 1))}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13" /></svg>
              </button>
            </div>
          {/if}

          {#if s.gradient.kind === 'radial'}
            <!-- A style that reached the panel without going through
                 `normalizeStyle` (an old undo snapshot, a hand-edited file) has
                 no radius at all, and an empty number field is a worse answer
                 than the default the renderers would use for it anyway. -->
            {@const rad = Number.isFinite(+s.gradient.radius) ? +s.gradient.radius : 1}
            <div class="pad-row">
              <div class="dirpad" role="radiogroup" aria-label="Gradient centre">
                {#each CENTRES as c, i (i)}
                  {#if c}
                    <button
                      type="button"
                      role="radio"
                      class="cell"
                      class:on={near(s.gradient.cx, c.cx) && near(s.gradient.cy, c.cy)}
                      title={c.n}
                      aria-label="Centre {c.n.toLowerCase()}"
                      aria-checked={near(s.gradient.cx, c.cx) && near(s.gradient.cy, c.cy)}
                      onclick={() => setCentre(c)}
                    ><span class="cdot"></span></button>
                  {:else}
                    <span class="cell blank"></span>
                  {/if}
                {/each}
              </div>
              <div class="pad-side">
                <div class="field">
                  <label class="lbl" for="insp-grad-radius">Radius · {Math.round(rad * 100)}%</label>
                  <div class="slider-row">
                    <input id="insp-grad-radius" type="range" min="0.1" max="4" step="0.05" value={rad} aria-label="Radius" oninput={(e) => setNum(s.gradient, 'radius', e.target.value, 0.1, 4)} />
                  </div>
                  <input type="number" min="0.1" max="4" step="0.05" value={rad} title="How far the last stop is from the centre, as a multiple of the distance to the far corner" aria-label="Radius, multiple" oninput={(e) => setNum(s.gradient, 'radius', e.target.value, 0.1, 4)} />
                </div>
              </div>
            </div>
          {:else}
            <div class="pad-row">
              <div class="dirpad" role="radiogroup" aria-label="Gradient direction">
                {#each DIRS as d, i (i)}
                  {#if d}
                    <button
                      type="button"
                      role="radio"
                      class="cell"
                      class:on={Math.round(s.gradient.angle) % 360 === d.a}
                      title="{d.n} · {d.a}°"
                      aria-label="{d.n}, {d.a} degrees"
                      aria-checked={Math.round(s.gradient.angle) % 360 === d.a}
                      onclick={() => setAngle(d.a)}
                    ><span class="arrow" style="transform:rotate({d.a}deg)">{@html iconArrowUp}</span></button>
                  {:else}
                    <span class="cell mid">{Math.round(s.gradient.angle)}°</span>
                  {/if}
                {/each}
              </div>
              <div class="pad-side">
                <div class="field">
                  <label class="lbl" for="insp-grad-angle">Angle</label>
                  <input id="insp-grad-angle" type="number" min="0" max="360" step="5" value={Math.round(s.gradient.angle)} title="0° runs bottom to top, 90° left to right" oninput={(e) => setNum(s.gradient, 'angle', e.target.value, 0, 360, true)} />
                </div>
              </div>
            </div>
          {/if}

          <div class="grp">
            <span class="lbl">Spans</span>
            <div class="seg">
              <button type="button" class:on={s.gradient.scope === 'box'} aria-pressed={s.gradient.scope === 'box'} title="One gradient across the whole block" onclick={() => { s.gradient.scope = 'box'; touch(); }}>Box</button>
              <button type="button" class:on={s.gradient.scope === 'line'} aria-pressed={s.gradient.scope === 'line'} title="Restart the gradient on every line" onclick={() => { s.gradient.scope = 'line'; touch(); }}>Line</button>
            </div>
          </div>

        {:else}
          <div class="grp">
            <span class="lbl">Tile</span>
            {#if rustPatterns}
              <div class="seg" role="group" aria-label="Pattern group">
                {#each [['all', 'All'], ['tone', 'Tone'], ['lines', 'Lines'], ['action', 'Action'], ['shapes', 'Shapes']] as [g, label] (g)}
                  <button type="button" class:on={patGroup === g} aria-pressed={patGroup === g} onclick={() => (patGroup = g)}>{label}</button>
                {/each}
              </div>
            {/if}
            <div class="pat-grid" role="radiogroup" aria-label="Pattern">
              {#each shownKinds as k (k)}
                <button
                  type="button"
                  role="radio"
                  aria-checked={s.pattern.kind === k}
                  class="pat-card"
                  class:on={s.pattern.kind === k}
                  title={patLabel(k)}
                  onclick={() => setPatternKind(k)}
                >
                  {#if rustPatterns}
                    <span class="pat-tile" style="background-image:url({patternCards[k]});background-size:100% 100%"></span>
                  {:else}
                    <span class="pat-tile" style="background-image:url({patternCards[k]});background-size:{CARD_TILE}px {CARD_TILE}px"></span>
                  {/if}
                  <span class="pat-name">{patLabel(k)}</span>
                </button>
              {/each}
            </div>
            {#if !rustPatterns}
              <p class="pat-note">More patterns and controls need the Rust text engine (Settings).</p>
            {/if}
          </div>
          {#if rustPatterns}
            <div class="grp">
              <span class="lbl">From the page</span>
              <div class="pat-pick">
                {#if s.pattern.src && s.pattern.cell.length}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={s.pattern.kind === 'picked'}
                    class="pat-card"
                    class:on={s.pattern.kind === 'picked'}
                    title="The tone taken from the page"
                    onclick={() => setPatternKind('picked')}
                  >
                    <span class="pat-tile" style="background-image:url({patternCards.picked ?? ''});background-size:100% 100%"></span>
                    <span class="pat-name">{patLabel('picked')}</span>
                  </button>
                {/if}
                <button
                  type="button"
                  class="add-btn"
                  class:on={patternPick.active}
                  disabled={patternPick.busy || !canPickPattern()}
                  title="Drag over a tone on the page; it becomes this box's pattern"
                  onclick={() => pickFromPage()}
                >{patternPick.busy ? 'Reading…' : patternPick.active ? 'Drag on the page…' : 'Pick from page'}</button>
              </div>
              <div class="switch-row">
                <button
                  type="button"
                  class="switch"
                  class:on={patternPick.raw}
                  role="switch"
                  aria-checked={patternPick.raw}
                  aria-label="Read the raw page"
                  onclick={() => (patternPick.raw = !patternPick.raw)}
                ><span class="knob"></span></button>
                <span class="lbl2" title="Cleaning often takes the tone away; the raw page still has it">Read the raw page</span>
              </div>
              {#if s.pattern.kind === 'picked'}
                <div class="seg">
                  <button type="button" class:on={s.pattern.mode === 'tone'} aria-pressed={s.pattern.mode === 'tone'} title="Recolour the tone with the two colours below" onclick={() => { s.pattern.mode = 'tone'; touch(); }}>Tone</button>
                  <button type="button" class:on={s.pattern.mode === 'image'} aria-pressed={s.pattern.mode === 'image'} title="Keep the page's own greys" onclick={() => { s.pattern.mode = 'image'; touch(); }}>Image</button>
                </div>
              {/if}
            </div>
          {/if}
          <div class="grp">
            <span class="lbl">Scale · {Number(s.pattern.scale).toFixed(2)}×</span>
            <!-- The slider spans the usual 0.25..4; the field takes all that
                 normalizePattern keeps (PATTERN_SCALE_MIN..MAX, 1-1000 %). -->
            <div class="slider-row">
              <input type="range" min="0.25" max="4" step="0.05" value={s.pattern.scale} aria-label="Pattern scale" oninput={(e) => setNum(s.pattern, 'scale', e.target.value, 0.25, 4)} />
              <input class="num-s" type="number" min={PATTERN_SCALE_MIN} max={PATTERN_SCALE_MAX} step="0.05" value={s.pattern.scale} title="Tile size, relative to the font size" aria-label="Pattern scale, multiple" oninput={(e) => setNum(s.pattern, 'scale', e.target.value, PATTERN_SCALE_MIN, PATTERN_SCALE_MAX)} />
            </div>
          </div>
          <div class="row2">
            <div class="field">
              <span class="lbl">Pattern</span>
              {@render colorField(s.pattern, 'fg', 'Pattern colour')}
            </div>
            <div class="field">
              <span class="lbl">Background</span>
              {@render colorField(s.pattern, 'bg', 'Background colour')}
            </div>
          </div>
          {#if rustPatterns}
            {@render patternControls(s)}
          {/if}
        {/if}

        <div class="insp-rule"></div>

        <div class="grp">
          <span class="lbl">Opacity</span>
          <div class="slider-row">
            <input type="range" min="0" max="100" step="1" value={pct(s.opacity)} aria-label="Opacity" oninput={(e) => setAlpha(s, 'opacity', e.target.value)} />
            <input class="num-s" type="number" min="0" max="100" step="1" value={pct(s.opacity)} title="Opacity, %" aria-label="Opacity, percent" onchange={(e) => commitAlpha(s, 'opacity', e)} />
          </div>
        </div>

        <!-- Photoshop's Blending Options: the box's mode over the page art,
             and Blend Interior Effects as Group. The Rust engine paints them
             (LAYER_STYLES_PLAN.md phase 6a). -->
        <div class="grp">
          <div class="fx-head">
            <span class="lbl" title="How the box mixes with the page art under it">Blend mode</span>
          </div>
          {#if rustBoxes}
            <select value={s.blendMode} aria-label="Box blend mode" title="Blend mode" onchange={(e) => { s.blendMode = e.target.value; touch(); }}>
              {#each LAYER_BLEND_MODES as m (m)}
                <option value={m}>{blendLabel(m)}</option>
              {/each}
            </select>
            {#if FILL_SPECIAL_MODES.includes(s.blendMode) && s.fillOpacity < 1}
              <p class="nofill-note">Fill works as in Photoshop for this mode: it changes the blend, not the coverage.</p>
            {/if}
            {@const inner = s.colorOverlays?.some(instanceOn) || s.gradientOverlays?.some(instanceOn) || s.patternOverlay?.on || s.satin?.on || s.innerGlow?.on}
            <!-- Advanced Blending, in Photoshop's order: Channels, Knockout,
                 Blend Interior Effects as Group, Blend Clipped Layers as
                 Group, Transparency Shapes Layer, Vector Mask Hides Effects,
                 Blend If (phase 6b). -->
            <div class="fx-head">
              <span class="lbl" title="Channels, Knockout, the group and shape options and Blend If">Advanced blending</span>
              <FxMenu kind="blending" name="Advanced blending" onpick={(id) => fxPick('blending', s.blending, 'Advanced blending', id)} />
            </div>
            <div class="blend-chans" role="group" aria-label="Channels" title="Channels: a channel left out shows the page art's">
              <span class="lbl">Channels</span>
              {#each [['r', 'R'], ['g', 'G'], ['b', 'B']] as [k, name] (k)}
                <label class="sh-check">
                  <input type="checkbox" checked={s.blending?.channels?.[k] !== false} aria-label="Channel {name}" onchange={(e) => setChannel(s, k, e.target.checked)} />
                  <span>{name}</span>
                </label>
              {/each}
            </div>
            <!-- Knockout is stored and written to the PSD, not painted: a box
                 blends with the page art only, never with the boxes under it
                 (user decision, phase 6c). -->
            <label class="sh-contour" title="Knockout: written to the PSD for Photoshop. Not painted here: a box blends with the page art only, never with the boxes under it">
              <span>Knockout</span>
              <select value={s.blending?.knockout ?? 'none'} aria-label="Knockout" onchange={(e) => setKnockout(s, e.target.value)}>
                {#each KNOCKOUT_MODES as k (k)}
                  <option value={k}>{KNOCKOUT_LABEL[k]}</option>
                {/each}
              </select>
            </label>
            <label class="sh-check" title="Blend Interior Effects as Group: Fill opacity also fades the overlays, the satin and the inner glow">
              <input type="checkbox" checked={s.blending?.interior === true} disabled={!inner} aria-label="Blend interior effects as group" onchange={(e) => { s.blending = { ...s.blending, interior: e.target.checked }; touch(); }} />
              <span>Blend interior effects as group</span>
            </label>
            <label class="sh-check" title="Blend Clipped Layers as Group: written to the PSD for Photoshop. A box has no layers clipped to it, so it changes nothing here">
              <input type="checkbox" checked={blendingSwitch(s.blending, 'blendClipped')} aria-label="Blend clipped layers as group" onchange={(e) => setBlendingSwitch(s, 'blendClipped', e.target.checked)} />
              <span>Blend clipped layers as group</span>
            </label>
            <label class="sh-check" title="Transparency Shapes Layer: off, a fill in Color Burn, Linear Burn, Color Dodge, Linear Dodge, Vivid Light, Linear Light, Hard Mix or Difference blends its own see-through edges as Fill does. Written to the PSD; in Photoshop the effects then cover the whole layer, here they stay on the letters">
              <input type="checkbox" checked={blendingSwitch(s.blending, 'transparencyShapes')} aria-label="Transparency shapes layer" onchange={(e) => setBlendingSwitch(s, 'transparencyShapes', e.target.checked)} />
              <span>Transparency shapes layer</span>
            </label>
            <label class="sh-check" title="Vector Mask Hides Effects: kept with the box only. A box has no vector mask, and the PSD writer cannot write this option">
              <input type="checkbox" checked={blendingSwitch(s.blending, 'vectorMaskHidesEffects')} aria-label="Vector mask hides effects" onchange={(e) => setBlendingSwitch(s, 'vectorMaskHidesEffects', e.target.checked)} />
              <span>Vector mask hides effects</span>
            </label>
            <div class="blend-if">
              <div class="blend-if-head">
                <span class="lbl" title="Blend If: hide the box where its own colour, or the page art's under it, is outside the sliders">Blend If</span>
                <select value={blendIfChannel} aria-label="Blend If channel" onchange={(e) => (blendIfChannel = e.target.value)}>
                  {#each BLEND_IF_CHANNELS as c (c)}
                    <option value={c}>{BLEND_IF_LABEL[c]}</option>
                  {/each}
                </select>
              </div>
              <!-- A split set by hand belongs to one box's one channel. -->
              {#key `${app.selectedId}|${blendIfChannel}`}
                {#each [['this', 'This Layer'], ['under', 'Underlying Layer']] as [side, name] (side)}
                  <BlendRangeSlider
                    label={name}
                    channel={blendIfChannel}
                    value={s.blending?.blendIf?.[blendIfChannel]?.[side] ?? BLEND_RANGE_FULL}
                    onchange={(r) => setBlendIf(s, blendIfChannel, side, r)}
                  />
                {/each}
              {/key}
            </div>
            {#if usesBackdrop(s)}
              <p class="nofill-note">Blends with the page art.</p>
            {/if}
          {:else}
            <p class="nofill-note">Needs the Rust text engine (Settings).</p>
          {/if}
        </div>
      </div>
    {/if}

    <!-- ===== Effects ===== -->
    {#if tab === 'effects'}
      <div class="insp-pane" role="tabpanel" id="insp-pane-effects" aria-labelledby="insp-tab-effects">
        <div class="sub-tabs" role="tablist" aria-label="Effects options">
          {#each EFFECTS_TABS as [id, label] (id)}
            <button
              type="button"
              role="tab"
              id="insp-subtab-{id}"
              class="sub-tab"
              class:on={effectsTab === id}
              aria-selected={effectsTab === id}
              aria-label={label}
              tabindex={effectsTab === id ? 0 : -1}
              title={label}
              onclick={() => setEffectsSubTab(id)}
              onkeydown={(e) => onSubTabKey(e, id)}
            >
              {@html effectsSubTabIcons[id]}
            </button>
          {/each}
        </div>

        {#if effectsTab === 'stroke'}
          <!-- Strokes: innermost first, which is also the order they are listed. -->
          {@render secHead('Strokes · inner to outer')}
          <div class="grp">
            {#if !s.strokes.length}
              <div class="insp-none">No stroke.</div>
            {/if}
            <div class="insp-list k-stroke">
              {#if s.strokes.length}
                <div class="insp-cap"><span></span><span class="left">Colour</span><span>Width</span><span>Op %</span><span></span></div>
              {/if}
              {#each s.strokes as k, i (k)}
                <div class="insp-row">
                  {@render swatchCell(k, 'color', `Stroke ${i + 1} colour`)}
                  <input type="text" class="hex" value={k.color} aria-label="Stroke {i + 1} hex colour" oninput={hexInput} onchange={(e) => setHex(k, 'color', e.target.value, e.target)} />
                  <input type="number" min="0.5" max="40" step="0.5" value={k.width} aria-label="Stroke {i + 1} width" title="Visible band width, page px" oninput={(e) => setNum(k, 'width', e.target.value, 0.5, 40)} />
                  <input type="number" min="0" max="100" step="1" value={pct(k.opacity)} aria-label="Stroke {i + 1} opacity" title="Opacity, %" oninput={(e) => setAlpha(k, 'opacity', e.target.value)} />
                  {@render rmBtn(`stroke ${i + 1}`, () => removeStroke(i))}
                </div>
              {/each}
            </div>
            {@render addBtn('Add stroke', addStroke)}
          </div>
          <!-- Photoshop's Stroke effect, under the outlines above: Outside,
               Inside or Center, filled with a colour, a gradient or a
               pattern. The Rust engine paints it. -->
          {@render secHead('Photoshop strokes · first on top')}
          <div class="grp">
            {#if !s.strokeEffects.length}
              <div class="insp-none">No Photoshop stroke.</div>
            {/if}
            {#each s.strokeEffects as k, i (k)}
              {@render strokeEffectRows(k, i)}
            {/each}
            {#if s.strokeEffects.length && !rustBoxes}
              <p class="nofill-note">Photoshop strokes need the Rust text engine (Settings).</p>
            {/if}
            {@render addBtn('Add Photoshop stroke', addStrokeEffect, roomFor(s.strokeEffects))}
          </div>
        {/if}

        {#if effectsTab === 'shadow'}
          <!-- Shadows: the first one is painted on top of the rest. -->
          {@render secHead('Shadows · first on top')}
          <div class="grp">
            {#if !s.shadows.length}
              <div class="insp-none">No shadow.</div>
            {/if}
            {@render shadowRows(s.shadows, false)}
            {#if s.shadows.length && !rustBoxes}
              <p class="nofill-note">Spread, Noise, Contour and Knock out need the Rust text engine (Settings).</p>
            {/if}
            {@render addBtn('Add shadow', addShadow, roomFor(s.shadows))}
          </div>
          <!-- Inner shadows: thrown from outside the letters into them. -->
          {@render secHead('Inner shadows · first on top')}
          <div class="grp">
            {#if !s.innerShadows.length}
              <div class="insp-none">No inner shadow.</div>
            {/if}
            {@render shadowRows(s.innerShadows, true)}
            {#if s.innerShadows.length && !rustBoxes}
              <p class="nofill-note">Inner shadows need the Rust text engine (Settings).</p>
            {/if}
            {@render addBtn('Add inner shadow', addInnerShadow, roomFor(s.innerShadows))}
          </div>
        {/if}

        {#if effectsTab === 'glow'}
          {#if !rustBoxes}
            <p class="nofill-note">Glows and Satin need the Rust text engine (Settings).</p>
          {/if}
          {@render glowControls(s.outerGlow, 'Outer glow', false)}
          <div class="insp-rule"></div>
          {@render glowControls(s.innerGlow, 'Inner glow', true)}
          <div class="insp-rule"></div>
          {@render satinControls(s.satin)}
        {/if}

        {#if effectsTab === 'bevel'}
          {#if !rustBoxes}
            <p class="nofill-note">Bevel & Emboss needs the Rust text engine (Settings).</p>
          {/if}
          {@render bevelControls(s.bevel)}
        {/if}

        {#if effectsTab === 'warp'}
          <div class="grp">
            <span class="lbl" title="Bend the baseline upward/downward">Arc</span>
            <div class="slider-row">
              <input type="range" min="-100" max="100" step="1" value={s.curve} disabled={s.path.on || s.circle.on} title={s.path.on || s.circle.on ? 'Curve path or Circle is on; they override Arc' : undefined} aria-label="Arc" oninput={(e) => { if (+e.target.value) sfxOff(s); setNum(s, 'curve', e.target.value, -100, 100); }} />
              <input class="num-s" type="number" min="-100" max="100" step="1" value={s.curve} disabled={s.path.on || s.circle.on} title={s.path.on || s.circle.on ? 'Curve path or Circle is on; they override Arc' : 'Bend the baseline upward/downward'} aria-label="Arc, amount" onchange={(e) => { if (+e.target.value) sfxOff(s); commitNum(s, 'curve', e, -100, 100); }} />
            </div>
          </div>
          <div class="insp-rule"></div>
          <div class="switch-row">
            <button
              type="button"
              class="switch"
              class:on={s.circle.on}
              role="switch"
              aria-checked={s.circle.on}
              aria-label="Circle"
              onclick={() => {
                s.circle.on = !s.circle.on;
                if (s.circle.on) {
                  s.path.on = false;
                  sfxOff(s);
                }
                touch();
              }}
            ><span class="knob"></span></button>
            <span class="lbl2">Circle</span>
          </div>
          <div class="insp-sub-body" class:disabled={!s.circle.on} style="padding:0;border:none;gap:11px">
            <div class="grp">
              <span class="lbl">Angle</span>
              <div class="slider-row">
                <input type="range" min="0" max="359" step="1" value={s.circle.angle} disabled={!s.circle.on} title="Turns the ring, degrees" aria-label="Angle" oninput={(e) => setNum(s.circle, 'angle', e.target.value, 0, 359)} />
                <input class="num-s" type="number" min="0" max="359" step="1" value={s.circle.angle} disabled={!s.circle.on} title="Turns the ring, degrees" aria-label="Angle, degrees" onchange={(e) => commitNum(s.circle, 'angle', e, 0, 359)} />
              </div>
            </div>
            <div class="grp">
              <span class="lbl">Radius</span>
              <div class="slider-row">
                <input type="range" min="0" max="600" step="1" value={Math.min(600, s.circle.r)} disabled={!s.circle.on} title="Ring radius in px. 0 fits the ring to the text; any other value holds the size and the text runs as far round as it reaches." aria-label="Radius" oninput={(e) => setNum(s.circle, 'r', e.target.value, 0, 4000)} />
                <input class="num-s" type="number" min="0" max="4000" step="1" value={s.circle.r} disabled={!s.circle.on} title="0 = auto (fit the ring to the text)" aria-label="Radius, px" onchange={(e) => commitNum(s.circle, 'r', e, 0, 4000)} />
              </div>
            </div>
            <div class="switch-row">
              <button
                type="button"
                class="switch"
                class:on={s.circle.inside}
                role="switch"
                aria-checked={s.circle.inside}
                aria-label="Inside (badge bottom)"
                onclick={() => {
                  if (!s.circle.on) return;
                  s.circle.inside = !s.circle.inside;
                  touch();
                }}
              ><span class="knob"></span></button>
              <span class="lbl2">Inside (badge bottom)</span>
            </div>
          </div>
          <div class="insp-rule"></div>
          <div class="switch-row">
            <button
              type="button"
              class="switch"
              class:on={s.path.on}
              role="switch"
              aria-checked={s.path.on}
              aria-label="Curve path"
              onclick={() => {
                s.path.on = !s.path.on;
                if (s.path.on) {
                  s.circle.on = false;
                  sfxOff(s);
                }
                if (s.path.on && s.path.pts.length < 2) s.path.pts = defaultPathPts(box.w, box.h);
                touch();
              }}
            ><span class="knob"></span></button>
            <span class="lbl2">Curve path</span>
          </div>
          {#if s.path.on}
            <div class="insp-none">Drag the red anchors and square handles on the box. Right-click an anchor to remove it.</div>
            {@render addBtn('Add anchor', () => { s.path.pts = insertPathAnchor(s.path.pts); touch(); })}
            {@render addBtn('Reset path', () => { s.path.pts = defaultPathPts(box.w, box.h); touch(); })}
          {/if}
        {/if}

        {#if effectsTab === 'transform'}
          <!-- The mesh. One setting at two grid sizes, exactly as CSP has it:
               Free is the four corner handles and a perspective map, Mesh is a
               grid the picture bends smoothly through. The handles are ON THE
               BOX, not in here - this panel only arms the gizmo, picks the
               mode, sizes the grid and resets it. -->
          {@const free = warpIsFree(s)}
          <div class="switch-row">
            <button
              type="button"
              class="switch"
              class:on={s.warp.on}
              role="switch"
              aria-checked={s.warp.on}
              aria-label="Transform"
              onclick={() => { s.warp.on = !s.warp.on; touch(); }}
            ><span class="knob"></span></button>
            <span class="lbl2">Transform</span>
          </div>
          <div class="insp-sub-body" class:disabled={!s.warp.on} style="padding:0;border:none;gap:11px">
            <div class="grp">
              <span class="lbl">Handles</span>
              <div class="seg">
                <button
                  type="button"
                  class:on={free}
                  aria-pressed={free}
                  disabled={!s.warp.on}
                  title="Four corners. Pull one and the box goes into perspective."
                  onclick={() => setWarpMode(s, true)}
                >Free</button>
                <button
                  type="button"
                  class:on={!free}
                  aria-pressed={!free}
                  disabled={!s.warp.on}
                  title="A grid of dots. The picture bends smoothly between them."
                  onclick={() => setWarpMode(s, false)}
                >Mesh</button>
              </div>
            </div>
            {#if !free}
              <div class="row2">
                <div class="field">
                  <label class="lbl" for="insp-warp-cols">Columns</label>
                  <input
                    id="insp-warp-cols"
                    type="number"
                    min={WARP_MIN_GRID}
                    max={WARP_MAX_GRID}
                    step="1"
                    value={s.warp.cols}
                    disabled={!s.warp.on}
                    title="Grid cells across."
                    onchange={(e) => setGrid(s, 'cols', e)}
                  />
                </div>
                <div class="field">
                  <label class="lbl" for="insp-warp-rows">Rows</label>
                  <input
                    id="insp-warp-rows"
                    type="number"
                    min={WARP_MIN_GRID}
                    max={WARP_MAX_GRID}
                    step="1"
                    value={s.warp.rows}
                    disabled={!s.warp.on}
                    title="Grid cells down."
                    onchange={(e) => setGrid(s, 'rows', e)}
                  />
                </div>
              </div>
            {/if}
            <!-- Says what the gizmo is for, and warns about the one thing a
                 grid change cannot promise: the deformation is carried onto the
                 new grid, but a finer mesh rebuilt onto a coarser one keeps only
                 what the coarser one can say. -->
            <div class="insp-none">
              {#if free}
                Drag a corner on the box; the picture goes into perspective. The
                dashed outline is where the box started; Esc during a drag puts
                it back.
              {:else}
                Drag the dots on the box; the picture bends smoothly between
                them. The dashed outline is where the box started; Esc during a
                drag puts it back. Changing the grid carries the deformation
                over, and a smaller grid keeps only what its dots can say.
              {/if}
            </div>
            <div class="mask-row">
              <span class="mask-count">{s.warp.pts.length ? `${s.warp.cols} x ${s.warp.rows} mesh` : 'Not deformed'}</span>
              <button
                type="button"
                class="rbtn"
                disabled={!s.warp.pts.length}
                onclick={() => {
                  if (!s.warp.pts.length) return;
                  s.warp.pts = [];
                  touch();
                }}
              >Reset mesh</button>
            </div>
          </div>
        {/if}

        {#if effectsTab === 'liquify'}
          <!-- Liquify: the tool that pushes the box's mesh around under the
               pointer. The controls are the tool's, not the box's - session
               state, like the mask tools - and what a drag writes is the same
               `warp` the Transform sub-tab edits, so Reset is shared. -->
          {@const LIQ_LABEL = { push: 'Push', expand: 'Expand', pinch: 'Pinch', twirl: 'Twirl' }}
          {@const LIQ_HINT = {
            push: 'Drags the box along with the pointer.',
            expand: 'Pushes outwards from the circle’s centre.',
            pinch: 'Pulls inwards towards the circle’s centre.',
            twirl: 'Turns about the circle’s centre.',
          }}
          <div class="grp">
            <span class="lbl">Tool</span>
            <div class="seg">
              {#each LIQUIFY_MODES as m (m)}
                <button type="button" class:on={liquifyTool.mode === m} aria-pressed={liquifyTool.mode === m} title={LIQ_HINT[m]} onclick={() => setLiquifyMode(m)}>{LIQ_LABEL[m]}</button>
              {/each}
            </div>
          </div>
          <div class="grp">
            <span class="lbl">Radius</span>
            <div class="slider-row">
              <input type="range" min={LIQUIFY_RADIUS_MIN} max={LIQUIFY_RADIUS_MAX} step="1" value={liquifyTool.radius} title="How far the tool reaches, in page px" aria-label="Liquify radius" oninput={(e) => (liquifyTool.radius = clamp(Number(e.target.value) || 0, LIQUIFY_RADIUS_MIN, LIQUIFY_RADIUS_MAX))} />
              <input class="num-s" type="number" min={LIQUIFY_RADIUS_MIN} max={LIQUIFY_RADIUS_MAX} step="1" value={liquifyTool.radius} aria-label="Liquify radius, page px" onchange={(e) => (liquifyTool.radius = clamp(Number(e.target.value) || 0, LIQUIFY_RADIUS_MIN, LIQUIFY_RADIUS_MAX))} />
            </div>
          </div>
          <div class="grp">
            <span class="lbl">Strength</span>
            <div class="slider-row">
              <input type="range" min="0" max="100" step="1" value={liquifyTool.strength} title="How far the picture moves at the centre of the circle" aria-label="Liquify strength" oninput={(e) => (liquifyTool.strength = clamp(Number(e.target.value) || 0, 0, 100))} />
              <input class="num-s" type="number" min="0" max="100" step="1" value={liquifyTool.strength} aria-label="Liquify strength, percent" onchange={(e) => (liquifyTool.strength = clamp(Number(e.target.value) || 0, 0, 100))} />
            </div>
          </div>
          <div class="insp-none">
            {LIQ_HINT[liquifyTool.mode] ?? ''} Drag on the box; the circle is what the tool reaches. It bends the text and the ink together, through the box's mesh. Esc during a drag puts it back.
          </div>
          <div class="mask-row">
            <span class="mask-count">{s.warp.pts.length ? `${s.warp.cols} x ${s.warp.rows} mesh` : 'Not deformed'}</span>
            <button
              type="button"
              class="rbtn"
              disabled={!s.warp.pts.length}
              onclick={() => {
                if (!s.warp.pts.length) return;
                s.warp.pts = [];
                touch();
              }}
            >Reset mesh</button>
          </div>
        {/if}

        {#if effectsTab === 'blur'}
          <div class="grp">
            <span class="lbl">Blur</span>
            <div class="slider-row">
              <input type="range" min="0" max="20" step="0.5" value={s.blur} aria-label="Blur" oninput={(e) => setNum(s, 'blur', e.target.value, 0, 20)} />
              <input class="num-s" type="number" min="0" max="20" step="0.5" value={s.blur} title="Blur, page px" aria-label="Blur, page px" onchange={(e) => commitNum(s, 'blur', e, 0, 20)} />
            </div>
          </div>
          <div class="insp-rule"></div>
          <div class="switch-row">
            <button
              type="button"
              class="switch"
              class:on={s.motionBlur.on}
              role="switch"
              aria-checked={s.motionBlur.on}
              aria-label="Motion blur"
              onclick={() => { s.motionBlur.on = !s.motionBlur.on; touch(); }}
            ><span class="knob"></span></button>
            <span class="lbl2">Motion blur</span>
          </div>
          <div class="insp-sub-body" class:disabled={!s.motionBlur.on} style="padding:0;border:none;gap:11px">
            <div class="grp">
              <span class="lbl">X</span>
              <div class="slider-row">
                <input type="range" min="-10" max="10" step="0.1" value={s.motionBlur.x} disabled={!s.motionBlur.on} aria-label="X" oninput={(e) => setNum(s.motionBlur, 'x', e.target.value, -10, 10)} />
                <input class="num-s" type="number" min="-10" max="10" step="0.1" value={s.motionBlur.x} disabled={!s.motionBlur.on} title="Smear direction X, pixels per step" aria-label="X" onchange={(e) => commitNum(s.motionBlur, 'x', e, -10, 10)} />
              </div>
            </div>
            <div class="grp">
              <span class="lbl">Y</span>
              <div class="slider-row">
                <input type="range" min="-10" max="10" step="0.1" value={s.motionBlur.y} disabled={!s.motionBlur.on} aria-label="Y" oninput={(e) => setNum(s.motionBlur, 'y', e.target.value, -10, 10)} />
                <input class="num-s" type="number" min="-10" max="10" step="0.1" value={s.motionBlur.y} disabled={!s.motionBlur.on} title="Smear direction Y, pixels per step" aria-label="Y" onchange={(e) => commitNum(s.motionBlur, 'y', e, -10, 10)} />
              </div>
            </div>
            <div class="grp">
              <span class="lbl">Amount</span>
              <div class="slider-row">
                <input type="range" min="1" max="32" step="1" value={s.motionBlur.amount} disabled={!s.motionBlur.on} aria-label="Amount" oninput={(e) => setNum(s.motionBlur, 'amount', e.target.value, 1, 32, true)} />
                <input class="num-s" type="number" min="1" max="32" step="1" value={s.motionBlur.amount} disabled={!s.motionBlur.on} title="Blur iterations - more is smoother and longer" aria-label="Amount" onchange={(e) => commitNum(s.motionBlur, 'amount', e, 1, 32, true)} />
              </div>
            </div>
          </div>
        {/if}

        {#if effectsTab === 'edges'}
          <div class="switch-row">
            <button type="button" class="switch" class:on={s.roughen.on} role="switch" aria-checked={s.roughen.on} aria-label="Roughen edges" onclick={() => { s.roughen.on = !s.roughen.on; touch(); }}><span class="knob"></span></button>
            <span class="lbl2">Roughen edges</span>
          </div>
          <div class="insp-sub-body" class:disabled={!s.roughen.on} style="padding:0;border:none;gap:11px">
            <div class="grp">
              <span class="lbl">Amount</span>
              <div class="slider-row"><input type="range" min="0" max="20" step="0.5" value={s.roughen.amount} disabled={!s.roughen.on} aria-label="Roughen amount" oninput={(e) => setNum(s.roughen, 'amount', e.target.value, 0, 20)} /><input class="num-s" type="number" min="0" max="20" step="0.5" value={s.roughen.amount} disabled={!s.roughen.on} title="Distortion strength" aria-label="Roughen amount" onchange={(e) => commitNum(s.roughen, 'amount', e, 0, 20)} /></div>
            </div>
            <div class="grp">
              <span class="lbl">Grain</span>
              <div class="slider-row"><input type="range" min="0.01" max="0.2" step="0.005" value={s.roughen.detail} disabled={!s.roughen.on} aria-label="Roughen grain" oninput={(e) => setNum(s.roughen, 'detail', e.target.value, 0.01, 0.2)} /><input class="num-s" type="number" min="0.01" max="0.2" step="0.005" value={s.roughen.detail} disabled={!s.roughen.on} title="Grain density, 0.01–0.2" aria-label="Roughen grain" onchange={(e) => commitNum(s.roughen, 'detail', e, 0.01, 0.2)} /></div>
            </div>
            {#if engineSwitch.painting}
              <!-- The Rust engine roughens the outline, which leaves a smooth
                   edge; grit is the fine tear the old moved pixels left. The
                   browser engine still moves pixels and has no use for it. -->
              <div class="grp">
                <span class="lbl">Grit</span>
                <div class="slider-row"><input type="range" min="0" max="6" step="0.25" value={s.roughen.grit ?? 0} disabled={!s.roughen.on} aria-label="Roughen grit" oninput={(e) => setNum(s.roughen, 'grit', e.target.value, 0, 6)} /><input class="num-s" type="number" min="0" max="6" step="0.25" value={s.roughen.grit ?? 0} disabled={!s.roughen.on} title="Fine torn edge over the wobble, 0–6" aria-label="Roughen grit" onchange={(e) => commitNum(s.roughen, 'grit', e, 0, 6)} /></div>
              </div>
            {/if}
            <div class="grp">
              <label class="lbl" for="insp-seed">Seed</label>
              <input id="insp-seed" type="number" min="0" max="999" value={s.roughen.seed} disabled={!s.roughen.on} title="Varies the distortion pattern; same seed = same result" oninput={(e) => setNum(s.roughen, 'seed', e.target.value, 0, 999, true)} />
            </div>
          </div>
        {/if}

        {#if effectsTab === 'mask'}
          <div class="switch-row">
            <button
              type="button"
              class="switch"
              class:on={s.clip.on}
              role="switch"
              aria-checked={s.clip.on}
              aria-label="Mask"
              onclick={() => {
                s.clip.on = !s.clip.on;
                if (!s.clip.on && maskTool.id !== null) setMaskTool(maskTool.id);
                touch();
              }}
            ><span class="knob"></span></button>
            <span class="lbl2">Mask</span>
          </div>
          <div class="insp-sub-body" class:disabled={!s.clip.on} style="padding:0;border:none;gap:11px">
            <div class="seg">
              <button
                type="button"
                class:on={s.clip.mode === 'exclude'}
                aria-pressed={s.clip.mode === 'exclude'}
                title="Shapes hide the text under them"
                onclick={() => { s.clip.mode = 'exclude'; touch(); }}
              >Exclude</button>
              <button
                type="button"
                class:on={s.clip.mode === 'include'}
                aria-pressed={s.clip.mode === 'include'}
                title="Only text under the shapes stays visible"
                onclick={() => { s.clip.mode = 'include'; touch(); }}
              >Include</button>
            </div>
            <div class="seg">
              <button
                type="button"
                class:on={maskTool.id === 'brush'}
                aria-pressed={maskTool.id === 'brush'}
                onclick={() => { if (!s.clip.on) return; setMaskTool('brush'); }}
              >Brush</button>
              <button
                type="button"
                class:on={maskTool.id === 'poly'}
                aria-pressed={maskTool.id === 'poly'}
                onclick={() => { if (!s.clip.on) return; setMaskTool('poly'); }}
              >Polygon</button>
              <button
                type="button"
                class:on={maskTool.id === 'ellipse'}
                aria-pressed={maskTool.id === 'ellipse'}
                onclick={() => { if (!s.clip.on) return; setMaskTool('ellipse'); }}
              >Ellipse</button>
            </div>
            <div class="grp">
              <span class="lbl">Brush size</span>
              <div class="slider-row">
                <input type="range" min="2" max="200" step="1" value={s.clip.brushSize} disabled={!s.clip.on} aria-label="Brush size" oninput={(e) => setNum(s.clip, 'brushSize', e.target.value, 2, 200, true)} />
                <input class="num-s" type="number" min="2" max="200" step="1" value={s.clip.brushSize} disabled={!s.clip.on} title="Brush size, page px" aria-label="Brush size, page px" onchange={(e) => commitNum(s.clip, 'brushSize', e, 2, 200, true)} />
              </div>
            </div>
            <div class="insp-none">Draw on the box: brush drags, polygon clicks corner points (double-click closes, Esc cancels), ellipse drags a bounds box. Shapes hide or keep the text per the mode.</div>
            <div class="mask-row">
              <span class="mask-count">{s.clip.shapes.length} shape(s)</span>
              <button
                type="button"
                class="rbtn"
                disabled={!s.clip.shapes.length}
                onclick={() => {
                  if (!s.clip.shapes.length) return;
                  s.clip.shapes = [];
                  touch();
                }}
              >Clear shapes</button>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ===== Layout ===== -->
    {#if tab === 'layout'}
      <div class="insp-pane" role="tabpanel" id="insp-pane-layout" aria-labelledby="insp-tab-layout">
        {@render secHead('Size')}
        <div class="grp">
          <span class="lbl" id="insp-sizing-lbl">Sizing</span>
          <div class="seg sizing" role="radiogroup" aria-labelledby="insp-sizing-lbl">
            {#each SIZINGS as [mode, label, tip] (mode)}
              <button type="button" role="radio" class:on={sizing === mode} aria-checked={sizing === mode} title={tip} onclick={() => setBoxSizing(box, mode, page())}>{label}</button>
            {/each}
          </div>
        </div>
        <div class="row2">
          <div class="field"><label class="lbl" for="insp-w">Width</label><input id="insp-w" type="number" min="30" max="5000" step="1" value={Math.round(box.w)} title="Width, page px" onchange={(e) => commitGeom('w', e, 30, 5000, 40)} /></div>
          <div class="field"><label class="lbl" for="insp-h">Height</label><input id="insp-h" type="number" min="30" max="5000" step="1" value={Math.round(box.h)} title={sizing === 'auto' ? 'Follows the text. Type a height to set it yourself (the box becomes Fixed)' : 'Height, page px'} onchange={(e) => commitGeom('h', e, 30, 5000, 30)} /></div>
        </div>
        {@render secHead('Place')}
        <div class="row2">
          <div class="field"><label class="lbl" for="insp-x">X</label><input id="insp-x" type="number" min="-20000" max="20000" step="1" value={Math.round(box.x)} title="Left edge, page px" onchange={(e) => commitGeom('x', e, -20000, 20000)} /></div>
          <div class="field"><label class="lbl" for="insp-y">Y</label><input id="insp-y" type="number" min="-20000" max="20000" step="1" value={Math.round(box.y)} title="Top edge, page px" onchange={(e) => commitGeom('y', e, -20000, 20000)} /></div>
        </div>
        <div class="row2">
          <div class="field">
            <span class="lbl">Mirror</span>
            <div class="seg">
              <button type="button" class:on={s.flipH} aria-pressed={s.flipH} title="Flip horizontal (mirror left↔right)" onclick={() => { s.flipH = !s.flipH; touch(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v18" stroke-dasharray="2 2" /><path d="M9 8l-5 4 5 4z" /><path d="M15 8l5 4-5 4z" /></svg>
              </button>
              <button type="button" class:on={s.flipV} aria-pressed={s.flipV} title="Flip vertical (mirror top↔bottom)" onclick={() => { s.flipV = !s.flipV; touch(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12h18" stroke-dasharray="2 2" /><path d="M8 9l4-5 4 5z" /><path d="M8 15l4 5 4-5z" /></svg>
              </button>
            </div>
          </div>
          <div></div>
        </div>

        <div class="insp-rule"></div>

        {@render secHead('Type')}
        <div class="row2">
          <div class="field">
            <span class="lbl">Align</span>
            <div class="seg">
              {#each ['left', 'center', 'right'] as al (al)}
                <button type="button" class:on={s.align === al} aria-pressed={s.align === al} title={al} onclick={() => { s.align = al; touch(); }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">{#each alignIcons[al] as d}<path {d} />{/each}</svg>
                </button>
              {/each}
            </div>
          </div>
          <div class="field">
            <span class="lbl">Vertical</span>
            <div class="seg">
              {#each ['top', 'middle', 'bottom'] as va (va)}
                <button type="button" class:on={s.valign === va} aria-pressed={s.valign === va} title={va} onclick={() => { s.valign = va; touch(); }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">{#each valignIcons[va] as d}<path {d} />{/each}</svg>
                </button>
              {/each}
            </div>
          </div>
        </div>
        <!-- Line height and letter spacing get a row of their own. Nested two
             columns deep they were ~60px wide, which is a number field with no
             room left for its stepper. -->
        <div class="row2">
          <div class="field">
            <label class="lbl" for="insp-lh">Line height</label>
            <input id="insp-lh" type="number" min={LINE_HEIGHT_MIN} max={LINE_HEIGHT_MAX} step="0.05" value={s.lineHeight} title="Line height" oninput={(e) => setNum(s, 'lineHeight', e.target.value || 1, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX)} />
          </div>
          <div class="field">
            <label class="lbl" for="insp-ls">Letter spacing</label>
            <input id="insp-ls" type="number" min={letterSpacingRange(s.size).min} max={letterSpacingRange(s.size).max} step="0.5" value={s.letterSpacing} title="Extra space between letters, page px" onchange={(e) => commitNum(s, 'letterSpacing', e, letterSpacingRange(s.size).min, letterSpacingRange(s.size).max)} />
          </div>
        </div>

        <div class="insp-rule"></div>

        <!-- Presets: the fastest way to get a box right is to not set it up at
             all. They live beside layout because that is where you reach for
             them, but they reach far past layout - so the section says what
             applying one replaces. -->
        {@render secHead('Preset')}
        <div class="grp">
          <div class="preset-row">
            {#if naming}
              <input
                bind:this={presetNameEl}
                bind:value={presetName}
                placeholder="Preset name"
                aria-label="Preset name"
                onkeydown={onPresetNameKey}
              />
              <button type="button" class="rbtn" title="Save the preset under this name" disabled={!presetName.trim()} onclick={confirmSavePreset}>Save</button>
              <button type="button" class="rbtn" title="Back without saving" onclick={cancelSavePreset}>Cancel</button>
            {:else}
              <select id="insp-preset" value={presetId} onchange={(e) => applyPreset(e.target.value)} aria-label="Preset">
                <option value="">{presets.list.length ? 'Choose…' : 'No presets yet'}</option>
                {#each presets.list as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
              </select>
              <button type="button" class="rbtn" title="Save this box's style as a preset" onclick={startSavePreset}>Save</button>
              <button type="button" class="rbtn" class:arm={delArm} title={delArm ? 'Click again to delete this preset' : 'Delete the selected preset'} disabled={!presetId} onclick={onDeletePreset}>{delArm ? 'Sure?' : 'Delete'}</button>
            {/if}
          </div>
          <div class="insp-none">Replaces colour, effects and type settings</div>
        </div>

        <!-- The box's tag style (LET-1): the look its line's first tag sets
             for every box placed under it. Reset puts this box back to it;
             Save makes this box's look the tag's, for boxes placed from now
             on - existing boxes change only through Bulk style. -->
        <div class="insp-rule"></div>
        {@render secHead('Tag style')}
        <div class="grp">
          {#if tagName}
            <div class="preset-row">
              <button type="button" class="rbtn" title="Give this box the style its tag sets" onclick={() => resetBoxToTagStyle(box.id)}>Reset to tag style</button>
              <button type="button" class="rbtn" title="Make this box's look the style of “{tagName}”, for boxes placed from now on" onclick={() => saveBoxStyleAsTag(box.id)}>Save as tag style</button>
            </div>
            <div class="insp-none">Tag “{tagName}” · position, size and line breaking stay the box's</div>
          {:else}
            <div class="insp-none">This box's line has no tag. Tag it in the Text Queue.</div>
          {/if}
        </div>

        <!-- ===== Typeset =====
             The one contextual thing about this box's line breaking: which
             balloon it was measured against, and the verb that measures it
             again. The switches - shaped breaks, hyphenation, balloon layout,
             the orphan threshold - are defaults, set once in Settings ›
             Typesetting, and overridable per box from the Bulk style panel.
             None of them said anything about the box you had selected. -->
        <div class="insp-rule"></div>
        {@render secHead('Typeset')}
        <div class="grp">
          <span class="lbl">{fitLabel(box)}</span>
          <!-- The outline's state (Bubble C), in the colour the Regions view
               draws it in. -->
          {#if outlineState(box)}
            <span class="outline-state {outlineState(box)}">{outlineWords(box)}</span>
          {/if}
          <!-- Verbs, not segments: none of them excludes another. -->
          <div class="outline-btns">
            <button type="button" class="rbtn" title="Find the bubble under this box again, from where the box is now, and typeset the text in it" onclick={() => refitBalloon(box.id)}>
              {box.fit ? 'Refit outline' : 'Find outline'}
            </button>
            <button type="button" class="rbtn" disabled={!box.fit || boxLocked(box)} title="Move the box so its text sits in the middle of its outline" onclick={() => centreTextInOutline(box.id)}>Centre in bubble</button>
            <button type="button" class="rbtn" title="Use this box's own rectangle as its outline - for free text, an SFX, or a bubble with no closed outline" onclick={() => outlineToBox(box.id)}>Outline = box</button>
            <button type="button" class="rbtn" disabled={!box.fit || box.outline?.approved === 'user'} title="Mark this outline right" onclick={() => approveOutline(box.id)}>Approve</button>
            <button type="button" class="rbtn" title="Approve every outline on this page that nobody approved yet" onclick={() => approvePageOutlines()}>Approve page</button>
          </div>
        </div>
      </div>
    {/if}

    </div>

    <!-- The lock is offered on the first tab only. -->
    <div class="insp-actions" class:pair={tab === 'text'}>
      {#if tab === 'text'}
        <button class="btn-lock" disabled={locked} title="Lock this box: nothing changes it until it is unlocked" onclick={() => setBoxLocked(box.id, true)}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
          Lock box
        </button>
      {/if}
      <button class="btn-danger" disabled={locked} onclick={onDeleteBox}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
        Delete box
      </button>
    </div>
  </div>
{/if}

<style>
  /* The outline's state. A dot in the Regions view's colour for it, the words
     in the panel's own text colour, so both themes read it. */
  .outline-state {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--t2);
  }
  .outline-state::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .outline-state.user::before {
    background: #1f9d55;
  }
  .outline-state.ai::before {
    background: #2f6fde;
  }
  .outline-state.waiting::before {
    background: #e08a00;
  }
  .outline-state.open::before {
    background: #d33a2c;
  }
  .outline-btns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .outline-btns .rbtn {
    width: 100%;
  }
  /* The panel body is a column of its own, as `.insp` lays its children out. */
  .insp-body {
    display: flex;
    flex-direction: column;
    gap: inherit;
    min-width: 0;
  }
  .insp-body.locked {
    opacity: 0.45;
  }
  .insp-locked {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px 7px 10px;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: var(--surface);
    font-size: 12px;
    color: var(--text);
  }
  .insp-locked span {
    flex: 1;
    min-width: 0;
  }
  .insp-locked svg,
  .btn-lock svg {
    flex: 0 0 auto;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linejoin: round;
  }
  .insp-locked svg rect,
  .btn-lock svg rect {
    fill: currentColor;
  }
  .insp-actions {
    display: grid;
    gap: 6px;
    margin-top: 4px;
  }
  .insp-actions.pair {
    grid-template-columns: 1fr 1fr;
  }
  .insp-actions .btn-danger {
    margin-top: 0;
  }
  .btn-lock {
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
  .btn-lock:hover:not(:disabled) {
    background: var(--surface);
  }
  .insp-actions button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  /* The tab strip. It sticks to the top of the panel's own scroll, because the
      panel is a floating window a letterer resizes down to a few rows: a tab bar
      that scrolls away is a tab bar you cannot reach without scrolling back.
      Each column keeps a minimum width, so the labels stay readable however
      narrow the panel is gripped - past that the strip scrolls sideways rather
      than crushing four words into nothing. */
  .insp-tabs {
    position: sticky;
    top: -12px;
    z-index: 2;
    display: grid;
    grid-template-columns: repeat(4, minmax(52px, 1fr));
    gap: 4px;
    margin: -12px -12px 2px;
    padding: 12px 12px 8px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
  }
  .insp-tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    height: 46px;
    padding: 0 2px;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: var(--t2);
    font-family: inherit;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    cursor: pointer;
    min-width: 0;
  }
  /* The icons arrive as markup, so they carry no scope class of their own. */
  .insp-tab :global(svg) {
    width: 18px;
    height: 18px;
  }
  .insp-tab span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .insp-tab:hover {
    color: var(--text);
    background: var(--surface);
  }
  .insp-tab.on {
    color: var(--accent-fg);
    background: var(--accent);
    border-color: var(--accent);
  }
  .insp-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* `.insp-pane` and `.slider-row .num-s` moved to styles.css - the brush panel
     is a pane with slider rows of its own, and Svelte's scoping would have made
     the second component restate them. */

  /* A heading inside a pane, for the two or three blocks a pane still groups. */
  .insp-sec {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--t3);
  }

  /* A label with its own glyph in front of it (rotation). */
  .lbl.ico {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .lbl.ico :global(svg) {
    width: 13px;
    height: 13px;
  }

  /* The size stepper, drawn as one control like the style segments beside
     it: − and + at the ends, the number and its unit between them. The field
     loses its own box and native spinner, which the buttons replace. */
  .size-step {
    display: flex;
    align-items: center;
    /* 28px of control inside the border, like the segments beside it. */
    height: 30px;
    background: var(--surface);
    border: 1px solid var(--line2);
    border-radius: 6px;
    overflow: hidden;
  }
  .size-step:focus-within {
    border-color: var(--accent);
  }
  .size-step button {
    flex: 0 0 26px;
    height: 100%;
    border: none;
    background: transparent;
    color: var(--t2);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
  }
  .size-step button:hover:not(:disabled) {
    color: var(--text);
    background: var(--accent-soft);
  }
  .size-step button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .size-step button:first-child {
    border-right: 1px solid var(--line);
  }
  .size-step button:last-child {
    border-left: 1px solid var(--line);
  }
  .size-step input[type='number'] {
    flex: 1 1 0;
    min-width: 0;
    height: 100%;
    border: none;
    border-radius: 0;
    background: transparent;
    padding: 0 2px 0 4px;
    font-variant-numeric: tabular-nums;
    -moz-appearance: textfield;
  }
  .size-step input[type='number']::-webkit-inner-spin-button,
  .size-step input[type='number']::-webkit-outer-spin-button {
    -webkit-appearance: none;
    appearance: none;
    margin: 0;
  }
  /* The field and the unit split the middle, so "26 px" sits centred between
     the buttons rather than pushed to the right one. */
  .size-step .unit {
    flex: 1 1 0;
    padding-left: 3px;
    font-size: 11px;
    color: var(--t2);
  }
  .size-now {
    font-size: 11px;
    color: var(--t2);
    font-variant-numeric: tabular-nums;
  }

  /* Size beside the weight buttons, half the row each. */
  .row-size {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .row-size > * {
    min-width: 0;
  }

  /* The fold for bold weight and italic angle: narrow, after the toggles. */
  .seg .more {
    flex: 0 0 26px;
    position: relative;
  }
  .seg .more.set::after {
    content: '';
    position: absolute;
    top: 3px;
    right: 3px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
  }
  .style-more {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* No fill: the struck-through swatch, as wide as it is tall. */
  .seg .nofill {
    flex: 0 0 34px;
  }
  /* A drop shadow's Photoshop options, under its row. */
  .sh-more {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px 10px;
    margin: -2px 0 6px 30px;
    font-size: 12px;
    color: var(--t2);
  }
  /* A contour's Edit button and its editor, across the row. */
  .ce-open {
    flex: 0 0 auto;
    padding: 1px 6px;
    font-size: 11px;
  }
  .ce-open.on {
    color: var(--accent);
  }
  .ce-span {
    grid-column: 1 / -1;
  }
  .sh-more label {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .sh-num span,
  .sh-contour span {
    flex: 0 0 auto;
  }
  .sh-num input,
  .sh-num select {
    flex: 1 1 auto;
    min-width: 0;
  }
  .sh-contour {
    grid-column: 1 / -1;
  }
  .sh-contour select {
    flex: 1 1 auto;
    min-width: 0;
  }
  /* A multi effect instance's switch and its up, down and duplicate. */
  .fx-inst {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: -2px 0 2px 30px;
    font-size: 12px;
    color: var(--t2);
  }
  .fx-inst.flush {
    margin-left: 0;
  }
  .fx-inst-end {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .inst-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--t3);
    cursor: pointer;
  }
  .inst-btn svg {
    width: 13px;
    height: 13px;
  }
  .inst-btn:hover:not(:disabled) {
    background: var(--accent-soft);
    color: var(--text);
  }
  .inst-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .add-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  /* A switched-off instance: kept, dimmed. */
  .inst-off {
    opacity: 0.55;
  }
  /* Advanced Blending: Channels on one row, Blend If's channel menu beside
     its heading, its two sliders under it. */
  .blend-chans,
  .blend-if-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .blend-if {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .blend-if-head select {
    margin-left: auto;
  }
  .nofill-note {
    margin: 0;
    font-size: 11px;
    line-height: 1.4;
    color: var(--t3);
  }

  /* Gradient type: an icon over its name, two up. */
  .kbtn {
    flex-direction: column;
    gap: 2px;
    height: 46px;
    font-size: 10px;
  }
  .kbtn :global(svg) {
    width: 17px;
    height: 17px;
  }

  /* The stop bar: the ramp at the size a decision needs, and a rail of handles
     under it. The two are one control - the wrapper takes the pointerdown that
     adds a stop, so clicking either the ramp or the empty rail beside a handle
     puts a new one where it was clicked. */
  .grad-edit {
    display: flex;
    flex-direction: column;
    cursor: copy;
    touch-action: none;
  }
  .grad-bar {
    position: relative;
    height: 34px;
    border-radius: 7px 7px 0 0;
    border: 1px solid var(--line2);
    border-bottom: none;
    overflow: hidden;
    /* The chequerboard a stop's alpha is read against: without something
       underneath it, a transparent stop is the panel's own background and
       reads as a colour rather than as a hole. */
    background-color: #fff;
    background-image:
      linear-gradient(45deg, #c9c9c9 25%, transparent 25%),
      linear-gradient(-45deg, #c9c9c9 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #c9c9c9 75%),
      linear-gradient(-45deg, transparent 75%, #c9c9c9 75%);
    background-size: 10px 10px;
    background-position: 0 0, 0 5px, 5px -5px, -5px 0;
  }
  .grad-ramp {
    position: absolute;
    inset: 0;
    background-size: cover;
  }
  /* The rail's PADDING box is the ramp's box exactly - same 1px side borders,
     no margin - because a handle's `left` is its position along the gradient
     and the two have to be the same ruler. */
  .grad-rail {
    position: relative;
    height: 15px;
    border-radius: 0 0 7px 7px;
    background: var(--surface);
    border: 1px solid var(--line2);
    border-top: none;
  }
  /* A house: flat-bottomed, pointed at the ramp it marks. The point IS the
     position, so the chip is centred on its own left edge. */
  .gstop {
    position: absolute;
    top: -1px;
    width: 13px;
    height: 15px;
    margin-left: -6.5px;
    padding: 0;
    border: none;
    background: var(--stop-c, #000);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.45);
    clip-path: polygon(50% 0, 100% 40%, 100% 100%, 0 100%, 0 40%);
    cursor: ew-resize;
    touch-action: none;
  }
  .gstop:hover {
    box-shadow: inset 0 0 0 1px var(--text);
  }
  .gstop.on,
  .gstop:focus-visible {
    outline: none;
    box-shadow:
      inset 0 0 0 1px var(--accent-fg),
      inset 0 0 0 3px var(--accent);
  }

  /* The selected stop's own row, on the same column widths as the caption
      above it: index, swatch, hex, position, opacity, add, bin. */
  .grad-sel,
  .grad-cap {
    display: grid;
    grid-template-columns: 22px 24px minmax(0, 1fr) 46px 46px 20px 20px;
    gap: 6px;
    align-items: center;
  }
  .grad-cap {
    margin-top: 8px;
  }
  .grad-sel {
    margin-top: 2px;
  }
  /* The same stripped number field the list rows use: at 46px a spinner costs
     the column the third digit of "100". */
  .grad-sel input[type='number'] {
    padding: 0 5px;
    -moz-appearance: textfield;
  }
  .grad-sel input[type='number']::-webkit-inner-spin-button,
  .grad-sel input[type='number']::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .grad-n {
    font-size: 10px;
    color: var(--t3);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  /* The direction pad: nine cells, and a cell's POSITION is the direction it
     sets. The number beside it is the same field, for the angles between. */
  .pad-row {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    min-width: 0;
  }
  .dirpad {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: repeat(3, 32px);
    grid-auto-rows: 32px;
    gap: 3px;
  }
  .pad-side {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .pad-side .field {
    gap: 6px;
  }
  .dirpad .cell {
    display: grid;
    place-items: center;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--t2);
    padding: 0;
    cursor: pointer;
    font-size: 9px;
    font-family: inherit;
    font-variant-numeric: tabular-nums;
  }
  .dirpad .cell.blank,
  .dirpad .cell.mid {
    border-color: transparent;
    background: transparent;
    color: var(--t3);
    cursor: default;
  }
  button.cell:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  button.cell.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
  }
  .dirpad .arrow {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
  }
  .dirpad .arrow :global(svg) {
    width: 16px;
    height: 16px;
  }
  /* The centre presets say where the middle of the circle goes, so the dot is
     the whole picture. */
  .dirpad .cdot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }

  /* Patterns as cards. Nobody knows what "grid" looks like from the word; the
     tile is drawn by the same painter that paints the glyphs, in this box's own
     two colours, so the card IS the answer. */
  .pat-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }
  .pat-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 4px 5px;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: var(--surface);
    color: var(--t2);
    font-family: inherit;
    cursor: pointer;
    min-width: 0;
  }
  .pat-card:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .pat-card.on {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
    color: var(--text);
  }
  .pat-tile {
    height: 30px;
    border-radius: 4px;
    background-repeat: repeat;
    background-position: center;
    border: 1px solid var(--line);
  }
  .pat-pick {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
    align-items: stretch;
  }
  .pat-pick .add-btn {
    grid-column: span 2;
    min-height: 30px;
  }
  .pat-pick .add-btn.on {
    border-color: var(--accent);
    color: var(--text);
  }
  .pat-note {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--t3);
  }
  .pat-name {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The inline preset name field takes the room the menu takes, and the armed
     delete reads as the warning it is. */
  .preset-row input {
    flex: 1 1 auto;
    min-width: 0;
    width: auto;
  }
  .preset-row .rbtn.arm {
    color: var(--warn);
    border-color: var(--warn);
  }

  .sub-tabs {
    display: grid;
    /* Nine tabs in one row: at the panel's default width each is about 30px,
       and the glyph is 15px. Six per row left a row of three. */
    grid-template-columns: repeat(9, minmax(0, 1fr));
    gap: 3px;
  }
  .sub-tab {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 24px;
    padding: 0 2px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
    min-width: 0;
  }
  .sub-tab :global(svg) {
    width: 15px;
    height: 15px;
  }
  .sub-tab:hover {
    color: var(--text);
    background: var(--surface);
  }
  .sub-tab.on {
    color: var(--accent-fg);
    background: var(--accent);
    border-color: var(--accent);
  }
  .sub-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .mask-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .mask-count {
    font-size: 11.5px;
    color: var(--t3);
  }
</style>
