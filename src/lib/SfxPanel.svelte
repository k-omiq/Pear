<script>
  // The SFX pane: the sound a box is lettered as, and every number of it. It
  // is the SFX tab of the Text box options (Inspector.svelte), top to bottom:
  //
  //   stage        the box's own text as the engine paints it, pinned
  //   sound        the words the box says (the Inspector's Content, here too)
  //   tabs         Type     a card per type, the box's text and look laid out as
  //                         each sound type; Auto pick; the shape (the seed);
  //                         Power, Roughness, Momentum (0..100, 50 the type as
  //                         designed); Remove SFX
  //                Layout   every layout number, in the reference app's units
  //                         (docs/giongo/04-reference-controls.md section 0)
  //                Effects  the SFX paint effects
  //                Caption  the small note beside the sound
  //   A box that is not SFX yet shows the stage, the sound and the cards.
  //
  // A type card writes the engine's sound type to `style.sfx` (sfx.js):
  // `applySfxKind` resets the layout, the dials, the paths and the letters'
  // hand edits, and never the look (font, fill, outlines). A layout number the
  // box leaves null is the type's: its slider shows the resolved number
  // (`sfxResolved`) until it is moved, and Reset gives the type's back.
  //
  // Every write is followed by the host's `touch`, handed in as a prop, so an
  // edit is one more entry in the same undo flow (edit-burst.js), and the store
  // sizes the box round its letters (`autoFitBox`). The host's capture-phase
  // pointerdown/keydown (`arm`) takes the before-snapshot, and this component
  // is rendered inside the element it is set on, so nothing here arms it -
  // except a colour picked in a popover, which lives outside that element and
  // calls `arm` itself.
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
  // keeps its last picture until its new one is in. A type card's key holds
  // neither the letters moved by hand nor the paths, so a drag on the page
  // repaints no type card.
  import { onDestroy, untrack } from 'svelte';
  import { app, boxText, lineByN, setBoxText } from './store.svelte.js';
  import { engineSwitch } from './engine-switch.svelte.js';
  import { settleNoise } from './exporter.js';
  import ColorPicker from './ColorPicker.svelte';
  import { sfxAvailable, sfxKinds, sfxKind, sfxPick, sfxPickText, sfxResolved, applySfxKind, clearSfx, startSfx, clearSfxKind } from './sfx.js';
  import { sfxLive } from './sfx-live.svelte.js';
  import { cardSpec, cardKeys, cachedCard, keepCard, paintCard, paintStage, previewDpr } from './sfx-preview.js';

  /**
   * `box` is the selected box; `pg` its page; `touch` the Inspector's; `arm` its
   * `armSnap`, for a write that comes from outside the panel's element;
   * `onSettings` opens Settings, when it can.
   */
  let { box, pg, touch, onSettings = null, arm = () => {} } = $props();

  const BATCH = 3;
  const SEED_MAX = 9999;
  // CSS px; the stage's height in the style block says the same.
  const STAGE_H = 120;
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
  const best = $derived((pick?.order ?? []).find((id) => sfxKind(id)) ?? null);

  const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---- writes ----
  function chooseKind(id) {
    if (applySfxKind(box.style, id, box)) touch();
  }
  // SFX with no type: every letter control, the letters in a plain row.
  function makeSfx() {
    if (startSfx(box.style, box)) touch();
  }
  function noKind() {
    if (clearSfxKind(box.style)) touch();
  }
  // The auto pick's first type, and its three dials read from the sound.
  function autoPick() {
    if (!best || !applySfxKind(box.style, best, box)) return;
    for (const [d] of DIALS) {
      const v = Number(pick?.[d]);
      if (Number.isFinite(v)) box.style.sfx[d] = clamp(Math.round(v), 0, 100);
    }
    touch();
  }
  function newShape() {
    let seed = sfx.seed;
    while (seed === sfx.seed) seed = 1 + Math.floor(Math.random() * SEED_MAX);
    box.style.sfx.seed = seed;
    touch();
  }
  // The next or the last shape, round from the end to the start.
  function stepShape(d) {
    box.style.sfx.seed = ((sfx.seed - 1 + d + SEED_MAX) % SEED_MAX) + 1;
    touch();
  }
  // The seed only moves the letters the type turns, sizes or lifts at random.
  const shapes = $derived(on && (R.jitter.rot > 0 || R.jitter.size > 0 || R.jitter.off > 0));

  // ---- the words ----
  function setText(v) {
    setBoxText(box, v, pg, { fit: false });
    touch();
  }
  let soundEl = $state(null);
  function remove() {
    clearSfx(box.style, false, box);
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
  // The curve line: added, its handles show on the page and bend the lines;
  // removed, the handles go and the lines run straight again.
  function addCurve() {
    box.style.sfx.guide = true;
    touch();
  }
  function removeCurve() {
    box.style.sfx.guide = false;
    box.style.sfx.paths = [];
    touch();
  }
  function resetGlyphs() {
    box.style.sfx.glyphs = {};
    touch();
  }
  const hasCurve = $derived(!!sfx?.guide || (sfx?.paths?.length ?? 0) > 0);
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
          { id: 'from', label: 'Start size', value: pct(R.flow.from), min: 30, max: 250, step: 1, unit: 'percent', write: (v) => writePart('flow', 'from', v / 100), isSet: sfx.flow != null, reset: back('flow'), title: 'The first letter, % of the type size' },
          { id: 'to', label: 'End size', value: pct(R.flow.to), min: 30, max: 250, step: 1, unit: 'percent', write: (v) => writePart('flow', 'to', v / 100), isSet: sfx.flow != null, reset: back('flow'), title: 'The last letter, % of the type size' },
          { id: 'gap', label: 'Letter spacing', value: pct(R.gap), min: -50, max: 120, step: 1, unit: 'percent', write: (v) => (box.style.sfx.gap = v / 100), isSet: sfx.gap != null, reset: back('gap'), title: 'Space between letters, % of a letter' },
          { id: 'bigTighter', label: 'Size spacing', value: pct(R.bigTighter), min: 0, max: 100, step: 1, unit: 'amount', write: (v) => (box.style.sfx.bigTighter = v / 100), isSet: sfx.bigTighter != null, reset: back('bigTighter'), title: 'How much tighter big letters sit' },
        ],
  );
  const moveSliders = $derived(
    !on
      ? []
      : [
          { id: 'follow', label: 'Lean', value: pct(R.follow), min: 0, max: 100, step: 1, unit: 'percent', write: (v) => (box.style.sfx.follow = v / 100), isSet: sfx.follow != null, reset: back('follow'), title: 'How far the letters turn with the line' },
          { id: 'slant', label: 'Slant', value: deg(R.slant), min: -40, max: 40, step: 1, unit: 'degrees', write: (v) => (box.style.sfx.slant = v), isSet: sfx.slant != null, reset: back('slant'), title: 'Every letter sheared by this, degrees' },
          { id: 'rise', label: 'Rise', value: deg(R.rise), min: -10, max: 20, step: 1, unit: 'degrees', write: (v) => (box.style.sfx.rise = v), isSet: sfx.rise != null, reset: back('rise'), title: 'The line tilted up towards its end, degrees' },
          { id: 'jrot', label: 'Random turn', value: deg(R.jitter.rot), min: 0, max: 40, step: 1, unit: 'degrees', write: (v) => writePart('jitter', 'rot', v), isSet: sfx.jitter != null, reset: back('jitter'), title: 'Each letter turned at random, up to this' },
          { id: 'jsize', label: 'Random size', value: pct(R.jitter.size), min: 0, max: 60, step: 1, unit: 'amount', write: (v) => writePart('jitter', 'size', v / 100), isSet: sfx.jitter != null, reset: back('jitter'), title: 'Each letter sized at random, up to this' },
          { id: 'joff', label: 'Random lift', value: pct(R.jitter.off), min: 0, max: 150, step: 1, unit: 'amount', write: (v) => writePart('jitter', 'off', v / 100), isSet: sfx.jitter != null, reset: back('jitter'), title: 'Each letter moved off the line at random, up to this' },
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

  // ---- tabs ----
  const TABS = [
    ['type', 'Type'],
    ['layout', 'Layout'],
    ['effects', 'Effects'],
    ['caption', 'Caption'],
  ];
  let tab = $state('type');
  const shownTab = $derived(on ? tab : 'type');
  // WAI-ARIA tabs, as the Inspector's: roving tabindex, arrows move and pick.
  let tabsEl = $state(null);
  function onTabKey(e, id) {
    const i = TABS.findIndex(([t]) => t === id);
    let n = null;
    if (e.key === 'ArrowLeft') n = (i + TABS.length - 1) % TABS.length;
    else if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    if (n == null) return;
    e.preventDefault();
    // A bare arrow is a nudge of the selected box to the window's handler.
    e.stopPropagation();
    tab = TABS[n][0];
    tabsEl?.querySelector(`[data-tab="${tab}"]`)?.focus();
  }

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
  // The type list is folded away until asked for, and only an open list's
  // cards are painted.
  let typesOpen = $state(false);
  const kindName = $derived(on && sfx.kind ? (sfxKind(sfx.kind)?.name ?? 'None') : 'None');
  const slots = $derived(typesOpen ? kinds.map((k) => ({ id: `t:${k.id}`, kind: k.id })) : []);

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
      // The list just opened (no card was asked for): a click, not a run of
      // changes, so nothing is waited out.
      const opened = !want?.slots.length && next.slots.length > 0;
      want = next;
      wantSeq++;
      if (opened) seenSeq = wantSeq;
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
    const cards = list.map((s) => ({ kind: s.kind, seed }));
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

  const UNIT_MARK = { percent: '%', degrees: '°', ems: 'em' };
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
  <div class="sfx-slider" title={o.title}>
    <span class="sfx-rl">{o.label}</span>
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
    <input class="num-s" type="number" min={o.min} max={o.max} step={o.step} value={shown(o)} aria-label="{o.label}, {o.unit}" onchange={(e) => typed(o, e)} />
    <span class="sfx-unit" aria-hidden="true">{UNIT_MARK[o.unit] ?? ''}</span>
    <!-- Kept in the row while there is nothing to reset, so the rows stay in
         line. -->
    <button
      type="button"
      class="sfx-reset"
      class:off={!(o.reset && o.isSet)}
      disabled={!(o.reset && o.isSet)}
      title={o.resetName === 'as designed' ? 'Back to the type as designed' : "Back to the type's value"}
      aria-label="{o.label}: {o.resetName ?? 'back to the type'}"
      onclick={o.reset}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v4h4" /></svg>
    </button>
  </div>
{/snippet}

{#snippet toggle(lbl, value, onset, title = undefined)}
  <div class="sfx-line" {title}>
    <span class="sfx-rl">{lbl}</span>
    <button type="button" class="switch" class:on={value} role="switch" aria-checked={value} aria-label={lbl} onclick={() => onset(!value)}><span class="knob"></span></button>
  </div>
{/snippet}

{#snippet colour(obj, key, lbl)}
  <div class="sfx-line">
    <span class="sfx-rl">{lbl}</span>
    <ColorPicker value={obj[key]} label={lbl} size={22} unclipped onchange={(hex) => setColour(obj, key, hex)} />
  </div>
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
  <!-- ===== Stage and words ===== -->
  <div class="sfx-top">
    <div class="sfx-stage" role="img" aria-label="Preview of the box's text with its SFX" bind:clientWidth={stageW}>
      <canvas bind:this={stageEl}></canvas>
    </div>
  </div>
  <div class="grp">
    <label class="lbl" for="sfx-sound">Sound</label>
    <textarea
      id="sfx-sound"
      class="sfx-sound"
      rows="2"
      bind:this={soundEl}
      value={text}
      placeholder="Type the sound"
      title="A new line or a / starts another part of the sound"
      oninput={(e) => setText(e.target.value)}
    ></textarea>
  </div>

  {#if on}
    <div class="seg sfx-tabs" role="tablist" aria-label="SFX options" bind:this={tabsEl}>
      {#each TABS as [id, name] (id)}
        <button
          type="button"
          role="tab"
          id="sfx-tab-{id}"
          data-tab={id}
          class:on={shownTab === id}
          aria-selected={shownTab === id}
          aria-controls="sfx-pane-{id}"
          tabindex={shownTab === id ? 0 : -1}
          onclick={() => (tab = id)}
          onkeydown={(e) => onTabKey(e, id)}>{name}</button
        >
      {/each}
    </div>
  {/if}

  <!-- ===== Type ===== -->
  {#if shownTab === 'type'}
    <div class="sfx-pane" role={on ? 'tabpanel' : null} id="sfx-pane-type" aria-labelledby={on ? 'sfx-tab-type' : null}>
      {#if !on}
        <div class="grp">
          <button type="button" class="rbtn sfx-make" title="Each letter set on its own, ready to move, turn and size; a type is optional" onclick={makeSfx}>Make SFX</button>
          <p class="sfx-note">Letters one by one, no type needed. Or pick a type below.</p>
        </div>
      {/if}
      <div class="grp">
        <div class="sfx-row-head">
          <button
            type="button"
            class="sfx-fold"
            aria-expanded={typesOpen}
            aria-controls="sfx-types"
            title={typesOpen ? 'Hide the sound types' : 'Show the sound types'}
            onclick={() => (typesOpen = !typesOpen)}
          >
            <span class="lbl">Type</span>
            <span class="sfx-fold-now">{kindName}</span>
            <svg class="sfx-chev" class:open={typesOpen} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          <button type="button" class="rbtn sfx-small" disabled={!best} title={best ? `${sfxKind(best)?.name}, with the intensity the sound asks for` : 'Nothing to read the sound from'} onclick={autoPick}>Auto pick</button>
        </div>
        {#if typesOpen}
          <div class="sfx-grid" id="sfx-types" role="radiogroup" aria-label="Sound type">
            {#if on}
              <button
                type="button"
                role="radio"
                aria-checked={sfx.kind == null}
                class="sfx-card sfx-none"
                class:on={sfx.kind == null}
                data-kind=""
                title="No type: the letters in a plain row, every letter control still there"
                onclick={noKind}
              >
                <span class="sfx-tile sfx-none-tile">Aa</span>
                <span class="sfx-name">None</span>
              </button>
            {/if}
            {#each kinds as k (k.id)}
              <button
                type="button"
                role="radio"
                aria-checked={on && sfx.kind === k.id}
                class="sfx-card"
                class:on={on && sfx.kind === k.id}
                data-kind={k.id}
                data-best={best === k.id ? '' : null}
                title={best === k.id ? `${k.name} · fits this sound best` : k.name}
                onclick={() => chooseKind(k.id)}
              >
                <span class="sfx-tile" style={tileStyle(`t:${k.id}`)}></span>
                <span class="sfx-name">{k.name}{#if best === k.id}<span class="sfx-best" aria-label=", fits best"></span>{/if}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      {#if on}
        <div class="sfx-line" title={shapes ? 'The letters turned, sized and lifted at random another way' : 'This type has no random shape at this Roughness'}>
          <span class="sfx-rl">Shape</span>
          <div class="sfx-stepper" class:off={!shapes}>
            <button type="button" class="rbtn sfx-icon" disabled={!shapes} aria-label="Last shape" onclick={() => stepShape(-1)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
            </button>
            <span class="sfx-seed" aria-live="polite">{sfx.seed}</span>
            <button type="button" class="rbtn sfx-icon" disabled={!shapes} aria-label="Next shape" onclick={() => stepShape(1)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
            </button>
            <button type="button" class="rbtn sfx-small" disabled={!shapes} onclick={newShape}>Shuffle</button>
          </div>
        </div>

        {#if sfx.kind}
          <div class="insp-rule"></div>
          <div class="grp sfx-dials" role="group" aria-label="Intensity">
            {#each dialSliders as o (o.id)}
              {@render slider(o)}
            {/each}
          </div>
        {/if}

        <div class="insp-rule"></div>
        <button type="button" class="sfx-remove" title="Back to the box it was before: its size, turn, fill, outlines and width and height" onclick={remove}>Remove SFX</button>
      {/if}
    </div>
  {/if}

  <!-- ===== Layout ===== -->
  {#if shownTab === 'layout'}
    <div class="sfx-pane" role="tabpanel" id="sfx-pane-layout" aria-labelledby="sfx-tab-layout">
      <div class="sfx-line">
        <span class="sfx-rl">Direction</span>
        <div class="sfx-acts">
          {#if sfx.dir != null}
            <button type="button" class="sfx-back" title="Back to the type's value" aria-label="Direction: back to the type" onclick={back('dir')}>Reset</button>
          {/if}
          <div class="seg sfx-seg">
            <button type="button" class:on={!R.vertical} aria-pressed={!R.vertical} onclick={() => set('dir', 'h')}>Across</button>
            <button type="button" class:on={R.vertical} aria-pressed={R.vertical} onclick={() => set('dir', 'v')}>Down</button>
          </div>
        </div>
      </div>
      {@render toggle('Join ー', sfx.joinBars !== false, (v) => set('joinBars', v), 'A run of long marks drawn as one bar')}
      {@render toggle('Optical spacing', sfx.kern !== false, (v) => set('kern', v), 'Letters spaced by their shapes, not their boxes')}
      <div class="insp-rule"></div>
      {#each sizeSliders as o (o.id)}
        {@render slider(o)}
      {/each}
      <div class="insp-rule"></div>
      {#each moveSliders as o (o.id)}
        {@render slider(o)}
      {/each}
      <div class="insp-rule"></div>
      <div class="sfx-acts wrap">
        <button type="button" class="rbtn sfx-small" disabled={!layoutSet} title={sfx.kind ? "Every number above back to the type's" : 'Every number above back to a plain row'} onclick={resetLayout}>{sfx.kind ? 'Back to type' : 'Reset'}</button>
        {#if hasCurve}
          <button type="button" class="rbtn sfx-small" data-sfx-curve="remove" title="Take the curve line away: its handles go and the lines run straight again" onclick={removeCurve}>Remove curve line</button>
        {:else}
          <button type="button" class="rbtn sfx-small" data-sfx-curve="add" title="Show a curve line on each line of the sound: drag its ends and its middle to bend the letters" onclick={addCurve}>Add curve line</button>
        {/if}
        <button type="button" class="rbtn sfx-small" disabled={!hasGlyphs} title="Letters moved, turned or sized by hand go back" onclick={resetGlyphs}>Reset letters</button>
      </div>
    </div>
  {/if}

  <!-- ===== Effects ===== -->
  {#if shownTab === 'effects'}
    {@const st = box.style}
    <div class="sfx-pane" role="tabpanel" id="sfx-pane-effects" aria-labelledby="sfx-tab-effects">
      {@render toggle('Negative', st.negative.on, (v) => setFx(st.negative, 'on', v), 'The letters cut out of one dark shape')}
      {#if st.negative.on}
        <div class="sfx-nest">
          {@render slider({ id: 'neg-grow', label: 'Grow', value: st.negative.grow, min: 0, max: 1, step: 0.01, unit: 'ems', title: 'How far the shape reaches past the letters, ems', write: (v) => (st.negative.grow = v) })}
          {@render colour(st.negative, 'color', 'Colour')}
        </div>
      {/if}

      {@render toggle('Extrude', st.extrude.on, (v) => setFx(st.extrude, 'on', v), 'The letters stacked into a block')}
      {#if st.extrude.on}
        <div class="sfx-nest">
          {@render slider({ id: 'ex-angle', label: 'Angle', value: wrapDeg(st.extrude.angle), min: 0, max: 359, step: 1, unit: 'degrees', write: (v) => (st.extrude.angle = v) })}
          {@render slider({ id: 'ex-depth', label: 'Depth', value: st.extrude.length, min: 0, max: 2, step: 0.01, unit: 'ems', title: 'Depth, ems', write: (v) => (st.extrude.length = v) })}
          {@render colour(st.extrude, 'color', 'Colour')}
          {@render toggle('Edge line', !!st.extrude.edge, (v) => setFx(st.extrude, 'edge', v ? '#ffffff' : ''))}
          {#if st.extrude.edge}
            {@render colour(st.extrude, 'edge', 'Edge colour')}
          {/if}
        </div>
      {/if}

      {@render toggle('Shake', st.shake.on, (v) => setFx(st.shake, 'on', v), 'Copies of the letters either side, as if they tremble')}
      {#if st.shake.on}
        <div class="sfx-nest">
          {@render slider({ id: 'sh-count', label: 'Copies', value: st.shake.count, min: 1, max: 4, step: 1, unit: 'count', write: (v) => (st.shake.count = v) })}
          {@render slider({ id: 'sh-amp', label: 'Spread', value: st.shake.amp, min: 0, max: 0.5, step: 0.01, unit: 'ems', title: 'Spread, ems', write: (v) => (st.shake.amp = v) })}
          {@render slider({ id: 'sh-angle', label: 'Angle', value: wrapDeg(st.shake.angle), min: 0, max: 359, step: 1, unit: 'degrees', write: (v) => (st.shake.angle = v) })}
        </div>
      {/if}

      {@render toggle('Trail', st.trail.on, (v) => setFx(st.trail, 'on', v), 'Fading copies behind each letter, along its line')}
      {#if st.trail.on}
        <div class="sfx-nest">
          {@render slider({ id: 'tr-count', label: 'Copies', value: st.trail.count, min: 1, max: 6, step: 1, unit: 'count', write: (v) => (st.trail.count = v) })}
          {@render slider({ id: 'tr-dist', label: 'Length', value: st.trail.dist, min: 0, max: 2, step: 0.01, unit: 'ems', title: 'Trail length, ems', write: (v) => (st.trail.dist = v) })}
        </div>
      {/if}

      <div class="insp-rule"></div>
      <div class="sfx-line">
        <span class="sfx-rl">Outlines</span>
        <div class="seg sfx-seg">
          <button type="button" class:on={st.strokeOrder !== 'each'} aria-pressed={st.strokeOrder !== 'each'} title="One outline round the whole sound" onclick={() => setStyle('strokeOrder', 'merged')}>Merged</button>
          <button type="button" class:on={st.strokeOrder === 'each'} aria-pressed={st.strokeOrder === 'each'} title="Each letter outlined over the one before" onclick={() => setStyle('strokeOrder', 'each')}>Each letter</button>
        </div>
      </div>
      <div class="sfx-line">
        <span class="sfx-rl">Corners</span>
        <div class="seg sfx-seg">
          <button type="button" class:on={st.strokeJoin !== 'miter'} aria-pressed={st.strokeJoin !== 'miter'} onclick={() => setStyle('strokeJoin', 'round')}>Round</button>
          <button type="button" class:on={st.strokeJoin === 'miter'} aria-pressed={st.strokeJoin === 'miter'} onclick={() => setStyle('strokeJoin', 'miter')}>Sharp</button>
        </div>
      </div>
      {@render slider({ id: 'shade', label: 'Shade', value: pct(st.strokeShade), min: 0, max: 100, step: 1, unit: 'percent', title: 'The outlines darkened on the side away from the light', write: (v) => (st.strokeShade = v / 100) })}
    </div>
  {/if}

  <!-- ===== Caption ===== -->
  {#if shownTab === 'caption'}
    <div class="sfx-pane" role="tabpanel" id="sfx-pane-caption" aria-labelledby="sfx-tab-caption">
      <div class="grp">
        <label class="lbl" for="sfx-caption">Caption</label>
        <input id="sfx-caption" type="text" value={sfx.caption.text} placeholder="What the sound means" oninput={(e) => setCaption('text', e.target.value)} />
        {#if meaning}
          <button type="button" class="rbtn sfx-small sfx-meaning" title="Use the dictionary's meaning of this sound" onclick={fillMeaning}>Use “{meaning}”</button>
        {/if}
      </div>
      {#if sfx.caption.text}
        <div class="sfx-line">
          <span class="sfx-rl">Side</span>
          <div class="seg sfx-seg">
            {#each SIDES as [side, name] (side)}
              <button type="button" class:on={sfx.caption.side === side} aria-pressed={sfx.caption.side === side} onclick={() => setCaption('side', side)}>{name}</button>
            {/each}
          </div>
        </div>
        {@render slider({ id: 'cap-size', label: 'Size', value: pct(sfx.caption.size), min: 10, max: 100, step: 5, unit: 'percent', title: 'The caption, % of the type size', write: (v) => (box.style.sfx.caption.size = v / 100) })}
        {@render colour(box.style.sfx.caption, 'color', 'Colour')}
      {:else}
        <p class="sfx-note">A small line beside the sound, saying what it means.</p>
      {/if}
    </div>
  {/if}
{/if}

<style>
  /* The stage stays pinned to the top of the window while it scrolls, so a
     card can be picked while watching it. Opaque ground, so nothing shows
     through. */
  .sfx-top {
    position: sticky;
    top: -12px;
    z-index: 2;
    margin: -12px -12px 0;
    padding: 12px 12px 4px;
    background: var(--panel);
  }
  /* Always paper, in both themes: the lettering is drawn to be read on a page. */
  .sfx-stage {
    height: 120px;
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 8px;
    overflow: hidden;
  }
  .sfx-stage canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .sfx-sound {
    min-height: 0;
    height: 48px;
    font-size: 14px;
    line-height: 1.3;
    resize: vertical;
  }

  .sfx-tabs {
    margin-top: 2px;
  }
  .sfx-tabs button {
    flex: 1 1 0;
    min-width: 0;
    padding: 0 4px;
    font-size: 11.5px;
  }
  .sfx-tabs button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .sfx-pane {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    padding-top: 4px;
  }

  .sfx-row-head,
  .sfx-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 28px;
    min-width: 0;
  }
  /* A row's name: the control's, in body ink, beside it. */
  .sfx-rl {
    flex: 0 1 auto;
    min-width: 0;
    font-size: 12px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sfx-note {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--t2);
  }
  .sfx-acts {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }
  .sfx-acts.wrap {
    flex-wrap: wrap;
  }
  .sfx-small {
    height: 26px;
    padding: 0 9px;
    font-size: 11.5px;
  }
  .sfx-seg {
    flex: 0 0 auto;
  }
  .sfx-seg button {
    padding: 0 10px;
    font-size: 11.5px;
  }
  /* The options an effect has, under its switch. */
  .sfx-nest {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-left: 12px;
    border-left: 1px solid var(--line);
  }

  /* ---- the type cards ---- */
  .sfx-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }
  .sfx-card {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 4px 4px 6px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--surface);
    color: var(--t2);
    font-family: inherit;
    cursor: pointer;
    min-width: 0;
    transition:
      border-color 0.12s,
      color 0.12s;
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
    height: 62px;
    border-radius: 5px;
    background-color: var(--paper);
    background-repeat: no-repeat;
    background-position: center;
    background-size: contain;
  }
  .sfx-name {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    font-size: 11.5px;
    overflow: hidden;
    white-space: nowrap;
  }
  /* The type the sound itself asks for: a dot after its name. */
  .sfx-best {
    flex: 0 0 auto;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
  }

  /* ---- the shape stepper ---- */
  .sfx-stepper {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .sfx-icon {
    width: 26px;
    min-width: 26px;
    padding: 0;
  }
  .sfx-icon svg {
    width: 13px;
    height: 13px;
  }
  .sfx-seed {
    min-width: 34px;
    text-align: center;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .sfx-stepper.off .sfx-seed {
    color: var(--t3);
  }
  .sfx-stepper .sfx-small {
    margin-left: 4px;
  }

  /* ---- a slider row: name, track, number, unit, reset ---- */
  .sfx-dials {
    gap: 8px;
  }
  .sfx-slider {
    display: grid;
    grid-template-columns: 86px minmax(0, 1fr) 54px 12px 20px;
    align-items: center;
    gap: 6px;
    min-height: 28px;
  }
  .sfx-slider .num-s {
    width: 100%;
    padding: 0 4px;
  }
  /* Room for four digits: the spinner is the arrows' and the drag's job. */
  .sfx-slider .num-s::-webkit-inner-spin-button {
    display: none;
  }
  .sfx-unit {
    font-size: 11px;
    color: var(--t3);
  }
  .sfx-track {
    position: relative;
    min-width: 0;
    display: flex;
    align-items: center;
  }
  .sfx-track input {
    width: 100%;
    margin: 0;
  }
  /* The dials' middle, where the type is as designed: a tick under the track. */
  .sfx-track.mid::after {
    content: '';
    position: absolute;
    left: 50%;
    top: calc(50% + 6px);
    width: 1px;
    height: 4px;
    background: var(--t3);
    pointer-events: none;
  }
  .sfx-reset {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
  }
  .sfx-reset svg {
    width: 13px;
    height: 13px;
  }
  .sfx-reset:hover {
    color: var(--text);
    background: var(--accent-soft);
  }
  .sfx-reset.off {
    visibility: hidden;
  }
  .sfx-back {
    flex: 0 0 auto;
    height: 22px;
    padding: 0 7px;
    border: 1px solid var(--line2);
    border-radius: 5px;
    background: transparent;
    color: var(--t2);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .sfx-back:hover {
    color: var(--text);
    border-color: var(--t3);
    background: var(--accent-soft);
  }

  .sfx-meaning {
    align-self: flex-start;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
  }

  .sfx-settings {
    align-self: flex-start;
    height: 28px;
    padding: 0 12px;
  }

  /* Destructive, so rust, and outlined rather than filled. */
  /* The type list's header: the label, the type now, and a chevron. */
  .sfx-fold {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1 1 auto;
    height: 28px;
    padding: 0 6px 0 0;
    border: 0;
    background: transparent;
    color: inherit;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
  }
  .sfx-fold .lbl {
    margin: 0;
  }
  .sfx-fold-now {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--t1);
  }
  .sfx-chev {
    flex: 0 0 14px;
    width: 14px;
    height: 14px;
    color: var(--t2);
    transition: transform 0.15s;
  }
  .sfx-chev.open {
    transform: rotate(180deg);
  }
  .sfx-none-tile {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    color: #222;
  }
  .sfx-make {
    align-self: stretch;
    height: 30px;
  }
  .sfx-remove {
    align-self: flex-start;
    height: 28px;
    padding: 0 12px;
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

  .sfx-back:focus-visible,
  .sfx-card:focus-visible,
  .sfx-reset:focus-visible,
  .sfx-remove:focus-visible,
  .sfx-settings:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
