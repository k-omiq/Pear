<script>
  // ===== The SFX handles =====
  //
  // Over a selected SFX box: each text group's path as a dashed hairline, a
  // dot at its start and end, and a diamond on the middle of the curve that
  // bends it. A click on a letter picks it: then a drag on it moves it, the
  // ring round it turns it, the square on the ring sizes it, a double click
  // puts it back, and the arrow keys nudge it. What a drag writes, and the one
  // history step it makes, is sfx-gizmo.js.
  //
  // A child of the box element, like the warp gizmo (editor/WarpGizmo.svelte),
  // so the box's own place, turn and flip are already on it: positions here
  // are the engine's, px from the box's centre at the zoom (`sfxPlacement`
  // at the size on screen, the same call the box draws with). A pointer comes
  // in through `toLocal`, the box's own client -> box-local page px.
  //
  // A letter not picked does not keep its press: the press goes on to the box,
  // which moves it as before, and a press that never travelled picks the
  // letter when it comes up. So an SFX box is still dragged by its letters,
  // and only a letter already picked is held.
  import { sfxPlacement, bendHandle, bendFor } from './sfx.js';
  import { mirrorCss } from './box-frame.js';
  import {
    NUDGE_SETTLE_MS,
    PATH_NUDGE_PX,
    LETTER_NUDGE_EM,
    glyphKey,
    glyphOf,
    hasGlyphEdit,
    setGlyph,
    ownPaths,
    setPathEnd,
    sfxGesture,
    sfxEdit,
  } from './sfx-gizmo.js';

  /** `text` is the box's text as it is drawn (case applied); `toLocal` the box's pointer -> box-local page px. */
  let { box, pageId, z, text, toLocal } = $props();

  const s = $derived(box.style);
  // Screen px per em, and the centre the engine places from.
  const em = $derived(s.size * z);
  const cx = $derived((box.w * z) / 2);
  const cy = $derived((box.h * z) / 2);
  const placed = $derived(sfxPlacement(text, s, em));
  const paths = $derived(placed?.paths ?? []);
  const letters = $derived(placed?.letters ?? []);
  const mirror = $derived(mirrorCss(s, box.w * z, box.h * z));

  const scr = (p) => [cx + p[0] * em, cy + p[1] * em];
  // A pointer, in ems of the box from its centre.
  function emsAt(ev) {
    const [x, y] = toLocal(ev);
    return [(x - box.w / 2) / s.size, (y - box.h / 2) / s.size];
  }
  // A pointer, in screen px of the overlay (unflipped, like everything in it).
  function scrAt(ev) {
    const [x, y] = toLocal(ev);
    return [x * z, y * z];
  }

  function curveD(q) {
    const [ax, ay] = scr(q.a);
    const [bx, by] = scr(q.b);
    const k = q.bend ?? 0;
    const [kx, ky] = scr([(q.a[0] + q.b[0]) / 2 - (q.b[1] - q.a[1]) * k, (q.a[1] + q.b[1]) / 2 + (q.b[0] - q.a[0]) * k]);
    return `M${ax},${ay} Q${kx},${ky} ${bx},${by}`;
  }

  // ---- the letters ----
  const keyOf = (l) => glyphKey(l.group, l.index);
  // A letter's box on screen: its advance by the face's height, scaled as the
  // engine scales it, and never too small to hit.
  function frameOf(l) {
    const w = Math.max(10, Math.abs(l.adv * l.sx));
    const h = Math.max(10, Math.abs(em * l.sy) * 0.8);
    return { x: cx + l.x, y: cy + l.y, w, h, deg: (l.rot * 180) / Math.PI };
  }
  let picked = $state(null);
  const pickedLetter = $derived(picked ? (letters.find((l) => keyOf(l) === picked) ?? null) : null);
  const pick = $derived(pickedLetter ? frameOf(pickedLetter) : null);
  const ringR = $derived(pick ? Math.hypot(pick.w, pick.h) / 2 + 8 : 0);
  // The letter text was edited away: nothing is picked.
  $effect(() => {
    if (picked && !pickedLetter) picked = null;
  });

  let svgEl = $state(null);
  let held = $state('');

  // ---- one gesture at a time ----
  let session = null;
  const live = new Set();
  function endSession(cancelled) {
    const sn = session;
    if (!sn) return false;
    session = null;
    clearTimeout(sn.timer);
    sn.ac?.abort();
    held = '';
    if (cancelled) sn.gesture.cancel();
    else sn.gesture.commit();
    return true;
  }
  $effect(() => () => {
    // A drag the pointer never finished is put back; a key burst is kept.
    endSession(session?.kind === 'drag');
    for (const ac of live) ac.abort();
    live.clear();
  });

  // A press, its moves and its release, as one gesture: `onMove(ev, start)`
  // writes the style from the pointer.
  function drag(e, id, onMove) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus?.({ preventScroll: true });
    endSession(false);
    const pid = e.pointerId;
    const ac = new AbortController();
    session = { gesture: sfxGesture(box, pageId), kind: 'drag', ac, timer: 0 };
    held = id;
    const start = e;
    const startLocal = { ems: emsAt(e), scr: scrAt(e) };
    document.addEventListener('pointermove', (ev) => ev.pointerId === pid && onMove(ev, startLocal, start), { signal: ac.signal });
    document.addEventListener('pointerup', (ev) => ev.pointerId === pid && endSession(false), { signal: ac.signal });
    document.addEventListener('pointercancel', (ev) => ev.pointerId === pid && endSession(true), { signal: ac.signal });
    document.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        ev.stopPropagation();
        endSession(true);
      },
      { signal: ac.signal, capture: true },
    );
  }

  // An arrow key: a burst of presses is one gesture, closed by a pause or by
  // the next press anywhere.
  function nudge(e, id, by) {
    if (session?.kind === 'drag') return false;
    if (!session || session.id !== id) {
      endSession(false);
      const ac = new AbortController();
      session = { gesture: sfxGesture(box, pageId), kind: 'nudge', ac, timer: 0, id };
      document.addEventListener('pointerdown', () => endSession(false), { signal: ac.signal, capture: true });
    }
    by();
    clearTimeout(session.timer);
    session.timer = setTimeout(() => endSession(false), NUDGE_SETTLE_MS);
    return true;
  }
  function arrow(e) {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') return [-step, 0];
    if (e.key === 'ArrowRight') return [step, 0];
    if (e.key === 'ArrowUp') return [0, -step];
    if (e.key === 'ArrowDown') return [0, step];
    return null;
  }

  // ---- the paths ----
  function onPathDown(e, i, end) {
    // From the path as it shows, the box's own or the engine's; the grab
    // offset keeps the handle from jumping to the pointer. The box takes its
    // own copy of the engine's paths on the first move, inside the gesture, so
    // the undo puts the box back to having none.
    const q0 = JSON.parse(JSON.stringify(box.style.sfx.paths[i] ?? paths[i]));
    const at0 = end === 'bend' ? bendHandle(q0) : q0[end];
    drag(e, `${i}:${end}`, (ev, st) => {
      ownPaths(box.style.sfx, paths);
      const p = emsAt(ev);
      const pt = [at0[0] + p[0] - st.ems[0], at0[1] + p[1] - st.ems[1]];
      const q = box.style.sfx.paths[i];
      if (end === 'bend') q.bend = bendFor(q, pt);
      else setPathEnd(box.style.sfx, i, end, pt);
    });
  }
  function onPathKey(e, i, end) {
    if (e.key === 'Escape') {
      e.currentTarget.blur?.();
      return;
    }
    const d = arrow(e);
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    nudge(e, `${i}:${end}`, () => {
      ownPaths(box.style.sfx, paths);
      const q = box.style.sfx.paths[i];
      if (!q) return;
      const k = PATH_NUDGE_PX / s.size;
      const flipX = s.flipH ? -1 : 1;
      const flipY = s.flipV ? -1 : 1;
      const dx = d[0] * k * flipX;
      const dy = d[1] * k * flipY;
      if (end === 'bend') {
        const h = bendHandle(q);
        q.bend = bendFor(q, [h[0] + dx, h[1] + dy]);
      } else setPathEnd(box.style.sfx, i, end, [q[end][0] + dx, q[end][1] + dy]);
    });
  }

  // ---- the letters ----
  // A letter not picked: the press goes on to the box; a release that never
  // travelled picks it.
  function onLetterDown(e, l) {
    if (e.button !== 0) return;
    const key = keyOf(l);
    if (picked === key) {
      onPickedDown(e, l);
      return;
    }
    const x0 = e.clientX;
    const y0 = e.clientY;
    const el = e.currentTarget;
    const pid = e.pointerId;
    const ac = new AbortController();
    live.add(ac);
    const done = () => {
      live.delete(ac);
      ac.abort();
    };
    document.addEventListener(
      'pointerup',
      (ev) => {
        if (ev.pointerId !== pid) return;
        done();
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 3) return;
        picked = key;
        // After the box's own press handling, which keeps the focus away.
        queueMicrotask(() => el.isConnected && el.focus?.({ preventScroll: true }));
      },
      { signal: ac.signal },
    );
    document.addEventListener('pointercancel', (ev) => ev.pointerId === pid && done(), { signal: ac.signal });
  }
  // The picked letter's body: a drag moves it, in its own ems.
  function onPickedDown(e, l) {
    const key = keyOf(l);
    const g0 = { ...glyphOf(box.style.sfx, key) };
    const unit = l.em > 0 ? l.em : em;
    drag(e, `l:${key}`, (ev, st) => {
      const p = scrAt(ev);
      setGlyph(box.style.sfx, key, { dx: g0.dx + (p[0] - st.scr[0]) / unit, dy: g0.dy + (p[1] - st.scr[1]) / unit });
    });
  }
  // The ring: the turn follows the pointer round the letter's centre.
  function onRingDown(e) {
    const key = picked;
    const c = [pick.x, pick.y];
    const g0 = { ...glyphOf(box.style.sfx, key) };
    drag(e, 'ring', (ev, st) => {
      const p = scrAt(ev);
      const a0 = Math.atan2(st.scr[1] - c[1], st.scr[0] - c[0]);
      const a1 = Math.atan2(p[1] - c[1], p[0] - c[0]);
      let deg = g0.rot + ((a1 - a0) * 180) / Math.PI;
      deg = ((((deg + 180) % 360) + 360) % 360) - 180;
      setGlyph(box.style.sfx, key, { rot: ev.shiftKey ? Math.round(deg / 15) * 15 : deg });
    });
  }
  // The square: the size follows the pointer's distance from the centre.
  function onScaleDown(e) {
    const key = picked;
    const c = [pick.x, pick.y];
    const g0 = { ...glyphOf(box.style.sfx, key) };
    drag(e, 'scale', (ev, st) => {
      const p = scrAt(ev);
      const d0 = Math.hypot(st.scr[0] - c[0], st.scr[1] - c[1]);
      const d1 = Math.hypot(p[0] - c[0], p[1] - c[1]);
      if (!(d0 > 1)) return;
      setGlyph(box.style.sfx, key, { s: g0.s * (d1 / d0) });
    });
  }
  // A double click on the picked letter puts it back. On a letter with no
  // edit there is nothing to put back, and the double click is the box's: it
  // types into it, as everywhere else.
  function onLetterDblClick(e, l) {
    const key = keyOf(l);
    if (picked !== key || !hasGlyphEdit(box.style.sfx, key)) return;
    e.stopPropagation();
    endSession(false);
    sfxEdit(box, pageId, (sfx) => setGlyph(sfx, key, { dx: 0, dy: 0, rot: 0, s: 1 }));
  }
  function onLetterKey(e, l) {
    const key = keyOf(l);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (session?.kind === 'nudge') endSession(true);
      picked = null;
      e.currentTarget.blur?.();
      return;
    }
    const d = arrow(e);
    if (!d || picked !== key) return;
    e.preventDefault();
    e.stopPropagation();
    // An arrow is a direction on screen: the letter's own ems are unflipped.
    const fx = s.flipH ? -1 : 1;
    const fy = s.flipV ? -1 : 1;
    nudge(e, `l:${key}`, () => {
      const g = glyphOf(box.style.sfx, key);
      setGlyph(box.style.sfx, key, { dx: g.dx + d[0] * fx * LETTER_NUDGE_EM, dy: g.dy + d[1] * fy * LETTER_NUDGE_EM });
    });
  }

  // A press anywhere but on these handles drops the pick.
  $effect(() => {
    if (!picked) return;
    const ac = new AbortController();
    document.addEventListener(
      'pointerdown',
      (ev) => {
        if (!svgEl?.contains(ev.target)) picked = null;
      },
      { signal: ac.signal, capture: true },
    );
    return () => ac.abort();
  });
</script>

<svg
  class="sfx-gizmo"
  width={box.w * z}
  height={box.h * z}
  style={mirror}
  role="group"
  aria-label="SFX handles"
  data-sfx-gizmo={box.id}
  bind:this={svgEl}
>
  {#each paths as q, i (i)}
    <path class="curve" aria-hidden="true" d={curveD(q)} />
  {/each}

  <!-- The letters' hit areas, under the handles. -->
  {#each letters as l (keyOf(l))}
    {@const f = frameOf(l)}
    <rect
      class="letter"
      class:picked={picked === keyOf(l)}
      data-sfx-letter={keyOf(l)}
      x={-f.w / 2}
      y={-f.h / 2}
      width={f.w}
      height={f.h}
      transform="translate({f.x} {f.y}) rotate({f.deg})"
      role="button"
      tabindex={picked === keyOf(l) ? 0 : -1}
      aria-label="Letter {l.index + 1} of line {l.group + 1}. Drag to move, arrow keys nudge, double-click resets."
      onpointerdown={(e) => onLetterDown(e, l)}
      ondblclick={(e) => onLetterDblClick(e, l)}
      onkeydown={(e) => onLetterKey(e, l)}
    />
  {/each}

  {#if pick}
    <circle class="ring-line" aria-hidden="true" cx={pick.x} cy={pick.y} r={ringR} />
    <circle
      class="ring"
      class:held={held === 'ring'}
      data-sfx-ring
      cx={pick.x}
      cy={pick.y}
      r={ringR}
      role="button"
      tabindex="-1"
      aria-label="Turn the letter"
      onpointerdown={onRingDown}
    />
    <rect
      class="scale"
      class:held={held === 'scale'}
      data-sfx-scale
      x={pick.x + ringR * Math.SQRT1_2 - 5}
      y={pick.y + ringR * Math.SQRT1_2 - 5}
      width="10"
      height="10"
      role="button"
      tabindex="-1"
      aria-label="Size the letter"
      onpointerdown={onScaleDown}
    />
  {/if}

  {#each paths as q, i (i)}
    {@const m = scr(bendHandle(q))}
    {@const a = scr(q.a)}
    {@const b = scr(q.b)}
    <rect
      class="bend"
      class:held={held === `${i}:bend`}
      data-sfx-bend={i}
      x={m[0] - 5}
      y={m[1] - 5}
      width="10"
      height="10"
      transform="rotate(45 {m[0]} {m[1]})"
      role="button"
      tabindex="0"
      aria-label="Bend line {i + 1}. Arrow keys nudge, Shift for ten."
      onpointerdown={(e) => onPathDown(e, i, 'bend')}
      onkeydown={(e) => onPathKey(e, i, 'bend')}
    />
    <circle
      class="end"
      class:held={held === `${i}:a`}
      data-sfx-end="{i}:a"
      cx={a[0]}
      cy={a[1]}
      r="5"
      role="button"
      tabindex="0"
      aria-label="Start of line {i + 1}. Arrow keys nudge, Shift for ten."
      onpointerdown={(e) => onPathDown(e, i, 'a')}
      onkeydown={(e) => onPathKey(e, i, 'a')}
    />
    <circle
      class="end"
      class:held={held === `${i}:b`}
      data-sfx-end="{i}:b"
      cx={b[0]}
      cy={b[1]}
      r="5"
      role="button"
      tabindex="0"
      aria-label="End of line {i + 1}. Arrow keys nudge, Shift for ten."
      onpointerdown={(e) => onPathDown(e, i, 'b')}
      onkeydown={(e) => onPathKey(e, i, 'b')}
    />
  {/each}
</svg>

<style>
  /* The warp gizmo's page-facing palette (WarpGizmo.svelte says why it is not
     the theme's): drawn over the paper in both themes. */
  .sfx-gizmo {
    --sg-line: var(--gizmo-accent, #00d5e0);
    --sg-handle: var(--gizmo-accent-deep, #00818a);
    position: absolute;
    left: 0;
    top: 0;
    overflow: visible;
    pointer-events: none;
    z-index: 4;
  }
  .curve {
    fill: none;
    stroke: var(--sg-line);
    stroke-width: 1;
    stroke-dasharray: 5 4;
    opacity: 0.85;
    vector-effect: non-scaling-stroke;
  }
  /* Invisible until picked: the letters are the picture. */
  .letter {
    fill: transparent;
    stroke: none;
    pointer-events: all;
  }
  .letter.picked {
    stroke: var(--sg-line);
    stroke-width: 1;
    stroke-dasharray: 3 3;
    cursor: move;
  }
  .letter:focus {
    outline: none;
  }
  .ring-line {
    fill: none;
    stroke: var(--sg-line);
    stroke-width: 1;
  }
  /* The ring is grabbed by a band wider than it is drawn. */
  .ring {
    fill: none;
    stroke: transparent;
    stroke-width: 10;
    pointer-events: stroke;
    cursor: grab;
  }
  .end,
  .bend,
  .scale {
    fill: #fff;
    stroke: var(--sg-handle);
    stroke-width: 1.5;
    pointer-events: all;
    cursor: grab;
  }
  .scale {
    cursor: nwse-resize;
  }
  .held,
  .end:focus,
  .bend:focus {
    outline: none;
    fill: var(--sg-line);
    cursor: grabbing;
  }
</style>
