import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0' }));

const { default: SettingsModal } = await import('./SettingsModal.svelte');
const { prefs, setPref } = await import('./prefs.svelte.js');

beforeEach(() => {
  const storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  });
});

afterEach(() => {
  cleanup();
  setPref('keepEnglish', false);
  vi.unstubAllGlobals();
});

it('offers and persists the English-lettering switch in detection settings', async () => {
  setPref('keepEnglish', false);
  const view = render(SettingsModal, { open: true });
  await tick();
  await fireEvent.click(view.getByRole('tab', { name: 'System' }));
  const toggle = view.getByRole('switch', { name: 'Keep text that is already English' });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  view.getByText('Off: English lettering on the raw is not detected.');

  await fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(prefs.keepEnglish).toBe(true);
  expect(JSON.parse(localStorage.getItem('mt.prefs')).keepEnglish).toBe(true);
  await fireEvent.click(toggle);
  expect(prefs.keepEnglish).toBe(false);
});
