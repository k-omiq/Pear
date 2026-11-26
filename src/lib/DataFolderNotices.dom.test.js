import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// One-time data folder notices (SHARED_DATA_FOLDER.md 5.2 and 7): they stay
// until closed or Show, no toast replaces them, and they count as shown
// only once they were on screen (App mounts them after the first-run setup).
const calls = vi.hoisted(() => ({ reveal: [] }));
// A localStorage of its own (the dom lane may run without one).
const store = new Map();
vi.stubGlobal('localStorage', {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));
vi.mock('./data-folder.svelte.js', async (original) => ({
  ...(await original()),
  revealDataFolder: async (path) => {
    calls.reveal.push(path);
  },
}));

const { notices, addNotice, loadNotices, _resetNoticesForTests } = await import('./data-folder-notices.svelte.js');
const { toast, app } = await import('./store.svelte.js');
const { default: Notices } = await import('./home/DataFolderNotices.svelte');
const { default: Toast } = await import('./Toast.svelte');

async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await tick();
  }
}
const KEY = 'mt.dataFolderNotices';

beforeEach(() => {
  calls.reveal = [];
  _resetNoticesForTests();
});
afterEach(() => {
  cleanup();
  _resetNoticesForTests();
});

describe('a one-time data folder notice', () => {
  it('is not replaced by a toast, stays, and Show opens the folder and closes it', async () => {
    addNotice({ id: 'quiet:/home/me/Manga Library', text: 'Your library now lives in ~/Manga Library.', reveal: '/home/me/Manga Library' });
    const view = render(Notices);
    render(Toast);
    await settle();
    toast('Detection ready · cpu');
    await settle();
    expect(app.toast.msg).toBe('Detection ready · cpu');
    expect(view.getByTestId('df-notice').textContent).toMatch('Your library now lives in ~/Manga Library.');
    await fireEvent.click(view.getByRole('button', { name: 'Show' }));
    await settle();
    expect(calls.reveal).toEqual(['/home/me/Manga Library']);
    expect(view.queryByTestId('df-notice')).toBeNull();
  });

  it('counts as shown only once it was on screen', async () => {
    addNotice({ id: 'recovered:x', text: 'A move that was stopped has been finished.' });
    // Not drawn yet (the first-run setup is open): kept for the next start.
    expect(JSON.parse(localStorage.getItem(KEY))).toHaveLength(1);
    notices.items = [];
    loadNotices();
    expect(notices.items.map((n) => n.id)).toEqual(['recovered:x']);
    const view = render(Notices);
    await settle();
    expect(view.getByTestId('df-notice')).toBeTruthy();
    expect(localStorage.getItem(KEY)).toBeNull();
    // Closed: gone, and not back at the next start.
    await fireEvent.click(view.getByRole('button', { name: 'Close' }));
    await settle();
    expect(notices.items).toEqual([]);
    loadNotices();
    expect(notices.items).toEqual([]);
  });

  it('the same notice is shown once', () => {
    addNotice({ id: 'a', text: 'One' });
    addNotice({ id: 'a', text: 'One' });
    expect(notices.items).toHaveLength(1);
  });
});
