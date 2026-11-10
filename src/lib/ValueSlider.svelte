<script>
  // A slider with its value beside it: the one numeric control of the layer
  // effects (Inspector, Effects tab). The value reads as quiet text; where an
  // exact number matters (`exact`) it is a small field to type in instead.
  //
  //   value, min, max, step   as a range input's; `oninput(v)` hears every
  //                           change, already clamped to min..max
  //   soft                    where the track ends while the value is under
  //                           it: Photoshop's Distance runs to 30000 px, and
  //                           a track that long cannot set 5. A typed value
  //                           past it stretches the track to it.
  //   unit                    shown after the number: 'px', '%', '°'
  //   label                   the control's name for a screen reader
  let { value, min = 0, max = 100, step = 1, soft = null, unit = '', label, disabled = false, exact = false, oninput } = $props();

  const UNIT_WORDS = { px: 'page px', '%': 'percent', '°': 'degrees' };
  const n = $derived(Number.isFinite(+value) ? +value : min);
  const top = $derived(soft == null ? max : Math.min(max, Math.max(soft, n)));
  const shown = $derived(fmt(n));

  // Whole steps, and at most two decimals for a half-step size.
  function fmt(v) {
    const r = Math.round(v / step) * step;
    return String(Math.round(r * 100) / 100);
  }
  const clamp = (v) => Math.min(max, Math.max(min, v));
  function fromTrack(e) {
    oninput?.(clamp(+e.currentTarget.value));
  }
  // Typed: committed on change, never per keystroke (a half-typed "-" is not
  // a number). An empty or unreadable entry puts the value back.
  function fromField(e) {
    const el = e.currentTarget;
    const v = +el.value;
    if (el.value.trim() !== '' && Number.isFinite(v)) oninput?.(clamp(v));
    el.value = fmt(Number.isFinite(+value) ? +value : min);
  }
</script>

<div class="vs" class:off={disabled}>
  <input
    type="range"
    {min}
    max={top}
    {step}
    value={n}
    {disabled}
    aria-label={label}
    aria-valuetext="{shown}{unit ? ` ${UNIT_WORDS[unit] ?? unit}` : ''}"
    oninput={fromTrack}
  />
  {#if exact}
    <label class="vs-num" class:has-unit={!!unit}>
      <input type="number" {min} {max} {step} value={shown} {disabled} aria-label="{label}{unit ? `, ${UNIT_WORDS[unit] ?? unit}` : ''}" onchange={fromField} />
      {#if unit}<span class="vs-unit" aria-hidden="true">{unit}</span>{/if}
    </label>
  {:else}
    <output class="vs-val" aria-hidden="true">{shown}<span class="vs-unit">{unit}</span></output>
  {/if}
</div>

<style>
  .vs {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .vs input[type='range'] {
    flex: 1 1 auto;
    min-width: 0;
  }
  .vs.off {
    opacity: 0.5;
  }
  /* The value, right-aligned in a fixed column so a stack of sliders lines
     its numbers up (the Tabular Rule). */
  .vs-val {
    flex: 0 0 46px;
    text-align: right;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--t2);
    white-space: nowrap;
  }
  .vs-unit {
    color: var(--t3);
    margin-left: 1px;
  }
  .vs-num {
    flex: 0 0 auto;
    position: relative;
    display: flex;
    align-items: center;
  }
  .vs-num input {
    width: 54px;
    height: 26px;
    padding: 0 6px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    -moz-appearance: textfield;
  }
  .vs-num.has-unit input {
    padding-right: 20px;
  }
  .vs-num input::-webkit-inner-spin-button,
  .vs-num input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .vs-num .vs-unit {
    position: absolute;
    right: 6px;
    font-size: 11px;
    pointer-events: none;
  }
</style>
