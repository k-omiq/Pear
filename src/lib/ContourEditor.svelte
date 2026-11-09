<!--
  An effect's contour curve, as Photoshop's Contour Editor has it: a 0..255
  square, a click adds a point, a drag moves one, Corner breaks the curve at
  it, Delete takes it out, and a preset is a place to start. The line drawn
  is the engine's reading of the points (`contourLut`, contour-curve.js).

  It edits a copy and hands every change to `onchange` as a custom contour
  (`normalizeContour`'s rules: points in order of x, at most
  CONTOUR_MAX_POINTS, a smooth point never on another's x). The Inspector
  writes it and records the step, as its other controls do.
-->
<script>
  import { CONTOUR_PRESETS, CONTOUR_LABELS, CONTOUR_MAX_POINTS, normalizeContour } from './data.js';
  import { contourLut, contourPoints } from './contour-curve.js';

  let { contour, title = 'Contour', onchange = () => {}, onclose = () => {} } = $props();

  // The drawing's side, in its own units: 0..255 maps onto it.
  const SIDE = 160;
  const PAD = 6;
  const toPx = (v) => PAD + (v / 255) * SIDE;
  const toY = (v) => PAD + SIDE - (v / 255) * SIDE;

  // The points shown: the contour's own, a preset's read from its table.
  const pts = $derived(contourPoints(contour).map(([x, y, corner]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10, corner]));
  let selected = $state(0);
  const sel = $derived(Math.min(selected, pts.length - 1));
  const curve = $derived.by(() => {
    const lut = contourLut(contour);
    return lut.map((v, i) => `${toPx(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  });

  let svgEl = $state(null);
  let drag = null;

  function emit(next) {
    onchange(normalizeContour({ preset: 'custom', aa: contour?.aa === true, pts: next }));
  }
  // How far point `i` may move along x: between its neighbours, a whole
  // level clear of each, so a smooth point never shares an x.
  function xRange(list, i) {
    const lo = i === 0 ? 0 : list[i - 1][0] + 1;
    const hi = i === list.length - 1 ? 255 : list[i + 1][0] - 1;
    return [lo, Math.max(lo, hi)];
  }
  function moveTo(i, x, y) {
    const list = pts.map((p) => [...p]);
    if (!list[i]) return;
    const [lo, hi] = xRange(list, i);
    list[i][0] = Math.round(Math.min(hi, Math.max(lo, x)));
    list[i][1] = Math.round(Math.min(255, Math.max(0, y)));
    emit(list);
  }
  // Where a pointer is, in levels.
  function levels(e) {
    const r = svgEl.getBoundingClientRect();
    const w = r.width || SIDE + PAD * 2;
    const h = r.height || SIDE + PAD * 2;
    const sx = ((e.clientX - r.left) / w) * (SIDE + PAD * 2);
    const sy = ((e.clientY - r.top) / h) * (SIDE + PAD * 2);
    return [((sx - PAD) / SIDE) * 255, ((SIDE + PAD - sy) / SIDE) * 255];
  }
  // A press on the square: on a point it takes that point, else it adds one
  // where it was pressed (Photoshop's click), and either way the drag moves it.
  function press(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const [x, y] = levels(e);
    const near = pts.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) <= 8);
    let i = near;
    if (i < 0) {
      if (pts.length >= CONTOUR_MAX_POINTS) return;
      const at = pts.findIndex((p) => p[0] > x);
      i = at < 0 ? pts.length : at;
      const list = pts.map((p) => [...p]);
      const lo = i === 0 ? 0 : list[i - 1][0] + 1;
      const hi = i === list.length ? 255 : list[i][0] - 1;
      if (lo > hi) return;
      list.splice(i, 0, [Math.round(Math.min(hi, Math.max(lo, x))), Math.round(Math.min(255, Math.max(0, y))), false]);
      emit(list);
    }
    selected = i;
    drag = { i };
    svgEl.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }
  function move(e) {
    if (!drag) return;
    const [x, y] = levels(e);
    moveTo(drag.i, x, y);
  }
  function release() {
    drag = null;
  }
  function setField(axis, e) {
    const v = Number(e.target.value);
    const p = pts[sel];
    if (!p || !Number.isFinite(v)) return;
    if (axis === 0) moveTo(sel, v, p[1]);
    else moveTo(sel, p[0], v);
  }
  function setCorner(on) {
    const list = pts.map((p, i) => (i === sel ? [p[0], p[1], on] : [...p]));
    emit(list);
  }
  function remove() {
    if (pts.length <= 2) return;
    const list = pts.filter((_, i) => i !== sel).map((p) => [...p]);
    selected = Math.max(0, sel - 1);
    emit(list);
  }
  function startFrom(preset) {
    selected = 0;
    emit(contourPoints({ preset }).map(([x, y, corner]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10, corner]));
  }
  // Arrow keys nudge the chosen point a level (ten with Shift).
  function key(e) {
    const step = e.shiftKey ? 10 : 1;
    const p = pts[sel];
    if (!p) return;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (d) {
      e.preventDefault();
      moveTo(sel, p[0] + d[0], p[1] + d[1]);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onclose();
    }
  }
</script>

<div class="ce" role="dialog" aria-label="{title} editor">
  <div class="ce-head">
    <span class="ce-title">{title}</span>
    <label class="ce-start" title="Start from one of Photoshop's curves">
      <span>Start from</span>
      <select value="" aria-label="{title} start from" onchange={(e) => { if (e.target.value) startFrom(e.target.value); e.target.value = ''; }}>
        <option value="" disabled>Preset…</option>
        {#each CONTOUR_PRESETS as id (id)}
          <option value={id}>{CONTOUR_LABELS[id]}</option>
        {/each}
      </select>
    </label>
  </div>
  <svg
    bind:this={svgEl}
    class="ce-plot"
    viewBox="0 0 {SIDE + PAD * 2} {SIDE + PAD * 2}"
    role="application"
    aria-label="{title} curve: click to add a point, drag to move one, arrow keys nudge the chosen point"
    tabindex="0"
    onpointerdown={press}
    onpointermove={move}
    onpointerup={release}
    onpointercancel={release}
    onkeydown={key}
  >
    <rect class="ce-bg" x={PAD} y={PAD} width={SIDE} height={SIDE} />
    {#each [1, 2, 3] as k (k)}
      <line class="ce-grid" x1={PAD + (SIDE * k) / 4} y1={PAD} x2={PAD + (SIDE * k) / 4} y2={PAD + SIDE} />
      <line class="ce-grid" x1={PAD} y1={PAD + (SIDE * k) / 4} x2={PAD + SIDE} y2={PAD + (SIDE * k) / 4} />
    {/each}
    <polyline class="ce-curve" points={curve} />
    {#each pts as p, i (i)}
      {#if p[2]}
        <rect class="ce-pt" class:on={i === sel} x={toPx(p[0]) - 3.5} y={toY(p[1]) - 3.5} width="7" height="7" />
      {:else}
        <circle class="ce-pt" class:on={i === sel} cx={toPx(p[0])} cy={toY(p[1])} r="3.5" />
      {/if}
    {/each}
  </svg>
  <div class="ce-row">
    <label class="ce-num" title="Input, 0 to 255">
      <span>Input</span>
      <input type="number" min="0" max="255" step="1" value={Math.round(pts[sel]?.[0] ?? 0)} aria-label="{title} point input" onchange={(e) => setField(0, e)} />
    </label>
    <label class="ce-num" title="Output, 0 to 255">
      <span>Output</span>
      <input type="number" min="0" max="255" step="1" value={Math.round(pts[sel]?.[1] ?? 0)} aria-label="{title} point output" onchange={(e) => setField(1, e)} />
    </label>
    <label class="ce-check" title="Corner: the curve breaks at this point">
      <input type="checkbox" checked={pts[sel]?.[2] === true} aria-label="{title} point corner" onchange={(e) => setCorner(e.target.checked)} />
      <span>Corner</span>
    </label>
  </div>
  <div class="ce-row">
    <span class="ce-count">Point {sel + 1} of {pts.length}</span>
    <button type="button" class="add-btn" disabled={pts.length <= 2} aria-label="{title} delete point" onclick={remove}>Delete point</button>
    <button type="button" class="add-btn" aria-label="{title} done" onclick={() => onclose()}>Done</button>
  </div>
</div>

<style>
  .ce {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    margin: 4px 0;
    border: 1px solid var(--line2);
    border-radius: var(--radius);
    background: var(--panel);
    box-shadow: var(--edge);
    font-size: 11px;
    color: var(--t2);
  }
  .ce-head,
  .ce-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .ce-title {
    flex: 1 1 auto;
    color: var(--text);
  }
  .ce-start,
  .ce-num,
  .ce-check {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .ce-num input {
    width: 52px;
  }
  .ce-count {
    flex: 1 1 auto;
    color: var(--t3);
    font-variant-numeric: tabular-nums;
  }
  .ce-plot {
    width: 100%;
    max-width: 220px;
    aspect-ratio: 1;
    align-self: center;
    touch-action: none;
    cursor: crosshair;
    outline: none;
  }
  .ce-plot:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .ce-bg {
    fill: var(--surface);
    stroke: var(--line2);
  }
  .ce-grid {
    stroke: var(--line);
    stroke-width: 0.5;
  }
  .ce-curve {
    fill: none;
    stroke: var(--text);
    stroke-width: 1.5;
  }
  .ce-pt {
    fill: var(--panel);
    stroke: var(--text);
    stroke-width: 1.2;
  }
  .ce-pt.on {
    fill: var(--accent);
    stroke: var(--accent);
  }
</style>
