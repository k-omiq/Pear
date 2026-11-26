<script>
  // Titles Manga Cleaner sent that wait to be matched (SHARED_DATA_FOLDER.md
  // section 8.4.2): a Send to Pear, or Saves whose screen was closed. "Match…"
  // opens the match screen.
  import { handoffMatch, openMatch } from '../handoff.svelte.js';

  const n = $derived(handoffMatch.rows.length);
</script>

{#if n && !handoffMatch.open}
  <section class="df-card" aria-label="Titles from Manga Cleaner">
    <div class="df-text">
      <strong>Manga Cleaner sent {n} title{n === 1 ? '' : 's'}. Match {n === 1 ? 'it' : 'them'} to your titles.</strong>
    </div>
    <button class="btn btn-accent" onclick={openMatch}>Match…</button>
  </section>
{/if}

<style>
  .df-card {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 0 0 20px;
    padding: 14px 16px;
    border: 1px solid var(--line2);
    border-radius: var(--radius, 10px);
    background: var(--panel);
  }
  .df-text {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    color: var(--t2);
  }
  .df-text strong {
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
  }
</style>
