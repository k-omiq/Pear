<script>
  // The Inspector's SFX pane: the sound type a box is lettered as, and every
  // number of it.
  //
  // It is the Effects tab's first sub-tab, top to bottom:
  //
  //   stage        the box's own text as the engine paints it
  //   type         twelve cards, the box's text and look laid out as each
  //                sound type; the auto pick's first three marked; Auto pick
  //                and New shape
  //   variations   eight seeds of the type
  //   intensity    Power, Roughness, Momentum (0..100, 50 the type as
  //                designed)
  //   layout       every layout number, in the reference app's units (docs/
  //                giongo/04-reference-controls.md section 0); closed
  //   effects      the SFX paint effects; closed
  //   caption      the small note beside the sound
  //   Remove SFX
  //
  // A type card writes the engine's sound type to `style.sfx` (data.js):
  // `applySfxKind` resets the layout, the dials, the paths and the letters'
  // hand edits, and never the look (font, fill, outlines). A layout number the
  // box leaves null is the type's: its slider shows the resolved number
  // (`sfxResolved`) until it is moved, and Reset gives the type's back.
  //
  // Every write is followed by the Inspector's `touch`, handed in as a prop,
  // so an edit is one more `style` entry in the same undo flow. The
  // Inspector's capture-phase pointerdown/keydown (`armSnap`) takes the
  // before-snapshot, and this component is rendered inside the element it is
  // set on, so nothing here arms it - except a colour picked in a popover,
  // which lives outside that element: `arm` is the Inspector's `armSnap`.
  //
  // Under the browser engine there is no SFX layout (`sfxAvailable`), so the
  // pane is one sentence and, when the host can open Settings, a button.
  //
  // SPEED. The box on the page follows every frame of a drag; the pane's
  // pictures need not. While a gesture is live (`sfxLive`: a slider of this
  // pane held, or the canvas's SFX handles dragged) neither the stage nor any
  // card is painted, or even keyed; each paints once when it ends. A slider
  // writes at most once a frame. The stage is painted at the pixels it shows.
  // The cards are painted three a frame by one pump that always paints the
  // latest look and waits out a run of changes (a colour dragged), and a card
  // keeps its last picture until its new one is in; their keys hold neither
  // the letters moved by hand nor the paths, so a drag on the page repaints no
  // card at all.
  import { onDestroy, untrack } from 'svelte';
  import { app, boxText, lineByN } from './store.svelte.js';
  import { engineSwitch } from './engine-switch.svelte.js';
  import { settleNoise } from './exporter.js';
  import ColorPicker from './ColorPicker.svelte';
  import { sfxAvailable, sfxKinds, sfxKind, sfxPick, sfxPickText, sfxResolved, applySfxKind, clearSfx } from './sfx.js';
  import { sfxLive } from './sfx-live.svelte.js';
  import { cardSpec, cardKeys, cachedCard, keepCard, paintCard, paintStage, previewDpr } from './sfx-preview.js';

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
  const DIALS = [
    ['power', 'Power', 'How big the sound is: the swell from first letter to last'],
    ['rough', 'Roughness', 'How ragged it is: letters turned and sized at random'],
    ['momentum', 'Momentum', 'How fast it moves: lean, slant and rise'],
  ];
  const MID = 50;
  // A dial let go this near the middle lands on it.
  const DETENT = 3;

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
  // The numbers the layout uses: the box's where it set them, else the type's
  // moved by the dials (the engine's `sfxResolve`). Asked of the layout
  // fields alone, so a letter dragged or a path end moved on the page (which
  // write `glyphs` and `paths` every frame) does not ask it again.
  const PLAIN_R = { vertical: false, flow: { from: 1, to: 1, pow: 1 }, follow: 0.5, gap: 0, bigTighter: 0.5, slant: 0, rise: 0, jitter: { rot: 0, size: 0, off: 0 } };
  const LAYOUT_FIELDS = ['kind', 'seed', 'power', 'rough', 'momentum', 'dir', 'joinBars', 'kern', 'flow', 'follow', 'gap', 'bigTighter', 'slant', 'rise', 'jitter'];
  function resolve(s) {
    if (!s) return PLAIN_R;
    const of = { paths: [], glyphs: {} };
    for (const k of LAYOUT_FIELDS) of[k] = s[k];
    return sfxResolved(of) ?? PLAIN_R;
  }
  const R = $derived(resolve(sfx));

  const text = $derived(boxText(box, pg));
  // The Japanese the box's line was read from, if any: auto pick reads it
  // first, and the caption's meaning is looked up from it.
  const jp = $derived(box.lineN != null ? (lineByN(pg, box.lineN)?.jp ?? '') : '');
  const pick = $derived(available ? sfxPick(sfxPickText(text, jp)) : null);
  const top = $derived((pick?.order ?? []).filter((id) => sfxKind(id)).slice(0, 3));
  const rankOf = (id) => top.indexOf(id);

  const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---- writes ----
  function chooseKind(id) {
    if (applySfxKind(box.style, id)) touch();
  }
  // The auto pick's first type, and its three dials read from the sound.
  function autoPick() {
    if (!top.length || !applySfxKind(box.style, top[0])) return;
    for (const [d] of DIALS) {
      const v = Number(pick?.[d]);
      if (Number.isFinite(v)) box.style.sfx[d] = clamp(Math.round(v), 0, 100);
    }
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
  // The layout numbers back to the type's.
  const LAYOUT_KEYS = ['dir', 'flow', 'follow', 'gap', 'bigTighter', 'slant', 'rise', 'jitter'];
  const layoutSet = $derived(LAYOUT_KEYS.some((k) => sfx?.[k] != null) || sfx?.joinBars === false || sfx?.kern === false);
  function resetLayout() {
    for (const k of LAYOUT_KEYS) box.style.sfx[k] = null;
    box.style.sfx.joinBars = true;
    box.style.sfx.kern = true;
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

  function setStyle(key, v) {
    box.style[key] = v;
    touch();
  }
  function setFx(obj, key, v) {
    obj[key] = v;
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

  // ---- sliders: held, and written once a frame ----
  //
  // A slider's input is written once a frame (the last value of the frame),
  // and at once when it is let go (`change`). While one is held the gesture is
  // live (`sfxLive`), so the stage and the cards wait for the release.
  const frame = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
  const unframe = (h) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(h) : clearTimeout(h));

  const pending = new Map();
  let writeRaf = 0;
  function flushWrites() {
    if (writeRaf) unframe(writeRaf);
    writeRaf = 0;
    if (!pending.size) return;
    const writes = [...pending.values()];
    pending.clear();
    for (const w of writes) w();
    touch();
  }
  function queue(id, write) {
    pending.set(id, write);
    if (!writeRaf) writeRaf = frame(flushWrites);
  }
  function dropWrites() {
    pending.clear();
    if (writeRaf) unframe(writeRaf);
    writeRaf = 0;
  }
  // A box changed under a held slider: what was not written yet was for the
  // other box, and is dropped.
  $effect(() => {
    box;
    return dropWrites;
  });

  let holding = false;
  function hold() {
    if (holding) return;
    holding = true;
    sfxLive.on = true;
    window.addEventListener('pointerup', letGo, true);
    window.addEventListener('pointercancel', letGo, true);
    window.addEventListener('blur', letGo);
  }
  function letGo() {
    if (!holding) return;
    holding = false;
    window.removeEventListener('pointerup', letGo, true);
    window.removeEventListener('pointercancel', letGo, true);
    window.removeEventListener('blur', letGo);
    // The last value first, so the paint the release asks for is of it.
    flushWrites();
    sfxLive.on = false;
  }

  // One slider, `o`: { id, label, value, min, max, step, unit, write(v),
  // isSet, reset, resetName, detent, title }. `value` and what `write` takes
  // are in the units the slider shows.
  function slide(o, e) {
    let v = +e.target.value;
    if (!Number.isFinite(v)) return;
    if (o.detent != null && Math.abs(v - o.detent) <= DETENT) {
      v = o.detent;
      e.target.value = String(v);
    }
    queue(o.id, () => o.write(v));
  }
  function typed(o, e) {
    let v = e.target.value === '' ? NaN : +e.target.value;
    if (!Number.isFinite(v)) v = Number(o.value);
    v = clamp(v, o.min, o.max);
    e.target.value = String(v);
    pending.delete(o.id);
    o.write(v);
    touch();
  }
  const shown = (o) => {
    const n = Number(o.value);
    if (!Number.isFinite(n)) return '';
    const d = o.step < 0.1 ? 2 : o.step < 1 ? 1 : 0;
    return String(Math.round(n * 10 ** d) / 10 ** d);
  };

  // The layout fields in the slider's units (docs/giongo section 0), written
  // back in the engine's. A part of a two- or three-number field (`flow`,
  // `jitter`) writes the whole field, the other parts as they resolve now.
  function writePart(key, part, v) {
    const now = plain(resolve(box.style.sfx)[key]);
    box.style.sfx[key] = { ...now, [part]: v };
  }
  const pct = (v) => Math.round((Number(v) || 0) * 100);
  const deg = (v) => Math.round((Number(v) || 0) * 10) / 10;
  const wrapDeg = (v) => ((Math.round(v ?? 0) % 360) + 360) % 360;

  const back = (key) => () => set(key, null);
  const sizeSliders = $derived(
    !on
      ? []
      : [
          { id: 'from', label: 'Start size %', value: pct(R.flow.from), min: 30, max: 250, step: 1, unit: 'percent', write: (v) => writePart('flow', 'from', v / 100), isSet: sfx.flow != null, reset: back('flow'), title: 'The first letter, % of the type size' },
          { id: 'to', label: 'End size %', value: pct(R.flow.to), min: 30, max: 250, step: 1, unit: 'percent', write: (v) => writePart('flow', 'to', v / 100), isSet: sfx.flow != null, reset: back('flow'), title: 'The last letter, % of the type size' },
          { id: 'gap', label: 'Letter spacing %', value: pct(R.gap), min: -50, max: 120, step: 1, unit: 'percent', write: (v) => (box.style.sfx.gap = v / 100), isSet: sfx.gap != null, reset: back('gap'), title: 'Space between letters, % of a letter' },
          { id: 'bigTighter', label: 'Spacing by size', value: pct(R.bigTighter), min: 0, max: 100, step: 1, unit: 'amount', write: (v) => (box.style.sfx.bigTighter = v / 100), isSet: sfx.bigTighter != null, reset: back('bigTighter'), title: 'How much tighter big letters sit' },
        ],
  );
  const moveSliders = $derived(
    !on
      ? []
      : [
          { id: 'follow', label: 'Lean %', value: pct(R.follow), min: 0, max: 100, step: 1, unit: 'percent', write: (v) => (box.style.sfx.follow = v / 100), isSet: sfx.follow != null, reset: back('follow'), title: 'How far the letters turn with the line' },
          { id: 'slant', label: 'Slant', value: deg(R.slant), min: -40, max: 40, step: 1, unit: 'degrees', write: (v) => (box.style.sfx.slant = v), isSet: sfx.slant != null, reset: back('slant'), title: 'Every letter sheared by this, degrees' },
          { id: 'rise', label: 'Rise °', value: deg(R.rise), min: -10, max: 20, step: 1, unit: 'degrees', write: (v) => (box.style.sfx.rise = v), isSet: sfx.rise != null, reset: back('rise'), title: 'The line tilted up towards its end, degrees' },
          { id: 'jrot', label: 'Angle variation °', value: deg(R.jitter.rot), min: 0, max: 40, step: 1, unit: 'degrees', write: (v) => writePart('jitter', 'rot', v), isSet: sfx.jitter != null, reset: back('jitter'), title: 'Each letter turned at random, up to this' },
          { id: 'jsize', label: 'Size variation', value: pct(R.jitter.size), min: 0, max: 60, step: 1, unit: 'amount', write: (v) => writePart('jitter', 'size', v / 100), isSet: sfx.jitter != null, reset: back('jitter'), title: 'Each letter sized at random, up to this' },
          { id: 'joff', label: 'Up/down variation', value: pct(R.jitter.off), min: 0, max: 150, step: 1, unit: 'amount', write: (v) => writePart('jitter', 'off', v / 100), isSet: sfx.jitter != null, reset: back('jitter'), title: 'Each letter moved off the line at random, up to this' },
        ],
  );
  const dialSliders = $derived(
    !on
      ? []
      : DIALS.map(([key, name, title]) => {
          const v = Number.isFinite(sfx[key]) ? sfx[key] : MID;
          return {
            id: key,
            label: name,
            value: v,
            min: 0,
            max: 100,
            step: 1,
            unit: 'amount',
            detent: MID,
            write: (n) => (box.style.sfx[key] = n),
            isSet: v !== MID,
            reset: () => set(key, MID),
            resetName: 'as designed',
            title,
          };
        }),
  );

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
  // What the last paint said of the box's ink, for the next paint's scale.
  let stageHint = null;
  let hintFor = null;
  // A function, so the unit lane's compiler keeps the snapshot (it turns a
  // bare `const x = $state.snapshot(y)` into `const x = y`).
  const snapStyle = () => $state.snapshot(box.style);

  $effect(() => {
    // Nothing else is read while a gesture is live, so nothing it writes
    // wakes this; its end does, and the stage paints once.
    if (!available || !stageEl || sfxLive.on) return;
    const snap = { id: box.id, style: snapStyle(), text, w: box.w, h: box.h };
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
        const pw = Math.max(1, Math.round(cssW * dpr));
        const ph = Math.max(1, Math.round(STAGE_H * dpr));
        if (stageEl.width !== pw) stageEl.width = pw;
        if (stageEl.height !== ph) stageEl.height = ph;
        if (hintFor !== snap.id) stageHint = null;
        stageHint = paintStage(stageEl, snap, dpr, stageHint);
        hintFor = snap.id;
      });
    });
  });

  // ---- the cards ----
  const dpr = previewDpr();
  // The picture each card shows now, by slot: kept until its new one is in.
  let tiles = $state({});
  // Plain data, so that what the cards depend on is one value.
  const spec = $derived(cardSpec(box.style, text));
  const slots = $derived([
    ...kinds.map((k) => ({ id: `t:${k.id}`, kind: k.id })),
    ...(on ? SEEDS.map((n) => ({ id: `v:${n}`, kind: null, seed: n })) : []),
  ]);

  // The latest of what the cards are to show, and how often it has changed:
  // the pump reads it when it runs, so a change while it runs is not a
  // restart.
  let want = null;
  let wantSeq = 0;
  let seenSeq = 0;
  let pumpRaf = 0;
  $effect(() => {
    if (!available || sfxLive.on) return;
    const next = { spec, slots, seed: sfx?.seed ?? 1, fonts: app.fontsVersion };
    untrack(() => {
      want = next;
      wantSeq++;
      if (!pumpRaf) {
        // Idle: the first change is painted on the next frame.
        seenSeq = wantSeq;
        pumpRaf = frame(pump);
      }
    });
  });

  function pump() {
    pumpRaf = 0;
    if (!want || sfxLive.on) return;
    // Changed since the last frame, so still changing (a colour dragged):
    // the cards wait for it to settle.
    if (seenSeq !== wantSeq) {
      seenSeq = wantSeq;
      pumpRaf = frame(pump);
      return;
    }
    const { spec: sp, slots: list, seed, fonts } = want;
    const cards = list.map((s) => (s.kind ? { kind: s.kind, seed } : { kind: null, seed: s.seed }));
    const keys = cardKeys(sp, cards, fonts, dpr);
    let painted = 0;
    let more = false;
    let changed = false;
    const next = {};
    for (let i = 0; i < list.length; i++) {
      let url = cachedCard(keys[i]);
      if (url === undefined) {
        if (painted >= BATCH) {
          more = true;
          continue;
        }
        // A card that could not be painted is kept as empty, not retried on
        // every change: the next change of font or text is a new key.
        url = paintCard(sp, cards[i], dpr) ?? '';
        keepCard(keys[i], url);
        painted++;
      }
      next[list[i].id] = url;
      if (tiles[list[i].id] !== url) changed = true;
    }
    if (changed) tiles = { ...tiles, ...next };
    if (more) pumpRaf = frame(pump);
  }
  const tileStyle = (id) => (tiles[id] ? `background-image:url(${tiles[id]})` : '');

  onDestroy(() => {
    stageSeq++;
    unframe(stageRaf);
    unframe(pumpRaf);
    pumpRaf = 0;
    want = null;
    dropWrites();
    letGo();
  });

  const SIDES = [
    ['below', 'Below'],
    ['above', 'Above'],
    ['left', 'Left'],
    ['right', 'Right'],
  ];
</script>

<!-- A slider and its typed number, as the Inspector lays one out. Reset shows
     while the box holds its own value (the slider otherwise shows the type's). -->
{#snippet slider(o)}
  <div class="grp">
    <div class="sfx-row-head">
      <span class="lbl" title={o.title}>{o.label}</span>
      {#if o.reset && o.isSet}
        <button
          type="button"
          class="sfx-back"
          title={o.resetName === 'as designed' ? 'Back to the type as designed' : "Back to the type's value"}
          aria-label="{o.label}: {o.resetName ?? 'back to the type'}"
          onclick={o.reset}>Reset</button
        >
      {/if}
    </div>
    <div class="slider-row">
      <span class="sfx-track" class:mid={o.detent != null}>
        <input
          type="range"
          min={o.min}
          max={o.max}
          step={o.step}
          value={o.value}
          aria-label={o.label}
          onpointerdown={hold}
          oninput={(e) => slide(o, e)}
          onchange={flushWrites}
          onblur={letGo}
        />
      </span>
      <input class="num-s" type="number" min={o.min} max={o.max} step={o.step} value={shown(o)} title={o.title} aria-label="{o.label}, {o.unit}" onchange={(e) => typed(o, e)} />
    </div>
  </div>
{/snippet}

{#snippet toggle(lbl, value, onset, title = undefined)}
  <div class="switch-row" {title}>
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
  <!-- ===== Stage ===== -->
  <div class="grp sfx-preview">
    <div class="sfx-head">
      <span class="lbl">SFX · {label}</span>
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
        <button type="button" class="rbtn" disabled={!top.length} title="The type that fits this sound best, with its intensity" onclick={autoPick}>Auto pick</button>
        <button type="button" class="rbtn" disabled={!on} title="Another random shape of this type" onclick={newShape}>New shape</button>
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
          data-kind={k.id}
          data-rank={rank >= 0 ? rank + 1 : null}
          title={rank >= 0 ? `${k.name} · auto pick ${rank + 1}` : k.name}
          onclick={() => chooseKind(k.id)}
        >
          <span class="sfx-tile" style={tileStyle(`t:${k.id}`)}></span>
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
            <span class="sfx-tile" style={tileStyle(`v:${n}`)}></span>
          </button>
        {/each}
      </div>
    </div>

    <!-- ===== Intensity ===== -->
    <div class="insp-rule"></div>
    <div class="grp sfx-dials" role="group" aria-label="Intensity">
      <span class="lbl">Intensity</span>
      {#each dialSliders as o (o.id)}
        {@render slider(o)}
      {/each}
    </div>

    <!-- ===== Layout ===== -->
    <div class="insp-sub" class:closed={!openLayout}>
      {@render sectionHead('Layout', openLayout, () => (openLayout = !openLayout))}
      {#if openLayout}
        <div class="insp-sub-body">
          <div class="grp">
            <div class="sfx-row-head">
              <span class="lbl">Direction</span>
              {#if sfx.dir != null}
                <button type="button" class="sfx-back" title="Back to the type's value" aria-label="Direction: back to the type" onclick={back('dir')}>Reset</button>
              {/if}
            </div>
            <div class="seg">
              <button type="button" class:on={!R.vertical} aria-pressed={!R.vertical} onclick={() => set('dir', 'h')}>Horizontal</button>
              <button type="button" class:on={R.vertical} aria-pressed={R.vertical} onclick={() => set('dir', 'v')}>Vertical</button>
            </div>
          </div>
          {@render toggle('Join ー', sfx.joinBars !== false, (v) => set('joinBars', v), 'A run of long marks drawn as one bar')}
          {#each sizeSliders as o (o.id)}
            {@render slider(o)}
          {/each}
          {@render toggle('Optical spacing', sfx.kern !== false, (v) => set('kern', v), 'Letters spaced by their shapes, not their boxes')}
          {#each moveSliders as o (o.id)}
            {@render slider(o)}
          {/each}
          <div class="sfx-acts wrap">
            <button type="button" class="rbtn" disabled={!layoutSet} title="Every number above back to the type's" onclick={resetLayout}>Back to type</button>
            <button type="button" class="rbtn" disabled={!hasPaths} title="The lines run where the type puts them" onclick={resetPaths}>Reset path</button>
            <button type="button" class="rbtn" disabled={!hasGlyphs} title="Letters moved, turned or sized by hand go back" onclick={resetGlyphs}>Reset letter edits</button>
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
            {@render slider({ id: 'neg-grow', label: 'Grow', value: st.negative.grow, min: 0, max: 1, step: 0.01, unit: 'ems', title: 'How far the ground reaches past the letters, ems', write: (v) => (st.negative.grow = v) })}
            {@render colour(st.negative, 'color', 'Negative colour')}
          {/if}

          {@render toggle('Extrude', st.extrude.on, (v) => setFx(st.extrude, 'on', v))}
          {#if st.extrude.on}
            {@render slider({ id: 'ex-angle', label: 'Angle', value: wrapDeg(st.extrude.angle), min: 0, max: 359, step: 1, unit: 'degrees', write: (v) => (st.extrude.angle = v) })}
            {@render slider({ id: 'ex-depth', label: 'Depth', value: st.extrude.length, min: 0, max: 2, step: 0.01, unit: 'ems', title: 'Depth, ems', write: (v) => (st.extrude.length = v) })}
            {@render colour(st.extrude, 'color', 'Extrude colour')}
            {@render toggle('Edge line', !!st.extrude.edge, (v) => setFx(st.extrude, 'edge', v ? '#ffffff' : ''))}
            {#if st.extrude.edge}
              {@render colour(st.extrude, 'edge', 'Edge colour')}
            {/if}
          {/if}

          {@render toggle('Shake', st.shake.on, (v) => setFx(st.shake, 'on', v))}
          {#if st.shake.on}
            {@render slider({ id: 'sh-count', label: 'Copies', value: st.shake.count, min: 1, max: 4, step: 1, unit: 'count', write: (v) => (st.shake.count = v) })}
            {@render slider({ id: 'sh-amp', label: 'Spread', value: st.shake.amp, min: 0, max: 0.5, step: 0.01, unit: 'ems', title: 'Spread, ems', write: (v) => (st.shake.amp = v) })}
            {@render slider({ id: 'sh-angle', label: 'Shake angle', value: wrapDeg(st.shake.angle), min: 0, max: 359, step: 1, unit: 'degrees', write: (v) => (st.shake.angle = v) })}
          {/if}

          {@render toggle('Trail', st.trail.on, (v) => setFx(st.trail, 'on', v))}
          {#if st.trail.on}
            {@render slider({ id: 'tr-count', label: 'Trail copies', value: st.trail.count, min: 1, max: 6, step: 1, unit: 'count', write: (v) => (st.trail.count = v) })}
            {@render slider({ id: 'tr-dist', label: 'Trail length', value: st.trail.dist, min: 0, max: 2, step: 0.01, unit: 'ems', title: 'Trail length, ems', write: (v) => (st.trail.dist = v) })}
          {/if}

          <div class="insp-rule"></div>
          <div class="grp">
            <span class="lbl">Outline order</span>
            <div class="seg">
              <button type="button" class:on={st.strokeOrder !== 'each'} aria-pressed={st.strokeOrder !== 'each'} title="One outline round the whole sound" onclick={() => setStyle('strokeOrder', 'merged')}>Merged</button>
              <button type="button" class:on={st.strokeOrder === 'each'} aria-pressed={st.strokeOrder === 'each'} title="Each letter outlined over the one before" onclick={() => setStyle('strokeOrder', 'each')}>Letter by letter</button>
            </div>
          </div>
          <div class="grp">
            <span class="lbl">Corners</span>
            <div class="seg">
              <button type="button" class:on={st.strokeJoin !== 'miter'} aria-pressed={st.strokeJoin !== 'miter'} onclick={() => setStyle('strokeJoin', 'round')}>Round</button>
              <button type="button" class:on={st.strokeJoin === 'miter'} aria-pressed={st.strokeJoin === 'miter'} onclick={() => setStyle('strokeJoin', 'miter')}>Sharp</button>
            </div>
          </div>
          {@render slider({ id: 'shade', label: 'Shade %', value: pct(st.strokeShade), min: 0, max: 100, step: 1, unit: 'percent', title: 'The outlines darkened on the side away from the light', write: (v) => (st.strokeShade = v / 100) })}
        </div>
      {/if}
    </div>

    <!-- ===== Caption ===== -->
    <div class="grp">
      <span class="lbl">Caption</span>
      <div class="sfx-caption">
        <input
          type="text"
          value={sfx.caption.text}
          placeholder="What the sound means"
          aria-label="Caption text"
          oninput={(e) => setCaption('text', e.target.value)}
        />
        <button type="button" class="rbtn" disabled={!meaning} title={meaning ? `Use "${meaning}"` : 'No meaning known for this line'} onclick={fillMeaning}>Fill from meaning</button>
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
      {@render slider({ id: 'cap-size', label: 'Caption size %', value: pct(sfx.caption.size), min: 10, max: 100, step: 5, unit: 'percent', title: 'The caption, % of the type size', write: (v) => (box.style.sfx.caption.size = v / 100) })}
      {@render colour(box.style.sfx.caption, 'color', 'Caption colour')}
    {/if}

    <!-- ===== Remove ===== -->
    <div class="insp-rule"></div>
    <button type="button" class="sfx-remove" title="Back to plain text; the arc, ring or path the box had comes back" onclick={remove}>Remove SFX</button>
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
  .sfx-head .lbl,
  .sfx-row-head .lbl {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sfx-acts {
    display: flex;
    gap: 6px;
    flex: 0 0 auto;
  }
  .sfx-acts.wrap {
    flex-wrap: wrap;
    padding-top: 2px;
  }
  .sfx-dials {
    gap: 8px;
  }
  /* "Back to the type", once per row: quiet until it is wanted. */
  .sfx-back {
    flex: 0 0 auto;
    height: 18px;
    padding: 0 6px;
    border: 1px solid var(--line2);
    border-radius: 5px;
    background: transparent;
    color: var(--t2);
    font-family: inherit;
    font-size: 10.5px;
    cursor: pointer;
  }
  .sfx-back:hover {
    color: var(--text);
    border-color: var(--t3);
    background: var(--accent-soft);
  }
  .sfx-back:focus-visible,
  .sfx-card:focus-visible,
  .sfx-remove:focus-visible,
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
    transition: border-color 0.12s;
  }
  .four .sfx-card {
    padding: 3px;
  }
  .sfx-card:hover {
    border-color: var(--t3);
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
    font-size: 11px;
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
    font-variant-numeric: tabular-nums;
  }

  /* A slider's track, and the dials' middle: a hairline tick under it, where
     the type is as designed. */
  .sfx-track {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
  }
  .sfx-track input {
    width: 100%;
    margin: 0;
  }
  .sfx-track.mid::after {
    content: '';
    position: absolute;
    left: 50%;
    top: calc(50% + 5px);
    width: 1px;
    height: 4px;
    background: var(--t3);
    pointer-events: none;
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
  .sfx-caption .rbtn {
    height: 28px;
  }

  /* Destructive, so rust, and outlined rather than filled. */
  .sfx-remove {
    height: 28px;
    width: 100%;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: transparent;
    color: var(--warn);
    font-family: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .sfx-remove:hover {
    border-color: var(--warn);
    background: color-mix(in srgb, var(--warn) 12%, transparent);
  }
</style>
