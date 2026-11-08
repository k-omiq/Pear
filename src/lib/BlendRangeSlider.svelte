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
  // Unsplit: a point moves both its halves.
  function setBlack(n) {
    const b = clamp(n, 0, v[2]);
    set([b, b, v[2], v[3]]);
  }
  function setWhite(n) {
    const w = clamp(n, v[1], 255);
    set([v[0], v[1], w, w]);
  }
  // Split: one half, between the handles either side of it.
  function setHalf(i, n) {
    const next = [...v];
    next[i] = clamp(n, i > 0 ? v[i - 1] : 0, i < 3 ? v[i + 1] : 255);
    set(next);
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
  <div class="br-track" class:split style:background={ramp}>
    {#if split}
      {#each HALVES as half, i (half)}
        <input type="range" min="0" max="255" step="1" value={v[i]} {disabled} aria-label="{label} {half}" oninput={(e) => setHalf(i, e.target.value)} />
      {/each}
    {:else}
      <input type="range" min="0" max="255" step="1" value={v[1]} {disabled} aria-label="{label} black" oninput={(e) => setBlack(e.target.value)} />
      <input type="range" min="0" max="255" step="1" value={v[2]} {disabled} aria-label="{label} white" oninput={(e) => setWhite(e.target.value)} />
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
