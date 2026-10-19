// ===== Themes =====
// 'system' plus five fixed themes. Light, dark and system came first; Sakura,
// Jade and Ocean are Manga Cleaner's colour themes, ported so the two apps can
// match. Each fixed name is a [data-theme] block in styles.css.
//
// For light and dark, three states, not two: 'system' follows the OS appearance and is what an app
// with no stored preference starts in; 'light' and 'dark' are an explicit choice
// and outrank the system for good, until the user picks 'system' again.
//
// This reverses the earlier decision, which was explicit-only with deliberately
// no prefers-color-scheme fallback so the app could never change appearance
// underfoot. In review that read as the app ignoring the machine it runs on -
// a desktop window that stays light while everything around it goes dark at
// sunset looks broken, not stable - and the two explicit modes are still there
// for anyone who wants it pinned. `mode` is what the user chose; `resolved` is
// what is actually on screen, which is what the Settings control needs to show
// both of at once.

// Mirrored, along with the light/dark/system resolution below, by the inline
// pre-paint script in index.html - which puts [data-theme] on the root before
// the first frame, because this module cannot run until the bundle has loaded
// and by then the wrong theme has already been painted. Change either the key
// or the rule and the other has to move with it, or the app flashes again.
const KEY = 'mt.theme';

export const THEMES = ['system', 'light', 'dark', 'sakura', 'jade', 'ocean'];
export const THEME_LABELS = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
  sakura: 'Sakura',
  jade: 'Jade',
  ocean: 'Ocean',
};

export const theme = $state({ mode: 'system', resolved: 'light' });

// The Dock / taskbar icon follows the theme: each fixed theme has its own pear,
// drawn by scripts/make-icon.mjs and swapped in by `set_theme_icon`. Only on a
// change, so the OS-appearance listener does not re-send the same icon.
let iconFor = null;
function syncIcon(name) {
  if (name === iconFor || typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return;
  iconFor = name;
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('set_theme_icon', { theme: name }))
    .catch((error) => console.warn('theme icon', error));
}

// One query for the lifetime of the module. The listener on it is the whole of
// "no restart": a mid-session switch in System Settings re-runs `apply` and the
// app follows within the frame. Creating the query per call would leak a
// listener per theme change, and dropping the listener would mean the app only
// picked the system up at launch - which is the behaviour being replaced.
const mq =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

function apply() {
  theme.resolved = theme.mode === 'system' ? (mq?.matches ? 'dark' : 'light') : theme.mode;
  // Always an explicit value on the root, even when following the system: the
  // stylesheet themes off [data-theme] alone, so nothing has to be duplicated
  // into a media query, and an explicit choice cannot be second-guessed by one.
  document.documentElement.dataset.theme = theme.resolved;
  syncIcon(theme.resolved);
}

export function setTheme(mode) {
  theme.mode = THEMES.includes(mode) ? mode : 'system';
  apply();
  try {
    localStorage.setItem(KEY, theme.mode);
  } catch {
    /* ignore - a missing preference just means following the system next launch */
  }
}

export function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* ignore */
  }
  // Only a fixed theme name is a choice someone made; anything else - including
  // no stored value at all, and including an unknown value - falls through to
  // the system.
  setTheme(saved);
  // Fires only while the preference is 'system'; `apply` reads `theme.mode`
  // first, so an explicit choice ignores the event rather than needing the
  // listener removed and re-added around every setting change.
  mq?.addEventListener('change', apply);
}
