<script>
  // Pending mode (SHARED_DATA_FOLDER.md section 5): Manga Cleaner set up the
  // shared folder and this app's library is still in its old place. The
  // button says ahead of time why it cannot run now.
  import { dataFolder, refreshBlockers } from '../data-folder.svelte.js';
  import { adoptNow, useSharedNow } from '../data-folder-actions.js';
  import { library } from '../library.svelte.js';

  const BLOCKER_POLL_MS = 3000;
  let busy = $state(false);
  async function run(fn) {
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
      refreshBlockers();
    }
  }

  const pending = $derived(dataFolder.mode === 'pending');
  $effect(() => {
    if (!pending) return;
    refreshBlockers();
    const timer = setInterval(refreshBlockers, BLOCKER_POLL_MS);
    return () => clearInterval(timer);
  });

  // Using the shared library moves nothing, so only this app has to be idle;
  // moving the old library in needs Manga Cleaner closed too.
  const why = $derived(
    dataFolder.blocked.local || (dataFolder.bothLibraries ? '' : dataFolder.blocked.cleaner),
  );
</script>

{#if pending}
  <section class="df-card" aria-label="Shared data folder">
    <div class="df-text">
      {#if dataFolder.bothLibraries}
        <strong>The shared folder already has a library</strong>
        <span>Manga Cleaner's data folder at {dataFolder.root} already holds a typesetter library, from another computer or an earlier setup. Use it to get Manga Cleaner's chapters here. Your library at {library.root} stays where it is.</span>
      {:else}
        <strong>Move your library into the shared folder</strong>
        <span>Manga Cleaner keeps its data in {dataFolder.root}. Move your library there to get its chapters here when you save them in Manga Cleaner.</span>
      {/if}
      {#if why}<span class="df-why" data-testid="df-card-why">{why}</span>{/if}
    </div>
    {#if dataFolder.bothLibraries}
      <button class="btn" disabled={busy || dataFolder.busy || !!why} onclick={() => run(useSharedNow)}>
        {busy ? 'Switching…' : 'Use the shared library'}
      </button>
    {:else}
      <button class="btn" disabled={busy || dataFolder.busy || !!why} onclick={() => run(adoptNow)}>
        {busy ? 'Moving…' : 'Move my library'}
      </button>
    {/if}
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
  .df-why {
    color: var(--text);
  }
</style>
