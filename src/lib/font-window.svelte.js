// ===== The Font Library's window =====
// In the desktop app the library is a window of its own (font_library.rs),
// one at most: asking again brings it to the front. In a plain browser there
// is one window, so the same library fills the app's window instead
// (`fontLibraryView`), which is what `vite dev` shows.
//
// Each window has its own font lists and its own registered faces; IndexedDB
// and localStorage are what they share. A window that changes the fonts or
// their switches says so with a `fonts-changed` event, and every other window
// reads them again (`followFontChanges`).
import { isTauri } from './importer.js';
import { setFontsWrittenHook, syncUserFonts } from './fonts.js';
import { adoptStoredPrefs } from './prefs.svelte.js';

export const FONT_WINDOW = 'fonts';
const EVENT = 'fonts-changed';

export const fontLibraryView = $state({ open: false });

let invoker = null;
async function invoke(cmd, args) {
  invoker ??= import('@tauri-apps/api/core').then((m) => m.invoke);
  return (await invoker)(cmd, args);
}

// Which window this is, without asking anyone: Tauri puts the label in the
// page before any script runs. `?window=fonts` gives the same in a browser.
export function windowLabel() {
  if (typeof window === 'undefined') return 'main';
  const meta = window.__TAURI_INTERNALS__?.metadata;
  const label = meta?.currentWebview?.label || meta?.currentWindow?.label;
  if (label) return label;
  try {
    return new URLSearchParams(window.location.search).get('window') === FONT_WINDOW ? FONT_WINDOW : 'main';
  } catch {
    return 'main';
  }
}
export const isFontWindow = () => windowLabel() === FONT_WINDOW;

export async function openFontLibrary() {
  if (isTauri()) {
    try {
      await invoke('font_library_open');
      return;
    } catch (e) {
      // A build whose Rust side has no such window: the library opens here.
      console.error('Could not open the Font Library window', e);
    }
  }
  fontLibraryView.open = true;
}
export function closeFontLibrary() {
  fontLibraryView.open = false;
}
// The main window going takes the library window with it.
export async function closeFontLibraryWindow() {
  if (!isTauri()) return;
  await invoke('font_library_close').catch(() => {});
}

// ---- telling the other windows ----
// Batched: an import of forty faces is one event, sent once the writes
// settle, not forty.
let emitTimer = null;
function sendSoon() {
  if (!isTauri()) return;
  clearTimeout(emitTimer);
  emitTimer = setTimeout(async () => {
    try {
      const { emit } = await import('@tauri-apps/api/event');
      await emit(EVENT, { from: windowLabel() });
    } catch {
      /* no event bridge: the other windows catch up at their next launch */
    }
  }, 120);
}
setFontsWrittenHook(sendSoon);

let following = null;
// Every window runs this once at boot. Returns the unlisten.
export async function followFontChanges() {
  if (!isTauri() || following) return following;
  const me = windowLabel();
  try {
    const { listen } = await import('@tauri-apps/api/event');
    following = await listen(EVENT, (e) => {
      if (e?.payload?.from === me) return;
      adoptStoredPrefs();
      syncUserFonts();
    });
  } catch {
    following = null;
  }
  return following;
}
