<script>
  // ===== The typing pane of a translate chapter =====
  //
  // A translate chapter is the page, numbered bubble by bubble in reading order
  // (BubbleNumbers), and this pane, where each number's English is typed: the
  // queue (Queue.svelte) given room, plus what a translator needs around it -
  // where they are, how far through, which way the series reads, the cleaned
  // pages once the typesetting tools are out, and the keys.
  //
  // Where it sits is the layout's (layouts.svelte.js): docked in the column
  // down the right (DockPane.svelte), or in the floating queue window. Either
  // way it is the same pane. `onfloat`, given by the dock, is the header's way
  // to the floating window.
  //
  // The never-read chapter's first detection is AutoDetect.svelte's, so it runs
  // wherever the pane is, and with the window hidden too.
  import Queue from '../Queue.svelte';
  import {
    app,
    page,
    translatedCount,
    chapterProgress,
    readingDirection,
    typesetToolsShown,
  } from '../store.svelte.js';
  import { sidecarReady, detectAllPages, detectCurrentPage } from '../sidecar.js';
  import { isComics } from '../prefs.svelte.js';
  import { comboFor, defaultCombo, formatCombo } from '../shortcuts.svelte.js';

  let { onfloat = null } = $props();

  // ---------- where the translator is ----------
  const p = $derived(page());
  const pageDone = $derived(translatedCount(p.lines));
  const chapter = $derived(chapterProgress(app.pages));
  const share = $derived(chapter.total ? chapter.translated / chapter.total : 0);
  const rtl = $derived(readingDirection() === 'rtl');
  const typesetKey = $derived(formatCombo(comboFor('translate.typesetTools')));
  const tools = $derived(typesetToolsShown());

  // ---------- detection ----------
  const engineReady = $derived(sidecarReady());
  const batch = $derived(app.detectBatch);

  // ---------- the keys ----------
  let keysOpen = $state(false);
  const k = (id) => formatCombo(comboFor(id));
  // ⌥1–9 while the tag keys are the default run; once any is rebound, the
  // first and last as they are now.
  function tagRange() {
    const ids = Array.from({ length: 9 }, (_, i) => `translate.tag${i + 1}`);
    if (ids.every((id) => comboFor(id) === defaultCombo(id))) return `${k('translate.tag1')}–9`;
    return `${k(ids[0])} … ${k(ids[8])}`;
  }
  const keyRows = $derived([
    ['Next line, on to the next page', [k('translate.next'), k('translate.nextAlt')]],
    ['Previous line', [k('translate.prev')]],
    ['Line break in the English', [formatCombo('Shift+Enter')]],
    ['Leave the field', [k('translate.leave')]],
    ['Step lines, outside a field', [k('translate.lineDown'), k('translate.lineUp')]],
    ['Back into the line, outside a field', [k('translate.edit')]],
    ['Turn the page, outside a field', [k('translate.pagePrev'), k('translate.pageNext')]],
    ['Delete the line, outside a field', [k('line.delete')]],
    ['Toggle tag 1 to 9', [tagRange()]],
    ['Find or add a tag', [k('translate.tagPicker')]],
    ['Clear the line’s tags', [k('translate.clearTags')]],
    ['Speaker', [k('translate.speaker')]],
    ['Source text', [k('translate.source')]],
    ['Page note', [k('translate.note')]],
    ['Show or hide the typesetting tools', [typesetKey]],
    ['Every command', [k('palette.open')]],
  ]);

  // The cleaned pages, in place of a raw sidebar: with the typesetting tools
  // out, one switch swaps the page between the raw and its cleaned version.
  // Offered once any page has a cleaned file; a page without one stays raw.
  const hasCleaned = $derived(app.pages.some((q) => q.cleaned || q.cleanedFile));
  const pageCleaned = $derived(!!(p.cleaned || p.cleanedFile));
</script>

<section class="tpane" aria-label="Translation">
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
      {#if tools && hasCleaned}
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
      <button class="tpane-btn icon" class:on={keysOpen} aria-pressed={keysOpen} aria-label="Keyboard keys" title="Keyboard keys" onclick={() => (keysOpen = !keysOpen)}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></svg>
      </button>
      {#if onfloat}
        <button class="tpane-btn icon" aria-label="Float the text queue" title="Float the text queue" onclick={onfloat}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="13" height="13" rx="2" /><path d="M10 3h11v11" /><path d="M21 3l-8 8" /></svg>
        </button>
      {/if}
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
        {#if !isComics()}
          <strong>No text on this page yet</strong>
          <span>Add text in the list below.</span>
        {:else if engineReady}
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
</section>

<style>
  .tpane {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    height: 100%;
    min-height: 0;
    min-width: 0;
    background: var(--panel);
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
