<script>
  import { onMount } from 'svelte';
  import { checkForUpdate } from '../updater.js';
  import UpdateDialog from './UpdateDialog.svelte';

  // Shared layout frame for home screens.
  let { onSettings, children } = $props();

  let update = $state(null);
  let updateDialogOpen = $state(false);

  onMount(async () => {
    try {
      update = await checkForUpdate();
    } catch {
      // Ignore updater errors on startup.
    }
  });
</script>

<div class="home-scroll">
  <div class="home-frame">
    <header class="home-head">
      <div class="wordmark" role="img" aria-label="Pear">
        <!-- The app icon's pear (src-tauri/icons/pear.svg), cropped to the fruit,
             with a shine on the body. -->
        <svg class="wordmark-pear" viewBox="350 215 324 566" aria-hidden="true">
          <path class="leaf" d="M529.2 291.0C546.3 239.5 600.3 217.5 654.2 232.2C619.9 276.3 570.8 303.3 529.2 291.0Z" />
          <path d="M500.2 344.9C499.3 305.7 512.0 273.8 525.7 255.7C530.6 247.9 543.4 252.8 544.4 262.6C532.6 278.3 524.7 305.7 524.7 344.9C516.9 344.9 508.1 344.9 500.2 344.9Z" />
          <path d="M512.0 325.3C553.7 325.3 583.1 364.6 588.0 428.3C591.9 492.1 664.0 550.9 664.0 634.3C664.0 709.8 595.4 771.6 512.0 771.6C428.6 771.6 360.0 709.8 360.0 634.3C360.0 550.9 432.1 492.1 436.0 428.3C440.9 364.6 470.3 325.3 512.0 325.3Z" />
          <ellipse class="shine" cx="430" cy="610" rx="22" ry="44" transform="rotate(18 430 610)" />
        </svg>
        <span aria-hidden="true">pear</span>
      </div>
      <div class="spacer"></div>
      {#if update}
        <button
          class="soft-btn update-badge"
          onclick={() => (updateDialogOpen = true)}
          title={update.version ? `Update to v${update.version}` : 'Update available'}
        >
          <span class="update-dot"></span>
          Update available
        </button>
      {/if}
      <button class="soft-btn settings-btn" onclick={onSettings} aria-label="Settings" title="Settings">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      </button>
    </header>
    {@render children()}
  </div>
</div>

<UpdateDialog bind:open={updateDialogOpen} {update} />

<style>
  /* The gear stands alone: an icon reads at a glance in a header that already
     says where you are, and it matches the modal it opens. */
  .settings-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    padding: 0;
    color: var(--t2);
  }
  .settings-btn:hover {
    color: var(--text);
  }
  .update-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-color: var(--line2);
    color: var(--text);
  }
  .update-badge .update-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text);
  }
  .update-badge:disabled {
    cursor: default;
    opacity: 0.75;
  }
</style>
