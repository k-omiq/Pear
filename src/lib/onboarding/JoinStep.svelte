<script>
  // Row C of the start table (SHARED_DATA_FOLDER.md section 5.5): a first
  // launch finds the data folder Manga Cleaner already uses. A new install
  // has nothing to move, so joining makes this app's library in that folder
  // and nothing else. "Keep separate" is kept, and not asked again.
  import { onboarding, nextOnboardingStep } from './onboarding.svelte.js';
  import { dataFolder, moveLibraryIntoShared, recordStartAnswer, dismissStart } from '../data-folder.svelte.js';
  import { homePath, plainError } from '../data-folder-words.js';
  import { scanLibrary } from '../library.svelte.js';
  import { fsx } from '../fsx.js';

  let home = $state('');
  fsx.homeDir().then((h) => (home = h)).catch(() => {});
  const where = $derived(homePath(dataFolder.root ?? '', home));

  let busy = $state(false);
  let error = $state('');

  async function join() {
    busy = true;
    error = '';
    try {
      await moveLibraryIntoShared();
      recordStartAnswer('join', 'accepted');
      dismissStart();
      if (dataFolder.mode === 'shared') await scanLibrary();
      onboarding.joined = true;
      nextOnboardingStep();
    } catch (e) {
      error = plainError(e);
    } finally {
      busy = false;
    }
  }
  function keepSeparate() {
    recordStartAnswer('join', 'declined');
    dismissStart();
    onboarding.joined = true;
    nextOnboardingStep();
  }
</script>

<p class="lead">Manga Cleaner already keeps its titles in {where}. Use the same folder?</p>
<p class="note">Chapters you clean show up in Pear when you save them.</p>
{#if error}<p class="note join-error" role="alert">{error}</p>{/if}
<div class="join-btns">
  <button class="btn" disabled={busy} onclick={keepSeparate}>Keep separate</button>
  <button class="btn btn-accent" disabled={busy || dataFolder.busy} onclick={join}>{busy ? 'Joining…' : 'Use the same folder'}</button>
</div>

<style>
  .join-btns {
    display: flex;
    gap: 8px;
    margin-top: 18px;
  }
  .join-error {
    color: var(--text);
  }
</style>
