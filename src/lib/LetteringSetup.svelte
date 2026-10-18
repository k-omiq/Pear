<script>
  // Settings ▸ Text styles ▸ AI lettering: how far an AI letterer may go past the
  // series' text styles (lettering.js), and notes on the look no style can
  // hold - the questions the AI asks before its first run, answered here
  // instead, or changed after it asked. The fonts themselves are the Text
  // styles above (TextStyles.svelte). Kept in the series guide.
  import { guide, setLettering } from './guide.svelte.js';
  import { FREEDOMS, FREEDOM_TEXT, letteringSetUp } from './lettering.js';

  const setUp = $derived(letteringSetUp(guide.lettering));
  const FREEDOM_LABEL = { strict: 'Strict', balanced: 'Balanced', free: 'Free' };
</script>

<section class="settings-section">
  <h3 class="settings-title">AI lettering</h3>
  <p class="set-intro">
    {#if setUp}
      How the AI letters this series: the text styles above, with this much
      freedom. Change anything here, or tell the AI.
    {:else}
      Not set up yet. The AI asks these questions before it letters this series.
      You can answer them here instead.
    {/if}
  </p>

  <div class="set-item">
    <div class="set-line">
      <span class="set-label">Freedom</span>
      <div class="seg" role="group" aria-label="AI freedom">
        {#each FREEDOMS as v (v)}
          <button class:on={guide.lettering.freedom === v} onclick={() => setLettering({ freedom: v })}>{FREEDOM_LABEL[v]}</button>
        {/each}
      </div>
    </div>
    <p class="set-desc">
      {guide.lettering.freedom ? FREEDOM_TEXT[guide.lettering.freedom] : 'Pick one. Until you do, the AI asks before it letters.'}
      {#if setUp}<button class="lt-again" onclick={() => setLettering({ freedom: null })}>Ask me again</button>{/if}
    </p>
  </div>

  <label class="lt-label" for="lt-notes">Notes on the look</label>
  <textarea
    id="lt-notes"
    class="qtf-input lt-notes"
    rows="3"
    placeholder="“Inner thoughts in italic narration”, “SFX keep the art’s colour”…"
    aria-label="Lettering notes"
    value={guide.lettering.notes}
    onchange={(e) => setLettering({ notes: e.currentTarget.value })}
  ></textarea>
</section>

<style>
  .lt-again {
    margin-left: 6px;
    padding: 0;
    border: none;
    background: none;
    color: var(--text);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .lt-label {
    display: block;
    margin: 14px 0 6px;
    font-size: 12.5px;
    color: var(--text);
  }
</style>
