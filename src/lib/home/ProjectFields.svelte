<script>
  // The new project's own fields, shared by the library screen's New project
  // form and the new-chapter dialog's "New project…" pick, so the two cannot
  // drift apart. The name always; for comics use also the language Detect
  // reads and the layout, which cannot be changed later and so stays in view.
  // General use has neither: no Detect, and the caller picks the layout from
  // the images (layout-guess.js).
  import { isComics } from '../prefs.svelte.js';
  import { word } from '../words.js';

  let {
    name = $bindable(''),
    layout = $bindable('pages'),
    language = $bindable('ja'),
    disabled = false,
    autofocus = false,
    // Told when the person picks a layout by hand, so a caller that guesses
    // one stops guessing.
    onpicklayout = () => {},
  } = $props();
  const pickLayout = (l) => {
    layout = l;
    onpicklayout(l);
  };

  const LANGUAGES = [['ja', 'Japanese'], ['zh', 'Chinese'], ['ko', 'Korean']];
  // The library form and the dialog can both be mounted, so the labels' ids
  // are this instance's own.
  const uid = $props.id();
</script>

<label class="field">
  <span>{word('seriesName')}</span>
  <!-- svelte-ignore a11y_autofocus -->
  <input bind:value={name} {disabled} {autofocus} />
</label>

{#if isComics()}
  <div class="field">
    <span id="{uid}-layout">Layout</span>
    <div class="seg" role="group" aria-labelledby="{uid}-layout">
      <button type="button" class:on={layout === 'pages'} aria-pressed={layout === 'pages'} onclick={() => pickLayout('pages')} {disabled}>Pages</button>
      <button type="button" class:on={layout === 'longstrip'} aria-pressed={layout === 'longstrip'} onclick={() => pickLayout('longstrip')} {disabled}>Longstrip</button>
    </div>
  </div>

  <div class="field">
    <span id="{uid}-language">Language</span>
    <div class="seg" role="group" aria-labelledby="{uid}-language">
      {#each LANGUAGES as [id, label] (id)}
        <button type="button" class:on={language === id} aria-pressed={language === id} onclick={() => (language = id)} {disabled}>{label}</button>
      {/each}
    </div>
  </div>
{/if}
