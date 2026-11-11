<script>
  // ===== The font picker =====
  //
  // Replaces the native font <select>. That menu drew every family's name in
  // its own face, was not searchable, and applied each family the arrow keys
  // passed over as a full edit - a solve, an undo entry, a repaint at full
  // resolution - so walking down a list of a hundred faces was a hundred edits.
  //
  // Here moving through the list only SHOWS the family (`onpreview`, which the
  // Inspector turns into `previewBoxFont`), and nothing is picked until a click
  // or Enter (`onpick`). Escape, or a press outside, closes with nothing
  // picked and the preview taken back. Typing filters. Only the rows in view
  // are in the document, so a long list costs what a short one does.
  import { untrack } from 'svelte';
  import { anchoredOverlay } from './anchored-overlay.svelte.js';
  import { fontGroups, fontCaveat, noteRecentFont, isFontOffered } from './font-menu.js';
  import { fontCssFor } from './store.svelte.js';
  import { prefs } from './prefs.svelte.js';

  /**
   * @type {{
   *   value?: string | null,
   *   label?: string,
   *   id?: string,
   *   unset?: string | null,
   *   compact?: boolean,
   *   onpick: (name: string | null) => void,
   *   onpreview?: (name: string | null) => void,
   *   keepsEdit?: boolean,
   * }}
   */
  // `keepsEdit`: the list may take the focus from a box being typed into
  // without ending its edit (typing-selection.svelte.js), as the Inspector's
  // family control does while it sets the face of selected words.
  let { value = null, label = 'Font', id, unset = null, compact = false, onpick, onpreview, keepsEdit = false } = $props();

  /** @type {HTMLElement | undefined} */
  let root = $state();
  /** @type {HTMLElement | undefined} */
  let panel = $state();
  /** @type {HTMLInputElement | undefined} */
  let search = $state();
  /** @type {HTMLElement | undefined} */
  let scroller = $state();

  const listId = $props.id();
  const overlay = anchoredOverlay(
    () => root,
    () => panel,
  );
  const open = $derived(overlay.open);

  let query = $state('');
  let active = $state(-1);
  let scrollTop = $state(0);
  let floating = $state({ x: 0, y: 0, w: 260 });

  const ROW = 30;
  const HEAD = 24;
  const VIEW = 340;

  // The rows, in order: headings and fonts. `css` is what the name is drawn in.
  const rows = $derived.by(() => {
    if (!open) return [];
    const q = query.trim().toLowerCase();
    const out = [];
    const font = (name, css, note = null) => out.push({ kind: 'font', name, css, note });
    if (unset != null && !q) font(null, null, unset);
    if (!q && value && fontCaveat(value)) font(value, fontCssFor(value), fontCaveat(value));
    const groups = fontGroups();
    if (!q) {
      const recent = prefs.recentFonts.filter((n) => isFontOffered(n));
      if (recent.length) {
        out.push({ kind: 'head', label: 'Recent' });
        for (const n of recent) font(n, fontCssFor(n));
      }
    }
    for (const g of groups) {
      const fonts = q ? g.fonts.filter((f) => f.name.toLowerCase().includes(q)) : g.fonts;
      if (!fonts.length) continue;
      out.push({ kind: 'head', label: g.label });
      for (const f of fonts) font(f.name, f.css);
    }
    let y = 0;
    for (const r of out) {
      r.y = y;
      y += r.kind === 'head' ? HEAD : ROW;
    }
    return out;
  });
  const total = $derived(rows.length ? rows[rows.length - 1].y + (rows[rows.length - 1].kind === 'head' ? HEAD : ROW) : 0);
  // The rows in view, and a screenful either side.
  const shown = $derived.by(() => {
    const lo = scrollTop - VIEW;
    const hi = scrollTop + VIEW * 2;
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.y + ROW < lo) continue;
      if (r.y > hi) break;
      out.push(i);
    }
    return out;
  });

  const pickable = (i) => rows[i]?.kind === 'font';
  function step(from, dir) {
    for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (pickable(i)) return i;
    return from;
  }

  // One preview per frame, the latest wins: the picture is repainted at most
  // as often as the screen can show it, however fast the keys repeat.
  //
  // A held arrow key is different: each family is new to the text engine, and
  // painting one costs more than the key repeat leaves, so the list would
  // crawl behind the key. While the key repeats the list moves alone and the
  // box shows the family the keys stop on (`HELD_MS` after the last repeat).
  const HELD_MS = 120;
  let frame = 0;
  let held = 0;
  let wanted = undefined;
  function preview(name, { repeat = false } = {}) {
    if (!onpreview) return;
    wanted = name;
    clearTimeout(held);
    held = 0;
    if (repeat) {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      held = setTimeout(() => {
        held = 0;
        preview(wanted);
      }, HELD_MS);
      return;
    }
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      onpreview(wanted ?? value);
    });
  }
  function stopPreview() {
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(held);
    frame = 0;
    held = 0;
    onpreview?.(null);
  }

  function setActive(i, { scroll = true, repeat = false } = {}) {
    if (!pickable(i)) return;
    active = i;
    const name = rows[i].name;
    if (name) preview(name, { repeat });
    if (scroll && scroller) {
      const r = rows[i];
      if (r.y < scroller.scrollTop) scroller.scrollTop = r.y;
      else if (r.y + ROW > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = r.y + ROW - scroller.clientHeight;
    }
  }

  // A row under a pointer that has not moved is not a choice: the list
  // scrolling under a resting pointer sends moves too, and those took the
  // highlight back from the arrow keys.
  let pointerAt = '';
  function hover(e, i) {
    const at = `${e.clientX},${e.clientY}`;
    if (at === pointerAt) return;
    pointerAt = at;
    if (i !== active) setActive(i, { scroll: false });
  }

  function pick(i) {
    const r = rows[i];
    if (!r || r.kind !== 'font') return;
    stopPreview();
    overlay.close();
    if (r.name) noteRecentFont(r.name);
    if (r.name !== value) onpick(r.name);
  }

  function openPanel(seed = '') {
    query = seed;
    overlay.show();
  }
  // Opened by its owner, for a command that asks for a family ("Typeface…").
  export function openList() {
    if (!open) openPanel();
  }

  // On open: the list starts at the family the box is in, and the search has
  // the keys.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      const at = rows.findIndex((r) => r.kind === 'font' && r.name === value);
      active = at >= 0 ? at : step(-1, 1);
      queueMicrotask(() => {
        search?.focus();
        if (scroller && at >= 0) scroller.scrollTop = Math.max(0, rows[at].y - VIEW / 2 + ROW / 2);
      });
    });
  });
  // Closed by any route - a pick, Escape, a press outside: the look ends.
  $effect(() => {
    if (open) return;
    untrack(() => {
      if (frame || wanted !== undefined) stopPreview();
      wanted = undefined;
      query = '';
    });
  });
  $effect(() => () => {
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(held);
    if (wanted !== undefined) onpreview?.(null);
  });

  // A filter that drops the active row moves to the first that is left.
  $effect(() => {
    query;
    untrack(() => {
      if (!pickable(active)) active = step(-1, 1);
      if (scroller) scroller.scrollTop = 0;
      scrollTop = 0;
    });
  });

  $effect(() => {
    if (!open || !root || !panel) return;
    const position = () => {
      const t = root.getBoundingClientRect();
      const w = Math.max(240, t.width);
      const h = panel.offsetHeight || VIEW + 48;
      const vw = globalThis.innerWidth || w + 16;
      const vh = globalThis.innerHeight || h + 16;
      const below = t.bottom + 4;
      const above = t.top - h - 4;
      floating = {
        x: Math.max(8, Math.min(vw - w - 8, t.left)),
        y: below + h <= vh - 8 ? below : above >= 8 ? above : Math.max(8, vh - h - 8),
        w,
      };
    };
    position();
    globalThis.addEventListener?.('resize', position);
    globalThis.addEventListener?.('scroll', position, true);
    return () => {
      globalThis.removeEventListener?.('resize', position);
      globalThis.removeEventListener?.('scroll', position, true);
    };
  });

  /** @param {HTMLElement} node */
  function portal(node) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  /** @param {KeyboardEvent} e */
  function onSearchKey(e) {
    if (overlay.dismissKey(e)) return;
    const page = Math.max(1, Math.floor(VIEW / ROW) - 1);
    let next = null;
    if (e.key === 'ArrowDown') next = step(active, 1);
    else if (e.key === 'ArrowUp') next = step(active, -1);
    else if (e.key === 'PageDown') {
      next = active;
      for (let k = 0; k < page; k++) next = step(next, 1);
    } else if (e.key === 'PageUp') {
      next = active;
      for (let k = 0; k < page; k++) next = step(next, -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    setActive(next, { repeat: e.repeat });
  }

  /** @param {KeyboardEvent} e */
  function onTriggerKey(e) {
    if (open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPanel();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      openPanel(e.key);
    }
  }

  const caveat = $derived(value ? fontCaveat(value) : null);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fp" class:compact bind:this={root} onfocusout={(e) => overlay.focusOut(e)}>
  <button
    type="button"
    {id}
    class="fp-trigger"
    aria-label={label}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={open ? listId : undefined}
    title={value ?? unset ?? ''}
    onclick={() => (open ? overlay.close() : openPanel())}
    onkeydown={onTriggerKey}
  >
    {#if value}
      <span class="fp-name" style="font-family:{fontCssFor(value)}">{value}</span>
      {#if caveat}<span class="fp-note">({caveat})</span>{/if}
    {:else}
      <span class="fp-name fp-unset">{unset ?? '-'}</span>
    {/if}
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={panel}
      use:portal
      class="fp-panel"
      data-keeps-edit={keepsEdit || undefined}
      style:left="{floating.x}px"
      style:top="{floating.y}px"
      style:width="{floating.w}px"
      onfocusout={(e) => overlay.focusOut(e)}
    >
      <input
        bind:this={search}
        bind:value={query}
        class="fp-search"
        type="text"
        placeholder="Search fonts"
        aria-label="Search fonts"
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        onkeydown={onSearchKey}
      />
      <div
        bind:this={scroller}
        class="fp-list"
        id={listId}
        role="listbox"
        aria-label={label}
        tabindex="-1"
        style:max-height="{VIEW}px"
        onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
      >
        <div class="fp-space" style:height="{total}px">
          {#each shown as i (i)}
            {@const r = rows[i]}
            {#if r.kind === 'head'}
              <div class="fp-head" style:top="{r.y}px">{r.label}</div>
            {:else}
              <!-- The keys are the search field's (aria-activedescendant): a
                   row is never focused, so it has no key handler of its own. -->
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                id="{listId}-{i}"
                class="fp-row"
                class:on={i === active}
                class:cur={r.name === value}
                role="option"
                tabindex="-1"
                aria-selected={r.name === value}
                style:top="{r.y}px"
                onpointermove={(e) => hover(e, i)}
                onpointerdown={(e) => e.preventDefault()}
                onclick={() => pick(i)}
              >
                {#if r.name}
                  <span class="fp-name" style="font-family:{r.css}">{r.name}</span>
                  {#if r.note}<span class="fp-note">({r.note})</span>{/if}
                {:else}
                  <span class="fp-name fp-unset">{r.note}</span>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
        {#if !rows.some((r) => r.kind === 'font')}
          <div class="fp-empty">No font matches "{query}"</div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .fp {
    position: relative;
    min-width: 0;
    width: 100%;
  }
  .fp-trigger {
    -webkit-appearance: none;
    appearance: none;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 28px;
    padding: 0 24px 0 8px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background-color: var(--surface);
    background-image:
      linear-gradient(45deg, transparent 50%, var(--t2) 50%),
      linear-gradient(135deg, var(--t2) 50%, transparent 50%);
    background-position:
      calc(100% - 14px) calc(50% - 1px),
      calc(100% - 10px) calc(50% - 1px);
    background-size: 4px 4px;
    background-repeat: no-repeat;
    color: var(--text);
    font-size: 14px;
    text-align: left;
    cursor: pointer;
    outline: none;
  }
  .compact .fp-trigger {
    height: 24px;
    border-radius: 5px;
    padding-left: 5px;
    font-size: 11.5px;
  }
  .fp-trigger:focus-visible,
  .fp-trigger[aria-expanded='true'] {
    border-color: var(--accent);
  }
  .fp-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fp-unset {
    color: var(--t2);
  }
  .fp-note {
    flex: none;
    font-size: 11px;
    color: var(--t2);
    font-family: var(--ui-font, inherit);
  }

  .fp-panel {
    position: fixed;
    z-index: 80;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--edge);
  }
  .fp-search {
    height: 28px;
    width: 100%;
    padding: 0 8px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
    outline: none;
  }
  .fp-search:focus {
    border-color: var(--accent);
  }
  .fp-list {
    position: relative;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .fp-space {
    position: relative;
  }
  .fp-head,
  .fp-row {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
  }
  .fp-head {
    height: 24px;
    padding: 6px 8px 0;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--t2);
  }
  .fp-row {
    gap: 6px;
    height: 30px;
    padding: 0 8px;
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;
  }
  .fp-row.on {
    background: var(--accent-soft);
  }
  .fp-row.cur::after {
    content: '';
    flex: none;
    margin-left: auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
  .fp-empty {
    padding: 10px 8px;
    font-size: 12px;
    color: var(--t2);
  }
</style>
