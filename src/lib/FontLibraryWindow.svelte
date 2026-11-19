<script>
  // The Font Library's own window (font_library.rs): the library, the toasts,
  // and nothing else of the app. It reads the fonts at boot as every window
  // does, and follows the other windows' changes the same way they follow
  // its own (font-window.svelte.js).
  import { onMount } from 'svelte';
  import FontLibrary from './FontLibrary.svelte';
  import Toast from './Toast.svelte';
  import { initTheme } from './theme.svelte.js';
  import { restoreFonts, scanSystemFonts } from './fonts.js';
  import { followFontChanges } from './font-window.svelte.js';
  import { installContextMenuGuard } from './shell-guards.js';
  // Read and applied on import, as in the app (the text engine stays off in
  // this window: main.js marks it).
  import './prefs.svelte.js';

  onMount(() => {
    initTheme();
    const release = installContextMenuGuard(document);
    restoreFonts();
    scanSystemFonts();
    let unlisten = null;
    followFontChanges().then((u) => (unlisten = u));
    // A theme picked in the app's Settings reaches this window too.
    const onStorage = (e) => e.key === 'mt.theme' && initTheme();
    window.addEventListener('storage', onStorage);
    return () => {
      release?.();
      unlisten?.();
      window.removeEventListener('storage', onStorage);
    };
  });
</script>

<FontLibrary />
<Toast />
