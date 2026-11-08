<script>
  // The "…" menu a home row keeps its actions in, the way Manga Cleaner's
  // chapter rows do: the row itself says where a chapter stands, and what can
  // be done to it waits one click away instead of crowding every line.
  //
  // The trigger sits beside the row's own button rather than inside it (a
  // button in a button reaches neither the keyboard nor a screen reader). The
  // same menu opens at the pointer on a right-click: the row calls `openAt`.
  // It is drawn `position: fixed` so no scrolling ancestor clips it.
  //
  // `items`: { id, label, title?, danger?, disabled?, separator? }. `onpick(id)`
  // runs after the menu closes. `compact` draws the trigger at the size of the
  // Inspector's row buttons (the effects' Make Default menu).
  import { tick } from 'svelte';

  let { items, label, onpick, compact = false } = $props();

  let trigger = $state(null);
  let menuEl = $state(null);
  let at = $state(null); // { x, y } in client pixels while open

  const actionable = () => [...(menuEl?.querySelectorAll('[role="menuitem"]:not([disabled])') ?? [])];

  // Open with the menu's top-left at (x, y) - or its right edge at `right` -
  // kept inside the window.
  export async function openAt(x, y, { focus = false, right = null } = {}) {
    at = { x, y };
    await tick();
    if (!menuEl) return;
    const r = menuEl.getBoundingClientRect();
    const left = right == null ? x : right - r.width;
    at = {
      x: Math.max(8, Math.min(left, window.innerWidth - r.width - 8)),
      y: y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height) : y,
    };
    if (focus) actionable()[0]?.focus();
  }

  function openFromTrigger(e) {
    if (at) return close();
    const r = trigger.getBoundingClientRect();
    // A keyboard press (detail 0) puts focus in the menu; a click leaves it.
    openAt(r.left, r.bottom + 4, { focus: e.detail === 0, right: r.right });
  }

  function close({ restore = false } = {}) {
    at = null;
    if (restore) trigger?.focus();
  }

  async function pick(it) {
    close({ restore: true });
    await tick();
    onpick?.(it.id);
  }

  function onKey(e) {
    if (!at) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close({ restore: true });
      return;
    }
    if (e.key === 'Tab') return close();
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const list = actionable();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i < 0 ? list.length - 1 : i - 1, Home: 0, End: list.length - 1 }[e.key];
    list[(to + list.length) % list.length].focus();
  }

  function onDown(e) {
    if (!at || menuEl?.contains(e.target) || trigger?.contains(e.target)) return;
    close();
  }

  $effect(() => {
    if (!at) return;
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  });
</script>

<button
  bind:this={trigger}
  class="row-menu-btn"
  class:compact
  class:open={!!at}
  aria-label={label}
  aria-haspopup="menu"
  aria-expanded={!!at}
  title="More"
  onclick={openFromTrigger}
>
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
</button>

{#if at}
  <div bind:this={menuEl} class="row-menu" role="menu" aria-label={label} style:left="{at.x}px" style:top="{at.y}px">
    {#each items as it, i (it.id ?? `sep-${i}`)}
      {#if it.separator}
        <div class="row-menu-sep" role="separator"></div>
      {:else}
        <button role="menuitem" class="row-menu-item" class:danger={it.danger} disabled={it.disabled} title={it.title} onclick={() => pick(it)}>{it.label}</button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .row-menu-btn {
    flex: none;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--t2);
    cursor: pointer;
    transition: background 0.12s, color 0.12s, opacity 0.12s;
  }
  .row-menu-btn.compact {
    width: 20px;
    height: 20px;
    border-radius: 4px;
  }
  .row-menu-btn:hover,
  .row-menu-btn.open {
    background: var(--accent-soft);
    color: var(--text);
  }
  .row-menu-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .row-menu {
    position: fixed;
    z-index: 90;
    min-width: 200px;
    padding: 4px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--panel);
    box-shadow: var(--edge);
    animation: row-menu-in 0.12s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes row-menu-in {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .row-menu {
      animation: none;
    }
  }
  .row-menu-item {
    display: flex;
    align-items: center;
    width: 100%;
    height: 30px;
    padding: 0 10px;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--text);
    font-size: 12.5px;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .row-menu-item:hover,
  .row-menu-item:focus-visible {
    background: var(--accent-soft);
    outline: none;
  }
  .row-menu-item.danger {
    color: var(--warn);
  }
  .row-menu-item:disabled {
    color: var(--t3);
    cursor: default;
    background: none;
  }
  .row-menu-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--line);
  }
</style>
