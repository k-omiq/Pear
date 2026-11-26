import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The match screen and the banner (SHARED_DATA_FOLDER.md 8.4.2, 8.4.3): the
// best candidate is preselected, a title here goes to one row only, and
// Apply hands the choices to the filer. The filing itself is
// handoff.realfs.test.js.
const applied = vi.hoisted(() => ({ plans: [], pairing: null }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));
vi.mock('./handoff.svelte.js', async (original) => ({
  ...(await original()),
  applyMatch: async (root, plan) => {
    applied.plans.push(plan);
    return [];
  },
  pairingFor: (...args) => (applied.pairing ? applied.pairing(...args) : new Promise(() => {})),
}));

const { handoffMatch, openMatch, closeMatch } = await import('./handoff.svelte.js');
const { library } = await import('./library.svelte.js');
const { default: Screen } = await import('./home/HandoffMatchScreen.svelte');
const { default: Banner } = await import('./home/HandoffMatchBanner.svelte');

async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await tick();
  }
}
const message = (key, number) => ({ key, sentAt: 'T1', send: 'bulk', chapterId: key, title: `Chapter ${number}`, number, label: String(number), numberKey: number, pageCount: 3, cleanedPages: 3 });
const row = (id, name, candidates, messages) => ({ id, libraryId: 'L', projectId: id, name, layout: 'pages', fixed: null, candidates, messages });

beforeEach(() => {
  applied.plans = [];
  applied.pairing = null;
  library.projects = [
    { id: 'pA', name: 'Dungeon Steamer', chapters: [] },
    { id: 'pB', name: 'Dungeon Streamers', chapters: [] },
  ];
  handoffMatch.rows = [
    row('r1', 'Dungeon streamer', ['pA', 'pB'], [message('k1', 1)]),
    row('r2', 'Dungeon streamer!', ['pA'], [message('k2', 1), message('k3', 2)]),
  ];
  handoffMatch.bulk = true;
  handoffMatch.open = false;
});
afterEach(() => {
  cleanup();
  closeMatch();
  handoffMatch.rows = [];
});

describe('the banner', () => {
  it('says how many titles wait and opens the screen', async () => {
    const view = render(Banner);
    await settle();
    expect(view.getByText('Manga Cleaner sent 2 titles. Match them to your titles.')).toBeTruthy();
    await fireEvent.click(view.getByRole('button', { name: 'Match…' }));
    expect(handoffMatch.open).toBe(true);
    await settle();
    expect(view.queryByText(/Manga Cleaner sent/)).toBeNull();
  });
});

describe('the match screen', () => {
  it('preselects the best candidate, gives each title here to one row, and applies the choices', async () => {
    openMatch();
    const view = render(Screen);
    await settle();
    const rows = view.getAllByTestId('match-row');
    expect(rows).toHaveLength(2);
    const first = view.getByRole('combobox', { name: 'Title in Pear for Dungeon streamer' });
    const second = view.getByRole('combobox', { name: 'Title in Pear for Dungeon streamer!' });
    expect(first.value).toBe('pA');
    // pA is taken by the first row: the second does not offer it.
    expect(second.value).toBe('new');
    expect([...second.options].map((o) => o.textContent)).toEqual(['New title in Pear', 'Skip']);
    expect([...first.options].map((o) => o.textContent)).toEqual(['Dungeon Steamer', 'Dungeon Streamers', 'New title in Pear', 'Skip']);
    // Each chapter says what happens: no chapter here has its number.
    expect(view.getAllByRole('combobox', { name: /What happens to Chapter/ }).map((s) => s.value)).toEqual(['new', 'new', 'new']);
    // Moving the first row to pB frees pA for the second.
    first.value = 'pB';
    await fireEvent.change(first);
    await settle();
    expect([...second.options].map((o) => o.textContent)).toContain('Dungeon Steamer');
    second.value = 'pA';
    await fireEvent.change(second);
    await settle();
    await fireEvent.click(view.getByRole('button', { name: 'Apply' }));
    await settle();
    expect(applied.plans[0]).toEqual([
      { rowId: 'r1', choice: 'pB', chapters: { k1: 'new' } },
      { rowId: 'r2', choice: 'pA', chapters: { k2: 'new', k3: 'new' } },
    ]);
    expect(handoffMatch.open).toBe(false);
  });

  it('a bulk title with no candidate preselects "New title in Pear"', async () => {
    handoffMatch.rows = [row('r1', 'Brand new series', [], [message('k1', 1)])];
    openMatch();
    const view = render(Screen);
    await settle();
    const sel = view.getByRole('combobox', { name: 'Title in Pear for Brand new series' });
    expect(sel.value).toBe('new');
    expect([...sel.options].map((o) => o.textContent)).toEqual(['New title in Pear', 'Skip']);
    expect(view.getByRole('combobox', { name: 'What happens to Chapter 1' }).value).toBe('new');
  });

  it('a row fixed on a linked project offers only that project', async () => {
    handoffMatch.rows = [{ ...row('r1', 'Dungeon streamer', [], [message('k1', 1)]), fixed: 'pA' }];
    openMatch();
    const view = render(Screen);
    await settle();
    const sel = view.getByRole('combobox', { name: 'Title in Pear for Dungeon streamer' });
    expect([sel.value, sel.disabled, sel.options.length]).toEqual(['pA', true, 1]);
  });

  describe('a chapter Pear has with that number', () => {
    const chapter = { id: 'cA1', number: 1, cleanerLink: null, dir: '/x' };
    const pending = () => {
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      applied.pairing = () => promise;
      return resolve;
    };
    beforeEach(() => {
      library.projects = [{ id: 'pA', name: 'Dungeon Steamer', chapters: [chapter] }];
      handoffMatch.rows = [row('r1', 'Dungeon streamer', ['pA'], [message('k1', 1)])];
    });

    it('says "Checking pages…" with Apply off until the pages are read; pages that do not pair keep waiting', async () => {
      const resolve = pending();
      openMatch();
      const view = render(Screen);
      await settle();
      expect(view.getByTestId('checking').textContent).toBe('Checking pages…');
      expect(view.queryByRole('combobox', { name: /What happens to/ })).toBeNull();
      expect(view.getByRole('button', { name: 'Apply' }).disabled).toBe(true);
      resolve({ ok: false, why: 'Pages differ: 15 in Manga Cleaner, 14 in Pear' });
      await settle();
      const sel = view.getByRole('combobox', { name: 'What happens to Chapter 1' });
      expect(sel.value).toBe('wait');
      expect([...sel.options].map((o) => o.textContent)).toEqual(['Keep waiting', 'Add as a separate chapter', 'Skip this chapter']);
      expect(view.getByText('Pages differ: 15 in Manga Cleaner, 14 in Pear')).toBeTruthy();
      await fireEvent.click(view.getByRole('button', { name: 'Apply' }));
      await settle();
      expect(applied.plans[0]).toEqual([{ rowId: 'r1', choice: 'pA', chapters: { k1: 'wait' } }]);
    });

    it('pages that pair default to link, never to a separate chapter', async () => {
      const resolve = pending();
      openMatch();
      const view = render(Screen);
      await settle();
      resolve({ ok: true, pairs: [{ index: 0, pageId: 1, how: 'same', pear: 0 }], identical: 1, byPosition: 0 });
      await settle();
      expect(view.getByRole('combobox', { name: 'What happens to Chapter 1' }).value).toBe('link');
      expect(view.getByRole('button', { name: 'Apply' }).disabled).toBe(false);
    });
  });
});
