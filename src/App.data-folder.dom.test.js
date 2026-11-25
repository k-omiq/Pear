import { afterEach, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

// The data folder in App.svelte: Unavailable replaces every screen (nothing
// behind it is mounted or scanned), and coming back to the window checks the
// folder again.
const calls = vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
  return { home: 0, scans: 0 };
});
vi.mock('./lib/library.svelte.js', () => ({
  library: { root: '/Users/me/MangaTypesetter', projects: [], error: '' },
  initRoot: async () => {},
  openChapter: async () => {},
  flushBeforeLeaving: async () => true,
  leaveApprovalCurrent: () => true,
  watchProjectRecords: () => {},
  setRoot: async () => {},
  setRootMustExist: () => {},
  setOpenGate: () => {},
  scanLibrary: async () => {
    calls.scans++;
  },
}));
vi.mock('./lib/fonts.js', async (original) => ({ ...await original(), restoreFonts: async () => {}, scanSystemFonts: async () => {} }));
vi.mock('./lib/importer.js', async (original) => ({ ...await original(), isTauri: () => false }));
vi.mock('./lib/sidecar.js', () => ({ checkSidecar: async () => null }));
vi.mock('./lib/agent/windows.js', async (original) => ({ ...await original(), windowRole: async () => ({ label: 'main', agent: false, chapter: null }) }));
vi.mock('./lib/editor/EditorRoot.svelte', () => ({ default: () => {} }));
vi.mock('./lib/FontLibrary.svelte', () => ({ default: () => {} }));
vi.mock('./lib/BrushModal.svelte', () => ({ default: () => {} }));
vi.mock('./lib/SettingsModal.svelte', () => ({ default: () => {} }));
vi.mock('./lib/ExportDialog.svelte', () => ({ default: () => {} }));
vi.mock('./lib/Toast.svelte', () => ({ default: () => {} }));
vi.mock('./lib/home/HomeFrame.svelte', () => ({
  default: () => {
    calls.home++;
  },
}));
vi.mock('./lib/home/LibraryView.svelte', () => ({ default: () => {} }));
vi.mock('./lib/home/ProjectView.svelte', () => ({ default: () => {} }));
vi.mock('./lib/home/NewChapterDialog.svelte', () => ({ default: () => {} }));
vi.mock('./lib/home/ChapterSourcesSheet.svelte', () => ({ default: () => {} }));

const { dataFolder, _setDataFolderCommands, _resetDataFolderForTests } = await import('./lib/data-folder.svelte.js');
const { default: App } = await import('./App.svelte');

async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    await tick();
  }
}
afterEach(async () => {
  await cleanup();
  _setDataFolderCommands(null);
  _resetDataFolderForTests();
});

it('shows the not-found screen in place of the library, then the library once the folder is settled', async () => {
  let status = { state: 'missing', pointer: { schema: 1, path: '/Volumes/Gone/Manga Library', folderId: 'f' } };
  let statusCalls = 0;
  _setDataFolderCommands(async (cmd) => {
    if (cmd === 'data_folder_status') {
      statusCalls++;
      return status;
    }
    return null;
  });
  const view = render(App);
  await settle();
  expect(dataFolder.mode).toBe('unavailable');
  expect(view.getByRole('heading', { name: 'Data folder not found' })).toBeTruthy();
  expect(calls.home, 'no library screen behind it').toBe(0);
  expect(document.activeElement).toBe(view.getByRole('button', { name: 'Try again' }));

  // Back to the window with the drive plugged in (here: no pointer at all).
  status = { state: 'none', pointer: null };
  const before = statusCalls;
  window.dispatchEvent(new Event('focus'));
  await settle();
  expect(statusCalls).toBeGreaterThan(before);
  expect(dataFolder.mode).toBe('legacy');
  expect(view.queryByRole('heading', { name: 'Data folder not found' })).toBeNull();
  expect(calls.home).toBeGreaterThan(0);
  expect(calls.scans).toBeGreaterThan(0);
});

it('a focus that finds the folder gone does not scan', async () => {
  let status = { state: 'none', pointer: null };
  _setDataFolderCommands(async (cmd) => (cmd === 'data_folder_status' ? status : null));
  const view = render(App);
  await settle();
  expect(dataFolder.mode).toBe('legacy');
  const scans = calls.scans;
  status = { state: 'missing', pointer: { schema: 1, path: '/Volumes/Gone/Manga Library', folderId: 'f' } };
  window.dispatchEvent(new Event('focus'));
  await settle();
  expect(dataFolder.mode).toBe('unavailable');
  expect(calls.scans).toBe(scans);
  expect(view.getByRole('heading', { name: 'Data folder not found' })).toBeTruthy();
});
