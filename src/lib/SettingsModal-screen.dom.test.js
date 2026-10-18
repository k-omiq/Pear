import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// Settings as a full-window screen: the sections down a sidebar, the series
// group only while a chapter of a series is open, and the old tab ids still
// landing somewhere.
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0' }));

const { default: SettingsModal } = await import('./SettingsModal.svelte');
const { app } = await import('./store.svelte.js');
const { library } = await import('./library.svelte.js');
const { settingsView, openSettings, closeSettings, shownSettingsTab } = await import('./settings-tabs.svelte.js');

afterEach(() => {
  cleanup();
  closeSettings();
  settingsView.tab = 'general';
  app.chapterRef = null;
  library.projects = [];
});

const tabNames = (view) => view.getAllByRole('tab').map((t) => t.textContent.trim());

describe('the Settings screen', () => {
  it('is not drawn while closed', () => {
    const view = render(SettingsModal, { open: false });
    expect(view.container.querySelector('.settings-screen')).toBeNull();
  });

  it('lists the app sections, and no series group with no chapter open', async () => {
    const view = render(SettingsModal, { open: true });
    await tick();
    expect(tabNames(view)).toEqual(['General', 'Typesetting', 'Detection', 'AI agents', 'Shortcuts', 'About']);
    expect(view.getByRole('heading', { level: 2 }).textContent).toBe('General');
  });

  it('adds a group named after the open series', async () => {
    library.projects = [{ id: 'p1', name: 'Nine Skies', layout: 'pages', ocrLanguage: 'ja', chapters: [] }];
    app.chapterRef = { projectId: 'p1', chapterId: 'c1' };
    const view = render(SettingsModal, { open: true });
    await tick();
    expect(tabNames(view).slice(-3)).toEqual(['Series', 'Text styles', 'Guide']);
    expect(view.getByText('Nine Skies')).toBeTruthy();
    await fireEvent.click(view.getByRole('tab', { name: 'Series' }));
    expect(view.getByRole('heading', { level: 2 }).textContent).toBe('Series');
    expect(view.container.querySelector('.set-lead').textContent).toContain('Saved with Nine Skies');
  });

  it('moves between sections with the arrow keys', async () => {
    const view = render(SettingsModal, { open: true });
    await tick();
    const general = view.getByRole('tab', { name: 'General' });
    await fireEvent.keyDown(general, { key: 'ArrowDown' });
    expect(settingsView.tab).toBe('typesetting');
    await fireEvent.keyDown(view.getByRole('tab', { name: 'Typesetting' }), { key: 'End' });
    expect(settingsView.tab).toBe('about');
    await fireEvent.keyDown(view.getByRole('tab', { name: 'About' }), { key: 'ArrowDown' });
    expect(settingsView.tab).toBe('general');
  });

  it('closes from the back button', async () => {
    const view = render(SettingsModal, { open: true });
    await tick();
    await fireEvent.click(view.getByRole('button', { name: 'Close settings' }));
    expect(view.container.querySelector('.settings-screen')).toBeNull();
  });
});

describe('opening Settings on a section', () => {
  it('takes the old tab ids to where their settings went', () => {
    openSettings('project');
    expect(settingsView.tab).toBe('series');
    openSettings('system');
    expect(settingsView.tab).toBe('detection');
  });

  it('shows General for a series section with no chapter open, and keeps the choice', () => {
    openSettings('styles');
    expect(shownSettingsTab(false)).toBe('general');
    expect(shownSettingsTab(true)).toBe('styles');
  });
});
