<script module>
  // The tab the screen was last on, for the next time Settings opens here.
  let lastTab = null;
</script>

<script>
  // Settings ▸ Shortcuts: every named action, one tab per group, and a search
  // across all of them. Click a key to bind it, × to take it away. Most
  // actions start with no key; the user binds the ones they reach for.
  import { onMount } from 'svelte';
  import {
    shortcutGroups,
    shortcutMatches,
    placeNote,
    comboFor,
    defaultCombo,
    isCustomCombo,
    setCombo,
    clearCombo,
    resetCombo,
    resetAllCombos,
    formatCombo,
  } from './shortcuts.svelte.js';
  import { createRebindCapture } from './rebind-capture.js';
  import { toast } from './store.svelte.js';

  const groups = $derived(shortcutGroups());
  let tab = $state(lastTab);
  const current = $derived(groups.find((g) => g.name === tab) ?? groups[0]);
  $effect(() => {
    lastTab = current?.name ?? null;
  });

  let query = $state('');
  const searching = $derived(query.trim() !== '');
  const shown = $derived(
    searching
      ? groups.map((g) => ({ ...g, items: g.items.filter((s) => shortcutMatches(s, query)) })).filter((g) => g.items.length)
      : current
        ? [current]
        : [],
  );
  const hits = $derived(shown.reduce((n, g) => n + g.items.length, 0));

  // ---------- binding ----------
  let capturing = $state(null); // the id waiting for keys
  let captureErr = $state('');
  let clash = $state(null); // { combo, other } when the keys belong to another action
  let confirmReset = $state(false);

  const capture = createRebindCapture(typeof window === 'undefined' ? null : window, {
    onKey: (combo, done) => {
      const r = setCombo(capturing, combo);
      if (r.ok) {
        done();
        stop();
        return;
      }
      clash = r.reason === 'conflict' ? { combo, other: r.conflict } : null;
      captureErr =
        r.reason === 'conflict'
          ? `${formatCombo(combo)} is already used by “${r.conflict.label}”.`
          : r.reason === 'types'
            ? `${formatCombo(combo)} would type into the field. Hold ${formatCombo('Alt+1').replace(/1$/, '')} or ${formatCombo('Mod+1').replace(/1$/, '')} with it.`
            : r.reason === 'contextual'
              ? 'Esc, Tab and the arrows are fixed keys. Try another.'
              : 'That key cannot be used. Try another.';
    },
    onCancel: () => {
      capturing = null;
      captureErr = '';
      clash = null;
    },
  });

  // The screen is on show while it is mounted; leaving it takes any capture
  // with it, so no window-wide key listener outlives the row that asked.
  onMount(() => {
    capture.setOpen(true);
    return () => capture.setOpen(false);
  });

  function stop() {
    capture.end();
    capturing = null;
    captureErr = '';
    clash = null;
  }

  function begin(id) {
    captureErr = '';
    clash = null;
    capturing = capture.begin(id);
  }

  // The keys move here: taken from the other action, given to this one.
  function takeKeys() {
    if (!clash || !capturing) return;
    const { combo, other } = clash;
    clearCombo(other.id);
    const r = setCombo(capturing, combo);
    if (r.ok) toast(`“${other.label}” has no key now`);
    stop();
  }

  function clear(id) {
    if (capturing === id) stop();
    clearCombo(id);
  }

  function reset(item) {
    if ([item.id, ...item.alts].includes(capturing)) stop();
    for (const id of [item.id, ...item.alts]) resetCombo(id);
  }

  const rowCustom = (item) => [item.id, ...item.alts].some(isCustomCombo);

  function onResetAll() {
    if (!confirmReset) {
      confirmReset = true;
      return;
    }
    confirmReset = false;
    stop();
    resetAllCombos();
    toast('Shortcuts back to their defaults');
  }

  // ---------- tabs ----------
  function pick(name) {
    if (capturing) stop();
    query = '';
    tab = name;
  }

  // Left and Right walk the tab row; Home and End go to its ends.
  function onTabKey(e) {
    const i = groups.findIndex((g) => g.name === current?.name);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: groups.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    const next = groups[(to + groups.length) % groups.length];
    pick(next.name);
    e.currentTarget.parentElement?.querySelector(`[data-tab="${CSS.escape(next.name)}"]`)?.focus();
  }

  // Escape in the search clears it before it closes Settings.
  function onSearchKey(e) {
    if (e.key === 'Escape' && query) {
      e.preventDefault();
      e.stopPropagation();
      query = '';
    }
  }
</script>

{#snippet keyChip(id)}
  {@const combo = comboFor(id)}
  {@const listening = capturing === id}
  <span class="sc-key" class:listening class:empty={!combo && !listening}>
    <button
      type="button"
      class="sc-combo"
      class:custom={isCustomCombo(id)}
      title={listening ? 'Press the keys. Esc cancels.' : defaultCombo(id) ? `Default ${formatCombo(defaultCombo(id))}` : 'No default key'}
      onclick={() => begin(id)}
    >
      {listening ? 'Press keys…' : combo ? formatCombo(combo) : 'Add key'}
    </button>
    {#if combo && !listening}
      <button type="button" class="sc-clear" aria-label="Remove {formatCombo(combo)}" title="Remove this key" onclick={() => clear(id)}>×</button>
    {/if}
  </span>
{/snippet}

<div class="sc-head">
  <label class="sc-search">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
    <input type="search" placeholder="Search actions or keys" aria-label="Search shortcuts" bind:value={query} onkeydown={onSearchKey} />
  </label>
  <div class="sc-tabs" role="tablist" aria-label="Shortcut groups">
    {#each groups as g (g.name)}
      {@const on = !searching && g.name === current?.name}
      {@const n = searching ? g.items.filter((s) => shortcutMatches(s, query)).length : 0}
      <button
        type="button"
        role="tab"
        data-tab={g.name}
        aria-selected={on}
        tabindex={on || (searching && g === groups[0]) ? 0 : -1}
        class:on
        class:dim={searching && !n}
        onclick={() => pick(g.name)}
        onkeydown={onTabKey}
      >
        {g.name}{#if searching && n}<span class="sc-count">{n}</span>{/if}
      </button>
    {/each}
  </div>
</div>

<p class="set-lead">Click a key to change it. Press <b>Esc</b> to cancel.</p>

{#each shown as g (g.name)}
  <section class="settings-section sc-section" role={searching ? undefined : 'tabpanel'}>
    {#if searching}<h3 class="settings-title">{g.name}</h3>{/if}
    {#each g.items as s (s.id)}
      <div class="set-item">
        <div class="set-line sc-line">
          <span class="set-label">
            {s.label}
            {#if placeNote(s)}<span class="sc-note">{placeNote(s)}</span>{/if}
          </span>
          <div class="sc-keys">
            {@render keyChip(s.id)}
            {#each s.alts as alt (alt)}{@render keyChip(alt)}{/each}
          </div>
          <button
            type="button"
            class="sc-reset"
            disabled={!rowCustom(s)}
            aria-label="Back to default"
            title={defaultCombo(s.id) ? `Back to ${formatCombo(defaultCombo(s.id))}` : 'Back to no key'}
            onclick={() => reset(s)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
          </button>
        </div>
        {#if [s.id, ...s.alts].includes(capturing) && captureErr}
          <p class="set-desc set-error">
            {captureErr}
            {#if clash}<button type="button" class="btn tiny sc-take" onclick={takeKeys}>Use it here</button>{/if}
          </p>
        {/if}
      </div>
    {/each}
  </section>
{/each}

{#if searching && !hits}
  <p class="sc-none">Nothing matches “{query.trim()}”.</p>
{/if}

<section class="settings-section">
  <h3 class="settings-title">Fixed keys</h3>
  <ul class="sc-fixed">
    <li><b>Esc</b> closes what is open, then deselects.</li>
    <li><b>Tab</b> steps through the boxes on the page.</li>
    <li><b>Arrows</b> nudge the selected box, or turn the page. Hold <b>Shift</b> for bigger steps.</li>
  </ul>
  <div class="set-actions">
    {#if confirmReset}<button class="btn tiny" onclick={() => (confirmReset = false)}>Cancel</button>{/if}
    <button class="btn tiny" class:danger={confirmReset} onclick={onResetAll}>{confirmReset ? 'Reset every shortcut' : 'Reset all shortcuts'}</button>
  </div>
</section>

<style>
  /* Search and tabs stay in view while the list scrolls under them. */
  .sc-head {
    position: sticky;
    top: 0;
    z-index: 1;
    margin-top: 14px;
    padding: 8px 0 0;
    background: var(--bg);
    border-bottom: 1px solid var(--line);
  }
  .sc-search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--t3);
  }
  .sc-search:focus-within {
    border-color: var(--accent);
  }
  .sc-search svg {
    flex: none;
    width: 14px;
    height: 14px;
  }
  .sc-search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: none;
    outline: none;
    background: transparent;
    color: var(--text);
    font-size: 12.5px;
  }
  .sc-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    margin-top: 8px;
  }
  .sc-tabs button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 30px;
    padding: 0 10px;
    border: none;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--t2);
    font-size: 12px;
    cursor: pointer;
  }
  .sc-tabs button:hover {
    color: var(--text);
  }
  .sc-tabs button.on {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .sc-tabs button.dim {
    opacity: 0.45;
  }
  .sc-tabs button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .sc-count {
    font-size: 10.5px;
    color: var(--t3);
    font-variant-numeric: tabular-nums;
  }
  .sc-section {
    margin-top: 10px;
  }
  .sc-section .settings-title {
    margin-top: 16px;
  }
  .sc-line {
    gap: 10px;
  }
  .sc-note {
    margin-left: 6px;
    font-size: 11.5px;
    color: var(--t3);
  }
  .sc-keys {
    display: flex;
    gap: 6px;
    flex: none;
  }
  /* The key is the button: there is no second "change" control to hunt for. */
  .sc-key {
    display: inline-flex;
    align-items: stretch;
    height: 28px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    overflow: hidden;
  }
  .sc-key.empty {
    border-style: dashed;
    background: transparent;
  }
  .sc-key.listening {
    border-color: var(--warn);
  }
  .sc-combo {
    min-width: 84px;
    padding: 0 10px;
    border: none;
    background: none;
    color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    cursor: pointer;
  }
  .sc-key.empty .sc-combo {
    color: var(--t3);
    font-family: inherit;
  }
  .sc-key.listening .sc-combo {
    color: var(--warn);
    font-family: inherit;
  }
  /* A rebound key is worth spotting when a press does something unexpected. */
  .sc-combo.custom {
    font-weight: 600;
  }
  .sc-combo:hover,
  .sc-clear:hover {
    background: var(--accent-soft);
  }
  .sc-combo:focus-visible,
  .sc-clear:focus-visible,
  .sc-reset:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .sc-clear {
    width: 22px;
    border: none;
    border-left: 1px solid var(--line);
    background: none;
    color: var(--t3);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  .sc-clear:hover {
    color: var(--text);
  }
  .sc-reset {
    flex: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--t2);
    cursor: pointer;
  }
  .sc-reset svg {
    width: 14px;
    height: 14px;
  }
  .sc-reset:hover:not(:disabled) {
    background: var(--accent-soft);
    color: var(--text);
  }
  /* Present but silent on a default binding, so nothing shifts sideways. */
  .sc-reset:disabled {
    opacity: 0.2;
    cursor: default;
  }
  .sc-take {
    margin-left: 8px;
  }
  .set-error {
    color: var(--warn);
  }
  .sc-none {
    margin: 24px 0;
    font-size: 12.5px;
    color: var(--t2);
  }
  .sc-fixed {
    margin: 10px 0 0;
    padding-left: 18px;
    font-size: 12px;
    line-height: 1.7;
    color: var(--t2);
  }
  .sc-fixed b {
    color: var(--text);
    font-weight: 500;
  }
</style>
