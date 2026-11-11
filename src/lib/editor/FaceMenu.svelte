<script module>
  // Where the last right-click on selected words asked for the menu of their
  // faces. Module state for the reason BoxMenu's is: the press is heard by a
  // TextBox and the menu is drawn once, over everything.
  const ask = $state({ x: 0, y: 0, turn: 0 });

  export function openFaceMenu(x, y) {
    ask.x = x;
    ask.y = y;
    ask.turn++;
  }
</script>

<script>
  // The right-click menu on words selected in a box: Bold, Italic, Typeface…
  // and Clear typeface. Each runs through the shortcut registry (`runShortcut`),
  // so the menu, the key and the Inspector's buttons are one command, and each
  // shows its key as the user has it bound. Bold and Italic are checked when
  // all of the words have them, and show "Mixed" when some do.
  //
  // The words stay selected and typed into while it is open: the box's edit
  // does not end on the focus coming here (TextBox.svelte `onEditBlur`), and
  // the focus goes back to the text when it closes, by a choice or Escape.
  import { untrack } from 'svelte';
  import { app, byId, boxText, boxRuns, isTranslateMode } from '../store.svelte.js';
  import { runShortcut, hasShortcutHandler, comboFor, formatCombo } from '../shortcuts.svelte.js';
  import { anchoredOverlay } from '../anchored-overlay.svelte.js';
  import { selectedRange } from '../typing-selection.svelte.js';
  import { rangeFace } from '../runs.js';

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
  const target = $derived.by(() => {
    const b = app.editingId != null ? byId(app.editingId) : null;
    if (!b) return null;
    const text = boxText(b) ?? '';
    const r = selectedRange(b.id, text);
    return r && r[0] < r[1] ? { b, text, r } : null;
  });

  // Nothing selected any more - the edit ended, the words were typed over -
  // takes the menu away.
  $effect(() => {
    if (!overlay.open) return;
    if (!target || isTranslateMode()) overlay.close({ refocus: false });
  });

  $effect(() => {
    if (!overlay.open) return;
    const wheel = (e) => {
      if (!menuEl?.contains(e.target)) overlay.close();
    };
    const away = () => overlay.close({ refocus: false });
    window.addEventListener('wheel', wheel, { capture: true, passive: true });
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('wheel', wheel, { capture: true });
      window.removeEventListener('resize', away);
    };
  });

  const keyOf = (id) => formatCombo(comboFor(id));
  function itemsFor(t) {
    const face = rangeFace(boxRuns(t.b), t.text, t.r[0], t.r[1], t.b.style);
    const keyed = (id, label, extra = {}) => ({ id, label, key: keyOf(id), ok: hasShortcutHandler(id), run: () => runShortcut(id), ...extra });
    return [
      keyed('text.bold', 'Bold', { checked: face.bold }),
      keyed('text.italic', 'Italic', { checked: face.italic }),
      keyed('text.typeface', 'Typeface…', { note: face.font === 'mixed' ? 'Mixed' : face.font }),
      keyed('text.clearFace', 'Clear typeface'),
    ];
  }

  // Bold, Italic and Clear give the focus back to the text first, so the
  // edit goes on; Typeface… opens the Inspector's family picker, which takes
  // it.
  function choose(it) {
    if (!it.ok) return;
    overlay.close({ refocus: it.id !== 'text.typeface' });
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
    {#each itemsFor(target) as it (it.id)}
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
