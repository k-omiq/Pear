<script>
  // Legacy mode, once (SHARED_DATA_FOLDER.md section 7, "First run asks
  // once"): offers the setup at the default place instead of waiting for the
  // user to find it in Settings. Nothing moves until Move is clicked. The
  // answer is kept in this app's own preferences (`dataFolderFirstRun`), never
  // in the data folder. Pending mode has its own card (DataFolderCard).
  import { dataFolder, defaultDataRoot, refreshBlockers, cleanerBlockerAt } from '../data-folder.svelte.js';
  import { setUpAtDefault } from '../data-folder-actions.js';
  import { prefs, setPref } from '../prefs.svelte.js';
  import { openSettings } from '../settings-tabs.svelte.js';

  const BLOCKER_POLL_MS = 3000;

  // `~/Manga Library`, asked of Rust once Legacy mode is known. Outside the
  // desktop app there is none, and then there is no card.
  let defaultRoot = $state(null);
  const asking = $derived(dataFolder.checked && dataFolder.mode === 'legacy' && prefs.dataFolderFirstRun === 'ask');
  $effect(() => {
    if (!asking || defaultRoot) return;
    let live = true;
    defaultDataRoot()
      .then((root) => {
        if (live && typeof root === 'string' && root) defaultRoot = root;
      })
      .catch(() => {});
    return () => (live = false);
  });
  const shown = $derived(asking && !!defaultRoot);

  // Setup from Legacy moves only this app's library, so Manga Cleaner may be
  // open, unless the default place already is a data folder it runs in.
  let cleaner = $state('');
  async function refresh() {
    const [, why] = await Promise.all([refreshBlockers(), cleanerBlockerAt(defaultRoot)]);
    if (why !== cleaner) cleaner = why;
  }
  $effect(() => {
    if (!shown) return;
    refresh();
    const timer = setInterval(refresh, BLOCKER_POLL_MS);
    return () => clearInterval(timer);
  });
  const why = $derived(dataFolder.blocked.local || cleaner);

  let busy = $state(false);
  async function move() {
    busy = true;
    try {
      if (await setUpAtDefault(defaultRoot)) setPref('dataFolderFirstRun', 'moved');
    } finally {
      busy = false;
      refresh();
    }
  }
  const chooseFolder = () => openSettings('general', 'data-folder');
  const notNow = () => setPref('dataFolderFirstRun', 'notNow');
</script>

{#if shown}
  <section class="df-card" aria-label="One data folder">
    <div class="df-text">
      <strong>One data folder for Pear and Manga Cleaner</strong>
      <span>Your library moves to {defaultRoot}. Both apps keep their data there. Chapters you clean and save in Manga Cleaner then show up here.</span>
      {#if why}<span class="df-why" data-testid="df-first-run-why">{why}</span>{/if}
    </div>
    <div class="df-actions">
      <button class="btn" disabled={busy || dataFolder.busy} onclick={notNow}>Not now</button>
      <button class="btn" disabled={busy || dataFolder.busy} onclick={chooseFolder}>Choose folder</button>
      <button class="btn btn-accent" disabled={busy || dataFolder.busy || !!why} onclick={move}>
        {busy ? 'Moving…' : 'Move'}
      </button>
    </div>
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
  .df-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
