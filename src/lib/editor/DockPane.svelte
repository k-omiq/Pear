<script>
  // ===== The column down the right =====
  //
  // Whatever the layout docks (layouts.svelte.js) sits here, one above the
  // other: the Text box options on top, the text queue under them. In a
  // translate chapter the queue is the typing pane (TranslatePane), header and
  // all. The page keeps the rest of the window; the canvas is inset by this
  // column's width exactly as it is by the sidebar's, so fit measures the part
  // of the window the page actually has.
  //
  // Both edges are the user's: the left one sets the width, the one between
  // the two panes sets how the height is shared. Both are kept on this
  // computer. The width keeps the typing pane's old key, so a width set before
  // layouts existed still stands.
  import { onMount } from 'svelte';
  import Queue from '../Queue.svelte';
  import Inspector from '../Inspector.svelte';
  import TranslatePane from './TranslatePane.svelte';
  import { isTranslateChapter, setLayoutField, page, pageProgress } from '../store.svelte.js';
  import { brushArmed } from '../brush-tool.svelte.js';
  import { isComics } from '../prefs.svelte.js';

  // `width` is the user's (stored); `shown` is what the editor has room for
  // beside the raw sidebar (insets.js), never more than `width`.
  let { width = $bindable(420), shown = null, options = false, queue = false, onSettings } = $props();

  // ---------- the width ----------
  const KEY = 'mt.translatePane';
  const MIN = 320;
  // The page keeps at least this much, so it can still be read beside the pane.
  const PAGE_MIN = 360;
  const vw = () => (typeof window === 'undefined' ? 1440 : window.innerWidth);
  const maxW = () => Math.max(MIN, vw() - PAGE_MIN);
  const clampW = (w) => Math.round(Math.min(maxW(), Math.max(MIN, w)));
  const defaultW = () => clampW(vw() * 0.4);

  // ---------- the share of the height (options on top) ----------
  const SPLIT_KEY = 'mt.dockSplit';
  const PANE_MIN = 140;
  let share = $state(0.5);
  const clampShare = (v) => Math.min(0.85, Math.max(0.15, v));

  function read(key) {
    try {
      return Number(localStorage.getItem(key));
    } catch {
      return NaN; /* private window, blocked storage: the default stands */
    }
  }
  function write(key, v) {
    try {
      localStorage.setItem(key, String(v));
    } catch {
      /* the column still works for this session */
    }
  }
  onMount(() => {
    const w = read(KEY);
    width = Number.isFinite(w) && w > 0 ? clampW(w) : defaultW();
    const s = read(SPLIT_KEY);
    if (Number.isFinite(s) && s > 0 && s < 1) share = clampShare(s);
  });

  let dragging = $state(false);
  function drag(e, kind) {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const w0 = width;
    const s0 = share;
    const h = colEl?.getBoundingClientRect().height || 1;
    dragging = true;
    const move = (ev) => {
      if (kind === 'width') width = clampW(w0 + (x0 - ev.clientX));
      else share = clampShare(s0 + (ev.clientY - y0) / h);
    };
    const up = () => {
      dragging = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (kind === 'width') write(KEY, width);
      else write(SPLIT_KEY, share);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  function onWidthKey(e) {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') width = clampW(width + step);
    else if (e.key === 'ArrowRight') width = clampW(width - step);
    else if (e.key === 'Home') width = clampW(maxW());
    else if (e.key === 'End') width = MIN;
    else return;
    e.preventDefault();
    e.stopPropagation();
    write(KEY, width);
  }
  function onShareKey(e) {
    const step = e.shiftKey ? 0.1 : 0.03;
    if (e.key === 'ArrowUp') share = clampShare(share - step);
    else if (e.key === 'ArrowDown') share = clampShare(share + step);
    else return;
    e.preventDefault();
    e.stopPropagation();
    write(SPLIT_KEY, share);
  }
  function resetWidth() {
    width = defaultW();
    write(KEY, width);
  }
  function resetShare() {
    share = 0.5;
    write(SPLIT_KEY, share);
  }
  const onResize = () => (width = clampW(width));

  let colEl = $state(null);
  const both = $derived(options && queue);
  const translate = $derived(isTranslateChapter());
  const progress = $derived(pageProgress(page()));
  const optionsTitle = $derived(brushArmed() ? 'Brush' : 'Text box options');
  const queueTitle = $derived(isComics() ? 'Text queue' : 'Text list');
</script>

<svelte:window onresize={onResize} />

<aside class="dock" class:dragging style="width:{shown ?? width}px" aria-label="Docked panes" bind:this={colEl}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="dock-edge"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize the page and the docked panes"
    aria-valuenow={width}
    aria-valuemin={MIN}
    aria-valuemax={maxW()}
    tabindex="0"
    title="Drag to resize · double-click to reset"
    onpointerdown={(e) => drag(e, 'width')}
    onkeydown={onWidthKey}
    ondblclick={resetWidth}
  ></div>

  {#if options}
    <section class="dock-sec" style={both ? `flex:0 0 calc(${(share * 100).toFixed(2)}% - 3px); min-height:${PANE_MIN}px` : ''} aria-label={optionsTitle}>
      <header class="dock-head">
        <span class="dock-title">{optionsTitle}</span>
        <button class="dock-float" aria-label="Float {optionsTitle}" title="Float {optionsTitle}" onclick={() => setLayoutField('options', 'floating')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="13" height="13" rx="2" /><path d="M10 3h11v11" /><path d="M21 3l-8 8" /></svg>
        </button>
      </header>
      <div class="dock-body">
        <Inspector {onSettings} />
      </div>
    </section>
  {/if}

  {#if both}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="dock-split"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Share the height between the options and the queue"
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={15}
      aria-valuemax={85}
      tabindex="0"
      title="Drag to resize · double-click to reset"
      onpointerdown={(e) => drag(e, 'share')}
      onkeydown={onShareKey}
      ondblclick={resetShare}
    ></div>
  {/if}

  {#if queue}
    <section class="dock-sec dock-grow" style={both ? `min-height:${PANE_MIN}px` : ''} aria-label={queueTitle}>
      {#if translate}
        <TranslatePane onfloat={() => setLayoutField('queue', 'floating')} />
      {:else}
        <header class="dock-head">
          <span class="dock-title">{queueTitle}</span>
          <span class="dock-count">{progress.placed} / {progress.total} placed</span>
          <button class="dock-float" aria-label="Float the text queue" title="Float the text queue" onclick={() => setLayoutField('queue', 'floating')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="13" height="13" rx="2" /><path d="M10 3h11v11" /><path d="M21 3l-8 8" /></svg>
          </button>
        </header>
        <div class="dock-body">
          <Queue />
        </div>
      {/if}
    </section>
  {/if}
</aside>

<style>
  .dock {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 25;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--panel);
    border-left: 1px solid var(--line2);
  }
  .dock.dragging {
    user-select: none;
    -webkit-user-select: none;
  }
  /* The edge is the handle: wider than it looks, so it is easy to catch. */
  .dock-edge {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -5px;
    width: 10px;
    cursor: col-resize;
    z-index: 2;
    touch-action: none;
  }
  .dock-edge::after,
  .dock-split::after {
    content: '';
    position: absolute;
    background: transparent;
    transition: background 0.15s;
  }
  .dock-edge::after {
    top: 0;
    bottom: 0;
    left: 4px;
    width: 2px;
  }
  .dock-edge:hover::after,
  .dock.dragging .dock-edge::after,
  .dock-edge:focus-visible::after,
  .dock-split:hover::after,
  .dock-split:focus-visible::after {
    background: var(--accent);
  }
  .dock-edge:focus-visible,
  .dock-split:focus-visible {
    outline: none;
  }
  .dock-sec {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }
  .dock-split {
    position: relative;
    flex: 0 0 6px;
    cursor: row-resize;
    touch-action: none;
    border-top: 1px solid var(--line2);
  }
  .dock-split::after {
    left: 0;
    right: 0;
    top: -1px;
    height: 2px;
  }
  .dock-head {
    flex: 0 0 auto;
    height: 32px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 6px 0 12px;
    border-bottom: 1px solid var(--line);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--t2);
    user-select: none;
  }
  .dock-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dock-count {
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
    color: var(--t2);
    background: var(--surface);
    border: 1px solid var(--line);
    padding: 1px 7px;
    border-radius: 10px;
  }
  .dock-float {
    width: 24px;
    height: 24px;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
  }
  .dock-float:hover {
    background: var(--panel2);
    color: var(--text);
  }
  .dock-float:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .dock-float svg {
    width: 14px;
    height: 14px;
  }
  .dock-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }
</style>
