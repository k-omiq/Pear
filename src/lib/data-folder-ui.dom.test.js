import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The data folder's screens (SHARED_DATA_FOLDER.md section 5): the Settings
// section, the pending card, the not-found screen, and what their buttons do
// (data-folder-actions.js). The Rust commands are stood in for through
// `_setDataFolderCommands`; the dialogs are the plugin's, mocked.
const dlg = vi.hoisted(() => ({ asks: [], answer: true, picked: '/picked' }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: async (text) => {
    dlg.asks.push(text);
    return typeof dlg.answer === 'function' ? dlg.answer(text) : dlg.answer;
  },
  open: async () => dlg.picked,
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
  return {
    fsx: {
      ...real.fsx,
      join: async (...parts) => parts.join('/'),
      exists: async () => false,
      readDir: async () => [],
    },
  };
});
vi.mock('./library.svelte.js', async (original) => ({ ...(await original()), scanLibrary: async () => {} }));

const df = await import('./data-folder.svelte.js');
const { dataFolder, _setDataFolderCommands, _resetDataFolderForTests } = df;
const actions = await import('./data-folder-actions.js');
const { default: DataFolderCard } = await import('./home/DataFolderCard.svelte');
const { default: DataFolderMissing } = await import('./home/DataFolderMissing.svelte');
const { default: SettingsModal } = await import('./SettingsModal.svelte');
const { settingsView, openSettings, closeSettings } = await import('./settings-tabs.svelte.js');
const { app } = await import('./store.svelte.js');
const { library } = await import('./library.svelte.js');

let calls;
let replies;
const names = () => calls.map(([c]) => c);
async function settle() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await tick();
  }
}

beforeEach(() => {
  _resetDataFolderForTests();
  dlg.asks = [];
  dlg.answer = true;
  dlg.picked = '/picked';
  calls = [];
  replies = {};
  app.chapterRef = null;
  library.root = '/Users/me/Documents/MangaTypesetter';
  _setDataFolderCommands(async (cmd, args) => {
    calls.push([cmd, args]);
    if (replies[cmd]) return replies[cmd](args);
    if (cmd === 'data_folder_move_busy') return false;
    if (cmd === 'data_folder_cleaner_running') return false;
    if (cmd === 'data_folder_status') return { state: 'none', pointer: null };
    return null;
  });
});
afterEach(() => {
  cleanup();
  closeSettings();
  app.chapterRef = null;
  _setDataFolderCommands(null);
});

const shared = () => Object.assign(dataFolder, { mode: 'shared', state: 'ok', root: '/Volumes/Work/Manga Library' });
const pending = (both = false) =>
  Object.assign(dataFolder, { mode: 'pending', state: 'ok', root: '/Users/me/Manga Library', bothLibraries: both });

describe('the pending card', () => {
  it('offers the move, and says ahead of time that Manga Cleaner has to be closed', async () => {
    pending();
    replies.data_folder_cleaner_running = () => true;
    const view = render(DataFolderCard);
    await settle();
    const button = view.getByRole('button', { name: 'Move my library' });
    expect(button.disabled).toBe(true);
    expect(view.getByTestId('df-card-why').textContent).toBe('Close Manga Cleaner first.');
    expect(calls).toContainEqual(['data_folder_cleaner_running', { root: '/Users/me/Manga Library' }]);
  });

  it('says what an open chapter blocks', async () => {
    pending();
    app.chapterRef = { projectId: 'p', chapterId: 'c' };
    const view = render(DataFolderCard);
    await settle();
    expect(view.getByTestId('df-card-why').textContent).toBe('Close the open chapter first.');
    expect(view.getByRole('button', { name: 'Move my library' }).disabled).toBe(true);
  });

  it('with two libraries offers the shared one, which needs no closed cleaner', async () => {
    pending(true);
    replies.data_folder_cleaner_running = () => true;
    const view = render(DataFolderCard);
    await settle();
    expect(view.getByText('The shared folder already has a library')).toBeTruthy();
    expect(view.getByText(/stays where it is/).textContent).toContain(library.root);
    const button = view.getByRole('button', { name: 'Use the shared library' });
    expect(button.disabled).toBe(false);
    await fireEvent.click(button);
    await settle();
    expect(dlg.asks[0]).toMatch(/stays where it is, untouched/);
    expect(calls).toContainEqual(['data_folder_adopt', { legacy: null }]);
  });

  it('is not there outside pending mode', async () => {
    shared();
    const view = render(DataFolderCard);
    await settle();
    expect(view.queryByRole('region', { name: 'Shared data folder' })).toBeNull();
  });
});

describe('the not-found screen', () => {
  it('names the folder, takes the focus and tries again', async () => {
    Object.assign(dataFolder, { mode: 'unavailable', state: 'missing', root: '/Volumes/Gone/Manga Library' });
    const view = render(DataFolderMissing);
    await settle();
    expect(view.getByRole('heading').textContent).toBe('Data folder not found');
    expect(view.getByText('/Volumes/Gone/Manga Library')).toBeTruthy();
    const retry = view.getByRole('button', { name: 'Try again' });
    expect(document.activeElement).toBe(retry);
    expect(view.getByRole('button', { name: 'Choose another folder…' })).toBeTruthy();
    await fireEvent.click(retry);
    await settle();
    expect(names()).toContain('data_folder_status');
    expect(dataFolder.mode).toBe('legacy');
  });

  it('for a move that did not finish says why and offers only Try again', async () => {
    Object.assign(dataFolder, {
      mode: 'unavailable',
      state: 'moving',
      root: '/Volumes/Work/Manga Library',
      detail: 'Close Manga Cleaner to finish the move of the data folder.',
    });
    const view = render(DataFolderMissing);
    await settle();
    expect(view.getByRole('heading').textContent).toBe('Data folder move not finished');
    expect(view.getByTestId('df-detail').textContent).toMatch(/Close Manga Cleaner/);
    expect(view.queryByRole('button', { name: 'Choose another folder…' })).toBeNull();
  });
});

describe('Settings ▸ Data folder', () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
  });

  async function settings() {
    openSettings('general');
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

  it('offers the setup in legacy mode', async () => {
    const view = await settings();
    expect(view.getByRole('button', { name: 'Set up shared folder…' }).disabled).toBe(false);
    expect(view.getByRole('button', { name: 'Use existing folder…' }).disabled).toBe(false);
    expect(view.queryByTestId('df-why')).toBeNull();
  });

  it('disables a move while Manga Cleaner is open, and says so', async () => {
    shared();
    replies.data_folder_cleaner_running = () => true;
    const view = await settings();
    expect(view.getByRole('button', { name: 'Move data folder…' }).disabled).toBe(true);
    expect(view.getByRole('button', { name: 'Use existing folder…' }).disabled).toBe(true);
    expect(view.getByTestId('df-why').textContent).toBe('Close Manga Cleaner first.');
  });

  it('disables a move while a job runs or a chapter is open', async () => {
    shared();
    app.chapterRef = { projectId: 'p', chapterId: 'c' };
    const view = await settings();
    expect(view.getByRole('button', { name: 'Move data folder…' }).disabled).toBe(true);
    expect(view.getByTestId('df-why').textContent).toBe('Close the open chapter first.');
  });

  it('cannot be closed while a move runs', async () => {
    shared();
    const view = await settings();
    dataFolder.busy = true;
    await settle();
    const back = view.getByRole('button', { name: 'Close settings' });
    expect(back.disabled).toBe(true);
    await fireEvent.click(back);
    expect(settingsView.open).toBe(true);
    dataFolder.busy = false;
    await settle();
    await fireEvent.click(back);
    expect(settingsView.open).toBe(false);
  });

  it('two libraries: the button uses the shared one', async () => {
    pending(true);
    const view = await settings();
    expect(view.getByRole('button', { name: 'Use the shared library' })).toBeTruthy();
    expect(view.getByText(/already has a typesetter library/)).toBeTruthy();
  });
});

describe('the buttons', () => {
  it('moving onto a folder that is a data folder uses it, asks when the drive cannot tell, and says so', async () => {
    shared();
    replies.data_folder_inspect = () => ({ exists: true, isDir: true, empty: false, marker: true });
    let tries = 0;
    replies.data_folder_use_existing = ({ confirmed }) => {
      tries++;
      if (!confirmed) throw new Error('CANNOT_TELL: This drive cannot tell whether Manga Cleaner is open.');
      return { schema: 1, path: '/picked', folderId: 'f' };
    };
    await actions.pickAndMove();
    expect(tries).toBe(2);
    expect(dlg.asks[0]).toMatch(/already a data folder/);
    expect(dlg.asks[1]).toMatch(/Is Manga Cleaner closed/);
    expect(app.toast.msg).toBe('Using the data folder at /picked.');
  });

  it('a move into a shared folder that has a library already asks to use that one', async () => {
    pending();
    let n = 0;
    replies.data_folder_adopt = () => {
      if (++n === 1) throw new Error('BOTH_LIBRARIES: The shared folder already has a typesetter library.');
      return { method: 'none' };
    };
    await actions.adoptNow();
    expect(dlg.asks[0]).toMatch(/already has a typesetter library/);
    expect(calls.filter(([c]) => c === 'data_folder_adopt')).toHaveLength(2);
    expect(app.toast.msg).toMatch(/Your old library is still at/);
  });

  it('a refusal is a toast without the code word', async () => {
    shared();
    dlg.picked = '/elsewhere';
    replies.data_folder_inspect = () => ({ exists: false, isDir: false, empty: false, marker: false });
    replies.data_folder_move = () => {
      throw new Error('Manga Cleaner is open. Close it first.');
    };
    await actions.pickAndMove();
    expect(app.toast.msg).toBe('Could not move the data folder: Manga Cleaner is open. Close it first.');
  });
});
