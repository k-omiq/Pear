<script>
  // Detection has two scopes and one artefact - more than a pill can hold, so
  // the pill opens this instead. Per-page detection has never had a UI before;
  // it was whole-chapter or nothing, which is a long wait to fix one page.
  import { app } from '../store.svelte.js';
  import { sidecarReady, detectCurrentPage, detectAllPages } from '../sidecar.js';
  import { exportImages } from '../exporter.js';
  import { prefs, setPref } from '../prefs.svelte.js';
  import ReaderChoice from '../ReaderChoice.svelte';

  // The models Detect uses, chosen where Detect is run: the reader for this
  // series' language, and the two optional second passes. The same choices as
  // Settings ▸ Detection, which also has the other languages.
  const LANG = { ja: 'Japanese', zh: 'Chinese', ko: 'Korean' };
  const lang = $derived(app.projectOcrLanguage);

  let { anchor = null, onClose } = $props();

  let menuEl = $state(null);

  // Both detection items ask the engine for work, so both need it up and idle.
  // The functions themselves still refuse and toast when there is no raw image
  // to look at; this only keeps the menu from offering work that cannot start.
  const canDetect = $derived(sidecarReady() && !app.detecting);
  // The JSON *is* detection's output, so there is nothing to save until some
  // page in the chapter carries it.
  const canSaveJson = $derived(app.pages.some((p) => p?.detect));

  // Escape and choosing an item both hand the keyboard back to the pill that
  // opened the menu - otherwise focus falls to the document and the next Tab
  // starts over from the top of the page, which is a long way from here.
  // Dismissal by pointer does not: the pointer has already said where it wants
  // to be.
  function close({ restoreFocus = false } = {}) {
    if (restoreFocus) anchor?.focus();
    onClose?.();
  }

  // Capture, so the menu swallows the key before the editor's own Escape
  // handling deselects a box the user was not trying to let go of.
  // stopImmediatePropagation, not stopPropagation: other window-level capture
  // listeners registered before this one are on the same node and the same
  // phase, and only the immediate form stops those.
  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.stopImmediatePropagation();
    close({ restoreFocus: true });
  }

  // The menu is opened from a pill, so the keyboard has to arrive with it -
  // landing on the first item the user can actually use. Roving arrow-key
  // movement between three items is not worth its own state machine: Tab
  // already walks them in order and Escape gets out.
  function focusFirst(node) {
    node.querySelector('button:not(:disabled)')?.focus();
  }

  // The trigger is spared as well as the menu itself: a pointerdown on the pill
  // would otherwise close the menu a beat before the same gesture's click
  // reopened it, and the pill would look dead on the second press.
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

  // Closed first, then run: detection takes minutes, and a menu hanging open
  // over the canvas for all of it is not a menu any more. Focus goes back to
  // the pill for the same reason Escape sends it there - the item that had it
  // is about to leave the DOM.
  function run(fn) {
    close({ restoreFocus: true });
    fn();
  }

  // The chapter's detected text as one document, through the exporter's single
  // serialiser - the same file the export dialog's JSON format writes, so the
  // two can never drift. Scope is the whole chapter: choosing between scopes is
  // what that dialog is for, and the detection JSON is a chapter-level artefact.
  //
  // exportImages owns the busy flag, job and errors for this path too.
  async function saveDetectionJson() {
    close({ restoreFocus: true });
    await exportImages('JSON', 'all');
  }
</script>

<div class="chrome-menu" role="menu" bind:this={menuEl} use:focusFirst>
  <button role="menuitem" disabled={!canDetect} onclick={() => run(detectCurrentPage)}>This page</button>
  <button role="menuitem" disabled={!canDetect} onclick={() => run(detectAllPages)}>Whole chapter</button>
  <div class="chrome-menu-sep"></div>
  <div class="dm-group" role="group" aria-label="Models">
    <span class="dm-head">{LANG[lang] ?? 'Source'} reader</span>
    <ReaderChoice language={lang} compact />
    <button
      role="menuitemcheckbox"
      aria-checked={prefs.secondDetector}
      class="dm-check"
      onclick={() => setPref('secondDetector', !prefs.secondDetector)}
    >
      <span class="dm-box" class:on={prefs.secondDetector} aria-hidden="true"></span>
      <span class="dm-text"><span>Find bubbles</span><span class="dm-sub">RT-DETR · 168 MB · tells bubbles from art</span></span>
    </button>
    {#if lang === 'ja'}
      <button
        role="menuitemcheckbox"
        aria-checked={prefs.secondReader}
        class="dm-check"
        onclick={() => setPref('secondReader', !prefs.secondReader)}
      >
        <span class="dm-box" class:on={prefs.secondReader} aria-hidden="true"></span>
        <span class="dm-text"><span>Second reader</span><span class="dm-sub">PP-OCRv6 · 77 MB · flags lines read differently</span></span>
      </button>
    {/if}
  </div>
  <div class="chrome-menu-sep"></div>
  <button role="menuitem" disabled={!canSaveJson || app.exporting} onclick={saveDetectionJson}>Save detection JSON…</button>
</div>

<style>
  .dm-group {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 268px;
  }
  .dm-head {
    padding: 6px 10px 3px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--t2);
  }
  .chrome-menu .dm-check {
    height: auto;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 7px 9px;
    white-space: normal;
  }
  .dm-box {
    flex: none;
    width: 14px;
    height: 14px;
    margin-top: 1px;
    border-radius: 5px;
    box-shadow: inset 0 0 0 1.5px var(--t3);
  }
  .dm-box.on {
    background: var(--accent);
    box-shadow: none;
  }
  /* The tick is the accent's own foreground, so it inverts with the theme. */
  .dm-box.on::after {
    content: '';
    display: block;
    width: 100%;
    height: 100%;
    background: var(--accent-fg);
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 8.5l2.6 2.5L12 5.5' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 100% no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 8.5l2.6 2.5L12 5.5' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 100% no-repeat;
  }
  .dm-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 12.5px;
    font-weight: 600;
  }
  .dm-sub {
    font-size: 11px;
    font-weight: 400;
    color: var(--t2);
  }
</style>
