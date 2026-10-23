<script module>
  // What the canvas around the box needs from the gizmo: whether a letter is
  // picked (the legend chip, Canvas.svelte) and the stage's visible size,
  // which Canvas writes and the gizmo's scale is read from.
  export const gizmoUi = $state({ letter: false, stageW: 0, stageH: 0 });
</script>

<script>
  // ===== The SFX handles =====
  //
  // The reference's handles (docs/giongo/04-reference-controls.md 2 and 3),
  // over a selected SFX box:
  //
  // - Each text group's path: its curve dashed, a blue dot at its start, an
  //   orange one at its end with a small arrow past it, and a white diamond ON
  //   the curve's middle that bends it. An end follows the pointer from where
  //   it was grabbed; the diamond follows only the pointer's distance across
  //   the chord.
  // - A press on a letter picks it and moves it at once. The picked letter
  //   shows its real outline and the gizmo, centred on it and upright on the
  //   screen whatever the box's turn and flip: a ring that turns it (Blender
  //   style: by the angle swept, never jumping to the pointer; Shift for 15°
  //   steps), an arrow that moves it along the screen's x only, one along its
  //   y only, a square and the centre that move it freely, and an arm that
  //   sizes it. A second press on the same part within 400 ms puts back what
  //   that part changes; Delete or Backspace puts the whole letter back,
  //   Escape lets it go, and the arrow keys do nothing.
  //
  // Every number a handle writes is the engine's (`sfxTurn`, `sfxScale`,
  // `sfxMove`, `sfxBendFor`; `sfxHit` says which letter a press is on, and
  // `sfxOutline` gives the picked letter's outline). This file turns pointers
  // into the box's frame and draws. A drag writes the box at most once an
  // animation frame (`frameLoop`), says it is live (`sfxLive`, so the box
  // paints within the drag budget and the SFX panel's pictures wait) and is
  // one history step (`sfxGesture`).
  //
  // A child of the box element, like the warp gizmo (editor/WarpGizmo.svelte),
  // so the box's own place, turn and flip are already on it: positions here
  // are the engine's, px from the box's centre at the zoom (`sfxPlacement` at
  // the size on screen), in the stored frame (before the flip, which the
  // overlay is drawn through). A pointer comes in through `toLocal`, the box's
  // own client -> box-local page px, handed the page frame's rect as it was
  // when the press came down (`frameRect`), so a move does not measure it.
  import { sfxPlacement, sfxOutline, sfxHit, sfxTurn, sfxScale, sfxMove, sfxBendFor } from './sfx.js';
  import { mirrorCss } from './box-frame.js';
  import { sfxLive } from './sfx-live.svelte.js';
  import {
    GLYPH_RESET,
    glyphKey,
    glyphOf,
    setGlyph,
    ownPaths,
    setPathEnd,
    sfxGesture,
    sfxEdit,
    isDouble,
    gizmoScale,
    screenAxis,
    frameLoop,
  } from './sfx-gizmo.js';

  /** `text` is the box's text as it is drawn (case applied); `toLocal(ev, rect)` the box's pointer -> box-local page px; `frameRect()` the page frame's client rect. */
  let { box, pageId, z, text, toLocal, frameRect = null } = $props();

  const s = $derived(box.style);
  // Screen px per em, and the centre the engine places from.
  const em = $derived(s.size * z);
  const cx = $derived((box.w * z) / 2);
  const cy = $derived((box.h * z) / 2);
  const placed = $derived(sfxPlacement(text, s, em));
  const paths = $derived(placed?.paths ?? []);
  const letters = $derived(placed?.letters ?? []);
  const mirror = $derived(mirrorCss(s, box.w * z, box.h * z));
  // Undoes the flip and the box's turn: what is drawn through it is upright
  // on the screen.
  const upright = $derived(`scale(${s.flipH ? -1 : 1} ${s.flipV ? -1 : 1}) rotate(${-(s.rotation || 0)})`);

  // The gizmo's size: lengths by `k`, squares by `q`, strokes fixed.
  const k = $derived(gizmoScale(gizmoUi.stageW, gizmoUi.stageH));
  const q = $derived(Math.max(k, 0.8));
  const D = Math.SQRT1_2;

  const scr = (p) => [cx + p[0] * em, cy + p[1] * em];
  const keyOf = (l) => glyphKey(l.group, l.index);

  // ---- the picked letter ----
  let picked = $state(null);
  let hovered = $state(-1);
  // The part under the pointer, and the one being dragged (which stays hot).
  let hot = $state('');
  let held = $state('');
  const pickedIdx = $derived(picked ? letters.findIndex((l) => keyOf(l) === picked) : -1);
  const pickedLetter = $derived(pickedIdx >= 0 ? letters[pickedIdx] : null);
  const hasPick = $derived(!!pickedLetter);
  // The gizmo's centre on the overlay: the letter's visual centre.
  const gc = $derived(pickedLetter ? [cx + pickedLetter.centre[0], cy + pickedLetter.centre[1]] : null);
  // The outlines: the picked letter's, and the hovered one's while nothing is
  // dragged. Asked of the engine only when the layout changes.
  const pickedD = $derived(pickedIdx >= 0 ? sfxOutline(text, s, em, pickedIdx) : '');
  const hoverD = $derived(
    !held && hovered >= 0 && hovered !== pickedIdx && hovered < letters.length ? sfxOutline(text, s, em, hovered) : '',
  );
  // The letter text was edited away: nothing is picked.
  $effect(() => {
    if (picked && !hasPick && letters.length) picked = null;
  });
  // The legend chip shows while a letter is picked.
  $effect(() => {
    gizmoUi.letter = hasPick;
    return () => (gizmoUi.letter = false);
  });

  let svgEl = $state(null);

  // ---- the pointer ----
  // The page frame's rect as the press found it.
  let rect = null;
  const begin = () => (rect = frameRect?.() ?? null);
  // A pointer in overlay px from the box's centre, stored frame.
  function at(ev) {
    const [x, y] = toLocal(ev, rect);
    return [x * z - cx, y * z - cy];
  }

  // A double press: the same part again, soon and near.
  let lastPress = null;
  function pressedTwice(e, part) {
    const t = performance.now();
    const two = isDouble(lastPress, part, t, e.clientX, e.clientY);
    lastPress = two ? null : { part, t, x: e.clientX, y: e.clientY };
    return two;
  }

  // ---- one gesture at a time ----
  let session = null;
  function endSession(cancelled) {
    const sn = session;
    if (!sn) return false;
    session = null;
    try {
      if (cancelled) sn.loop.cancel();
      else sn.loop.flush();
    } finally {
      sn.ac.abort();
      held = '';
      sfxLive.on = false;
    }
    if (cancelled) sn.gesture.cancel();
    else sn.gesture.commit();
    return true;
  }
  $effect(() => () => endSession(true));

  // A press, its moves and its release, as one gesture: `onMove(p, ev, start)`
  // writes the style from the pointer (overlay px from the box's centre), at
  // most once an animation frame.
  function drag(e, part, onMove) {
    e.preventDefault();
    e.stopPropagation();
    endSession(false);
    e.currentTarget?.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const start = at(e);
    const ac = new AbortController();
    // A press that travelled is not the first of a double.
    const loop = frameLoop((ev) => {
      lastPress = null;
      onMove(at(ev), ev, start);
    });
    session = { gesture: sfxGesture(box, pageId), loop, ac };
    held = part;
    hot = part;
    sfxLive.on = true;
    const opts = { signal: ac.signal };
    document.addEventListener('pointermove', (ev) => ev.pointerId === pid && loop.push(ev), opts);
    document.addEventListener('pointerup', (ev) => ev.pointerId === pid && endSession(false), opts);
    document.addEventListener('pointercancel', (ev) => ev.pointerId === pid && endSession(true), opts);
    // A pointer let go over another window is never heard of.
    window.addEventListener('blur', () => endSession(false), opts);
  }

  // ---- the letters ----
  function reset(e, part, key) {
    e.preventDefault();
    e.stopPropagation();
    endSession(false);
    sfxEdit(box, pageId, (sfx) => setGlyph(sfx, key, GLYPH_RESET[part]));
  }

  // A free move, or along one screen axis (`axis` 'x' or 'y').
  function move(e, part, l, axis = null) {
    const key = keyOf(l);
    const g0 = { ...glyphOf(box.style.sfx, key) };
    drag(e, part, (p, _ev, st) => {
      let now = p;
      if (axis) {
        const u = screenAxis(s.rotation, s.flipH, s.flipV, axis);
        const d = (p[0] - st[0]) * u[0] + (p[1] - st[1]) * u[1];
        now = [st[0] + u[0] * d, st[1] + u[1] * d];
      }
      const got = sfxMove(l, st, now, g0.dx, g0.dy);
      if (got) setGlyph(box.style.sfx, key, { dx: got[0], dy: got[1] });
    });
  }

  // A press on a letter's body picks it and moves it, at once.
  function onLetterDown(e, i0) {
    if (e.button !== 0) return;
    begin();
    const p = at(e);
    const i = sfxHit(letters, p[0], p[1], 4);
    const l = letters[i >= 0 ? i : i0];
    if (!l) return;
    const key = keyOf(l);
    picked = key;
    hovered = -1;
    if (pressedTwice(e, `letter:${key}`)) return reset(e, 'letter', key);
    move(e, 'letter', l);
  }

  // A press on one of the gizmo's parts.
  function onPartDown(e, part) {
    if (e.button !== 0 || !pickedLetter) return;
    begin();
    const l = pickedLetter;
    const key = keyOf(l);
    if (pressedTwice(e, part)) return reset(e, part, key);
    if (part === 'x' || part === 'y') return move(e, part, l, part);
    if (part === 'plane' || part === 'centre') return move(e, part, l);
    const g0 = { ...glyphOf(box.style.sfx, key) };
    const c = [...l.centre];
    if (part === 'scale') {
      drag(e, part, (p, _ev, st) => {
        const got = sfxScale(c, st, p, g0.s, false);
        if (got != null) setGlyph(box.style.sfx, key, { s: got });
      });
      return;
    }
    // The ring: the angle swept since the last move, added up.
    let total = g0.rot;
    let prev = null;
    drag(e, part, (p, ev, st) => {
      const got = sfxTurn(c, prev ?? st, p, total, ev.shiftKey ? 15 : 0);
      if (!got) return;
      total = got.total;
      prev = p;
      setGlyph(box.style.sfx, key, { rot: got.shown });
    });
  }

  // ---- the paths ----
  function onPathDown(e, i, end) {
    if (e.button !== 0) return;
    const shown = paths[i];
    if (!shown) return;
    begin();
    // From the path as it shows, the box's own or the engine's. The box takes
    // its own copy of the engine's paths on the first move, inside the
    // gesture, so the undo puts the box back to having none.
    const from = end === 'bend' ? [...shown.mid] : [...shown[end]];
    drag(e, `${i}:${end}`, (p, _ev, st) => {
      ownPaths(box.style.sfx, paths);
      const pt = [from[0] + (p[0] - st[0]) / em, from[1] + (p[1] - st[1]) / em];
      const path = box.style.sfx.paths[i];
      if (!path) return;
      if (end === 'bend') {
        const b = sfxBendFor(path, pt);
        if (b != null) path.bend = b;
      } else setPathEnd(box.style.sfx, i, end, pt);
    });
  }

  // ---- keys, while a letter is picked ----
  const typingIn = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ''));
  $effect(() => {
    if (!hasPick) return;
    const ac = new AbortController();
    document.addEventListener(
      'keydown',
      (ev) => {
        if (typingIn(ev.target)) return;
        const key = picked;
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          endSession(false);
          picked = null;
        } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
          // The letter, not the box.
          ev.preventDefault();
          ev.stopPropagation();
          endSession(false);
          if (key) sfxEdit(box, pageId, (sfx) => setGlyph(sfx, key, GLYPH_RESET.letter));
        } else if (ev.key.startsWith('Arrow')) {
          // Nothing, as in the reference: not the letter, not the box.
          ev.preventDefault();
          ev.stopPropagation();
        }
      },
      { signal: ac.signal, capture: true },
    );
    // A press anywhere but on these handles lets the letter go.
    document.addEventListener(
      'pointerdown',
      (ev) => {
        if (!svgEl?.contains(ev.target)) picked = null;
      },
      { signal: ac.signal, capture: true },
    );
    return () => ac.abort();
  });

  // A part's hover, for its thicker line.
  const hover = (part) => ({
    onpointerenter: () => (hot = part),
    onpointerleave: () => hot === part && !held && (hot = ''),
  });
  const isHot = (part) => hot === part || held === part;
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<svg
  class="sfx-gizmo"
  width={box.w * z}
  height={box.h * z}
  style={mirror}
  role="group"
  aria-label="SFX handles"
  data-sfx-gizmo={box.id}
  bind:this={svgEl}
  ondblclick={(e) => e.stopPropagation()}
>
  {#each paths as path, i (i)}
    {@const a = scr(path.a)}
    {@const b = scr(path.b)}
    {@const c = scr(path.ctrl)}
    <path class="guide" aria-hidden="true" d="M{a[0]},{a[1]} Q{c[0]},{c[1]} {b[0]},{b[1]}" />
  {/each}

  <!-- The letters' bodies: a press picks one and moves it. -->
  <g class="bodies" transform="translate({cx} {cy})" onpointerleave={() => (hovered = -1)}>
    {#each letters as l, i (keyOf(l))}
      <polygon
        class="body"
        data-sfx-letter={keyOf(l)}
        points={l.quad.map((p) => p.join(',')).join(' ')}
        role="button"
        tabindex="-1"
        aria-label="Letter {l.index + 1} of line {l.group + 1}"
        onpointerdown={(e) => onLetterDown(e, i)}
        onpointerenter={() => (hovered = i)}
      />
    {/each}
  </g>

  {#if hoverD}
    <g class="outline hover" aria-hidden="true" transform="translate({cx} {cy})">
      <path class="halo" d={hoverD} />
      <path class="line" d={hoverD} />
    </g>
  {/if}
  {#if pickedD}
    <g class="outline picked" aria-hidden="true" data-sfx-outline transform="translate({cx} {cy})">
      <path class="halo" d={pickedD} />
      <path class="line" d={pickedD} />
    </g>
  {/if}

  {#each paths as path, i (i)}
    {@const a = scr(path.a)}
    {@const b = scr(path.b)}
    {@const c = scr(path.ctrl)}
    {@const m = scr(path.mid)}
    {@const tan = (Math.atan2(b[1] - c[1], b[0] - c[0]) * 180) / Math.PI}
    <polygon class="end-arrow" aria-hidden="true" points="10,-5 22,0 10,5" transform="translate({b[0]} {b[1]}) rotate({tan})" />
    <circle
      class="end start"
      class:held={held === `${i}:a`}
      data-sfx-end="{i}:a"
      cx={a[0]}
      cy={a[1]}
      r="7"
      role="button"
      tabindex="-1"
      aria-label="Start of line {i + 1}"
      onpointerdown={(e) => onPathDown(e, i, 'a')}
    />
    <circle
      class="end finish"
      class:held={held === `${i}:b`}
      data-sfx-end="{i}:b"
      cx={b[0]}
      cy={b[1]}
      r="7"
      role="button"
      tabindex="-1"
      aria-label="End of line {i + 1}"
      onpointerdown={(e) => onPathDown(e, i, 'b')}
    />
    <g transform="translate({m[0]} {m[1]}) {upright}">
      <rect
        class="bend"
        class:held={held === `${i}:bend`}
        data-sfx-bend={i}
        data-at="{m[0]},{m[1]}"
        x="-5.66"
        y="-5.66"
        width="11.31"
        height="11.31"
        transform="rotate(45)"
        role="button"
        tabindex="-1"
        aria-label="Bend line {i + 1}"
        onpointerdown={(e) => onPathDown(e, i, 'bend')}
      />
    </g>
  {/each}

  {#if gc}
    <!-- The gizmo, upright on the screen whatever the box's turn and flip. -->
    <g class="gizmo" data-sfx-gizmo-at="{gc[0]},{gc[1]}" transform="translate({gc[0]} {gc[1]}) {upright}">
      <g class="ring" class:hot={isHot('ring')} class:held={held === 'ring'}>
        <circle class="ring-halo" aria-hidden="true" r={104 * k} />
        <circle class="ring-line" aria-hidden="true" r={104 * k} />
        <circle
          class="ring-hit"
          data-sfx-ring
          r={104 * k}
          role="button"
          tabindex="-1"
          aria-label="Rotate"
          onpointerdown={(e) => onPartDown(e, 'ring')}
          {...hover('ring')}
        >
          <title>Rotate (Shift = 15° steps)</title>
        </circle>
      </g>

      <g class="scale" class:hot={isHot('scale')}>
        <line class="arm" aria-hidden="true" x1={8 * k * D} y1={8 * k * D} x2={55 * k * D} y2={55 * k * D} />
        <rect class="box" aria-hidden="true" x={62 * k * D - 5.5 * q} y={62 * k * D - 5.5 * q} width={11 * q} height={11 * q} />
        <g
          class="part-hit"
          data-sfx-scale
          role="button"
          tabindex="-1"
          aria-label="Resize"
          onpointerdown={(e) => onPartDown(e, 'scale')}
          {...hover('scale')}
        >
          <title>Resize</title>
          <line class="band" x1={8 * k * D} y1={8 * k * D} x2={55 * k * D} y2={55 * k * D} />
          <rect class="pad" x={62 * k * D - 12 * q} y={62 * k * D - 12 * q} width={24 * q} height={24 * q} />
        </g>
      </g>

      <g class="arrow x" class:hot={isHot('x')}>
        <line class="shaft" aria-hidden="true" x1={9 * k} y1="0" x2={76 * k} y2="0" />
        <polygon class="head" aria-hidden="true" points="{92 * k},0 {92 * k - 17 * q},{-5.5 * q} {92 * k - 17 * q},{5.5 * q}" />
        <line
          class="band"
          data-sfx-arrow="x"
          x1={9 * k}
          y1="0"
          x2={94 * k}
          y2="0"
          role="button"
          tabindex="-1"
          aria-label="Move sideways"
          onpointerdown={(e) => onPartDown(e, 'x')}
          {...hover('x')}
        >
          <title>Move sideways</title>
        </line>
      </g>

      <g class="arrow y" class:hot={isHot('y')}>
        <line class="shaft" aria-hidden="true" x1="0" y1={-9 * k} x2="0" y2={-76 * k} />
        <polygon class="head" aria-hidden="true" points="0,{-92 * k} {-5.5 * q},{-92 * k + 17 * q} {5.5 * q},{-92 * k + 17 * q}" />
        <line
          class="band"
          data-sfx-arrow="y"
          x1="0"
          y1={-9 * k}
          x2="0"
          y2={-94 * k}
          role="button"
          tabindex="-1"
          aria-label="Move up or down"
          onpointerdown={(e) => onPartDown(e, 'y')}
          {...hover('y')}
        >
          <title>Move up or down</title>
        </line>
      </g>

      <rect
        class="plane"
        class:hot={isHot('plane')}
        data-sfx-plane
        x={30 * k - 8.5 * q}
        y={-30 * k - 8.5 * q}
        width={17 * q}
        height={17 * q}
        role="button"
        tabindex="-1"
        aria-label="Move freely"
        onpointerdown={(e) => onPartDown(e, 'plane')}
        {...hover('plane')}
      >
        <title>Move freely</title>
      </rect>

      <g class="centre" class:hot={isHot('centre')}>
        <rect class="box" aria-hidden="true" x={-5.5 * q} y={-5.5 * q} width={11 * q} height={11 * q} />
        <rect
          class="pad"
          data-sfx-centre
          x={-11 * q}
          y={-11 * q}
          width={22 * q}
          height={22 * q}
          role="button"
          tabindex="-1"
          aria-label="Move freely"
          onpointerdown={(e) => onPartDown(e, 'centre')}
          {...hover('centre')}
        >
          <title>Move freely</title>
        </rect>
      </g>
    </g>
  {/if}
</svg>

<style>
  /* The reference's own colours, drawn over the paper in both themes (like
     the warp gizmo's, WarpGizmo.svelte): the page under them is the same
     paper whatever the app's theme is. */
  .sfx-gizmo {
    position: absolute;
    left: 0;
    top: 0;
    overflow: visible;
    pointer-events: none;
    z-index: 4;
  }
  .sfx-gizmo [role='button']:focus {
    outline: none;
  }

  /* ---- the paths ---- */
  .guide {
    fill: none;
    stroke: #4ea3e8;
    stroke-width: 1.4;
    stroke-dasharray: 6 5;
    opacity: 0.8;
  }
  .end {
    stroke: #fff;
    stroke-width: 2;
    pointer-events: all;
    cursor: grab;
  }
  .end.start {
    fill: #4ea3e8;
  }
  .end.finish {
    fill: #f08a55;
  }
  .end-arrow {
    fill: #4ea3e8;
  }
  .bend {
    fill: #fff;
    stroke: #4ea3e8;
    stroke-width: 2.2;
    pointer-events: all;
    cursor: grab;
  }
  .end.held,
  .bend.held {
    cursor: grabbing;
  }

  /* ---- the letters ---- */
  /* Invisible: the letters are the picture. A few px of slop round each. */
  .body {
    fill: transparent;
    stroke: transparent;
    stroke-width: 6;
    stroke-linejoin: round;
    pointer-events: all;
    cursor: default;
  }
  .outline .halo {
    fill: none;
    stroke: rgba(255, 255, 255, 0.85);
    stroke-width: 3.4;
    stroke-linejoin: round;
  }
  .outline.picked .line {
    fill: rgba(0, 207, 216, 0.13);
    stroke: #00cfd8;
    stroke-width: 1.6;
    stroke-linejoin: round;
  }
  .outline.hover .line {
    fill: none;
    stroke: #4ddde4;
    stroke-width: 1.4;
    stroke-linejoin: round;
  }

  /* ---- the gizmo ---- */
  .ring-halo {
    fill: none;
    stroke: rgba(30, 30, 30, 0.42);
    stroke-width: 4.6;
  }
  .ring-line {
    fill: none;
    stroke: #ff8c73;
    stroke-width: 2.2;
  }
  .ring.hot .ring-halo {
    stroke-width: 6.2;
  }
  .ring.hot .ring-line {
    stroke-width: 3.8;
  }
  /* The ring is grabbed by a band on its line, not inside it. */
  .ring-hit {
    fill: none;
    stroke: transparent;
    stroke-width: 13;
    pointer-events: stroke;
    cursor: grab;
  }
  .ring.held .ring-hit {
    cursor: grabbing;
  }
  .arm,
  .shaft {
    stroke-width: 2.2;
    stroke-linecap: butt;
  }
  .hot .arm,
  .hot .shaft {
    stroke-width: 3.8;
  }
  .arm {
    stroke: #d8d8d8;
  }
  .scale .box {
    fill: #d8d8d8;
    stroke: #303030;
    stroke-width: 1.1;
  }
  .arrow.x .shaft {
    stroke: #75d9ff;
  }
  .arrow.x .head {
    fill: #75d9ff;
  }
  .arrow.y .shaft {
    stroke: #f2c94c;
  }
  .arrow.y .head {
    fill: #f2c94c;
  }
  .head {
    stroke: #303030;
    stroke-width: 1.1;
    stroke-linejoin: round;
  }
  .band {
    stroke: transparent;
    stroke-width: 13;
    pointer-events: stroke;
  }
  .pad {
    fill: transparent;
    pointer-events: all;
  }
  .part-hit {
    cursor: nwse-resize;
  }
  .arrow.x .band {
    cursor: ew-resize;
  }
  .arrow.y .band {
    cursor: ns-resize;
  }
  .plane {
    fill: rgba(255, 140, 115, 0.45);
    stroke: #303030;
    stroke-width: 1.1;
    pointer-events: all;
    cursor: move;
  }
  .plane.hot {
    fill: rgba(255, 140, 115, 0.7);
  }
  .centre .box {
    fill: #fff;
    stroke: #303030;
    stroke-width: 1.1;
  }
  .centre.hot .box {
    stroke-width: 1.8;
  }
  .centre .pad {
    cursor: move;
  }
</style>
