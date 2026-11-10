<script>
  // An angle as Photoshop's dial sets one: a circle with a hand from its
  // centre, dragged round, and the degrees beside it to type. 0 points right
  // and the angle runs counter-clockwise (90 is up), as every angle in the
  // layer style is stored. Shift snaps to 15 degrees.
  //
  // Given an `altitude` too (0..90) it is Photoshop's light dial for Bevel &
  // Emboss: the point is where the light stands, its direction the angle and
  // its distance from the rim the altitude (the rim is 0, level with the
  // letters; the centre is 90, straight above). One drag sets both.
  //
  //   oninput({ angle, altitude }, { live })   every change; `altitude` only
  //                  on a light dial; `live` while the dial is held down
  //   onend()        the drag let go, so a caller holding a drag's changes as
  //                  one step (the chapter's light) can record it
  let { angle, altitude = null, label, disabled = false, oninput, onend } = $props();

  const light = $derived(altitude != null);
  const R = $derived(light ? 26 : 14);
  const a = $derived(Number.isFinite(+angle) ? +angle : 0);
  const alt = $derived(Number.isFinite(+altitude) ? Math.min(90, Math.max(0, +altitude)) : 0);
  // The hand's end, in the dial's own box (y down): on the rim for an angle,
  // in from it by the altitude for a light.
  const reach = $derived(light ? R * (1 - alt / 90) : R - 3);
  const tip = $derived({ x: R + Math.cos((a * Math.PI) / 180) * reach, y: R - Math.sin((a * Math.PI) / 180) * reach });

  let el = $state(null);
  let held = false;

  const wrap = (v) => {
    const r = Math.round(((((v + 180) % 360) + 360) % 360) - 180);
    return r === -180 ? 180 : r;
  };
  function send(next) {
    oninput?.(light ? { angle: next.angle ?? a, altitude: next.altitude ?? alt } : { angle: next.angle ?? a }, { live: held });
  }
  function fromPointer(e) {
    const box = el.getBoundingClientRect();
    const dx = e.clientX - (box.left + box.width / 2);
    const dy = e.clientY - (box.top + box.height / 2);
    let deg = (Math.atan2(-dy, dx) * 180) / Math.PI;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    const out = { angle: wrap(deg) };
    if (light) {
      const r = Math.min(1, Math.hypot(dx, dy) / (box.width / 2));
      out.altitude = Math.round(90 * (1 - r));
    }
    send(out);
  }
  function down(e) {
    if (disabled || e.button !== 0) return;
    held = true;
    el.setPointerCapture?.(e.pointerId);
    el.focus();
    fromPointer(e);
  }
  function move(e) {
    if (held) fromPointer(e);
  }
  function up(e) {
    if (!held) return;
    held = false;
    el.releasePointerCapture?.(e.pointerId);
    onend?.();
  }
  // Arrows turn it a degree (Shift: 15); on a light dial Up and Down raise
  // and lower the light instead.
  function key(e) {
    if (disabled) return;
    const step = e.shiftKey ? 15 : 1;
    let out = null;
    if (e.key === 'ArrowLeft' || (!light && e.key === 'ArrowUp')) out = { angle: wrap(a + step) };
    else if (e.key === 'ArrowRight' || (!light && e.key === 'ArrowDown')) out = { angle: wrap(a - step) };
    else if (light && e.key === 'ArrowUp') out = { altitude: Math.min(90, alt + step) };
    else if (light && e.key === 'ArrowDown') out = { altitude: Math.max(0, alt - step) };
    if (!out) return;
    e.preventDefault();
    send(out);
  }
  function typed(e, field) {
    const t = e.currentTarget;
    const v = +t.value;
    if (t.value.trim() !== '' && Number.isFinite(v)) send(field === 'angle' ? { angle: wrap(v) } : { altitude: Math.round(Math.min(90, Math.max(0, v))) });
    t.value = String(field === 'angle' ? Math.round(a) : Math.round(alt));
  }
</script>

<div class="dial-row" class:off={disabled}>
  <div
    bind:this={el}
    class="dial"
    class:light
    style="width:{R * 2}px;height:{R * 2}px"
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label={label}
    aria-valuemin="-180"
    aria-valuemax="180"
    aria-valuenow={Math.round(a)}
    aria-valuetext={light ? `${Math.round(a)} degrees, ${Math.round(alt)} degrees high` : `${Math.round(a)} degrees`}
    aria-disabled={disabled}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onkeydown={key}
  >
    <svg viewBox="0 0 {R * 2} {R * 2}" aria-hidden="true">
      <circle class="face" cx={R} cy={R} r={R - 0.5} />
      {#if light}
        <!-- The altitude rings, 30 and 60 degrees up. -->
        <circle class="ring" cx={R} cy={R} r={(R * 2) / 3} />
        <circle class="ring" cx={R} cy={R} r={R / 3} />
      {/if}
      <line class="hand" x1={R} y1={R} x2={tip.x} y2={tip.y} />
      <circle class="hub" cx={R} cy={R} r="1.5" />
      <circle class="knob" cx={tip.x} cy={tip.y} r={light ? 3.5 : 2.5} />
    </svg>
  </div>
  <div class="dial-fields">
    <label class="dial-num" title="Angle, degrees">
      <input type="number" min="-180" max="180" step="1" value={Math.round(a)} {disabled} aria-label="{label}, degrees" onchange={(e) => typed(e, 'angle')} />
      <span aria-hidden="true">°</span>
    </label>
    {#if light}
      <label class="dial-num" title="Altitude: how high the light stands, degrees (90 is straight above)">
        <input type="number" min="0" max="90" step="1" value={Math.round(alt)} {disabled} aria-label="{label} altitude, degrees" onchange={(e) => typed(e, 'altitude')} />
        <span aria-hidden="true">° up</span>
      </label>
    {/if}
  </div>
</div>

<style>
  .dial-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .dial-row.off {
    opacity: 0.5;
  }
  .dial {
    flex: none;
    border-radius: 50%;
    cursor: grab;
    touch-action: none;
    outline: none;
  }
  .dial:active {
    cursor: grabbing;
  }
  .off .dial {
    cursor: default;
  }
  .dial:focus-visible {
    box-shadow: 0 0 0 2px var(--panel), 0 0 0 4px var(--accent);
  }
  .dial svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .face {
    fill: var(--surface);
    stroke: var(--line2);
    stroke-width: 1;
  }
  .ring {
    fill: none;
    stroke: var(--line);
    stroke-width: 1;
  }
  .hand {
    stroke: var(--accent);
    stroke-width: 1.5;
    stroke-linecap: round;
  }
  .hub {
    fill: var(--accent);
  }
  .knob {
    fill: var(--accent);
    stroke: var(--surface);
    stroke-width: 1.5;
  }
  .dial-fields {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .dial-num {
    display: flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: var(--t3);
    white-space: nowrap;
  }
  .dial-num input {
    width: 50px;
    height: 26px;
    padding: 0 6px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    -moz-appearance: textfield;
  }
  .dial-num input::-webkit-inner-spin-button,
  .dial-num input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
</style>
