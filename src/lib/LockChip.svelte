<script>
  // The padlock on a locked box (`boxLocked`), and the way to unlock it: one
  // click. TextBox draws it only on a locked box, so an unlocked box shows
  // nothing. There is no menu: the lock holds everything, so there is nothing
  // to choose between, and the hover shows the open padlock the click leads to.
  //
  // Editor chrome only: the exporter and the PSD writer paint from the
  // document, never from this DOM, so it is in no export and no thumbnail. It
  // sits outside the box's own rectangle and is absolutely placed, so it takes
  // no room from the text and moves no line.
  import { app, setBoxLocked, isTranslateMode } from './store.svelte.js';
  import { comboFor, formatCombo } from './shortcuts.svelte.js';

  let { box } = $props();

  // Hidden while the Bulk panel is picking boxes (a click there means "this
  // box", and the tick mark takes the same corner) and in a translate chapter,
  // where nothing on the page is laid out.
  const shown = $derived(!app.bulk.active && !isTranslateMode());
  // The box turns, and the chip with it, as everything inside the box does. A
  // padlock on its side reads as a cup, so the chip is turned back upright
  // about its own centre.
  const upright = $derived(Number(box.style?.rotation) ? `transform: rotate(${-Number(box.style.rotation)}deg)` : '');
  // The key as the user has it bound, not as it shipped.
  const key = $derived(formatCombo(comboFor('box.layoutLock')));
  const tip = $derived(`Locked - click to unlock${key ? ` (${key})` : ''}`);

  // The box drags from a press anywhere inside it; the chip is not the box.
  const stop = (e) => e.stopPropagation();
  // The editor reads plain keys on the window (Delete, the arrows, Escape);
  // on the chip they mean the chip. Cmd/Ctrl combos go on, so undo still works.
  const onKey = (e) => {
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
  };
</script>

{#if shown}
  <button
    class="lock-chip"
    style={upright}
    type="button"
    contenteditable="false"
    title={tip}
    aria-label="Locked. Unlock"
    onpointerdown={stop}
    ondblclick={stop}
    onkeydown={onKey}
    onclick={(e) => {
      e.stopPropagation();
      setBoxLocked(box.id, false);
    }}
  >
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path class="shut" d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
      <path class="open" d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" />
    </svg>
  </button>
{/if}

<style>
  /* Beside the box's top-right corner, where the corner handle would be on an
     unlocked box (a locked one has none), clear of the review badge above the
     top-left, so it never covers either and never sits on the text. */
  .lock-chip {
    position: absolute;
    left: calc(100% + 6px);
    top: -1px;
    z-index: 8;
    display: grid;
    place-items: center;
    width: 19px;
    height: 19px;
    padding: 0;
    border: 1px solid var(--line2);
    border-radius: 999px;
    background: var(--panel);
    color: var(--text);
    box-shadow: var(--edge-soft);
    cursor: pointer;
    transform-origin: center;
  }
  .lock-chip:hover {
    border-color: var(--tintline);
  }
  .lock-chip:focus-visible {
    outline: 2px solid var(--tintline);
    outline-offset: 1px;
  }
  .lock-chip svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .lock-chip svg rect {
    fill: currentColor;
  }
  /* The click unlocks, so the hover shows the padlock open. */
  .lock-chip .open,
  .lock-chip:hover .shut {
    display: none;
  }
  .lock-chip:hover .open {
    display: inline;
  }
</style>
