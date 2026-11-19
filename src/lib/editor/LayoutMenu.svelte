<script>
  // The rail's Layout menu: what the editor shows, in place of the old
  // translate and typeset "modes". A preset, or the panes one by one - the
  // typesetting tools, and whether the text queue and the Text box options
  // sit docked down the right or float as windows. Remembered for the open
  // chapter's kind (layouts.svelte.js, docs/UI_COMBOS.md).
  import {
    activeLayout,
    activeLayoutId,
    chooseLayout,
    setLayoutField,
    isTranslateChapter,
  } from '../store.svelte.js';
  import { LAYOUT_NAMES } from '../layouts.svelte.js';
  import { keyLabel } from '../shortcuts.svelte.js';
  import { isComics } from '../prefs.svelte.js';

  let { anchor = null, onClose } = $props();
  let menuEl = $state(null);

  const combo = $derived(activeLayout());
  const id = $derived(activeLayoutId());
  const kind = $derived(isTranslateChapter() ? 'translate' : 'typeset');
  const toolsKey = $derived(keyLabel('translate.typesetTools'));

  const PRESETS = [
    ['translate', 'The page beside the typing pane'],
    ['typeset', 'Typesetting tools, floating panels'],
    ['custom', 'Your own mix'],
  ];
  // General use has no translating (every chapter is typeset), so it has no
  // Translate layout to offer.
  const presets = $derived(isComics() || isTranslateChapter() ? PRESETS : PRESETS.filter(([pid]) => pid !== 'translate'));

  function close({ restoreFocus = false } = {}) {
    if (restoreFocus) anchor?.focus();
    onClose?.();
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.stopImmediatePropagation();
    close({ restoreFocus: true });
  }
  function onDown(e) {
    if (menuEl?.contains(e.target) || anchor?.contains(e.target)) return;
    close();
  }
  $effect(() => {
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  });
  function focusFirst(node) {
    node.querySelector('button[aria-checked="true"], button:not(:disabled)')?.focus();
  }
  // Out of the rail and onto the body, fixed beside its button: the rail sits
  // under the dock, the pills and the floating panels, and a menu inside it
  // would open under them. Modals (z 100) still cover it.
  function portal(node) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }
  let pos = $state({ left: 0, top: 0 });
  function place() {
    const r = anchor?.getBoundingClientRect?.();
    if (!r) return;
    const h = menuEl?.offsetHeight ?? 0;
    const room = (globalThis.innerHeight || 0) - 8;
    pos = { left: Math.round(r.right + 8), top: Math.round(Math.max(8, Math.min(r.top, room - h))) };
  }
  $effect(() => {
    place();
    globalThis.addEventListener?.('resize', place);
    return () => globalThis.removeEventListener?.('resize', place);
  });
</script>

<div class="chrome-menu lay-menu" role="menu" aria-label="Layout" bind:this={menuEl} use:portal use:focusFirst style:left="{pos.left}px" style:top="{pos.top}px">
  <span class="lay-head">Layout</span>
  {#each presets as [pid, sub] (pid)}
    <button role="menuitemradio" aria-checked={id === pid} class="lay-row" onclick={() => chooseLayout(pid)}>
      <span class="lay-dot" class:on={id === pid} aria-hidden="true"></span>
      <span class="lay-text"><span>{LAYOUT_NAMES[pid]}</span><span class="lay-sub">{sub}</span></span>
    </button>
  {/each}
  <div class="chrome-menu-sep"></div>
  <button
    role="menuitemcheckbox"
    aria-checked={combo.tools}
    class="lay-row"
    onclick={() => setLayoutField('tools', !combo.tools)}
  >
    <span class="lay-box" class:on={combo.tools} aria-hidden="true"></span>
    <span class="lay-text"><span>Typesetting tools</span><span class="lay-sub">This chapter only{toolsKey ? ` · ${toolsKey}` : ''}</span></span>
  </button>
  <div class="lay-pane" role="group" aria-label="Text queue">
    <span class="lay-label">Text queue</span>
    <span class="lay-seg">
      <button role="menuitemradio" aria-checked={combo.queue === 'docked'} class:on={combo.queue === 'docked'} onclick={() => setLayoutField('queue', 'docked')}>Docked</button>
      <button role="menuitemradio" aria-checked={combo.queue === 'floating'} class:on={combo.queue === 'floating'} onclick={() => setLayoutField('queue', 'floating')}>Floating</button>
    </span>
  </div>
  <div class="lay-pane" role="group" aria-label="Text box options">
    <span class="lay-label" class:off={!combo.tools}>Text box options</span>
    <span class="lay-seg">
      <button role="menuitemradio" aria-checked={combo.options === 'docked'} class:on={combo.options === 'docked'} disabled={!combo.tools} onclick={() => setLayoutField('options', 'docked')}>Docked</button>
      <button role="menuitemradio" aria-checked={combo.options === 'floating'} class:on={combo.options === 'floating'} disabled={!combo.tools} onclick={() => setLayoutField('options', 'floating')}>Floating</button>
    </span>
  </div>
  <p class="lay-note">The layout and panes are remembered for {kind} chapters.</p>
</div>

<style>
  .lay-menu {
    position: fixed;
    right: auto;
    z-index: 95;
    width: 268px;
    cursor: default;
  }
  .lay-head {
    padding: 6px 10px 3px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--t2);
  }
  .chrome-menu .lay-row {
    height: auto;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 7px 9px;
    white-space: normal;
  }
  .lay-dot,
  .lay-box {
    flex: none;
    width: 14px;
    height: 14px;
    margin-top: 1px;
    box-shadow: inset 0 0 0 1.5px var(--t3);
  }
  .lay-dot {
    border-radius: 50%;
  }
  .lay-dot.on {
    box-shadow: inset 0 0 0 4px var(--accent);
  }
  .lay-box {
    border-radius: 5px;
  }
  .lay-box.on {
    background: var(--accent);
    box-shadow: none;
  }
  .lay-box.on::after {
    content: '';
    display: block;
    width: 100%;
    height: 100%;
    background: var(--accent-fg);
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 8.5l2.6 2.5L12 5.5' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 100% no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 8.5l2.6 2.5L12 5.5' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 100% no-repeat;
  }
  .lay-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 12.5px;
    font-weight: 600;
  }
  .lay-sub {
    font-size: 11px;
    font-weight: 400;
    color: var(--t2);
  }
  .lay-pane {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 9px;
  }
  .lay-label {
    font-size: 12.5px;
    font-weight: 600;
  }
  .lay-label.off {
    color: var(--t3);
  }
  .lay-seg {
    display: inline-flex;
    padding: 2px;
    border: 1px solid var(--line2);
    border-radius: 8px;
  }
  .chrome-menu .lay-seg button {
    height: 24px;
    padding: 0 9px;
    border-radius: 6px;
    font-size: 11.5px;
  }
  .chrome-menu .lay-seg button.on,
  .chrome-menu .lay-seg button.on:hover {
    background: var(--accent);
    color: var(--accent-fg);
  }
  .lay-note {
    margin: 4px 10px 6px;
    font-size: 11px;
    color: var(--t3);
  }
</style>
