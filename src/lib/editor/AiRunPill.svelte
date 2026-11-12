<script>
  // The "AI is editing" bar (docs/AI_TYPESETTING_PLAN.md section 5): while an
  // agent run is going, how much it has done, and the two ways to answer it -
  // Stop, which ends it with its work kept, and Revert run, which takes that
  // work back from every page it touched. After the run it stays as long as
  // the run can still be reverted, so the user can look first and decide
  // after; the close button puts it away until the next run.
  import { aiRun, stopRun, revertRun, checkPin } from '../agent/run.svelte.js';
  import { panel, stopPrompt } from '../agent/panel.svelte.js';

  // The panel's run stops its prompt too; the door's run, the door's agent.
  const stop = () => (aiRun.door === 'panel' && panel.running ? stopPrompt() : stopRun());
  import { app } from '../store.svelte.js';

  let dismissed = $state(false);
  // A new run brings the bar back.
  $effect(() => {
    if (aiRun.active) dismissed = false;
  });

  // Another chapter: the run ends, and its Revert goes with it.
  $effect(() => {
    void app.chapterRef;
    checkPin();
  });

  const shown = $derived(aiRun.active || (aiRun.canRevert && !dismissed));
  const what = $derived(
    `${aiRun.edits} edit${aiRun.edits === 1 ? '' : 's'}` +
      (aiRun.pages ? ` on ${aiRun.pages} page${aiRun.pages === 1 ? '' : 's'}` : ''),
  );
</script>

{#if shown}
  <div class="ai-run" role="status" aria-live="polite">
    <div class="pill ai-run-pill" class:live={aiRun.active}>
      <span class="ai-dot" aria-hidden="true"></span>
      <span class="ai-label">{aiRun.active ? (aiRun.quiet ? 'AI is thinking' : 'AI is editing') : aiRun.stopped ? 'AI run stopped' : 'AI run done'}</span>
      <span class="pill-count">{what}</span>
      {#if aiRun.active}
        <button onclick={stop} title="End the run now. What it did stays.">Stop</button>
      {/if}
      {#if aiRun.canRevert}
        <button onclick={revertRun} title="Put every page the run touched back as it was. Undo on a page brings the run's work back.">Revert run</button>
      {/if}
      {#if !aiRun.active}
        <button class="ai-close" onclick={() => (dismissed = true)} aria-label="Hide" title="Hide until the next run">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Centred over the canvas, between the identity row and the tool cluster,
     where neither can hide it. */
  .ai-run {
    position: fixed;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 31;
  }
  /* Too narrow for three groups in one band: under the identity row. */
  @media (max-width: 1000px) {
    .ai-run {
      top: 52px;
      left: 16px;
      transform: none;
    }
  }
  .ai-run-pill {
    cursor: default;
    gap: 8px;
    padding: 0 6px 0 12px;
  }
  .ai-run-pill:hover {
    border-color: var(--line2);
  }
  .ai-run-pill.live {
    border-color: var(--accent);
  }
  .ai-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--t3);
    flex: none;
  }
  .live .ai-dot {
    background: var(--accent);
    animation: ai-pulse 1.2s ease-in-out infinite;
  }
  @keyframes ai-pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .live .ai-dot {
      animation: none;
    }
  }
  .ai-label {
    font-weight: 600;
  }
  .ai-run-pill button {
    height: 22px;
    padding: 0 9px;
    border: 1px solid var(--line2);
    border-radius: 11px;
    background: var(--panel2);
    color: var(--text);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .ai-run-pill button:hover {
    border-color: var(--t3);
  }
  .ai-run-pill .ai-close {
    width: 22px;
    padding: 0;
    display: grid;
    place-items: center;
    border-color: transparent;
    background: transparent;
  }
  .ai-close svg {
    width: 11px;
    height: 11px;
  }
</style>
