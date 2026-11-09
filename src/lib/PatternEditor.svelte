<!--
  The one pattern editor. The fill's pattern, the pattern overlay, a Photoshop
  stroke's pattern, the bevel's texture and the Bulk Style panel's pattern are
  the same record (`normalizePattern`) through the same painter (`screenFill`),
  so they share every control.

  `kinds` + `cards` pick the kind from swatches (the fill, which has the room);
  without them a list does. The browser engine repeats a canvas tile and reads
  kind, scale and the two colours only, so the rest shows only with `rust`.
  `full` shows every kind and control whatever the engine: a layer effect's
  pattern is kept and written to the PSD even while nothing paints it.
  `acts` and `note` are the caller's own extras (the pick from the page).
-->
<script>
  import ColorPicker from './ColorPicker.svelte';
  import { PATTERN_KINDS, CANVAS_PATTERN_KINDS, SEEDED_PATTERN_KINDS, PATTERN_SCALE_MIN, PATTERN_SCALE_MAX } from './data.js';

  let { p = $bindable(), title, rust = false, full = false, onchange, oncolour, kinds = null, cards = null, cardTile = 0, acts = null, note = null } = $props();

  let moreOpen = $state(false);

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pct = (v) => Math.round((v ?? 0) * 100);
  // The names the swatches and the list show.
  const PATTERN_LABELS = {
    dots: 'Dots',
    halftone: 'Halftone',
    stripes: 'Stripes',
    hstripes: 'Bands',
    diagonal: 'Diagonal',
    'diagonal-alt': 'Diagonal 2',
    crosshatch: 'Crosshatch',
    checker: 'Checker',
    grid: 'Grid',
    vlines: 'Hairline',
    hlines: 'Hairline 2',
    'halftone-fade': 'Tone fade',
    'square-dots': 'Squares',
    'diamond-dots': 'Diamonds',
    'line-tone': 'Line tone',
    sand: 'Sand',
    stipple: 'Stipple',
    'speed-lines': 'Speed lines',
    burst: 'Burst',
    rings: 'Rings',
    waves: 'Waves',
    zigzag: 'Zigzag',
    bricks: 'Bricks',
    scales: 'Scales',
    hex: 'Hex',
    triangles: 'Triangles',
    plus: 'Plus',
    stars: 'Stars',
    hearts: 'Hearts',
    kakeami: 'Kakeami',
    glitch: 'Glitch',
    dither: 'Dither',
    'dither-dots': 'Dither dots',
    picked: 'From page',
  };
  const patLabel = (k) => PATTERN_LABELS[k] ?? k;
  const HEX = /^#?(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

  const hasTile = $derived(rust && !!p.src && p.cell?.length > 0);
  const image = $derived(p.kind === 'picked' && p.mode === 'image');
  // Every control, not only the ones the browser engine reads.
  const all = $derived(rust || full);
  // The list never drops the kind the record has (a PSD's, on the browser engine).
  const listKinds = $derived.by(() => {
    const list = all ? (hasTile ? [...PATTERN_KINDS, 'picked'] : PATTERN_KINDS) : CANVAS_PATTERN_KINDS;
    return list.includes(p.kind) ? list : [...list, p.kind];
  });
  // The fold says "set" when a setting inside it is not the plain one.
  const tuned = $derived((p.density ?? 0.5) !== 0.5 || !!p.angle || (p.aspect ?? 1) !== 1 || !!p.ox || !!p.oy || p.anchor === 'page' || p.fade?.on === true || (SEEDED_PATTERN_KINDS.includes(p.kind) && (p.seed ?? 1) !== 1));

  function setKind(k) {
    p.kind = k;
    onchange();
  }
  function setNum(obj, key, v, lo, hi) {
    let n = +v;
    if (!Number.isFinite(n)) n = 0;
    obj[key] = clamp(n, lo, hi);
    onchange();
  }
  // A typed number commits on change, not on every key (a half-typed "-").
  function commitNum(obj, key, e, lo, hi, round = false) {
    const el = e.target;
    let n = +el.value;
    if (!Number.isFinite(n)) n = 0;
    n = clamp(n, lo, hi);
    obj[key] = round ? Math.round(n) : n;
    el.value = String(obj[key]);
    onchange();
  }
  // Alpha fields are edited in percent and stored as a fraction.
  function setAlpha(obj, key, v) {
    obj[key] = clamp((+v || 0) / 100, 0, 1);
    onchange();
  }
  function commitAlpha(obj, key, e) {
    const el = e.target;
    obj[key] = clamp((+el.value || 0) / 100, 0, 1);
    el.value = String(Math.round(obj[key] * 100));
    onchange();
  }
  // A bad hex is flagged in place, not put back: the field must not eat text.
  function hexFlag(el, bad) {
    el.classList.toggle('hex-bad', !!bad);
    if (bad) el.title = 'Not a hex colour - use 3, 4, 6 or 8 hex digits, like #ff00aa';
    else el.removeAttribute('title');
  }
  function setHex(key, el) {
    const raw = el.value.trim();
    if (!HEX.test(raw)) return hexFlag(el, true);
    hexFlag(el, false);
    oncolour(p, key, raw.startsWith('#') ? raw : '#' + raw);
  }
</script>

{#snippet colour(key, label)}
  <div class="color-field">
    <ColorPicker value={p[key]} {label} size={24} unclipped onchange={(hex) => oncolour(p, key, hex)} />
    <input type="text" class="hex" value={p[key]} aria-label="{label} hex" oninput={(e) => hexFlag(e.target, e.target.value !== '' && !HEX.test(e.target.value))} onchange={(e) => setHex(key, e.target)} />
  </div>
{/snippet}

{#if kinds}
  <!-- The swatches carry no names: the one chosen is named above them, and
       each says its own on hover. Thirty-odd of them fit without a scroll. -->
  <div class="pat-head">
    <span class="pat-now">{patLabel(p.kind)}</span>
    {#if rust && acts}<span class="pat-end">{@render acts()}</span>{/if}
  </div>
  <div class="pat-grid" role="radiogroup" aria-label="Pattern">
    {#if hasTile}
      <button type="button" role="radio" aria-checked={p.kind === 'picked'} aria-label={patLabel('picked')} class="pat-card" class:on={p.kind === 'picked'} title="The tone taken from the page" style="background-image:url({cards.picked ?? ''});background-size:100% 100%" onclick={() => setKind('picked')}></button>
    {/if}
    {#each kinds as k (k)}
      <button
        type="button"
        role="radio"
        aria-checked={p.kind === k}
        aria-label={patLabel(k)}
        class="pat-card"
        class:on={p.kind === k}
        title={patLabel(k)}
        style="background-image:url({cards[k]});background-size:{rust ? '100% 100%' : `${cardTile}px ${cardTile}px`}"
        onclick={() => setKind(k)}
      ></button>
    {/each}
  </div>
  {#if !rust}
    <p class="nofill-note">More patterns and controls need the Rust text engine (Settings).</p>
  {/if}
{:else}
  <div class="prow">
    <span class="pl">Pattern</span>
    <div class="pc">
      <select value={p.kind} aria-label="{title} kind" onchange={(e) => { p.kind = e.target.value; onchange(); }}>
        {#each listKinds as k (k)}
          <option value={k}>{patLabel(k)}</option>
        {/each}
      </select>
    </div>
  </div>
  {#if rust && acts}
    <div class="pat-acts">{@render acts()}</div>
  {/if}
{/if}
{@render note?.()}
{#if rust && p.kind === 'picked'}
  <div class="prow">
    <span class="pl">Use as</span>
    <div class="pc">
      <div class="seg">
        <button type="button" class:on={p.mode === 'tone'} aria-pressed={p.mode === 'tone'} title="Recolour the tone with the ink and the ground" onclick={() => { p.mode = 'tone'; onchange(); }}>Tone</button>
        <button type="button" class:on={p.mode === 'image'} aria-pressed={p.mode === 'image'} title="Keep the page's own greys" onclick={() => { p.mode = 'image'; onchange(); }}>Image</button>
      </div>
    </div>
  </div>
{/if}
<!-- The slider spans the usual 25..400 %; the field takes all that
     normalizePattern keeps (Photoshop's 1 to 1000 %). -->
<div class="prow" title="Tile size against the font size, %">
  <span class="pl">Scale</span>
  <div class="pc">
    <input type="range" min="25" max="400" step="5" value={pct(p.scale)} aria-label="{title} scale" oninput={(e) => setNum(p, 'scale', e.target.value / 100, PATTERN_SCALE_MIN, PATTERN_SCALE_MAX)} />
    <input type="number" min={PATTERN_SCALE_MIN * 100} max={PATTERN_SCALE_MAX * 100} step="1" value={pct(p.scale)} aria-label="{title} scale, percent" onchange={(e) => { const v = clamp(Math.round(+e.target.value) || 100, PATTERN_SCALE_MIN * 100, PATTERN_SCALE_MAX * 100); p.scale = v / 100; e.target.value = String(v); onchange(); }} />
  </div>
</div>
<!-- A picked tile kept as an image has the page's own greys and its own
     see-through: the two colours and the ground's opacity change nothing
     there (`ScreenShader` in text-engine/src/paint/screen.rs), and the
     ink's opacity fades the whole tile. -->
{#if image}
  <div class="prow">
    <span class="pl">Opacity</span>
    <div class="pc">
      <input type="range" min="0" max="100" step="1" value={pct(p.fgOpacity)} aria-label="{title} opacity" oninput={(e) => setAlpha(p, 'fgOpacity', e.target.value)} />
      <input type="number" min="0" max="100" step="1" value={pct(p.fgOpacity)} aria-label="{title} opacity, percent" onchange={(e) => commitAlpha(p, 'fgOpacity', e)} />
    </div>
  </div>
{:else}
  <div class="prow">
    <span class="pl">Ink</span>
    <div class="pc">
      {@render colour('fg', `${title} ink`)}
      {#if all}
        <input type="number" min="0" max="100" step="1" value={pct(p.fgOpacity)} title="Ink opacity, %" aria-label="{title} ink opacity" onchange={(e) => commitAlpha(p, 'fgOpacity', e)} />
      {/if}
    </div>
  </div>
  <div class="prow">
    <span class="pl">Ground</span>
    <div class="pc">
      {@render colour('bg', `${title} ground`)}
      {#if all}
        <input type="number" min="0" max="100" step="1" value={pct(p.bgOpacity)} title="Ground opacity, %; 0 lets what is under show between" aria-label="{title} ground opacity" onchange={(e) => commitAlpha(p, 'bgOpacity', e)} />
      {/if}
    </div>
  </div>
{/if}
{#if all}
  <!-- svelte-ignore a11y_role_supports_aria_props_implicit -->
  <button type="button" class="insp-fold sub" class:open={moreOpen} aria-expanded={moreOpen} aria-label="{title} more options" aria-description={tuned ? 'has settings' : undefined} title="Density, angle, stretch, offset and fade" onclick={() => (moreOpen = !moreOpen)}>
    <svg class="fold-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
    <span>More</span>
    {#if tuned}<span class="fold-badge">set</span>{/if}
  </button>
  {#if moreOpen}
    {#if !image}
      <div class="prow" title="How much ink; 50% is the pattern as designed">
        <span class="pl">Density</span>
        <div class="pc">
          <input type="range" min="0" max="100" step="1" value={pct(p.density)} aria-label="{title} density" oninput={(e) => setAlpha(p, 'density', e.target.value)} />
          <input type="number" min="0" max="100" step="1" value={pct(p.density)} aria-label="{title} density, percent" onchange={(e) => commitAlpha(p, 'density', e)} />
        </div>
      </div>
    {/if}
    <div class="prow" title="Turns the pattern, degrees">
      <span class="pl">Angle</span>
      <div class="pc">
        <input type="range" min="-180" max="180" step="1" value={p.angle} aria-label="{title} angle" oninput={(e) => setNum(p, 'angle', e.target.value, -180, 180)} />
        <input type="number" min="-180" max="180" step="1" value={p.angle} aria-label="{title} angle, degrees" onchange={(e) => commitNum(p, 'angle', e, -180, 180)} />
      </div>
    </div>
    <div class="prow" title="Stretches the tile along its own width">
      <span class="pl">Stretch</span>
      <div class="pc">
        <input type="range" min="0.25" max="4" step="0.05" value={p.aspect} aria-label="{title} stretch" oninput={(e) => setNum(p, 'aspect', e.target.value, 0.25, 4)} />
        <input type="number" min="0.25" max="4" step="0.05" value={p.aspect} aria-label="{title} stretch, multiple" onchange={(e) => commitNum(p, 'aspect', e, 0.25, 4)} />
      </div>
    </div>
    <div class="prow" title="Moves the tiles, % of a tile">
      <span class="pl">Offset</span>
      <div class="pc">
        <span class="axis">X</span>
        <input type="number" min="0" max="100" step="1" value={pct(p.ox)} aria-label="{title} offset X, percent of a tile" onchange={(e) => commitAlpha(p, 'ox', e)} />
        <span class="axis">Y</span>
        <input type="number" min="0" max="100" step="1" value={pct(p.oy)} aria-label="{title} offset Y, percent of a tile" onchange={(e) => commitAlpha(p, 'oy', e)} />
        <button type="button" class="link-btn end" title="Put the tiles back on the {p.anchor === 'page' ? "page's" : "box's"} corner (Snap to Origin)" aria-label="{title} snap to origin" disabled={!p.ox && !p.oy} onclick={() => { p.ox = 0; p.oy = 0; onchange(); }}>Reset</button>
      </div>
    </div>
    <div class="prow">
      <span class="pl">Tiles from</span>
      <div class="pc">
        <div class="seg" role="group" aria-label="{title} tiles start at">
          <button type="button" class:on={p.anchor !== 'page'} aria-pressed={p.anchor !== 'page'} title="Each box starts its own tiles" onclick={() => { p.anchor = 'box'; onchange(); }}>Box</button>
          <button type="button" class:on={p.anchor === 'page'} aria-pressed={p.anchor === 'page'} title="Tiles line up across boxes, from the page's corner" onclick={() => { p.anchor = 'page'; onchange(); }}>Page</button>
        </div>
      </div>
    </div>
    {#if SEEDED_PATTERN_KINDS.includes(p.kind)}
      <div class="prow" title="Picks the random arrangement; same seed, same pattern">
        <span class="pl">Seed</span>
        <div class="pc">
          <input type="number" class="wide" min="1" max="9999" step="1" value={p.seed} aria-label="{title} seed" onchange={(e) => commitNum(p, 'seed', e, 1, 9999, true)} />
          <button type="button" class="link-btn end" onclick={() => { p.seed = 1 + Math.floor(Math.random() * 9999); onchange(); }}>Reshuffle</button>
        </div>
      </div>
    {/if}
    <!-- An image tile takes no fade. 'halftone-fade' fades on its own, top
         to bottom; the switch then sets where. -->
    {#if !image}
      <div class="prow" title={p.kind === 'halftone-fade' ? 'This tile always fades, top to bottom. Switch on to set where' : 'The ink runs out across the box'}>
        <span class="pl">{p.kind === 'halftone-fade' ? 'Set fade' : 'Fade'}</span>
        <div class="pc">
          <button
            type="button"
            class="switch"
            class:on={p.fade.on}
            role="switch"
            aria-checked={p.fade.on}
            aria-label="{title} fade"
            onclick={() => { p.fade.on = !p.fade.on; onchange(); }}
          ><span class="knob"></span></button>
        </div>
      </div>
      {#if p.fade.on}
        <div class="prow" title="Degrees, as a gradient's: 180 fades top to bottom">
          <span class="pl">Direction</span>
          <div class="pc">
            <input type="range" min="0" max="359" step="1" value={((p.fade.angle % 360) + 360) % 360} aria-label="{title} fade direction" oninput={(e) => setNum(p.fade, 'angle', e.target.value, 0, 359)} />
            <input type="number" min="0" max="359" step="1" value={((p.fade.angle % 360) + 360) % 360} aria-label="{title} fade direction, degrees" onchange={(e) => commitNum(p.fade, 'angle', e, 0, 359)} />
          </div>
        </div>
        <div class="prow" title="Full ink up to here, % across the box">
          <span class="pl">Start</span>
          <div class="pc">
            <input type="range" min="0" max="100" step="1" value={pct(p.fade.from)} aria-label="{title} fade start" oninput={(e) => setAlpha(p.fade, 'from', e.target.value)} />
            <input type="number" min="0" max="100" step="1" value={pct(p.fade.from)} aria-label="{title} fade start, percent" onchange={(e) => commitAlpha(p.fade, 'from', e)} />
          </div>
        </div>
        <div class="prow" title="No ink from here, % across the box">
          <span class="pl">End</span>
          <div class="pc">
            <input type="range" min="0" max="100" step="1" value={pct(p.fade.to)} aria-label="{title} fade end" oninput={(e) => setAlpha(p.fade, 'to', e.target.value)} />
            <input type="number" min="0" max="100" step="1" value={pct(p.fade.to)} aria-label="{title} fade end, percent" onchange={(e) => commitAlpha(p.fade, 'to', e)} />
          </div>
        </div>
      {/if}
    {/if}
  {/if}
{/if}

<style>
  /* Patterns as swatches. Nobody knows what "grid" looks like from the word;
     the tile is drawn by the painter that paints the glyphs, in this box's
     own two colours, so the swatch IS the answer. */
  .pat-grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 6px;
  }
  /* Over the swatches: the chosen pattern's name, and the caller's extras. */
  .pat-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 24px;
  }
  .pat-now {
    font-size: 12px;
    color: var(--text);
  }
  .pat-end,
  .pat-acts {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pat-acts {
    justify-content: flex-end;
    margin-top: -4px;
  }
  /* A swatch: the picture is the control. No frame of its own and no name
     under it; the chosen one wears a ring. */
  .pat-card {
    height: 30px;
    padding: 0;
    border: 1px solid var(--line2);
    border-radius: 5px;
    background-color: var(--surface);
    background-repeat: repeat;
    background-position: center;
    cursor: pointer;
  }
  .pat-card:hover {
    border-color: var(--t2);
  }
  .pat-card.on {
    border-color: transparent;
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .pat-card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
