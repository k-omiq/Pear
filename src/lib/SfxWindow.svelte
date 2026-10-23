<script>
  // The SFX window's body: the selected box's sound type and every number of
  // it (SfxPanel), in a floating window of its own rather than a sub-tab of
  // the Text box options. Hidden, its tab sits under the options panel's on
  // the tool strip (RailTools.svelte); drawing a sound with the SFX tool
  // opens it (Canvas.svelte).
  //
  // Its edits are undo steps the same way the Inspector's are: one burst, one
  // step, the before-snapshot taken capture-phase on this element before any
  // control writes (edit-burst.js).
  import { onDestroy } from 'svelte';
  import { app, byId, page, boxLocked } from './store.svelte.js';
  import { editBurst } from './edit-burst.js';
  import SfxPanel from './SfxPanel.svelte';

  // `onSettings` opens the Settings modal; the pane offers it when the engine
  // it needs is not the one running.
  let { onSettings = null } = $props();

  const box = $derived(app.selectedId ? byId(app.selectedId) : null);
  const locked = $derived(boxLocked(box));
  const burst = editBurst(() => box);
  onDestroy(() => burst.dispose());
</script>

{#if !box}
  <div class="insp-empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 17c4-1 6-6 9-9" /><path d="M13 8l-1 4 4-1" /><path d="M16 4l1-2" /><path d="M19 7l2-1" /><path d="M18 11h3" /></svg>
    <div>No text box selected.<br />Click a box, or draw a sound with the SFX tool.</div>
  </div>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="insp" onpointerdowncapture={burst.arm} onkeydowncapture={burst.arm}>
    {#if locked}
      <p class="sfx-locked" role="status">Locked. Unlock it in Text box options to change it.</p>
    {/if}
    <div inert={locked} class:sfx-dim={locked}>
      <SfxPanel {box} pg={page()} touch={burst.touch} arm={burst.arm} {onSettings} />
    </div>
  </div>
{/if}

<style>
  .sfx-locked {
    margin: 0;
    font-size: 12px;
    color: var(--t2);
  }
  .sfx-dim {
    opacity: 0.55;
  }
</style>
