import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

const { default: FontPicker } = await import('./FontPicker.svelte');
const { app, loadProjectPages, previewBoxFont, endFontPreview, fontPreviewing } = await import('./store.svelte.js');
const { prefs } = await import('./prefs.svelte.js');

const originalFonts = app.fonts;
beforeEach(() => {
  app.fonts = {
    user: [{ name: 'Anime Ace', css: "'Anime Ace'" }, { name: 'Bangers', css: "'Bangers'" }, { name: 'Wild Words', css: "'Wild Words'" }],
    builtin: [],
    system: [],
  };
  prefs.recentFonts = [];
});
afterEach(() => {
  cleanup();
  endFontPreview();
  loadProjectPages([]);
  app.fonts = originalFonts;
});

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const options = () => [...document.querySelectorAll('[role="option"]')];
const option = (name) => options().find((o) => o.textContent.trim() === name);

it('shows each family as the keys move, and picks only on Enter', async () => {
  const onpick = vi.fn();
  const onpreview = vi.fn();
  const view = render(FontPicker, { props: { value: 'Anime Ace', label: 'Font', onpick, onpreview } });
  await fireEvent.click(view.getByRole('button', { name: 'Font' }));
  await tick();
  const search = document.querySelector('input[aria-label="Search fonts"]');
  await fireEvent.keyDown(search, { key: 'ArrowDown' });
  await fireEvent.keyDown(search, { key: 'ArrowDown' });
  await frame();
  // Two steps, one frame: one preview, of where the keys ended.
  expect(onpreview.mock.calls).toEqual([['Wild Words']]);
  expect(onpick).not.toHaveBeenCalled();
  await fireEvent.keyDown(search, { key: 'Enter' });
  expect(onpick).toHaveBeenCalledWith('Wild Words');
  expect(onpreview).toHaveBeenLastCalledWith(null);
  expect(prefs.recentFonts[0]).toBe('Wild Words');
});

it('a held key moves the list and shows the family it stops on', async () => {
  const onpreview = vi.fn();
  const view = render(FontPicker, { props: { value: 'Anime Ace', label: 'Font', onpick: vi.fn(), onpreview } });
  await fireEvent.click(view.getByRole('button', { name: 'Font' }));
  await tick();
  const search = document.querySelector('input[aria-label="Search fonts"]');
  await fireEvent.keyDown(search, { key: 'ArrowDown', repeat: true });
  await fireEvent.keyDown(search, { key: 'ArrowDown', repeat: true });
  await frame();
  expect(onpreview).not.toHaveBeenCalled();
  expect(document.querySelector('.fp-row.on').textContent.trim()).toBe('Wild Words');
  await new Promise((r) => setTimeout(r, 160));
  await frame();
  expect(onpreview.mock.calls).toEqual([['Wild Words']]);
});

it('Escape ends the look with nothing picked', async () => {
  const onpick = vi.fn();
  const onpreview = vi.fn();
  const view = render(FontPicker, { props: { value: 'Anime Ace', label: 'Font', onpick, onpreview } });
  await fireEvent.click(view.getByRole('button', { name: 'Font' }));
  await tick();
  const search = document.querySelector('input[aria-label="Search fonts"]');
  await fireEvent.keyDown(search, { key: 'ArrowDown' });
  await frame();
  await fireEvent.keyDown(search, { key: 'Escape' });
  await tick();
  expect(onpick).not.toHaveBeenCalled();
  expect(onpreview).toHaveBeenLastCalledWith(null);
  expect(options()).toHaveLength(0);
});

it('typing filters the list', async () => {
  const view = render(FontPicker, { props: { value: 'Anime Ace', label: 'Font', onpick: vi.fn() } });
  await fireEvent.click(view.getByRole('button', { name: 'Font' }));
  await tick();
  const search = document.querySelector('input[aria-label="Search fonts"]');
  await fireEvent.input(search, { target: { value: 'wild' } });
  await tick();
  expect(options().map((o) => o.textContent.trim())).toEqual(['Wild Words']);
});

it('lists recent families first', async () => {
  prefs.recentFonts = ['Bangers'];
  const view = render(FontPicker, { props: { value: 'Anime Ace', label: 'Font', onpick: vi.fn() } });
  await fireEvent.click(view.getByRole('button', { name: 'Font' }));
  await tick();
  expect(options()[0].textContent.trim()).toBe('Bangers');
  expect(document.querySelector('.fp-head').textContent).toBe('Recent');
});

it('a click picks the row', async () => {
  const onpick = vi.fn();
  const view = render(FontPicker, { props: { value: 'Anime Ace', label: 'Font', onpick } });
  await fireEvent.click(view.getByRole('button', { name: 'Font' }));
  await tick();
  await fireEvent.click(option('Bangers'));
  expect(onpick).toHaveBeenCalledWith('Bangers');
});

it('a previewed family changes only the family, and goes back when the look ends', () => {
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [{ id: 'b1', x: 10, y: 10, w: 100, h: 60, text: 'Hi', style: { font: 'Anime Ace', size: 20 } }] }]);
  const b = app.pages[0].boxes[0];
  const before = JSON.stringify(b);
  previewBoxFont(b, 'Bangers');
  expect(b.style.font).toBe('Bangers');
  expect(fontPreviewing('b1')).toBe(true);
  endFontPreview();
  expect(fontPreviewing('b1')).toBe(false);
  expect(JSON.stringify(b)).toBe(before);
});
