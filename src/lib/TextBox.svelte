<script>
  import {
    app,
    page,
    selectBox,
    markUnsaved,
    fontCssFor,
    boxText,
    beginEdit,
    endEdit,
    lineByN,
    toggleBulkTarget,
    isBulkTarget,
    cloneStyle,
    rememberStyle,
    settleEdits,
    setBoxText,
    setBoxRuns,
    boxRuns,
    refitBox,
    autoFitBoxTo,
    fitGeom,
    followGeom,
    moveGeom,
    moveBoxTo,
    focusPage,
    resizeBox,
    isLongstrip,
    reviewBox,
    reviewOf,
    edgeDragWidthFloor,
    toast,
    boxLocked,
    isTranslateMode,
    fontPreviewing,
  } from './store.svelte.js';
  import { openBoxMenu } from './editor/BoxMenu.svelte';
  import { openFaceMenu } from './editor/FaceMenu.svelte';
  import { typingSel, setTypingSel, clearTypingSel, onEditAway, endEditIfAway, keepsEdit } from './typing-selection.svelte.js';
  import { stripDragYBounds } from './editor/strip.js';

  import { untrack, flushSync } from 'svelte';
  import { resizeBoxMath } from './resize-math.js';
  import { sizingOf, instanceOn, stylePatterns, outlineBands } from './data.js';
  import { record } from './editor/history.svelte.js';
  import {
    createFieldUndo,
    recordFieldEdit,
    resyncField,
    undoField,
    redoField,
    fieldFaces,
    recordFieldFaces,
    caretAfter,
    isAtomicInput,
  } from './editor/field-undo.svelte.js';
  import { copyRuns, editedSpan, runsKey, shiftRuns, patchRuns } from './runs.js';
  import { smoothPath, splitPath, nearestOnPath, toggleSmooth } from './bezier-path.js';
  import { arcLayout, circleLayout, pathLayout, verticalLayout, pathPolyline, removePathAnchor, applyCase, casedRuns, lineFaces, layoutLines, brokenLines, lineIndents, textInset, contentWidth, balloonWidthsFor, inkShiftY, charWidths } from './measure.js';
  import {
    strokeBands,
    rgba,
    gradientCss,
    patternTilePx,
    patternTileCanvas,
    motionBlurPreviewTaps,
    drawClipShapes,
    inkActive,
    drawInk,
    ensureNoisePhase,
    applyTextFilters,
    textFiltersActive,
    OCTAVES,
    TILE_SS,
    resolveShadow,
    shadowSigma,
    usesBackdrop,
    patternFillStyle,
  } from './text-paint.js';
  import { pageArtSrc, artImage, artReady } from './page-art.svelte.js';
  import { warpActive, meshMap, unwarpPoint, unwarpWith } from './warp.js';
  import { paintWarpedBox, renderBoxTexture, paintWarpedTexture, boxNoiseOrigin, boxFootprint } from './exporter.js';
  import { meshWarper } from './warp-paint.js';
  import { boxCandidate, placeBlock, blockReach, keptBreaks, breaksWords, boxHull, lettersInkRect, verticalStyle } from './contain.js';
  import { HANDLE_KINDS, ARM_LENGTH, handleFrame, handlePoint, dragHandle, dragArm, armEnd } from './special.js';
  import { sfxActive, sfxLayout } from './sfx.js';
  import { engineSwitch } from './engine-switch.svelte.js';
  import { isMacKeyboard } from './shortcuts.svelte.js';
  import { PICTURE_MAX_PX, PICTURE_DRAG_PX, pictureDragPx, PICTURE_OFF, pictureScale, pictureKey, pageUnderKey, pageSheet, pageGradientKey, pictureCss, pageCorner, paintBoxPicture, paintPictureTexture, pictureTexture, presentPicture, requestBoxPicture, pictureWorkerReady, schedulePicture, unschedulePicture } from './editor/box-picture.js';
  import { patternTiles } from './pattern-tiles.svelte.js';
  import { displayScale } from './editor/display-scale.svelte.js';
  import { watchNear } from './editor/near-view.js';
  import { drawTool, drawSettings, clearDrawTool, DRAW_TARGETS } from './box-draw-tool.svelte.js';
  import { maskActive, frameKey, maskInBoxFrame, maskOnPage, translateMask, pinnedToPage, modelShapesOnPage, modelShapesFromPage, MASK_SHAPES_MAX } from './box-mask.js';
  import { fadeActive } from './box-fade.js';
  import { paintKey, marksFromPage, marksOnPage, moveMarks, paintRoomFor } from './box-paint.js';
  import { inspectorTab, effectsSubTab } from './inspector-tabs.svelte.js';
  import WarpGizmo from './editor/WarpGizmo.svelte';
  import SfxGizmo from './SfxGizmo.svelte';
  import { sfxLive } from './sfx-live.svelte.js';
  import { crispFor } from './text-edges.svelte.js';
  import { editLive } from './edit-live.svelte.js';
  import { sfxToolOn } from './prefs.svelte.js';
  import LockChip from './LockChip.svelte';
  import { brushArmed } from './brush-tool.svelte.js';
  import { inkTipIds, settleTips } from './brush-tips.js';
  import { liquifySettings } from './liquify-tool.svelte.js';
  import { liquifyMeshGesture, frameScaleFor } from './liquify-mesh.js';
  import { reviewReach, reviewTitle } from './review-label.js';
  import { inkOverhang } from './paint-reach.js';
  import { screenPoint, flipPoint, flipDelta, mirrorTransform, mirrorCss } from './box-frame.js';
  import { editLines, drawEditLines, rawOffset, domPoint, rawEdit, stepChar } from './edit-lines.js';
  import { glyphIndex, rawIndex, glyphsMatch, caretAt, caretNearest, glyphNearest, selectionBoxes, caretKey, wordAt, glyphReach, zoomColumnGlyph, columnKey } from './curve-caret.js';
  import { typeModel } from './type-rows.js';
  import { caretAt as rowCaret, selectionRects, rowExtent, offsetAt, wordPress, linePress, moveCaret, lineDeleteSpan, rawAtDrawn, boundKey, editStops } from './flat-caret.js';

  // pg defaults to current page; longstrip passes explicit page.
  // `shown` and `lazy` are read only while the Rust engine draws (see "the
  // engine's picture" below): `shown` is false for a box on a page the paged
  // view keeps mounted but hidden, and `lazy` is set where most mounted boxes
  // are off screen (the longstrip), so a box waits to be told it is near the
  // viewport before it paints rather than painting and then letting go.
  let { box, pageFrameEl, pg = page(), shown = true, lazy = false } = $props();

  const z = $derived(app.zoom);
  const selected = $derived(app.selectedId === box.id);
  const editing = $derived(app.editingId === box.id);

  // ---- the engine's picture ----
  //
  // With the Rust engine drawing (`engineSwitch.painting`: it is installed for
  // measuring AND its painter is the glyph painter - the one flag, written
  // where the painter is installed), a box at rest is shown as one canvas
  // painted by the exporter, the way a warped box always was: see "the mesh
  // warp" below, which is that path, now the general one. While the engine is
  // starting, has failed, or has no font to measure in, the flag is false and
  // the box is the DOM it always was.
  //
  // A BOX BEING TYPED INTO stays that picture (see "typing into the picture"
  // below): it is painted again from every change, the caret and the selection
  // are drawn over it from the painter's own layout (`typed`, type-rows.js),
  // and the contenteditable holds the text unseen. `typed` is null for a box
  // that cannot be typed into that way - a warped one, whose letters are
  // where the mesh put them, and one the model has no answer for - and the
  // picture then stands down for it here, in `engineWanted`, and nowhere
  // else: it is the contenteditable it is with the switch off. Everything
  // downstream reads `engineShown`, which is that and "its paint did not
  // throw".
  const enginePaints = $derived(engineSwitch.painting);
  const typed = $derived.by(() => {
    if (!enginePaints || !editing || warped) return null;
    // The lines and the faces are read through the measure's own memo, which
    // is not reactive: this is what says they changed.
    app.fontsVersion;
    try {
      // A composition is laid out with the faces the words around it keep
      // (`liveRuns`).
      return typeModel(box, composeText ?? text, liveRuns);
    } catch {
      return null;
    }
  });
  const engineWanted = $derived(enginePaints && (!editing || typed !== null));
  // A PAINT THAT THREW. The picture is painted in an effect, and the painter
  // can refuse: the engine throws for a job it will not paint, and nothing
  // promises it never will. A box must not be left with the last picture it
  // had, or with none, so the box whose paint threw is shown as its DOM text
  // - exactly what it is with the switch off - until what it is painted from
  // changes (`paintFailed` is the key that failed), and then it is tried
  // again. The throw is caught where the paint is called, in the effect, so
  // the other boxes of the same flush are painted as if nothing had happened.
  //
  // A WARPED box too, and it loses its mesh by it: CSS cannot state a mesh,
  // and the painter that refused the engine's picture is the one the old
  // warped paint asks as well, so the choice is its lines unwarped in its
  // frame or nothing at all, and a box nobody can see or press is not a
  // choice. `failed` therefore stands down every picture of the box, the old
  // one included (`pictured`, `warpKey`). Always false with the switch off.
  let paintFailed = $state(null);
  const failed = $derived(enginePaints && paintFailed !== null && wantedKey === paintFailed);
  const engineShown = $derived(engineWanted && !failed);
  // The box is being typed into AS its picture. False with the switch off,
  // and false the moment that picture's paint throws: the box is then its
  // text in the document, in the same editable, with the same caret.
  const typing = $derived(editing && engineShown && typed !== null);
  // Texture px per page px the picture is painted at: the same at every zoom
  // (`pictureScale`), so a zoom repaints nothing and only shows the kept
  // picture again (`presentPic`). Less for a box over the pixel budget
  // (`PICTURE_MAX_PX`).
  const pictureRes = $derived(enginePaints ? pictureScale(s.rotation) : 0);
  // WHILE A HANDLE IS RESIZING THE BOX every frame of the drag is a repaint,
  // and a frame has no time for megapixels. So while moves are arriving
  // (`resizing`, set by the drag in `startTransform`) the picture is painted
  // within a smaller budget (`PICTURE_DRAG_PX`, handed to the paint in the
  // place of the usual one, so it is counted on what is painted). A box
  // inside that budget is painted exactly as at rest.
  //
  // The budget is not in the picture's key - it changes nothing about what
  // the picture is OF - so the paint says what it came out at, and a picture
  // that came out lower than the box has at rest is remembered as soft
  // (`dragSoft`). When the moves stop coming, `settleResize` forgets what was
  // drawn for a soft picture, and the paint effect, which reads `resizing`,
  // paints it once in full; for a box that was never lowered it does nothing.
  //
  // The moves stop coming in more ways than a pointer coming up over the
  // document, and each of them settles it: the pointer cancelled, the window
  // losing the focus (a pointer let go over another window is never heard
  // of), the handle losing the pointer's capture, and the handles going away
  // under the drag (`handlesOn`: the box deselected, which is what Escape
  // does, another box selected, the box typed into). Each of those ends the
  // drag as well (`transformEnd`): a drag whose handles are gone is over, and
  // the box is painted in full.
  let resizing = $state(false);
  // AN SFX GESTURE ON THIS BOX (a drag on its SFX handles, a slider of the
  // SFX panel held down: `sfxLive`, the selected box's) is the same: every
  // frame rewrites the recipe and the picture follows it, so it is painted
  // within the drag budget while the gesture lasts and once in full when it
  // ends (the effect below `sfxGizmoOn`). Its own flag rather than the shared
  // one, so the paint effect is run again by the settle, after what was drawn
  // for a soft picture has been forgotten.
  let sfxDragging = $state(false);
  // A handle being dragged (not the rotation one): the size chip shows.
  let sizingDrag = $state(false);
  let dragSoft = false;
  function settleResize() {
    if (!resizing) return;
    if (dragSoft) warpDrawn = '';
    dragSoft = false;
    resizing = false;
  }
  // WHILE KEYS ARE COMING INTO A BOX TYPED INTO AS ITS PICTURE every key is a
  // repaint too, and it is given the same smaller budget for the same reason
  // (`keying`, set by `keyed` from whatever changes the text of the box being
  // typed into: an edit, an undo, what an IME has in hand). A box under that
  // budget - a balloon at any zoom a display shows it whole at - is painted
  // exactly as it was, the same bytes. A box over it is soft while it is
  // typed into and is painted in full once, `KEY_SETTLE_MS` after the last
  // key, and at once when the edit ends (`settleKeys`, from the editable's
  // teardown, which also leaves no timer behind). The caret and the selection
  // are drawn in page px from the rows, not from the picture, and do not move
  // with any of it. Never set with the switch off.
  const KEY_SETTLE_MS = 150;
  let keying = $state(false);
  let keySoft = false;
  let keyTimer = null;
  function keyed() {
    if (!typing) return;
    pictureEdit = true;
    keying = true;
    clearTimeout(keyTimer);
    keyTimer = setTimeout(settleKeys, KEY_SETTLE_MS);
  }
  function settleKeys() {
    clearTimeout(keyTimer);
    keyTimer = null;
    if (!keying) return;
    if (keySoft) warpDrawn = '';
    keySoft = false;
    keying = false;
  }
  // Whether the box is near the viewport: null until the observer has said.
  //
  // What is watched is not the box's rectangle but what its picture covers
  // (`reachEl`, an element with nothing in it, laid over the picture's
  // footprint). Ink goes past the rectangle - an overflowing line, a curve, a
  // shadow, a mesh - and a box judged by its rectangle let go of ink that was
  // still in view.
  //
  // While the box holds its picture the footprint is the one that paint
  // returned (`paintedReach`). While it has been LET GO there is no paint to
  // return one, and the box goes on changing - more text, another size, a
  // shadow - so the footprint is worked out instead (`boxFootprint`: the
  // layout's arithmetic, no canvas), again whenever what it is made from
  // changes. Kept at the last painted footprint it would be the rectangle of
  // a picture the box no longer has, and ink that grew into view would wait
  // for a scroll to bring the OLD rectangle near. The two are one measure -
  // the paint sizes its canvas by this arithmetic, and only rounds it up to
  // whole pixels - so what is worked out is never larger than what was
  // painted, and a box that came back for it stays. Not worked out on a
  // hidden page, where nothing is watched.
  let reachEl = $state(null);
  let paintedReach = $state(null);
  const keepReach = (g) => {
    const r = paintedReach;
    if (r && r.ox === g.ox && r.oy === g.oy && r.cw === g.cw && r.ch === g.ch) return;
    paintedReach = { ox: g.ox, oy: g.oy, cw: g.cw, ch: g.ch };
  };
  const reach = $derived.by(() => {
    if (!enginePaints) return null;
    if (!shown || engineKey !== PICTURE_OFF) return paintedReach;
    // The lines and the faces are read through the measure's own memo, which
    // is not reactive: these three are what says they changed.
    app.fontsVersion;
    shaped;
    indents;
    return boxFootprint(box, pg);
  });
  let near = $state(null);
  $effect(() => {
    if (!enginePaints || !shown || !reachEl) {
      near = null;
      if (!enginePaints) paintedReach = null;
      return;
    }
    // Asked again each time the page comes back on screen: an observer tells
    // of changes, and "still off screen" after a page turn is not one.
    near = null;
    return watchNear(reachEl, (v) => {
      near = v;
    });
  });
  // Whether the picture may hold pixels at all. Not on a hidden page, and not
  // far off screen; until the observer has spoken a box on the page in front
  // of the user paints (a page turn must not show a frame without its text)
  // and a lazy one waits.
  const pictureOn = $derived(shown && (lazy ? near === true : near !== false));
  const bulkOn = $derived(app.bulk.active);
  const bulkTarget = $derived(isBulkTarget(box.id));
  const s = $derived(box.style);
  const text = $derived(boxText(box, pg));
  // The faces of those words (runs.js), from where `boxText` read them.
  const runs = $derived(boxRuns(box, pg));

  const line = $derived(box.lineN != null ? lineByN(pg, box.lineN) : null);
  const jp = $derived(line?.jp ?? '');
  const isSfx = $derived(line?.type === 'sfx');

  const effSize = $derived(s.size * z);
  const effLs = $derived(s.letterSpacing * z);

  const justify = $derived(
    s.align === 'left' ? 'flex-start' : s.align === 'right' ? 'flex-end' : 'center',
  );
  const alignItems = $derived(
    s.valign === 'top' ? 'flex-start' : s.valign === 'bottom' ? 'flex-end' : 'center',
  );

  const roughId = `rough-${box.id}`;
  const mbId = `mb-${box.id}`;
  const hollowId = `hollow-${box.id}`;

  // The directional smear's tap list: here each tap becomes an feOffset plus
  // an arithmetic accumulate. Offsets are page px, the filter runs in zoomed
  // px, so they scale by the zoom exactly as the blur radius does. The PREVIEW
  // list, not the exporter's full one - every named result in the SVG chain is
  // its own raster surface in WebKit, so the live filter samples the same
  // smear coarser (see motionBlurPreviewTaps).
  const mbTaps = $derived(
    s.motionBlur?.on
      ? motionBlurPreviewTaps(s.motionBlur.x, s.motionBlur.y, s.motionBlur.amount)
      : [],
  );

  // The filter region, sized to what the smear can actually reach instead of a
  // flat 400%. The region is what WebKit allocates every intermediate surface
  // over, so on a large box the fixed margin was paying for megapixels of
  // guaranteed-empty raster per tap. Ink is allowed the same overreach the
  // clip mask grants (MASK_EXPAND page px) plus the furthest tap offset; each
  // side is that in percent of the box, floored at 50% and capped at the old
  // 150% so the region only ever shrinks.
  const mbRegion = $derived.by(() => {
    if (!mbTaps.length) return null;
    let mx = 0;
    let my = 0;
    for (const t of mbTaps) {
      if (Math.abs(t.dx) > mx) mx = Math.abs(t.dx);
      if (Math.abs(t.dy) > my) my = Math.abs(t.dy);
    }
    const side = (reach, size) => Math.min(150, Math.max(50, Math.ceil(((MASK_EXPAND + reach) / Math.max(1, size)) * 100)));
    const px = side(mx, box.w);
    const py = side(my, box.h);
    return { x: `-${px}%`, y: `-${py}%`, w: `${100 + 2 * px}%`, h: `${100 + 2 * py}%` };
  });

  // How far past the box the editor's mask image reaches, page px each side.
  // The mask has to cover overflowing text (a path outside the box, a huge
  // glyph) or CSS masks it to nothing; past this margin, ink is cut off -
  // the price of a finite image, stated once.
  const MASK_EXPAND = 300;

  // The mask as a CSS mask-image, drawn by the same painter the exporter
  // composites with (drawClipShapes), in the box's own frame, which is the
  // frame CSS masks the element in: the keep shapes (the world, with none),
  // less the hide shapes. The shapes are pinned to the page, so a move of the
  // box builds it again.
  //
  // A blob URL, not a data URL, and that is the point of the shape below: a
  // data URL cannot be revoked, so every rebuild left its decoded bitmap in
  // WebKit's image cache with nothing entitled to evict it, and rebuilds
  // happen - auto-fit moves `box.h` while the user types. Two defences here:
  // the canvas extent is bucketed to MASK_STEP so a keystroke-sized resize
  // reuses the standing image (mask-size covers the slack), and when a rebuild
  // does happen the old URL is revoked the moment the new one lands, which is
  // what lets the renderer give the old bitmap back.
  const MASK_STEP = 32;
  // The mask's shapes in the box's own frame (`maskInBoxFrame`), and whether
  // it does anything: what the picture's key, this image and the overlay read.
  const maskOn = $derived(maskActive(box));
  const maskFrame = $derived(maskOn ? maskInBoxFrame(box) : []);
  // Whether the fade does anything (box-fade.js): pinned to the page like
  // the mask, so it is in the picture's key beside it.
  const fadeOn = $derived(fadeActive(box));
  let maskUrl = $state('');
  let maskW = $state(0); // page px the mask image spans, MASK_EXPAND included
  let maskH = $state(0);
  let maskKey = '';
  let maskLive = ''; // non-reactive twin of maskUrl: what revocation acts on
  let maskSeq = 0; // drops a toBlob that lands after a newer build or destroy
  const setMask = (url, w, h) => {
    if (maskLive && maskLive !== url) URL.revokeObjectURL(maskLive);
    maskLive = url;
    maskUrl = url;
    maskW = w;
    maskH = h;
  };
  $effect(() => {
    // Kept while the box is the engine's picture, though the mask is in those
    // pixels and nothing applies this image then. The encode below answers a
    // task later, so an image built when an edit starts leaves the editable
    // on screen unmasked - excluded text shown - until it lands; standing, it
    // is there on the edit's first frame. What stands is a blob URL: the
    // encoded PNG of a flat mask, which nothing decodes until CSS applies it.
    if (!maskOn) {
      maskKey = '';
      maskSeq++;
      setMask('', 0, 0);
      return;
    }
    // While a pictured box is dragged nothing applies this image, and its
    // key changes every frame (the mask stays on the page): it is built
    // again once, when the box is let go.
    if (placeHeld && pictured) return;
    const qz = Math.min(1, Math.max(0.125, Math.round(z * 8) / 8));
    const w = Math.ceil((box.w + MASK_EXPAND * 2) / MASK_STEP) * MASK_STEP;
    const h = Math.ceil((box.h + MASK_EXPAND * 2) / MASK_STEP) * MASK_STEP;
    const key = `${frameKey(box, box.mask)}|${qz}|${w}|${h}`;
    if (key === maskKey) return;
    maskKey = key;
    const shapes = maskFrame;
    const cnv = document.createElement('canvas');
    cnv.width = Math.max(2, Math.round(w * qz));
    cnv.height = Math.max(2, Math.round(h * qz));
    const ctx = cnv.getContext('2d');
    if (!ctx) return;
    ctx.scale(cnv.width / w, cnv.height / h);
    ctx.translate(MASK_EXPAND, MASK_EXPAND);
    if (shapes.some((sh) => sh.op === 'keep')) drawClipShapes(ctx, shapes, 'keep');
    else {
      ctx.fillStyle = '#fff';
      ctx.fillRect(-MASK_EXPAND, -MASK_EXPAND, w, h);
    }
    ctx.globalCompositeOperation = 'destination-out';
    drawClipShapes(ctx, shapes, 'hide');
    const seq = ++maskSeq;
    if (typeof cnv.toBlob === 'function') {
      // Async, so the standing mask holds the frame until the new one is
      // ready - the swap is invisible. A build superseded before its encode
      // lands is dropped unminted.
      cnv.toBlob((b) => {
        if (seq !== maskSeq || !b) return;
        setMask(URL.createObjectURL(b), w, h);
      });
    } else {
      // jsdom and friends: no toBlob, no image cache to leak into either.
      setMask(cnv.toDataURL(), w, h);
    }
  });
  // Reads nothing reactive, so it runs once and its cleanup is the destroy
  // path: the last URL goes back, and the seq bump orphans any encode still in
  // flight.
  $effect(() => {
    return () => {
      maskSeq++;
      if (maskLive) URL.revokeObjectURL(maskLive);
    };
  });
  const maskCss = $derived.by(() => {
    if (!maskOn || !maskUrl) return '';
    const sz = `${maskW * z}px ${maskH * z}px`;
    const pos = `${-MASK_EXPAND * z}px ${-MASK_EXPAND * z}px`;
    return (
      `-webkit-mask-image:url(${maskUrl});mask-image:url(${maskUrl});` +
      `-webkit-mask-size:${sz};mask-size:${sz};` +
      `-webkit-mask-position:${pos};mask-position:${pos};` +
      `-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;`
    );
  });

  // ---- ink ----
  // The strokes, drawn on a canvas over the box. The exporter paints the same
  // strokes with the same painter, so this is a preview of the file rather than
  // an approximation of it. It is sized to the box plus however far the ink
  // reaches outside it - a stroke drawn over the edge must not be cut off here
  // any more than it is on export.
  let inkEl = $state(null);
  // Padded on each side by however far the ink reaches past that edge, with its
  // finish and the filters (`inkOverhang`): a stroke carried past the right or
  // the bottom edge is drawn whole, as the export draws it.
  const inkPad = $derived(inkOverhang(s, box.w, box.h));
  // Where the roughening's grain starts, in box-local page px - the exporter's
  // own answer, so the ink crumples in the field the text does. Only for a box
  // that is both inked and roughened, because it costs a layout.
  const inkNoise = $derived.by(() => {
    if (!inkActive(s.ink) || !s.roughen.on) return null;
    // A font that loads late moves the block, and the grain with it.
    app.fontsVersion;
    return boxNoiseOrigin(box, pg);
  });
  // A shadow, an inner shadow or a bevel on the chapter's Global Light moves
  // when the light does: the light's angle (and, for a bevel, its altitude)
  // is in the key of a box that has one.
  const onLight = (list) => list?.some((sh) => sh.useGlobalLight);
  const lightKey = $derived(
    s.bevel?.on && s.bevel.useGlobalLight
      ? `${app.typesetting.light?.angle ?? 'd'}|${app.typesetting.light?.altitude ?? 'd'}`
      : onLight(s.shadows) || onLight(s.innerShadows)
        ? `${app.typesetting.light?.angle ?? 'd'}`
        : '',
  );
  // The shadows as they are painted, thrown from the light where they follow
  // it; one switched off in the list (`on: false`) paints nothing.
  const cast = $derived.by(() => {
    void lightKey;
    return (s.shadows ?? []).filter(instanceOn).map(resolveShadow);
  });
  // The strokes and shadows are in the key because they are in the picture:
  // they wrap the ink (see `drawInk`), so a change to either repaints it. The
  // blur, the smear and the roughening are run over it (see `paintInk`).
  const inkKey = $derived(
    inkActive(s.ink)
      ? JSON.stringify([s.ink, s.strokeEffects, s.shadows, s.blur, s.motionBlur, s.roughen, inkNoise]) +
          `|${box.w}|${box.h}|${z}|${lightKey}`
      : '',
  );
  let inkDrawn = '';
  let inkLive = null; // non-reactive twin of inkEl: what the pixel release acts on
  // The decoded tips the last paint had in hand, and the sequence number that
  // says which paint is the current one. Neither is reactive: they are read by
  // the paint, not by the effect that schedules it, and making them state would
  // turn "the tips arrived" into a dependency of the effect that asked for them.
  let inkTips = null;
  let inkTipSeq = 0;
  // The roughening filter's phase is measured against the running browser once
  // per session (see text-paint.js), and the measurement is a rasterisation. The
  // first paint of a roughened ink layer or warped box happens before it lands;
  // this is what says the second one is worth its cost and the third is not.
  let noiseSettled = false;

  // Whether two settles answered with the same tips. A repaint is only worth
  // its cost when they did not - the usual case on a live stroke is that the
  // library handed back the identical wrapper it did last frame.
  function sameTips(a, b) {
    if (a === b) return true;
    if (!a || !b || a.size !== b.size) return false;
    for (const [id, tip] of a) if (b.get(id) !== tip) return false;
    return true;
  }

  // The ink canvas, drawn from scratch. `tips` is what the imported brushes
  // stamp with; without it - the first frame, or a brush this install does not
  // have - those strokes draw with the round tip and keep their brush id. The
  // strokes themselves are drawn on the brush board and placed here whole; a
  // box never takes a stroke from the pointer directly.
  function paintInk(el, tips) {
    const pw = box.w + inkPad.l + inkPad.r;
    const ph = box.h + inkPad.t + inkPad.b;
    const w = Math.max(1, Math.round(pw * z));
    const h = Math.max(1, Math.round(ph * z));
    if (el.width !== w) el.width = w;
    if (el.height !== h) el.height = h;
    const ctx = el.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Scaled to the whole pixels the canvas has, not by the zoom: the canvas
    // is stretched to its CSS size (`pw * z`), so ink drawn at the zoom alone
    // landed up to half a pixel off at the far edge, by an amount that changed
    // with every zoom it was repainted at.
    ctx.scale(pw > 0 ? w / pw : z, ph > 0 ? h / ph : z);
    ctx.translate(inkPad.l, inkPad.t);
    drawInk(ctx, s.ink, undefined, tips, s);
    // The whole-text filters, over the ink as the exporter runs them over its
    // composite - the same chain, at the zoom instead of the supersample. The
    // text beside it gets the same three from its CSS filter list; the ink is a
    // canvas and cannot hang that list, so it is filtered in its pixels here.
    // The chain's result is copied back and let go at once: a second
    // zoom-sized canvas per box is not something to keep between paints.
    if (!textFiltersActive(s)) return;
    const o = inkNoise ?? { x: 0, y: 0 };
    const out = applyTextFilters(el, s, z, { x: o.x + inkPad.l, y: o.y + inkPad.t });
    if (out === el) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(out, 0, 0);
    out.width = 0;
    out.height = 0;
  }

  $effect(() => {
    const key = inkKey;
    const el = inkEl;
    if (!el) {
      // The canvas is gone (ink switched off, or the box is being torn down).
      // Hand its pixels back now, and forget what was drawn: switching the same
      // ink back on mints a *new* blank canvas, and a remembered key would let
      // it stay blank.
      if (inkLive) {
        inkLive.width = 0;
        inkLive.height = 0;
        inkLive = null;
      }
      inkDrawn = '';
      // Let go of the tips with the canvas. Holding a decoded bitmap for a box
      // that is not drawing is exactly what the library's lifetime contract is
      // written against.
      inkTips = null;
      inkTipSeq++;
      return;
    }
    inkLive = el;
    if (key === inkDrawn) return;
    // A zoom still moving: the canvas the browser is already scaling to its CSS
    // box is soft, not wrong, and it is repainted the moment the gesture stops -
    // `app.zoomLive` is read here, so clearing it re-runs this effect with the
    // key still unbanked. Repainting per wheel tick meant every sampled point of
    // every stroke, per box, per event. Only once something HAS been drawn: a
    // box that mounts mid-gesture has to paint its first frame here or it stays
    // blank until the user lets go.
    if (app.zoomLive && inkDrawn) return;
    inkDrawn = key;
    // Paint NOW with whatever is already decoded - the tips the last frame
    // settled, usually the same ones - and then re-ask the library, because a
    // tip it dropped between frames has to be read again (see the tip lifetime
    // contract). The second paint happens only when the answer changed, which
    // on a live stroke is the first frame after the brush is picked and no
    // frame after that.
    paintInk(el, inkTips);
    // The roughening's phase lands once per session (see `noiseSettled`); a
    // roughened ink painted before it is repainted once it has.
    const ids = inkTipIds(s.ink);
    const wantNoise = s.roughen.on && !noiseSettled;
    if (!ids.size && !wantNoise) {
      inkTips = null;
      inkTipSeq++;
      return;
    }
    const seq = ++inkTipSeq;
    Promise.all([ids.size ? settleTips(ids) : null, wantNoise ? ensureNoisePhase() : null]).then(
      ([map]) => {
        // A newer paint, a torn-down canvas, or a canvas the effect has since
        // handed its pixels back: in all three this paint is stale.
        if (seq !== inkTipSeq || inkLive !== el || !el.width) return;
        if (wantNoise) noiseSettled = true;
        const before = inkTips;
        inkTips = map ?? null;
        if (wantNoise || !sameTips(before, inkTips)) paintInk(el, inkTips);
      },
      () => {},
    );
  });
  // A box scrolled off the page keeps its canvas alive otherwise, and a chapter
  // of inked boxes is exactly the shape that put 2 GB in the webview before.
  // Reads nothing reactive, so it runs once and its cleanup is the destroy path;
  // it zeroes the twin rather than the binding, which teardown may already have
  // nulled.
  $effect(() => () => {
    if (inkLive) {
      inkLive.width = 0;
      inkLive.height = 0;
      inkLive = null;
    }
    // The tips go with it: a destroyed box must not be the last thing holding a
    // decoded bitmap alive, and a settle still in flight must not paint into a
    // canvas that is gone.
    inkTips = null;
    inkTipSeq++;
  });

  // ---- the mesh warp ----
  //
  // A warped box stops being DOM text. There is no CSS that states a mesh, so
  // the box renders as the exporter's own picture of itself - `paintWarpedBox`
  // is the same `renderBox` call the page composite makes, drawn at the zoom
  // instead of at the export's supersample - and what is on screen is the file
  // by construction rather than by two painters agreeing.
  //
  // This is the substitution the PSD export already makes for a box Photoshop
  // cannot re-render, and it costs the same things: no caret and no selection.
  // See `onDblClick` below. The mask tools still work: their shapes are page
  // px, cut from the picture after the mesh.
  //
  // With the Rust engine drawing, this is how EVERY box at rest is shown
  // (`engineShown`): the same canvas, the same effect, the same release. Two
  // things differ, both in `paintWarp` and the key: the picture is painted
  // once and kept, a zoom only shows it again (`presentPic`), and it is not
  // painted at all for a box nobody can see (`pictureOn`).
  const warped = $derived(warpActive(s, box.w, box.h));
  const pictured = $derived((warped || engineShown) && !failed);
  let warpEl = $state(null);
  let warpGeom = $state(null);
  // Everything the picture is drawn from - the whole style, because a warped
  // box is drawn by the exporter and the exporter reads all of it.
  //
  // The ink block is the one thing NOT stringified here. It is far the heaviest
  // part of a style (a stroke is hundreds of sampled points, and a box can carry
  // many), the key is recomputed on every reactive cycle that touches the box,
  // and `inkKey` above already states exactly that block for the layer this one
  // replaces - it is computed either way, so folding it in costs nothing and
  // says the same thing. Anything the ink can change, it changes there.
  //
  // The engine's picture has a key of its own (`pictureKey`): it leaves out
  // what CSS applies to the finished picture - the turn, the flip, the opacity
  // - so turning a box repaints nothing, and it states the LINES, so a change
  // to how the text breaks repaints whatever caused it and a move, which
  // re-derives the same lines, does not.
  // What else a pattern's picture is painted from: a picked tile that lands
  // after the box first painted, and, for tiles that start at the page's
  // corner, where the box stands on the page (a move slides its tone).
  // A BOX THAT BLENDS WITH THE PAGE (`usesBackdrop`: a blend mode, a shadow
  // or glow in a mode that reads the page) is painted over the page art under
  // it (`backdrop.js`), the art the frame shows (`pageArtSrc`), so where it
  // stands, how it is turned and mirrored and what art is there are in its
  // key - and only its: an ordinary box still repaints nothing on a move.
  // While it is dragged or turned by hand the key is held as the press found
  // it (`underHeld`): the last picture rides along under the pointer, and the
  // box is painted against its new place once, when it is let go.
  const blendsPage = $derived(enginePaints && usesBackdrop(s));
  const artSrc = $derived(blendsPage ? pageArtSrc(pg, app) : null);
  const underLive = $derived(blendsPage ? pageUnderKey(box, pg, artSrc, artReady(artSrc)) : '');
  let underHeld = $state(null);
  const underKey = $derived(underHeld ?? underLive);
  // The art to blend with, as the painter takes it, or null while it loads
  // (its load moves `underLive`, which paints the box again).
  function pageUnder() {
    if (!blendsPage) return null;
    const image = artImage(artSrc);
    if (!image) return null;
    return { image, W: pg.w || image.naturalWidth, H: pg.h || image.naturalHeight, src: artSrc, key: box.id };
  }
  // The page a gradient with Align with Layer off is laid over, once the
  // page's size is known (`pageSheet`), and what of the box's place on it
  // the picture is painted from: a move, a turn or a mirror repaints it live.
  const gradientSheet = $derived(engineWanted ? pageSheet(box, pg, blendsPage ? artImage(artSrc) : null) : null);
  const pageGradLive = $derived(pageGradientKey(box, gradientSheet));
  // Every pattern the box paints counts: the old fill's, the Pattern
  // Overlay's, a pattern stroke's, the bevel's texture (`stylePatterns`).
  const patternTileLive = $derived.by(() => {
    const pats = stylePatterns(s).filter((p) => p.on || p !== s.pattern);
    const tile = pats.some((p) => p.kind === 'picked') ? `t${patternTiles.version}` : '';
    // A bevel texture off Link with Layer is laid from the page's corner too.
    const paged = pats.some((p) => p.anchor === 'page') || (s.bevel?.on && s.bevel.texture?.on && s.bevel.texture.link === false);
    const at = paged ? `@${box.x},${box.y}` : '';
    return tile + at;
  });
  // A box dragged by the pointer keeps both until it is let go (`placeHeld`,
  // as `underHeld` does for the page under it): a picture that follows the
  // box's place would be painted on every move of the drag, in full, and a
  // box with layer effects then trails the pointer by a paint a frame. The
  // last picture rides along and the box is painted once where it lands. A
  // move from anywhere else (the arrow keys, the Inspector's X and Y, a
  // tool) still repaints as it goes.
  let placeHeld = $state(null);
  const pageGradKey = $derived(placeHeld ? placeHeld.grad : pageGradLive);
  const patternTileKey = $derived(placeHeld ? placeHeld.tiles : patternTileLive);
  // Everything of the picture's key but the mask and the fade, and the key
  // itself. A box with a mask or a fade on is painted again as it moves,
  // since they stay on the page while the letters slide under them: their
  // shapes in the box's own frame are in the picture.
  // Nothing else of it changes with a move, so the engine reads the picture
  // before them back (its premask piece) and only lays them again. The key
  // holds each one's revision and what its frame depends on (`frameKey`),
  // never the shapes themselves: a key is built on every move frame.
  const engineRest = $derived(
    engineWanted
      ? pictureOn
        ? pictureKey({
            style: s,
            inkKey,
            // What an IME has in hand is in the picture while it is composed
            // (`composeText`, null at any other time).
            text: composeText ?? text,
            w: box.w,
            h: box.h,
            lines: shaped,
            indents,
            scale: pictureRes,
            fonts: app.fontsVersion,
            tiles: patternTileKey,
            // The faces of the words, which the picture is painted in, moved
            // over what an IME has in hand (`liveRuns`).
            runs: liveRuns,
            light: lightKey,
            // Crisp letter edges, which the painter reads from the setting.
            edges: crispFor(s) ? 'crisp' : '',
            under: underKey,
            page: pageGradKey,
          })
        : PICTURE_OFF
      : '',
  );
  const engineKey = $derived(
    engineRest && engineRest !== PICTURE_OFF && (maskOn || fadeOn)
      ? `${engineRest}${maskOn ? `|M${frameKey(box, box.mask)}` : ''}${fadeOn ? `|F${frameKey(box, box.fade)}` : ''}`
      : engineRest,
  );
  // The key of the picture the box is to be, whichever paint makes it: the
  // engine's, or the old one a warped box has with the switch off (and, with
  // it on, while it is being typed into).
  const wantedKey = $derived(
    engineWanted
      ? engineKey
      : warped
        ? JSON.stringify({ ...s, ink: 0, paint: paintKey(s.paint) }) +
          `|${inkKey}|${text}|${box.w}|${box.h}|${z}|${app.fontsVersion}|${lightKey}` +
          // The faces of the words, which the warped picture is painted in.
          (runs?.length ? `|R${runsKey(runs)}` : '')
        : '',
  );
  const warpKey = $derived(failed ? '' : wantedKey);
  let warpDrawn = '';
  let warpLive = null; // non-reactive twin of warpEl: what the pixel release acts on
  let warpTips = null;
  let warpSeq = 0;

  // What the last paint of this box's picture cost, ms a pixel painted (0
  // until one is timed): the next live paint's budget (`pictureDragPx`).
  let paintCost = 0;

  // THE KEPT PICTURE. What the last paint made, `{ canvas, ox, oy, cw, ch,
  // ss }` (`paintBoxPicture`), held off screen at its own resolution so a zoom
  // can show it again without painting (`presentPic`). Not state: nothing
  // reads it but the two functions below and the paints. `borrowed` is the
  // gizmo's texture, which the gizmo lets go of itself.
  let warpPic = null;
  function releasePic() {
    if (warpPic && !warpPic.borrowed) {
      warpPic.canvas.width = 0;
      warpPic.canvas.height = 0;
    }
    warpPic = null;
  }
  // The kept picture onto the canvas on screen at this zoom, and where the
  // canvas goes (`warpGeom`, which `pictureCss` places it by). An upright,
  // unmirrored box is set on whole device pixels (`presentPicture`).
  function presentPic(el) {
    if (!warpPic || !el) return;
    const page = pageCorner(pageFrameEl);
    const at = !s.rotation && !mirror ? box : null;
    warpGeom = presentPicture(el, warpPic, { z, dpr: displayScale(), page, at, turned: !!(s.rotation % 90) });
    keepReach(warpGeom);
  }
  function keepPic(el, pic) {
    if (warpPic && warpPic.canvas !== pic.canvas) releasePic();
    warpPic = pic;
    presentPic(el);
  }
  // An IME's text is not the box's until the composition ends, so the box
  // is painted with it standing in for its own.
  //
  // A box with a mask or a fade is painted where it stood when the rest of
  // its key last changed (`grainHold`), its mask and fade carried to stay
  // where they are on the page relative to it. The letters are the same wherever the box stands, and
  // what is anchored to the page (the grain of a noise or a glow) stays put
  // under a move as it does for a box with no mask, whose picture a move
  // never repaints: so a move changes only how far the mask has moved, and
  // the engine's premask piece and its raster of the mask are read back. The file is always painted where the box is.
  // The faces go with it, moved over the composed letters (`liveRuns`).
  let grainHold = null;
  // A move drag in hand (`startMove`): its frames alone may read the kept
  // mask between pixels (`liveMove`, wire v24). Every other paint is exact,
  // and the drag let go paints once more without it.
  let moveLive = $state(false);
  const paintedBox = () => {
    let b = editing && composeText != null ? { ...box, text: composeText, runs: liveRuns } : box;
    // Shapes that move with the box need no hold (`pinnedToPage`).
    if ((!maskOn && !fadeOn) || !pinnedToPage(box)) return b;
    if (grainHold?.key !== engineRest) grainHold = { key: engineRest, x: box.x, y: box.y };
    const dx = grainHold.x - box.x;
    const dy = grainHold.y - box.y;
    if (!dx && !dy) return b;
    // The shapes stay as they are (a bubble link's outline is the fit's,
    // which does not move here) and the move goes apart: the engine reads
    // the raster it keeps of them at the move (`pinShiftOf`), and a move
    // frame never walks the shapes.
    return { ...b, x: grainHold.x, y: grainHold.y, pinMove: [dx, dy], ...(moveLive ? { liveMove: true } : {}) };
  };
  // `key` is the picture key this paint is for: the effect's paints have one,
  // and only those may go to the paint worker (`paintFull`). `worker` false
  // paints here whatever the box is: the fallback for a paint the worker did
  // not make.
  function paintWarp(el, tips, key = null, worker = true) {
    if (!engineShown) {
      // The old paint draws straight into the canvas: the engine's kept
      // picture, if there was one, is nobody's now.
      releasePic();
      warpGeom = paintWarpedBox(el, box, pg, z, tips);
      return;
    }
    const live = resizing || sfxDragging;
    // THE FULL PAINT IN THE WORKER. A picture at rest (no drag, no keys: the
    // whole budget) is painted off the main thread where it can be; the live
    // ones stay here, inside a frame, and on screen in the frame they were
    // asked in. A box whose roughening still waits for the session's noise
    // phase is painted here too: the settle after it repaints it here.
    if (key != null && worker && !live && !keying && !(s.roughen?.on && !noiseSettled) && pictureWorkerReady(paintedBox())) {
      paintFull(el, tips, key);
      return;
    }
    // A picture painted now is newer than any on its way from the worker,
    // and than any waiting to be asked for.
    dropFull();
    // The drag budget is what the last paint of this box says fits a frame
    // (`pictureDragPx`): a stack of layer effects has fewer pixels in the hand.
    const shown = warpGeom ? warpGeom.cw * z * warpGeom.ch * z : 0;
    const budget = live || keying ? pictureDragPx(paintCost, shown) : PICTURE_MAX_PX;
    const of = paintedBox();
    const t0 = performance.now();
    const pic = paintBoxPicture(of, pg, pictureRes, tips, budget, pageUnder(), gradientSheet);
    const painted = pic.canvas.width * pic.canvas.height;
    if (painted > 0) paintCost = (performance.now() - t0) / painted;
    // Lower than asked for under the drag's budget: to be painted again when
    // the drag settles (`settleResize`), or the keys do (`settleKeys`).
    dragSoft = live && pic.ss < pictureRes;
    keySoft = keying && pic.ss < pictureRes;
    keepPic(el, pic);
  }

  // ---- the full paint, in the paint worker ----
  //
  // The request waits for one of the few slots every box shares
  // (`schedulePicture`, box-picture.js) as an intent: no texture and no job
  // bytes until its turn. One asked for while this box is waiting takes its
  // place, and one asked for while this box's paint is with the worker waits
  // for it: only the newest is ever painted. Every request and every paint
  // made here takes a number (`fullSeq`), and a result is shown only if it is
  // still the newest, the picture it was asked for is still the one wanted
  // (`warpDrawn`), and the canvas is still this box's - otherwise it is let
  // go. While it is on its way the picture already on screen stays.
  //
  // A paint the worker did not make - refused, or the worker gone - is made
  // here once (`tryPaint` with the worker off); only that failing drops the
  // box to its text (`paintFailedWith`). A worker stopped on purpose is let
  // go, and painted here only while the engine still paints.
  const fullOwner = {};
  let fullSeq = 0;
  function dropFull() {
    fullSeq++;
    unschedulePicture(fullOwner);
  }
  const fullWanted = (el, key, seq) => seq === fullSeq && key === warpDrawn && warpLive === el && !warpDragging;
  function paintFull(el, tips, key) {
    const seq = ++fullSeq;
    schedulePicture(fullOwner, () => sendFull(el, tips, key, seq));
  }
  // The slot's work: a promise that settles when the answer is shown or let
  // go, or null when the slot is not needed.
  function sendFull(el, tips, key, seq) {
    if (!fullWanted(el, key, seq)) return null;
    const req = requestBoxPicture(paintedBox(), pg, pictureRes, tips, PICTURE_MAX_PX, pageUnder(), gradientSheet);
    if (!req) {
      // Not one for the worker after all (a caption, the worker gone).
      tryPaint(el, tips, key, false);
      return null;
    }
    return req.promise.then(
      (res) => {
        if (!fullWanted(el, key, seq)) req.cancel();
        else if (res?.closed) {
          // Stopped on purpose. The engine switch going off has taken the
          // painter away already (`enginePaints`), and its key change
          // repaints the box; the preference turned off leaves the painter,
          // and this picture is painted here.
          req.cancel();
          if (enginePaints) tryPaint(el, tips, key, false);
        } else if (res?.dead) {
          req.cancel();
          tryPaint(el, tips, key, false);
        } else {
          try {
            const pic = req.apply(res);
            const painted = pic.canvas.width * pic.canvas.height;
            if (painted > 0) paintCost = (req.prepMs + (res.ms || 0)) / painted;
            dragSoft = false;
            keySoft = false;
            keepPic(el, pic);
            failSaid = false;
          } catch (err) {
            paintFailedWith(el, key, err);
          }
        }
      },
      () => {
        req.cancel();
        if (fullWanted(el, key, seq)) tryPaint(el, tips, key, false);
      },
    );
  }

  // The paint, for the effect: true when it painted. When it threw, the canvas
  // holds nothing (a half-made picture is not kept), the picture stands down
  // for this key (`paintFailed`, above) and the error is said once for the
  // box, not once a frame of a drag that keeps failing.
  //
  // ONLY WITH THE ENGINE PAINTING. With the switch off the effect calls the
  // paint bare, as it did before there was an engine's picture, and whatever a
  // paint throws leaves the effect as it always has: nothing is released and
  // nothing is logged here that was not before.
  let failSaid = false;
  function tryPaint(el, tips, key, worker = true) {
    if (!enginePaints) {
      paintWarp(el, tips);
      return true;
    }
    try {
      paintWarp(el, tips, key, worker);
      failSaid = false;
      return true;
    } catch (err) {
      paintFailedWith(el, key, err);
      return false;
    }
  }
  function paintFailedWith(el, key, err) {
    el.width = 0;
    el.height = 0;
    releasePic();
    warpGeom = null;
    warpTips = null;
    warpSeq++;
    dropFull();
    if (!failSaid) {
      failSaid = true;
      console.error(`the picture of box ${box.id} could not be painted; it is shown as its text${warped ? ', without its mesh' : ''}`, err);
    }
    paintFailed = key;
  }

  // ---- the gizmo's live drag ----
  //
  // A handle drag changes the MESH forty times a second and changes nothing
  // else: the same type, the same ink, the same blur, smear and mask. Rendering
  // the box per frame would pay for all of that per frame, so the texture is
  // rendered once when the pointer goes down and every move after it re-runs
  // only `warpBoxCanvas` over the cache (see the exporter's `renderBoxTexture` /
  // `paintWarpedTexture`, split out for exactly this).
  //
  // `warpDragging` is what keeps the reactive path out of the way meanwhile:
  // every move writes `warp.pts`, which changes `warpKey`, which would
  // otherwise re-render the whole box a second time per frame.
  let warpDragging = $state(false);
  let warpTex = null;
  const releaseWarpTex = () => {
    if (!warpTex) return;
    warpTex.canvas.width = 0;
    warpTex.canvas.height = 0;
    warpTex = null;
  };
  let warpGpu = null;
  let warpFrameAsk = 0;
  function paintWarpFrame() {
    // No canvas yet on the first move of a mesh that was still identity when
    // the pointer went down: the box only becomes a picture once the mesh
    // deforms, and the effect below paints that first frame as it mounts.
    if (!warpTex || !warpLive) return;
    if (engineShown) keepPic(warpLive, paintPictureTexture(warpTex, box, undefined, warpGpu));
    else warpGeom = paintWarpedTexture(warpLive, warpTex, box, z, warpGpu);
  }
  const warpPainter = {
    begin() {
      // The kept picture may be the last gesture's texture (`borrowed`).
      if (warpPic?.borrowed) warpPic = null;
      warpGpu?.release();
      warpGpu = null;
      releaseWarpTex();
      // Unbent, even where the painter bends the letters itself: a frame of
      // the drag is then one texture warp (a few ms) and not a repaint of
      // every glyph and band. The bent letters are painted once, when the
      // drag ends (`end` forgets what was drawn).
      warpTex = engineShown
        ? pictureTexture(box, pg, warpTips, pictureRes, undefined, true, null, gradientSheet)
        : renderBoxTexture(box, pg, warpTips);
      // The texture goes to the GPU once, and every frame of the drag is one
      // draw call of the mesh over it (`meshWarper`); null where WebGL is not
      // to be had, and the frames are drawn on the canvas as before.
      warpGpu = warpTex && !warpTex.warped ? meshWarper(warpTex.canvas) : null;
      warpDragging = true;
    },
    // A pointer can move several times in one frame (a 120 Hz digitiser, a
    // busy main thread), and every move changes the mesh: the frame is drawn
    // once, from the latest mesh, when the screen is next drawn.
    frame() {
      if (warpFrameAsk) return;
      if (typeof requestAnimationFrame !== 'function') return paintWarpFrame();
      warpFrameAsk = requestAnimationFrame(() => {
        warpFrameAsk = 0;
        paintWarpFrame();
      });
    },
    end() {
      if (warpFrameAsk) cancelAnimationFrame(warpFrameAsk);
      warpFrameAsk = 0;
      if (warpPic?.borrowed) warpPic = null;
      warpGpu?.release();
      warpGpu = null;
      releaseWarpTex();
      // Forget what was drawn, so the effect repaints from the committed (or
      // cancelled) style rather than trusting the last frame of the drag.
      warpDrawn = '';
      warpDragging = false;
    },
  };

  $effect(() => {
    const key = warpKey;
    const el = warpEl;
    const dragging = warpDragging;
    // Read so that a resize settling runs this again (`settleResize`), and
    // the keys settling (`settleKeys`): the key is the same and only what was
    // drawn for it has been forgotten.
    resizing;
    sfxDragging;
    keying;
    moveLive;
    if (!el) {
      // Warp switched off, or the box is going away: hand the pixels back and
      // forget what was drawn, so switching it on again paints the new canvas.
      if (warpLive) {
        warpLive.width = 0;
        warpLive.height = 0;
        warpLive = null;
      }
      releasePic();
      warpDrawn = '';
      warpGeom = null;
      warpTips = null;
      warpSeq++;
      dropFull();
      return;
    }
    warpLive = el;
    // The gizmo owns this canvas while a handle is down - it is painting the
    // cached texture through the new mesh already. The key is banked so the
    // release at pointer-up is what triggers the one authoritative repaint.
    // Only once something HAS been drawn: the first frame of a drag that
    // started from an identity mesh mounts this canvas mid-gesture, and that
    // frame has to be painted here.
    if (dragging && warpDrawn) {
      warpDrawn = key;
      return;
    }
    // A zoom still moving, deferred for the reason the ink layer is - and this
    // one costs more, because the paint is the exporter's whole composite run
    // through the mesh. The key is NOT banked here, unlike the gizmo drag above:
    // nothing else is painting this canvas, so the settle has to find the key
    // still stale and repaint. (The engine's picture is not in this: its key
    // has no zoom in it, and the zoom only shows the kept picture again.)
    // Only a canvas that HOLDS a picture is left to be stretched: one that was
    // let go for being off screen has nothing to stretch, and zooming out is
    // exactly what brings it back into view.
    if (app.zoomLive && warpDrawn && warpDrawn !== PICTURE_OFF) return;
    if (key === warpDrawn) return;
    warpDrawn = key;
    if (key === PICTURE_OFF) {
      // The box is on a hidden page or far off screen: the element stays, its
      // pixels do not, and a settle still in flight must not paint them back.
      el.width = 0;
      el.height = 0;
      releasePic();
      warpGeom = null;
      warpTips = null;
      warpSeq++;
      dropFull();
      return;
    }
    if (!tryPaint(el, warpTips, key)) return;
    const ids = inkTipIds(s.ink);
    const wantNoise = s.roughen.on && !noiseSettled;
    if (!ids.size && !wantNoise) {
      warpTips = null;
      return;
    }
    const seq = ++warpSeq;
    Promise.all([ids.size ? settleTips(ids) : null, wantNoise ? ensureNoisePhase() : null]).then(
      ([map]) => {
        if (seq !== warpSeq || warpLive !== el || !el.width) return;
        if (wantNoise) noiseSettled = true;
        const before = warpTips;
        warpTips = map ?? null;
        if (wantNoise || !sameTips(before, warpTips)) tryPaint(el, warpTips, key);
      },
      () => {},
    );
  });
  // A ZOOM SETTLED, OR THE DISPLAY CHANGED: the kept picture shown again at
  // the new size. A resample, never a paint (`presentPicture`). Not while a
  // pinch is still moving: the page is scaled as one picture then
  // (Canvas.svelte), and the box is shown again once, when it settles. A turn
  // or a mirror, which CSS applies and which repaint nothing, changes how the
  // canvas is set (on device pixels or stretched), so it shows it again too.
  $effect(() => {
    // Only with the engine's picture shown: with the switch off nothing
    // listens to the display at all (display-scale.svelte.js).
    if (!engineShown) return;
    const zoom = z;
    const dpr = displayScale();
    s.rotation;
    mirror;
    const settling = app.zoomLive;
    if (settling || !zoom || !dpr) return;
    untrack(() => {
      if (warpLive && warpPic && warpDrawn && warpDrawn !== PICTURE_OFF) presentPic(warpLive);
    });
  });
  $effect(() => () => {
    if (warpLive) {
      warpLive.width = 0;
      warpLive.height = 0;
      warpLive = null;
    }
    releasePic();
    // A gesture's cached texture is a supersampled footprint; a box destroyed
    // mid-drag must not be the last thing holding one. The two flags go with
    // it: the gizmo's own teardown ends the gesture and calls `end()`, but this
    // box may be the thing being destroyed and the order of the two teardowns is
    // not ours to assume. `warpDragging` left true is the expensive one - it is
    // what holds the reactive repaint off - so it is reset here as well.
    releaseWarpTex();
    warpDragging = false;
    warpDrawn = '';
    warpTips = null;
    warpSeq++;
    // A paint waiting for the worker's slots goes with the box.
    dropFull();
  });

  // ---- the transform gizmo ----
  //
  // Shown while the Effects panel's `transform` sub-tab is the one on screen and
  // this box's warp is switched on - the same shape the mask tools' gate has
  // (selected, not being edited, not under the bulk panel), plus the sub-tab,
  // because handles at every grid point are not something to leave on a box
  // whose controls are not in front of the user.
  //
  // Deliberately NOT gated on `warped`: an untouched mesh IS identity, so the
  // box is not warped yet and the gizmo is the only thing that can make it so.
  // And gated on the brush being down, because an armed brush replaces the
  // whole panel - the sub-tab is not on screen then, whatever it remembers.
  const warpGizmoOn = $derived(
    selected &&
      !editing &&
      !bulkOn &&
      !brushArmed() &&
      !!pageFrameEl &&
      s.warp?.on === true &&
      inspectorTab.id === 'effects' &&
      effectsSubTab.id === 'transform',
  );

  // ---- the SFX handles ----
  //
  // On a selected box laid out as SFX, whatever tab the Inspector is on: the
  // paths and the letters ARE the sound, as the text is a balloon's. The same
  // gate as the transform gizmo's, less the sub-tab, and not while that one is
  // up (both would want the box's middle), nor on a locked box, nor while the
  // SFX beta is switched off. `layout` is the engine's placement having letters.
  const sfxGizmoOn = $derived(
    selected &&
      !editing &&
      !bulkOn &&
      !brushArmed() &&
      !!pageFrameEl &&
      sfxCurve &&
      !!layout &&
      sfxToolOn() &&
      !warpGizmoOn &&
      !boxLocked(box),
  );
  // An SFX gesture on this box, from its press to its commit or cancel: the
  // picture is painted within the drag budget meanwhile, and once in full at
  // the end (`sfxDragging`, above).
  // A control of a style panel held down on this box (`editLive`: a slider of
  // the Inspector, the colour picker's square) is the same gesture: every
  // frame rewrites the style.
  $effect(() => {
    const on = selected && ((sfxLive.on && !!sfxCurve) || editLive.on);
    untrack(() => {
      if (on) {
        if (enginePaints) sfxDragging = true;
        return;
      }
      if (!sfxDragging) return;
      if (dragSoft) warpDrawn = '';
      dragSoft = false;
      sfxDragging = false;
    });
  });
  // The pointer for the SFX handles: the box's own client -> box-local page
  // px (as `maskLocal`), from the page frame's rect the press measured, so a
  // drag's moves do not each measure it again.
  const sfxFrameRect = () => pageFrameEl?.getBoundingClientRect() ?? null;
  function sfxLocal(ev, rect) {
    return flipPoint(screenPoint(ev.clientX, ev.clientY, rect ?? pageFrameEl.getBoundingClientRect(), app.zoom, box), box);
  }

  // The resize and rotate handles are on the box: while it is selected and
  // nothing else has its controls. A resize whose handles go away has had its
  // last frame as far as the picture is concerned (`settleResize`).
  // A locked box has none: nothing on it moves until it is unlocked.
  const locked = $derived(boxLocked(box));
  // ---- the curve path's handles ----
  //
  // The path is edited in its own mode: while the Warp sub-tab is in front and
  // the path is on, its anchors and handles are the box's only controls. The
  // resize handles stand down for it, as they do for the mesh (below): a path
  // runs edge to edge, so its two end anchors sit exactly on the side handles,
  // and two controls in one place is a coin toss over which one a press gets.
  // The box still MOVES by its body.
  const pathGizmoOn = $derived(
    selected &&
      !editing &&
      !bulkOn &&
      !brushArmed() &&
      s.path?.on === true &&
      (s.path.pts?.length ?? 0) >= 2 &&
      inspectorTab.id === 'effects' &&
      effectsSubTab.id === 'warp' &&
      !boxLocked(box),
  );
  // The special effects' points stand them down too (`specialHandles`): a
  // lightning starts on the left edge by default, on the W handle.
  const handlesOn = $derived(selected && !editing && !bulkOn && !warpGizmoOn && !pathGizmoOn && !specialPointsOn && !locked);
  // The end of the handle gesture in flight (`startTransform`), or null.
  let transformEnd = null;
  $effect(() => {
    if (handlesOn) return;
    untrack(() => {
      transformEnd?.();
      settleResize();
    });
  });

  // Padded by the content box's inset - the padding plus the outline's reach
  // (`textInset`, measure.js) - so the flex layout and `text-align` put the block
  // exactly where the exporter and the PSD writer anchor it, with room for its
  // outline inside the box.
  const pad = $derived(textInset(s) * z);
  // The box as shown: the rectangle grown on each side the ink spills past
  // (`boxHull`), as zoomed px for the outline, the handles and the badge to
  // sit on (styles.css reads them as --hl/--ht/--hr/--hb). The rectangle
  // itself is what the text is laid out in, so nothing inside moves.
  const hull = $derived(boxHull(box));
  const hullCss = $derived(
    hull.l || hull.t || hull.r || hull.b
      ? `--hl:${hull.l * z}px;--ht:${hull.t * z}px;--hr:${hull.r * z}px;--hb:${hull.b * z}px;`
      : '',
  );
  const boxStyle = $derived(
    `left:${box.x * z}px;top:${box.y * z}px;width:${box.w * z}px;height:${box.h * z}px;` +
      `padding:${pad}px;${hullCss}` +
      `transform:rotate(${s.rotation}deg);justify-content:${justify};align-items:${alignItems};` +
      `opacity:${s.opacity}`,
  );


  // The font and the block's own metrics: everything that decides WHERE a glyph
  // lands. Every layer of the stack below carries it, because they are copies of
  // the same block and have to lay out identically; what differs between them is
  // only how the glyphs are painted.
  const textStyle = $derived(
    `font-family:${fontCssFor(s.font)};font-weight:${s.bold ? 700 : 400};` +
      `font-style:${s.italic ? 'italic' : 'normal'};text-align:${s.align};` +
      `line-height:${s.lineHeight};font-size:${effSize}px;letter-spacing:${effLs}px;` +
      `text-transform:${s.uppercase ? 'uppercase' : 'none'};`,
  );

  // The whole-text filters, applied to the composite of every layer: the blur,
  // then the directional smear, then roughening's SVG displacement. One
  // `filter` list, in that order, because a roughened edge should be blurred
  // and smeared rather than the other way round - and the exporter runs its
  // three passes in the same order.
  const filterCss = $derived.by(() => {
    const f = [];
    if (s.blur > 0) f.push(`blur(${s.blur * z}px)`);
    if (mbTaps.length) f.push(`url(#${mbId})`);
    if (s.roughen.on) f.push(`url(#${roughId})`);
    return f.length ? `filter:${f.join(' ')};` : '';
  });

  // The paint, as a stack of copies of the same text block: shadows underneath,
  // then one layer per stroke from the outermost in, then the fill on top. It is
  // the exporter's paint order stated in DOM terms, and the reason it is a stack
  // rather than one element is that CSS gives an element ONE text colour and ONE
  // stroke - so a second stroke, or a shadow cast from the strokes rather than
  // from the glyphs, has nowhere else to live.
  //
  // Each layer holds the same lines, so they lay out on top of one another
  // exactly; the first is in normal flow and gives the block its size, and the
  // rest are absolutely positioned over it (see the styles at the foot of this
  // file). A shadow layer's translate and blur do not move its layout box, which
  // is why offsetting it cannot shift the layers stacked on it.
  const layers = $derived.by(() => {
    const out = [];
    const bands = strokeBands(outlineBands(s));
    const cut = !!s.noFill;
    // shadows[0] paints on top of shadows[1], so the list is walked backwards.
    for (let i = cast.length - 1; i >= 0; i--) {
      const sh = cast[i];
      // The shadow's shape is the glyphs plus every stroke, which is exactly
      // what this layer draws: the outermost stroke and the fill, both in the
      // shadow's colour. A CSS `blur()` radius is the gaussian's sigma, the
      // one the shadow's Size stands for (`shadowSigma`).
      //
      // With no fill it is the outermost stroke's outer half alone, and a box
      // with no stroke either casts nothing.
      if (cut && !bands.length) continue;
      let css = cut ? hollowMatte(bands[0].line) : `color:${sh.color};`;
      if (bands.length && !cut) css += `-webkit-text-stroke:${bands[0].line * z}px ${sh.color};`;
      css += `opacity:${sh.opacity};transform:translate(${sh.x * z}px, ${sh.y * z}px);`;
      const f = [];
      if (cut) f.push(`url(#${hollowId}-s${i})`);
      const sigma = shadowSigma(sh.size);
      if (sigma > 0) f.push(`blur(${sigma * z}px)`);
      if (f.length) css += `filter:${f.join(' ')};`;
      out.push({ css, arc: css, line: '', bg: '' });
    }
    bands.forEach((band, i) => {
      // Transparent fill, so what shows of this layer is its stroke alone - and
      // the layers stacked after it (the next stroke in, then the fill) cover
      // the half of it that falls inside the glyph. With no fill nothing would
      // cover the innermost one's, so every stroke is cut to its outer half.
      const css = cut
        ? `${hollowMatte(band.line)}filter:url(#${hollowId}-b${i});`
        : `color:transparent;-webkit-text-stroke:${band.line * z}px ${rgba(band.color, band.opacity)};`;
      out.push({ css, arc: css, line: '', bg: '' });
    });
    out.push(fillLayer());
    return out;
  });

  // ---- no fill ----
  //
  // CSS cannot cut a letter out of its own stroke: `-webkit-text-stroke`
  // straddles the outline, and nothing in CSS erases. So a layer of a box with
  // no fill is drawn as a matte - its stroke in white and the letters in black
  // over it - and an SVG filter (in the markup below) makes the matte's red
  // channel the layer's alpha and floods it with the colour the layer was to
  // have. What is left is the stroke's outer half, which is what the exporter
  // leaves when it takes the letters out of the bands with `destination-out`.
  // One filter per layer, because the colour is in the filter.
  const hollowMatte = (line) => `color:#000;-webkit-text-stroke:${line * z}px #fff;paint-order:stroke fill;`;
  const hollowDefs = $derived.by(() => {
    if (!s.noFill || engineShown) return [];
    const bands = strokeBands(outlineBands(s));
    if (!bands.length) return [];
    return [
      ...bands.map((b, i) => ({ id: `${hollowId}-b${i}`, color: b.color, opacity: b.opacity })),
      ...cast.map((sh, i) => ({ id: `${hollowId}-s${i}`, color: sh.color, opacity: 1 })),
    ];
  });

  // The topmost layer: the fill. A gradient or a pattern is painted as the
  // layer's background and clipped to the glyphs, which needs the text itself to
  // be transparent; scope 'line' moves that background onto each line instead,
  // so it restarts on every wrapped line.
  //
  // `arc` and `bg` are the curved path's halves of the same thing. Curved text
  // is a set of absolutely positioned spans, and a background clipped to text on
  // their container does not reach them - so the background goes on each span,
  // and the markup gives it the box's size and an offset for that glyph, which
  // is what makes one gradient run across the whole word instead of restarting
  // on every letter.
  const CLIP = '-webkit-background-clip:text;background-clip:text;';

  // One tile's data URL, remembered. Rebuilding it means drawing a canvas and
  // then base64ing it, and `fillLayer` is re-run for every style change and
  // every zoom tick - so a pinch gesture used to encode a fresh PNG per frame
  // per patterned box. Keyed on everything the tile is drawn from, with the zoom
  // quantised to an eighth: the tile is a raster CSS resamples anyway, so a
  // hair's difference in the resolution it was drawn at cannot be seen.
  let tileMemo = { key: '', url: '' };
  function patternTileUrl(fs) {
    const qz = Math.max(0.125, Math.round(z * 8) / 8);
    const key = JSON.stringify([fs.pattern, fs.size, qz]);
    if (tileMemo.key === key) return tileMemo.url;
    const cnv = patternTileCanvas(fs, TILE_SS * qz);
    const url = cnv ? cnv.toDataURL() : '';
    tileMemo = { key, url };
    return url;
  }

  function fillLayer() {
    // No fill wins over both. The layer stays, because the first layer of the
    // stack is the one that gives the block its size.
    if (s.noFill) return { css: 'color:transparent;', arc: 'color:transparent;', line: '', bg: '' };
    // The DOM lays no layer effects: a plain Pattern Overlay is the fill here.
    const fs = patternFillStyle(s);
    if (fs.pattern.on) {
      const tile = patternTileUrl(fs);
      if (tile) {
        const px = patternTilePx(fs) * z;
        const bg = `background-image:url(${tile});background-repeat:repeat;${CLIP}`;
        return {
          css: `color:transparent;${bg}background-size:${px}px ${px}px;`,
          arc: 'color:transparent;',
          line: '',
          bg,
          tile: px,
        };
      }
    }
    if (s.gradient.on) {
      const bg = `background-image:${gradientCss(s.gradient)};${CLIP}`;
      return {
        css: s.gradient.scope === 'line' ? 'color:transparent;' : `color:transparent;${bg}`,
        arc: 'color:transparent;',
        line: s.gradient.scope === 'line' ? bg : '',
        bg,
        tile: 0,
      };
    }
    return { css: `color:${s.color};`, arc: `color:${s.color};`, line: '', bg: '' };
  }

  // What the box looks like while it is being typed into: one editable element,
  // so the caret and the selection behave. A stack of copies has no caret, so the
  // editor shows the outermost stroke and the shadows as CSS can state them on a
  // single element and the full paint comes back the moment the edit ends.
  const editStyle = $derived.by(() => {
    const bands = strokeBands(outlineBands(s));
    // No fill is typed as its outermost stroke with nothing in it, and the
    // caret, which takes the text's colour, is given the one the fill had.
    // With no stroke either there would be nothing to see of what is typed,
    // so that box is typed in its colour.
    const ink = s.noFill && bands.length ? `transparent;caret-color:${s.color}` : s.color;
    let css = `${textStyle}color:${ink};`;
    if (bands.length)
      css += `-webkit-text-stroke:${bands[0].line * z}px ${bands[0].color};paint-order:stroke fill;`;
    // `text-shadow`'s blur radius is TWICE the gaussian's sigma (CSS states it
    // that way, as does a canvas `shadowBlur`), while `filter: blur()` is the
    // sigma itself - so it is doubled here and not on the display layer above,
    // and both come out at the same softness.
    if (cast.length)
      css += `text-shadow:${cast
        .map((sh) => `${sh.x * z}px ${sh.y * z}px ${2 * shadowSigma(sh.size) * z}px ${rgba(sh.color, sh.opacity)}`)
        .join(',')};`;
    return css + filterCss;
  });

  // Glyph-by-glyph layout, when one applies: the bezier path when it is on and
  // has a curve to follow, else the closed circle, else the arc. All three
  // return the same shape, so the markup below draws any of them without
  // knowing which.
  //
  // While it is typed into too (`curveEdit`), from the text being typed: the
  // box draws the glyphs the result draws, with the caret and the selection
  // drawn on them, and the text itself in an editable nobody sees. Not when
  // uppercasing changes the number of characters, so that a glyph is no longer
  // a character of the text: that box is typed into flat, as it always was.
  //
  // SFX lettering comes before all three (`placeBlock`'s precedence) and exists
  // only while the Rust engine is installed. The engine is module state, so
  // `enginePaints` is read to make a switch of engines re-derive this.
  const sfxCurve = $derived.by(() => {
    enginePaints;
    return sfxActive(s);
  });
  // Vertical text is set in columns glyph by glyph, below the bends.
  const columns = $derived(!sfxCurve && verticalStyle(s));
  const curved = $derived(!!(sfxCurve || (s.path?.on && (s.path.pts?.length ?? 0) >= 2) || s.circle?.on || s.curve || columns));
  const curveEdit = $derived(editing && curved && glyphsMatch(text, applyCase(text, s)));
  // An IME's text is not the box's until the composition ends, but it is on
  // the curve while it is being composed: the editable holds it by then.
  let composeText = $state(null);
  // What the composition began on: the text, and the raw range the IME was
  // given (`onCompositionStart`).
  let composeFrom = null;
  // The faces of the words while an IME composes: the box's own runs moved
  // over the composed letters as the edit at its end will move them (the
  // range it was given, `editedSpan`; a guess from the text when that does not
  // explain it), so the rest of the box keeps its faces and its line breaks.
  // The box's runs at any other time.
  const liveRuns = $derived(composeText == null ? runs : (shiftRuns(runs, composeFrom?.v ?? text, composeText, composeFrom ? (editedSpan(composeFrom.v, composeText, composeFrom.a, composeFrom.b) ?? undefined) : undefined) ?? null));
  const layout = $derived.by(() => {
    if ((editing && !curveEdit) || !curved) return null;
    const t = applyCase(editing ? (composeText ?? text) : text, s);
    if (t === '') return null;
    const sfxGlyphs = sfxCurve ? sfxLayout(t, s, effSize) : null;
    if (sfxGlyphs?.length) return sfxGlyphs;
    if (s.path?.on && (s.path.pts?.length ?? 0) >= 2) return pathLayout(t, s, effSize, box.w, box.h);
    if (s.circle?.on) return circleLayout(t, s, effSize);
    if (columns) return verticalLayout(t, s, effSize, box.w, box.h);
    return arcLayout(t, s, effSize);
  });

  // The lines this box draws, and the ONLY thing that draws them: the editor
  // renders what `layoutLines` returns rather than handing the raw text to the
  // browser, so what is on the canvas is what the exporter puts in the file -
  // including the leading and trailing blank lines that function drops. While
  // it is being typed into too (`editSegs`), so the text does not jump when
  // the edit ends - except curved text, which is not broken into lines at all
  // and is typed on its curve (or flat).
  const shaped = $derived.by(() => {
    if (layout || (editing && curved)) return null;
    // Invalidate breaks when fonts load.
    app.fontsVersion;
    // The lines an outline fit chose, while they are this text's, face's and
    // size's (`brokenLines`); otherwise line breaking from the box's
    // dimensions and balloon fit.
    const opts = breaksWords(box) ? { breakWords: true } : undefined;
    if (!runs) {
      const cased = applyCase(text, s);
      return brokenLines(cased, s, s.size, keptBreaks(box)) ?? layoutLines(cased, s, s.size, contentWidth(box.w, s), balloonWidthsFor(box, s, s.size), opts);
    }
    // Words in several faces: broken by the faces' widths (`casedRuns`), and
    // drawn in them (`lineCuts` below, and the picture's job).
    const c = casedRuns(text, runs, s);
    return (
      brokenLines(c.text, s, s.size, keptBreaks(box), c.runs) ??
      layoutLines(c.text, s, s.size, contentWidth(box.w, s), balloonWidthsFor(box, s, s.size), { ...opts, runs: c.runs })
    );
  });

  // How far each flush line is set in from the edge it is aligned to, to its
  // balloon row's own edge (`lineIndents`): the number the exporter draws each
  // line's x from and the PSD indents each paragraph by. Unzoomed, and null for
  // every box that sets none in - centred text, no balloon, plain wrapping -
  // which then draws exactly as it always did. A line's padding on its aligned
  // side, so its row is still the content box and a line-scoped gradient spans
  // what the exporter's does.
  const indents = $derived.by(() => {
    if (!shaped) return null;
    app.fontsVersion;
    return lineIndents(shaped, s, s.size, contentWidth(box.w, s), balloonWidthsFor(box, s, s.size));
  });
  const indentCss = (i) => (indents ? `padding-${s.align}:${indents[i] * z}px;` : '');
  // Each line's stretches in their faces (`lineFaces`), for a layout with runs:
  // the line drawn as one span per stretch, each with its weight and slant, so
  // the browser draws what it measured - each stretch alone. Null for every
  // line of a box without runs, which is drawn as the one string it was.
  const faceCss = (st) => `${st.font !== s.font ? `font-family:${fontCssFor(st.font)};` : ''}font-weight:${st.bold ? 700 : 400};font-style:${st.italic ? 'italic' : 'normal'};`;
  const lineCuts = $derived(shaped?.runs ? shaped.map((_, i) => lineFaces(shaped, i, s)?.map((p) => ({ ...p, css: faceCss(p.style) })) ?? null) : null);

  // How far the centred block moves so its INK, not its line boxes, is centred
  // in the box - the exporter's `inkShiftY`. Measured at the page size and
  // zoomed, never measured at the zoomed size: WebKit answers the font's
  // ascent and descent in whole pixels (23 at 26px type, 24 at 1% more), so a
  // shift measured at each zoom moved the text against the box by up to two
  // page px as the zoom changed - the shake a pinch showed. Zero for any other
  // `valign` and for curved text, which is placed glyph by glyph from the box
  // centre, typed into or not. While curved text is typed into flat there are
  // no shaped lines, so the typed paragraphs stand in: their first ascender
  // and last descender are the ones that decide the shift, and measuring them
  // keeps the text from jumping when the edit starts and ends.
  const inkShiftPage = $derived.by(() => {
    if (s.valign !== 'middle' || layout || curveEdit) return 0;
    const lines = shaped ?? (editing ? applyCase(text, s).split('\n') : null);
    return lines ? inkShiftY(lines, s, s.size) : 0;
  });
  const inkShift = $derived(inkShiftPage * z);
  // In the unflipped frame, inside the mirror (which is the clip wrapper's -
  // see `wrapMirror`): the export centres the block on its ink and then flips
  // the finished picture, so a vertically mirrored block is shifted the other
  // way on the page, and here it is too.
  const stackTransform = $derived(inkShift ? `transform:translateY(${inkShift}px);` : '');

  // ---- what a screen reader is told while the box is the engine's picture ----
  //
  // With the switch off the words are text nodes and are read as such. As a
  // picture they are pixels on a canvas that is hidden from the accessibility
  // tree, so the box says them itself: its text as its name, and the role a
  // name needs (one on a plain div is not announced). Only then - typed into,
  // or with the switch off, the text is in the document and a name over it
  // would be read twice.
  const spoken = $derived(engineShown && !editing && text ? text : null);

  // ---- what takes the pointer while the box is the engine's picture ----
  //
  // With the switch off the letters are elements, and a press on one selects
  // the box wherever the letter is - outside the frame too, where an arc or an
  // overflowing block puts it. The picture's canvas takes no pointer and must
  // not: its footprint is the ink plus padding on every side, and it would
  // take presses meant for whatever lies under that padding. So while the box
  // is a picture, transparent targets stand where the letters' elements stood:
  // one per glyph of a curve (in the markup, from `layout`), and for straight
  // text one rectangle - only when it reaches past the box, since inside it
  // the box is the target already. The rectangle is the block's line boxes
  // and its glyphs' ink together (`blockReach`): the picture is cut to hold
  // the ink, so a letter that leans out of the frame while its advance stays
  // inside is on screen out there, and is pressed there. Not for a warped
  // box: its letters are where the mesh carried them, and it had no such
  // targets before either.
  const hitsOn = $derived(engineShown && !warped && !editing);
  const hitBlock = $derived.by(() => {
    // Not for a family only being looked at: the box is not pressed while a
    // font picker has the keys, and placing the block again costs a frame.
    if (!hitsOn || !shaped || fontPreviewing(box.id)) return null;
    app.fontsVersion;
    const r = blockReach(placeBlock(boxCandidate(box, text, runs)));
    if (!r || !(r.x1 > r.x0) || (r.x0 >= 0 && r.y0 >= 0 && r.x1 <= box.w && r.y1 <= box.h)) return null;
    return r;
  });
  // A glyph's element with the switch off is its advance wide and a line high.
  const hitLine = $derived(effSize * (s.lineHeight > 0 ? s.lineHeight : 1));

  // Reactive auto-fit effect for text metrics.
  //
  // The box's height follows its line count, and this component has just worked
  // that line count out in order to draw with it. So the count is handed over
  // rather than derived a second time: `shaped` and `autoFitBox` used to call
  // `layoutLines` with byte-identical arguments, one after the other, on every
  // box on the page on every page turn - a full duplicate shaping pass, measured
  // at ~59ms of a turn's 100 with the typesetting beta on.
  //
  // `shaped` is read TRACKED, which is what makes this correct rather than
  // merely fast: it is derived from exactly the inputs listed below, so the
  // effect can no longer run against a line count from before the change that
  // woke it. It cannot loop either - `shaped` reads the text, the style and
  // `box.w`, and `autoFitBoxTo` / `growToFit` is grow-only and writes `box.h`
  // only when it actually changes.
  //
  // `shaped` is null only for a curved box (glyphs along an arc, never
  // wrapped), drawn or being typed into. It falls back to `refitBox`, the same
  // grow-only net, which for a curve is the verdict alone. Never the solver or
  // the ladder: sizing a box is the store's, on the edits that call for it
  // (ARC-1), and a component that re-sized boxes as it rendered them would
  // resize every box it drew.
  $effect(() => {
    text;
    box.w;
    box.h;
    s.font;
    s.size;
    s.lineHeight;
    s.letterSpacing;
    s.uppercase;
    s.bold;
    s.italic;
    s.valign;
    s.shape;
    s.minOrphan;
    s.hyphenate;
    s.autoHeight;
    // Both halves of the balloon fit: the shape itself, and the switch that says
    // whether to lay out to it. Either changing changes the line count, which is
    // the box's height.
    s.balloon;
    box.fit;
    app.fontsVersion;
    const lines = shaped;
    // A family only being looked at in a font picker grows nothing: the box
    // is put back as it was when the look ends (`previewBoxFont`).
    if (fontPreviewing(box.id)) return;
    untrack(() => (lines ? autoFitBoxTo(box, lines.length, pg) : refitBox(box, pg)));
  });

  // The "needs review" flag as every reader sees it: the containment check's,
  // or the solver's while the solve it came from still stands (`reviewOf`).
  const review = $derived(reviewOf(box, pg));

  // Mirror flip transform for text.
  const mirror = $derived(mirrorTransform(s));
  // The same flip on an overlay of stored points - the path and mask gizmos -
  // about the box's centre, so a handle sits on the part of the flipped
  // picture it moves (see box-frame.js).
  const overlayMirror = $derived(mirrorCss(s, box.w * z, box.h * z));
  // The flip, as the export makes it: of the box's FINISHED picture - type,
  // ink, and the mask already cut out of them - about the box's centre
  // (`paintBoxOnPage` mirrors the bitmap `renderBox` composited, the mask
  // included). So it goes on the clip wrapper, whose border box is the box and
  // which carries the mask: a CSS mask is applied in the element's own frame,
  // before its transform, which is the export's order. It used to sit on the
  // text alone, under the mask, so a mask cut the flipped text where the
  // unflipped text is cut on export, and the ink was not flipped at all.
  // Not while typing: the caret gets the text the right way round. Unless it
  // is typed into as its picture (`typing`): the picture is the result, the
  // flip included, and the caret and the selection are drawn in its frame.
  const wrapMirror = $derived(mirror && (!editing || typing) ? `transform:${mirror};` : '');

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  // Track active pointer gesture AbortControllers.
  const live = new Set();
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
  });

  function onBoxPointerDown(e) {
    if (editing) return;

    if (e.button !== 0) return;

    focusPage(pg);
    if (bulkOn) {
      e.stopPropagation();
      toggleBulkTarget(box.id);
      return;
    }
    if (e.target.classList.contains('handle')) return;
    e.stopPropagation();
    if (!selected) selectBox(box.id);
    // Selected, so the Inspector shows it and its lock, and not moved.
    if (locked) return;
    startMove(e);
  }

  // The right button: select the box and open its menu (FLOW-9). Not while it
  // is typed into, where the system's Cut / Copy / Paste is the menu wanted
  // (`typeMenu`, and the context-menu guard lets it through on an editable),
  // nor while the Bulk panel is picking boxes, where a press means "this box".
  // The guard in App.svelte has already kept the webview's own menu away.
  function onBoxContextMenu(e) {
    if (editing || bulkOn || isTranslateMode()) return;
    e.preventDefault();
    e.stopPropagation();
    focusPage(pg);
    if (!selected) selectBox(box.id);
    openBoxMenu(box.id, e.clientX, e.clientY);
  }

  function onDblClick(e) {
    e.stopPropagation();
    focusPage(pg);
    // A warped box has no text element to put a caret in - it is one canvas -
    // so the edit is refused rather than opened onto something invisible. The
    // Effects panel's Reset (or switching the warp off) gives the box back.
    if (warped) return;
    beginEdit(box.id);
  }

  function startMove(e) {
    e.preventDefault();

    e.currentTarget.setPointerCapture?.(e.pointerId);

    settleEdits();
    const zz = app.zoom;
    const dims = pg;
    const stripBounds = isLongstrip() ? stripDragYBounds(app.pages, dims.id, box.h) : null;
    const pid = e.pointerId;
    const sx = e.clientX, sy = e.clientY, ox = box.x, oy = box.y;

    const pageId = dims.id;
    // The box moves alone; its balloon fit stays on the bubble (`moveBoxTo`).
    const before = moveGeom(box);
    // A box that blends with the page keeps its picture until it is let go.
    if (blendsPage) underHeld = underLive;
    placeHeld = { grad: pageGradLive, tiles: patternTileLive };
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const x = clamp(ox + (ev.clientX - sx) / zz, -box.w + 20, dims.w - 20);
      const y = stripBounds
        ? clamp(oy + (ev.clientY - sy) / zz, stripBounds.min, stripBounds.max)
        : clamp(oy + (ev.clientY - sy) / zz, -box.h + 20, dims.h - 20);
      moveBoxTo(box, x, y, pg);
      if ((maskOn || fadeOn) && pinnedToPage(box)) moveLive = true;
      markUnsaved();
    };

    const ac = new AbortController();
    const stop = () => {
      live.delete(ac);
      ac.abort();
      underHeld = null;
      placeHeld = null;
      // The last frame may have read the mask between pixels: one paint at
      // rest, exact, where the box was let go.
      if (moveLive) {
        warpDrawn = '';
        moveLive = false;
      }

      if (box.x !== before.x || box.y !== before.y) {
        // The mask stays on the page, so a move changes what a keep shape
        // lets the check count.
        if (maskOn) reviewBox(box, pg);
        record({ t: 'move', pageId, boxId: box.id, before, after: moveGeom(box) });
      }
    };
    const end = (ev) => {
      if (ev.pointerId === pid) stop();
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
    // The two endings no pointerup tells of, as a resize has them
    // (`startTransform`): the window losing the focus, and the capture lost.
    // Without them the box went on following the pointer, and the pictures
    // held above stayed held until the next click.
    window.addEventListener('blur', stop, { signal: ac.signal });
    document.addEventListener('lostpointercapture', end, { signal: ac.signal });
  }

  function startTransform(e, dir) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    focusPage(pg);
    if (!selected) selectBox(box.id);
    settleEdits();
    const zz = app.zoom;
    const pid = e.pointerId;
    const sx = e.clientX, sy = e.clientY;

    // The rectangle and the size, and the solver's record: a width drag locks the
    // width and re-sets the text in it, and the undo has to take both back.
    const o = fitGeom(box);
    // A mask or fade that moves with the box, which a scale scales.
    const followStart = dir === 'rot' ? null : followGeom(box);
    const isRot = dir === 'rot';
    const hasInk = !!(box.style?.ink?.on && box.style?.ink?.strokes?.length);
    const inkBefore = hasInk ? cloneStyle(box.style).ink : null;

    const dims = pg;
    const pageId = dims.id;
    // Rotation gesture records style edit.
    const styleBefore = isRot ? cloneStyle(box.style) : null;
    // A box that blends with the page is turned on its last picture and
    // painted against the page once, when the handle is let go.
    if (isRot && blendsPage) underHeld = underLive;
    // And one whose picture follows its turn on the page (`placeHeld`).
    if (isRot) placeHeld = { grad: pageGradLive, tiles: patternTileLive };

    const fitBefore = isRot ? { y: box.y, h: box.h } : null;
    const cx = () => box.x + box.w / 2;
    const cy = () => box.y + box.h / 2;
    // The size is the same all through a drag that does not scale, and so is
    // its widest word.
    const wFloor = isRot ? 40 : edgeDragWidthFloor(box, pg);
    // The style as the press found it: what a Cmd-drag scales from, and what
    // a drag that changed the style - a scale, or Auto height giving way to
    // Fixed - is recorded against.
    const styleStart = isRot ? null : cloneStyle(box.style);
    let hyphenSaid = false;

    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      if (isRot) {
        if (!pageFrameEl) return;
        const r = pageFrameEl.getBoundingClientRect();
        const mx = (ev.clientX - r.left) / zz, my = (ev.clientY - r.top) / zz;
        let ang = (Math.atan2(my - cy(), mx - cx()) * 180) / Math.PI + 90;
        if (ang > 180) ang -= 360;
        else if (ang < -180) ang += 360;
        if (ev.shiftKey) {
          ang = Math.round(ang / 15) * 15;
          if (ang > 180) ang -= 360;
          else if (ang < -180) ang += 360;
        }
        box.style.rotation = clamp(Math.round(ang), -180, 180);
      } else {
        // Transform pointer delta into box coordinate space.
        const rad = (-(s.rotation || 0) * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const sdx = (ev.clientX - sx) / zz, sdy = (ev.clientY - sy) / zz;
        const dx = sdx * cos - sdy * sin, dy = sdx * sin + sdy * cos;
        // The box has no height handle: its height is its text's. The bottom
        // edge changes the size - the box and the text by one factor, so the
        // lines stay the lines they were - and a corner is the bottom edge
        // and a side at once: its up and down the size, its sideways the
        // width. A left or right edge changes the width and never the size:
        // the text breaks again in what it leaves (resize-math.js).
        const scale = dir === 's' || dir.length > 1;
        // The width floor the store holds the box to, worked out here too so
        // the opposite edge stays put when it stops the drag (resize-math.js):
        // never narrower than the text can break to (`edgeDragWidthFloor`,
        // which hyphenates). Fit to box has none - its size gives way. Never
        // above the width the press found: a box already narrower than its
        // floor does not jump wider when a side is pulled in.
        const wf = sizingOf(box.style) !== 'fit' ? Math.min(wFloor, o.w) : 40;
        const geom = resizeBoxMath(dx, dy, dir, o, s.rotation, 30, wf, { scale });
        // From the first move, not from the press: a handle pressed and let
        // go changes nothing and must repaint nothing.
        if (enginePaints && handlesOn) resizing = true;
        sizingDrag = true;
        resizeBox(
          pageId,
          box.id,
          geom,
          { w: o.w, h: o.h, style: styleStart, ...(inkBefore ? { ink: inkBefore } : null) }
        );
        // A width pulled below the widest word turns hyphenation on for the
        // box (`resizeBox`): said once, as the box changes.
        if (!hyphenSaid && styleStart.hyphenate === false && box.style.hyphenate !== false) {
          hyphenSaid = true;
          toast('Hyphenation turned on for this box');
        }
      }
    };

    const ac = new AbortController();
    // Every ending of the gesture, once, committed as it stands: the pointer
    // let go or cancelled (`end`), and the ways the moves stop without either
    // (below).
    const finish = () => {
      if (ac.signal.aborted) return;
      live.delete(ac);
      ac.abort();
      if (transformEnd === finish) transformEnd = null;
      underHeld = null;
      placeHeld = null;
      settleResize();
      sizingDrag = false;
      // Both gestures on this handle CHANGE THE STYLE - the rotation handle
      // writes `rotation`, a corner writes `size` - and the next box placed is
      // meant to follow the box the user just shaped. Nothing else on this path
      // touches `lastStyle` (the Inspector's `touch` covers only edits made in
      // the panel), so without this a rotate-then-place produced the style of
      // some earlier box. At the END of the gesture, not during: the style is
      // settled here, and remembering per pointermove would clone it per frame.
      rememberStyle(box);
      if (isRot) {
        const after = cloneStyle(box.style);
        if (after.rotation !== styleBefore.rotation) {
          markUnsaved();
          record({
            t: 'style',
            pageId,
            boxId: box.id,
            before: styleBefore,
            after,
            geomBefore: fitBefore,
            geomAfter: { y: box.y, h: box.h },
          });
        }
        return;
      }
      // A drag that changed the style - a scale, or Auto height made Fixed -
      // is recorded with it, so one undo puts back the outline, the tracking
      // and the sizing mode as well as the rectangle.
      const styleAfter = cloneStyle(box.style);
      if (JSON.stringify(styleAfter) !== JSON.stringify(styleStart)) {
        markUnsaved();
        record({ t: 'style', pageId, boxId: box.id, before: styleStart, after: styleAfter, geomBefore: { ...o, ...followStart }, geomAfter: { ...fitGeom(box), ...followGeom(box) } });
        return;
      }
      const before = { ...o };
      if (inkBefore) before.ink = inkBefore;
      const after = fitGeom(box);
      if (box.style?.ink?.on) after.ink = cloneStyle(box.style).ink;
      const geomKeys = ['x', 'y', 'w', 'h', 'size'];
      if (geomKeys.some((k) => after[k] !== before[k])) {
        markUnsaved();
        record({ t: 'resize', pageId, boxId: box.id, before, after });
      }
    };
    const end = (ev) => {
      if (ev.pointerId === pid) finish();
    };
    // The capture lost: on the handle, or - once the handle has left the
    // document, which is where the event then goes - on the document itself.
    const lost = (ev) => {
      if (ev.pointerId === pid && (ev.target === handle || !handle.isConnected)) finish();
    };

    transformEnd?.();
    transformEnd = finish;
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
    // The ways the moves stop without either of those, and each of them ends
    // the gesture: the window losing the focus (a pointer let go over another
    // window is never heard of), the handle losing the pointer's capture, and
    // the handles going away under the drag (`handlesOn`: Escape deselecting,
    // another box selected, the box typed into - it calls `transformEnd`).
    // Left open, the gesture had no button behind it any more, and the next
    // moves over the page went on turning or sizing the box on hover.
    window.addEventListener('blur', finish, { signal: ac.signal });
    document.addEventListener('lostpointercapture', lost, { signal: ac.signal });
  }

  // Drag one bezier-path anchor or handle. `which` is 'a' (the anchor itself),
  // 'in' or 'out'. Dragging a handle mirrors its partner, keeping the curve
  // smooth through the anchor in a single drag; with Alt held the partner stays
  // put, which makes a cusp. A handle drag makes its anchor the user's own
  // (`auto` off); smooth anchors (bezier-path.js) re-fit to every move.
  // Alt-click on an anchor removes it, like the right button does.
  // The pointer delta is inverse-rotated into box space like a resize is, and
  // the gesture records one style edit at the end like the rotation handle.
  // Deltas rather than `maskLocal` points, so the drag needs no page frame.
  // `styleBefore` is passed when the gesture began earlier - a press on the
  // line adds the anchor and then drags it, as one undo step.
  function startPathDrag(e, i, which, styleBefore = null) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (which === 'a' && e.altKey && !styleBefore) {
      removeAnchor(i);
      return;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    focusPage(pg);
    settleEdits();
    pathActive = i;
    const zz = app.zoom;
    const pid = e.pointerId;
    const sx = e.clientX,
      sy = e.clientY;
    const pt = s.path.pts[i];
    if (!pt) return;
    const o = { x: pt.x, y: pt.y, ix: pt.ix, iy: pt.iy, ox: pt.ox, oy: pt.oy };
    styleBefore ??= cloneStyle(box.style);
    const pageId = pg.id;
    const rad = (-(s.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rad),
      sin = Math.sin(rad);
    // The handle dragged and its partner, as [x key, y key] pairs.
    const [own, other] = which === 'in' ? [['ix', 'iy'], ['ox', 'oy']] : [['ox', 'oy'], ['ix', 'iy']];
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const sdx = (ev.clientX - sx) / zz,
        sdy = (ev.clientY - sy) / zz;
      // And mirrored into the path's own frame, which is the unflipped one: the
      // curve is drawn flipped (`overlayMirror`), so a step right on screen is
      // a step left in the path on a box flipped left-right.
      const [dx, dy] = flipDelta([sdx * cos - sdy * sin, sdx * sin + sdy * cos], s);
      const pts = s.path.pts.map((p) => ({ ...p }));
      const p = pts[i];
      if (!p) return;
      if (which === 'a') {
        p.x = o.x + dx;
        p.y = o.y + dy;
      } else {
        delete p.auto;
        p[own[0]] = o[own[0]] + dx;
        p[own[1]] = o[own[1]] + dy;
        if (!ev.altKey) {
          p[other[0]] = -p[own[0]];
          p[other[1]] = -p[own[1]];
        }
      }
      s.path.pts = smoothPath(pts);
      markUnsaved();
    };
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      commitPath(styleBefore, pageId);
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // One path edit, recorded against the style it started from. Nothing is
  // recorded when the path came back the same (a press with no drag).
  function commitPath(styleBefore, pageId = pg.id) {
    const after = cloneStyle(box.style);
    if (JSON.stringify(after.path) === JSON.stringify(styleBefore.path)) return;
    // The glyphs follow the curve, so where they land decides the flag - and
    // nothing else asks: the fit effect does not read the path. Once, at the
    // end, as the mesh gestures do.
    reviewBox(box, pg);
    record({ t: 'style', pageId, boxId: box.id, before: styleBefore, after });
  }

  // The anchor last pressed: its handles show even when it is smooth. Every
  // corner and hand-set anchor shows its handles always; a smooth one's are
  // worked out for it, so a wave of them stays a clean line of dots.
  let pathActive = $state(-1);

  // A press on the curve itself adds an anchor there - the curve does not move,
  // the split is exact - and the same press drags it, so one gesture pulls a
  // new bump out of the line.
  function onPathLinePointerDown(e) {
    if (e.button !== 0 || !pageFrameEl) return;
    const [x, y] = maskLocal(e);
    const hit = nearestOnPath(s.path.pts, x, y);
    if (hit.seg < 0) return;
    const styleBefore = cloneStyle(box.style);
    const res = splitPath(s.path.pts, hit.seg, hit.t);
    if (res.index < 0) return;
    s.path.pts = res.pts;
    markUnsaved();
    startPathDrag(e, res.index, 'a', styleBefore);
  }

  // Double-click flips an anchor between smooth and a sharp corner.
  function onAnchorDblClick(e, i) {
    e.preventDefault();
    e.stopPropagation();
    const styleBefore = cloneStyle(box.style);
    s.path.pts = toggleSmooth(s.path.pts, i);
    markUnsaved();
    commitPath(styleBefore);
  }

  // Remove one anchor (the path keeps at least two).
  function removeAnchor(i) {
    const next = removePathAnchor(s.path.pts, i);
    if (next === s.path.pts) return;
    const styleBefore = cloneStyle(box.style);
    s.path.pts = next;
    pathActive = -1;
    markUnsaved();
    commitPath(styleBefore);
  }

  // ---- mask and fade drawing ----
  //
  // The armed tool comes from the Inspector (box-draw-tool.svelte.js). While
  // one is armed for this box's mask or its fade and the box is selected, a
  // transparent layer over the whole page takes the pointer and turns gestures into
  // shapes, committed one per gesture with one undo record each. The shapes
  // are page px (`box.mask`, box-mask.js): pinned to the page, never to the
  // box, so the pointer is taken to the page and nothing else, and a shape
  // may be drawn anywhere on it.
  // The paint's marks (`style.paint`, box-paint.js) are drawn with the same
  // gestures on the same layer, in page px, and stored in the box's texture
  // (its own frame before a warp mesh): carried onto the page to be shown
  // and picked (`marksOnPage`), and a gesture's new or moved mark carried
  // back when it commits, the rest left as stored.
  const drawTarget = $derived(DRAW_TARGETS.includes(drawTool.target) ? drawTool.target : null);
  // Whose shapes the page layer shows: the armed tool's, or with none armed
  // the mask's, which a selected box with a mask on always outlines.
  const shownTarget = $derived(drawTarget ?? 'mask');
  const drawKind = $derived(drawTarget ? drawTool.kind : null);
  // Kept as the mask's names: the liquify ring and the key handler read them.
  const maskKind = $derived(drawKind);
  const modelOf = (t) => (t === 'paint' ? box.style.paint : box[t]);
  const drawModel = $derived(drawTarget ? modelOf(drawTarget) : null);
  const drawShown = $derived(selected && !editing && !bulkOn && !!modelOf(shownTarget)?.on);
  // The shown target's shapes in page px, one for each stored shape and in
  // its order.
  const shownList = $derived.by(() => {
    // A mask or fade that moves with the box is shown in page px too.
    if (shownTarget !== 'paint') return modelShapesOnPage(box, box[shownTarget]);
    const marks = box.style.paint?.marks;
    return drawShown && marks ? marksOnPage(box, marks) : marks;
  });
  // The stored list itself, what a pick is made in: the paint's page list is
  // made again whenever the box moves, its marks are not.
  const shownStored = () => (shownTarget === 'paint' ? box.style.paint?.marks : box[shownTarget]?.shapes);
  const maskArmed = $derived(drawShown && !!drawModel?.on && !!drawKind);

  // The gesture in progress: a shape being drawn, not yet in the box; the
  // polygon's corners so far; the shape the Move tool has picked (its index)
  // and how far a Move drag has carried it, or every shape when `idx` is null;
  // and where the pointer is, for the brush's ring.
  // `pickedIn` is the shape list the pick was made in: a pick is an index,
  // so once the list is another (an undo, a redo, an edit from elsewhere)
  // the index may name another shape, and the pick is dropped.
  const maskDraft = $state({ shape: null, poly: null, picked: null, pickedIn: null, moving: null, at: null });
  $effect(() => {
    const list = shownStored();
    untrack(() => {
      if (maskDraft.picked !== null && list !== maskDraft.pickedIn) maskDraft.picked = null;
    });
  });

  // The tool is the selection's: it goes when this box stops being selected
  // (another box picked, the page left, the box deleted), so it is never left
  // armed on a box nobody chose to draw on.
  $effect(() => {
    if (!selected) return;
    return () => untrack(clearDrawTool);
  });

  // A pointer event in box-local page px: page coords from the page frame,
  // then inverse-rotated around the box centre - the SCREEN frame, where the
  // liquify ring is drawn. Every gizmo that stores points takes one step more
  // (`maskLocal`).
  function maskPoint(ev) {
    return screenPoint(ev.clientX, ev.clientY, pageFrameEl.getBoundingClientRect(), app.zoom, box);
  }

  // The same point in the frame the warp mesh and the path are stored in:
  // unflipped, because both are applied before the flip (`wrapMirror`), so
  // what they move lands - once mirrored with the box - under the pointer
  // that moved it.
  function maskLocal(ev) {
    return flipPoint(maskPoint(ev), box);
  }

  // A pointer event in page px, the frame the mask's shapes are stored in.
  function pagePoint(ev) {
    const r = pageFrameEl.getBoundingClientRect();
    return [(ev.clientX - r.left) / app.zoom, (ev.clientY - r.top) / app.zoom];
  }

  // Stored page points as an SVG points list at the zoom.
  const outline = (pts) => pts.map(([px, py]) => `${px * z},${py * z}`).join(' ');

  // A model as plain data, for the undo record.
  const plainOf = (m) => (m ? $state.snapshot(m) : null);

  // A shape changes the verdict as well as the picture: a keep shape cuts the
  // ink the check counts (contain.js), and the fit effect does not read the
  // mask, so the flag is brought up to date here. Every gesture ends here - a
  // new shape, a move, a removal - as one record.
  function commitMaskShapes(next) {
    const target = drawTarget ?? 'mask';
    const before = plainOf(box[target]);
    box[target] = { ...(box[target] ?? { on: true }), shapes: modelShapesFromPage(box, box[target], next) };
    markUnsaved();
    // The fade changes no verdict.
    if (target === 'mask') reviewBox(box, pg);
    record({ t: target, pageId: pg.id, boxId: box.id, before, after: plainOf(box[target]) });
  }
  // A new shape takes what the panel set for the next one: the mask's op,
  // or the fade's strength and soft edge.
  // The paint's: its colour, opacity and soft edge, and the eraser's flag.
  const nextShapeSet = () =>
    shownTarget === 'paint'
      ? { color: drawSettings.paint.color, opacity: drawSettings.paint.opacity, soft: drawSettings.paint.soft, ...(drawKind === 'erase' ? { erase: true } : {}) }
      : shownTarget === 'fade'
        ? { strength: drawSettings.fade.strength, soft: drawSettings.fade.soft }
        : { op: drawSettings.mask.op };
  // The paint's marks as `marks` (the paint's frame), recorded as a style
  // edit: the paint is the style's.
  function commitPaint(marks) {
    const before = cloneStyle(box.style);
    box.style.paint = { ...(box.style.paint ?? { on: true }), marks };
    markUnsaved();
    record({ t: 'style', pageId: pg.id, boxId: box.id, before, after: cloneStyle(box.style) });
  }
  function commitMaskShape(shape) {
    const shapes = shownList;
    const set = nextShapeSet();
    if (shownTarget === 'paint') {
      // An eraser counts against a ceiling of its own, so a full box can
      // still have paint taken off it.
      const full = paintRoomFor(box.style.paint, set.erase);
      if (full) return toast(full);
      return commitPaint([...shownStored(), ...marksFromPage(box, [{ ...shape, ...set }])]);
    }
    if (shapes.length >= MASK_SHAPES_MAX) {
      toast(`A ${shownTarget} holds ${MASK_SHAPES_MAX} shapes at most`);
      return;
    }
    commitMaskShapes([...shapes, { ...shape, ...set }]);
  }

  // A shape carried by (dx, dy) page px. A bubble link follows its outline,
  // not the pointer.
  function movedShape(sh, dx, dy) {
    if (sh.kind === 'bubble') return sh;
    return translateMask({ shapes: [sh] }, dx, dy).shapes[0];
  }

  // The four corners of the rectangle two points span, as the polygon the
  // engine already cuts: a rectangle needs nothing new from it.
  function rectPts(a, b) {
    return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
  }

  // The shapes as they are drawn on the page, one for each stored shape and in
  // its order: a bubble link as its inset outline (null with no outline).
  const pageShapes = $derived.by(() => {
    if (shownTarget === 'paint') return shownList ?? [];
    if (!box[shownTarget]) return [];
    return (shownList ?? []).map((sh) => (sh.kind === 'bubble' ? (maskOnPage({ ...box, mask: { shapes: [sh] } })[0] ?? null) : sh));
  });

  // The topmost shape under a page point, or null. Searched from the last
  // drawn, the one drawn over the rest.
  function maskShapeAt(p) {
    const [x, y] = p;
    for (let i = pageShapes.length - 1; i >= 0; i--) {
      const sh = pageShapes[i];
      if (!sh) continue;
      if (sh.kind === 'ellipse') {
        if (sh.rx > 0 && sh.ry > 0 && ((x - sh.cx) / sh.rx) ** 2 + ((y - sh.cy) / sh.ry) ** 2 <= 1) return i;
      } else if (sh.kind === 'poly') {
        let inside = false;
        for (let j = 0, k = sh.pts.length - 1; j < sh.pts.length; k = j++) {
          const [xj, yj] = sh.pts[j];
          const [xk, yk] = sh.pts[k];
          if (yj > y !== yk > y && x < ((xk - xj) * (y - yj)) / (yk - yj) + xj) inside = !inside;
        }
        if (inside) return i;
      } else if (sh.pts?.length) {
        // A brush stroke is hit within half its width of its line, plus a
        // little, so a thin stroke can still be caught.
        const reach = sh.size / 2 + 3;
        for (let j = 0; j < sh.pts.length; j++) {
          const [ax, ay] = sh.pts[j];
          const [bx, by] = sh.pts[Math.min(j + 1, sh.pts.length - 1)];
          const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
          const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2)) : 0;
          if (Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) <= reach) return i;
        }
      }
    }
    return null;
  }

  function onMaskPointerDown(e) {
    if (e.button !== 0 || !maskArmed || !pageFrameEl) return;
    e.preventDefault();
    e.stopPropagation();
    const p = pagePoint(e);
    const kind = maskKind;
    // The polygon is click-built rather than dragged; the rest are drags.
    if (kind === 'poly') {
      maskDraft.poly = [...(maskDraft.poly ?? []), p];
      return;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const start = p;
    if (kind === 'move') {
      // A press on a shape picks it and drags it alone; a press on empty
      // space drags them all. The shapes stay where they are in the box
      // until the pointer comes up, so a drag is one record and no repaint
      // per move: the overlay shows them carried meanwhile.
      maskDraft.picked = maskShapeAt(p);
      maskDraft.pickedIn = shownStored();
      maskDraft.moving = { idx: maskDraft.picked, dx: 0, dy: 0 };
    } else if (kind === 'brush' || kind === 'erase') maskDraft.shape = { kind: 'stroke', size: drawSettings[shownTarget].size, pts: [p] };
    else if (kind === 'rect') maskDraft.shape = { kind: 'poly', pts: rectPts(p, p) };
    else maskDraft.shape = { kind: 'ellipse', cx: p[0], cy: p[1], rx: 0, ry: 0 };
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const q = pagePoint(ev);
      if (maskDraft.moving) {
        maskDraft.moving.dx = q[0] - start[0];
        maskDraft.moving.dy = q[1] - start[1];
        return;
      }
      if (!maskDraft.shape) return;
      if (kind === 'brush' || kind === 'erase') {
        const last = maskDraft.shape.pts[maskDraft.shape.pts.length - 1];
        if (Math.hypot(q[0] - last[0], q[1] - last[1]) > 1.5) maskDraft.shape.pts.push(q);
      } else if (kind === 'rect') {
        maskDraft.shape.pts = rectPts(start, q);
      } else {
        maskDraft.shape.cx = (start[0] + q[0]) / 2;
        maskDraft.shape.cy = (start[1] + q[1]) / 2;
        maskDraft.shape.rx = Math.abs(q[0] - start[0]) / 2;
        maskDraft.shape.ry = Math.abs(q[1] - start[1]) / 2;
      }
    };
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      const mv = maskDraft.moving;
      maskDraft.moving = null;
      if (mv) {
        // A press that did not travel moved nothing, and records nothing.
        if (ev.type === 'pointercancel' || Math.hypot(mv.dx, mv.dy) < 0.5) return;
        if (shownTarget === 'paint') commitPaint(moveMarks(box, shownStored(), mv.idx, mv.dx, mv.dy));
        else commitMaskShapes(shownList.map((sh, i) => (mv.idx === null || mv.idx === i ? movedShape(sh, mv.dx, mv.dy) : sh)));
        // The moved shape is still the one picked, in the list just made.
        maskDraft.pickedIn = shownStored();
        return;
      }
      const sh = maskDraft.shape;
      maskDraft.shape = null;
      if (!sh) return;
      // A shape too small to see was a slip, not a shape.
      if (sh.kind === 'ellipse' && (sh.rx < 1 || sh.ry < 1)) return;
      if (kind === 'rect' && (Math.abs(sh.pts[2][0] - sh.pts[0][0]) < 1 || Math.abs(sh.pts[2][1] - sh.pts[0][1]) < 1)) return;
      commitMaskShape($state.snapshot(sh));
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // Where the pointer is over the capture surface, page px, for the ring.
  function onMaskPointerMove(e) {
    if (maskArmed) maskDraft.at = pagePoint(e);
  }
  function onMaskPointerLeave() {
    maskDraft.at = null;
  }
  const maskRing = $derived(
    maskArmed && (maskKind === 'brush' || maskKind === 'erase') && maskDraft.at
      ? { x: maskDraft.at[0], y: maskDraft.at[1], d: drawSettings[shownTarget].size * z }
      : null,
  );

  function onMaskDblClick(e) {
    if (maskKind !== 'poly' || !maskDraft.poly) return;
    e.preventDefault();
    e.stopPropagation();
    const pts = maskDraft.poly;
    maskDraft.poly = null;
    if (pts.length >= 3) commitMaskShape({ kind: 'poly', pts });
  }
  // A new tool starts with nothing in hand.
  $effect(() => {
    void maskKind;
    untrack(() => {
      maskDraft.poly = null;
      maskDraft.picked = null;
    });
  });
  $effect(() => {
    if (!maskArmed) {
      maskDraft.poly = null;
      maskDraft.shape = null;
      maskDraft.picked = null;
      maskDraft.moving = null;
      maskDraft.at = null;
      return;
    }
    // Escape drops a polygon half built, and with none puts the tool down.
    // Delete and Backspace remove the shape the Move tool picked. Both are
    // taken in the capture phase and stopped there, because the window's own
    // handler reads Escape as "deselect" and Delete as "delete the box".
    // A key pressed in a field is the field's, and one pressed in an open
    // popover or menu (a colour picker) is the popover's, which closes on it.
    const onKey = (e) => {
      if (e.target?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (maskDraft.poly) maskDraft.poly = null;
        else clearDrawTool();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && maskKind === 'move' && maskDraft.picked !== null && shownStored() === maskDraft.pickedIn) {
        e.preventDefault();
        e.stopPropagation();
        const i = maskDraft.picked;
        maskDraft.picked = null;
        const shapes = shownList;
        if (i >= shapes.length) return;
        if (shownTarget === 'paint') commitPaint(shownStored().filter((_, j) => j !== i));
        else commitMaskShapes(shapes.filter((_, j) => j !== i));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Everything the page layer outlines: the shapes as drawn (a Move drag
  // carrying them meanwhile), plus the draft.
  const maskShapesShown = $derived.by(() => {
    if (!drawShown) return null;
    const mv = maskDraft.moving;
    const out = pageShapes.map((sh, i) => (sh && mv && (mv.idx === null || mv.idx === i) && shownList[i].kind !== 'bubble' ? movedShape(sh, mv.dx, mv.dy) : sh));
    if (maskDraft.shape) out.push({ ...maskDraft.shape, ...nextShapeSet() });
    return out;
  });

  // ---- liquify ----
  //
  // The Effects panel's liquify sub-tab: a round tool that pushes the box's
  // MESH around under the pointer, so the type and the ink bend together
  // through the same texture the transform gizmo deforms by hand. The maths is
  // `liquify.js`, the gesture - the snapshot, the one commit, the cancel - is
  // `liquify-mesh.js`; what lives here is the pointer, the clock, the circle
  // the cursor draws, and the cached-texture repaint the gizmo also uses.
  //
  // `liquifyEnd` is how a gesture in flight is ended from anywhere: the pointer
  // coming up, Escape, a cancelled pointer, and the two endings that arrive
  // with no pointer event at all - the capture surface being unmounted, and
  // this box being destroyed. Null when no gesture is running.
  let liquifyEnd = null;
  let liquifyAt = $state(null);
  const liquifyOn = $derived(
    selected &&
      !editing &&
      !bulkOn &&
      !brushArmed() &&
      !!pageFrameEl &&
      inspectorTab.id === 'effects' &&
      effectsSubTab.id === 'liquify',
  );
  const liquifyRing = $derived(
    liquifyOn && liquifyAt
      ? { x: liquifyAt[0], y: liquifyAt[1], d: liquifySettings().radius * 2 * z }
      : null,
  );

  function onLiquifyPointerDown(e) {
    if (e.button !== 0 || !liquifyOn) return;
    e.preventDefault();
    e.stopPropagation();
    // A second pointer mid-gesture ends the first as a cancel: a pointer that
    // never came up did not finish.
    liquifyEnd?.(false);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const g = liquifyMeshGesture(box, pg.id, liquifySettings());
    // The texture is rendered once, here, and every move re-warps it - the
    // same trade the transform gizmo makes, for the same reason.
    warpPainter.begin();
    const ac = new AbortController();
    // The ring is drawn where the pointer is, in the screen frame; the mesh is
    // pushed in its own, unflipped one (`maskLocal`), so on a flipped box the
    // push is mirrored into the mesh and lands, flipped back, under the ring
    // and the way the pointer went.
    liquifyAt = maskPoint(e);
    let [lx, ly] = flipPoint(liquifyAt, box);
    let lastT = e.timeStamp;
    liquifyEnd = (commit) => {
      liquifyEnd = null;
      live.delete(ac);
      ac.abort();
      if (commit) g.commit();
      else g.cancel();
      warpPainter.end();
    };
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      liquifyAt = maskPoint(ev);
      const [x, y] = flipPoint(liquifyAt, box);
      const scale = frameScaleFor(ev.timeStamp - lastT);
      lastT = ev.timeStamp;
      if (g.step({ cx: x, cy: y, dx: x - lx, dy: y - ly, scale })) warpPainter.frame();
      lx = x;
      ly = y;
    };
    const up = (ev) => {
      if (ev.pointerId === pid) liquifyEnd?.(true);
    };
    const cancel = (ev) => {
      if (ev.pointerId === pid) liquifyEnd?.(false);
    };
    // Escape puts the mesh back exactly as the pointer found it, and ONLY that:
    // capture phase so App's window handler cannot also read it as "deselect".
    const key = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      liquifyEnd?.(false);
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', up, { signal: ac.signal });
    document.addEventListener('pointercancel', cancel, { signal: ac.signal });
    document.addEventListener('keydown', key, { signal: ac.signal, capture: true });
  }

  function onLiquifyPointerMove(e) {
    if (!liquifyOn || liquifyEnd) return;
    liquifyAt = maskPoint(e);
  }
  function onLiquifyPointerLeave() {
    if (!liquifyEnd) liquifyAt = null;
  }

  // The capture surface can go away mid-drag with no pointer event: the
  // sub-tab changes, another box is selected, the brush is armed. Ended as a
  // cancel, like the mesh gizmo's teardown.
  $effect(() => {
    if (liquifyOn) return;
    untrack(() => {
      liquifyEnd?.(false);
      liquifyAt = null;
    });
  });
  $effect(() => () => {
    liquifyEnd?.(false);
    liquifyAt = null;
  });

  // Double-click closes the polygon.
  // Right-click on a path anchor removes it.
  function onAnchorContextMenu(e, i) {
    e.preventDefault();
    e.stopPropagation();
    removeAnchor(i);
  }

  // ---- the special effects' handles (special.js) ----
  // While Effects ▸ Special is open, a point on the selected box for each
  // effect that has one and is on: Crack's focus, Lightning's start with an
  // arm the way it goes, Splash's landing. A drag writes the effect's
  // numbers, as its sliders do, in one undo step.
  const specialHandlesOn = $derived(
    selected &&
      !editing &&
      !bulkOn &&
      !brushArmed() &&
      inspectorTab.id === 'effects' &&
      effectsSubTab.id === 'special' &&
      !boxLocked(box),
  );
  //
  // The effects are laid in the box's texture, before its warp mesh, which
  // then bends them with the letters. So a point is stated before the mesh
  // (`p`) and shown where the mesh carries it (`at`), and a pointer is taken
  // back through the mesh (`unwarpWith`) before it is written. A point the
  // mesh does not carry anywhere (past a perspective's horizon) has no handle.
  const specialMesh = $derived(warped ? meshMap(s.warp.pts, s.warp.cols, s.warp.rows, box.w, box.h) : null);
  const meshed = (p) => {
    if (!specialMesh) return p;
    const q = specialMesh.at(p.x, p.y);
    return q && Number.isFinite(q[0]) && Number.isFinite(q[1]) ? { x: q[0], y: q[1] } : null;
  };
  const specialHandles = $derived.by(() => {
    if (!specialHandlesOn || !s.special) return [];
    const out = [];
    let ink;
    for (const kind of HANDLE_KINDS) {
      const fx = s.special[kind];
      if (!fx?.on) continue;
      if (kind === 'crack') ink ??= lettersInkRect(boxCandidate(box, text, runs));
      const frame = handleFrame(kind, box, ink);
      const p = handlePoint(fx, frame);
      const at = meshed(p);
      if (!at) continue;
      const arm = kind === 'lightning' ? meshed(armEnd(fx, p, ARM_LENGTH / z)) : null;
      out.push({ kind, frame, p, at, arm });
    }
    return out;
  });
  const specialPointsOn = $derived(specialHandles.length > 0);
  const HANDLE_TITLES = {
    crack: 'Crack focus: drag to set where the cracks gather',
    lightning: 'Lightning start: drag to set where the bolts begin',
    splash: 'Splash: drag to set where the paint lands',
  };

  // Drags a handle (`part` 'point') or the lightning's arm end ('arm').
  function startSpecialDrag(e, kind, part) {
    if (e.button !== 0 || !pageFrameEl) return;
    const h = specialHandles.find((x) => x.kind === kind);
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    focusPage(pg);
    settleEdits();
    const pid = e.pointerId;
    const styleBefore = cloneStyle(box.style);
    const pageId = pg.id;
    const frame = h.frame;
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const fx = s.special?.[kind];
      if (!fx) return;
      const from = handlePoint(fx, frame);
      const q = unwarpWith(specialMesh, box.w, box.h, ...maskLocal(ev), { hint: [from.x, from.y] });
      if (!q) return;
      const [x, y] = q;
      if (part === 'arm') dragArm(fx, from, { x, y });
      else dragHandle(kind, fx, { x, y }, frame);
      markUnsaved();
    };
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      const after = cloneStyle(box.style);
      if (JSON.stringify(after.special) === JSON.stringify(styleBefore.special)) return;
      record({ t: 'style', pageId, boxId: box.id, before: styleBefore, after });
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // The gizmo's polyline, in zoomed box-local px.
  const gizmoLine = $derived.by(() => {
    if (!pathGizmoOn) return null;
    return pathPolyline(s.path.pts, z)
      .map((p) => `${p[0]},${p[1]}`)
      .join(' ');
  });

  // Inline contenteditable undo stack.
  const fieldUndo = createFieldUndo();

  // ===== typing into the box (UX-4) =====
  // The box being typed into shows the lines the result draws - `shaped`, laid
  // over the raw text by `editLines` and drawn by `drawEditLines`, one element
  // per line - instead of letting the browser wrap the raw text its own way. So
  // the browser cannot be allowed to change that DOM: every edit is made to the
  // raw text here, from where the browser says it goes, and the lines are drawn
  // again from the result. Composition (an IME) is the one exception, because
  // its text is not final until it ends; it is left to the browser and read
  // back then. Curved text is edited the same way, in an editable nobody sees
  // (see "typing on the curve" below).
  const editSegs = $derived(editing && shaped ? editLines(text, applyCase(text, s), shaped) : null);
  // What a line's hidden head or tail would take up on it, in zoomed px.
  const hangWidth = (str) => charWidths(str, s, effSize).reduce((a, w) => a + w + effLs, 0);
  // Where the caret goes when the lines are next drawn, as a raw offset.
  let caretNext = null;
  let composing = false;
  let compositionTimer = null;
  let compositionVersion = 0;
  // The editable, for the curve's pointer handlers, and its selection as raw
  // offsets (anchor, focus), which is what the caret on the curve is drawn from.
  let editEl = null;
  let edSel = $state(null);
  // The selection, for the face commands (typing-selection.svelte.js), for as
  // long as the box is typed into.
  $effect(() => {
    if (!editing || !edSel) return;
    setTypingSel(box.id, text, edSel.a, edSel.f);
  });
  // The focus on a control that sets the faces keeps the edit
  // (`onEditBlur`); once it lands anywhere else - a press, a Tab, the control
  // closing with nowhere to give it back - the edit ends as a blur ends it.
  $effect(() => {
    if (!editing) return;
    const id = box.id;
    const off = onEditAway(() => {
      if (app.editingId !== id || !editEl) return;
      if (pictureEdit) clearComposition();
      composeText = null;
      endEdit(editEl.textContent);
    });
    const check = () => setTimeout(endEditIfAway);
    document.addEventListener('focusin', check, true);
    document.addEventListener('pointerdown', check, true);
    return () => {
      off();
      document.removeEventListener('focusin', check, true);
      document.removeEventListener('pointerdown', check, true);
      if (typingSel.boxId === id) clearTypingSel();
    };
  });

  // Whether this edit has been a picture at any time: what the editable's
  // teardown has to put back then, and with the switch off never true.
  let pictureEdit = false;
  function clearComposition() {
    clearTimeout(compositionTimer);
    compositionTimer = null;
    compositionVersion++;
    composing = false;
    composeText = null;
    composeAt = null;
  }
  function editField(node) {
    let first = true;
    // A composition belongs to one editable. A new picture edit must not
    // inherit a composition whose editable has already gone away.
    if (enginePaints) {
      clearComposition();
      endDefaultCurveDrags();
    }
    editEl = node;
    const onSel = () => {
      const sel = window.getSelection();
      if (!sel.rangeCount || !node.contains(sel.focusNode)) return;
      const a = rawOffset(node, sel.anchorNode, sel.anchorOffset);
      const f = rawOffset(node, sel.focusNode, sel.focusOffset);
      if (a == null || f == null) return;
      // A selection the browser moved itself (a word step, a key it kept)
      // starts again: no side of a wrap, no column kept (`edUp`, `goalX`).
      if (typing && edSel && (edSel.a !== a || edSel.f !== f)) {
        edUp = false;
        goalX = null;
      }
      edSel = { a, f };
    };
    $effect(() => {
      document.addEventListener('selectionchange', onSel);
      return () => {
        document.removeEventListener('selectionchange', onSel);
        if (pictureEdit) {
          clearComposition();
          menuBack?.(false);
          curveDrag?.end();
          endDefaultCurveDrags();
        }
        if (editEl === node) editEl = null;
        edSel = null;
        if (!pictureEdit) return;
        pictureEdit = false;
        // The picture is painted in full at once, and no timer outlives the edit.
        settleKeys();
        typeDrag?.end();
        nudge = { x: 0, y: 0 };
        menuShift = null;
        edUp = false;
        goalX = null;
        composeAt = null;
      };
    });
    $effect(() => {
      editSegs;
      indents;
      text;
      effSize;
      effLs;
      // The faces the lines are drawn in, set by a command with the words as
      // they were: drawn again, the selection kept.
      lineCuts;
      // WITH THE ENGINE DRAWING, the effect that keeps the editable's own
      // caret under the drawn one (`alignNative`). It is made HERE, as this
      // effect's child, for two reasons. It then runs after this one has
      // drawn the lines it measures, whatever changed. And it is made
      // whenever the engine is drawing, not only when the edit began with
      // it: the flag is read here, so the engine coming on in the middle of
      // an edit (it starts after the first paint of the app, and it can be
      // switched) runs this again and makes it. With the switch off the flag
      // is false and nothing is made.
      if (enginePaints) {
        pictureEdit = true;
        $effect(() => {
          if (!typing) {
            // Not a picture now (the paint threw, the model has no answer):
            // the editable is where it is with the switch off, and nothing
            // is kept to move it by when the picture comes back.
            untrack(() => {
              if (nudge.x || nudge.y) nudge = { x: 0, y: 0 };
            });
            return;
          }
          // What moves either caret: the marks, and what the box is laid out by.
          typeMarks;
          curveMarks;
          z;
          s.rotation;
          s.flipH;
          s.flipV;
          box.w;
          box.h;
          inkShift;
          untrack(() => alignNative(node));
        });
      } else if (pictureEdit) {
        // The switch went off in the middle of the edit: the editable is
        // where it is with the switch off, and nothing is kept to move it by.
        untrack(() => {
          if (nudge.x || nudge.y) nudge = { x: 0, y: 0 };
        });
      }
      if (composing) return;
      untrack(() => {
        if (first) {
          first = false;
          resyncField(fieldUndo, text, copyRuns(boxRuns(box)));
          node.focus();
          drawEdit(node, null);
        } else {
          const sel = window.getSelection();
          const anchor = sel.rangeCount ? rawOffset(node, sel.anchorNode, sel.anchorOffset) : null;
          const caret = caretNext ?? caretNow(node) ?? text.length;
          drawEdit(node, caret, caretNext ?? anchor ?? caret);
        }
        caretNext = null;
      });
    });
  }

  // Draws the lines, restoring both raw selection endpoints, or selects all.
  function drawEdit(node, caret, anchor = caret) {
    drawEditLines(node, text, editSegs, hangWidth, indents && { side: s.align, px: indents.map((v) => v * z) }, editSegs ? lineCuts : null);
    const sel = window.getSelection();
    if (caret == null) {
      const r = document.createRange();
      r.selectNodeContents(node);
      sel.removeAllRanges();
      sel.addRange(r);
    } else {
      const [ac, ai] = domPoint(node, Math.min(anchor, text.length));
      const [fc, fi] = domPoint(node, Math.min(caret, text.length));
      sel.setBaseAndExtent(ac, ai, fc, fi);
    }
    // Now, not at the selectionchange that follows, so the caret on the curve
    // is never drawn for one frame at the old offset on the new glyphs.
    const o = caret == null ? null : Math.min(caret, text.length);
    edSel = o == null ? { a: 0, f: text.length } : { a: Math.min(anchor, text.length), f: o };
    if (typing) {
      edUp = false;
      goalX = null;
    }
  }

  function caretNow(node) {
    const sel = window.getSelection();
    return sel.rangeCount ? rawOffset(node, sel.focusNode, sel.focusOffset) : null;
  }

  // The raw span an edit replaces: where the browser says it goes, else the
  // selection.
  function editSpan(node, e) {
    const sel = window.getSelection();
    const r = e?.getTargetRanges?.()[0] ?? (sel.rangeCount ? sel.getRangeAt(0) : null);
    if (!r) return null;
    const a = rawOffset(node, r.startContainer, r.startOffset);
    const b = rawOffset(node, r.endContainer, r.endOffset);
    return a == null || b == null ? null : [Math.min(a, b), Math.max(a, b)];
  }

  // setBoxText routes text to line for free-typed boxes. `at` is the range
  // the edit replaced, when it is known, so the faces move with this edit.
  function commitEdit(v, caret, inputType, at) {
    if (v === text) return;
    keyed();
    caretNext = caret;
    const runs = pendingRuns(v, at);
    setBoxText(box, v, page(), runs ? { runs } : { span: at });
    recordFieldEdit(fieldUndo, v, { atomic: isAtomicInput(inputType), faces: copyRuns(boxRuns(box)) });
    markUnsaved();
  }

  function applyEdit(node, span, inputType, data) {
    if (typeFlat && !composing) span = editStops(node.textContent, span);
    const r = rawEdit(node.textContent, span, inputType, data);
    if (r) commitEdit(r.v, r.caret, inputType, r.span);
  }

  // A face asked for at the caret (`typingSel.pending`, Bold or Italic with
  // nothing selected) put on the letters typed there now: the runs the edit
  // leaves, or null for an edit it does not touch. The letters typed after
  // them take their face from the letter before, as any typed letter does.
  function pendingRuns(v, at) {
    const pend = typingSel.pending;
    if (!pend || pend.boxId !== box.id || pend.text !== text || !at || at[0] !== pend.at || at[1] !== pend.at || v.length <= text.length) return null;
    const face = { bold: !!s.bold, italic: !!s.italic };
    const moved = shiftRuns(boxRuns(box), text, v, at);
    return patchRuns(moved, v, pend.at, pend.at + v.length - text.length, pend.patch, face) ?? [];
  }

  function onEditBeforeInput(e) {
    const t = e.inputType;
    if (e.isComposing || t.includes('Composition')) return;
    // The browser's own Bold and Italic (Cmd+B in an editable) would write
    // markup into the words: the faces are the editor's commands' to set
    // (`text.bold`), which the key reaches through the shortcut registry.
    if (t.startsWith('format')) return e.preventDefault();
    // On a picture, while a composition is open the text is the IME's and the
    // browser's (`composing`: an input can arrive in the middle of one without
    // saying so). Nothing is cut from the picture's rows then, and the box's
    // text is not written under the composition.
    if (composing && (pictureEdit || t === 'historyUndo' || t === 'historyRedo')) return;
    e.preventDefault();
    const node = e.currentTarget;
    if (t === 'historyUndo' || t === 'historyRedo') return stepField(node, t === 'historyRedo');
    let span = editSpan(node, e);
    // A delete to the line's end is cut from the lines the picture draws; on
    // a curve, which is one line, from the paragraph of the raw text.
    if (typing && edSel && edSel.a === edSel.f) span = (typeFlat ? lineDeleteSpan(typed.rows, node.textContent, edSel.f, edUp, t) : curveCut(node.textContent, edSel.f, t)) ?? span;
    if (span) applyEdit(node, span, t, e.data ?? e.dataTransfer?.getData('text/plain'));
  }

  function onEditPaste(e) {
    if (pictureEdit && composing) return;
    e.preventDefault();
    const node = e.currentTarget;
    const span = editSpan(node);
    if (span) applyEdit(node, span, 'insertFromPaste', e.clipboardData?.getData('text/plain') ?? '');
  }

  // The browser's copy of the lines has a Return at every wrap and the hidden
  // spaces; what was selected is a slice of the raw text.
  function onEditCopy(e) {
    if (e.type === 'cut' && pictureEdit && composing) return;
    const node = e.currentTarget;
    let span = editSpan(node);
    if (!span || span[0] === span[1]) return;
    if (typeFlat && !composing) span = editStops(node.textContent, span);
    e.preventDefault();
    e.clipboardData.setData('text/plain', node.textContent.slice(...span));
    if (e.type === 'cut') applyEdit(node, span, 'deleteByCut');
  }

  // Whatever the browser did change - a composition, an input it would not let
  // be cancelled - is read back as raw text, and the lines drawn again.
  //
  // `from`, for the end of a composition: the text and the raw range the IME
  // was given when it began, so what it replaced is known (`editedSpan`) and
  // the faces of the words (runs.js) move with it; without it, or when it does
  // not explain the change, the range is guessed from the text alone.
  function readBack(node, from = null) {
    if (!node.isConnected) return;
    const caret = caretNow(node);
    const v = node.textContent;
    const span = from && from.v === text ? editedSpan(from.v, v, from.a, from.b) : null;
    if (v !== text) commitEdit(v, caret ?? v.length, 'insertText', span ?? undefined);
    else drawEdit(node, caret ?? v.length);
  }
  function onEditInput(e) {
    if (!composing) readBack(e.currentTarget);
    else if (curveEdit || typing) {
      keyed();
      composeText = e.currentTarget.textContent;
    }
  }
  function onCompositionStart(e) {
    clearTimeout(compositionTimer);
    compositionTimer = null;
    compositionVersion++;
    composing = true;
    // On a picture the selection is the picture's own (`edSel`); in the DOM
    // lines it is the browser's.
    const at = typing && edSel ? [Math.min(edSel.a, edSel.f), Math.max(edSel.a, edSel.f)] : e?.currentTarget ? editSpan(e.currentTarget) : null;
    composeFrom = at ? { v: text, a: at[0], b: at[1] } : null;
    // A drag/menu that began before composition cannot go on changing its
    // selection, even if the picture falls back to DOM text in the meantime.
    if (pictureEdit) {
      typeDrag?.end();
      curveDrag?.end();
      endDefaultCurveDrags();
      menuBack?.(false);
    }
    // What the composed text takes the place of, to mark it in the picture.
    if (typing) composeAt = edSel ? { from: Math.min(edSel.a, edSel.f), cut: Math.abs(edSel.a - edSel.f) } : null;
  }
  function onCompositionEnd(e) {
    composing = false;
    const node = e.currentTarget;
    const version = compositionVersion;
    const pictured = pictureEdit;
    // WebKit ends the composition before its last input lands.
    const finish = () => {
      if ((pictured || pictureEdit) && (editEl !== node || compositionVersion !== version)) return;
      if (pictured) compositionTimer = null;
      composeText = null;
      if (composeAt) composeAt = null;
      const from = composeFrom;
      composeFrom = null;
      readBack(node, from);
    };
    if (pictured) {
      clearTimeout(compositionTimer);
      compositionTimer = setTimeout(finish);
    } else setTimeout(finish);
  }

  // The right button on the editable itself (the lines in the DOM, with the
  // engine not drawing): on selected words of flat text, the menu of their
  // faces; anywhere else the system's, with Paste.
  function onEditContextMenu(e) {
    if (curved || composing || !edSel || edSel.a === edSel.f) return;
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const inside = [...sel.getRangeAt(0).getClientRects()].some((r) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
    if (!inside) return;
    e.preventDefault();
    openFaceMenu(e.clientX, e.clientY);
  }

  function onEditBlur(e) {
    // To a control that sets the words' faces (the faces menu, the
    // Inspector's B, I and family): the edit, and its selection, go on until
    // the focus is elsewhere (`onEditAway`).
    if (keepsEdit(e.relatedTarget)) return;
    if (pictureEdit) clearComposition();
    composeText = null;
    endEdit(e.currentTarget.textContent);
  }
  function onEditKey(e) {
    // A key the IME is composing with is the IME's, whatever it is: keyCode
    // 229 is how WebKit marks one it took (the Enter that commits a conversion
    // arrives as one, with `isComposing` already false).
    if (e.isComposing || e.keyCode === 229) return;
    // No key the picture answers moves the caret or cuts text while a
    // composition is open; and a key can arrive in the middle of one without
    // `isComposing`, so the composition's own start and end are asked too.
    // With the switch off a curve's keys are what they were.
    const open = pictureEdit && composing;
    if (!open && typeFlat && typeKey(e)) return;
    if (!open && (curveEdit || typeCurve) && curveKey(e)) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      if (composing) return;
      e.preventDefault();
      stepField(e.currentTarget, e.shiftKey);
      return;
    }
    // Escape inside a composition cancels the conversion. Taken here it
    // would end the edit, and the blur would commit the half-composed text.
    if (e.key === 'Escape' && !composing) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  }

  // One step of the field's own undo; the caret goes where the text changed.
  // A step that changed only the faces (a command on selected words) puts
  // them back where the command wrote them, and the selection stays.
  function stepField(node, redo) {
    const was = node.textContent;
    const next = redo ? redoField(fieldUndo) : undoField(fieldUndo);
    if (next == null) return;
    keyed();
    if (next === was) {
      setBoxRuns(box, fieldFaces(fieldUndo), page());
      return;
    }
    caretNext = caretAfter(was, next);
    setBoxText(box, next, page(), { runs: fieldFaces(fieldUndo) });
    markUnsaved();
  }

  // A face set on the words while they are typed into is a command, not a
  // keystroke, and writes nothing to the field's own undo: it is recorded
  // here as a step of the same words with the new faces, so Cmd+Z takes the
  // face back before any typing.
  $effect(() => {
    if (!editing) return;
    const key = runsKey(boxRuns(box));
    const t = text;
    untrack(() => {
      if (t !== fieldUndo.stack[fieldUndo.i] || key === runsKey(fieldFaces(fieldUndo))) return;
      recordFieldFaces(fieldUndo, copyRuns(boxRuns(box)));
    });
  });

  // ----- typing on the curve -----
  // The editable nobody sees wraps the raw text at the box's width, so where
  // the browser would put a caret for a click, or for Home and End, is its
  // flat layout's idea and not the curve's. So those are placed here, on the
  // glyphs, and the browser keeps the rest: Left and Right step through the
  // raw text, which is the order the glyphs run in, and every edit goes
  // through `beforeinput` as flat text's does.

  // The caret and the selection, on the glyphs being drawn.
  const curveMarks = $derived.by(() => {
    if (typing) return typeCurve && edSel ? typeCurveMarks() : null;
    if (!curveEdit || !edSel) return null;
    const t = composeText ?? text;
    const glyphs = layout ?? [];
    const a = glyphIndex(t, edSel.a);
    const f = glyphIndex(t, edSel.f);
    return { caret: a === f ? caretAt(glyphs, f) : null, sel: selectionBoxes(glyphs, a, f) };
  });

  // Selects raw [a, f] in the editable (a caret when they are equal).
  function setRawSel(a, f) {
    const node = editEl;
    if (!node) return;
    const [ac, ai] = domPoint(node, a);
    const [fc, fi] = domPoint(node, f);
    window.getSelection().setBaseAndExtent(ac, ai, fc, fi);
    edSel = { a, f };
  }

  // The raw offset nearest a pointer, on the glyphs. The overlay is the box,
  // so the centre of its screen rect is the box centre whatever the turn; the
  // turn is undone around it, and the box is never mirrored while typed into
  // (`wrapMirror`), so the point is then in the glyphs' own frame.
  function curvePoint(el, e) {
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const rad = (-(s.rotation || 0) * Math.PI) / 180;
    return [dx * Math.cos(rad) - dy * Math.sin(rad), dx * Math.sin(rad) + dy * Math.cos(rad)];
  }
  function curveOffset(el, e) {
    if (typeCurve) return curveRaw(caretNearest(typeGlyphs, ...typeCurvePoint(e)));
    const t = editEl?.textContent ?? text;
    return rawIndex(t, caretNearest(layout ?? [], ...curvePoint(el, e)));
  }

  // A click puts the caret at the glyph under it, a drag selects, and Shift
  // extends. Default prevented, so the editable keeps the focus.
  function onCurvePointerDown(e) {
    // The right button, on a curve that is a picture: the path straight text has.
    if (e.button === 2 && typeCurve && editEl && !composing) return typeMenu(e);
    if (e.button !== 0 || !editEl || composing) return;
    const pictured = typing;
    if (pictured && curveDrag && curveDrag.id !== e.pointerId) return;
    e.preventDefault();
    const el = e.currentTarget;
    const o = curveOffset(el, e);
    const anchor = e.shiftKey && edSel ? edSel.a : o;
    setRawSel(anchor, o);
    if (pictured) {
      try {
        el.setPointerCapture?.(e.pointerId);
      } catch {
        // A pen press may end before capture; the caret is still placed.
      }
    } else el.setPointerCapture?.(e.pointerId);
    // On a picture the drag is the pointer's that began it: another pointer
    // moving over the curve, or let go, is not it. (With the switch off the
    // handlers are what they were.)
    const mine = (ev) => !pictured || ev.pointerId === e.pointerId;
    const move = (ev) => mine(ev) && (!pictured || (typeCurve && !composing)) && setRawSel(anchor, curveOffset(el, ev));
    // And it is over when the browser takes the pointer back, as when the
    // button is let go: a release outside the curve is never heard here.
    const drag = { id: e.pointerId, end: null };
    const up = (ev) => {
      if (!mine(ev)) return;
      drag.end();
    };
    drag.end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (pictured) el.removeEventListener('lostpointercapture', up);
      if (curveDrag === drag) curveDrag = null;
      defaultCurveDrags.delete(drag);
    };
    if (pictured) {
      curveDrag?.end();
      curveDrag = drag;
    } else defaultCurveDrags.add(drag);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    if (pictured) el.addEventListener('lostpointercapture', up);
  }

  // A double-click selects the word, and is the box's no further: the box's
  // own double-click is the one that opens the edit.
  function onCurveDblClick(e) {
    e.stopPropagation();
    if (!editEl || composing) return;
    // The glyph under the pointer, not the caret beside it: the right half of
    // a word's last letter puts the caret after the word, on the space.
    const g = typeCurve ? glyphNearest(typeGlyphs, ...typeCurvePoint(e)) : glyphNearest(layout ?? [], ...curvePoint(e.currentTarget, e));
    if (!g) return;
    const [a, b] = wordAt(editEl.textContent, typeCurve ? curveRaw(g.i) : rawIndex(editEl.textContent, g.i));
    setRawSel(a, b);
  }

  // Home, End, Up and Down on the curve (`caretKey`); true when it took the key.
  //
  // A key with Option or Control is the browser's, as it always was - except
  // on a curve that is a picture, on a Mac: the keys the system binds to a
  // move or a cut by lines (`boundKey`) would be answered on the lines of the
  // editable nobody sees, so they are answered as the curve's own keys are.
  // The curve is one line: a step by a line is a step to an end of the
  // paragraph, and a page is the text.
  function curveKey(e) {
    const node = e.currentTarget;
    let key = e.key;
    let shift = e.shiftKey;
    let step = 0;
    if (e.altKey || e.ctrlKey) {
      const b = typeCurve && isMacKeyboard() ? boundKey(e) : null;
      if (!b || b.key === 'ArrowLeft' || b.key === 'ArrowRight') return false;
      shift = b.shift;
      key = { PageUp: 'ArrowUp', PageDown: 'ArrowDown', LineUp: 'Home', LineDown: 'End' }[b.key] ?? b.key;
      step = b.key === 'LineUp' ? -1 : b.key === 'LineDown' ? 1 : 0;
    }
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const a = rawOffset(node, sel.anchorNode, sel.anchorOffset);
    const f = rawOffset(node, sel.focusNode, sel.focusOffset);
    if (a == null || f == null) return false;
    const v = node.textContent;
    // Columns: the arrows go by the columns (`columnKey`).
    const cols = columns ? (typeCurve ? typeGlyphs : layout) : null;
    if (cols && !e.metaKey && !e.altKey && !e.ctrlKey) {
      const gi = columnKey(cols, typeCurve ? curveGlyph(f) : glyphIndex(v, f), key);
      if (gi != null) {
        e.preventDefault();
        const to = typeCurve ? curveRaw(gi) : rawIndex(v, gi);
        setRawSel(shift ? a : to, to);
        return true;
      }
    }
    if (key === 'Kill') {
      e.preventDefault();
      applyEdit(node, a !== f ? [Math.min(a, f), Math.max(a, f)] : curveCut(v, f, 'deleteHardLineForward'), 'deleteContentForward');
      return true;
    }
    const to = caretKey(v, step ? stepChar(v, f, step) : f, key, e.metaKey);
    if (to == null) return false;
    e.preventDefault();
    setRawSel(shift ? a : to, to);
    return true;
  }
  // The raw span a line delete takes on a curve that is a picture: to the
  // start or the end of the paragraph of the raw text, which is the curve's
  // line (`caretKey`), not a line of the editable nobody sees. Null for an
  // input that is not one.
  function curveCut(v, f, inputType) {
    if (!/^delete(Soft|Hard)Line/.test(inputType)) return null;
    return inputType.endsWith('Backward') ? [caretKey(v, f, 'Home'), f] : [f, caretKey(v, f, 'End')];
  }

  // ===== typing into the picture =====
  // With the Rust engine drawing, the box being typed into is still the
  // engine's picture of it, painted again from every change, so what is typed
  // is the result as it is typed: every stroke, the gradient, the blur, the
  // flip. The text itself sits in the editable above, unseen, laid out as it
  // always was - it is what the system types into, and where it thinks the
  // caret is - and every edit still goes through `beforeinput` to the raw
  // text, exactly as it does with the switch off.
  //
  // What the browser used to do with glyphs it had laid out is done on the
  // painter's own (`typed`: type-rows.js makes the rows from the lines and the
  // pens the picture is painted from; flat-caret.js is the arithmetic): the
  // caret, the selection, the pointer, and the keys that go by lines. Text on
  // a curve has the marks and the keys it has with the switch off ("typing on
  // the curve" above), on the glyphs the painter places.
  const typeFlat = $derived(typing && typed.kind === 'flat');
  const typeCurve = $derived(typing && typed.kind === 'curve');
  // Which side of a wrap the caret shows on (flat-caret.js `rowOf`), and the
  // x Up and Down are making for, kept from one to the next.
  let edUp = $state(false);
  let goalX = null;
  // What an IME's text took the place of when it began: where, and how many
  // characters. The span it is composing is marked from it.
  let composeAt = $state(null);
  const composeSpan = $derived.by(() => {
    if (!typing || composeText == null || !composeAt) return null;
    const to = composeAt.from + composeText.length - (text.length - composeAt.cut);
    return to > composeAt.from ? [composeAt.from, to] : null;
  });

  // The caret, the selection and the composed span, in the rows' own px: page
  // px from the box's corner. The caret is always there for `alignNative` to
  // measure; it is shown when nothing is selected.
  const typeMarks = $derived.by(() => {
    if (!typeFlat || !edSel) return null;
    let { a, f } = edSel;
    // A browser selection can name only a component of a raw grapheme. Show
    // the same whole span a pictured edit/cut replaces, keeping its focus on
    // the same side. The IME's selection and pending text keep their own path.
    if (!composing && composeText == null) {
      const [lo, hi] = editStops(text, [a, f]);
      [a, f] = a > f ? [hi, lo] : [lo, hi];
    }
    const caret = rowCaret(typed.rows, f, edUp);
    if (!caret) return null;
    return {
      caret,
      on: a === f,
      // A selected Return shows as a sliver past its line's end.
      sel: selectionRects(typed.rows, a, f, s.size * 0.3),
      comp: composeSpan ? selectionRects(typed.rows, composeSpan[0], composeSpan[1]) : [],
    };
  });
  // What takes the pointer for text that reaches past the frame: the rows'
  // own rectangle, when it does.
  const typePad = $derived.by(() => {
    if (!typeFlat) return null;
    let x0 = 0;
    let y0 = 0;
    let x1 = box.w;
    let y1 = box.h;
    for (const r of typed.rows) {
      const [from, to] = rowExtent(r);
      x0 = Math.min(x0, from);
      x1 = Math.max(x1, to);
      y0 = Math.min(y0, r.top);
      y1 = Math.max(y1, r.top + r.height);
    }
    return x0 < 0 || y0 < 0 || x1 > box.w || y1 > box.h ? { x0, y0, x1, y1 } : null;
  });

  // Selects raw [a, f], the focus on the side of a wrap `up` says.
  function setTypeSel(a, f, up = false) {
    setRawSel(a, f);
    edUp = up;
  }
  // A pointer on the rows: box-local page px with the turn undone and the
  // flip mirrored out (`maskLocal`), which is the frame the picture is painted
  // in and the rows are made in.
  const typeAt = (e) => offsetAt(typed.rows, ...maskLocal(e));

  // A press puts the caret at the nearest stop of the row it is level with, a
  // drag selects, and Shift extends. The second and third press of a
  // double-click and a triple-click are `onTypeMouseDown`'s, and the drag that
  // follows one of them goes by words, or by rows.
  //
  // The drag in hand: the pointer that began it (`id`: another pointer moving
  // over the picture, or let go, is not it), and for a drag by words or rows
  // what picks one (`pick`) and the one the press took (`base`), which stays
  // selected whichever way the pointer goes.
  let typeDrag = null;
  let curveDrag = null;
  // Default-only gestures keep their old listeners and pointer rules. Keep
  // their cleanup privately so an incoming Rust edit can end every one.
  const defaultCurveDrags = new Set();
  function endDefaultCurveDrags() {
    for (const drag of defaultCurveDrags) drag.end();
  }
  let menuBack = null;
  // A picture's drag/menu belongs to its current editing mode. Switching,
  // failure or a different model ends it; switching back never revives it.
  $effect(() => {
    if (enginePaints) endDefaultCurveDrags();
    const mode = typing ? typed.kind : null;
    if (mode !== 'flat') typeDrag?.end();
    if (mode !== 'curve') curveDrag?.end();
    if (!mode) menuBack?.(false);
  });
  function onTypePointerDown(e) {
    if (!editEl || composing || !typeFlat) return;
    // A second pointer while one is dragging is not a press of the text.
    if (typeDrag && typeDrag.id !== e.pointerId) return;
    if (e.button === 2) return typeMenu(e);
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const hit = typeAt(e);
    const anchor = e.shiftKey && edSel ? edSel.a : hit.o;
    goalX = null;
    setTypeSel(anchor, hit.o, hit.up);
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      // A pointer the browser no longer has: the press still placed the caret.
    }
    const drag = { id: e.pointerId, pick: null, base: null, end: null };
    const move = (ev) => {
      if (ev.pointerId !== drag.id || !typeFlat || composing) return;
      const [x, y] = maskLocal(ev);
      if (!drag.pick) {
        const h = offsetAt(typed.rows, x, y);
        return setTypeSel(anchor, h.o, h.up);
      }
      // By words or rows: from the far end of the one the press took to the
      // far end of the one under the pointer.
      const to = drag.pick(typed.rows, editEl.textContent, x, y);
      const lo = Math.min(drag.base.a, drag.base.f);
      const hi = Math.max(drag.base.a, drag.base.f);
      if (Math.min(to.a, to.f) < lo) setTypeSel(hi, Math.min(to.a, to.f), false);
      else if (Math.max(to.a, to.f) > hi) setTypeSel(lo, Math.max(to.a, to.f), to.up);
      else setTypeSel(drag.base.a, drag.base.f, drag.base.up);
    };
    const up = (ev) => {
      if (ev.pointerId !== drag.id) return;
      drag.end();
    };
    drag.end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      if (typeDrag === drag) typeDrag = null;
    };
    typeDrag?.end();
    typeDrag = drag;
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }
  // Default prevented, so the editable keeps the focus. The press count is
  // the mouse event's: two select a word and three a line of the picture, by
  // the rule the browser goes by in the editable (flat-caret.js `wordPress`,
  // `linePress`, which say what was measured). The drag the press began goes
  // on from there, by words or by rows.
  function onTypeMouseDown(e) {
    e.preventDefault();
    if (e.button !== 0 || e.detail < 2 || !editEl || composing || !typeFlat) return;
    const pick = e.detail === 2 ? wordPress : linePress;
    const to = pick(typed.rows, editEl.textContent, ...maskLocal(e));
    setTypeSel(to.a, to.f, to.up);
    if (typeDrag) Object.assign(typeDrag, { pick, base: to });
  }
  // The right button. The system's menu for text is offered only on an
  // editable, and the overlay is not one; so the word under the pointer is
  // selected (unless the press is on the selection), as the system does, and
  // the overlay steps aside for the menu's own hit test, which then finds the
  // editable under it and offers Cut, Copy and Paste on that selection.
  //
  // The editable is laid out by the browser, and a curve's is nothing like
  // the curve: what it has under the pointer is not what the picture has, or
  // is nothing (text past the frame, a curve's letters). The system selects
  // the word IT finds under a right press that is not on the selection. So
  // for as long as the overlay stands aside the editable is moved to put its
  // own selection under the pointer (`menuShift`): the press is then on the
  // selection, the system leaves it alone, and the menu is that selection's.
  function typeMenu(e) {
    menuBack?.(false);
    const el = e.currentTarget;
    const held = editEl.textContent;
    const lo = edSel ? Math.min(edSel.a, edSel.f) : 0;
    const hi = edSel ? Math.max(edSel.a, edSel.f) : 0;
    // On selected words of flat text: the menu of their faces. Anywhere else
    // the system's, with Paste.
    if (typeFlat && lo < hi) {
      const o = offsetAt(typed.rows, ...maskLocal(e)).o;
      if (o >= lo && o <= hi) {
        e.preventDefault();
        openFaceMenu(e.clientX, e.clientY);
        return;
      }
    }
    if (typeCurve) {
      const p = typeCurvePoint(e);
      const o = curveRaw(caretNearest(typeGlyphs, ...p));
      const g = glyphNearest(typeGlyphs, ...p);
      if (g && (lo === hi || o < lo || o > hi)) setRawSel(...wordAt(held, curveRaw(g.i)));
    } else {
      const [x, y] = maskLocal(e);
      const o = offsetAt(typed.rows, x, y).o;
      if (lo === hi || o < lo || o > hi) {
        const to = wordPress(typed.rows, held, x, y);
        setTypeSel(to.a, to.f, to.up);
      }
    }
    // The marks and the editable's own caret, as they are for this selection;
    // and the editable as it is while the overlay stands aside (a curve's is
    // clipped to the box at any other time, and what is clipped takes no
    // pointer), which is what is measured.
    flushSync();
    el.classList.add('ctx');
    const node = editEl;
    const at = menuRect(node);
    if (at) {
      const [x, y] = boxDelta(e.clientX - (at.left + at.width / 2), e.clientY - (at.top + at.height / 2));
      menuShift = { x, y };
      flushSync();
    }
    let afterTimer = null;
    const back = (align = true) => {
      clearTimeout(timer);
      clearTimeout(afterTimer);
      window.removeEventListener('contextmenu', after, true);
      if (menuBack !== back) return;
      el.classList.remove('ctx');
      menuBack = null;
      menuShift = null;
      // Back where its caret belongs.
      if (align && editEl === node && typing) {
        flushSync();
        alignNative(node);
      }
    };
    const after = () => {
      if (menuBack !== back) return;
      clearTimeout(afterTimer);
      afterTimer = setTimeout(back);
    };
    const timer = setTimeout(back, 1000);
    menuBack = back;
    window.addEventListener('contextmenu', after, true);
  }
  // A rectangle of the editable's own selection, on screen: of what is
  // selected, or of its caret when nothing is.
  function menuRect(node) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !node.contains(sel.focusNode)) return null;
    const rects = sel.getRangeAt(0).getClientRects?.();
    for (const r of rects ?? []) if (r.width > 0 && r.height > 0) return r;
    return nativeCaret(node);
  }

  // The keys that go by lines, on the picture's lines (`moveCaret`); true
  // when it took the key. Left and Right too: where a line wrapped, the
  // editable has two places for one offset and the browser would spend a
  // press moving between them. And on a Mac the keys the system binds to a
  // move or a cut by lines (`boundKey`): any other key with Option or Control
  // is the browser's.
  function typeKey(e) {
    if (!edSel) return false;
    const node = e.currentTarget;
    const bound = e.altKey || e.ctrlKey;
    const b = bound && isMacKeyboard() ? boundKey(e) : null;
    if (bound && !b) return false;
    if (b?.key === 'Kill') {
      e.preventDefault();
      const { a, f } = edSel;
      applyEdit(node, a !== f ? [Math.min(a, f), Math.max(a, f)] : lineDeleteSpan(typed.rows, node.textContent, f, edUp, 'deleteHardLineForward'), 'deleteContentForward');
      return true;
    }
    const to = moveCaret(typed.rows, node.textContent, { a: edSel.a, f: edSel.f, up: edUp }, b ? b.key : e.key, { shift: b ? b.shift : e.shiftKey, mod: !b && e.metaKey }, goalX);
    if (!to) return false;
    e.preventDefault();
    setTypeSel(to.a, to.f, to.up);
    goalX = to.goal;
    return true;
  }

  // ----- the curve, as a picture -----
  // The glyphs the painter places (`placeBlock`'s, in page px from the box
  // centre), in the zoomed px the marks are drawn in.
  // A column's glyphs carry their stretch of the column too (`verticalLayout`).
  const typeGlyphs = $derived(typeCurve ? typed.glyphs.map((g) => (g.flow == null ? { ...g, x: g.x * z, y: g.y * z, w: g.w * z } : zoomColumnGlyph(g, z))) : null);
  // A raw offset as a glyph, and a glyph as a raw offset. The glyphs are the
  // CASED text's, which is longer where uppercasing made a letter two
  // (`typed.map`).
  const curveGlyph = (o) => (typed.map ? glyphIndex(typed.drawn, typed.map.toDrawn[Math.min(o, typed.map.toDrawn.length - 1)]) : glyphIndex(typed.drawn, o));
  const curveRaw = (i) => (typed.map ? rawAtDrawn(typed.map, rawIndex(typed.drawn, i)) : rawIndex(typed.drawn, i));
  function typeCurveMarks() {
    const a = curveGlyph(edSel.a);
    const f = curveGlyph(edSel.f);
    const c = composeSpan;
    return {
      caret: caretAt(typeGlyphs, f),
      off: a !== f,
      sel: selectionBoxes(typeGlyphs, a, f),
      comp: c ? selectionBoxes(typeGlyphs, curveGlyph(c[0]), curveGlyph(c[1])) : [],
    };
  }
  // A pointer in the glyphs' frame: from the box centre, in zoomed px, the
  // turn undone and the flip mirrored out.
  function typeCurvePoint(e) {
    const [x, y] = maskLocal(e);
    return [(x - box.w / 2) * z, (y - box.h / 2) * z];
  }

  // ----- the editable's own caret -----
  // The system puts an IME's window, and anything else it hangs on the
  // caret, where the EDITABLE's caret is. The editable is laid out by the
  // browser and the picture by the engine, and the two do not agree to the
  // pixel (a synthesised bold advances differently; a curve is not laid out
  // by the browser at all). So the editable is moved by the difference: the
  // drawn caret's centre less the native caret's, measured on screen and
  // taken back through the box's turn and flip into the editable's frame.
  let nudge = $state({ x: 0, y: 0 });
  function nativeCaret(node) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !node.contains(sel.focusNode)) return null;
    const { focusNode: n, focusOffset: o } = sel;
    const r = document.createRange();
    r.setStart(n, o);
    r.collapse(true);
    const rect = r.getClientRects?.()?.[0];
    if (rect) return rect;
    // Some places have no rectangle of their own (measured, Chromium 155). In
    // front of a Return that starts its text node - the end of a line, which
    // `drawEditLines` writes as a node of its own - the Return has one, as
    // wide as nothing, where the caret is.
    if (n.nodeType === 3) {
      if (n.data[o] !== '\n') return null;
      r.setEnd(n, o + 1);
      return r.getClientRects?.()?.[0] ?? null;
    }
    // A line with nothing on it: its `<br>` has one.
    const at = n.childNodes[o] ?? n;
    const br = at.nodeName === 'BR' ? at : !at.textContent ? at.querySelector?.('br') : null;
    return br?.getBoundingClientRect() ?? null;
  }
  // A distance on screen, in the editable's own frame: back through the
  // box's turn and its flip.
  function boxDelta(dx, dy) {
    const rad = (-(s.rotation || 0) * Math.PI) / 180;
    return flipDelta([dx * Math.cos(rad) - dy * Math.sin(rad), dx * Math.sin(rad) + dy * Math.cos(rad)], s);
  }
  function alignNative(node) {
    // Moved aside for the system's menu (`typeMenu`): not where it belongs.
    if (menuShift) return;
    try {
      const mark = node.parentNode?.querySelector('.tcaret, .ccaret');
      const n = mark && nativeCaret(node);
      if (!n) return;
      const m = mark.getBoundingClientRect();
      const [lx, ly] = boxDelta(m.left + m.width / 2 - (n.left + n.width / 2), m.top + m.height / 2 - (n.top + n.height / 2));
      if (Math.abs(lx) < 0.25 && Math.abs(ly) < 0.25) return;
      nudge = { x: nudge.x + lx, y: nudge.y + ly };
    } catch {
      // A caret the system has a little off is not worth an edit.
    }
  }
  // Where the editable is moved to for the system's menu, on top of `nudge`:
  // set for as long as the overlay stands aside for it (`typeMenu`).
  let menuShift = $state(null);
  // Where the editable is moved to: by the ink's centring (`inkShift`), as
  // with the switch off, and while it is unseen by `nudge` as well.
  const editShift = $derived.by(() => {
    if (!typing) return inkShift ? `transform:translateY(${inkShift}px);` : '';
    const x = nudge.x + (menuShift?.x ?? 0);
    const y = nudge.y + inkShift + (menuShift?.y ?? 0);
    return x || y ? `transform:translate(${x}px,${y}px);` : '';
  });

  const corners = [['corner', 'nw'], ['corner', 'ne'], ['corner', 'sw'], ['corner', 'se']];
  // No top edge: the height is the text's. The bottom edge is the size
  // handle, drawn apart from the two width handles.
  const sides = [['side size', 's'], ['side', 'w'], ['side', 'e']];
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="tbox"
  class:selected
  class:editing
  class:bulk-on={bulkOn}
  class:bulk-target={bulkTarget}
  class:flagged={!!review}
  data-id={box.id}
  style={boxStyle}
  role={spoken ? 'group' : undefined}
  aria-label={spoken ?? undefined}
  onpointerdown={onBoxPointerDown}
  oncontextmenu={onBoxContextMenu}
  ondblclick={onDblClick}
>
  {#if s.roughen.on && !engineShown}
    <svg class="rough-def" width="0" height="0" aria-hidden="true">
      <!-- The filter runs in CSS px, which are ZOOMED px, so both of its numbers
           have to be turned back into the page's own units or the roughening is
           a different roughening at every zoom - and only ever matched the
           export at 100%. `amount` is a displacement, so it grows with the zoom;
           `detail` is a frequency, so it shrinks. The exporter states the same
           two numbers in page px against the same noise (see `roughen` and
           text-paint.js), which is what makes the export the picture on the
           canvas rather than one like it. -->
      <!-- The region has to hold the displacement as well as the text, and it is
           a share of the element's own size: a small box with a large `amount`
           had its crumple cut off square at the old -30%/160%, which the export
           (padded in absolute px) then did not do. Half the block again on every
           edge covers any amount the panel offers on any box worth reading. -->
      <filter id={roughId} x="-50%" y="-50%" width="200%" height="200%">
        <feTurbulence type="fractalNoise" baseFrequency={s.roughen.detail / z} numOctaves={OCTAVES} seed={s.roughen.seed} result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale={s.roughen.amount * z} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  {/if}

  {#if !engineShown && mbTaps.length}
    <svg class="rough-def" width="0" height="0" aria-hidden="true">
      <!-- The directional smear, as the exporter's tap list stated in SVG:
           every tap is shifted off the source and added into a running sum
           (feComposite/arithmetic, k2 = the tap's weight, k3 = 1), which is
           exactly the exporter's 'lighter' accumulation. sRGB interpolation,
           because canvas compositing is sRGB and the two smears must be one
           smear. Offsets are page px scaled by the zoom, like the blur
           radius. The first tap is the centre one (dx = dy = 0), so it seeds
           the sum straight off SourceGraphic. -->
      <filter id={mbId} x={mbRegion.x} y={mbRegion.y} width={mbRegion.w} height={mbRegion.h} color-interpolation-filters="sRGB">
        {#each mbTaps as t, i (i)}
          {#if i === 0}
            <feComposite in="SourceGraphic" in2="SourceGraphic" operator="arithmetic" k1="0" k2={t.w} k3="0" k4="0" result="p0" />
          {:else}
            <feOffset in="SourceGraphic" dx={t.dx * z} dy={t.dy * z} result={`t${i}`} />
            <feComposite in={`t${i}`} in2={`p${i - 1}`} operator="arithmetic" k1="0" k2={t.w} k3="1" k4="0" result={`p${i}`} />
          {/if}
        {/each}
      </filter>
    </svg>
  {/if}

  {#if hollowDefs.length}
    <svg class="rough-def" width="0" height="0" aria-hidden="true">
      <!-- A matte to a cut-out stroke (see `hollowMatte`). The colour matrix
           works on colour that is not premultiplied, so at the stroke's soft
           outer edge red is still 1: the second step multiplies the source's
           own alpha back in. sRGB, so the flood is the colour as written. -->
      {#each hollowDefs as h (h.id)}
        <filter id={h.id} x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">
          <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" result="m" />
          <feComposite in="m" in2="SourceAlpha" operator="in" result="ring" />
          <feFlood flood-color={h.color} flood-opacity={h.opacity} />
          <feComposite in2="ring" operator="in" />
        </filter>
      {/each}
    </svg>
  {/if}

  {#if selected && jp}
    <div class="jp-pill" class:sfx={isSfx} contenteditable="false">{jp}</div>
  {/if}

  {#if review}
    <!-- The "needs review" flag (UX-6): the text does not fit this box, and by
         how far - the containment check's verdict, never a clip. Outside the
         clip wrapper so a mask cannot hide it; it turns with the box, as the
         handles do. The reason is in the tooltip and in the queue's list.
         A solver overflow crosses no edge of the box - it is the balloon the
         text leaves - so it has no distance to show, only the mark. -->
    {@const reach = reviewReach(review)}
    <div class="review-badge" contenteditable="false" role="img" title={reviewTitle(review)} aria-label={reviewTitle(review)}>
      !{#if reach}<span>{reach}px</span>{/if}
    </div>
  {/if}

  <!-- On a locked box only: the padlock, which unlocks it. -->
  {#if locked}<LockChip {box} />{/if}

  <!-- The wrapper exists for the mask: `mask-image` needs an element whose
       (0,0) is the box's own top-left, and the text stack is a centred flex
       child with no fixed origin. It replicates the box's flex layout and
       padding, so with the mask off it changes nothing. The selection
       handles and the jp pill stay outside it, unmasked. It also carries the
       flip, over the mask, as the export does (`wrapMirror`). -->
  <div
    class="clipwrap"
    style="justify-content:{justify};align-items:{alignItems};padding:{pad}px;{pictured ? '' : maskCss}{wrapMirror}"
  >
  {#if enginePaints}
    <!-- What tells whether the box is near the viewport (`reach`, above):
         nothing to see and nothing to click, only a rectangle for the
         observer. Inside the wrapper so it is mirrored as the picture is. -->
    <div
      class="reach"
      bind:this={reachEl}
      style={reach
        ? `left:${-reach.ox * z}px;top:${-reach.oy * z}px;width:${reach.cw * z}px;height:${reach.ch * z}px`
        : 'left:0;top:0;width:100%;height:100%'}
      aria-hidden="true"
    ></div>
  {/if}
  {#if pictured}
    <!-- The whole box as one picture: type, ink and every filter, carried
         through the mesh by the exporter's painter. Placed off the box's own
         top-left by however far the deformed mesh reached past it, which is
         what `paintWarpedBox` hands back.
         The mask is NOT applied to it by the wrapper above: it is already
         inside these pixels, because `renderBox` composites it before the mesh
         carries the texture, and applying it a second time in box coordinates
         would crop the warped picture against the unwarped shape.
         The mirror IS applied, by the wrapper, for the opposite reason: the
         export flips the finished bitmap around the box's centre rather than
         baking the flip into it (see paintBoxOnPage).
         The engine's picture of an unwarped box is the same canvas for the
         same reasons - `renderBoxTexture` has the mask in it and neither the
         flip, the turn nor the opacity, which stay CSS on the wrapper and on
         the box - set on whole device pixels where that keeps it sharp
         (`pictureCss`), and painted moved by the fraction of a pixel that
         snap takes away (`phase`), so the letters still land exactly. A pinch
         does not lay the box out again (Canvas.svelte scales the page as one
         picture until it settles), so nothing here moves while one is in
         flight. -->
    <canvas
      class="warpl"
      bind:this={warpEl}
      data-painter={engineShown ? 'engine' : undefined}
      style={warpGeom
        ? engineShown
          ? pictureCss(warpGeom, z, displayScale(), s.rotation || mirror ? null : box)
          : `left:${-warpGeom.ox * z}px;top:${-warpGeom.oy * z}px;width:${warpGeom.cw * z}px;height:${warpGeom.ch * z}px;`
        : 'left:0;top:0;width:0;height:0'}
      aria-hidden="true"
    ></canvas>
    {#if hitsOn}
      <!-- What takes the pointer for text outside the frame (`hitsOn`, above).
           No pointer-events of their own: they follow the box, which the hand
           tool makes deaf. -->
      {#if layout}
        {#each layout as g, i (i)}
          <span class="hit" style="left:50%;top:50%;width:{glyphReach(g)}px;height:{hitLine * (Number.isFinite(g.sy) ? Math.abs(g.sy) : 1)}px;transform:translate(calc(-50% + {g.x}px), calc(-50% + {g.y}px)) rotate({g.rot}rad)"></span>
        {/each}
      {:else if hitBlock}
        <span class="hit" style="left:{hitBlock.x0 * z}px;top:{hitBlock.y0 * z}px;width:{(hitBlock.x1 - hitBlock.x0) * z}px;height:{(hitBlock.y1 - hitBlock.y0) * z}px"></span>
      {/if}
    {/if}
  {:else if layout}
      <!-- Curved text is placed glyph by glyph, so each layer of the stack is a
           full set of glyph spans; they are all absolutely positioned already, so
           no layer has to hold the others up. A line the engine shaped whole
           (`g.whole`, measure.js `lineClusters`) centres each cluster on the
           room the line gives it, kerning included: its span is that wide
           and starts the letter at its left, so the browser's letter, shaped
           alone, stands at the line's pen and not half a kern off. -->
      <div class="arcstack" style={filterCss}>
        {#each layers as ly, li (li)}
          <div class="arc" style={ly.arc}>
            {#each layout as g, i (i)}
              <span
                class="arc-ch"
                style="{textStyle}{g.whole && Number.isFinite(g.w) ? `width:${g.w}px;text-align:left;` : ''}{ly.bg
                  ? `${ly.bg}background-size:${ly.tile ? `${ly.tile}px ${ly.tile}px` : `${box.w * z}px ${box.h * z}px`};background-position:${-((box.w * z) / 2 + g.x - g.w / 2)}px ${-((box.h * z) / 2 + g.y - effSize / 2)}px;`
                  : ''}transform:translate(calc(-50% + {g.x}px), calc(-50% + {g.y}px)) rotate({g.rot}rad){g.sx != null ? ` scale(${g.sx}, ${g.sy ?? 1}) skewX(${g.skew ?? 0}rad)` : ''}"
              >{g.ch}</span>
            {/each}
          </div>
        {/each}
      </div>
  {/if}
    <!-- The editable is ONE element whichever way the box is shown - under
         the engine's picture (`typing`) or as the text itself - so a picture
         that stops being painted in the middle of an edit hands the box back
         to its text with the caret, the selection and the focus where they
         were. -->
    {#if editing && (typing || !pictured)}
      {#if typeFlat}
        <!-- Straight text typed into as its picture: this takes the pointer
             and holds the caret, the selection and the span an IME is
             composing, drawn from the painter's own rows. In the wrapper, so
             the flip carries them as it carries the picture. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="type-edit" onpointerdown={onTypePointerDown} onmousedown={onTypeMouseDown} ondblclick={(e) => e.stopPropagation()}>
          {#if typePad}
            <span class="tpad" style="left:{typePad.x0 * z}px;top:{typePad.y0 * z}px;width:{(typePad.x1 - typePad.x0) * z}px;height:{(typePad.y1 - typePad.y0) * z}px"></span>
          {/if}
          {#if typeMarks}
            {@const c = typeMarks.caret}
            {#each typeMarks.sel as r, i (i)}
              <span class="tsel" style="left:{r.x * z}px;top:{r.y * z}px;width:{r.w * z}px;height:{r.h * z}px"></span>
            {/each}
            {#each typeMarks.comp as r, i (i)}
              <span class="tcomp" style="left:{r.x * z}px;top:{(r.y + r.h) * z - 2}px;width:{r.w * z}px"></span>
            {/each}
            <!-- Made again where it moves, so it is lit when it arrives. -->
            {#key `${c.x}|${c.top}`}
              <span class="tcaret" class:off={!typeMarks.on} style="left:{c.x * z}px;top:{c.top * z}px;height:{c.height * z}px"></span>
            {/key}
          {/if}
        </div>
      {:else if curveEdit || typeCurve}
        <!-- Curved text being typed into: the glyphs above are the result's,
             and this draws the caret and the selection on them and takes the
             pointer, so a click lands on the glyph under it rather than in the
             editable below, which holds the text and is not seen. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="curve-edit" onpointerdown={onCurvePointerDown} onmousedown={(e) => e.preventDefault()} ondblclick={onCurveDblClick}>
          {#if typeCurve}
            <!-- A curve leaves the frame, and its picture takes no pointer: a
                 target a glyph, where the glyph is, as the picture at rest
                 has (`hitsOn`). -->
            {#each typeGlyphs as g, i (i)}
              <span class="tpad" style="left:50%;top:50%;width:{glyphReach(g)}px;height:{hitLine * (Number.isFinite(g.sy) ? Math.abs(g.sy) : 1)}px;transform:translate(calc(-50% + {g.x}px), calc(-50% + {g.y}px)) rotate({g.rot}rad)"></span>
            {/each}
          {/if}
          {#if curveMarks}
            {#each curveMarks.sel as r, i (i)}
              <span class="csel" style="width:{r.w}px;height:{effSize}px;transform:translate(calc(-50% + {r.x}px), calc(-50% + {r.y}px)) rotate({r.rot}rad)"></span>
            {/each}
            {#if curveMarks.comp}
              {#each curveMarks.comp as r, i (i)}
                <span class="csel ccomp" style="width:{r.w}px;height:{effSize}px;transform:translate(calc(-50% + {r.x}px), calc(-50% + {r.y}px)) rotate({r.rot}rad)"></span>
              {/each}
            {/if}
            {#if curveMarks.caret}
              {@const c = curveMarks.caret}
              <span class="ccaret" class:off={curveMarks.off} style="height:{effSize}px;transform:translate(calc(-50% + {c.x}px), calc(-50% + {c.y}px)) rotate({c.rot}rad)"></span>
            {/if}
          {/if}
        </div>
      {/if}
      <div
        class="txt editable"
        class:ghost={curveEdit || (typing && curved)}
        class:unseen={typing}
        contenteditable="true"
        style="{typing ? textStyle : editStyle}{editShift}"
        use:editField
        onbeforeinput={onEditBeforeInput}
        oninput={onEditInput}
        oncompositionstart={onCompositionStart}
        oncompositionend={onCompositionEnd}
        onpaste={onEditPaste}
        oncopy={onEditCopy}
        oncut={onEditCopy}
        ondragstart={(e) => e.preventDefault()}
        onblur={onEditBlur}
        onkeydown={onEditKey}
        oncontextmenu={onEditContextMenu}
      ></div>
    {:else if !pictured && !layout}
      <div class="txt shaped stack" style="{textStyle}{stackTransform}{filterCss}">
        {#each layers as ly, li (li)}
          <div class="tlayer" class:base={li === 0} style={ly.css}>
            {#each shaped as ln, i (i)}<div class="tline" style="{ly.line}{indentCss(i)}">{#if lineCuts?.[i]}{#each lineCuts[i] as p, j (j)}<span style={p.css}>{ln.slice(p.start, p.end)}</span>{/each}{:else}{ln === '' ? '\u200b' : ln}{/if}</div>{/each}
          </div>
        {/each}
      </div>
    {/if}
    {#if !pictured && inkActive(s.ink)}
      <!-- Inside the clip wrapper so the visibility mask hides ink the same way
           it hides letters; positioned off the box's own top-left, offset by the
           overhang the canvas was grown by. -->
      <canvas
        class="inkl"
        bind:this={inkEl}
        style="left:{-inkPad.l * z}px;top:{-inkPad.t * z}px;width:{(box.w + inkPad.l + inkPad.r) * z}px;height:{(box.h + inkPad.t + inkPad.b) * z}px"
        aria-hidden="true"
      ></canvas>
    {/if}
  </div>

  {#if gizmoLine}
    <!-- The path gizmo: the baked curve and an anchor per point, round when
         smooth and square when a corner, with the handles of corners, of
         hand-set anchors and of the anchor last pressed. Every control has a
         wide invisible hit shape over a small visible mark, and the curve
         itself takes a press (add an anchor there). Outside the clip wrapper on
         purpose - the curve must stay visible where the clip has cropped the
         letters - and so it carries the box's flip itself, as the curve the
         letters follow does. -->
    <svg class="path-gizmo" width={box.w * z} height={box.h * z} style={overlayMirror} aria-hidden="true">
      <polyline class="pline" points={gizmoLine} />
      <polyline class="phit" points={gizmoLine} onpointerdown={onPathLinePointerDown} />
      {#each s.path.pts as p, i (i)}
        {#if !p.auto || i === pathActive}
          {#if i > 0 && Math.hypot(p.ix, p.iy) * z > 1}
            <line x1={p.x * z} y1={p.y * z} x2={(p.x + p.ix) * z} y2={(p.y + p.iy) * z} />
            <circle class="ph" cx={(p.x + p.ix) * z} cy={(p.y + p.iy) * z} r="3.5" />
            <circle class="hit" cx={(p.x + p.ix) * z} cy={(p.y + p.iy) * z} r="9" onpointerdown={(e) => startPathDrag(e, i, 'in')} />
          {/if}
          {#if i < s.path.pts.length - 1 && Math.hypot(p.ox, p.oy) * z > 1}
            <line x1={p.x * z} y1={p.y * z} x2={(p.x + p.ox) * z} y2={(p.y + p.oy) * z} />
            <circle class="ph" cx={(p.x + p.ox) * z} cy={(p.y + p.oy) * z} r="3.5" />
            <circle class="hit" cx={(p.x + p.ox) * z} cy={(p.y + p.oy) * z} r="9" onpointerdown={(e) => startPathDrag(e, i, 'out')} />
          {/if}
        {/if}
      {/each}
      {#each s.path.pts as p, i (i)}
        {#if p.auto}
          <circle class="pa" class:active={i === pathActive} cx={p.x * z} cy={p.y * z} r="5" />
        {:else}
          <rect class="pa" class:active={i === pathActive} x={p.x * z - 4.5} y={p.y * z - 4.5} width="9" height="9" />
        {/if}
        <circle
          class="hit anchor"
          cx={p.x * z}
          cy={p.y * z}
          r="11"
          onpointerdown={(e) => startPathDrag(e, i, 'a')}
          ondblclick={(e) => onAnchorDblClick(e, i)}
          oncontextmenu={(e) => onAnchorContextMenu(e, i)}
        />
      {/each}
    </svg>
  {/if}

  {#if specialHandles.length}
    <!-- The special effects' handles (special.js): a point each, and the
         lightning's arm. Stated in the box's own unflipped frame and carried
         by its warp mesh and its flip, as the picture is. -->
    <svg class="special-gizmo" width={box.w * z} height={box.h * z} style={overlayMirror} aria-hidden="true">
      {#each specialHandles as h (h.kind)}
        {#if h.arm}
          <line class="sarm" x1={h.at.x * z} y1={h.at.y * z} x2={h.arm.x * z} y2={h.arm.y * z} />
          <circle class="send" cx={h.arm.x * z} cy={h.arm.y * z} r="4" />
          <circle class="hit arm" data-kind={h.kind} cx={h.arm.x * z} cy={h.arm.y * z} r="9" onpointerdown={(e) => startSpecialDrag(e, h.kind, 'arm')}><title>Lightning direction: drag to aim the bolts</title></circle>
        {/if}
        <circle class="spt {h.kind}" cx={h.at.x * z} cy={h.at.y * z} r="6" />
        <circle class="hit point" data-kind={h.kind} cx={h.at.x * z} cy={h.at.y * z} r="11" onpointerdown={(e) => startSpecialDrag(e, h.kind, 'point')}><title>{HANDLE_TITLES[h.kind]}</title></circle>
      {/each}
    </svg>
  {/if}

  {#if liquifyOn}
    <!-- The surface that turns a drag into a liquify. Full-box and on top, the
         same shape the mask tool's capture rect has; without it the drag lands
         on the box and moves it instead. Outside the clip wrapper so a mask
         cannot hide it. -->
    <div
      class="liq-capture"
      style="width:{box.w * z}px;height:{box.h * z}px"
      onpointerdown={onLiquifyPointerDown}
      onpointermove={onLiquifyPointerMove}
      onpointerenter={onLiquifyPointerMove}
      onpointerleave={onLiquifyPointerLeave}
      aria-hidden="true"
    ></div>
  {/if}

  {#if liquifyRing}
    <!-- The tool's own circle, at its radius in PAGE px times the zoom: what
         the next application would reach. Drawn rather than made a CSS cursor
         because the radius goes to 300 page px and a cursor image cannot. -->
    <div
      class="liq-ring"
      style="left:{liquifyRing.x * z}px;top:{liquifyRing.y * z}px;width:{liquifyRing.d}px;height:{liquifyRing.d}px"
      aria-hidden="true"
    ></div>
  {/if}

  {#if warpGizmoOn}
    <!-- The mesh's handles. `maskLocal` is the box's own client -> box-local
         conversion, rotation undone and the flip mirrored out - the frame the
         mesh is stored in - and the gizmo takes it rather than working the same
         thing out a second time. -->
    <WarpGizmo {box} pageId={pg.id} {z} toLocal={maskLocal} painter={warpPainter} />
  {/if}

  {#if sfxGizmoOn}
    <!-- Over the resize handles (z-index), which stay: a path's end can sit
         near a side handle, and the one asked for by the SFX wins there. -->
    <SfxGizmo {box} pageId={pg.id} {z} text={applyCase(text, s)} toLocal={sfxLocal} frameRect={sfxFrameRect} />
  {/if}

  <!-- The box's own resize and rotate handles stand down while the gizmo is up.
       They have to: a 1x1 mesh puts a control point on each corner of the box,
       exactly where the corner resize handles sit, and two controls in one place
       is a coin toss over which one a drag gets. The gizmo's handles are the
       ones the sub-tab was opened for, so they win by being the only ones there
       - and the box still MOVES by its body, because a warp handle stops its own
       pointerdown from reaching it. -->
  {#if handlesOn}
    <div class="rotate-stem"></div>
    {#each corners as [kind, dir] (dir)}
      <div class="handle {kind} {dir}" onpointerdown={(e) => startTransform(e, dir)}></div>
    {/each}
    {#each sides as [kind, dir] (dir)}
      <div class="handle {kind} {dir}" onpointerdown={(e) => startTransform(e, dir)}></div>
    {/each}
    <div class="handle rot" onpointerdown={(e) => startTransform(e, 'rot')}></div>
    {#if sizingDrag}
      <!-- What the drag is setting, as it sets it: the box and the type. -->
      <div class="size-chip" aria-hidden="true">{Math.round(box.w)} × {Math.round(box.h)} · {s.size} px</div>
    {/if}
  {/if}
</div>

{#if maskShapesShown}
  <!-- The mask's page layer: a sibling of the box, over the whole page, since
       the shapes are pinned to the page and may lie anywhere on it. It
       outlines every shape (and the drag in progress) so the user can see what
       they have painted where the mask has hidden the letters, and - while a
       tool is armed - takes the pointer over the whole page. -->
  <div class="draw-page" class:armed={maskArmed} class:fade={shownTarget === 'fade'} class:paint={shownTarget === 'paint'} aria-hidden="true">
    <svg class="mask-gizmo" width="100%" height="100%">
      {#if maskArmed}
        <rect
          class="capture"
          class:move={maskKind === 'move'}
          x="0"
          y="0"
          width="100%"
          height="100%"
          onpointerdown={onMaskPointerDown}
          onpointermove={onMaskPointerMove}
          onpointerenter={onMaskPointerMove}
          onpointerleave={onMaskPointerLeave}
          ondblclick={onMaskDblClick}
        />
      {/if}
      {#each maskShapesShown as sh, i (i)}
        {#if sh}
          {@const picked = maskKind === 'move' && maskDraft.picked === i}
          {#if sh.kind === 'ellipse'}
            <ellipse class:picked class:hide={sh.op === 'hide' || sh.erase} cx={sh.cx * z} cy={sh.cy * z} rx={sh.rx * z} ry={sh.ry * z} />
          {:else if sh.kind === 'poly'}
            <polygon class:picked class:hide={sh.op === 'hide' || sh.erase} points={outline(sh.pts)} />
          {:else}
            <polyline class="stroke" class:picked class:hide={sh.op === 'hide' || sh.erase} points={outline(sh.pts)} style="stroke-width:{sh.size * z}px" />
          {/if}
        {/if}
      {/each}
      {#if maskDraft.poly}
        <polyline class="draft" points={outline(maskDraft.poly)} />
        {#each maskDraft.poly as p, i (i)}
          <circle class="vert" cx={p[0] * z} cy={p[1] * z} r="3.5" />
        {/each}
      {/if}
    </svg>
    {#if maskRing}
      <!-- The brush's own circle, its width at the zoom, as liquify's. -->
      <div class="liq-ring" style="left:{maskRing.x * z}px;top:{maskRing.y * z}px;width:{maskRing.d}px;height:{maskRing.d}px"></div>
    {/if}
  </div>
{/if}

<style>
  /* The layer stack. Every layer holds the same lines and lays out identically;
     the first one is in flow and gives the block its height, the rest sit over
     it. A layer's own transform (a shadow's offset) moves what is painted and
     not what is measured, so the stack cannot come apart. */
  .stack { position: relative; }
  .tlayer { position: absolute; left: 0; top: 0; width: 100%; }
  .tlayer.base { position: relative; }
  /* Curved layers are already absolute (.arc is inset:0), so this only has to
     give them something to be absolute inside. */
  .arcstack { position: absolute; inset: 0; }
  /* The clip wrapper mirrors the box's own flex layout (justify/align/padding
     are inlined per box) so the text lands exactly where it did as a direct
     child. Its border box IS the box rect, which is the frame the clip-path
     is stated in. */
  .clipwrap { position: absolute; inset: 0; display: flex; box-sizing: border-box; }
  /* The ink layer. Absolute so it does not disturb the text's flex centring,
     and never a pointer target: the strokes are drawn on the brush board and
     placed here whole. */
  .inkl {
    position: absolute;
    pointer-events: none;
  }
  /* The warped box. Same shape as the ink layer - absolute, never a pointer
     target - and `user-select:none` because there is no text under the cursor
     here to select, only pixels. */
  .warpl {
    position: absolute;
    pointer-events: none;
    user-select: none;
    -webkit-user-select: none;
  }
  /* The engine's picture is painted in a layer of its own. WebKit paints a
     canvas into a rect rounded to whole CSS px from the origin of the layer it
     is painted in; that origin is set on a device pixel, and the box's own
     layer origin is where the box is - so the picture landed up to a device
     pixel off where `pictureCss` put it. With its own layer the origin is the
     picture's corner, which `pictureCss` has already set on a device pixel,
     and the rect from there is whole CSS px (`show` in box-picture.js). An
     identity transform makes the layer and moves nothing. */
  .warpl[data-painter='engine'] {
    transform: translate(0, 0);
  }
  /* A transparent pointer target over text that the engine's picture shows
     outside the box's frame. */
  .hit {
    position: absolute;
    user-select: none;
    -webkit-user-select: none;
  }
  /* The rectangle the near-viewport observer is given for a box shown as the
     engine's picture. It is geometry only. */
  .reach {
    position: absolute;
    visibility: hidden;
    pointer-events: none;
  }
  /* The path gizmo. The svg itself lets clicks through to the box; only the
     hit shapes take the pointer, and they are drawn wider than the marks under
     them so a point is easy to catch at any zoom. High-contrast colours so the
     curve and handles read on both white pages and dark art. On top of the box's
     other overlays (z-index), and the resize handles stand down meanwhile. */
  .path-gizmo { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; z-index: 5; }
  .path-gizmo .pline { fill: none; stroke: #00d5e0; stroke-width: 1.5; }
  .path-gizmo .phit { fill: none; stroke: transparent; stroke-width: 14; stroke-linecap: round; pointer-events: stroke; cursor: copy; }
  .path-gizmo line { stroke: #663399; stroke-width: 1; }
  .path-gizmo .hit { fill: transparent; pointer-events: all; cursor: grab; }
  .path-gizmo .hit:active { cursor: grabbing; }
  .path-gizmo .pa { fill: #e33; stroke: #fff; stroke-width: 1.5; }
  .path-gizmo .pa.active { stroke: #00d5e0; stroke-width: 2.5; }
  .path-gizmo .ph { fill: #fff; stroke: #663399; stroke-width: 1.5; }
  /* The mask overlay. Shape outlines are hints, not paint, drawn in the page
     tint that does not invert, because they sit over paper in every theme.
     An exclude shape is filled darker than an include one: darker is the ink
     that goes away. The capture rect is the drawing surface while a tool is
     armed; it reaches past the box exactly as far as the mask image does. */
  /* Over every box on the page, so a shape can be drawn over any of them. */
  .draw-page { position: absolute; inset: 0; pointer-events: none; z-index: 40; }
  /* The special effects' handles: only the marks take the pointer. */
  .special-gizmo { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; z-index: 6; }
  .special-gizmo .spt { stroke: #fff; stroke-width: 2; fill: #e33; }
  .special-gizmo .spt.lightning { fill: #1e90ff; }
  .special-gizmo .spt.splash { fill: #e6a100; }
  .special-gizmo .sarm { stroke: #1e90ff; stroke-width: 2; }
  .special-gizmo .send { fill: #fff; stroke: #1e90ff; stroke-width: 2; }
  .special-gizmo .hit { fill: transparent; pointer-events: all; cursor: grab; }
  .special-gizmo .hit:active { cursor: grabbing; }
  .mask-gizmo { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .mask-gizmo .capture { fill: transparent; pointer-events: all; cursor: crosshair; touch-action: none; }
  .mask-gizmo .capture.move { cursor: move; }
  .mask-gizmo ellipse, .mask-gizmo polygon { fill: color-mix(in srgb, var(--tintline) 8%, transparent); stroke: var(--tintline); stroke-width: 1; }
  .mask-gizmo .stroke { fill: none; stroke: color-mix(in srgb, var(--tintline) 14%, transparent); stroke-linecap: round; stroke-linejoin: round; }
  .mask-gizmo ellipse.hide, .mask-gizmo polygon.hide { fill: color-mix(in srgb, var(--tintline) 22%, transparent); }
  .mask-gizmo .stroke.hide { stroke: color-mix(in srgb, var(--tintline) 30%, transparent); }
  .mask-gizmo .picked { stroke-width: 2.5; stroke-dasharray: 5 3; }
  .mask-gizmo .stroke.picked { stroke: var(--tint); stroke-dasharray: none; }
  /* A fade's shapes take opacity, not the letters: dashed, never filled as
     a hide. */
  .draw-page.fade .mask-gizmo ellipse, .draw-page.fade .mask-gizmo polygon { stroke-dasharray: 3 3; }
  .mask-gizmo .draft { fill: none; stroke: var(--tintline); stroke-width: 1.5; stroke-dasharray: 4 3; }
  .mask-gizmo .vert { fill: var(--tintline); stroke: var(--paper); stroke-width: 1; }
  /* The liquify tool's capture surface. `touch-action: none` so a pen or a
     finger drags instead of scrolling the page out from under the tool. */
  .liq-capture {
    position: absolute;
    left: 0;
    top: 0;
    cursor: crosshair;
    touch-action: none;
    z-index: 3;
  }
  /* Liquify draws its own circle, and the crosshair inside it says where the
     centre is - so both are shown. A darker ring under the first, so the circle
     reads on white paper and on black art alike. */
  .liq-ring {
    position: absolute;
    border: 1px solid rgba(255, 153, 0, 0.9);
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35) inset;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 4;
  }
  .jp-pill {
    font-family: 'Noto Sans JP', 'Hiragino Kaku Gothic Pro', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', sans-serif;
  }
</style>
