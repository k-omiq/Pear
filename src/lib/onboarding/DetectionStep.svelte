<script>
  // Comics only. What Detect and OCR are for, said before anything else, and
  // the three choices a new series and a new chapter start from. Each one is
  // saved the moment it is changed, as the theme is.
  import { prefs, setPref } from '../prefs.svelte.js';
  import ReaderChoice from '../ReaderChoice.svelte';

  const LANGUAGES = [
    ['ja', 'Japanese'],
    ['zh', 'Chinese'],
    ['ko', 'Korean'],
  ];
  const MODES = [
    ['translate', 'Translate'],
    ['typeset', 'Typeset'],
  ];
</script>

<!-- Outlined in the warn colour, never filled: it is a warning about what the
     models are, not an error. -->
<div class="notice" role="note">
  <p><strong>These models are not a translator.</strong> Detection and OCR find where the text is and read it, so your text lands in the right place faster. They cannot produce a good translation. Do not use them for machine translation.</p>
</div>

<div class="set-item">
  <div class="set-line">
    <span class="set-label">Source language</span>
    <div class="seg" role="group" aria-label="Source language">
      {#each LANGUAGES as [v, label] (v)}
        <button class:on={prefs.defaultOcrLanguage === v} aria-pressed={prefs.defaultOcrLanguage === v} onclick={() => setPref('defaultOcrLanguage', v)}>{label}</button>
      {/each}
    </div>
  </div>
  <p class="set-desc">The language a new series starts with.</p>
</div>

<div class="set-item">
  <div class="set-line"><span class="set-label">Text reader</span></div>
  <div class="reader"><ReaderChoice language={prefs.defaultOcrLanguage} /></div>
</div>

<div class="set-item">
  <div class="set-line">
    <span class="set-label">New chapters start as</span>
    <div class="seg" role="group" aria-label="New chapters start as">
      {#each MODES as [v, label] (v)}
        <button class:on={prefs.defaultChapterMode === v} aria-pressed={prefs.defaultChapterMode === v} onclick={() => setPref('defaultChapterMode', v)}>{label}</button>
      {/each}
    </div>
  </div>
  <p class="set-desc">Translate opens the page beside a typing pane. Typeset goes straight to lettering. You can change this in Settings.</p>
</div>

<p class="note">Models download the first time Detect runs (about 170 MB). A Translate chapter runs it when it first opens.</p>

<style>
  .notice {
    margin: 0 0 14px;
    padding: 11px 14px;
    border: 1px solid var(--warn);
    border-radius: 8px;
  }
  .notice p {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--t2);
  }
  .notice strong {
    font-weight: 600;
    color: var(--warn);
  }
  /* Controls at row scale, as Settings draws them. */
  .seg {
    flex: none;
  }
  .seg button {
    height: 28px;
    padding: 0 13px;
    font-size: 11.5px;
  }
  .reader {
    padding: 0 0 14px;
  }
</style>
