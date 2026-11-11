<script module>
  import { isDesktopApp, popFaceMenu } from './face-menu-native.js';

  // Where the last right-click on selected words asked for the menu of their
  // faces. Module state for the reason BoxMenu's is: the press is heard by a
  // TextBox and the menu is drawn once, over everything.
  const ask = $state({ x: 0, y: 0, turn: 0 });

  // In the desktop app the system's own popup (face-menu-native.js); in a
  // browser, this one.
  export function openFaceMenu(x, y) {
    if (isDesktopApp()) {
      popFaceMenu();
      return;
    }
    ask.x = x;
    ask.y = y;
    ask.turn++;
  }
</script>

<script>
  // The right-click menu on words selected in a box, in a browser: Cut and
  // Copy, then Bold, Italic, Typeface… and Clear typeface (face-menu-items.js).
  // Bold and Italic are checked when all of the words have them, and show
  // "Mixed" when some do.
  //
  // The words stay selected and typed into while it is open: the box's edit
  // does not end on the focus coming here (`data-keeps-edit`, TextBox.svelte
  // `onEditBlur`), and the focus and the selection go back to the text when
  // it closes, by a choice or Escape. Closed any other way, the edit ends
  // unless the focus is back in the box (`endEditIfAway`).
  import { untrack } from 'svelte';
  import { isTranslateMode } from '../store.svelte.js';
  import { anchoredOverlay } from '../anchored-overlay.svelte.js';
  import { endEditIfAway } from '../typing-selection.svelte.js';
  import { faceMenuTarget, faceMenuItems } from './face-menu-items.js';
  import { formatCombo } from '../shortcuts.svelte.js';

  const EDGE = 8;
  let menuEl = $state(null);
  let at = $state({ x: 0, y: 0 });
  let turn = $state(0);
  const overlay = anchoredOverlay(() => menuEl);

  $effect(() => {
    const t = ask.turn;
    if (!t) return;
    untrack(() => {
      overlay.close({ refocus: false });
      turn = t;
      at = { x: ask.x, y: ask.y };
      overlay.show();
    });
  });

  // The words it is about: the selection in the box typed into.
  const target = $derived(faceMenuTarget());

  // Closed with nowhere to hand the focus back (a press away, the window
  // resized, a wheel): the edit ends once the focus has landed outside it.
  function closeAway() {
    overlay.close({ refocus: false });
    setTimeout(endEditIfAway);
  }

  // Nothing selected any more - the edit ended, the words were typed over -
  // takes the menu away.
  $effect(() => {
    if (!overlay.open) return;
    if (!target || isTranslateMode()) closeAway();
  });

  $effect(() => {
    if (!overlay.open) return;
    const wheel = (e) => {
      if (!menuEl?.contains(e.target)) overlay.close();
    };
    const away = closeAway;
    window.addEventListener('wheel', wheel, { capture: true, passive: true });
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('wheel', wheel, { capture: true });
      window.removeEventListener('resize', away);
    };
  });

  // Cut and Copy run the browser's own command on the words, which the box
  // hears as it hears the keys (its `oncut`/`oncopy`).
  // Their keys are the field's own, written as the app writes keys.
  const clip = (kind, label, key) => ({ id: `edit.${kind}`, label, key: formatCombo(`Mod+${key}`), ok: true, run: () => document.execCommand(kind) });
  const itemsFor = (t) => [clip('cut', 'Cut', 'x'), clip('copy', 'Copy', 'c'), ...faceMenuItems(t)];

  // Every choice gives the focus and the selection back to the text first,
  // so the edit goes on: Typeface… then opens the Inspector's family list,
  // which hands them back when it closes.
  function choose(it) {
    if (!it.ok) return;
    overlay.close();
    it.run();
  }

  function place(node) {
    const r = node.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = at.x, y = at.y;
    if (x + r.width > vw - EDGE) x = Math.max(EDGE, x - r.width);
    if (y + r.height > vh - EDGE) y = Math.max(EDGE, y - r.height);
    at = { x: Math.min(x, Math.max(EDGE, vw - EDGE - r.width)), y: Math.min(y, Math.max(EDGE, vh - EDGE - r.height)) };
    node.querySelector('button:not(:disabled)')?.focus();
  }

  // Plain keys stop here (the box being typed into, and the editor, listen
  // on the window); Cmd/Ctrl combos go on, so Cmd+B still bolds.
  function onKey(e) {
    if (overlay.dismissKey(e)) return;
    if (e.metaKey || e.ctrlKey) return;
    e.stopPropagation();
    const all = [...(menuEl?.querySelectorAll('button:not(:disabled)') ?? [])];
    if (!all.length) return;
    const i = all.indexOf(document.activeElement);
    const n = all.length;
    let to = null;
    if (e.key === 'ArrowDown') to = all[(i + 1) % n];
    else if (e.key === 'ArrowUp') to = i < 0 ? all[n - 1] : all[(i + n - 1) % n];
    else if (e.key === 'Home') to = all[0];
    else if (e.key === 'End') to = all[n - 1];
    else if (e.key === 'Enter' && i >= 0) {
      e.preventDefault();
      all[i].click();
      return;
    } else if (e.key === 'Tab') {
      e.preventDefault();
      overlay.close();
      return;
    } else return;
    e.preventDefault();
    to?.focus();
  }
</script>

{#if overlay.open && target}
  {#key turn}
  <div
    class="chrome-menu face-menu"
    data-keeps-edit
    role="menu"
    tabindex="-1"
    aria-label="Selected words"
    style="left:{at.x}px;top:{at.y}px"
    bind:this={menuEl}
    use:place
    onkeydown={onKey}
    onfocusout={overlay.focusOut}
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#each itemsFor(target) as it, i (it.id)}
      {#if i === 2}<div class="fm-sep" role="separator"></div>{/if}
      <button
        type="button"
        role={it.checked != null ? 'menuitemcheckbox' : 'menuitem'}
        aria-checked={it.checked == null ? undefined : it.checked}
        disabled={!it.ok}
        onclick={() => choose(it)}
      >
        <span class="fm-label">{it.label}</span>
        {#if it.checked === 'mixed'}<span class="fm-note">Mixed</span>{:else if it.checked}<span class="fm-note">On</span>{:else if it.note}<span class="fm-note">{it.note}</span>{/if}
        {#if it.key}<kbd class="fm-key">{it.key}</kbd>{/if}
      </button>
    {/each}
  </div>
  {/key}
{/if}

<style>
  /* As the box's menu (BoxMenu.svelte): the app's dropdown at the pointer. */
  .face-menu {
    position: fixed;
    right: auto;
    z-index: 90;
    min-width: 200px;
    outline: none;
  }
  .face-menu button {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .face-menu button:focus-visible {
    background: var(--panel2);
    outline: none;
  }
  .fm-label {
    flex: 1;
  }
  .fm-sep {
    height: 1px;
    margin: 4px 0;
    background: var(--line, var(--panel2));
  }
  .fm-note {
    font-size: 11px;
    color: var(--t2);
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fm-key {
    font: inherit;
    font-size: 11.5px;
    color: var(--t3);
  }
</style>
