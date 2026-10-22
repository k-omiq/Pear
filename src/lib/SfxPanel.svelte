<script>
  // The Inspector's SFX pane: the sound type a box is lettered as, and every
  // number of it.
  //
  // It is the Effects tab's first sub-tab. A type card writes the engine's
  // sound type to the selected box's `style.sfx` (data.js) with its look
  // (`applySfxKind`); the rest of the pane tunes it: the seed (Variations, New
  // shape), the strength, the layout numbers (a number the box leaves null is
  // the type's, `sfxResolved`, and a slider shows that until it is moved), the
  // SFX effects, and the caption. Remove SFX puts the box back as it was
  // (`clearSfx`). Every write is followed by the Inspector's `touch`, handed in
  // as a prop, so an edit is one more `style` entry in the same undo flow. The
  // Inspector's capture-phase pointerdown/keydown (`armSnap`) takes the
  // before-snapshot, and this component is rendered inside the element it is
  // set on, so nothing here arms it - except a colour picked in a popover,
  // which lives outside that element: `arm` is the Inspector's `armSnap`.
  //
  // The SFX effects (negative, extrude, shake, trail, outline order and
  // corners, shade) paint only while SFX is on, so their controls are here and
  // only while it is.
  //
  // Under the browser engine there is no SFX layout (`sfxAvailable`), so the
  // pane is one sentence and, when the host can open Settings, a button.
  //
  // The pictures are the engine's own (sfx-preview.js). The stage repaints on
  // any change to the box's style or text, one paint per frame. The cards (the
  // twelve types, and eight seeds of the box's own) are painted while this pane
  // is mounted, three a frame, and only when something their picture depends
  // on has changed; a card already painted is read back from a cache.
  import { onDestroy, untrack } from 'svelte';
  import { app, boxText, lineByN } from './store.svelte.js';
  import { engineSwitch } from './engine-switch.svelte.js';
  import { settleNoise } from './exporter.js';
  import ColorPicker from './ColorPicker.svelte';
  import { sfxAvailable, sfxKinds, sfxKind, sfxPick, sfxPickText, sfxResolved, applySfxKind, clearSfx } from './sfx.js';
  import { cardSpec, cardKey, cachedCard, keepCard, paintCard, paintStage, previewDpr } from './sfx-preview.js';

  /**
   * `box` is the selected box; `pg` its page; `touch` the Inspector's; `arm` its
   * `armSnap`, for a write that comes from outside the panel's element;
   * `onSettings` opens Settings, when it can.
   */
  let { box, pg, touch, onSettings = null, arm = () => {} } = $props();

  const BATCH = 3;
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
  // CSS px; the stage's height in the style block says the same.
  const STAGE_H = 110;

  // The engine can change under an open pane (Settings), and its tables are not
  // reactive, so what stands for "the engine changed" is read here.
  const available = $derived.by(() => {
    engineSwitch.phase;
    engineSwitch.painting;
    app.fontsVersion;
    return sfxAvailable();
  });
  const kinds = $derived(available ? sfxKinds() : []);
  const sfx = $derived(box.style.sfx);
  const on = $derived(!!sfx?.on);
  const current = $derived(on ? sfxKind(sfx.kind) : null);
  const label = $derived(!on ? 'Off' : (current?.name ?? 'Custom'));
  const R = $derived(sfxResolved(sfx));

  const text = $derived(boxText(box, pg));
  // The Japanese the box's line was read from, if any: auto pick reads it
  // first, and the caption's meaning is looked up from it.
  const jp = $derived(box.lineN != null ? (lineByN(pg, box.lineN)?.jp ?? '') : '');
  const pick = $derived(available ? sfxPick(sfxPickText(text, jp)) : null);
  const top = $derived((pick?.order ?? []).filter((id) => sfxKind(id)).slice(0, 3));
  const rankOf = (id) => top.indexOf(id);

  // ---- writes ----
  const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

  // A type over the box. The paths and the letters moved by hand are the
  // user's drawing, not the type's, so they stay.
  function overType(id) {
    const keep = plain({ paths: box.style.sfx.paths, glyphs: box.style.sfx.glyphs });
    if (!applySfxKind(box.style, id)) return false;
    box.style.sfx.paths = keep.paths ?? [];
    box.style.sfx.glyphs = keep.glyphs ?? {};
    return true;
  }
  function chooseKind(id) {
    if (overType(id)) touch();
  }
  // The auto pick's first, at the strength the sound asks for.
  function autoPick() {
    if (!top.length || !overType(top[0])) return;
    if (Number.isFinite(pick?.strength)) box.style.sfx.strength = Math.min(2, Math.max(0, pick.strength));
    touch();
  }
  function newShape() {
    let seed = sfx.seed;
    while (seed === sfx.seed) seed = 1 + Math.floor(Math.random() * 9999);
    box.style.sfx.seed = seed;
    touch();
  }
  function setSeed(n) {
    box.style.sfx.seed = n;
    touch();
  }
  function remove() {
    clearSfx(box.style);
    touch();
  }
  function set(key, v) {
    box.style.sfx[key] = v;
    touch();
  }
  // One part of a two- or three-number field (`flow`, `jitter`): the whole
  // field is written, the other parts as they show now.
  function setPart(key, part, v) {
    box.style.sfx[key] = { ...plain(R[key]), [part]: v };
    touch();
  }
  // The layout numbers back to the type's.
  const LAYOUT_KEYS = ['dir', 'flow', 'follow', 'gap', 'bigTighter', 'slant', 'rise', 'jitter'];
  const layoutSet = $derived(LAYOUT_KEYS.some((k) => sfx?.[k] != null));
  function resetLayout() {
    for (const k of LAYOUT_KEYS) box.style.sfx[k] = null;
    touch();
  }
  function resetPaths() {
    box.style.sfx.paths = [];
    touch();
  }
  function resetGlyphs() {
    box.style.sfx.glyphs = {};
    touch();
  }
  const hasPaths = $derived((sfx?.paths?.length ?? 0) > 0);
  const hasGlyphs = $derived(Object.keys(sfx?.glyphs ?? {}).length > 0);

  // A field of an effect (`negative`, `extrude`, ...) or of the style.
  function setFx(obj, key, v) {
    obj[key] = v;
    touch();
  }
  function setStyle(key, v) {
    box.style[key] = v;
    touch();
  }
  // A colour from the picker's popover, which is outside the Inspector.
  function setColour(obj, key, hex) {
    arm();
    obj[key] = hex;
    touch();
  }
  function setCaption(key, v) {
    box.style.sfx.caption[key] = v;
    touch();
  }

  // ---- the caption's meaning ----
  // The dictionary is big, so it loads the first time it could be asked for.
  let meaningOf = $state(null);
  $effect(() => {
    if (meaningOf || !on || !jp) return;
    import('./sfx-meanings.js').then((m) => (meaningOf = m.sfxMeaning)).catch(() => {});
  });
  const meaning = $derived(meaningOf && jp ? (meaningOf(jp)?.meanings?.[0] ?? '') : '');
  function fillMeaning() {
    if (meaning) setCaption('text', meaning);
  }

  // ---- open sections ----
  let openLayout = $state(false);
  let openFx = $state(false);

  // ---- the stage ----
  let stageEl = $state(null);
  let stageW = $state(0);
  let stageRaf = 0;
  let stageSeq = 0;
  const frame = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
  const unframe = (h) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(h) : clearTimeout(h));
  // A function, so the unit lane's compiler keeps the snapshot (it turns a
  // bare `const x = $state.snapshot(y)` into `const x = y`).
  const snapStyle = () => $state.snapshot(box.style);

  $effect(() => {
    if (!available || !stageEl) return;
    // Read here, tracked: the whole style (a snapshot reads all of it), the
    // text, the frame, the fonts and the stage's own width.
    const snap = { style: snapStyle(), text, w: box.w, h: box.h };
    app.fontsVersion;
    const width = stageW;
    untrack(() => {
      unframe(stageRaf);
      stageRaf = frame(async () => {
        const mine = ++stageSeq;
        // A roughened box's grain needs the browser's turbulence measured once.
        if (snap.style.roughen?.on) await settleNoise([snap]);
        if (mine !== stageSeq || !stageEl) return;
        const dpr = previewDpr();
        const cssW = width > 0 ? width : 296;
        stageEl.width = Math.max(1, Math.round(cssW * dpr));
        stageEl.height = Math.max(1, Math.round(STAGE_H * dpr));
        paintStage(stageEl, snap, dpr);
      });
    });
  });

  // ---- the cards ----
  const dpr = previewDpr();
  let landed = $state(0);
  // Plain data, so that what the cards depend on is one string.
  const spec = $derived(cardSpec(box.style, text));
  const typeCard = (id) => ({ kind: id, seed: sfx?.seed ?? 1 });
  const seedCard = (n) => ({ kind: null, seed: n });
  const cards = $derived([...kinds.map((k) => typeCard(k.id)), ...(on ? SEEDS.map(seedCard) : [])]);
  function urlOf(card) {
    landed;
    const u = cachedCard(cardKey(spec, card, app.fontsVersion, dpr));
    return u ? `background-image:url(${u})` : '';
  }

  let cardRaf = 0;
  let cardSeq = 0;
  $effect(() => {
    if (!available) return;
    const now = spec;
    const list = cards;
    const fonts = app.fontsVersion;
    untrack(() => {
      unframe(cardRaf);
      const mine = ++cardSeq;
      const todo = list.filter((c) => cachedCard(cardKey(now, c, fonts, dpr)) === undefined);
      if (!todo.length) return;
      const step = () => {
        if (mine !== cardSeq) return;
        for (let n = 0; n < BATCH && todo.length; n++) {
          const c = todo.shift();
          // A card that could not be painted is kept as empty, not retried on
          // every change: the next change of font or text is a new key.
          keepCard(cardKey(now, c, fonts, dpr), paintCard(now, c, dpr) ?? '');
        }
        landed++;
        if (todo.length) cardRaf = frame(step);
      };
      cardRaf = frame(step);
    });
  });

  onDestroy(() => {
    cardSeq++;
    stageSeq++;
    unframe(cardRaf);
    unframe(stageRaf);
  });

  // ---- showing numbers ----
  const fix = (v, d = 2) => {
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.round(n * 10 ** d) / 10 ** d) : '';
  };
  const pct = (v) => Math.round((v ?? 0) * 100);
  const wrapDeg = (v) => ((Math.round(v ?? 0) % 360) + 360) % 360;
  const SIDES = [
    ['below', 'Below'],
    ['above', 'Above'],
    ['left', 'Left'],
    ['right', 'Right'],
  ];
</script>

<!-- A slider and what it shows. `isSet` is whether the box holds its own value
     (the slider otherwise shows the type's); `reset` gives the type's back. -->
{#snippet slider(lbl, value, min, max, step, onset, shown, isSet = false, reset = null)}
  <div class="grp">
    <div class="sfx-row-head">
      <span class="lbl">{lbl}</span>
      {#if reset && isSet}
        <button type="button" class="sfx-back" title="Back to the type's" aria-label="{lbl}: back to the type's" onclick={reset}>Type's</button>
      {/if}
    </div>
    <div class="slider-row">
      <input type="range" {min} {max} {step} {value} aria-label={lbl} oninput={(e) => onset(+e.target.value)} />
      <span class="val">{shown}</span>
    </div>
  </div>
{/snippet}

{#snippet toggle(lbl, value, onset)}
  <div class="switch-row">
    <button type="button" class="switch" class:on={value} role="switch" aria-checked={value} aria-label={lbl} onclick={() => onset(!value)}><span class="knob"></span></button>
    <span class="lbl2">{lbl}</span>
  </div>
{/snippet}

{#snippet colour(obj, key, lbl)}
  <div class="sfx-colour">
    <span class="lbl">{lbl}</span>
    <ColorPicker value={obj[key]} label={lbl} size={22} unclipped onchange={(hex) => setColour(obj, key, hex)} />
  </div>
{/snippet}

{#snippet sectionHead(title, open, flip)}
  <button type="button" class="insp-sub-head" aria-expanded={open} onclick={flip}>
    {title}
    <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
  </button>
{/snippet}

{#if !available}
  <div class="grp">
    <div class="insp-none">SFX lettering needs the Rust text engine.</div>
    {#if onSettings}
      <!-- Straight to the tab the engine switch is on, not the last one open. -->
      <button type="button" class="rbtn sfx-settings" onclick={() => onSettings('typesetting')}>Open settings</button>
    {/if}
  </div>
{:else}
  <div class="grp sfx-preview">
    <div class="sfx-head">
      <span class="lbl">SFX · {label}</span>
      {#if on}
        <button type="button" class="sfx-remove" onclick={remove}>Remove SFX</button>
      {/if}
    </div>
    <div class="sfx-stage" role="img" aria-label="Preview of the box's text with its SFX" bind:clientWidth={stageW}>
      <canvas bind:this={stageEl}></canvas>
    </div>
  </div>

  <!-- ===== Type ===== -->
  <div class="grp">
    <div class="sfx-row-head">
      <span class="lbl">Type</span>
      <div class="sfx-acts">
        <button type="button" class="add-btn" disabled={!top.length} title="The type that fits this sound best" onclick={autoPick}>Auto pick</button>
        {#if on}
          <button type="button" class="add-btn" title="Another random shape of this type" onclick={newShape}>New shape</button>
        {/if}
      </div>
    </div>
    <div class="sfx-grid" role="radiogroup" aria-label="Sound type">
      {#each kinds as k (k.id)}
        {@const rank = rankOf(k.id)}
        <button
          type="button"
          role="radio"
          aria-checked={on && sfx.kind === k.id}
          class="sfx-card"
          class:on={on && sfx.kind === k.id}
          class:top={rank >= 0}
          data-kind={k.id}
          data-rank={rank >= 0 ? rank + 1 : null}
          title={rank >= 0 ? `${k.name} · auto pick ${rank + 1}` : k.name}
          onclick={() => chooseKind(k.id)}
        >
          <span class="sfx-tile" style={urlOf(typeCard(k.id))}></span>
          <span class="sfx-name">{k.name}</span>
          {#if rank >= 0}
            <span class="sfx-rank" aria-hidden="true">{rank + 1}</span>
          {/if}
        </button>
      {/each}
    </div>
  </div>

  {#if on}
    <!-- ===== Variations ===== -->
    <div class="grp">
      <span class="lbl">Variations</span>
      <div class="sfx-grid four" role="radiogroup" aria-label="Variations">
        {#each SEEDS as n (n)}
          <button
            type="button"
            role="radio"
            aria-checked={sfx.seed === n}
            aria-label="Variation {n}"
            class="sfx-card"
            class:on={sfx.seed === n}
            title="Shape {n}"
            onclick={() => setSeed(n)}
          >
            <span class="sfx-tile" style={urlOf(seedCard(n))}></span>
          </button>
        {/each}
      </div>
    </div>

    {@render slider('Strength', sfx.strength, 0, 2, 0.05, (v) => set('strength', v), fix(sfx.strength))}

    <!-- ===== Layout ===== -->
    <div class="insp-sub" class:closed={!openLayout}>
      {@render sectionHead('Layout', openLayout, () => (openLayout = !openLayout))}
      {#if openLayout}
        <div class="insp-sub-body">
          <div class="grp">
            <div class="sfx-row-head">
              <span class="lbl">Direction</span>
              {#if sfx.dir != null}
                <button type="button" class="sfx-back" title="Back to the type's" aria-label="Direction: back to the type's" onclick={() => set('dir', null)}>Type's</button>
              {/if}
            </div>
            <div class="seg">
              <button type="button" class:on={!R.vertical} aria-pressed={!R.vertical} onclick={() => set('dir', 'h')}>Across</button>
              <button type="button" class:on={R.vertical} aria-pressed={R.vertical} onclick={() => set('dir', 'v')}>Down</button>
            </div>
          </div>
          {@render toggle('Join ー into one bar', sfx.joinBars !== false, (v) => set('joinBars', v))}
          {@render toggle('Shape kerning', sfx.kern !== false, (v) => set('kern', v))}
          {@render slider('Size at start', R.flow.from, 0.2, 3, 0.05, (v) => setPart('flow', 'from', v), `${fix(R.flow.from)}×`, sfx.flow != null, () => set('flow', null))}
          {@render slider('Size at end', R.flow.to, 0.2, 3, 0.05, (v) => setPart('flow', 'to', v), `${fix(R.flow.to)}×`, sfx.flow != null, () => set('flow', null))}
          {@render slider('Follow the line', R.follow, 0, 1, 0.01, (v) => set('follow', v), `${pct(R.follow)}%`, sfx.follow != null, () => set('follow', null))}
          {@render slider('Gap', R.gap, -0.5, 1, 0.01, (v) => set('gap', v), `${fix(R.gap)} em`, sfx.gap != null, () => set('gap', null))}
          {@render slider('Big letters tighter', R.bigTighter, 0, 1, 0.01, (v) => set('bigTighter', v), `${pct(R.bigTighter)}%`, sfx.bigTighter != null, () => set('bigTighter', null))}
          {@render slider('Slant', R.slant, -45, 45, 1, (v) => set('slant', v), `${Math.round(R.slant)}°`, sfx.slant != null, () => set('slant', null))}
          {@render slider('Rise', R.rise, -30, 30, 1, (v) => set('rise', v), `${Math.round(R.rise)}°`, sfx.rise != null, () => set('rise', null))}
          {@render slider('Jitter turn', R.jitter.rot, 0, 45, 1, (v) => setPart('jitter', 'rot', v), `${Math.round(R.jitter.rot)}°`, sfx.jitter != null, () => set('jitter', null))}
          {@render slider('Jitter size', R.jitter.size, 0, 1, 0.01, (v) => setPart('jitter', 'size', v), `${pct(R.jitter.size)}%`, sfx.jitter != null, () => set('jitter', null))}
          {@render slider('Jitter offset', R.jitter.off, 0, 1, 0.01, (v) => setPart('jitter', 'off', v), `${pct(R.jitter.off)}%`, sfx.jitter != null, () => set('jitter', null))}
          <div class="sfx-acts wrap">
            <button type="button" class="add-btn" disabled={!layoutSet} onclick={resetLayout}>Back to type</button>
            <button type="button" class="add-btn" disabled={!hasPaths} title="Lines run where the type puts them" onclick={resetPaths}>Reset paths</button>
            <button type="button" class="add-btn" disabled={!hasGlyphs} title="Letters moved, turned or sized by hand go back" onclick={resetGlyphs}>Reset letter edits</button>
          </div>
        </div>
      {/if}
    </div>

    <!-- ===== Effects ===== -->
    <div class="insp-sub" class:closed={!openFx}>
      {@render sectionHead('Effects', openFx, () => (openFx = !openFx))}
      {#if openFx}
        {@const st = box.style}
        <div class="insp-sub-body">
          {@render toggle('Negative', st.negative.on, (v) => setFx(st.negative, 'on', v))}
          {#if st.negative.on}
            {@render slider('Grow', st.negative.grow, 0, 1, 0.01, (v) => setFx(st.negative, 'grow', v), `${fix(st.negative.grow)} em`)}
            {@render colour(st.negative, 'color', 'Negative colour')}
          {/if}

          {@render toggle('Extrude', st.extrude.on, (v) => setFx(st.extrude, 'on', v))}
          {#if st.extrude.on}
            {@render slider('Angle', wrapDeg(st.extrude.angle), 0, 359, 1, (v) => setFx(st.extrude, 'angle', v), `${wrapDeg(st.extrude.angle)}°`)}
            {@render slider('Depth', st.extrude.length, 0, 2, 0.01, (v) => setFx(st.extrude, 'length', v), `${fix(st.extrude.length)} em`)}
            {@render colour(st.extrude, 'color', 'Extrude colour')}
            {@render toggle('Edge line', !!st.extrude.edge, (v) => setFx(st.extrude, 'edge', v ? '#ffffff' : ''))}
            {#if st.extrude.edge}
              {@render colour(st.extrude, 'edge', 'Edge colour')}
            {/if}
          {/if}

          {@render toggle('Shake', st.shake.on, (v) => setFx(st.shake, 'on', v))}
          {#if st.shake.on}
            {@render slider('Copies', st.shake.count, 1, 4, 1, (v) => setFx(st.shake, 'count', v), String(st.shake.count))}
            {@render slider('Spread', st.shake.amp, 0, 0.5, 0.01, (v) => setFx(st.shake, 'amp', v), `${fix(st.shake.amp)} em`)}
            {@render slider('Shake angle', wrapDeg(st.shake.angle), 0, 359, 1, (v) => setFx(st.shake, 'angle', v), `${wrapDeg(st.shake.angle)}°`)}
          {/if}

          {@render toggle('Trail', st.trail.on, (v) => setFx(st.trail, 'on', v))}
          {#if st.trail.on}
            {@render slider('Trail copies', st.trail.count, 1, 6, 1, (v) => setFx(st.trail, 'count', v), String(st.trail.count))}
            {@render slider('Trail length', st.trail.dist, 0, 2, 0.01, (v) => setFx(st.trail, 'dist', v), `${fix(st.trail.dist)} em`)}
          {/if}

          <div class="grp">
            <span class="lbl">Outlines</span>
            <div class="seg">
              <button type="button" class:on={st.strokeOrder !== 'each'} aria-pressed={st.strokeOrder !== 'each'} title="One outline round the whole sound" onclick={() => setStyle('strokeOrder', 'merged')}>Merged</button>
              <button type="button" class:on={st.strokeOrder === 'each'} aria-pressed={st.strokeOrder === 'each'} title="Each letter outlined over the one before" onclick={() => setStyle('strokeOrder', 'each')}>Each letter</button>
            </div>
          </div>
          <div class="grp">
            <span class="lbl">Corners</span>
            <div class="seg">
              <button type="button" class:on={st.strokeJoin !== 'miter'} aria-pressed={st.strokeJoin !== 'miter'} onclick={() => setStyle('strokeJoin', 'round')}>Round</button>
              <button type="button" class:on={st.strokeJoin === 'miter'} aria-pressed={st.strokeJoin === 'miter'} onclick={() => setStyle('strokeJoin', 'miter')}>Sharp</button>
            </div>
          </div>
          {@render slider('Shade', st.strokeShade, 0, 1, 0.01, (v) => setStyle('strokeShade', v), `${pct(st.strokeShade)}%`)}
        </div>
      {/if}
    </div>

    <!-- ===== Caption ===== -->
    <div class="grp">
      <span class="lbl">Caption</span>
      <div class="sfx-caption">
        <input
          type="text"
          class="hex"
          value={sfx.caption.text}
          placeholder="What the sound means"
          aria-label="Caption text"
          oninput={(e) => setCaption('text', e.target.value)}
        />
        <button type="button" class="add-btn" disabled={!meaning} title={meaning ? `Use "${meaning}"` : 'No meaning known for this line'} onclick={fillMeaning}>Fill from meaning</button>
      </div>
    </div>
    {#if sfx.caption.text}
      <div class="grp">
        <span class="lbl">Caption side</span>
        <div class="seg">
          {#each SIDES as [side, name] (side)}
            <button type="button" class:on={sfx.caption.side === side} aria-pressed={sfx.caption.side === side} onclick={() => setCaption('side', side)}>{name}</button>
          {/each}
        </div>
      </div>
      {@render slider('Caption size', sfx.caption.size, 0.1, 1, 0.05, (v) => setCaption('size', v), `${pct(sfx.caption.size)}%`)}
      {@render colour(box.style.sfx.caption, 'color', 'Caption colour')}
    {/if}
  {/if}
{/if}

<style>
  /* The preview stays under the Inspector's tab strip (54px of it shows while
     the panel is scrolled) so a card can be picked while watching it. Opaque
     ground, as the strip has, so cards do not show through. */
  .sfx-preview {
    position: sticky;
    top: 54px;
    z-index: 1;
    margin: 0 -12px;
    padding: 4px 12px 8px;
    background: var(--panel);
  }
  .sfx-head,
  .sfx-row-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 22px;
    min-width: 0;
  }
  .sfx-head .lbl {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sfx-acts {
    display: flex;
    gap: 6px;
  }
  .sfx-acts.wrap {
    flex-wrap: wrap;
  }
  .sfx-remove,
  .sfx-back {
    flex: 0 0 auto;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--line2);
    border-radius: 5px;
    background: var(--surface);
    color: var(--t2);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .sfx-back {
    height: 18px;
    padding: 0 6px;
    font-size: 10px;
  }
  .sfx-back:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .sfx-remove:hover {
    color: var(--warn);
    border-color: var(--warn);
  }
  .sfx-remove:focus-visible,
  .sfx-back:focus-visible,
  .sfx-card:focus-visible,
  .sfx-settings:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .sfx-settings {
    align-self: flex-start;
    height: 28px;
    padding: 0 12px;
  }

  /* The stage is always paper, in both themes: the lettering is drawn to be
     read on a page. */
  .sfx-stage {
    height: 110px;
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 7px;
    overflow: hidden;
  }
  .sfx-stage canvas {
    display: block;
    width: 100%;
    height: 100%;
  }

  /* The cards are the pattern cards (Inspector.svelte `.pat-card`), mirrored
     because a component's styles are its own. */
  .sfx-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }
  .sfx-grid.four {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .sfx-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 4px 5px;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: var(--surface);
    color: var(--t2);
    font-family: inherit;
    cursor: pointer;
    min-width: 0;
  }
  .four .sfx-card {
    padding: 3px;
  }
  .sfx-card:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .sfx-card.on {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
    color: var(--text);
  }
  .sfx-tile {
    height: 44px;
    border-radius: 4px;
    background-color: var(--paper);
    background-repeat: no-repeat;
    background-position: center;
    background-size: contain;
    border: 1px solid var(--line);
  }
  .four .sfx-tile {
    height: 34px;
  }
  .sfx-name {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The auto pick's first three, numbered in the tile's corner. */
  .sfx-rank {
    position: absolute;
    top: 2px;
    right: 2px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 7px;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 9px;
    font-weight: 600;
    line-height: 14px;
    text-align: center;
  }
  .sfx-colour {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .sfx-caption {
    display: flex;
    gap: 6px;
    min-width: 0;
  }
  .sfx-caption input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .sfx-caption .add-btn {
    flex: 0 0 auto;
  }
</style>
