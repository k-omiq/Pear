<script>
  // The one-time data folder notices (data-folder-notices.svelte.js). App
  // mounts this only while the first-run setup is closed, so a notice is
  // seen, and counted as seen, only once it is on screen.
  import { notices, markNoticeSeen, dismissNotice } from '../data-folder-notices.svelte.js';
  import { revealDataFolder } from '../data-folder.svelte.js';
  import { plainError } from '../data-folder-words.js';
  import { toastError } from '../store.svelte.js';

  $effect(() => {
    for (const n of notices.items) markNoticeSeen(n.id);
  });

  function show(n) {
    dismissNotice(n.id);
    revealDataFolder(n.reveal).catch((e) => toastError(`Could not open the folder: ${plainError(e)}`));
  }
</script>

{#if notices.items.length}
  <div class="df-notices" role="status">
    {#each notices.items as n (n.id)}
      <div class="df-notice" data-testid="df-notice">
        <span class="msg">{n.text}</span>
        {#if n.reveal}<button class="act" onclick={() => show(n)}>Show</button>{/if}
        <button class="x" onclick={() => dismissNotice(n.id)} aria-label="Close">✕</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .df-notices {
    position: fixed;
    bottom: 38px;
    left: 16px;
    z-index: 301;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: min(420px, calc(100vw - 32px));
  }
  .df-notice {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 10px 9px 14px;
    border-radius: 8px;
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--line2);
    border-left: 3px solid var(--accent);
    font-size: 12.5px;
    box-shadow: var(--edge);
    user-select: text;
    -webkit-user-select: text;
  }
  .msg {
    flex: 1;
    overflow-wrap: anywhere;
    line-height: 1.4;
  }
  .act {
    border: 1px solid var(--line2);
    background: transparent;
    color: var(--text);
    border-radius: 6px;
    padding: 3px 9px;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .act:hover {
    background: var(--surface);
  }
  .x {
    border: 0;
    background: none;
    color: var(--t2);
    cursor: pointer;
    padding: 0 2px;
    font-size: 12px;
    line-height: 1.4;
  }
  .x:hover {
    color: var(--text);
  }
</style>
