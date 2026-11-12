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
  // A line marks the box drawn for it (`line.rect`) when it has one, and its
  // detected block otherwise, so a line added by hand is on the page once it
  // is drawn, and a redrawn block replaces the detector's. Free lines are
  // called T1, T2... as their rows are (`lineLabels`).
  //
  // Page pixels, like RegionsLayer: the svg's viewBox is the page, the badges
  // are scaled back to screen pixels so they read the same at any zoom.
  import { app, page, gotoPage, activateLine, isTranslated, readingDirection, lineRect } from '../store.svelte.js';
  import { focusActiveField } from '../Queue.svelte';
  import { lineLabels } from '../reading-order.js';

  let { pg } = $props();

  const px = $derived(1 / (app.zoom || 1));
  // In a strip several slices are numbered at once; only the page the reader is
  // on has the active line.
  const here = $derived(page() === pg);
  const rtl = $derived(readingDirection() === 'rtl');
  const marks = $derived.by(() => {
    const blocks = new Map();
    // The first usable block per line: a malformed one ahead of it must not
    // hide it.
    for (const d of pg.detect?.boxes ?? []) {
      const r = lineRect(d?.box);
      if (r && !blocks.has(d.n)) blocks.set(d.n, r);
    }
    const labels = lineLabels(pg.lines);
    const out = [];
    for (const l of pg.lines ?? []) {
      const r = lineRect(l.rect) ?? blocks.get(l.n);
      if (!r) continue;
      const label = labels.get(l.n);
      out.push({ n: l.n, label, wide: label.length > 2, x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1], done: isTranslated(l) });
    }
    return out;
  });

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
        {#if m.wide}
          <rect class="pill" x={-(m.label.length * 3.6 + 6)} y="-11" width={m.label.length * 7.2 + 12} height="22" rx="11" />
        {:else}
          <circle r="11" />
        {/if}
        <text text-anchor="middle" dy="4">{m.label}</text>
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
  .badge circle,
  .badge .pill {
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
  .done .badge circle,
  .done .badge .pill {
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
  .active .badge circle,
  .active .badge .pill {
    fill: var(--bn-live);
    stroke: var(--bn-live);
  }
  .active .badge text {
    fill: #fff;
  }
</style>
