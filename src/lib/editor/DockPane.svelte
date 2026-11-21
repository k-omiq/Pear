<script>
  // ===== The column down the right =====
  //
  // The docked text queue (layouts.svelte.js) sits here. Only the queue: the
  // Text box options and the AI chat are always windows. In a translate
  // chapter the queue is the typing pane (TranslatePane), header and all. The page keeps the rest of the window; the canvas is inset by this
  // column's width exactly as it is by the sidebar's, so fit measures the part
  // of the window the page actually has.
  //
  // The left edge sets the width, kept on this computer. The width keeps the typing pane's old key, so a width set before
  // layouts existed still stands.
  import { onMount } from 'svelte';
  import Queue from '../Queue.svelte';
  import TranslatePane from './TranslatePane.svelte';
  import { isTranslateChapter, setLayoutField, page, pageProgress } from '../store.svelte.js';
  import { isComics } from '../prefs.svelte.js';

  // `width` is the user's (stored); `shown` is what the editor has room for
  // beside the raw sidebar (insets.js), never more than `width`.
  let { width = $bindable(420), shown = null } = $props();

  // ---------- the width ----------
  const KEY = 'mt.translatePane';
  const MIN = 320;
  // The page keeps at least this much, so it can still be read beside the pane.
  const PAGE_MIN = 360;
  const vw = () => (typeof window === 'undefined' ? 1440 : window.innerWidth);
  const maxW = () => Math.max(MIN, vw() - PAGE_MIN);
  const clampW = (w) => Math.round(Math.min(maxW(), Math.max(MIN, w)));
  const defaultW = () => clampW(vw() * 0.4);

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
  });

  let dragging = $state(false);
  function drag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    dragging = true;
    const move = (ev) => (width = clampW(w0 + (x0 - ev.clientX)));
    const up = () => {
      dragging = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      write(KEY, width);
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
  function resetWidth() {
    width = defaultW();
    write(KEY, width);
  }
  const onResize = () => (width = clampW(width));

  const translate = $derived(isTranslateChapter());
  const progress = $derived(pageProgress(page()));
  const queueTitle = $derived(isComics() ? 'Text queue' : 'Text list');
</script>

<svelte:window onresize={onResize} />

<aside class="dock" class:dragging style="width:{shown ?? width}px" aria-label={queueTitle}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="dock-edge"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize the page and the docked queue"
    aria-valuenow={width}
    aria-valuemin={MIN}
    aria-valuemax={maxW()}
    tabindex="0"
    title="Drag to resize · double-click to reset"
    onpointerdown={drag}
    onkeydown={onWidthKey}
    ondblclick={resetWidth}
  ></div>

  <section class="dock-sec">
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
  .dock-edge::after {
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
  .dock-edge:focus-visible::after {
    background: var(--accent);
  }
  .dock-edge:focus-visible {
    outline: none;
  }
  .dock-sec {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
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
    border-radius: 999px;
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
