<script>
  // Pending mode (SHARED_DATA_FOLDER.md section 5): Manga Cleaner set up the
  // shared folder and this app's library is still in its old place.
  import { dataFolder } from '../data-folder.svelte.js';
  import { adoptNow } from '../data-folder-actions.js';
  import { app } from '../store.svelte.js';

  let busy = $state(false);
  async function run() {
    busy = true;
    try {
      await adoptNow();
    } finally {
      busy = false;
    }
  }
</script>

{#if dataFolder.mode === 'pending'}
  <section class="df-card" aria-label="Shared data folder">
    <div class="df-text">
      <strong>Move your library into the shared folder</strong>
      <span>Manga Cleaner keeps its data in {dataFolder.root}. Move your library there to get its chapters here when you save them in Manga Cleaner.</span>
      {#if app.chapterRef}<span>Close the open chapter first.</span>{/if}
    </div>
    <button class="btn" disabled={busy || dataFolder.busy || !!app.chapterRef} onclick={run}>
      {busy ? 'Moving…' : 'Move my library'}
    </button>
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
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    font-size: 12.5px;
    color: var(--t2);
    overflow-wrap: anywhere;
  }
  .df-text strong {
    color: var(--text);
    font-size: 13px;
  }
</style>
