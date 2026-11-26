<script>
  // The start dialog (SHARED_DATA_FOLDER.md section 5.4), rows D and F of
  // the start table: "One folder for both apps", asked once. Set up (no data
  // folder yet, Manga Cleaner has run here) or Join (Manga Cleaner's folder
  // exists, this app's library is still in its old place). It replaces the
  // version 1 Home card. In the one dialog: the question, Blocked (Manga
  // Cleaner open, or this app busy), Working (a progress bar; it cannot be
  // closed), Done and Failed.
  import {
    dataFolder,
    defaultDataRoot,
    refreshBlockers,
    cleanerBlockerAt,
    rootForPick,
    setUpSharedFolder,
    moveLibraryIntoShared,
    recordStartAnswer,
    dismissStart,
    startPlan,
    copyProgress,
    sisterPresent,
  } from '../data-folder.svelte.js';
  import { homePath, whatHappens, copyingText, plainError, shownPath } from '../data-folder-words.js';
  import { library, scanLibrary } from '../library.svelte.js';
  import { onboarding } from '../onboarding/onboarding.svelte.js';
  import { fsx } from '../fsx.js';
  import { captureFocus } from '../focus.js';
  import { untrack } from 'svelte';

  const POLL_MS = 3000;
  const PROGRESS_MS = 250;

  // The question in hand: 'setup' or 'join'. Never over the first-run setup.
  const kind = $derived(dataFolder.start === 'setup' || dataFolder.start === 'join' ? dataFolder.start : null);
  const shown = $derived(!!kind && dataFolder.checked && !onboarding.open);

  let root = $state('');
  let home = $state('');
  let plan = $state(null);
  // 'ask' | 'working' | 'done' | 'failed'
  let phase = $state('ask');
  let failure = $state('');
  let unchanged = $state(false);
  let progress = $state(null);
  let sister = $state(false);
  let cleaner = $state('');
  let confirmText = $state('');
  let confirmAnswer = null;

  // Where the library would go: `~/Manga Library` for a setup, the folder
  // Manga Cleaner uses for a join.
  $effect(() => {
    if (!shown) return;
    let live = true;
    (async () => {
      const picked = untrack(() => root);
      const at = kind === 'join' ? dataFolder.root : picked || (await defaultDataRoot().catch(() => ''));
      home = await fsx.homeDir().catch(() => '');
      if (!live || !at) return;
      root = at;
      plan = await startPlan(at).catch(() => null);
    })();
    return () => (live = false);
  });

  // Blocked: what stops the move now, checked again every few seconds.
  async function check() {
    await refreshBlockers();
    // A setup into an existing data folder, or a join that moves a library
    // in, needs Manga Cleaner closed; one that moves nothing does not.
    const needsClosed = kind === 'setup' || !!plan?.hasLibrary;
    const why = needsClosed && root ? await cleanerBlockerAt(root) : '';
    if (why !== cleaner) cleaner = why;
  }
  $effect(() => {
    if (!shown || phase !== 'ask' || !root) return;
    void plan;
    check();
    const timer = setInterval(check, POLL_MS);
    return () => clearInterval(timer);
  });
  const blocked = $derived(dataFolder.blocked.local || cleaner);

  let box = $state(null);
  $effect(() => {
    if (shown && box) return captureFocus();
  });

  async function change() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, defaultPath: root.replace(/[\\/][^\\/]+$/, '') || undefined });
      if (typeof picked !== 'string') return;
      const next = await rootForPick(picked);
      if (next.info?.syncWarning) {
        const { ask } = await import('@tauri-apps/plugin-dialog');
        const yes = await ask(`${next.info.syncWarning}\n\nUse this folder anyway?`, { title: 'Data folder', kind: 'warning', okLabel: 'Use it', cancelLabel: 'Cancel' });
        if (!yes) return;
      }
      root = next.root;
      plan = await startPlan(root).catch(() => null);
    } catch (e) {
      failure = plainError(e);
    }
  }

  // A drive that cannot tell whether Manga Cleaner is open: the user says.
  function confirmClosed(text) {
    confirmText = text;
    return new Promise((resolve) => (confirmAnswer = resolve));
  }
  function answerConfirm(yes) {
    confirmText = '';
    confirmAnswer?.(yes);
    confirmAnswer = null;
  }

  async function useOneFolder() {
    const wasRoot = library.root;
    const wasMode = dataFolder.mode;
    phase = 'working';
    failure = '';
    progress = null;
    sister = kind === 'join' || (await sisterPresent());
    const timer = setInterval(async () => {
      const p = await copyProgress().catch(() => null);
      if (p?.active) progress = p;
    }, PROGRESS_MS);
    try {
      if (kind === 'join') await moveLibraryIntoShared({ confirm: confirmClosed });
      else await setUpSharedFolder(root, { confirm: confirmClosed });
      recordStartAnswer(kind, 'accepted');
      phase = 'done';
      if (dataFolder.mode === 'shared') await scanLibrary();
    } catch (e) {
      if (String(e?.message ?? e) === 'Nothing was moved.') {
        phase = 'ask';
        return;
      }
      failure = plainError(e);
      unchanged = dataFolder.mode === wasMode && library.root === wasRoot && dataFolder.state !== 'moving';
      phase = 'failed';
    } finally {
      clearInterval(timer);
      progress = null;
    }
  }

  function notNow() {
    recordStartAnswer(kind, 'declined');
    dismissStart();
    phase = 'ask';
  }
  function close() {
    dismissStart();
    phase = 'ask';
  }

  function onkeydown(e) {
    if (e.key !== 'Escape' || phase === 'working') return;
    e.preventDefault();
    e.stopPropagation();
    if (phase === 'ask') notNow();
    else close();
  }

  const where = $derived(homePath(phase === 'done' && dataFolder.root ? dataFolder.root : root, home));
  const percent = $derived(progress?.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null);
</script>

{#if shown}
  <div class="modal-overlay open" role="presentation">
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={box}
      class="modal dialog-narrow df-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="df-dialog-title"
      tabindex="-1"
      {onkeydown}
    >
      <svg class="df-art" viewBox="0 0 200 72" aria-hidden="true">
        <rect x="6" y="10" width="40" height="40" rx="10" class="icon cleaner" />
        <path d="M18 38 l14 -16 M22 40 l12 -12" class="glyph" />
        <rect x="154" y="10" width="40" height="40" rx="10" class="icon pear" />
        <path d="M174 18 c-2 -4 2 -6 4 -5 M174 20 c-8 0 -10 10 -7 16 c3 6 11 6 14 0 c3 -6 1 -16 -7 -16 z" class="glyph" />
        <path d="M52 30 H78 m-6 -5 l6 5 l-6 5" class="arrow" />
        <path d="M148 30 H122 m6 -5 l-6 5 l6 5" class="arrow" />
        <path d="M84 20 h11 l5 5 h16 v26 h-32 z" class="folder" />
      </svg>

      <h2 id="df-dialog-title" class="df-title">
        {phase === 'done' ? 'Done' : 'One folder for both apps'}
      </h2>

      {#if phase === 'done'}
        <p class="df-line">Done. Both apps now use {where}.</p>
        {#if sister}
          <p class="df-line">To bring your Manga Cleaner titles across, use Send to Pear in Manga Cleaner.</p>
        {/if}
      {:else}
        <p class="df-line">Manga Cleaner and Pear keep your titles in one place.</p>
        <p class="df-line">Chapters you clean show up in Pear when you save them.</p>

        <div class="df-path">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4 h4.5 l1.5 1.5 h7 v8 h-13 z" /></svg>
          <span class="df-path-text" title={shownPath(root)} data-testid="df-dialog-path">{where}</span>
          {#if kind === 'setup' && phase === 'ask'}
            <button class="link-btn" onclick={change}>Change…</button>
          {/if}
        </div>

        {#if phase === 'working'}
          <div class="df-progress" aria-live="polite">
            <div class="df-progress-meta">
              {progress?.total ? copyingText(progress.done, progress.total) : plan?.hasLibrary ? 'Moving your library…' : 'Setting up…'}
            </div>
            <div class="df-track" role="progressbar" aria-label="Moving your library" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
              <div class="df-fill" class:indeterminate={percent == null} style={percent != null ? `width: ${percent}%` : ''}></div>
            </div>
          </div>
        {:else if phase === 'failed'}
          <p class="df-line df-failed" role="alert" data-testid="df-dialog-failed">{failure}</p>
          {#if unchanged}<p class="df-line">Nothing was changed.</p>{/if}
        {:else}
          <p class="df-line df-what" data-testid="df-dialog-what">{plan ? whatHappens(kind, plan) : ' '}</p>
          {#if blocked}
            <p class="df-line df-blocked" data-testid="df-dialog-blocked">{blocked}</p>
          {/if}
        {/if}

        {#if confirmText}
          <div class="df-confirm" role="alert">
            <p class="df-line">{confirmText}</p>
            <div class="df-confirm-btns">
              <button class="soft-btn" onclick={() => answerConfirm(false)}>Cancel</button>
              <button class="accent-btn narrow" onclick={() => answerConfirm(true)}>It is closed</button>
            </div>
          </div>
        {/if}
      {/if}

      <div class="modal-foot">
        {#if phase === 'ask'}
          {#if blocked}
            <button class="soft-btn" onclick={check}>Check again</button>
          {/if}
          <button class="soft-btn" onclick={notNow}>Not now</button>
          <button class="accent-btn narrow" disabled={!!blocked || !root || dataFolder.busy} onclick={useOneFolder}>Use one folder</button>
        {:else if phase === 'working'}
          <button class="accent-btn narrow" disabled>Use one folder</button>
        {:else}
          <button class="accent-btn narrow" onclick={close}>{phase === 'done' ? 'Done' : 'Close'}</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .df-dialog {
    width: 440px;
    max-width: calc(100vw - 32px);
  }
  .df-dialog:focus {
    outline: none;
  }
  .df-art {
    display: block;
    width: 200px;
    height: 72px;
    margin: 4px auto 10px;
  }
  .df-art .icon {
    fill: var(--surface);
    stroke: var(--line2);
    stroke-width: 1.5;
  }
  .df-art .icon.pear {
    fill: var(--accent-soft);
    stroke: var(--accent);
  }
  .df-art .glyph,
  .df-art .arrow {
    fill: none;
    stroke: var(--t2);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .df-art .icon.pear + .glyph {
    stroke: var(--accent);
  }
  .df-art .folder {
    fill: var(--panel);
    stroke: var(--text);
    stroke-width: 1.5;
    stroke-linejoin: round;
  }
  .df-title {
    margin: 0 0 8px;
    text-align: center;
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
  }
  .df-line {
    margin: 0 0 6px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--t2);
    overflow-wrap: anywhere;
  }
  .df-path {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 0;
    padding: 8px 10px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    font-size: 12.5px;
    color: var(--text);
  }
  .df-path svg {
    flex: none;
    width: 16px;
    height: 16px;
    fill: none;
    stroke: var(--t2);
    stroke-width: 1.3;
    stroke-linejoin: round;
  }
  .df-path-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link-btn {
    flex: none;
    border: none;
    background: none;
    padding: 0;
    color: var(--accent);
    font-size: 12px;
    cursor: pointer;
  }
  .link-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 2px;
  }
  .df-what,
  .df-blocked,
  .df-failed {
    color: var(--text);
  }
  .df-progress {
    margin: 4px 0 10px;
  }
  .df-progress-meta {
    margin-bottom: 6px;
    font-size: 11.5px;
    color: var(--t2);
    font-variant-numeric: tabular-nums;
  }
  .df-track {
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
    background: var(--line2);
  }
  .df-fill {
    height: 100%;
    border-radius: 2px;
    background: var(--accent);
    transition: width 0.15s ease;
  }
  .df-fill.indeterminate {
    width: 30%;
  }
  .df-confirm {
    margin: 8px 0;
    padding: 10px;
    border: 1px solid var(--warn);
    border-radius: 6px;
  }
  .df-confirm-btns {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  @media (prefers-reduced-motion: reduce) {
    .df-fill {
      transition: none;
    }
  }
</style>
