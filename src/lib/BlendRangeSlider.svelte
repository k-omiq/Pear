<script>
  // One Blend If slider (Photoshop's Layer Style > Blending Options): a black
  // point and a white point over a ramp of the channel's levels, 0 to 255.
  // A pixel whose value is under the black point or over the white point is
  // hidden. "Split" stands in for Photoshop's Alt-drag: each point becomes
  // two handles, and between the halves the box fades. The value is the
  // style's [black low, black high, white low, white high] (`normalizeBlendRange`);
  // a handle stops at its neighbours, so the four stay in order.
  let { label, value = [0, 0, 255, 255], channel = 'gray', disabled = false, onchange } = $props();

  const v = $derived(Array.isArray(value) && value.length === 4 ? value : [0, 0, 255, 255]);
  // Shown split when the value is; the toggle splits or joins by hand.
  let splitByHand = $state(null);
  const split = $derived(splitByHand ?? (v[0] !== v[1] || v[2] !== v[3]));

  // The ramp under the handles: the channel from none to full.
  const END = { gray: '#ffffff', red: '#ff0000', green: '#00ff00', blue: '#0000ff' };
  const ramp = $derived(`linear-gradient(to right, #000000, ${END[channel] ?? END.gray})`);

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));
  function set(next) {
    onchange?.(next);
  }
  // Each setter returns the value it kept, so the input can be told: a handle
  // stopped at its neighbour whose stored value did not change would otherwise
  // stay drawn where the pointer left it (Svelte skips an unchanged write).
  // Unsplit: a point moves both its halves.
  function setBlack(n) {
    const b = clamp(n, 0, v[2]);
    set([b, b, v[2], v[3]]);
    return b;
  }
  function setWhite(n) {
    const w = clamp(n, v[1], 255);
    set([v[0], v[1], w, w]);
    return w;
  }
  // Split: one half, between the handles either side of it.
  function setHalf(i, n) {
    const next = [...v];
    next[i] = clamp(n, i > 0 ? v[i - 1] : 0, i < 3 ? v[i + 1] : 255);
    set(next);
    return next[i];
  }
  const put = (e, kept) => {
    e.target.value = String(kept);
  };

  // The inputs lie on top of each other, so the last in the DOM takes every
  // press, even when its handle cannot move that way (a white point at 255, or
  // two handles on the same spot). The handle a press should take is the
  // nearest one that is free to move toward the pointer, and its input is
  // raised before the press lands.
  const handles = $derived(
    split
      ? [0, 1, 2, 3].map((i) => ({ val: v[i], lo: i > 0 ? v[i - 1] : 0, hi: i < 3 ? v[i + 1] : 255, set: (n) => setHalf(i, n) }))
      : [
          { val: v[1], lo: 0, hi: v[2], set: setBlack },
          { val: v[2], lo: v[1], hi: 255, set: setWhite },
        ],
  );
  let raised = $state(-1);
  let trackEl;
  const valueAt = (clientX) => {
    const r = trackEl.getBoundingClientRect();
    return r.width > 0 ? clamp(((clientX - r.left) / r.width) * 255, 0, 255) : 0;
  };
  function nearest(x) {
    let best = -1;
    let bestD = Infinity;
    handles.forEach((h, i) => {
      const free = x > h.val ? h.hi > h.val : x < h.val ? h.lo < h.val : true;
      const d = Math.abs(x - h.val) + (free ? 0 : 1000);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }
  function aim(e) {
    if (disabled || !trackEl) return -1;
    raised = nearest(valueAt(e.clientX));
    return raised;
  }
  // A press that still lands on another input (touch has no hover to raise
  // from) is taken over and dragged here.
  function press(e) {
    const i = aim(e);
    if (i < 0 || e.target === trackEl.querySelectorAll('input')[i]) return;
    e.preventDefault();
    const h = handles[i];
    const move = (ev) => {
      const kept = h.set(valueAt(ev.clientX));
      const input = trackEl.querySelectorAll('input')[i];
      if (input) input.value = String(kept);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    move(e);
  }
  // Joining a split point puts both halves where its middle was.
  function toggleSplit(on) {
    splitByHand = on;
    if (!on && (v[0] !== v[1] || v[2] !== v[3])) {
      const b = Math.round((v[0] + v[1]) / 2);
      const w = Math.max(b, Math.round((v[2] + v[3]) / 2));
      set([b, b, w, w]);
    }
  }
  const text = (lo, hi) => (lo === hi ? `${lo}` : `${lo}/${hi}`);
  const HALVES = ['black low', 'black high', 'white low', 'white high'];
</script>

<div class="br" class:off={disabled}>
  <div class="br-head">
    <span class="br-lbl">{label}</span>
    <span class="br-val" aria-hidden="true">{text(v[0], v[1])} · {text(v[2], v[3])}</span>
    <label class="br-split" title="Split a point in two halves: the box fades between them (Photoshop: Alt-drag)">
      <input type="checkbox" checked={split} {disabled} aria-label="{label} split" onchange={(e) => toggleSplit(e.target.checked)} />
      <span>Split</span>
    </label>
  </div>
  <div class="br-track" class:split style:background={ramp} bind:this={trackEl} onpointermove={aim} onpointerdowncapture={press} role="presentation">
    {#if split}
      {#each HALVES as half, i (half)}
        <input type="range" min="0" max="255" step="1" value={v[i]} {disabled} aria-label="{label} {half}" style:z-index={raised === i ? 2 : 1} oninput={(e) => put(e, setHalf(i, e.target.value))} />
      {/each}
    {:else}
      <input type="range" min="0" max="255" step="1" value={v[1]} {disabled} aria-label="{label} black" style:z-index={raised === 0 ? 2 : 1} oninput={(e) => put(e, setBlack(e.target.value))} />
      <input type="range" min="0" max="255" step="1" value={v[2]} {disabled} aria-label="{label} white" style:z-index={raised === 1 ? 2 : 1} oninput={(e) => put(e, setWhite(e.target.value))} />
    {/if}
  </div>
</div>

<style>
  .br {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .br.off {
    opacity: 0.5;
  }
  .br-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--t2);
  }
  .br-lbl {
    flex: 1 1 auto;
    min-width: 0;
  }
  .br-val {
    font-variant-numeric: tabular-nums;
    color: var(--t3);
  }
  .br-split {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  /* The handles share one track: the inputs lie on top of each other and
     only their thumbs take the pointer. */
  .br-track {
    position: relative;
    height: 12px;
    border-radius: 2px;
    border: 1px solid var(--line2);
  }
  .br-track input[type='range'] {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    background: transparent;
    pointer-events: none;
  }
  .br-track input[type='range']::-webkit-slider-thumb {
    pointer-events: auto;
  }
  .br-track input[type='range']::-moz-range-thumb {
    pointer-events: auto;
  }
  .br-track.split input[type='range']::-webkit-slider-thumb {
    width: 10px;
    height: 10px;
  }
</style>
