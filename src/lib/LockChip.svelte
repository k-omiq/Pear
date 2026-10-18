<script>
  // The lock chip (FIT-5): a box the solver manages that has something locked -
  // a size typed in, a width dragged wider, its whole layout held - says so on
  // the page, and this is where the user lets it go. Until now the only way to
  // release a lock was an undo, which also took back the edit that set it.
  //
  // Drawn by TextBox beside the "needs review" badge, and like the badge it is
  // editor chrome only: the exporter and the PSD writer paint from the document,
  // never from this DOM, so it is in no export and no thumbnail. It sits outside
  // the box's own rectangle and is absolutely placed, so it takes no room from
  // the text and moves no line.
  //
  // Every command is the store's (`setBoxLocks` and its two wrappers); this only
  // decides which of them to offer. None of them typesets the box again - see
  // `setBoxLocks` for why - so the menu says what will.
  import { app, boxLocks, layoutLocked, unlockBoxes, lockBoxLayout, isTranslateMode, LOCK_KEYS } from './store.svelte.js';
  import { comboFor, formatCombo } from './shortcuts.svelte.js';

  let { box } = $props();

  const locks = $derived(boxLocks(box));
  // Hidden while the Bulk panel is picking boxes (a click there means "this
  // box", and the tick mark takes the same corner) and in a translate chapter,
  // where nothing on the page is laid out.
  const shown = $derived(!!locks && !app.bulk.active && !isTranslateMode());
  // The whole layout, as "Lock layout" holds it - not the line breaks alone,
  // which the agent holds by themselves (`layoutLocked`).
  const layout = $derived(!!locks && layoutLocked(box));

  // The entries that apply, and no others: one per lock that is on, so each
  // can be let go by itself, and "Unlock all" once there is more than one. A
  // box whose layout is held offers only "Unlock all", since letting one part
  // of a held layout go is not holding it.
  const WORDS = { size: 'size', width: 'width', height: 'height', pos: 'position', breaks: 'line breaks' };
  const names = $derived(locks ? LOCK_KEYS.filter((k) => locks[k]) : []);
  const items = $derived.by(() => {
    if (!locks) return [];
    if (layout) return [{ id: 'all', label: 'Unlock all' }];
    const out = names.map((k) => ({ id: k, label: `Unlock ${WORDS[k]}` }));
    if (out.length > 1) out.push({ id: 'all', label: 'Unlock all' });
    out.push({ id: 'layout', label: 'Lock layout', sep: true });
    return out;
  });

  const summary = $derived(layout ? 'Layout locked' : `Locked: ${names.map((k) => WORDS[k]).join(', ')}`);
  // The box turns, and the chip with it, as everything inside the box does. A
  // padlock on its side reads as a cup, and its menu would open sideways, so
  // the chip is turned back upright about its own centre, where it stays.
  const upright = $derived(Number(box.style?.rotation) ? `transform: rotate(${-Number(box.style.rotation)}deg)` : '');
  // The key as the user has it bound, not as it shipped.
  const refitKey = $derived(formatCombo(comboFor('box.retypeset')));

  let open = $state(false);
  let chipEl = $state(null);
  let menuEl = $state(null);

  // A box that loses its last lock - by the menu, an undo, the box turning
  // manual - takes the menu with it rather than leaving it open on nothing.
  $effect(() => {
    if (!shown) open = false;
  });

  function close(restoreFocus = false) {
    open = false;
    if (restoreFocus) chipEl?.focus();
  }

  function choose(id) {
    // Focus goes back to the chip while it is still on the page; after "Unlock
    // all" it will not be, and focus falls back to the document as it would
    // for any control that has gone.
    close(true);
    if (id === 'layout') lockBoxLayout(box.id);
    else unlockBoxes(box.id, id);
  }

  // Outside the menu and the chip, a press closes it. The chip is spared so its
  // own click toggles the menu rather than closing and reopening it.
  function onWindowDown(e) {
    if (menuEl?.contains(e.target) || chipEl?.contains(e.target)) return;
    close();
  }
  $effect(() => {
    if (!open) return;
    window.addEventListener('pointerdown', onWindowDown, true);
    return () => window.removeEventListener('pointerdown', onWindowDown, true);
  });

  function focusFirst(node) {
    node.querySelector('button')?.focus();
  }

  // The editor listens for keys on the window: Delete deletes the selected box,
  // the arrows nudge it, Tab walks the selection, Escape deselects. None of that
  // is what a key pressed on this chip or its menu means, so plain keys stop
  // here. Cmd/Ctrl combos go on, so undo and the other shortcuts still work.
  function onKey(e) {
    if (e.metaKey || e.ctrlKey) return;
    if (e.key === 'Escape') {
      if (!open) return;
      close(true);
    } else if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const all = [...(menuEl?.querySelectorAll('button') ?? [])];
      const i = all.indexOf(document.activeElement);
      const n = all.length;
      all[(i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n]?.focus();
      e.preventDefault();
    }
    e.stopPropagation();
  }

  // The box drags from a press anywhere inside it; the chip is not the box.
  const stop = (e) => e.stopPropagation();
</script>

{#if shown}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="lock-chip-wrap" style={upright} contenteditable="false" onpointerdown={stop} ondblclick={stop} onkeydown={onKey}>
    <button
      class="lock-chip"
      class:layout
      bind:this={chipEl}
      type="button"
      title="{summary} - click to unlock"
      aria-label="{summary}. Open lock menu"
      aria-haspopup="menu"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
      </svg>
    </button>
    {#if open}
      <div class="chrome-menu lock-menu" role="menu" aria-label="Locks" bind:this={menuEl} use:focusFirst>
        {#each items as it (it.id)}
          {#if it.sep}<div class="chrome-menu-sep"></div>{/if}
          <button role="menuitem" type="button" onclick={() => choose(it.id)}>{it.label}</button>
        {/each}
        <!-- What the menu will not do, said where it is chosen: nothing moves on
             a click, and Refit is how the box is laid out again. -->
        <p class="lock-note">
          Unlocking moves nothing - Refit{refitKey ? ` (${refitKey})` : ''} lays the box out again.{#if !layout}
            Lock layout keeps its size, width, place and line breaks through edits and Refit.{/if}
        </p>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Beside the box's top-right corner, clear of the corner handle (6px out),
     the rotation grip (top centre) and the review badge (above the top-left),
     so it never covers either and never sits on the text. */
  .lock-chip-wrap {
    position: absolute;
    left: calc(100% + 9px);
    top: -1px;
    z-index: 8;
    /* The chip's centre, for turning it upright on a turned box. */
    transform-origin: 9.5px 9.5px;
    cursor: default;
    text-align: left;
    line-height: 1.3;
    font-family: inherit;
  }
  .lock-chip {
    display: grid;
    place-items: center;
    width: 19px;
    height: 19px;
    padding: 0;
    border: 1px solid var(--line2);
    border-radius: 999px;
    background: var(--panel);
    color: var(--t2);
    box-shadow: var(--edge-soft);
    cursor: pointer;
  }
  .lock-chip:hover,
  .lock-chip[aria-expanded='true'] {
    color: var(--text);
    border-color: var(--tintline);
  }
  .lock-chip:focus-visible {
    outline: 2px solid var(--tintline);
    outline-offset: 1px;
  }
  /* A held layout is the stronger statement, so it reads darker. */
  .lock-chip.layout {
    background: var(--tintline);
    border-color: var(--tintline);
    color: var(--paper);
  }
  .lock-chip svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linejoin: round;
  }
  .lock-chip svg rect {
    fill: currentColor;
    fill-opacity: 0.2;
  }
  /* The app's dropdown, placed under the chip instead of under a toolbar pill. */
  .lock-menu {
    top: calc(100% + 4px);
    left: 0;
    right: auto;
    min-width: 168px;
    max-width: 220px;
  }
  .lock-note {
    margin: 4px 6px 2px;
    font-size: 11px;
    line-height: 1.35;
    color: var(--t2);
    white-space: normal;
  }
</style>
