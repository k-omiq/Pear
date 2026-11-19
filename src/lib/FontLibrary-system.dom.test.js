import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The installed fonts as the desktop app has them: a machine has a thousand
// or more, and the library makes rows only for the screenful in view.

// jsdom has no layout: the list's height binding needs the observer to exist.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock('./importer.js', async (original) => ({ ...(await original()), isTauri: () => true }));
vi.mock('./fonts.js', async (original) => ({ ...(await original()), scanSystemFonts: async () => {} }));

const { default: FontLibrary } = await import('./FontLibrary.svelte');
const { app } = await import('./store.svelte.js');
const { prefs, setPref } = await import('./prefs.svelte.js');
const { systemFontEntry } = await import('./fonts.js');

afterEach(() => {
  cleanup();
  app.fonts.system = [];
  setPref('shownSystemFonts', []);
});

it('makes rows only for what is in view, and switches a family into the menus', async () => {
  app.fonts.system = Array.from({ length: 1500 }, (_, i) => systemFontEntry({ name: `Family ${String(i).padStart(4, '0')}`, faces: { regular: true, bold: i % 2 === 0 } }));
  const view = render(FontLibrary, { props: { embedded: true } });
  await fireEvent.click(view.getByRole('button', { name: /^On this computer/ }));
  await tick();
  const rows = document.querySelectorAll('.fl-row.abs');
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThan(60);
  expect(document.querySelector('.fl-vlist-inner').style.height).toBe(`${1500 * 44}px`);
  await fireEvent.click(view.getByRole('switch', { name: 'Offer Family 0001 in the font menus' }));
  expect(prefs.shownSystemFonts).toEqual(['Family 0001']);

  // A search narrows the list; the bulk switch turns every match on at once.
  await fireEvent.input(view.getByRole('searchbox', { name: 'Search installed fonts' }), { target: { value: 'Family 014' } });
  await tick();
  // jsdom measures the list 0 tall, so only the overscan rows are made.
  expect(document.querySelector('.fl-vlist-inner').style.height).toBe(`${10 * 44}px`);
  await fireEvent.click(view.getByRole('button', { name: 'Turn 10 on' }));
  expect(prefs.shownSystemFonts).toHaveLength(11);
});
