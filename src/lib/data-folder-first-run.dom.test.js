import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The first-run card (SHARED_DATA_FOLDER.md section 7, "First run asks
// once"): in Legacy mode it offers the setup at the default place, once.
// The Rust commands are stood in for through `_setDataFolderCommands`; the
// dialogs are the plugin's, mocked; the legacy library is a folder holding
// one project until the setup moves it.
const dlg = vi.hoisted(() => ({ asks: [], answer: true }));
const disk = vi.hoisted(() => ({ legacy: '/Users/me/Documents/MangaTypesetter', legacyThere: true }));
// The preferences' own store, kept across a reload of the module.
const storage = vi.hoisted(() => {
  const items = {};
  globalThis.localStorage = {
    getItem: (key) => items[key] ?? null,
    setItem: (key, value) => {
      items[key] = String(value);
    },
    removeItem: (key) => {
      delete items[key];
    },
  };
  return items;
});
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: async (text) => {
    dlg.asks.push(text);
    return dlg.answer;
  },
  open: async () => '/picked',
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0' }));
vi.mock('./sidecar.js', async (original) => ({
  ...(await original()),
  checkSidecar: async () => null,
  modelsCacheInfo: async () => null,
}));
vi.mock('./fsx.js', async (original) => {
  const real = await original();
  const inLegacy = (p) => disk.legacyThere && (p === disk.legacy || p === `${disk.legacy}/p1/project.json`);
  return {
    fsx: {
      ...real.fsx,
      join: async (...parts) => parts.join('/'),
      exists: async (p) => inLegacy(p),
      readDir: async (p) => (inLegacy(p) ? [{ name: 'p1', isDirectory: true }] : []),
    },
  };
});
vi.mock('./library.svelte.js', async (original) => ({ ...(await original()), scanLibrary: async () => {} }));

const { dataFolder, _setDataFolderCommands, _resetDataFolderForTests } = await import('./data-folder.svelte.js');
const { default: DataFolderFirstRun } = await import('./home/DataFolderFirstRun.svelte');
const { default: SettingsModal } = await import('./SettingsModal.svelte');
const { settingsView, openSettings, closeSettings } = await import('./settings-tabs.svelte.js');
const { prefs, setPref } = await import('./prefs.svelte.js');
const { app } = await import('./store.svelte.js');
const { library } = await import('./library.svelte.js');

const DEFAULT_ROOT = '/Users/me/Manga Library';
let calls;
let replies;
async function settle() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await tick();
  }
}

beforeEach(() => {
  _resetDataFolderForTests();
  dataFolder.checked = true;
  setPref('dataFolderFirstRun', 'ask');
  dlg.asks = [];
  dlg.answer = true;
  disk.legacyThere = true;
  calls = [];
  replies = {};
  app.chapterRef = null;
  library.root = disk.legacy;
  _setDataFolderCommands(async (cmd, args) => {
    calls.push([cmd, args]);
    if (replies[cmd]) return replies[cmd](args);
    if (cmd === 'data_folder_default_root') return DEFAULT_ROOT;
    if (cmd === 'data_folder_move_busy') return false;
    if (cmd === 'data_folder_cleaner_running') return false;
    if (cmd === 'data_folder_inspect') return { exists: false, isDir: false, empty: false, marker: false };
    if (cmd === 'data_folder_status') return { state: 'none', pointer: null };
    return null;
  });
});
afterEach(() => {
  cleanup();
  closeSettings();
  app.chapterRef = null;
  delete window.__TAURI_INTERNALS__;
  _setDataFolderCommands(null);
});

const card = (view) => view.queryByRole('region', { name: 'One data folder' });

// Settings enables its data folder buttons only in the desktop app.
async function settings() {
  window.__TAURI_INTERNALS__ = {};
  const view = render(SettingsModal, {
    get open() {
      return settingsView.open;
    },
    set open(v) {
      settingsView.open = v;
    },
  });
  await settle();
  return view;
}

describe('the first-run data folder card', () => {
  it('shows in legacy mode with the default place and no answer yet', async () => {
    const view = render(DataFolderFirstRun);
    await settle();
    expect(card(view)).toBeTruthy();
    expect(view.getByText('One data folder for Pear and Manga Cleaner')).toBeTruthy();
    expect(view.getByText(/Your library moves to/).textContent).toContain(DEFAULT_ROOT);
    expect(view.getByText(/show up here/).textContent).toMatch(/Manga Cleaner/);
    expect(view.getByRole('button', { name: 'Move' }).disabled).toBe(false);
    expect(view.getByRole('button', { name: 'Choose folder' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Not now' })).toBeTruthy();
    expect(view.queryByTestId('df-first-run-why')).toBeNull();
  });

  for (const mode of ['pending', 'shared', 'unavailable']) {
    it(`is not there in ${mode} mode`, async () => {
      Object.assign(dataFolder, { mode, state: mode === 'unavailable' ? 'missing' : 'ok', root: DEFAULT_ROOT });
      const view = render(DataFolderFirstRun);
      await settle();
      expect(card(view)).toBeNull();
    });
  }

  it('waits for the first status check and for the default place', async () => {
    dataFolder.checked = false;
    let answer;
    replies.data_folder_default_root = () => new Promise((resolve) => (answer = resolve));
    const view = render(DataFolderFirstRun);
    await settle();
    expect(card(view), 'status not checked yet').toBeNull();
    dataFolder.checked = true;
    await settle();
    expect(card(view), 'default place not known yet').toBeNull();
    answer(DEFAULT_ROOT);
    await settle();
    expect(card(view)).toBeTruthy();
  });

  it('has no card when there is no default place (outside the desktop app)', async () => {
    replies.data_folder_default_root = () => {
      throw new Error('This needs the desktop app');
    };
    const view = render(DataFolderFirstRun);
    await settle();
    expect(card(view)).toBeNull();
  });

  it('Not now records the answer, the card stays away after a reload, and Settings still offers the setup', async () => {
    const view = render(DataFolderFirstRun);
    await settle();
    await fireEvent.click(view.getByRole('button', { name: 'Not now' }));
    await settle();
    expect(card(view)).toBeNull();
    expect(prefs.dataFolderFirstRun).toBe('notNow');
    expect(JSON.parse(storage['mt.prefs']).dataFolderFirstRun).toBe('notNow');
    expect(calls.map(([c]) => c)).not.toContain('data_folder_setup');
    cleanup();

    // A fresh load of the preferences, as at the next start.
    vi.resetModules();
    const reloaded = await import('./prefs.svelte.js');
    expect(reloaded.prefs.dataFolderFirstRun).toBe('notNow');

    const again = render(DataFolderFirstRun);
    await settle();
    expect(card(again)).toBeNull();
    cleanup();

    openSettings('general');
    const set = await settings();
    expect(set.getByRole('button', { name: 'Set up shared folder…' }).disabled).toBe(false);
  });

  it('Move runs the setup at the default place with the legacy library, and records the answer', async () => {
    replies.data_folder_setup = () => {
      disk.legacyThere = false;
      return { method: 'rename' };
    };
    replies.data_folder_status = () =>
      calls.some(([c]) => c === 'data_folder_setup')
        ? { state: 'ok', pointer: { schema: 1, path: DEFAULT_ROOT, folderId: 'f' }, typesetterReady: true }
        : { state: 'none', pointer: null };
    const view = render(DataFolderFirstRun);
    await settle();
    await fireEvent.click(view.getByRole('button', { name: 'Move' }));
    await vi.waitFor(() => expect(prefs.dataFolderFirstRun).toBe('moved'));
    expect(calls).toContainEqual(['data_folder_setup', { root: DEFAULT_ROOT, legacy: disk.legacy, confirmed: false }]);
    expect(dataFolder.mode).toBe('shared');
    expect(library.root).toBe(`${DEFAULT_ROOT}/Typesetter`);
    expect(prefs.dataFolderFirstRun).toBe('moved');
    expect(app.toast.msg).toBe(`Your library is now in the shared folder at ${DEFAULT_ROOT}.`);
    expect(card(view)).toBeNull();
  });

  it('Move asks when the drive cannot tell, and a refusal keeps the card and the question', async () => {
    let tries = 0;
    replies.data_folder_setup = ({ confirmed }) => {
      tries++;
      if (!confirmed) throw new Error('CANNOT_TELL: This drive cannot tell whether Manga Cleaner is open. Close it, then confirm.');
      throw new Error('Pick an empty folder, or one that is already a shared data folder.');
    };
    const view = render(DataFolderFirstRun);
    await settle();
    await fireEvent.click(view.getByRole('button', { name: 'Move' }));
    await vi.waitFor(() => expect(app.toast.msg).toMatch(/^Could not set up/));
    await settle();
    expect(tries).toBe(2);
    expect(dlg.asks[0]).toMatch(/Is Manga Cleaner closed/);
    expect(app.toast.msg).toBe('Could not set up the shared folder: Pick an empty folder, or one that is already a shared data folder.');
    expect(prefs.dataFolderFirstRun).toBe('ask');
    expect(card(view)).toBeTruthy();
  });

  it('Choose folder opens Settings at the Data folder row', async () => {
    const scrolled = [];
    Element.prototype.scrollIntoView = function () {
      scrolled.push(this);
    };
    try {
      const view = render(DataFolderFirstRun);
      await settle();
      await fireEvent.click(view.getByRole('button', { name: 'Choose folder' }));
      expect(settingsView).toMatchObject({ open: true, tab: 'general', section: 'data-folder' });
      expect(prefs.dataFolderFirstRun, 'not an answer').toBe('ask');
      const set = await settings();
      expect(scrolled.map((el) => el.dataset.section)).toEqual(['data-folder']);
      expect(set.getByRole('button', { name: 'Set up shared folder…' })).toBeTruthy();
      expect(settingsView.section).toBeNull();
    } finally {
      delete Element.prototype.scrollIntoView;
    }
  });

  it('Move is disabled with the reason while Manga Cleaner runs in the default place', async () => {
    replies.data_folder_cleaner_running = () => true;
    const view = render(DataFolderFirstRun);
    await settle();
    expect(view.getByRole('button', { name: 'Move' }).disabled).toBe(true);
    expect(view.getByTestId('df-first-run-why').textContent).toBe('Close Manga Cleaner first.');
    expect(calls).toContainEqual(['data_folder_cleaner_running', { root: DEFAULT_ROOT }]);
    expect(view.getByRole('button', { name: 'Not now' }).disabled).toBe(false);
  });

  it('Move is disabled with the reason while a chapter is open', async () => {
    app.chapterRef = { projectId: 'p', chapterId: 'c' };
    const view = render(DataFolderFirstRun);
    await settle();
    expect(view.getByRole('button', { name: 'Move' }).disabled).toBe(true);
    expect(view.getByTestId('df-first-run-why').textContent).toBe('Close the open chapter first.');
  });
});
