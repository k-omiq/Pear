<script>
  // ===== The typing pane of a translate chapter =====
  //
  // A translate chapter is two halves: the page on the left, numbered bubble by
  // bubble in reading order (BubbleNumbers), and this pane on the right, where
  // each number's English is typed. The split between them is the user's: the
  // edge drags (and takes the arrow keys), and the width is kept on this
  // computer.
  //
  // The pane is the queue (Queue.svelte) given room, plus what a translator
  // needs around it: where they are, how far through, which way the series
  // reads, the typesetting tools behind one switch, and the keys.
  //
  // Detection runs on its own the first time a chapter that has never been read
  // is opened, because a translate chapter with no lines has nothing to type
  // against.
  import { onMount, untrack } from 'svelte';
  import Queue from '../Queue.svelte';
  import {
    app,
    page,
    translatedCount,
    chapterProgress,
    readingDirection,
    setTranslateTypeset,
    toast,
  } from '../store.svelte.js';
  import { sidecarReady, detectAllPages, detectCurrentPage } from '../sidecar.js';
  import { comboFor, formatCombo } from '../shortcuts.svelte.js';

  let { width = $bindable(420) } = $props();

  // ---------- the split ----------
  const KEY = 'mt.translatePane';
  const MIN = 320;
  // The page keeps at least this much, so it can still be read beside the pane.
  const PAGE_MIN = 360;
  const maxW = () => Math.max(MIN, (typeof window === 'undefined' ? 1440 : window.innerWidth) - PAGE_MIN);
  const clampW = (w) => Math.round(Math.min(maxW(), Math.max(MIN, w)));
  const defaultW = () => clampW((typeof window === 'undefined' ? 1440 : window.innerWidth) * 0.4);

  function load() {
    let saved = null;
    try {
      saved = Number(localStorage.getItem(KEY));
    } catch {
      /* private window, blocked storage: the default stands */
    }
    width = Number.isFinite(saved) && saved > 0 ? clampW(saved) : defaultW();
  }
  function save() {
    try {
      localStorage.setItem(KEY, String(width));
    } catch {
      /* the split still works for this session */
    }
  }
  onMount(load);

  let dragging = $state(false);
  function onSplitDown(e) {
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
      save();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  function onSplitKey(e) {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') width = clampW(width + step);
    else if (e.key === 'ArrowRight') width = clampW(width - step);
    else if (e.key === 'Home') width = clampW(maxW());
    else if (e.key === 'End') width = MIN;
    else return;
    e.preventDefault();
    e.stopPropagation();
    save();
  }
  function resetSplit() {
    width = defaultW();
    save();
  }
  const onResize = () => (width = clampW(width));

  // ---------- where the translator is ----------
  const p = $derived(page());
  const pageDone = $derived(translatedCount(p.lines));
  const chapter = $derived(chapterProgress(app.pages));
  const share = $derived(chapter.total ? chapter.translated / chapter.total : 0);
  const rtl = $derived(readingDirection() === 'rtl');
  const typesetKey = $derived(formatCombo(comboFor('translate.typesetTools')));

  // ---------- detection ----------
  const engineReady = $derived(sidecarReady());
  const neverRead = $derived(app.pages.length > 0 && !app.pages.some((q) => q.detect || q.lines?.length));
  const batch = $derived(app.detectBatch);

  // Once per chapter opened: a chapter nobody has detected yet is detected now.
  // A chapter that has lines from anywhere (a JSON import, a previous run) is
  // never re-read behind the user's back - that is the Detect menu's job.
  const tried = new Set();
  $effect(() => {
    const ref = app.chapterRef;
    const ready = engineReady;
    const fresh = neverRead;
    if (!ref || !app.loaded) return;
    const key = `${ref.projectId}/${ref.chapterId}`;
    untrack(() => {
      if (tried.has(key) || app.detecting) return;
      if (!fresh) return void tried.add(key);
      if (!ready) return;
      tried.add(key);
      detectAllPages();
    });
  });

  // ---------- the keys ----------
  let keysOpen = $state(false);
  const k = (id) => formatCombo(comboFor(id));
  const keyRows = $derived([
    ['Next line, on to the next page', ['↵', 'Tab']],
    ['Previous line', [formatCombo('Shift+Tab')]],
    ['Line break in the English', [formatCombo('Shift+Enter')]],
    ['Leave the field', ['Esc']],
    ['Step lines, outside a field', ['↑', '↓']],
    ['Turn the page, outside a field', ['←', '→']],
    ['Toggle tag 1 to 9', [`${formatCombo('Alt+1').replace(/1$/, '')}1–9`]],
    ['Find or add a tag', [k('translate.tagPicker')]],
    ['Clear the line’s tags', [k('translate.clearTags')]],
    ['Speaker', [k('translate.speaker')]],
    ['Source text', [k('translate.source')]],
    ['Page note', [k('translate.note')]],
    ['Typesetting tools', [typesetKey]],
    ['Every command', [k('palette.open')]],
  ]);

  // The cleaned pages, in place of a raw sidebar: with the typesetting tools
  // out, one switch swaps the page between the raw and its cleaned version.
  // Offered once any page has a cleaned file; a page without one stays raw.
  const hasCleaned = $derived(app.pages.some((q) => q.cleaned || q.cleanedFile));
  const pageCleaned = $derived(!!(p.cleaned || p.cleanedFile));

  function toggleTypeset() {
    setTranslateTypeset(!app.translateTypeset);
    toast(app.translateTypeset ? 'Typesetting tools shown' : 'Typesetting tools hidden');
  }
</script>

<svelte:window onresize={onResize} />

<aside class="tpane" class:dragging style="width:{width}px" aria-label="Translation">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="tpane-split"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize the page and the typing pane"
    aria-valuenow={width}
    aria-valuemin={MIN}
    aria-valuemax={maxW()}
    tabindex="0"
    title="Drag to resize · double-click to reset"
    onpointerdown={onSplitDown}
    onkeydown={onSplitKey}
    ondblclick={resetSplit}
  ></div>

  <header class="tpane-head">
    <div class="tpane-where">
      <span class="tpane-page">Page {app.pageIndex + 1}{" "}<span class="tpane-of">of {app.pages.length}</span></span>
      <span class="tpane-count">{pageDone} / {p.lines.length} on this page</span>
    </div>
    <div class="tpane-tools">
      <span class="tpane-dir" title={rtl ? 'Bubbles are numbered right to left, top to bottom (manga)' : 'Bubbles are numbered left to right, top to bottom (manhwa, manhua)'}>
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          {#if rtl}<path d="M13 8H3" /><path d="M6.5 4.5 3 8l3.5 3.5" />{:else}<path d="M3 8h10" /><path d="M9.5 4.5 13 8l-3.5 3.5" />{/if}
        </svg>
        <span class="tpane-dir-text">{rtl ? 'Right to left' : 'Left to right'}</span>
      </span>
      {#if app.translateTypeset && hasCleaned}
        <button
          class="tpane-btn"
          class:on={app.viewCleaned}
          aria-pressed={app.viewCleaned}
          onclick={() => (app.viewCleaned = !app.viewCleaned)}
          title={app.viewCleaned
            ? 'Showing the cleaned pages - press to show the raws. Hold \\ to peek at the raw'
            : pageCleaned
              ? 'Show the cleaned pages instead of the raws'
              : 'Show the cleaned pages instead of the raws (this page has none yet)'}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 14l3-3 2 2 3-4" /></svg>
          Cleaned
        </button>
      {/if}
      <button
        class="tpane-btn"
        class:on={app.translateTypeset}
        aria-pressed={app.translateTypeset}
        onclick={toggleTypeset}
        title={`${app.translateTypeset ? 'Hide' : 'Show'} the typesetting tools${typesetKey ? ` (${typesetKey})` : ''}`}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7V5h16v2" /><path d="M12 5v14" /><path d="M9 19h6" /></svg>
        Typeset
      </button>
      <button class="tpane-btn icon" class:on={keysOpen} aria-pressed={keysOpen} aria-label="Keyboard keys" title="Keyboard keys" onclick={() => (keysOpen = !keysOpen)}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></svg>
      </button>
    </div>
    <div class="tpane-meter" role="progressbar" aria-label="Chapter translated" aria-valuemin="0" aria-valuemax={chapter.total} aria-valuenow={chapter.translated} title="{chapter.translated} of {chapter.total} lines translated in this chapter">
      <span style="transform:scaleX({share.toFixed(4)})"></span>
    </div>
  </header>

  {#if keysOpen}
    <div class="tpane-keys" role="region" aria-label="Keyboard keys">
      <dl>
        {#each keyRows as [label, keys] (label)}
          <dt>{label}</dt>
          <dd>{#each keys.filter(Boolean) as key, i (i)}<kbd>{key}</kbd>{/each}</dd>
        {/each}
      </dl>
      <p>The Translation keys can be changed in Settings ▸ Keyboard.</p>
    </div>
  {/if}

  <div class="tpane-body">
    {#if app.detecting && batch}
      <div class="tpane-state" aria-live="polite">
        <strong>Reading the chapter</strong>
        <span>Page {Math.min(batch.done + 1, batch.total)} of {batch.total} · each bubble gets its number in reading order</span>
        <span class="tpane-bar"><span style="transform:scaleX({(batch.done / Math.max(1, batch.total)).toFixed(4)})"></span></span>
      </div>
    {:else if app.detecting}
      <div class="tpane-state" aria-live="polite"><strong>Reading this page…</strong></div>
    {:else if p.lines.length === 0}
      <div class="tpane-state">
        {#if engineReady}
          <strong>No text on this page yet</strong>
          <span>Detect finds each bubble, reads it and numbers it {rtl ? 'right to left' : 'left to right'}, top to bottom.</span>
          <span class="tpane-acts">
            <button class="tpane-go" onclick={() => detectCurrentPage()}>Detect this page</button>
            <button class="tpane-btn" onclick={() => detectAllPages()}>Whole chapter</button>
          </span>
        {:else}
          <strong>Detection is not ready</strong>
          <span>The detection engine runs in the desktop app. Once it is up, a chapter that has never been read is read on its own.</span>
        {/if}
      </div>
    {/if}
    <Queue />
  </div>
</aside>

<style>
  .tpane {
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
  .tpane.dragging {
    user-select: none;
    -webkit-user-select: none;
  }
  /* The edge is the handle: wider than it looks, so it is easy to catch. */
  .tpane-split {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -5px;
    width: 10px;
    cursor: col-resize;
    z-index: 2;
    touch-action: none;
  }
  .tpane-split::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 4px;
    width: 2px;
    background: transparent;
    transition: background 0.15s;
  }
  .tpane-split:hover::after,
  .tpane.dragging .tpane-split::after,
  .tpane-split:focus-visible::after {
    background: var(--accent);
  }
  .tpane-split:focus-visible {
    outline: none;
  }

  .tpane-head {
    flex: none;
    container-type: inline-size;
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 6px 12px;
    padding: 14px 16px 0;
  }
  .tpane-where {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .tpane-page {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.005em;
    color: var(--text);
  }
  .tpane-of {
    font-weight: 400;
    color: var(--t2);
  }
  .tpane-count {
    font-size: 11.5px;
    color: var(--t2);
    font-variant-numeric: tabular-nums;
  }
  .tpane-tools {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tpane-dir {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 8px;
    font-size: 11px;
    color: var(--t2);
    white-space: nowrap;
  }
  /* A narrow pane keeps the arrow and drops the words (the tooltip says it). */
  @container (max-width: 440px) {
    .tpane-dir-text {
      display: none;
    }
  }
  .tpane-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--line2);
    border-radius: 16px;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .tpane-btn.icon {
    width: 28px;
    padding: 0;
    justify-content: center;
  }
  .tpane-btn:hover {
    background: var(--accent-soft);
    border-color: var(--t3);
  }
  .tpane-btn.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
  }
  .tpane-btn:focus-visible,
  .tpane-go:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .tpane-meter {
    grid-column: 1 / -1;
    height: 2px;
    margin: 8px -16px 0;
    background: var(--line);
  }
  .tpane-meter span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left center;
    transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .tpane-keys {
    flex: none;
    max-height: 45%;
    overflow: auto;
    padding: 12px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--panel2);
  }
  .tpane-keys dl {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px 12px;
    margin: 0;
    font-size: 11.5px;
  }
  .tpane-keys dt {
    color: var(--t2);
  }
  .tpane-keys dd {
    margin: 0;
    display: flex;
    gap: 4px;
    justify-content: flex-end;
  }
  .tpane-keys p {
    margin: 10px 0 0;
    font-size: 11px;
    color: var(--t3);
  }
  kbd {
    display: inline-flex;
    align-items: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    justify-content: center;
    border: 1px solid var(--line2);
    border-bottom-width: 2px;
    border-radius: 5px;
    background: var(--surface);
    color: var(--text);
    font: 500 10.5px/1 system-ui, -apple-system, sans-serif;
    white-space: nowrap;
  }

  .tpane-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 4px 6px 0;
  }
  .tpane-state {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 10px 10px 6px;
    padding: 14px;
    border: 1px dashed var(--line2);
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.45;
    color: var(--t2);
  }
  .tpane-state strong {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .tpane-acts {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  .tpane-go {
    height: 28px;
    padding: 0 12px;
    border: 1px solid var(--accent);
    border-radius: 16px;
    background: var(--accent);
    color: var(--accent-fg);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .tpane-bar {
    height: 3px;
    border-radius: 2px;
    background: var(--line2);
    overflow: hidden;
  }
  .tpane-bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left center;
    transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }
</style>
