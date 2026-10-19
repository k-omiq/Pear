<script>
  // A radio group of theme swatches, ported from Manga Cleaner's picker.
  //
  // Each swatch wears its own theme through a local `data-theme` attribute, so
  // it is drawn from the same token blocks in styles.css that paint the app and
  // cannot drift from them. `system` is drawn split, light over dark.
  //
  // Arrows move and select, Home / End jump to the ends, and the group holds
  // one tab stop.
  import { theme, setTheme, THEMES, THEME_LABELS } from './theme.svelte.js';

  let buttons = $state([]);

  function onkeydown(event, index) {
    const last = THEMES.length - 1;
    let next;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = index === last ? 0 : index + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = index === 0 ? last : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    setTheme(THEMES[next]);
    buttons[next]?.focus();
  }
</script>

<div class="picker" role="radiogroup" aria-label="Theme">
  {#each THEMES as name, index (name)}
    {@const on = name === theme.mode}
    <button
      bind:this={buttons[index]}
      type="button"
      role="radio"
      class="option"
      class:on
      aria-checked={on}
      tabindex={on ? 0 : -1}
      onclick={() => setTheme(name)}
      onkeydown={(event) => onkeydown(event, index)}
    >
      <span class="swatch" aria-hidden="true">
        {#if name === 'system'}
          <span class="half" data-theme="light"><span class="card"><i></i><b></b></span></span>
          <span class="half" data-theme="dark"><span class="card"><i></i><b></b></span></span>
        {:else}
          <span class="half" data-theme={name}><span class="card"><i></i><b></b></span></span>
        {/if}
      </span>
      <span class="name">{THEME_LABELS[name]}{name === 'system' && on ? ` · ${THEME_LABELS[theme.resolved]}` : ''}</span>
    </button>
  {/each}
</div>

<style>
  .picker {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    margin: 10px 0 12px;
  }

  .option {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0;
    border: none;
    background: none;
    color: var(--t2);
    font-size: 11.5px;
    text-align: left;
    cursor: pointer;
  }
  .option:hover, .option.on { color: var(--text); }
  .option.on .name { font-weight: 600; }

  .swatch {
    display: flex;
    flex-direction: column;
    height: 72px;
    overflow: hidden;
    border-radius: 8px;
    box-shadow: 0 0 0 1px var(--line2);
    transition: box-shadow .12s, transform .12s;
  }
  .option:hover .swatch { box-shadow: 0 0 0 1px var(--t3); }
  .option.on .swatch { box-shadow: 0 0 0 2px var(--accent); }
  .option:active .swatch { transform: scale(.98); }
  .option:focus-visible { outline: none; }
  .option:focus-visible .swatch { outline: 2px solid var(--accent); outline-offset: 3px; }

  /* One theme's field. `system` stacks two of them. */
  .half {
    flex: 1;
    display: flex;
    align-items: flex-end;
    padding: 8px 0 0 12px;
    background: var(--bg);
    overflow: hidden;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 5px;
    width: 100%;
    height: 100%;
    min-height: 22px;
    padding: 8px 9px;
    border-radius: 5px 0 0 0;
    background: var(--panel);
    box-shadow: var(--edge-soft);
  }
  .card i, .card b { display: block; height: 4px; border-radius: 999px; }
  .card i { width: 60%; background: var(--t3); }
  .card b { width: 34%; background: var(--accent); }
  .half + .half .card { min-height: 0; }

  .name { padding-left: 1px; }
</style>
