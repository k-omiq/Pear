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
    toastError,
  } from './store.svelte.js';

  import { editBurst } from './edit-burst.js';
  import FontPicker from './FontPicker.svelte';
  import { sizingOf, sizeSetting, setSizeSetting, steppedSize, SIZE_MIN, SIZE_MAX, foldPatternFill } from './data.js';
  import { loadedPatterns, loadPatternLibrary, importPatterns, removePatternSet, useLoadedPattern } from './pattern-library.svelte.js';
  import { isTauri, pickFilesTauri } from './importer.js';
  import { comboFor, formatCombo } from './shortcuts.svelte.js';
  import { modKey } from './format.js';
  import {
    PATTERN_KINDS,
    CANVAS_PATTERN_KINDS,
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
    tintOf,
    olderOverlays,
    setTintKind,
    newStrokeEffect,
    FX_GRADIENT_STYLES,
    FX_GRADIENT_METHODS,
    NOISE_MODELS,
    STROKE_POSITIONS,
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
    blendIfActive,
    outlineRun,
  } from './data.js';
  import FxMenu from './FxMenu.svelte';
  import ValueSlider from './ValueSlider.svelte';
  import AngleDial from './AngleDial.svelte';
  import { editLive, holdEditLive } from './edit-live.svelte.js';
  import { setFxDefault, clearFxDefault, isComics } from './prefs.svelte.js';
  import { layoutShape } from './balloon.js';
  import { patternTileCanvas, shadowAngle, shadowDistance, shadowOffset, usesBackdrop, FILL_SPECIAL_MODES } from './text-paint.js';
  import { insertPathAnchor } from './measure.js';
  import { wavePath } from './bezier-path.js';
  import { drawKindFor, setDrawTool, clearDrawTool, drawSettings } from './box-draw-tool.svelte.js';
  import { bubbleLink, BUBBLE_INSET_MAX, MASK_BRUSH_MIN, MASK_BRUSH_MAX } from './box-mask.js';
  import { setMaskOn, clearMaskShapes, clipToBubble, slideBubbleInset } from './box-mask-actions.js';
  import { regridWarp } from './warp-gizmo.js';
  import { liquifyTool, setLiquifyMode, LIQUIFY_RADIUS_MIN, LIQUIFY_RADIUS_MAX } from './liquify-tool.svelte.js';
  import { LIQUIFY_MODES } from './liquify.js';
  import BrushPanel from './BrushPanel.svelte';
  import { clearSfx } from './sfx.js';
  import { engineSwitch } from './engine-switch.svelte.js';
  import { glyphPainter } from './text-engine/index.js';
  import { inkJobGap } from './exporter.js';
  import { patternCard } from './pattern-cards.js';
  import { patternTiles, restorePickedTile } from './pattern-tiles.svelte.js';
  import { patternPick, startPatternPick, canPickPattern } from './pattern-pick.svelte.js';
  import ColorPicker from './ColorPicker.svelte';
  import FxGradientEditor from './FxGradientEditor.svelte';
  import PatternEditor from './PatternEditor.svelte';
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
    setEffectsGroup,
    effectsGroupOf,
    effectsTabsIn,
    EFFECTS_GROUPS,
  } from './inspector-tabs.svelte.js';
  import { presets, savePreset, removePreset } from './presets.svelte.js';
  import {
    tabIcons,
    iconRotate,
    iconNoFill,
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

  // The Effects tab is a group segment over the group's own sub-tabs, both
  // in words (inspector-tabs.svelte.js has the list). SFX is not here: it has
  // its own window (SfxWindow.svelte).
  const effectsTab = $derived(effectsSubTab.id);
  const effectsGroup = $derived(effectsGroupOf(effectsSubTab.id));
  const groupTabs = $derived(effectsTabsIn(effectsGroup));

  // The same keys as the main tabs, in each row: the group row walks the
  // groups, the sub-tab row walks the group it shows.
  function rowKey(e, ids, id, pick, prefix) {
    const i = ids.indexOf(id);
    let n = null;
    if (e.key === 'ArrowLeft') n = (i + ids.length - 1) % ids.length;
    else if (e.key === 'ArrowRight') n = (i + 1) % ids.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = ids.length - 1;
    if (n == null) return;
    e.preventDefault();
    e.stopPropagation();
    pick(ids[n]);
    document.getElementById(`${prefix}${ids[n]}`)?.focus();
  }
  const onGroupKey = (e, id) => rowKey(e, EFFECTS_GROUPS.map((g) => g.id), id, setEffectsGroup, 'insp-fxgroup-');
  const onSubTabKey = (e, id) => rowKey(e, groupTabs.map((t) => t.id), id, setEffectsSubTab, 'insp-subtab-');

  // The Mask panel's tools, and the one line that says what the armed one
  // does. Rectangles are stored as four-point polygons.
  const MASK_KINDS = [
    ['brush', 'Brush'],
    ['rect', 'Rectangle'],
    ['ellipse', 'Ellipse'],
    ['poly', 'Polygon'],
    ['move', 'Move'],
  ];
  const MASK_HINT = {
    brush: 'Drag on the page to paint a shape.',
    rect: 'Drag on the page to draw a rectangle.',
    ellipse: 'Drag on the page to draw an ellipse.',
    poly: 'Click the corners. Double-click to close, Esc to drop it.',
    move: 'Drag a shape to move it, or empty space to move all. Delete removes the picked shape.',
  };

  // A new seed for a seeded effect, never the one it has: a press that
  // changed nothing would look like a broken button.
  function newSeed(obj, max) {
    let seed = obj.seed;
    while (seed === obj.seed) seed = Math.floor(Math.random() * (max + 1));
    obj.seed = seed;
    touch();
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

  // The Fill tab's folds: closed until asked and kept for the session, as the
  // tabs are. A closed fold's head says what it holds (a count, or "set").
  let overlaysOpen = $state(false);
  let blendOpen = $state(false);
  // One per layer gradient (its title): an overlay's fold does not open a
  // stroke's.
  let gradMore = $state({});
  const patternOn = $derived(!!box?.style.patternOverlay?.on);
  const blendTuned = $derived.by(() => {
    const b = box?.style.blending;
    if (!b) return false;
    return b.interior === true || (b.knockout ?? 'none') !== 'none' || Object.values(b.channels ?? {}).some((v) => v === false) || blendIfActive(b.blendIf) || ['blendClipped', 'transparencyShapes'].some((k) => blendingSwitch(b, k) !== BLENDING_SWITCHES[k]);
  });
  // A layer gradient's fold says "set" when a setting inside it is not the plain one.
  // `placed` gradients alone show dither, align and offset (a glow's does not).
  const gradTuned = (g, placed) => g.type === 'noise' || !!g.smoothness || (g.method ?? 'classic') !== 'classic' || (placed && (g.dither === true || g.align === false || !!g.offset?.[0] || !!g.offset?.[1]));

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
    ['fixed', 'Fixed', 'You set the width, the height and the size. The box still grows if the text needs more room.'],
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
  // Three exclusive looks over independent flags, because the renderer needs
  // them all (no fill beats pattern beats gradient when more than one is on)
  // and the user needs one choice. A pattern is the Pattern Overlay's, the
  // one pattern tool; 'pattern' here is an old pattern fill that could not
  // move there by itself (`foldPatternFill`), offered a move.
  const fillMode = $derived(
    box ? (box.style.noFill ? 'none' : box.style.pattern.on ? 'pattern' : box.style.gradient.on ? 'gradient' : 'solid') : 'solid',
  );
  function setFillMode(m) {
    box.style.noFill = m === 'none';
    box.style.gradient.on = m === 'gradient';
    box.style.pattern.on = false;
    touch();
  }
  function movePatternFill() {
    if (!box || !foldPatternFill(box.style, true)) return;
    overlaysOpen = true;
    touch();
  }

  // ---- gradient ----
  function setGradKind(k) {
    box.style.gradient.kind = k;
    touch();
  }

  // Nine cells for a radial centre, with the corners left out: a
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

  // ---- patterns ----
  // A pattern is picked by looking at it. Each card draws the real tile through
  // the same painter the editor and the exporter use, in the box's own two
  // colours, so what is on the card is what lands on the glyphs.
  // The Rust engine shades a pattern per pixel and paints every kind and
  // control; the browser engine repeats one of the eleven canvas tiles.
  const rustPatterns = $derived(engineSwitch.painting && glyphPainter().screen === true);
  // The engine paints whole boxes: Fill Opacity, and a shadow's Spread,
  // Contour, Noise and knockout (the browser engine paints none of them).
  const rustBoxes = $derived(engineSwitch.painting && glyphPainter().box === true);
  // Whether the painter moves letters on its own (`wobbleInJob`).
  const wobblePaints = $derived(engineSwitch.painting && glyphPainter().wobble === true);
  // The ink note: a box whose brush ink the engine's box job cannot take yet
  // (`inkJobGap`) is painted by the canvas, with none of its layer effects,
  // Fill Opacity, blend mode, Channels or Blend If. The controls stay (the
  // values are kept, and a PSD carries them); the note says they do not show.
  const inkGap = $derived(rustBoxes && box ? inkJobGap(box) : null);
  const INK_GAP_WHY = {
    engine: 'this build of the Rust engine paints no brush ink in the box',
  };
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
  const shownKinds = $derived(rustPatterns ? PATTERN_KINDS : CANVAS_PATTERN_KINDS);
  // The card's tile is a fixed size rather than the box's, so the cards are
  // comparable with each other; `scale` is the slider under them.
  const CARD_SIZE = 44;
  const CARD_TILE = CARD_SIZE * 0.3;
  // A swatch of the grid: six to a row of the panel.
  const CARD_W = 44;
  const CARD_H = 30;
  // While a control is held (`editLive`) the cards keep the pictures they
  // have: a slider's every frame would otherwise paint all of them again
  // (thirty-one engine fills and as many `toDataURL`s), and that, not the
  // box, was most of a pattern slider's lag. They are painted once on release.
  // A plain variable, not state: it is the derived's own memory and nothing
  // is to run because it was written.
  let cardsKept = null;
  const patternCards = $derived.by(() => {
    if (editLive.on && cardsKept?.boxId === box?.id) return cardsKept.cards;
    // Painted again only for what the cards show: the pattern's look, never
    // which card is chosen. A press in the panel turns `editLive` on and off
    // and runs this again; with nothing changed it hands back what it has.
    const pat = box?.style.patternOverlay?.pattern;
    const key = JSON.stringify([box?.id, rustPatterns, shownKinds, patternTiles.version, pat ? { ...$state.snapshot(pat), kind: '' } : null]);
    if (cardsKept?.key === key) return cardsKept.cards;
    const cards = paintPatternCards();
    cardsKept = { boxId: box?.id, key, cards };
    return cards;
  });
  // A press that can be a drag says so (`editLive`). Not a list: WebKit runs
  // a <select>'s menu in a loop of its own and the page hears no pointerup,
  // so the flag would stay up and the box stay soft until the next click.
  function holdLive(e) {
    if (e.button === 0 && !e.target.closest?.('select')) holdEditLive();
  }
  function paintPatternCards() {
    const pat = box?.style.patternOverlay?.pattern;
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
  }
  // Pattern from page: the next drag on the page is read (pattern-pick.svelte.js),
  // which records its own style step, so the panel's pending one lands first.
  function pickFromPage(target = 'patternOverlay.pattern') {
    if (!box) return;
    settle();
    startPatternPick(page().id, box.id, target);
  }
  // An effect's pattern takes the tile the Pattern Overlay already has (from
  // the page or a .pat), at its own size and lie, as a pick does.
  function usePickedTile(p, from) {
    Object.assign(p, { kind: 'picked', src: from.src, cell: [...from.cell], mode: from.mode, scale: 1, angle: 0, aspect: 1, density: 0.5, ox: 0, oy: 0 });
    touch();
  }

  // ---- loaded patterns (.pat) ----
  // The person's own patterns, app-wide (pattern-library.svelte.js), offered
  // under the built-in ones in the Pattern Overlay.
  void loadPatternLibrary();
  let patFileInput = $state(null);
  async function loadPatFiles() {
    try {
      let files;
      if (isTauri()) files = await pickFilesTauri({ name: 'Patterns', extensions: ['pat'], multiple: true });
      else return patFileInput?.click();
      if (files?.length) await takePatFiles(files);
    } catch (e) {
      toastError(`Couldn't load the patterns: ${e?.message ?? e}`);
    }
  }
  async function takePatFiles(files) {
    try {
      const read = await Promise.all([...files].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
      const { added, same, skipped } = await importPatterns(read);
      const parts = [`${added} pattern${added === 1 ? '' : 's'} loaded`];
      if (same) parts.push(`${same} already there`);
      if (skipped) parts.push(`${skipped} could not be read`);
      toast(parts.join(', ') + '.');
    } catch (e) {
      toastError(`Couldn't load the patterns: ${e?.message ?? e}`);
    }
  }
  // A loaded pattern becomes the overlay's: its tile is copied into the
  // chapter first, so the chapter keeps it whatever the library does.
  async function pickLoaded(it) {
    const id = box?.id;
    if (!id) return;
    try {
      const fields = await useLoadedPattern(it);
      if (box?.id !== id) return;
      settle();
      Object.assign(box.style.patternOverlay.pattern, fields);
      touch();
    } catch (e) {
      toastError(`Couldn't use that pattern: ${e?.message ?? e}`);
    }
  }

  // ---- the layer effects' sliders and folds ----
  // A slider's value written as it is (ValueSlider clamps it), or a percent
  // slider's as the fraction the style keeps.
  function setVal(obj, key, v) {
    obj[key] = v;
    touch();
  }
  function setFrac(obj, key, v) {
    obj[key] = clamp(v / 100, 0, 1);
    touch();
  }
  // Which effect's "More" fold is open, by the effect (`moreFold`): closed
  // until asked, kept for the session as the tabs are.
  let fxMore = $state({});
  // A satin dark on dark letters lays nothing anyone can see: the default
  // (black, Multiply) on the default letters (black) is just that.
  function satinHidden(st) {
    const sa = st?.satin;
    if (!sa?.on || st.noFill || st.gradient?.on || st.patternOverlay?.on) return false;
    return lumOf(sa.color) < 0.25 && lumOf(st.color) < 0.25;
  }
  function lumOf(hex) {
    const h = String(hex ?? '#000000').replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const [r, g, b] = [0, 2, 4].map((i) => (parseInt(full.slice(i, i + 2), 16) || 0) / 255);
    return 0.299 * r + 0.587 * g + 0.114 * b;
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
  // A dial held down on the chapter's light is laid live and recorded as one
  // step when it lets go (`setChapterLight`).
  function setShadowAngle(sh, a, live = false) {
    if (!Number.isFinite(a)) return;
    a = clamp(a, -180, 180);
    if (sh.useGlobalLight) setChapterLight({ angle: a }, { live });
    else {
      Object.assign(sh, shadowOffset(a, shadowDistance(sh)));
      keepShadowAngle(sh, a);
      touch();
    }
  }
  function setShadowDistance(sh, d) {
    if (!Number.isFinite(d)) d = 0;
    d = clamp(d, 0, SHADOW_DISTANCE_MAX);
    const a = angleOf(sh);
    Object.assign(sh, shadowOffset(a, d));
    if (!sh.useGlobalLight) keepShadowAngle(sh, a);
    touch();
  }
  const endLightDrag = () => setChapterLight({});
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
  // `next` is the light dial's { angle, altitude }.
  function setBevelLight(bv, next, live = false) {
    const v = { angle: clamp(next.angle, -180, 180), altitude: clamp(next.altitude, 0, 90) };
    if (bv.useGlobalLight) setChapterLight(v, { live });
    else {
      Object.assign(bv, v);
      touch();
    }
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
  // The Tint (Fill tab): the top colour overlay, or the top gradient one
  // (`tintOf`). Off by default: no overlay. Switched off it is kept, as any
  // effect instance is.
  function setTint(on) {
    const t = tintOf(box.style);
    if (t) return setInstanceOn(t.fx, on);
    if (!on) return;
    box.style.colorOverlays.push(newOverlay());
    touch();
  }
  function pickTintKind(kind) {
    if (setTintKind(box.style, kind)) touch();
  }
  // An overlay from an older file (`olderOverlays`): it paints as before and
  // can only be removed.
  function removeOlderOverlay(o) {
    (o.kind === 'color' ? box.style.colorOverlays : box.style.gradientOverlays).splice(o.i, 1);
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
  // Photoshop's Interpolation Method names, as its Gradient Editor has them.
  const FX_METHOD_LABELS = { classic: 'Classic', perceptual: 'Perceptual', linear: 'Linear', smooth: 'Smooth' };
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
  // A blend mode's name as Photoshop's menu shows it.
  const blendLabel = (m) => m.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  // The modes that only darken: over white paper they leave black letters as
  // Normal paints them, which reads as "the mode does nothing".
  const DARKEN_MODES = ['darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color'];

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
<!-- The ink note (`inkGap`): this box's layer effects, Fill Opacity, blend
     mode, Channels and Blend If are not painted, and why. -->
{#snippet inkGapNote()}
  {#if inkGap}
    <p class="nofill-note ink-gap-note" role="note">Not painted on this box: layer effects, Fill opacity, blend mode, Channels and Blend If. The values are kept, but {INK_GAP_WHY[inkGap]}.</p>
  {/if}
{/snippet}

<!-- ===== The layer effects (Effects tab) =====
     One grammar with the Fill tab: a property row is its name on the left and
     its control on the right (`.prow`). Numbers are sliders with their value
     beside them (ValueSlider); an angle is a dial (AngleDial). What a plain
     look never needs (noise, contours, Photoshop-only switches) waits in a
     "More" fold under the effect, its badge saying when it holds anything. A
     one-of effect shows its settings only while it is on. -->

<!-- A row with a slider: `value` as shown, `set(v)` writes it. -->
{#snippet sliderRow(label, title, value, set, opts)}
  <div class="prow" {title}>
    <span class="pl">{label}</span>
    <div class="pc"><ValueSlider {value} min={opts.min ?? 0} max={opts.max} step={opts.step ?? 1} soft={opts.soft ?? null} unit={opts.unit ?? ''} exact={opts.exact === true} disabled={opts.disabled === true} label={opts.aria} oninput={set} /></div>
  </div>
{/snippet}
<!-- A 0..1 field as a percent slider. -->
{#snippet pctRow(label, title, obj, key, aria, disabled = false)}
  {@render sliderRow(label, title, pct(obj[key]), (v) => setFrac(obj, key, v), { max: 100, unit: '%', aria, disabled })}
{/snippet}
<!-- A page-px length. `soft` is where the track ends (ValueSlider). -->
{#snippet pxRow(label, title, obj, key, aria, max, soft, exact = false, step = 1)}
  {@render sliderRow(label, title, obj[key], (v) => setVal(obj, key, v), { max, soft, unit: 'px', aria, exact, step })}
{/snippet}
<!-- An effect's blend mode. -->
{#snippet modeRow(obj, aria, label = 'Mode')}
  <div class="prow" title="Blend mode: how it mixes with what is under it">
    <span class="pl">{label}</span>
    <div class="pc">
      <select value={obj.blend} aria-label={aria} onchange={(e) => { obj.blend = e.target.value; touch(); }}>
        {#each LAYER_BLEND_MODES as m (m)}
          <option value={m}>{blendLabel(m)}</option>
        {/each}
      </select>
    </div>
  </div>
{/snippet}
<!-- A contour: its curve from the menu or drawn (Edit), and Anti-aliased,
     which Photoshop reads and the engine does not paint. -->
{#snippet contourRow(owner, key, id, label = 'Contour', title = 'Contour: how the edge falls off')}
  <div class="prow" {title}>
    <span class="pl">{label}</span>
    <div class="pc">
      <select value={owner[key]?.preset ?? 'linear'} aria-label={id} onchange={(e) => pickContour(owner, key, e.target.value, id)}>
        {#each CONTOUR_PRESETS as cid (cid)}
          <option value={cid}>{CONTOUR_LABELS[cid]}</option>
        {/each}
        <option value="custom">{CONTOUR_LABELS.custom}</option>
      </select>
      {@render contourEditBtn(id, false)}
    </div>
  </div>
  {@render contourPanel(owner, key, id)}
  <label class="sh-check indent" title="Anti-aliased: written to the PSD for Photoshop; the engine does not paint it">
    <input type="checkbox" checked={owner[key]?.aa === true} aria-label="{id} anti-aliased" onchange={(e) => { owner[key] = { ...owner[key], aa: e.target.checked }; touch(); }} />
    <span>Anti-aliased (Photoshop only)</span>
  </label>
{/snippet}
<!-- A segmented choice row. -->
{#snippet segRow(label, title, options, current, pick, aria)}
  <div class="prow" {title}>
    <span class="pl">{label}</span>
    <div class="pc">
      <div class="seg" role="group" aria-label={aria}>
        {#each options as [id, text, hint] (id)}
          <button type="button" class:on={current === id} aria-pressed={current === id} title={hint} onclick={() => pick(id)}>{text}</button>
        {/each}
      </div>
    </div>
  </div>
{/snippet}
<!-- An effect's "More" fold, keyed in `fxMore`. -->
{#snippet moreFold(id, label, tuned, hint)}
  {@render foldHead(`${label} more options`, 'More', !!fxMore[id], () => (fxMore[id] = !fxMore[id]), tuned ? 'set' : '', hint, true)}
{/snippet}

<!-- The head of one item of a multi effect: its switch, its name, then up,
     down, duplicate, the defaults menu and remove. -->
{#snippet fxItemHead(list, i, name, kind, onRemove)}
  {@const item = list[i]}
  <div class="fx-item-head">
    <button
      type="button"
      class="switch"
      class:on={instanceOn(item)}
      role="switch"
      aria-checked={instanceOn(item)}
      aria-label="{name} on"
      title="On: switched off, it is kept and paints nothing"
      onclick={() => setInstanceOn(item, !instanceOn(item))}
    ><span class="knob"></span></button>
    <span class="fx-item-name">{name}</span>
    <span class="fx-item-end">
      <button type="button" class="inst-btn" title="Move up: paints over the one above" aria-label="Move {name} up" disabled={i === 0} onclick={() => moveInstance(list, i, -1)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 15l6-6 6 6" /></svg>
      </button>
      <button type="button" class="inst-btn" title="Move down: paints under the one below" aria-label="Move {name} down" disabled={i >= list.length - 1} onclick={() => moveInstance(list, i, 1)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <button type="button" class="inst-btn" title={roomFor(list) ? 'Duplicate: the copy goes over it' : `At most ${FX_INSTANCES_MAX} of a kind`} aria-label="Duplicate {name}" disabled={!roomFor(list)} onclick={() => duplicateInstance(list, i)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
      </button>
      <FxMenu {kind} {name} onpick={(id) => fxPick(kind, item, name, id)} />
      {@render rmBtn(name.toLowerCase(), onRemove)}
    </span>
  </div>
{/snippet}

<!-- The head of a one-of effect: its switch, its name, the defaults menu. -->
{#snippet fxSwitchHead(fx, kind, title)}
  <div class="switch-row">
    <button
      type="button"
      class="switch"
      class:on={fx.on}
      role="switch"
      aria-checked={fx.on}
      aria-label={title}
      onclick={() => switchFx(kind, fx)}
    ><span class="knob"></span></button>
    <span class="lbl2">{title}</span>
    <span class="fx-menu-end"><FxMenu {kind} name={title} onpick={(id) => fxPick(kind, fx, title, id)} /></span>
  </div>
{/snippet}

<!-- One stroke: how wide, where it sits on the letters' edge, what it is
     filled with, how it mixes. -->
{#snippet strokeItem(k, i)}
  {@const name = `Stroke ${i + 1}`}
  {@const more = `stroke-${i}`}
  <div class="fx-item" class:inst-off={!instanceOn(k)}>
    {@render fxItemHead(box.style.strokeEffects, i, name, 'strokeEffect', () => removeStrokeEffect(i))}
    {@render pxRow('Size', 'How wide the stroke is, from the letters\' edge, page px', k, 'size', `${name} size`, SHADOW_SIZE_MAX, 30, true, 0.5)}
    {@render segRow('Position', 'Where the stroke sits on the letters\' edge', [['outside', 'Outside', 'Round the letters'], ['center', 'Centre', 'Half outside, half inside'], ['inside', 'Inside', 'Within the letters']], k.position, (v) => { k.position = v; touch(); }, `${name} position`)}
    {@render segRow('Fill', 'What the stroke is filled with', [['color', 'Colour'], ['gradient', 'Gradient'], ['pattern', 'Pattern']], k.fill, (v) => { k.fill = v; touch(); }, `${name} fill`)}
    {#if k.fill === 'gradient'}
      {@render fxGradientControls(k.gradient, `${name} gradient`)}
    {:else if k.fill === 'pattern'}
      {@render patternEditor(k.pattern, `${name} pattern`, `strokeEffects.${i}.pattern`, false)}
    {:else}
      <div class="prow">
        <span class="pl">Colour</span>
        <div class="pc">{@render colorField(k, 'color', `${name} colour`)}</div>
      </div>
    {/if}
    {@render pctRow('Opacity', 'Opacity', k, 'opacity', `${name} opacity`)}
    {@render modeRow(k, `${name} blend mode`)}
    {@render moreFold(more, name, k.overprint === true, 'Overprint')}
    {#if fxMore[more]}
      <!-- Overprint is stored and written to the PSD, not painted: PhotoCraft
           paints nothing for it and Photoshop states no rule. Off leaves no
           key, so old files stay as they were. -->
      <label class="sh-check" title="Overprint: a print setting written to the PSD for Photoshop. It changes nothing in how the stroke mixes with the page here">
        <input type="checkbox" checked={k.overprint === true} aria-label="{name} overprint" onchange={(e) => { if (e.target.checked) k.overprint = true; else delete k.overprint; touch(); }} />
        <span>Overprint (Photoshop only)</span>
      </label>
    {/if}
  </div>
{/snippet}

<!-- One Drop Shadow or Inner Shadow. The Global Light is read here so a turn
     of it shows. -->
{#snippet shadowItem(list, i, inner)}
  {@const sh = list[i]}
  {@const name = `${inner ? 'Inner shadow' : 'Shadow'} ${i + 1}`}
  {@const kind = inner ? 'innerShadow' : 'dropShadow'}
  {@const key = inner ? 'choke' : 'spread'}
  {@const angle = (app.typesetting.light?.angle, angleOf(sh))}
  {@const more = `${kind}-${i}`}
  {@const tuned = sh[key] > 0 || sh.noise > 0 || (sh.contour?.preset ?? 'linear') !== 'linear' || (!inner && sh.knockout === false)}
  <div class="fx-item" class:inst-off={!instanceOn(sh)}>
    {@render fxItemHead(list, i, name, kind, () => (inner ? removeInnerShadow(i) : removeShadow(i)))}
    <div class="prow">
      <span class="pl">Colour</span>
      <div class="pc">{@render colorField(sh, 'color', `${name} colour`)}</div>
    </div>
    <div class="prow" title={sh.useGlobalLight ? "The chapter's light: turning it turns every shadow and bevel that uses it" : 'Where the light comes from'}>
      <span class="pl">Angle</span>
      <div class="pc">
        <AngleDial {angle} label="{name} angle" oninput={(v, m) => setShadowAngle(sh, v.angle, m.live)} onend={endLightDrag} />
        <label class="sh-check end" title="Use Global Light: the angle is the chapter's, shared by every shadow and bevel that uses it">
          <input type="checkbox" checked={sh.useGlobalLight} aria-label="{name} uses the global light" onchange={(e) => setShadowGlobal(sh, e.target.checked)} />
          <span>Global</span>
        </label>
      </div>
    </div>
    {@render sliderRow('Distance', 'How far the shadow is thrown, page px', Math.round(shadowDistance(sh) * 100) / 100, (v) => setShadowDistance(sh, v), { max: SHADOW_DISTANCE_MAX, soft: 50, unit: 'px', aria: `${name} distance`, exact: true })}
    {@render pxRow('Size', 'Size: how far the soft edge reaches, page px', sh, 'size', `${name} size`, SHADOW_SIZE_MAX, 50)}
    {@render pctRow('Opacity', 'Opacity', sh, 'opacity', `${name} opacity`)}
    {@render modeRow(sh, `${name} blend mode`)}
    {@render moreFold(more, name, tuned, inner ? 'Choke, noise and contour' : 'Spread, noise, contour and knock out')}
    {#if fxMore[more]}
      {@render pctRow(inner ? 'Choke' : 'Spread', `${inner ? 'Choke' : 'Spread'}: how much of the size is a hard edge`, sh, key, `${name} ${key}`)}
      {@render pctRow('Noise', 'Noise: grain in the shadow', sh, 'noise', `${name} noise`)}
      {@render contourRow(sh, 'contour', `${name} contour`)}
      {#if !inner}
        <label class="sh-check" title="Layer Knocks Out Drop Shadow: the shadow does not show through see-through letters">
          <input type="checkbox" checked={sh.knockout} aria-label="{name} knocked out by the letters" onchange={(e) => { sh.knockout = e.target.checked; touch(); }} />
          <span>Hidden behind see-through letters</span>
        </label>
      {/if}
    {/if}
  </div>
{/snippet}

<!-- Outer Glow or Inner Glow: a colour or a gradient run out from the
     letters' edge. -->
{#snippet glowControls(g, title, inner)}
  {@const kind = inner ? 'innerGlow' : 'outerGlow'}
  {@const tuned = g.technique === 'precise' || Math.abs(g.range - 0.5) > 1e-9 || g.noise > 0 || (g.jitter ?? 0) > 0 || (g.contour?.preset ?? 'linear') !== 'linear'}
  {@render fxSwitchHead(g, kind, title)}
  {#if g.on}
    <div class="fx-body">
      {@render segRow('Fill', 'A flat colour, or a gradient along the glow (its first stop at the letters\' edge)', [['color', 'Colour'], ['gradient', 'Gradient']], g.fill === 'gradient' ? 'gradient' : 'color', (v) => { g.fill = v; touch(); }, `${title} fill`)}
      {#if g.fill === 'gradient'}
        {@render fxGradientControls(g.gradient, `${title} gradient`, false)}
      {:else}
        <div class="prow">
          <span class="pl">Colour</span>
          <div class="pc">{@render colorField(g, 'color', `${title} colour`)}</div>
        </div>
      {/if}
      {@render pxRow('Size', 'How far the glow reaches, page px', g, 'size', `${title} size`, SHADOW_SIZE_MAX, 50)}
      {@render pctRow(inner ? 'Choke' : 'Spread', `${inner ? 'Choke' : 'Spread'}: how much of the size is solid`, g, 'spread', `${title} ${inner ? 'choke' : 'spread'}`)}
      {@render pctRow('Opacity', 'Opacity', g, 'opacity', `${title} opacity`)}
      {#if inner}
        {@render segRow('From', 'Glow in from the letters\' edge, or out from their centre', [['edge', 'Edge'], ['center', 'Centre']], g.source, (v) => { g.source = v; touch(); }, `${title} source`)}
      {/if}
      {@render modeRow(g, `${title} blend mode`)}
      {@render moreFold(kind, title, tuned, 'Technique, range, noise, jitter and contour')}
      {#if fxMore[kind]}
        {@render segRow('Technique', 'Softer blurs the edge; Precise keeps its shape', [['softer', 'Softer'], ['precise', 'Precise']], g.technique, (v) => { g.technique = v; touch(); }, `${title} technique`)}
        {@render sliderRow('Range', 'Range: how much of the falloff the contour spans', pct(g.range), (v) => setFrac(g, 'range', Math.max(1, v)), { min: 1, max: 100, unit: '%', aria: `${title} range` })}
        {@render pctRow('Noise', 'Noise: grain in the glow', g, 'noise', `${title} noise`)}
        {#if g.fill === 'gradient'}
          {@render pctRow('Jitter', "Jitter: scatters the gradient's colours pixel by pixel", g, 'jitter', `${title} jitter`)}
        {/if}
        {@render contourRow(g, 'contour', `${title} contour`)}
      {/if}
    </div>
  {/if}
{/snippet}

<!-- Photoshop's Satin: two soft copies of the letters thrown apart along its
     angle, laid inside the letters where they do not overlap. A silky,
     wavy shading inside the letters. The Rust engine paints it. -->
{#snippet satinControls(sa)}
  {@const tuned = (sa.contour?.preset ?? 'linear') !== 'linear' || sa.invert !== true}
  {@render fxSwitchHead(sa, 'satin', 'Satin')}
  {#if sa.on}
    <div class="fx-body">
      <div class="prow">
        <span class="pl">Colour</span>
        <div class="pc">{@render colorField(sa, 'color', 'Satin colour')}</div>
      </div>
      <div class="prow" title="The angle the two copies are thrown along: the box's own, not the chapter's light">
        <span class="pl">Angle</span>
        <div class="pc"><AngleDial angle={sa.angle} label="Satin angle" oninput={(v) => setVal(sa, 'angle', v.angle)} /></div>
      </div>
      {@render pxRow('Distance', 'How far each copy is thrown, page px (0 draws as 1, as Photoshop does)', sa, 'distance', 'Satin distance', SATIN_DISTANCE_MAX, 50)}
      {@render pxRow('Size', 'How soft the copies are, page px', sa, 'size', 'Satin size', SHADOW_SIZE_MAX, 50)}
      {@render pctRow('Opacity', 'Opacity', sa, 'opacity', 'Satin opacity')}
      {@render modeRow(sa, 'Satin blend mode')}
      {#if satinHidden(box.style)}
        <p class="nofill-note">A dark satin does not show on dark letters. Pick a light colour, or use it on light letters.</p>
      {/if}
      {@render moreFold('satin', 'Satin', tuned, 'Contour and invert')}
      {#if fxMore.satin}
        {@render contourRow(sa, 'contour', 'Satin contour', 'Contour', 'Contour: Satin reads it from its far end, as Photoshop does')}
        <label class="sh-check" title="Invert: lay the inverse of the gap between the copies">
          <input type="checkbox" checked={sa.invert} aria-label="Satin invert" onchange={(e) => { sa.invert = e.target.checked; touch(); }} />
          <span>Invert</span>
        </label>
      {/if}
    </div>
  {/if}
{/snippet}

<!-- Photoshop's Bevel & Emboss: Structure (the shape of the slope), then
     Shading (where the light stands and the two colours it lays). The gloss
     contour, the blend modes, the Contour and the Texture elements wait in
     folds. The Rust engine paints it. -->
{#snippet bevelControls(bv)}
  {@const lit = (app.typesetting.light, bevelLight(bv))}
  {@render fxSwitchHead(bv, 'bevel', 'Bevel & Emboss')}
  {#if bv.on}
    <div class="fx-body">
      {@render secHead('Structure')}
      <div class="prow" title="Style: where the bevel is laid">
        <span class="pl">Style</span>
        <div class="pc">
          <select value={bv.style} aria-label="Bevel style" onchange={(e) => { bv.style = e.target.value; touch(); }}>
            {#each BEVEL_STYLE_OPTIONS as [id, label] (id)}
              <option value={id}>{label}</option>
            {/each}
          </select>
        </div>
      </div>
      {#if bv.style === 'stroke' && !box.style.strokeEffects?.length}
        <p class="nofill-note">Stroke Emboss bevels the strokes (Stroke tab); this box has none.</p>
      {/if}
      {@render segRow('Technique', 'A soft slope, or a cut edge', [['smooth', 'Smooth', 'Smooth'], ['chisel-hard', 'Hard', 'Chisel Hard: a sharp cut edge'], ['chisel-soft', 'Soft', 'Chisel Soft: a rough cut edge']], bv.technique, (v) => { bv.technique = v; touch(); }, 'Bevel technique')}
      {@render segRow('Direction', 'Which side the light falls on', [['up', 'Up', 'Raised'], ['down', 'Down', 'Sunk']], bv.direction, (v) => { bv.direction = v; touch(); }, 'Bevel direction')}
      {@render sliderRow('Depth', 'Depth: how steep the slope is shaded', pct(bv.depth), (v) => setVal(bv, 'depth', v / 100), { max: BEVEL_DEPTH_MAX * 100, soft: 300, unit: '%', aria: 'Bevel depth' })}
      {@render pxRow('Size', 'How wide the slope is, page px (0 draws as 1, as Photoshop does)', bv, 'size', 'Bevel size', SHADOW_SIZE_MAX, 50)}
      {@render pxRow('Soften', 'Blurs the shading, page px', bv, 'soften', 'Bevel soften', BEVEL_SOFTEN_MAX)}

      {@render secHead('Shading')}
      <div class="prow light-row" title={bv.useGlobalLight ? "The chapter's light: moving it moves every shadow and bevel that uses it. It turns with a turned or mirrored box" : 'Where the light stands: its direction, and how high it is (the centre is straight above)'}>
        <span class="pl">Light</span>
        <div class="pc">
          <AngleDial angle={lit.angle} altitude={lit.altitude} label="Bevel light" oninput={(v, m) => setBevelLight(bv, v, m.live)} onend={endLightDrag} />
          <label class="sh-check end" title="Use Global Light: the angle and altitude are the chapter's, shared by every shadow and bevel that uses it">
            <input type="checkbox" checked={bv.useGlobalLight} aria-label="Bevel uses the global light" onchange={(e) => setBevelGlobal(bv, e.target.checked)} />
            <span>Global</span>
          </label>
        </div>
      </div>
      {#each [['highlight', 'Highlight'], ['shadow', 'Shadow']] as [key, label] (key)}
        {@const sh = bv[key]}
        <div class="prow" title="{label}: its colour and opacity">
          <span class="pl">{label}</span>
          <div class="pc">
            {@render swatchCell(sh, 'color', `Bevel ${label.toLowerCase()} colour`)}
            <ValueSlider value={pct(sh.opacity)} max={100} unit="%" label="Bevel {label.toLowerCase()} opacity" oninput={(v) => setFrac(sh, 'opacity', v)} />
          </div>
        </div>
      {/each}
      {@render moreFold('bevel', 'Bevel shading', (bv.gloss?.preset ?? 'linear') !== 'linear' || bv.highlight.blend !== 'screen' || bv.shadow.blend !== 'multiply', 'Gloss contour and the blend modes')}
      {#if fxMore.bevel}
        {@render contourRow(bv, 'gloss', 'Bevel gloss contour', 'Gloss', 'Gloss Contour: reshapes the shading')}
        {@render modeRow(bv.highlight, 'Bevel highlight mode', 'Highlight')}
        {@render modeRow(bv.shadow, 'Bevel shadow mode', 'Shadow')}
      {/if}

      {@render foldHead('Bevel contour', 'Contour', !!fxMore.bevelContour, () => (fxMore.bevelContour = !fxMore.bevelContour), bv.contour.on ? 'on' : '', 'Reshapes the slope')}
      {#if fxMore.bevelContour}
        <div class="switch-row">
          <button type="button" class="switch" class:on={bv.contour.on} role="switch" aria-checked={bv.contour.on} aria-label="Bevel contour" onclick={() => { bv.contour.on = !bv.contour.on; touch(); }}><span class="knob"></span></button>
          <span class="lbl2">Contour</span>
        </div>
        {#if bv.contour.on}
          {@render contourRow(bv.contour, 'curve', 'Bevel contour curve', 'Curve', "Contour: reshapes the bevel's slope")}
          {@render sliderRow('Range', 'Range: kept and written to Photoshop; the engine does not paint it yet', pct(bv.contour.range), (v) => setFrac(bv.contour, 'range', v), { max: 100, unit: '%', aria: 'Bevel contour range' })}
          <p class="nofill-note">Range is not painted yet. In a PSD the curve is not written (Photoshop shows Linear); Range and Anti-aliased are.</p>
        {/if}
      {/if}

      {@render foldHead('Bevel texture', 'Texture', !!fxMore.bevelTexture, () => (fxMore.bevelTexture = !fxMore.bevelTexture), bv.texture.on ? 'on' : '', 'A pattern pressed into the slope')}
      {#if fxMore.bevelTexture}
        <div class="switch-row">
          <button type="button" class="switch" class:on={bv.texture.on} role="switch" aria-checked={bv.texture.on} aria-label="Bevel texture" onclick={() => { bv.texture.on = !bv.texture.on; touch(); }}><span class="knob"></span></button>
          <span class="lbl2">Texture</span>
        </div>
        {#if bv.texture.on}
          {@render patternEditor(bv.texture.pattern, 'Bevel texture pattern', 'bevel.texture.pattern', false)}
          {@render sliderRow('Scale', "Scale, over the pattern's own", pct(bv.texture.scale), (v) => setVal(bv.texture, 'scale', v / 100), { min: 1, max: 1000, soft: 200, unit: '%', aria: 'Bevel texture scale' })}
          {@render sliderRow('Depth', 'Depth: how much the pattern raises the slope; below 0 it carves', pct(bv.texture.depth), (v) => setVal(bv.texture, 'depth', v / 100), { min: -BEVEL_DEPTH_MAX * 100, max: BEVEL_DEPTH_MAX * 100, unit: '%', aria: 'Bevel texture depth' })}
          <label class="sh-check" title="Invert: the pattern's light parts carve instead of raise">
            <input type="checkbox" checked={bv.texture.invert} aria-label="Bevel texture invert" onchange={(e) => { bv.texture.invert = e.target.checked; touch(); }} />
            <span>Invert</span>
          </label>
          <label class="sh-check" title="Link with Layer: the pattern moves with the box; off, it is fixed to the page">
            <input type="checkbox" checked={bv.texture.link} aria-label="Bevel texture linked with the box" onchange={(e) => { bv.texture.link = e.target.checked; touch(); }} />
            <span>Moves with the box</span>
          </label>
          <p class="nofill-note">A textured bevel goes into a PSD as pixels: Photoshop's pattern table cannot be written.</p>
        {/if}
      {/if}
    </div>
  {/if}
{/snippet}

<!-- The Tint (Fill tab): a colour or a gradient over the fill, in a blend
     mode, on the box's top Color or Gradient Overlay (`tintOf`). Overlays
     past it came from an older file: they still paint, and only their
     remove button is offered. -->
{#snippet tintControls(s)}
  {@const tint = tintOf(s)}
  {@const on = !!tint && instanceOn(tint.fx)}
  {@const older = olderOverlays(s)}
  <div class="switch-row" title="Tint: colours the fill in a blend mode (Photoshop's Color or Gradient Overlay)">
    <button type="button" class="switch" class:on role="switch" aria-checked={on} aria-label="Tint" onclick={() => setTint(!on)}><span class="knob"></span></button>
    <span class="lbl2">Tint</span>
  </div>
  {#if on}
    <p class="nofill-note">Colours the fill: try Multiply or Color.</p>
    {@render segRow('Kind', 'A flat colour or a gradient over the fill', [['color', 'Colour'], ['gradient', 'Gradient']], tint.kind, pickTintKind, 'Tint kind')}
    {#if tint.kind === 'gradient'}
      {@render fxGradientControls(tint.fx.gradient, 'Tint gradient')}
    {:else}
      <div class="prow">
        <span class="pl">Colour</span>
        <div class="pc">{@render colorField(tint.fx, 'color', 'Tint colour')}</div>
      </div>
    {/if}
    {@render modeRow(tint.fx, 'Tint blend mode')}
    {@render pctRow('Amount', 'How strong the tint is', tint.fx, 'opacity', 'Tint amount')}
  {/if}
  {#if older.length}
    <div class="sub-head" title="Overlays from an older file. They paint as before; remove them to keep only the tint">
      <span class="sub-name">From older file</span>
    </div>
    <div class="older-list">
      {#each older as o (o.fx)}
        {@const what = `${o.kind === 'color' ? 'colour' : 'gradient'} overlay ${o.i + 1}`}
        <div class="older-row" class:inst-off={!instanceOn(o.fx)}>
          <span class="older-chip" aria-hidden="true" style:background={o.kind === 'color' ? o.fx.color : `linear-gradient(90deg, ${o.fx.gradient.stops.map((st) => st.color).join(', ')})`}></span>
          <span class="older-name">{o.kind === 'color' ? 'Colour' : 'Gradient'} · {blendLabel(o.fx.blend)} · {pct(o.fx.opacity)}%{instanceOn(o.fx) ? '' : ' · off'}</span>
          {@render rmBtn(`older ${what}`, () => removeOlderOverlay(o))}
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

<!-- An effect gradient, as Photoshop's Gradient Overlay and Stroke take one:
     Style, Angle, Scale, Reverse, and its stops. `placed` false hides what a
     glow's gradient does not read (it runs along the glow). -->
{#snippet fxGradientControls(g, title, placed = true)}
  {@const moreKey = `g:${title}`}
  {#if g.type === 'noise'}
    {@const n = g.noise}
    <div class="prow" title="Roughness, %: how many colour steps, and how sharp">
      <span class="pl">Roughness</span>
      <div class="pc">
        <input type="range" min="0" max="100" step="1" value={pct(n.roughness)} aria-label="{title} roughness" oninput={(e) => { n.roughness = +e.target.value / 100; touch(); }} />
        <input type="number" min="0" max="100" step="1" value={pct(n.roughness)} aria-label="{title} roughness, percent" onchange={(e) => { const v = clamp(Math.round(+e.target.value || 0), 0, 100); n.roughness = v / 100; e.target.value = String(v); touch(); }} />
      </div>
    </div>
    <div class="prow" title="Color Model: the channels the colours walk in">
      <span class="pl">Model</span>
      <div class="pc">
        <select value={n.model} aria-label="{title} colour model" onchange={(e) => { n.model = e.target.value; touch(); }}>
          {#each NOISE_MODELS as m (m)}
            <option value={m}>{NOISE_MODEL_LABELS[m]}</option>
          {/each}
        </select>
      </div>
    </div>
    {#each NOISE_CHANNELS[n.model] as ch, i (i)}
      <div class="prow" title="{ch} limits, %: the range this channel may take">
        <span class="pl">{ch}</span>
        <div class="pc">
          <input type="number" min="0" max="100" step="1" value={pct(n.min[i])} aria-label="{title} {ch} limit low, percent" onchange={(e) => setNoiseLimit(n, 'min', i, e)} />
          <span class="axis">to</span>
          <input type="number" min="0" max="100" step="1" value={pct(n.max[i])} aria-label="{title} {ch} limit high, percent" onchange={(e) => setNoiseLimit(n, 'max', i, e)} />
        </div>
      </div>
    {/each}
    <div class="prow">
      <span class="pl"></span>
      <div class="pc">
        <label class="sh-check" title="Restrict Colors: no oversaturated colours">
          <input type="checkbox" checked={n.restrict} aria-label="{title} restrict colours" onchange={(e) => { n.restrict = e.target.checked; touch(); }} />
          <span>Restrict</span>
        </label>
        <label class="sh-check" title="Add Transparency: a random opacity too">
          <input type="checkbox" checked={n.transparency} aria-label="{title} add transparency" onchange={(e) => { n.transparency = e.target.checked; touch(); }} />
          <span>See-through</span>
        </label>
        <button type="button" class="link-btn end" title="A new random seed: a new ramp from the same settings" aria-label="{title} randomize" onclick={() => randomizeNoise(n)}>Randomize</button>
      </div>
    </div>
  {:else}
    <!-- Photoshop's Gradient Editor: opacity stops above the ramp, colour
         stops under it, a midpoint diamond between each two. -->
    <FxGradientEditor {g} {title} onchange={() => touch()} oncolour={setColour} />
  {/if}
  {#if placed}
    <div class="prow" title="Style: the gradient's shape. Shape Burst runs from the edge in">
      <span class="pl">Style</span>
      <div class="pc">
        <select value={g.style} aria-label="{title} style" onchange={(e) => { g.style = e.target.value; touch(); }}>
          {#each FX_GRADIENT_STYLES as st (st)}
            <option value={st}>{FX_STYLE_LABELS[st]}</option>
          {/each}
        </select>
      </div>
    </div>
    <div class="prow" title="Angle, degrees: 90 runs bottom to top, as Photoshop's dial. Reverse: the ramp the other way">
      <span class="pl">Angle</span>
      <div class="pc">
        <input type="number" min="-180" max="180" step="1" value={g.angle} aria-label="{title} angle" onchange={(e) => commitNum(g, 'angle', e, -180, 180)} />
        <label class="sh-check end">
          <input type="checkbox" checked={g.reverse} aria-label="{title} reversed" onchange={(e) => { g.reverse = e.target.checked; touch(); }} />
          <span>Reverse</span>
        </label>
      </div>
    </div>
    <div class="prow" title="Scale, %: how much of the box the ramp spans">
      <span class="pl">Scale</span>
      <div class="pc">
        <input type="range" min="10" max="150" step="1" value={pct(g.scale)} aria-label="{title} scale" oninput={(e) => { g.scale = +e.target.value / 100; touch(); }} />
        <input type="number" min="10" max="150" step="1" value={pct(g.scale)} aria-label="{title} scale, percent" onchange={(e) => { const v = clamp(+e.target.value || 100, 10, 150); g.scale = v / 100; e.target.value = String(v); touch(); }} />
      </div>
    </div>
  {/if}
  <!-- The settings a plain gradient never needs wait in a fold. -->
  {@render foldHead(`${title} more options`, 'More', !!gradMore[moreKey], () => (gradMore[moreKey] = !gradMore[moreKey]), gradTuned(g, placed) ? 'set' : '', 'Noise, smoothness, method, dither and offset', true)}
  {#if gradMore[moreKey]}
    <div class="prow" title="Gradient Type: Solid paints the stops; Noise paints a random ramp made from a seed">
      <span class="pl">Type</span>
      <div class="pc">
        <select value={g.type} aria-label="{title} type" onchange={(e) => { g.type = e.target.value; touch(); }}>
          <option value="solid">Solid</option>
          <option value="noise">Noise</option>
        </select>
      </div>
    </div>
    {#if g.type !== 'noise'}
      <div class="prow" title="Smoothness, %: 0 runs straight from stop to stop, 100 eases through them">
        <span class="pl">Smoothness</span>
        <div class="pc">
          <input type="number" min="0" max="100" step="1" value={pct(g.smoothness ?? 0)} aria-label="{title} smoothness, percent" onchange={(e) => commitAlpha(g, 'smoothness', e)} />
        </div>
      </div>
      <div class="prow" title="Method: the colour space the stops blend in. Classic is how gradients blended before Photoshop 2022">
        <span class="pl">Method</span>
        <div class="pc">
          <select value={g.method ?? 'classic'} aria-label="{title} interpolation method" onchange={(e) => { g.method = e.target.value; touch(); }}>
            {#each FX_GRADIENT_METHODS as m (m)}
              <option value={m}>{FX_METHOD_LABELS[m]}</option>
            {/each}
          </select>
        </div>
      </div>
    {/if}
    {#if placed}
      <!-- Photoshop's Offset: moves the gradient's centre, % of the box. -->
      <div class="prow" title="Offset: moves the gradient's centre, % of the box, or of the page with Follow the box off">
        <span class="pl">Offset</span>
        <div class="pc">
          <span class="axis">X</span>
          <input type="number" min="-100" max="100" step="1" value={pct(g.offset?.[0] ?? 0)} aria-label="{title} offset X, percent" onchange={(e) => setFxGradientOffset(g, 0, e)} />
          <span class="axis">Y</span>
          <input type="number" min="-100" max="100" step="1" value={pct(g.offset?.[1] ?? 0)} aria-label="{title} offset Y, percent" onchange={(e) => setFxGradientOffset(g, 1, e)} />
          <button type="button" class="link-btn end" title="Put the gradient's centre back in the middle" aria-label="{title} reset offset" disabled={!g.offset?.[0] && !g.offset?.[1]} onclick={() => { g.offset = [0, 0]; touch(); }}>Reset</button>
        </div>
      </div>
      <label class="sh-check" title="Dither: a touch of noise so a long, gentle ramp does not band">
        <input type="checkbox" checked={g.dither === true} aria-label="{title} dither" onchange={(e) => { g.dither = e.target.checked; touch(); }} />
        <span>Dither, against banding</span>
      </label>
      <!-- Photoshop's Align with Layer, kept on the gradient only when off.
           Shape Burst runs from the letters' edge and reads no frame: the box
           shows the kept value, greyed, and it applies again when the style
           changes back. -->
      <label class="sh-check" title={g.style === 'shapeburst' ? 'Align with Layer does not apply to Shape Burst, which runs from the letters\' edge. The setting is kept for the other styles.' : 'Align with Layer: on, the gradient spans the letters and turns with the box; off, it spans the whole page under them and stays put when the box moves or turns'}>
        <input type="checkbox" checked={g.align !== false} disabled={g.style === 'shapeburst'} aria-label="{title} align with layer" onchange={(e) => { if (e.target.checked) delete g.align; else g.align = false; touch(); }} />
        <span>Follow the box</span>
      </label>
    {/if}
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

<!-- A fold's head: a part of a pane a plain box never needs, closed until
     asked. The badge says what is inside while it is closed. -->
{#snippet foldHead(label, title, open, toggle, badge, hint, sub = false)}
<!-- svelte-ignore a11y_role_supports_aria_props_implicit -->
  <button type="button" class="insp-fold" class:sub class:open aria-expanded={open} aria-label={label} aria-description={badge ? (badge === 'set' ? 'has settings' : `${badge} inside`) : undefined} title={hint} onclick={toggle}>
    <svg class="fold-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
    <span>{title}</span>
    {#if badge}<span class="fold-badge">{badge}</span>{/if}
  </button>
{/snippet}

<!-- A pattern's tone from the page: the pick, and for an effect the tone the
     fill already took. While the pick waits for its drag, where it reads. -->
{#snippet patActs(p, title, path, fromOverlay, cards)}
  {@const picking = patternPick.active && patternPick.target === path}
  {#if fromOverlay}
    <button type="button" class="link-btn" title="Use the Pattern overlay's own tile" aria-label="{title} use the overlay's tile" onclick={() => usePickedTile(p, box.style.patternOverlay.pattern)}>Use the overlay's tile</button>
  {/if}
  {#if cards}
    <button type="button" class="link-btn" title="Load Photoshop or GIMP pattern files (.pat). Colour patterns keep their colours" onclick={loadPatFiles}>Load .pat…</button>
  {/if}
  <button
    type="button"
    class="link-btn"
    class:on={picking}
    disabled={patternPick.busy || !canPickPattern()}
    title="Drag over a tone on the page; it becomes this pattern"
    aria-label="{title} pick from page"
    onclick={() => pickFromPage(path)}
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 22 1-1h3l9-9" /><path d="M3 21v-3l9-9" /><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" /></svg>
    {patternPick.busy ? 'Reading…' : picking ? 'Drag on the page…' : 'Pick from page'}
  </button>
{/snippet}

<!-- The one pattern editor (PatternEditor.svelte), with the Inspector's own
     extras: the pick from the page, named by `path` (`patternPick.target`). -->
{#snippet patternEditor(p, title, path, cards)}
  {@const hasTile = rustPatterns && !!p.src && p.cell?.length > 0}
  {@const po = box?.style.patternOverlay?.pattern}
  {@const fromOverlay = !cards && !hasTile && po?.kind === 'picked' && !!po.src && po.cell?.length > 0}
  <PatternEditor
    bind:p={() => p, () => {}}
    {title}
    rust={rustPatterns}
    full
    onchange={() => touch()}
    oncolour={setColour}
    kinds={cards ? shownKinds : null}
    cards={cards ? patternCards : null}
    cardTile={CARD_TILE}
    loaded={cards && rustPatterns ? loadedPatterns : null}
    onloaded={pickLoaded}
    onremoveset={(set) => void removePatternSet(set)}
  >
    {#snippet acts()}{@render patActs(p, title, path, fromOverlay, cards)}{/snippet}
    {#snippet note()}
      {#if patternPick.active && patternPick.target === path}
        <label class="sh-check" title="Cleaning often takes the tone away; the raw page still has it">
          <input type="checkbox" checked={patternPick.raw} aria-label="Read the raw page" onchange={(e) => (patternPick.raw = e.target.checked)} />
          <span>Read the raw page, not the cleaned one</span>
        </label>
      {/if}
    {/snippet}
  </PatternEditor>
{/snippet}

{#snippet secHead(title)}
  <div class="insp-sec">{title}</div>
{/snippet}

<!-- Swatch + hex, the one colour idiom in the panel. The label is named by
     the caller, as `swatchCell` does for the list rows - three identical
     "Colour" inputs are three identical names to a screen reader. -->
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
  <div class="insp" onpointerdowncapture={(e) => { armSnap(); holdLive(e); }} onkeydowncapture={armSnap}>
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
    <!-- One grammar down the pane: a property row is its name on the left and
         its control on the right, on one line (`.prow`). Top to bottom: what
         the letters are filled with, that fill's own rows, how see-through it
         is; then the box over the page; then the two folds a plain box never
         needs (overlays, advanced blending). -->
    {#if tab === 'fill'}
      <div class="insp-pane" role="tabpanel" id="insp-pane-fill" aria-labelledby="insp-tab-fill">
        {@render inkGapNote()}
        <div class="seg" role="group" aria-label="Fill">
          <button type="button" class="nofill" class:on={fillMode === 'none'} aria-pressed={fillMode === 'none'} title="No fill" aria-label="No fill" onclick={() => setFillMode('none')}>{@html iconNoFill}</button>
          {#each [['solid', 'Solid'], ['gradient', 'Gradient']] as [m, label] (m)}
            <button type="button" class:on={fillMode === m} aria-pressed={fillMode === m} onclick={() => setFillMode(m)}>{label}</button>
          {/each}
        </div>

        {#if fillMode === 'pattern'}
          <p class="nofill-note">This box has an old pattern fill. Patterns are under Pattern now.</p>
          <button type="button" class="link-btn" onclick={movePatternFill}>Move it to the Pattern overlay</button>
        {:else if fillMode === 'none'}
          <p class="nofill-note">{s.strokeEffects.length ? 'The letters are see-through: their outlines and layer effects show, as a Photoshop layer at Fill 0 % does.' : 'No fill and no stroke: only the layer effects show. Add a stroke or an effect.'}</p>
        {:else if fillMode === 'solid'}
          <div class="prow">
            <span class="pl">Colour</span>
            <div class="pc">{@render colorField(s, 'color', 'Fill colour')}</div>
          </div>
        {:else if fillMode === 'gradient'}
          <!-- The gradient in the order it is built: its shape, its stops (the
               one gradient editor, in its fill form), where it runs, and what
               it spans. -->
          <div class="prow">
            <span class="pl">Shape</span>
            <div class="pc">
              <div class="seg">
                <button type="button" class:on={s.gradient.kind !== 'radial'} aria-pressed={s.gradient.kind !== 'radial'} title="Linear gradient" onclick={() => setGradKind('linear')}>Linear</button>
                <button type="button" class:on={s.gradient.kind === 'radial'} aria-pressed={s.gradient.kind === 'radial'} title="Radial gradient" onclick={() => setGradKind('radial')}>Radial</button>
              </div>
            </div>
          </div>
          <FxGradientEditor flat g={s.gradient} title="Fill gradient" onchange={() => touch()} oncolour={setColour} />
          {#if s.gradient.kind === 'radial'}
            <!-- A style that reached the panel without going through
                 `normalizeStyle` (an old undo snapshot, a hand-edited file) has
                 no radius at all, and an empty number field is a worse answer
                 than the default the renderers would use for it anyway. -->
            {@const rad = Number.isFinite(+s.gradient.radius) ? +s.gradient.radius : 1}
            <div class="prow">
              <span class="pl">Centre</span>
              <div class="pc">
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
              </div>
            </div>
            <div class="prow" title="How far the last stop is from the centre, % of the distance to the far corner">
              <span class="pl">Radius</span>
              <div class="pc">
                <input type="range" min="10" max="400" step="5" value={Math.round(rad * 100)} aria-label="Radius" oninput={(e) => setNum(s.gradient, 'radius', e.target.value / 100, 0.1, 4)} />
                <input type="number" min="10" max="400" step="5" value={Math.round(rad * 100)} aria-label="Radius, percent" onchange={(e) => { const v = clamp(Math.round(+e.target.value) || 100, 10, 400); s.gradient.radius = v / 100; e.target.value = String(v); touch(); }} />
              </div>
            </div>
          {:else}
            <div class="prow" title="0° runs bottom to top, 90° left to right">
              <span class="pl">Angle</span>
              <div class="pc">
                <input type="range" min="0" max="360" step="5" value={Math.round(s.gradient.angle)} aria-label="Gradient angle" oninput={(e) => setNum(s.gradient, 'angle', e.target.value, 0, 360, true)} />
                <input type="number" min="0" max="360" step="5" value={Math.round(s.gradient.angle)} aria-label="Gradient angle, degrees" onchange={(e) => commitNum(s.gradient, 'angle', e, 0, 360, true)} />
              </div>
            </div>
          {/if}
          <div class="prow">
            <span class="pl">Spans</span>
            <div class="pc">
              <div class="seg">
                <button type="button" class:on={s.gradient.scope === 'box'} aria-pressed={s.gradient.scope === 'box'} title="One gradient across the whole block" onclick={() => { s.gradient.scope = 'box'; touch(); }}>Box</button>
                <button type="button" class:on={s.gradient.scope === 'line'} aria-pressed={s.gradient.scope === 'line'} title="Restart the gradient on every line" onclick={() => { s.gradient.scope = 'line'; touch(); }}>Line</button>
              </div>
            </div>
          </div>
        {/if}

        <!-- Photoshop's Fill Opacity: the fill fades, the strokes and the
             shadows stay. The Rust engine paints it. -->
        {#if fillMode !== 'none' && rustBoxes}
          <div class="prow" title="Fades the fill only: strokes and shadows stay">
            <span class="pl">Fill opacity</span>
            <div class="pc">
              <input type="range" min="0" max="100" step="1" value={pct(s.fillOpacity)} aria-label="Fill opacity" oninput={(e) => setAlpha(s, 'fillOpacity', e.target.value)} />
              <input type="number" min="0" max="100" step="1" value={pct(s.fillOpacity)} aria-label="Fill opacity, percent" onchange={(e) => commitAlpha(s, 'fillOpacity', e)} />
            </div>
          </div>
        {/if}

        <div class="insp-rule"></div>

        <div class="prow" title="Fades the whole box: fill, strokes and effects">
          <span class="pl">Box opacity</span>
          <div class="pc">
            <input type="range" min="0" max="100" step="1" value={pct(s.opacity)} aria-label="Opacity" oninput={(e) => setAlpha(s, 'opacity', e.target.value)} />
            <input type="number" min="0" max="100" step="1" value={pct(s.opacity)} aria-label="Opacity, percent" onchange={(e) => commitAlpha(s, 'opacity', e)} />
          </div>
        </div>
        <!-- Photoshop's Blending Options: the box's mode over the page art.
             The Rust engine paints it (LAYER_STYLES_PLAN.md phase 6a). -->
        {#if rustBoxes}
          <div class="prow" title="How the box mixes with the page art under it">
            <span class="pl">Blend mode</span>
            <div class="pc">
              <select value={s.blendMode} aria-label="Box blend mode" onchange={(e) => { s.blendMode = e.target.value; touch(); }}>
                {#each LAYER_BLEND_MODES as m (m)}
                  <option value={m}>{blendLabel(m)}</option>
                {/each}
              </select>
            </div>
          </div>
          {#if FILL_SPECIAL_MODES.includes(s.blendMode) && s.fillOpacity < 1}
            <p class="nofill-note">Fill works as in Photoshop for this mode: it changes the blend, not the coverage.</p>
          {/if}
          {#if usesBackdrop(s)}
            <p class="nofill-note">Blends with the page art.</p>
          {/if}
          <!-- Black letters on white paper look the same in every darkening
               mode: the maths, not a bug (effect-findings.engine.test.js). -->
          {#if DARKEN_MODES.includes(s.blendMode)}
            <p class="nofill-note">Black letters on white paper look the same as Normal in this mode. It shows over grey or coloured art.</p>
          {/if}
        {:else}
          <p class="nofill-note">Fill opacity, blend modes and overlays need the Rust text engine (Settings).</p>
        {/if}

        <!-- The Tint, then the Pattern: what Photoshop's Color, Gradient and
             Pattern Overlay add over the fill, under the strokes. -->
        {@render tintControls(s)}
        {@render foldHead('Pattern', 'Pattern', overlaysOpen, () => (overlaysOpen = !overlaysOpen), patternOn ? 'on' : '', 'A pattern laid over the fill')}
        {#if overlaysOpen}
          {@const po = s.patternOverlay}
          <div class="sub-head" title="The box's pattern: over the fill, under the gradient overlays. At Normal 100 % it is the letters' fill">
            <span class="sub-name">Pattern</span>
            <span class="sub-end">
              <FxMenu kind="patternOverlay" name="Pattern overlay" onpick={(id) => fxPick('patternOverlay', po, 'Pattern overlay', id)} />
              <button
                type="button"
                class="switch"
                class:on={po.on}
                role="switch"
                aria-checked={po.on}
                aria-label="Pattern overlay"
                onclick={() => switchFx('patternOverlay', po)}
              ><span class="knob"></span></button>
            </span>
          </div>
          {#if po.on}
            <div class="fx-block">
              <div class="insp-row k-goverlay">
                <select value={po.blend} aria-label="Pattern overlay blend mode" title="Blend mode" onchange={(e) => { po.blend = e.target.value; touch(); }}>
                  {#each LAYER_BLEND_MODES as m (m)}
                    <option value={m}>{blendLabel(m)}</option>
                  {/each}
                </select>
                <input type="number" min="0" max="100" step="1" value={pct(po.opacity)} aria-label="Pattern overlay opacity" title="Opacity, %" onchange={(e) => commitAlpha(po, 'opacity', e)} />
              </div>
              {@render patternEditor(po.pattern, 'Pattern overlay', 'patternOverlay.pattern', true)}
              <!-- The browser preview's way to a .pat; the app opens its own dialog. -->
              <input type="file" accept=".pat" multiple hidden bind:this={patFileInput} onchange={(e) => { void takePatFiles(e.target.files); e.target.value = ''; }} />
            </div>
          {/if}
        {/if}

        <!-- Advanced Blending: Channels, Blend Interior Effects as Group,
             Transparency Shapes Layer and Blend If are painted (phase 6b).
             Knockout and Blend Clipped Layers as Group are written to the PSD
             and paint nothing here (user decision, phase 6c): they sit apart,
             under their own heading. -->
        {#if rustBoxes}
          {@const inner = s.colorOverlays?.some(instanceOn) || s.gradientOverlays?.some(instanceOn) || s.patternOverlay?.on || s.satin?.on || s.innerGlow?.on}
          {@render foldHead('Advanced blending', 'Advanced blending', blendOpen, () => (blendOpen = !blendOpen), blendTuned ? 'set' : '', 'Channels, Blend If and the Photoshop options')}
          {#if blendOpen}
            <div class="prow" title="Channels: a channel left out shows the page art's">
              <span class="pl">Channels</span>
              <div class="pc" role="group" aria-label="Channels">
                {#each [['r', 'R'], ['g', 'G'], ['b', 'B']] as [k, name] (k)}
                  <label class="sh-check">
                    <input type="checkbox" checked={s.blending?.channels?.[k] !== false} aria-label="Channel {name}" onchange={(e) => setChannel(s, k, e.target.checked)} />
                    <span>{name}</span>
                  </label>
                {/each}
                <span class="end"><FxMenu kind="blending" name="Advanced blending" onpick={(id) => fxPick('blending', s.blending, 'Advanced blending', id)} /></span>
              </div>
            </div>
            <label class="sh-check" title="Blend Interior Effects as Group: Fill opacity also fades the overlays, the satin and the inner glow">
              <input type="checkbox" checked={s.blending?.interior === true} disabled={!inner} aria-label="Blend interior effects as group" onchange={(e) => { s.blending = { ...s.blending, interior: e.target.checked }; touch(); }} />
              <span>Fill opacity fades the inner effects too</span>
            </label>
            <!-- Said where it is set, so an unchanged page is not a mystery. -->
            {#if s.blending?.interior === true && (!inner || (s.fillOpacity >= 1 && !s.noFill))}
              <p class="nofill-note">{inner ? 'Changes nothing at Fill opacity 100 %.' : 'Changes nothing: no overlay, satin or inner glow is on.'}</p>
            {/if}
            <label class="sh-check" title="Transparency Shapes Layer: off, a fill in Color Burn, Linear Burn, Color Dodge, Linear Dodge, Vivid Light, Linear Light, Hard Mix or Difference blends its own see-through edges as Fill does. Written to the PSD; in Photoshop the effects then cover the whole layer, here they stay on the letters">
              <input type="checkbox" checked={blendingSwitch(s.blending, 'transparencyShapes')} aria-label="Transparency shapes layer" onchange={(e) => setBlendingSwitch(s, 'transparencyShapes', e.target.checked)} />
              <span>Transparency shapes layer</span>
            </label>
            {#if !blendingSwitch(s.blending, 'transparencyShapes') && !FILL_SPECIAL_MODES.includes(s.blendMode)}
              <p class="nofill-note">Off changes nothing here in this blend mode, only in Color Burn, Linear Burn, Color Dodge, Linear Dodge, Vivid Light, Linear Light, Hard Mix and Difference.</p>
            {/if}
            <div class="prow" title="Blend If: hide the box where its own colour, or the page art's under it, is outside the sliders">
              <span class="pl">Blend If</span>
              <div class="pc">
                <select value={blendIfChannel} aria-label="Blend If channel" onchange={(e) => (blendIfChannel = e.target.value)}>
                  {#each BLEND_IF_CHANNELS as c (c)}
                    <option value={c}>{BLEND_IF_LABEL[c]}</option>
                  {/each}
                </select>
              </div>
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
            <div class="sub-head sub-apart" title="Saved in the PSD for Photoshop. They change nothing on the page here">
              <span class="sub-name">Photoshop file only</span>
            </div>
            <div class="prow" title="Knockout: written to the PSD for Photoshop. Not painted here: a box blends with the page art only, never with the boxes under it">
              <span class="pl">Knockout</span>
              <div class="pc">
                <select value={s.blending?.knockout ?? 'none'} aria-label="Knockout" onchange={(e) => setKnockout(s, e.target.value)}>
                  {#each KNOCKOUT_MODES as k (k)}
                    <option value={k}>{KNOCKOUT_LABEL[k]}</option>
                  {/each}
                </select>
              </div>
            </div>
            <label class="sh-check" title="Blend Clipped Layers as Group: written to the PSD for Photoshop. A box has no layers clipped to it, so it changes nothing here">
              <input type="checkbox" checked={blendingSwitch(s.blending, 'blendClipped')} aria-label="Blend clipped layers as group" onchange={(e) => setBlendingSwitch(s, 'blendClipped', e.target.checked)} />
              <span>Blend clipped layers as group</span>
            </label>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- ===== Effects ===== -->
    {#if tab === 'effects'}
      <div class="insp-pane" role="tabpanel" id="insp-pane-effects" aria-labelledby="insp-tab-effects">
        {@render inkGapNote()}
        <div class="fx-groups" role="tablist" aria-label="Effects groups">
          {#each EFFECTS_GROUPS as g (g.id)}
            <button
              type="button"
              role="tab"
              id="insp-fxgroup-{g.id}"
              class="fx-group"
              class:on={effectsGroup === g.id}
              aria-selected={effectsGroup === g.id}
              tabindex={effectsGroup === g.id ? 0 : -1}
              onclick={() => setEffectsGroup(g.id)}
              onkeydown={(e) => onGroupKey(e, g.id)}
            >{g.label}</button>
          {/each}
        </div>
        <div class="sub-tabs" role="tablist" aria-label="Effects options">
          {#each groupTabs as t (t.id)}
            <button
              type="button"
              role="tab"
              id="insp-subtab-{t.id}"
              class="sub-tab"
              class:on={effectsTab === t.id}
              aria-selected={effectsTab === t.id}
              tabindex={effectsTab === t.id ? 0 : -1}
              onclick={() => setEffectsSubTab(t.id)}
              onkeydown={(e) => onSubTabKey(e, t.id)}
            >{t.label}</button>
          {/each}
        </div>
        <!-- One note per group for what only the Rust engine paints, rather
             than one under every effect that needs it. -->
        {#if !rustBoxes && effectsGroup === 'styles'}
          <p class="nofill-note">Glow, Satin, Bevel, inner shadows, most shadow settings and strokes that are not plain outlines need the Rust text engine (Settings).</p>
        {/if}
        {#if !wobblePaints && effectsGroup === 'shape'}
          <p class="nofill-note">Wobble needs the Rust text engine (Settings).</p>
        {/if}

        {#if effectsTab === 'stroke'}
          <!-- The strokes: one list, the first on top. Plain ones at the head
               (Outside, a colour, Normal) are the outline both engines lay;
               the rest the Rust engine lays (`outlineRun`). -->
          {@render secHead('Strokes · first on top')}
          <div class="grp">
            {#if !s.strokeEffects.length}
              <div class="insp-none">No stroke.</div>
            {/if}
            <div class="fx-list">
              {#each s.strokeEffects as k, i (k)}
                {@render strokeItem(k, i)}
              {/each}
            </div>
            {@render addBtn('Add stroke', addStrokeEffect, roomFor(s.strokeEffects))}
          </div>
        {/if}

        {#if effectsTab === 'shadow'}
          <!-- Shadows: the first one is painted on top of the rest. -->
          {@render secHead('Shadows · first on top')}
          <div class="grp">
            {#if !s.shadows.length}
              <div class="insp-none">No shadow.</div>
            {/if}
            <div class="fx-list">
              {#each s.shadows as sh, i (sh)}
                {@render shadowItem(s.shadows, i, false)}
              {/each}
            </div>
            {@render addBtn('Add shadow', addShadow, roomFor(s.shadows))}
          </div>
          <!-- Inner shadows: thrown from outside the letters into them. -->
          {@render secHead('Inner shadows · first on top')}
          <div class="grp">
            {#if !s.innerShadows.length}
              <div class="insp-none">No inner shadow.</div>
            {/if}
            <div class="fx-list">
              {#each s.innerShadows as sh, i (sh)}
                {@render shadowItem(s.innerShadows, i, true)}
              {/each}
            </div>
            {@render addBtn('Add inner shadow', addInnerShadow, roomFor(s.innerShadows))}
          </div>
        {/if}

        {#if effectsTab === 'glow'}
          {@render glowControls(s.outerGlow, 'Outer glow', false)}
          <div class="insp-rule"></div>
          {@render glowControls(s.innerGlow, 'Inner glow', true)}
          <div class="insp-rule"></div>
          {@render satinControls(s.satin)}
        {/if}

        {#if effectsTab === 'bevel'}
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
            <!-- Ready-made shapes to start from; each is all smooth points, so a
                 drag on any point keeps the curve flowing. The on-box gizmo does
                 the rest: press the line to add a point and pull it. -->
            <div class="grp">
              <span class="lbl">Start from</span>
              <div class="seg" role="group" aria-label="Path shape">
                {#each [[0, 'Straight', 'A straight line through the middle'], [1, 'Arc', 'One arch'], [2, 'S-curve', 'Up, then down'], [3, 'Wave', 'Three bumps']] as [bumps, label, tip] (bumps)}
                  <button type="button" title={tip} onclick={() => { s.path.pts = wavePath(box.w, box.h, bumps); touch(); }}>{label}</button>
                {/each}
              </div>
            </div>
            <div class="insp-none">Press the line to add a point, then drag it. Double-click a point to make it sharp or smooth. Right-click or Alt-click a point to remove it.</div>
            {@render addBtn('Add point', () => { s.path.pts = insertPathAnchor(s.path.pts); touch(); })}
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

        {#if effectsTab === 'wobble'}
          <!-- Each letter moved up or down and turned by numbers of its own.
               Only the Rust engine paints it, so under the browser engine
               the controls are dimmed and the group's note says why. The
               switch can still turn a wobble off, so a box set under the
               Rust engine is not stuck with one. -->
          {@const wb = s.wobble}
          {@const off = !wb.on || !wobblePaints}
          <div class="switch-row" title="Each letter sits a little high or low and can tilt, like a shaky hand">
            <button
              type="button"
              class="switch"
              class:on={wb.on}
              role="switch"
              aria-checked={wb.on}
              aria-label="Wobble"
              disabled={!wobblePaints && !wb.on}
              onclick={() => { wb.on = !wb.on; touch(); }}
            ><span class="knob"></span></button>
            <span class="lbl2">Wobble</span>
          </div>
          <div class="insp-sub-body" class:disabled={off} style="padding:0;border:none;gap:11px">
            {@render sliderRow('Amount', 'How far a letter sits high or low, percent of the font size', wb.amount, (v) => setVal(wb, 'amount', v), { max: 40, unit: '%', aria: 'Wobble amount', disabled: off })}
            {@render sliderRow('Tilt', 'How far a letter can turn either way, degrees', wb.tilt, (v) => setVal(wb, 'tilt', v), { max: 20, unit: '°', aria: 'Wobble tilt', disabled: off })}
            <div class="prow" title="Which letters go which way. The same seed gives the same wobble">
              <span class="pl">Seed</span>
              <div class="pc seed-pc">
                <input type="number" min="0" max="999" step="1" value={wb.seed} disabled={off} aria-label="Wobble seed" onchange={(e) => commitNum(wb, 'seed', e, 0, 999, true)} />
                <button type="button" class="dice" disabled={off} aria-label="New wobble seed" title="A new seed: the letters go other ways" onclick={() => newSeed(wb, 999)}>
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3.5" y="3.5" width="13" height="13" rx="2.5" /><circle cx="7.2" cy="7.2" r="1" fill="currentColor" stroke="none" /><circle cx="12.8" cy="12.8" r="1" fill="currentColor" stroke="none" /><circle cx="10" cy="10" r="1" fill="currentColor" stroke="none" /></svg>
                </button>
              </div>
            </div>
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
          {@const maskKind = drawKindFor('mask')}
          {@const mk = box.mask}
          {@const maskOn = !!mk?.on}
          {@const link = bubbleLink(box)}
          <div class="switch-row">
            <button
              type="button"
              class="switch"
              class:on={maskOn}
              role="switch"
              aria-checked={maskOn}
              aria-label="Mask"
              onclick={() => {
                setMaskOn(box, page(), !maskOn);
                if (!box.mask?.on && maskKind) clearDrawTool();
              }}
            ><span class="knob"></span></button>
            <span class="lbl2">Mask</span>
          </div>
          <div class="insp-sub-body" class:disabled={!maskOn} style="padding:0;border:none;gap:11px">
            <!-- What the next shape does. Each shape keeps its own. -->
            <div class="seg" role="group" aria-label="Next shape">
              <button
                type="button"
                class:on={drawSettings.mask.op === 'hide'}
                aria-pressed={drawSettings.mask.op === 'hide'}
                disabled={!maskOn}
                title="The next shape hides the text under it"
                onclick={() => (drawSettings.mask.op = 'hide')}
              >Hide</button>
              <button
                type="button"
                class:on={drawSettings.mask.op === 'keep'}
                aria-pressed={drawSettings.mask.op === 'keep'}
                disabled={!maskOn}
                title="The next shape keeps the text under it, and the text outside every keep shape is hidden"
                onclick={() => (drawSettings.mask.op = 'keep')}
              >Keep</button>
            </div>
            <div class="seg" role="group" aria-label="Mask tool">
              {#each MASK_KINDS as [k, label] (k)}
                <button
                  type="button"
                  class:on={maskKind === k}
                  aria-pressed={maskKind === k}
                  disabled={!maskOn}
                  onclick={() => setDrawTool('mask', k)}
                >{label}</button>
              {/each}
            </div>
            {@render sliderRow('Brush size', 'Brush size, page px', drawSettings.mask.size, (v) => (drawSettings.mask.size = v), { min: MASK_BRUSH_MIN, max: MASK_BRUSH_MAX, unit: 'px', aria: 'Brush size', disabled: !maskOn })}
            {#if isComics()}
              <div class="mask-row">
                <button
                  type="button"
                  class="rbtn"
                  class:on={!!link}
                  aria-pressed={!!link}
                  title={link ? 'Stop clipping the text to its bubble' : 'Keep the text inside its bubble outline, and follow the outline when it changes'}
                  onclick={() => clipToBubble(box.id, page())}
                >Clip to bubble</button>
              </div>
              {#if link}
                {@render sliderRow('Inset', 'How far inside the bubble outline the clip runs, page px', link.inset, (v) => slideBubbleInset(box, page(), v), { min: 0, max: BUBBLE_INSET_MAX, unit: 'px', aria: 'Bubble inset' })}
              {/if}
            {/if}
            <div class="insp-none">{MASK_HINT[maskKind] ?? 'Pick a tool, then draw anywhere on the page.'}</div>
            <div class="mask-row">
              <span class="mask-count">{mk?.shapes.length ?? 0} {mk?.shapes.length === 1 ? 'shape' : 'shapes'}</span>
              <button
                type="button"
                class="rbtn"
                disabled={!mk?.shapes.length}
                onclick={() => clearMaskShapes(box, page())}
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

    <!-- The lock and the delete are offered on the first tab only. -->
    {#if tab === 'text'}
      <div class="insp-actions pair">
        <button class="btn-lock" disabled={locked} title="Lock this box: nothing changes it until it is unlocked" onclick={() => setBoxLocked(box.id, true)}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
          Lock box
        </button>
        <button class="btn-danger" disabled={locked} onclick={onDeleteBox}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
          Delete box
        </button>
      </div>
    {/if}
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
    margin-top: 14px;
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
  /* A multi effect item's up, down and duplicate. */
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
  /* The layer effects: a list of items split by hairlines, never boxed
     (the Rows Don't Float Rule); each item a head and its property rows. */
  .fx-list {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .fx-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 0;
    border-top: 1px solid var(--line);
    min-width: 0;
  }
  .fx-item:first-child {
    border-top: none;
    padding-top: 2px;
  }
  /* Off, only the head says so: the rows under it dim, the switch does not. */
  .fx-item.inst-off {
    opacity: 1;
  }
  .fx-item.inst-off > :not(.fx-item-head) {
    opacity: 0.5;
  }
  .fx-item-head {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 28px;
  }
  .fx-item-name {
    font-size: 12px;
    color: var(--text);
  }
  .fx-item-end {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .fx-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .sh-check.indent {
    padding-left: 88px;
  }
  .sh-check.end {
    margin-left: auto;
    min-height: 0;
  }
  /* Advanced Blending: Channels on one row, Blend If's channel menu beside
     its heading, its two sliders under it. */
  /* The centre pad: nine cells, and a cell's POSITION is where the middle of
     the circle goes. */
  .dirpad {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: repeat(3, 22px);
    grid-auto-rows: 22px;
    gap: 2px;
  }
  .dirpad .cell {
    display: grid;
    place-items: center;
    border: 1px solid var(--line2);
    border-radius: 5px;
    background: var(--surface);
    color: var(--t2);
    padding: 0;
    cursor: pointer;
    font-size: 9px;
    font-family: inherit;
    font-variant-numeric: tabular-nums;
  }
  .dirpad .cell.blank {
    border-color: transparent;
    background: transparent;
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
  /* The centre presets say where the middle of the circle goes, so the dot is
     the whole picture. */
  .dirpad .cdot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }

  /* A list's own line inside a fold: its name, and the one thing to do. */
  .sub-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 24px;
  }
  .sub-name {
    font-size: 12px;
    color: var(--text);
  }
  .sub-end {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  /* Overlays from an older file under the Tint: one quiet line each, a chip
     of what it lays, its mode and amount, and remove. */
  .older-list {
    display: flex;
    flex-direction: column;
  }
  .older-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
  }
  .older-row.inst-off .older-chip,
  .older-row.inst-off .older-name {
    opacity: 0.5;
  }
  .older-chip {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px var(--line2);
  }
  .older-name {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 12px;
    color: var(--t2);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The heading of the part that is for the PSD only: a hairline apart. */
  .sub-apart {
    margin-top: 4px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
  }
  .sub-apart .sub-name {
    color: var(--t2);
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

  /* The Effects tab's two rows: the group, then the group's own sub-tabs,
     both in words. Four groups of four or fewer, so every word fits at the
     panel's width. What is picked is a soft fill and nothing else: the same
     weight and size as the rest, so the row does not jump when it changes. */
  .fx-groups {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0;
    border: 1px solid var(--line2);
    border-radius: 7px;
    overflow: hidden;
  }
  .fx-group {
    height: 28px;
    padding: 0 4px;
    border: none;
    background: transparent;
    color: var(--t2);
    font-family: inherit;
    font-size: 11.5px;
    cursor: pointer;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fx-group:not(:last-child) {
    border-right: 1px solid var(--line);
  }
  .fx-group:hover {
    color: var(--text);
  }
  .fx-group.on {
    color: var(--text);
    background: var(--accent-soft);
  }
  .fx-group:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .seed-pc {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .dice {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
  }
  .dice svg {
    width: 15px;
    height: 15px;
  }
  .dice:hover:not(:disabled) {
    color: var(--text);
    background: var(--accent-soft);
  }
  .dice:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .sub-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }
  .sub-tab {
    flex: 1 1 0;
    height: 24px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--t2);
    font-family: inherit;
    font-size: 11.5px;
    cursor: pointer;
    min-width: 0;
    white-space: nowrap;
  }
  .sub-tab:hover {
    color: var(--text);
    background: var(--surface);
  }
  .sub-tab.on {
    color: var(--text);
    background: var(--accent-soft);
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
  /* Clip to bubble while the link stands: a soft fill, no weight change. */
  .mask-row .rbtn.on {
    background: var(--accent-soft);
  }
</style>
