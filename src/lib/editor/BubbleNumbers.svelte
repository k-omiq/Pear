<script>
  // ===== The numbered bubbles of a translate chapter =====
  //
  // Every detected text block on the page, outlined and numbered in reading
  // order - the number is the line's number in the typing pane beside the page,
  // so "what is 7" is answered by looking. The badge sits on the corner the eye
  // reaches first: top right for a right-to-left series, top left otherwise.
  //
  // A badge is hollow while its line has no English and filled once it has; the
  // active line's bubble is the one lit. A click on a bubble makes its line the
  // active one and puts the caret in its English field.
  //
  // Page pixels, like RegionsLayer: the svg's viewBox is the page, the badges
  // are scaled back to screen pixels so they read the same at any zoom.
  import { app, page, gotoPage, activateLine, isTranslated, readingDirection } from '../store.svelte.js';
  import { focusActiveField } from '../Queue.svelte';

  let { pg } = $props();

  const px = $derived(1 / (app.zoom || 1));
  // In a strip several slices are numbered at once; only the page the reader is
  // on has the active line.
  const here = $derived(page() === pg);
  const rtl = $derived(readingDirection() === 'rtl');
  const lineOf = $derived(new Map((pg.lines ?? []).map((l) => [l.n, l])));
  const marks = $derived(
    (pg.detect?.boxes ?? [])
      .filter((d) => Array.isArray(d.box) && d.box.length === 4 && lineOf.has(d.n))
      .map((d) => {
        const x = Math.min(d.box[0], d.box[2]);
        const y = Math.min(d.box[1], d.box[3]);
        const w = Math.abs(d.box[2] - d.box[0]);
        const h = Math.abs(d.box[3] - d.box[1]);
        return { n: d.n, x, y, w, h, done: isTranslated(lineOf.get(d.n)) };
      }),
  );

  // A press that turns into a pan is not a click on the bubble under it.
  let down = null;
  function onDown(e) {
    down = [e.clientX, e.clientY];
  }
  function onClick(e, n) {
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
    e.stopPropagation();
    if (!here) {
      const i = app.pages.indexOf(pg);
      if (i >= 0) gotoPage(i);
    }
    activateLine(n);
    focusActiveField('en');
  }
</script>

<svg class="bubble-numbers" viewBox="0 0 {pg.w} {pg.h}" preserveAspectRatio="none" aria-hidden="true">
  {#each marks as m (m.n)}
    {@const active = here && m.n === pg.activeLineN}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <g class="mark" class:active class:done={m.done} onpointerdown={onDown} onclick={(e) => onClick(e, m.n)}>
      <rect class="area" x={m.x} y={m.y} width={m.w} height={m.h} rx={6 * px} />
      <g class="badge" transform="translate({rtl ? m.x + m.w : m.x} {m.y}) scale({px})">
        <circle r="11" />
        <text text-anchor="middle" dy="4">{m.n}</text>
      </g>
    </g>
  {/each}
</svg>

<style>
  /* Over the page, which is paper in both themes: fixed page-facing colours,
     as in RegionsLayer, not theme tokens. One signal colour, for the line
     being typed; everything else is ink and paper. */
  .bubble-numbers {
    --bn-ink: #22211e;
    --bn-paper: #fefdfb;
    --bn-live: #d4572a;
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
    z-index: 2;
  }
  .mark {
    pointer-events: auto;
    cursor: pointer;
  }
  .area {
    fill: transparent;
    stroke: var(--bn-ink);
    stroke-opacity: 0.32;
    stroke-width: 1.25;
    stroke-dasharray: 4 3;
    vector-effect: non-scaling-stroke;
    transition: stroke-opacity 0.15s, fill 0.15s;
  }
  .mark:hover .area {
    stroke-opacity: 0.7;
    fill: rgba(34, 33, 30, 0.05);
  }
  .badge circle {
    fill: var(--bn-paper);
    stroke: var(--bn-ink);
    stroke-width: 1.5;
    filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.3));
  }
  .badge text {
    fill: var(--bn-ink);
    font: 700 11.5px/1 system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-variant-numeric: tabular-nums;
  }
  .done .badge circle {
    fill: var(--bn-ink);
  }
  .done .badge text {
    fill: var(--bn-paper);
  }
  .active .area {
    stroke: var(--bn-live);
    stroke-opacity: 1;
    stroke-width: 2;
    stroke-dasharray: none;
    fill: rgba(212, 87, 42, 0.08);
  }
  .active .badge circle {
    fill: var(--bn-live);
    stroke: var(--bn-live);
  }
  .active .badge text {
    fill: #fff;
  }
</style>
