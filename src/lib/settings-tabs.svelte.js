// ===== Is Settings open, and on which tab =====
// Out here rather than in App.svelte or the modal for the same reason as the
// Inspector's tabs (`inspector-tabs.svelte.js`): more than one place has to open
// Settings on a given tab - the command palette lists every tab, and a pane
// that needs a setting changed (the SFX pane's "needs the Rust engine") wants
// to land the user on it rather than on whichever tab was last open. The modal
// reads this; anything else opens it through `openSettings`.
//
// Session-only, like the Inspector's: the tab a session opens on is General.
// The series sections are shown only while a chapter is open, because what they
// edit is the open chapter's project; asked for with none open, Settings opens
// on General (see `shownSettingsTab`).
export const SETTINGS_TABS = ['general', 'typesetting', 'detection', 'ai', 'shortcuts', 'about', 'series', 'styles', 'guide'];
export const SERIES_SETTINGS_TABS = ['series', 'styles', 'guide'];
// The ids of the old six-tab modal, for any caller still using them.
const OLD_TABS = { project: 'series', system: 'detection' };

export const settingsView = $state({ open: false, tab: 'general' });

// Open Settings, on `tab` when it names one. Anything else - including the
// click event a plain `onclick={onSettings}` hands over - opens it on the tab
// it was last on, which is what the gear buttons have always done.
export function openSettings(tab) {
  const id = typeof tab === 'string' ? (OLD_TABS[tab] ?? tab) : null;
  if (SETTINGS_TABS.includes(id)) settingsView.tab = id;
  settingsView.open = true;
}

export function closeSettings() {
  settingsView.open = false;
}

// The tab actually on screen. A series section with no chapter open has
// nothing to show, so it falls back to General rather than to an empty pane -
// and the stored choice is left alone, so reopening with a chapter open lands
// back on it.
export function shownSettingsTab(hasProject) {
  return SERIES_SETTINGS_TABS.includes(settingsView.tab) && !hasProject ? 'general' : settingsView.tab;
}
