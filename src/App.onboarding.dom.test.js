import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

// The first-run setup as App mounts it: offered only once the window's role
// is known, never in an agent's window, and run again from the real Settings
// screen with focus going back to what opened Settings.
const calls = vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
  return { role: null, probes: 0 };
});
vi.mock('./lib/library.svelte.js', async (original) => ({
  ...(await original()),
  initRoot: async () => {},
  scanLibrary: async () => { throw new Error('no library in this test'); },
  watchProjectRecords: () => {},
}));
vi.mock('./lib/fonts.js', async (original) => ({ ...await original(), restoreFonts: async () => {}, scanSystemFonts: async () => {} }));
vi.mock('./lib/importer.js', async (original) => ({ ...await original(), isTauri: () => false }));
vi.mock('./lib/sidecar.js', () => ({ checkSidecar: async () => { calls.probes++; return null; }, modelsCacheInfo: async () => null, clearModelsCache: async () => null }));
// The role answers when the test says so, as the Rust side does at boot.
vi.mock('./lib/agent/windows.js', async (original) => ({
  ...await original(),
  windowRole: () => new Promise((resolve) => (calls.role = resolve)),
  agentWindowReady: async () => {},
}));
vi.mock('./lib/agent/door.svelte.js', async (original) => ({ ...await original(), initDoor: () => {}, initChapterWindowDoor: async () => {} }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0' }));
vi.mock('./lib/editor/EditorRoot.svelte', () => ({ default: () => {} }));
vi.mock('./lib/FontModal.svelte', () => ({ default: () => {} }));
vi.mock('./lib/BrushModal.svelte', () => ({ default: () => {} }));
vi.mock('./lib/ExportDialog.svelte', () => ({ default: () => {} }));
vi.mock('./lib/Toast.svelte', () => ({ default: () => {} }));
vi.mock('./lib/home/HomeFrame.svelte', () => ({ default: () => {} }));
vi.mock('./lib/home/LibraryView.svelte', () => ({ default: () => {} }));
vi.mock('./lib/home/ProjectView.svelte', () => ({ default: () => {} }));
vi.mock('./lib/home/NewChapterDialog.svelte', () => ({ default: () => {} }));
vi.mock('./lib/home/ChapterSourcesSheet.svelte', () => ({ default: () => {} }));

import App from './App.svelte';
import { setPref } from './lib/prefs.svelte.js';
import { onboarding } from './lib/onboarding/onboarding.svelte.js';
import { openSettings, closeSettings } from './lib/settings-tabs.svelte.js';
import { resetRoute } from './lib/route.svelte.js';
async function settle() { for (let i = 0; i < 15; i++) { await Promise.resolve(); await tick(); } }
const screen = () => document.querySelector('.onboarding-screen');

beforeEach(() => {
  resetRoute();
  calls.role = null;
  calls.probes = 0;
  setPref('onboarded', false);
  setPref('usage', 'comics');
});
afterEach(async () => {
  onboarding.open = false;
  closeSettings();
  await cleanup();
  document.body.innerHTML = '';
});

it('mounts the setup on a fresh install only once the main window\'s role is known', async () => {
  render(App); await settle();
  // Booted, but the role has not answered: nothing is decided yet.
  expect(calls.role).toBeTypeOf('function');
  expect(screen()).toBe(null);
  calls.role({ label: 'main', agent: false, chapter: null }); await settle();
  expect(screen()).not.toBe(null);
});

it('never mounts it in an agent\'s window, however late the role answers', async () => {
  render(App); await settle();
  await new Promise((r) => setTimeout(r, 20));
  calls.role({ label: 'agent-1', agent: true, chapter: 'p/c' }); await settle();
  expect(screen()).toBe(null);
  expect(onboarding.open).toBe(false);
});

it('does not mount it for an install that is already set up', async () => {
  setPref('onboarded', true);
  render(App); await settle();
  calls.role({ label: 'main', agent: false, chapter: null }); await settle();
  expect(screen()).toBe(null);
});

it('Run setup again hands focus back to what opened Settings when the setup closes', async () => {
  setPref('onboarded', true);
  render(App); await settle();
  calls.role({ label: 'main', agent: false, chapter: null }); await settle();
  const gear = document.createElement('button');
  gear.textContent = 'Settings';
  document.body.append(gear);
  gear.focus();
  openSettings('general'); await settle();
  expect(document.activeElement).not.toBe(gear);

  const again = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Run setup again');
  await fireEvent.click(again); await settle();
  expect(document.querySelector('.settings-screen')).toBe(null);
  expect(screen()).not.toBe(null);
  expect(screen().contains(document.activeElement)).toBe(true);

  await fireEvent.keyDown(document.activeElement, { key: 'Escape' }); await settle();
  expect(screen()).toBe(null);
  expect(document.activeElement).toBe(gear);
});

it('probes the detection engine at boot for comics use only, and once comics is picked later', async () => {
  setPref('onboarded', true);
  setPref('usage', 'general');
  render(App); await settle();
  calls.role({ label: 'main', agent: false, chapter: null }); await settle();
  expect(calls.probes).toBe(0);
  setPref('usage', 'comics'); await settle();
  expect(calls.probes).toBe(1);
  setPref('usage', 'general'); await settle();
  setPref('usage', 'comics'); await settle();
  expect(calls.probes).toBe(1);
});
