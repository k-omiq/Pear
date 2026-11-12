// ===== Open a link in the person's browser =====
// The desktop app hands the URL to the opener plugin, whose capability lists
// every URL it may open (src-tauri/capabilities/default.json), so a link
// added here must be added there too or the plugin refuses it. The browser
// dev build has no plugin, and a new tab is the same thing there.
import { isTauri } from './importer.js';
import { toastError } from './store.svelte.js';

export async function openExternal(url) {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch (e) {
    // A refused or failed open would otherwise look like a dead link.
    toastError(`Could not open the link: ${e?.message ?? e}`);
  }
}
