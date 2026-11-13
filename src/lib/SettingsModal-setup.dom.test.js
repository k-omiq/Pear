import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';

// The setup's rows in Settings: the usage switch and "Run setup again" under
// General, the chapter mode under Typesetting for a comics install only, and
// the Discord card at the end of About.
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0' }));
vi.mock('./open-external.js', () => ({ openExternal: vi.fn(async () => {}) }));
const probe = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./sidecar.js', async (original) => ({
  ...(await original()),
  checkSidecar: async () => { probe.calls++; return null; },
}));
// One series, so the series tabs (Guide among them) are there with a chapter open.
vi.mock('./library.svelte.js', async (original) => {
  const real = await original();
  const series = { id: 'p', name: 'Series', layout: 'pages', ocrLanguage: 'ja', chapters: [] };
  return { ...real, projectById: (id) => (id === 'p' ? series : real.projectById(id)) };
});

const { default: SettingsModal } = await import('./SettingsModal.svelte');
const { prefs, setPref } = await import('./prefs.svelte.js');
const { onboarding } = await import('./onboarding/onboarding.svelte.js');
const { settingsView, openSettings, closeSettings } = await import('./settings-tabs.svelte.js');
const { openExternal } = await import('./open-external.js');
const { app } = await import('./store.svelte.js');

beforeEach(() => {
  setPref('onboarded', true);
  setPref('usage', 'comics');
  setPref('defaultChapterMode', 'typeset');
});

afterEach(() => {
  cleanup();
  closeSettings();
  settingsView.tab = 'general';
  onboarding.open = false;
  vi.clearAllMocks();
});

/** Settings, bound to the shared open flag the way App.svelte mounts it. */
async function settings(tab = 'general') {
  openSettings(tab);
  const view = render(SettingsModal, {
    get open() {
      return settingsView.open;
    },
    set open(v) {
      settingsView.open = v;
    },
  });
  await tick();
  return view;
}

describe('Settings ▸ General', () => {
  it('switches the usage between Comics and General use', async () => {
    const view = await settings();
    const group = view.getByRole('group', { name: 'Usage' });
    expect(group.querySelector('[aria-pressed="true"]').textContent).toBe('Comics');
    await fireEvent.click(view.getByRole('button', { name: 'General use' }));
    expect(prefs.usage).toBe('general');
    await fireEvent.click(view.getByRole('button', { name: 'Comics' }));
    expect(prefs.usage).toBe('comics');
  });

  it('Run setup again closes Settings and opens the setup from the top', async () => {
    onboarding.step = 'community';
    const view = await settings();
    expect(view.getByText('Walk through the theme, usage and community steps again.')).toBeTruthy();
    await fireEvent.click(view.getByRole('button', { name: 'Run setup again' }));
    await waitFor(() => expect(onboarding.open).toBe(true));
    expect(settingsView.open).toBe(false);
    expect(onboarding.step).toBe('welcome');
    // Already set up, so this run is the forced one and the usage starts picked.
    expect(onboarding.usage).toBe('comics');
  });
});

describe('Settings ▸ Typesetting', () => {
  it('sets what new chapters start as, for a comics install', async () => {
    const view = await settings('typesetting');
    const group = view.getByRole('group', { name: 'New chapters start as' });
    expect(group.querySelector('[aria-pressed="true"]').textContent).toBe('Typeset');
    await fireEvent.click(view.getByRole('button', { name: 'Translate' }));
    expect(prefs.defaultChapterMode).toBe('translate');
  });

  it('has no chapter mode under general use, which has no translate chapters', async () => {
    setPref('usage', 'general');
    const view = await settings('typesetting');
    expect(view.queryByRole('group', { name: 'New chapters start as' })).toBeNull();
  });
});

describe('Settings ▸ About', () => {
  it('ends with the Discord card, which opens the invite', async () => {
    const view = await settings('about');
    expect(view.getByRole('heading', { level: 3, name: 'Join the community' })).toBeTruthy();
    await fireEvent.click(view.getByRole('link', { name: /Join our Discord server/ }));
    expect(openExternal).toHaveBeenCalledWith('https://discord.gg/3ueKc9PaX7');
  });
});

describe('Settings under general use', () => {
  const tabNames = (view) => view.getAllByRole('tab').map((t) => t.textContent.trim());

  it('has no Detection tab, no SFX row and no balloon fit, and comics use brings them back', async () => {
    const view = await settings();
    expect(tabNames(view)).toContain('Detection');
    expect(view.container.textContent).toContain('SFX options');
    setPref('usage', 'general');
    await tick();
    expect(tabNames(view)).not.toContain('Detection');
    expect(view.container.textContent).not.toContain('SFX options');
    settingsView.tab = 'typesetting';
    await tick();
    expect(view.container.textContent).not.toContain('Fit text to balloon');
    setPref('usage', 'comics');
    await tick();
    expect(view.container.textContent).toContain('Fit text to balloon');
    expect(tabNames(view)).toContain('Detection');
  });

  it('opens on General when asked for the Detection tab it does not have', async () => {
    setPref('usage', 'general');
    const view = await settings('detection');
    expect(view.getByRole('tab', { selected: true }).textContent.trim()).toBe('General');
  });

  it('does not start the detection engine when opened, and comics use does', async () => {
    setPref('usage', 'general');
    probe.calls = 0;
    await settings();
    expect(probe.calls).toBe(0);
    cleanup();
    closeSettings();
    setPref('usage', 'comics');
    await settings();
    expect(probe.calls).toBe(1);
  });

  it('leaves the Guide tab for General when general use is picked with it open', async () => {
    app.chapterRef = { projectId: 'p', chapterId: 'c' };
    try {
      const view = await settings('guide');
      expect(view.getByRole('tab', { selected: true }).textContent.trim()).toBe('Guide');
      setPref('usage', 'general');
      await tick();
      expect(view.getByRole('tab', { selected: true }).textContent.trim()).toBe('General');
      expect(tabNames(view)).not.toContain('Guide');
      expect(tabNames(view)).toContain('Text styles');
    } finally {
      app.chapterRef = null;
    }
  });
});
