<script>
  // Unavailable mode (SHARED_DATA_FOLDER.md section 5): the pointer names a
  // folder that is not there, is not a data folder, has another folder id, or
  // was set up by a newer version, or a move of it is not finished. App.svelte
  // shows this in place of every screen, so nothing behind it can be reached
  // or written to. Nothing is created; the user reconnects the drive, waits
  // for the move to finish, or picks another folder.
  import { dataFolder, recheckDataFolder } from '../data-folder.svelte.js';
  import { pickInstead } from '../data-folder-actions.js';
  import { scanLibrary } from '../library.svelte.js';

  const WHY = {
    missing: 'Reconnect the drive, or choose another folder.',
    noMarker: 'The folder is there but is not a data folder any more. Choose another folder.',
    idMismatch: 'A different data folder is at that place now. Choose the right one.',
    newer: 'It was set up by a newer version of the app. Update the app, or choose another folder.',
    invalid: 'The note that says where it is could not be read. Choose the folder again.',
    moving: 'A move of the data folder did not finish. It is finished when nothing is in its way; then press Try again.',
  };

  const moving = $derived(dataFolder.state === 'moving');
  let busy = $state(false);
  let first = $state(null);

  // Focus lands on the screen's first button, so the keyboard is never left
  // on a control that is no longer there.
  $effect(() => {
    first?.focus();
  });

  async function act(fn) {
    busy = true;
    try {
      await fn();
      if (dataFolder.mode !== 'unavailable') await scanLibrary();
    } finally {
      busy = false;
    }
  }
  const retry = () => act(async () => { await recheckDataFolder(); });
</script>

<main class="df-block" aria-labelledby="df-title">
  <div class="df-box">
    <h1 id="df-title">{moving ? 'Data folder move not finished' : 'Data folder not found'}</h1>
    <p class="df-path">{dataFolder.root ?? 'No folder'}</p>
    <p>{WHY[dataFolder.state] ?? WHY.missing}</p>
    {#if dataFolder.detail}<p class="df-detail" data-testid="df-detail">{dataFolder.detail}</p>{/if}
    <div class="df-actions">
      <button class="btn" bind:this={first} disabled={busy} onclick={retry}>Try again</button>
      {#if !moving}
        <button class="btn" disabled={busy} onclick={() => act(pickInstead)}>Choose another folder…</button>
      {/if}
    </div>
  </div>
</main>

<style>
  .df-block {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 16px;
    background: var(--bg);
  }
  .df-box {
    max-width: 460px;
    width: 100%;
    padding: 24px;
    border: 1px solid var(--line2);
    border-radius: var(--radius, 10px);
    background: var(--panel);
    color: var(--t2);
    font-size: 13px;
  }
  h1 {
    margin: 0 0 8px;
    font-size: 17px;
    color: var(--text);
  }
  .df-path {
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .df-detail {
    font-size: 12px;
    color: var(--t3);
  }
  .df-actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }
</style>
