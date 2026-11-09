<script>
  // One layer effect's "…" menu: Photoshop's Make Default and Reset to
  // Default, and Reset to factory (LAYER_STYLES_PLAN.md item 12). The menu
  // itself is the home rows' (`RowMenu`); what each entry does is the
  // Inspector's, which owns the box and its undo step.
  //
  // `kind`: an `FX_KINDS` name. `name`: what the effect is called on screen.
  // `onpick(id)`: 'make' | 'reset' | 'factory'.
  import RowMenu from './home/RowMenu.svelte';
  import { prefs } from './prefs.svelte.js';

  let { kind, name, onpick } = $props();

  // Advanced Blending is not added to a box, so a saved default only serves
  // Reset; it never reaches a new box.
  const TIP = $derived(kind === 'blending' ? 'Used when you reset these options; a new box starts from the built-in values.' : 'Used when you add or reset this effect.');
  const saved = $derived(!!prefs.fxDefaults?.[kind]);
  const items = $derived([
    { id: 'make', label: 'Make default', title: `Saves these settings as the ${name} default. ${TIP}` },
    { id: 'reset', label: 'Reset to default', title: saved ? `Back to your saved default. ${TIP}` : `No default saved: back to the built-in values. ${TIP}` },
    { id: 'factory', label: 'Reset to factory', title: `Back to the built-in values, and the saved default is forgotten. ${TIP}` },
  ]);
</script>

<RowMenu compact label="{name} defaults" {items} {onpick} />
