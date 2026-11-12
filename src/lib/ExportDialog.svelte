<script>
  import { app, saveExportPrefs, isLongstrip, checks, openCheck, normalizeExportScale } from './store.svelte.js';
  import { exportImages, exportPreflight, scaleBlock, stripSliceBlock } from './exporter.js';
  import { SLICE_H_MIN, SLICE_H_MAX, SLICE_H_DEFAULT } from './editor/strip-cuts.js';
  import { maxPageWidth } from './editor/strip.js';
  import { projectById, setProjectExportScale } from './library.svelte.js';

  const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

  // JSON exports detected/typeset text as one document.
  const isJson = $derived(app.fmt === 'JSON');
  // Longstrip raster export re-cuts column for non-PSD/JSON formats.
  const isStrip = $derived(isLongstrip() && !isJson && app.fmt !== 'PSD');

  // Size: the series' own choice (project.json), Original unless it says 2x.
  const project = $derived(projectById(app.chapterRef?.projectId));
  const stored = $derived(normalizeExportScale(project?.exportScale));
  // Why 2x cannot be written for this chapter in this format, judged on the
  // pages whose size is known (the export measures the rest and asks again).
  // A strip page is a slice the column's width.
  const block2x = $derived(scaleBlock(app.pages, app.fmt, 2, isStrip ? { strip: { width: maxPageWidth(app.pages) } } : {}));
  // What the export is made at: the stored choice where it can be, else the
  // page's own size. JSON has no pixels.
  const scale = $derived(isJson || block2x ? 1 : stored);
  // A whole strip re-cut at this Slice height, at this size: the one thing
  // that can stop All pages while This page can go. The export checks every
  // real cut again before it writes.
  const blockAll = $derived(isStrip ? stripSliceBlock(app.pages, app.fmt, scale, maxPageWidth(app.pages), app.stripSliceH || SLICE_H_DEFAULT) : null);
  let sizeError = $state('');
  async function onSize(v) {
    if (!project || v === stored) return;
    sizeError = '';
    try {
      await setProjectExportScale(project.id, v);
    } catch (e) {
      sizeError = `Could not save the size: ${e?.message ?? e}`;
    }
  }

  let preflight = $state(null);
  let checkError = $state('');
  const needsLook = $derived(!!preflight?.items.length);
  const checkNote = $derived(preflight ? [
    preflight.boxes ? `${preflight.boxes} ${preflight.boxes === 1 ? 'box needs' : 'boxes need'} a look` : '',
    preflight.lines ? `${preflight.lines} ${preflight.lines === 1 ? 'line' : 'lines'} unplaced` : '',
    preflight.text ? `${preflight.text} ${preflight.text === 1 ? 'line needs' : 'lines need'} a look` : '',
  ].filter(Boolean).join(' · ') : '');

  $effect(() => {
    if (!app.exportOpen) {
      preflight = null;
      checkError = '';
      return;
    }
    const pages = app.pages;
    // Subscribe to the shared list, including font arrivals. The async check
    // counts only after the font gate; a superseded answer cannot replace it.
    checks.items;
    app.fontsVersion;
    let current = true;
    exportPreflight(pages).then((result) => {
      if (current) { preflight = result; checkError = ''; }
    }).catch(() => {
      if (current) { preflight = null; checkError = 'Could not finish the check. You can still export.'; }
    });
    return () => { current = false; };
  });

  function showCheck() {
    close();
    openCheck(preflight?.items[0]);
  }

  // Clamp slice height when committed.
  function onSliceH(e) {
    const v = Math.round(Number(e.target.value));
    app.stripSliceH = isFinite(v) && v > 0 ? Math.min(SLICE_H_MAX, Math.max(SLICE_H_MIN, v)) : SLICE_H_DEFAULT;
    e.target.value = String(app.stripSliceH);
  }

  function close() {
    app.exportOpen = false;
  }
  function onOverlayClick(e) {
    if (e.target.classList.contains('modal-overlay')) close();
  }
  function onName(e) {
    saveExportPrefs(null, e.target.value.trim() || 'page');
  }
  async function go(scope) {
    close();

    await exportImages(app.fmt, scope, scale);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-overlay" class:open={app.exportOpen} onclick={onOverlayClick}>
  <div class="modal export-modal">
    <div class="modal-head">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>
      <h3>Export</h3>
      <button class="x" aria-label="Close" onclick={close}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>
    <div class="modal-body">

      <div class="grp">
        <label class="lbl" for="exp-fmt">Format</label>
        <select id="exp-fmt" bind:value={app.fmt}>
          <option>PNG</option><option>JPG</option><option>WebP</option><option>PSD</option><option>JSON</option>
        </select>
      </div>

      <div class="grp">
        <span class="lbl" id="exp-size">Size</span>
        <div class="seg exp-size" role="group" aria-labelledby="exp-size">
          <button class:on={scale === 1} disabled={isJson || !project} onclick={() => onSize(1)}>Original</button>
          <button class:on={scale === 2} disabled={isJson || !project || !!block2x} onclick={() => onSize(2)}>2x</button>
        </div>
        {#if isJson}
          <div class="exp-sub">JSON has text only, no pictures.</div>
        {:else if block2x}
          <div class="exp-sub">{block2x}.</div>
        {:else if scale === 2}
          <div class="exp-sub">Text is sharper. The page is enlarged, not redrawn. Files are about 4 times larger.</div>
        {/if}
        {#if sizeError}<div class="exp-sub">{sizeError}</div>{/if}
      </div>

      <div class="grp">
        <label class="lbl">File name (base)</label>
        <input type="text" value={app.exportName} oninput={onName} placeholder="page" />
        <div class="exp-sub">
          {#if isJson}

            One file - <code>{app.exportName}-text.json</code> for the whole chapter, or
            <code>{app.exportName}-&lt;page&gt;-text.json</code> for a single page - carrying
            the detected text (source + your translation), reading order and box geometry.
          {:else if isStrip}

            All pages: <code>{app.exportName}-strip-01.{app.fmt.toLowerCase()}</code> - this page:
            <code>{app.exportName}-&lt;page&gt;.{app.fmt.toLowerCase()}</code>
          {:else}
            Saved as <code>{app.exportName}-&lt;page&gt;.{app.fmt.toLowerCase()}</code>
          {/if}
        </div>
      </div>

      {#if isStrip}
        <div class="grp">
          <label class="lbl" for="exp-slice">Slice height</label>
          <input
            id="exp-slice"
            type="number"
            min={SLICE_H_MIN}
            max={SLICE_H_MAX}
            step="500"
            value={app.stripSliceH}
            onchange={onSliceH}
          />
          <div class="exp-sub">
            Height of each exported image, in page pixels. Cuts move off this height to avoid
            landing on a text box.
          </div>
        </div>
      {/if}

      <div class="grp">
        <label class="lbl">Output folder</label>
        {#if isTauri}
          <div class="exp-dir">{app.exportDir || 'Not set - you’ll pick on export'}</div>
        {:else}
          <div class="exp-dir warn">Browser preview - files download to your Downloads folder. The native picker works in the desktop app.</div>
        {/if}
      </div>

      <div class="grp">
        <label class="lbl">What to export?</label>
        {#if needsLook}
          <div class="exp-check">
            <span>{checkNote}. Export anyway, or look first.</span>
            <button class="btn" onclick={showCheck}>Show</button>
            {#if app.fmt === 'PSD' && preflight.raster}
              <div class="exp-sub">{preflight.raster} {preflight.raster === 1 ? 'box will' : 'boxes will'} be raster layers in Photoshop.</div>
            {/if}
          </div>
        {/if}
        {#if checkError}<div class="exp-sub">{checkError}</div>{/if}
        <div class="exp-choices">
          <button class="exp-card" onclick={() => go('current')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>
            <div class="t">This page</div>
            <div class="d">Page {app.pageIndex + 1} only</div>
          </button>
          <button class="exp-card" disabled={!!blockAll} onclick={() => go('all')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="13" height="15" rx="2" /><path d="M8 2h11a2 2 0 0 1 2 2v13" /></svg>
            <div class="t">All pages</div>
            <div class="d">
              {#if isStrip}
                Whole strip, re-sliced
              {:else}
                {app.pages.length} {isJson ? 'pages, one file' : 'images'}
              {/if}
            </div>
          </button>
        </div>
        {#if blockAll}<div class="exp-sub">{blockAll}.</div>{/if}
      </div>
    </div>
  </div>
</div>
