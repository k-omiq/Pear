<script>
  // The Inspector as EditorRoot holds it: drawn only while the Text box
  // options panel is shown (FloatingPanel draws nothing for a hidden one).
  import Inspector from '../lib/Inspector.svelte';
  import { panels } from '../lib/editor/panels.svelte.js';
</script>

{#if !panels.options.hidden}<Inspector />{/if}
