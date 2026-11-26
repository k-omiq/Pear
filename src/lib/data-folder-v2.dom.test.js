import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// Version 2 of the data folder's screens (SHARED_DATA_FOLDER.md 5.4, 5.5,
// 11): the start dialog in each state, the Join step of the first-run setup,
// the not-found screen checking again by itself, and the pending card after
// a declined Join. The Rust commands are stood in for through
// `_setDataFolderCommands`.
const dlg = vi.hoisted(() => ({ asks: [], answer: true, picked: '/Volumes/Big' }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: async (text) => {
    dlg.asks.push(text);
    return dlg.answer;
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
const disk = vi.hoisted(() => ({ legacy: '/Users/me/Documents/MangaTypesetter', holds: true }));
vi.mock('./fsx.js', async (original) => {
  const real = await original();
  const inLegacy = (p) => disk.holds && (p === disk.legacy || p === `${disk.legacy}/p1/project.json`);
  return {
    fsx: {
      ...real.fsx,
      join: async (...parts) => parts.join('/'),
      exists: async (p) => inLegacy(p),
      readDir: async (p) => (inLegacy(p) ? [{ name: 'p1', isDirectory: true }] : []),
      homeDir: async () => '/Users/me',
    },
  };
});
vi.mock('./library.svelte.js', async (original) => ({ ...(await original()), scanLibrary: async () => {} }));

const df = await import('./data-folder.svelte.js');
const { dataFolder, _setDataFolderCommands, _resetDataFolderForTests } = df;
const { default: DataFolderDialog } = await import('./home/DataFolderDialog.svelte');
const { default: DataFolderMissing } = await import('./home/DataFolderMissing.svelte');
const { default: DataFolderCard } = await import('./home/DataFolderCard.svelte');
const { default: Onboarding } = await import('./onboarding/Onboarding.svelte');
const ob = await import('./onboarding/onboarding.svelte.js');
const { prefs, setPref } = await import('./prefs.svelte.js');
const { app } = await import('./store.svelte.js');
const { library } = await import('./library.svelte.js');

const DEFAULT = '/Users/me/Manga Library';
let calls;
let replies;
const names = () => calls.map(([c]) => c);
async function settle() {
  for (let i = 0; i < 14; i++) {
    await Promise.resolve();
    await tick();
  }
}

beforeEach(() => {
  _resetDataFolderForTests();
  ob.finishOnboarding();
  setPref('dataFolderFirstRun', { setup: null, join: null });
  dlg.asks = [];
  dlg.answer = true;
  disk.holds = true;
  calls = [];
  replies = {};
  app.chapterRef = null;
  library.root = disk.legacy;
  dataFolder.checked = true;
  _setDataFolderCommands(async (cmd, args) => {
    calls.push([cmd, args]);
    if (replies[cmd]) return replies[cmd](args);
    if (cmd === 'data_folder_default_root') return DEFAULT;
    if (cmd === 'data_folder_move_busy') return false;
    if (cmd === 'data_folder_cleaner_running') return false;
    if (cmd === 'data_folder_plan') return { hasLibrary: true, bytes: 9.7e9, sameVolume: true };
    if (cmd === 'data_folder_inspect') return { exists: false, isDir: false, empty: false, marker: false };
    if (cmd === 'data_folder_status') return { state: 'none', pointer: null };
    if (cmd === 'data_folder_sister') return { present: true, source: 'appData' };
    return null;
  });
});
afterEach(() => {
  cleanup();
  app.chapterRef = null;
  _setDataFolderCommands(null);
  vi.useRealTimers();
});

const dialog = (view) => view.queryByRole('dialog', { name: 'One folder for both apps' }) ?? view.queryByRole('dialog', { name: 'Done' });

describe('the start dialog, Set up (row F)', () => {
  it('says what it is, where, and what will happen; Not now is kept and it is gone', async () => {
    dataFolder.start = 'setup';
    const view = render(DataFolderDialog);
    await settle();
    expect(dialog(view)).toBeTruthy();
    expect(view.getByText('Manga Cleaner and Pear keep your titles in one place.')).toBeTruthy();
    expect(view.getByText('Chapters you clean show up in Pear when you save them.')).toBeTruthy();
    expect(view.getByTestId('df-dialog-path').textContent).toBe('~/Manga Library');
    expect(view.getByTestId('df-dialog-what').textContent).toBe('Your library moves there. It takes a moment.');
    expect(view.getByRole('button', { name: 'Change…' })).toBeTruthy();
    await fireEvent.click(view.getByRole('button', { name: 'Not now' }));
    await settle();
    expect(prefs.dataFolderFirstRun).toEqual({ setup: 'declined', join: null });
    expect(dialog(view)).toBeNull();
  });

  it('another drive says the size and the time; Change… picks the folder', async () => {
    replies.data_folder_plan = ({ root }) => ({ hasLibrary: true, bytes: 9.7e9, sameVolume: root === DEFAULT });
    replies.data_folder_inspect = () => ({ exists: true, isDir: true, empty: false, marker: false });
    dataFolder.start = 'setup';
    const view = render(DataFolderDialog);
    await settle();
    await fireEvent.click(view.getByRole('button', { name: 'Change…' }));
    await settle();
    expect(view.getByTestId('df-dialog-path').textContent).toBe('/Volumes/Big/Manga Library');
    expect(view.getByTestId('df-dialog-what').textContent).toBe('Your library (9.7 GB) is copied there. It takes about 9 minutes.');
  });

  it('Use one folder runs the setup there and says Done, with how to bring the titles across', async () => {
    replies.data_folder_setup = () => {
      replies.data_folder_status = () => ({ state: 'ok', pointer: { schema: 1, path: DEFAULT, folderId: 'f' }, typesetterReady: true });
      return { method: 'rename' };
    };
    dataFolder.start = 'setup';
    const view = render(DataFolderDialog);
    await settle();
    await fireEvent.click(view.getByRole('button', { name: 'Use one folder' }));
    await settle();
    expect(calls).toContainEqual(['data_folder_setup', { root: DEFAULT, legacy: disk.legacy, confirmed: false }]);
    await vi.waitFor(() => view.getByText('Done. Both apps now use ~/Manga Library.'));
    expect(view.getByText('To bring your Manga Cleaner titles across, use Send to Pear in Manga Cleaner.')).toBeTruthy();
    expect(prefs.dataFolderFirstRun.setup).toBe('accepted');
    await fireEvent.click(view.getByRole('button', { name: 'Done' }));
    await settle();
    expect(dialog(view)).toBeNull();
  });

  it('Blocked: Manga Cleaner open in that folder disables the move and offers Check again', async () => {
    replies.data_folder_cleaner_running = () => true;
    dataFolder.start = 'setup';
    const view = render(DataFolderDialog);
    await settle();
    expect(view.getByTestId('df-dialog-blocked').textContent).toBe('Close Manga Cleaner first.');
    expect(view.getByRole('button', { name: 'Use one folder' }).disabled).toBe(true);
    replies.data_folder_cleaner_running = () => false;
    await fireEvent.click(view.getByRole('button', { name: 'Check again' }));
    await settle();
    expect(view.queryByTestId('df-dialog-blocked')).toBeNull();
    expect(view.getByRole('button', { name: 'Use one folder' }).disabled).toBe(false);
  });

  it('Failed: plain words, never the system text, and Nothing was changed when that is true', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    replies.data_folder_setup = () => {
      throw new Error('Could not create /Users/me/Manga Library: Permission denied (os error 13)');
    };
    dataFolder.start = 'setup';
    const view = render(DataFolderDialog);
    await settle();
    await fireEvent.click(view.getByRole('button', { name: 'Use one folder' }));
    await settle();
    expect(view.getByTestId('df-dialog-failed').textContent).toBe('This app is not allowed to write there.');
    expect(view.getByText('Nothing was changed.')).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/os error/);
    expect(prefs.dataFolderFirstRun.setup).toBe(null);
    warn.mockRestore();
  });

  it('Working: a progress bar that says how far the copy is, and no way to close', async () => {
    let finish;
    replies.data_folder_setup = () => new Promise((r) => (finish = r));
    replies.data_folder_progress = () => ({ active: true, done: 5.5e9, total: 9.7e9 });
    dataFolder.start = 'setup';
    const view = render(DataFolderDialog);
    await settle();
    await fireEvent.click(view.getByRole('button', { name: 'Use one folder' }));
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    expect(view.getByText('Copying 5.5 of 9.7 GB')).toBeTruthy();
    expect(view.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('57');
    expect(view.queryByRole('button', { name: 'Not now' })).toBeNull();
    await fireEvent.keyDown(dialog(view), { key: 'Escape' });
    expect(dialog(view)).toBeTruthy();
    finish({ method: 'copy' });
    await settle();
  });

  it('is not shown over the first-run setup', async () => {
    dataFolder.start = 'setup';
    ob.offerOnboarding({ force: true });
    const view = render(DataFolderDialog);
    await settle();
    expect(dialog(view)).toBeNull();
    ob.finishOnboarding();
    await settle();
    expect(dialog(view)).toBeTruthy();
  });
});

describe('the start dialog, Join (row D)', () => {
  it('names the folder Manga Cleaner uses, with no Change…, and joins', async () => {
    Object.assign(dataFolder, { mode: 'pending', state: 'ok', root: '/Volumes/Work/Manga Library', start: 'join' });
    replies.data_folder_plan = () => ({ hasLibrary: true, bytes: 4.4e9, sameVolume: false });
    replies.data_folder_adopt = () => {
      replies.data_folder_status = () => ({ state: 'ok', pointer: { schema: 1, path: '/Volumes/Work/Manga Library', folderId: 'f' }, typesetterReady: true });
      return { method: 'copy' };
    };
    const view = render(DataFolderDialog);
    await settle();
    expect(view.getByTestId('df-dialog-path').textContent).toBe('/Volumes/Work/Manga Library');
    expect(view.queryByRole('button', { name: 'Change…' })).toBeNull();
    expect(view.getByTestId('df-dialog-what').textContent).toBe(
      'Manga Cleaner already uses this folder. Your library (4.4 GB) is copied in next to it. It takes about 4 minutes.',
    );
    await fireEvent.click(view.getByRole('button', { name: 'Use one folder' }));
    await vi.waitFor(() => view.getByText('Done. Both apps now use /Volumes/Work/Manga Library.'));
    expect(names()).toContain('data_folder_adopt');
    expect(prefs.dataFolderFirstRun.join).toBe('accepted');
  });

  it('after Not now the pending card stays away too: the question is not asked again', async () => {
    Object.assign(dataFolder, { mode: 'pending', state: 'ok', root: '/Users/me/Manga Library', start: 'join' });
    const view = render(DataFolderDialog);
    const card = render(DataFolderCard);
    await settle();
    expect(card.queryByRole('region', { name: 'Shared data folder' })).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Not now' }));
    await settle();
    expect(prefs.dataFolderFirstRun.join).toBe('declined');
    expect(card.queryByRole('region', { name: 'Shared data folder' })).toBeNull();
    // Settings still offers it; the card shows again only for two libraries.
    dataFolder.bothLibraries = true;
    await settle();
    expect(card.queryByRole('region', { name: 'Shared data folder' })).toBeTruthy();
  });
});

describe('the first-run Join step (row C)', () => {
  it('is a step only when the start table says so, and joining makes the library there', async () => {
    Object.assign(dataFolder, { mode: 'pending', state: 'ok', root: '/Users/me/Manga Library', start: null });
    ob.offerOnboarding({ force: true });
    expect(ob.onboardingSteps()).not.toContain('join');
    ob.finishOnboarding();
    dataFolder.start = 'joinStep';
    ob.offerOnboarding({ force: true });
    ob.pickUsage('comics');
    expect(ob.onboardingSteps()).toEqual(['welcome', 'theme', 'scope', 'usage', 'join', 'detection', 'community']);
    ob.onboarding.step = 'join';
    replies.data_folder_adopt = () => {
      replies.data_folder_status = () => ({ state: 'ok', pointer: { schema: 1, path: '/Users/me/Manga Library', folderId: 'f' }, typesetterReady: true });
      return { method: 'none' };
    };
    disk.holds = false;
    const view = render(Onboarding);
    await settle();
    expect(view.getByText('Manga Cleaner already keeps its titles in ~/Manga Library. Use the same folder?')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Continue' }).disabled).toBe(true);
    await fireEvent.click(view.getByRole('button', { name: 'Use the same folder' }));
    await settle();
    expect(calls).toContainEqual(['data_folder_adopt', { legacy: null, confirmed: false }]);
    expect(prefs.dataFolderFirstRun.join).toBe('accepted');
    expect(dataFolder.mode).toBe('shared');
    expect(ob.onboarding.step).toBe('detection');
  });

  it('Keep separate is kept and moves on', async () => {
    Object.assign(dataFolder, { mode: 'pending', state: 'ok', root: '/Users/me/Manga Library', start: 'joinStep' });
    ob.offerOnboarding({ force: true });
    ob.pickUsage('general');
    ob.onboarding.step = 'join';
    const view = render(Onboarding);
    await settle();
    await fireEvent.click(view.getByRole('button', { name: 'Keep separate' }));
    await settle();
    expect(prefs.dataFolderFirstRun).toEqual({ setup: null, join: 'declined' });
    expect(ob.onboarding.step).toBe('community');
    expect(names()).not.toContain('data_folder_adopt');
    expect(dataFolder.start).toBe(null);
  });
});

describe('the not-found screen', () => {
  it('checks again by itself every 3 seconds while it is shown', async () => {
    vi.useFakeTimers();
    Object.assign(dataFolder, { mode: 'unavailable', state: 'missing', root: '\\\\?\\D:\\Manga Library' });
    replies.data_folder_status = () => ({ state: 'missing', pointer: { schema: 1, path: '\\\\?\\D:\\Manga Library', folderId: 'f' } });
    const view = render(DataFolderMissing);
    await vi.advanceTimersByTimeAsync(10);
    expect(view.getByText('D:\\Manga Library')).toBeTruthy();
    expect(names().filter((n) => n === 'data_folder_status')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(names().filter((n) => n === 'data_folder_status')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(names().filter((n) => n === 'data_folder_status')).toHaveLength(2);
    view.unmount();
    await vi.advanceTimersByTimeAsync(6000);
    expect(names().filter((n) => n === 'data_folder_status')).toHaveLength(2);
  });

  it('says a damaged Pear folder is damaged', async () => {
    Object.assign(dataFolder, { mode: 'unavailable', state: 'damaged', root: '/Users/me/Manga Library', detail: 'The Pear folder inside the data folder is damaged.' });
    const view = render(DataFolderMissing);
    await settle();
    expect(view.getByRole('heading').textContent).toBe('Data folder damaged');
    expect(view.getByText(/The Pear folder inside the data folder is damaged/)).toBeTruthy();
    expect(view.queryByTestId('df-detail')).toBeNull();
  });
});
