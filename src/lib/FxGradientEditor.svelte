<!--
  An effect gradient's stops, as Photoshop's Gradient Editor lays them out:
  the opacity stops on a rail above the ramp, the colour stops on a rail
  under it, and between each two neighbours on a rail a midpoint diamond
  (where the blend is half-way, 5 to 95 % of the way across). Clicking an
  empty stretch of a rail puts a stop there; a stop or a diamond drags along
  its rail, and the arrow keys move the one with focus (Shift for 10 %).
  The selected one's fields sit under the bar.

  `g` is a normalised effect gradient (`normalizeFxGradient`); every change
  goes through `onchange` (the Inspector's `touch`), and a colour through
  `oncolour(stop, key, hex)` (its `setColour`, which arms the undo snapshot
  the colour picker's popover would otherwise miss).
-->
<script>
  import ColorPicker from './ColorPicker.svelte';
  import { GRADIENT_MIN_STOPS, GRADIENT_MAX_STOPS, GRADIENT_MID_MIN, GRADIENT_MID_MAX } from './data.js';
  import { rampCss, sampleRamp } from './gradient-ramp.js';

  let { g, title, onchange, oncolour } = $props();

  // What is selected: a stop of a kind, or the midpoint a stop ends.
  let sel = $state({ kind: 'color', i: 0, mid: false });
  let rampEl = $state(null);
  let drag = null;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pct = (v) => Math.round((Number(v) || 0) * 100);
  const list = (kind) => (kind === 'color' ? g.stops : (g.opacityStops ?? []));

  // A gradient that reached the panel from before opacity stops were their
  // own (an old undo entry) gets its list made before the first edit to it.
  function opacityList() {
    if (!Array.isArray(g.opacityStops)) g.opacityStops = g.stops.map((st) => ({ opacity: st.opacity ?? 1, pos: st.pos }));
    return g.opacityStops;
  }

  // Each rail's stops by position, and the diamonds between them: the k-th
  // one belongs to the stop that ends its segment.
  function railOf(kind) {
    const stops = list(kind);
    const order = stops.map((_, i) => i).sort((a, b) => stops[a].pos - stops[b].pos);
    const mids = [];
    for (let k = 1; k < order.length; k++) {
      const a = stops[order[k - 1]].pos;
      const b = stops[order[k]].pos;
      if (b - a < 1e-6) continue;
      const m = Number.isFinite(stops[order[k]].mid) ? stops[order[k]].mid : 0.5;
      mids.push({ i: order[k], at: a + (b - a) * m, m, n: k });
    }
    return { stops, order, mids };
  }
  const colorRail = $derived(railOf('color'));
  const opacityRail = $derived(railOf('opacity'));
  const css = $derived(rampCss(g));

  const selList = $derived(list(sel.kind));
  const selStop = $derived(selList[Math.min(sel.i, selList.length - 1)]);

  function posOf(e) {
    const r = rampEl?.getBoundingClientRect();
    if (!r || r.width <= 0) return 0;
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  }

  // The segment stop `i` of `kind` ends: its neighbour before it by position.
  function before(kind, i) {
    const stops = list(kind);
    let best = null;
    for (let j = 0; j < stops.length; j++) {
      if (j === i) continue;
      const p = stops[j].pos;
      if (p < stops[i].pos || (p === stops[i].pos && j < i)) {
        if (best === null || p >= stops[best].pos) best = j;
      }
    }
    return best;
  }

  function setMid(st, m) {
    const v = Math.round(clamp(m, GRADIENT_MID_MIN, GRADIENT_MID_MAX) * 100) / 100;
    if (v === 0.5) delete st.mid;
    else st.mid = v;
  }

  // The ramp's colour or opacity where a new stop goes, so adding one
  // changes nothing until it is moved or recoloured.
  function addAt(kind, pos) {
    const stops = kind === 'color' ? g.stops : opacityList();
    if (stops.length >= GRADIENT_MAX_STOPS) return;
    const here = sampleRamp(g, 100).reduce((a, b) => (Math.abs(b.pos - pos) < Math.abs(a.pos - pos) ? b : a), { pos: Infinity });
    const st =
      kind === 'color'
        ? { color: '#' + (here?.rgb ?? [0, 0, 0]).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join(''), pos }
        : { opacity: Math.round((here?.opacity ?? 1) * 100) / 100, pos };
    stops.push(st);
    // The list holds its own (proxied) copy: that is the one to follow.
    const added = stops[stops.length - 1];
    stops.sort((a, b) => a.pos - b.pos);
    sel = { kind, i: Math.max(0, stops.indexOf(added)), mid: false };
    onchange();
  }

  function removeSel() {
    const stops = sel.kind === 'color' ? g.stops : opacityList();
    if (sel.mid || stops.length <= GRADIENT_MIN_STOPS) return;
    stops.splice(Math.min(sel.i, stops.length - 1), 1);
    sel = { kind: sel.kind, i: Math.max(0, Math.min(sel.i, stops.length - 1)), mid: false };
    onchange();
  }

  function onRailDown(e, kind) {
    if (e.target.closest('.fxg-stop, .fxg-mid')) return;
    addAt(kind, Math.round(posOf(e) * 100) / 100);
  }

  function onHandleDown(e, kind, i, mid) {
    e.stopPropagation();
    e.preventDefault();
    if (kind === 'opacity') opacityList();
    sel = { kind, i, mid };
    drag = { kind, i, mid };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus();
  }
  function onHandleMove(e) {
    if (!drag) return;
    const stops = list(drag.kind);
    const st = stops[drag.i];
    if (!st) return;
    const t = posOf(e);
    if (drag.mid) {
      const b = before(drag.kind, drag.i);
      if (b === null) return;
      const a = stops[b].pos;
      if (st.pos - a < 1e-6) return;
      setMid(st, (t - a) / (st.pos - a));
    } else {
      st.pos = Math.round(t * 100) / 100;
    }
    onchange();
  }
  // Live while dragged a stop keeps its index; sorted when let go, its
  // selection following it.
  function onHandleUp(e) {
    if (!drag) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const was = drag;
    drag = null;
    if (!was.mid) resort(was.kind, was.i);
  }
  function resort(kind, i) {
    const stops = list(kind);
    const st = stops[i];
    stops.sort((a, b) => a.pos - b.pos);
    sel = { kind, i: Math.max(0, stops.indexOf(st)), mid: sel.mid };
    onchange();
  }

  function onHandleKey(e, kind, i, mid) {
    const step = e.shiftKey ? 0.1 : 0.01;
    const stops = list(kind);
    const st = stops[i];
    if (!st) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      const d = e.key === 'ArrowLeft' ? -step : step;
      sel = { kind, i, mid };
      if (mid) setMid(st, (Number.isFinite(st.mid) ? st.mid : 0.5) + d);
      else st.pos = Math.round(clamp(st.pos + d, 0, 1) * 100) / 100;
      onchange();
      if (!mid) resort(kind, i);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !mid) {
      e.preventDefault();
      e.stopPropagation();
      sel = { kind, i, mid: false };
      removeSel();
    }
  }

  function setNum(e, key, lo, hi) {
    const el = e.target;
    const v = clamp(Math.round(+el.value || 0), lo, hi);
    el.value = String(v);
    if (!selStop) return;
    if (key === 'mid') setMid(selStop, v / 100);
    else selStop[key] = v / 100;
    onchange();
    if (key === 'pos') resort(sel.kind, sel.i);
  }
</script>

<div class="fxg">
  <div class="fxg-rail top" role="presentation" onpointerdown={(e) => onRailDown(e, 'opacity')} title="Opacity stops: click to add one">
    {#each opacityRail.mids as d (d.i)}
      <button
        type="button"
        class="fxg-mid"
        class:on={sel.kind === 'opacity' && sel.mid && sel.i === d.i}
        style="left:{d.at * 100}%"
        aria-label="{title} opacity midpoint {d.n} at {pct(d.m)} percent"
        title="Midpoint · {pct(d.m)}% · drag to move"
        onpointerdown={(e) => onHandleDown(e, 'opacity', d.i, true)}
        onpointermove={onHandleMove}
        onpointerup={onHandleUp}
        onpointercancel={onHandleUp}
        onkeydown={(e) => onHandleKey(e, 'opacity', d.i, true)}
      ></button>
    {/each}
    {#each opacityRail.stops as st, i (i)}
      <button
        type="button"
        class="fxg-stop down"
        class:on={sel.kind === 'opacity' && !sel.mid && sel.i === i}
        style="left:{clamp(st.pos, 0, 1) * 100}%;--stop-c:rgb(0 0 0 / {st.opacity})"
        aria-label="{title} opacity stop {opacityRail.order.indexOf(i) + 1} at {pct(st.pos)} percent, {pct(st.opacity)} percent opaque"
        title="Opacity stop · {pct(st.opacity)}% at {pct(st.pos)}% · drag to move"
        onpointerdown={(e) => onHandleDown(e, 'opacity', i, false)}
        onpointermove={onHandleMove}
        onpointerup={onHandleUp}
        onpointercancel={onHandleUp}
        onkeydown={(e) => onHandleKey(e, 'opacity', i, false)}
      ></button>
    {/each}
  </div>
  <div class="fxg-bar"><div class="fxg-ramp" bind:this={rampEl} style="background-image:{css}"></div></div>
  <div class="fxg-rail bottom" role="presentation" onpointerdown={(e) => onRailDown(e, 'color')} title="Colour stops: click to add one">
    {#each colorRail.mids as d (d.i)}
      <button
        type="button"
        class="fxg-mid"
        class:on={sel.kind === 'color' && sel.mid && sel.i === d.i}
        style="left:{d.at * 100}%"
        aria-label="{title} colour midpoint {d.n} at {pct(d.m)} percent"
        title="Midpoint · {pct(d.m)}% · drag to move"
        onpointerdown={(e) => onHandleDown(e, 'color', d.i, true)}
        onpointermove={onHandleMove}
        onpointerup={onHandleUp}
        onpointercancel={onHandleUp}
        onkeydown={(e) => onHandleKey(e, 'color', d.i, true)}
      ></button>
    {/each}
    {#each colorRail.stops as st, i (i)}
      <button
        type="button"
        class="fxg-stop up"
        class:on={sel.kind === 'color' && !sel.mid && sel.i === i}
        style="left:{clamp(st.pos, 0, 1) * 100}%;--stop-c:{st.color}"
        aria-label="{title} colour stop {colorRail.order.indexOf(i) + 1} at {pct(st.pos)} percent"
        title="Colour stop · {pct(st.pos)}% · drag to move"
        onpointerdown={(e) => onHandleDown(e, 'color', i, false)}
        onpointermove={onHandleMove}
        onpointerup={onHandleUp}
        onpointercancel={onHandleUp}
        onkeydown={(e) => onHandleKey(e, 'color', i, false)}
      ></button>
    {/each}
  </div>

  {#if selStop}
    <div class="fxg-sel">
      {#if sel.mid}
        <span class="fxg-kind">{sel.kind === 'color' ? 'Colour' : 'Opacity'} midpoint</span>
        <label class="fxg-num" title="Where the blend is half-way, % of the way from the stop before">
          <span>Location</span>
          <input type="number" min={GRADIENT_MID_MIN * 100} max={GRADIENT_MID_MAX * 100} step="1" value={pct(selStop.mid ?? 0.5)} aria-label="{title} midpoint, percent" onchange={(e) => setNum(e, 'mid', GRADIENT_MID_MIN * 100, GRADIENT_MID_MAX * 100)} />
        </label>
      {:else}
        {#if sel.kind === 'color'}
          <ColorPicker value={selStop.color} label="{title} stop colour" size={24} unclipped onchange={(hex) => oncolour(selStop, 'color', hex)} />
        {:else}
          <label class="fxg-num" title="Opacity of this stop, %">
            <span>Opacity</span>
            <input type="number" min="0" max="100" step="1" value={pct(selStop.opacity)} aria-label="{title} stop opacity, percent" onchange={(e) => setNum(e, 'opacity', 0, 100)} />
          </label>
        {/if}
        <label class="fxg-num" title="Position along the gradient, %">
          <span>Location</span>
          <input type="number" min="0" max="100" step="1" value={pct(selStop.pos)} aria-label="{title} stop location, percent" onchange={(e) => setNum(e, 'pos', 0, 100)} />
        </label>
        <button type="button" class="icon-btn" title={selList.length > GRADIENT_MIN_STOPS ? 'Delete this stop' : 'A gradient needs two stops of each kind'} aria-label="{title} delete stop" disabled={selList.length <= GRADIENT_MIN_STOPS} onclick={removeSel}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .fxg {
    display: flex;
    flex-direction: column;
    margin: 4px 0;
  }
  /* The rails' boxes are the ramp's box exactly (same side borders, no
     margin), so a handle's `left` is its place along the gradient. */
  .fxg-rail {
    position: relative;
    height: 15px;
    background: var(--surface);
    border: 1px solid var(--line2);
    cursor: copy;
    touch-action: none;
  }
  .fxg-rail.top {
    border-bottom: none;
    border-radius: 7px 7px 0 0;
  }
  .fxg-rail.bottom {
    border-top: none;
    border-radius: 0 0 7px 7px;
  }
  .fxg-bar {
    position: relative;
    height: 24px;
    border-left: 1px solid var(--line2);
    border-right: 1px solid var(--line2);
    overflow: hidden;
    /* The chequerboard an opacity is read against. */
    background-color: #fff;
    background-image:
      linear-gradient(45deg, #c9c9c9 25%, transparent 25%),
      linear-gradient(-45deg, #c9c9c9 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #c9c9c9 75%),
      linear-gradient(-45deg, transparent 75%, #c9c9c9 75%);
    background-size: 10px 10px;
    background-position: 0 0, 0 5px, 5px -5px, -5px 0;
  }
  .fxg-ramp {
    position: absolute;
    inset: 0;
  }
  /* A house pointed at the ramp; the point is the position. */
  .fxg-stop {
    position: absolute;
    width: 13px;
    height: 15px;
    margin-left: -6.5px;
    padding: 0;
    border: none;
    background: var(--stop-c, #000);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.45);
    cursor: ew-resize;
    touch-action: none;
  }
  .fxg-stop.up {
    top: -1px;
    clip-path: polygon(50% 0, 100% 40%, 100% 100%, 0 100%, 0 40%);
  }
  .fxg-stop.down {
    bottom: -1px;
    clip-path: polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%);
  }
  .fxg-mid {
    position: absolute;
    top: 3px;
    width: 9px;
    height: 9px;
    margin-left: -4.5px;
    padding: 0;
    border: 1px solid var(--text);
    background: var(--surface);
    transform: rotate(45deg);
    cursor: ew-resize;
    touch-action: none;
  }
  .fxg-stop:hover,
  .fxg-mid:hover {
    box-shadow: inset 0 0 0 1px var(--text);
  }
  .fxg-stop.on,
  .fxg-stop:focus-visible {
    outline: none;
    box-shadow:
      inset 0 0 0 1px var(--accent-fg),
      inset 0 0 0 3px var(--accent);
  }
  .fxg-mid.on,
  .fxg-mid:focus-visible {
    outline: none;
    background: var(--accent);
    border-color: var(--accent);
  }
  .fxg-sel {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    min-height: 26px;
  }
  .fxg-kind {
    font-size: 11px;
    color: var(--muted);
  }
  .fxg-num {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--muted);
  }
  .fxg-num input {
    width: 46px;
  }
</style>
