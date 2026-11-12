import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The AI tab: the lines to paste carry the door's port and token, Copy puts
// one on the clipboard, and a browser tab says it needs the desktop app.
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0' }));

const { default: SettingsModal } = await import('./SettingsModal.svelte');
const { app } = await import('./store.svelte.js');
const { door, DEFAULT_PORT } = await import('./agent/door.svelte.js');
const { SETTINGS_TABS, settingsView, openSettings, closeSettings } = await import('./settings-tabs.svelte.js');

afterEach(() => {
  cleanup();
  closeSettings();
  settingsView.tab = 'general';
});

async function aiTab() {
  door.token = 'ab'.repeat(32);
  door.port = DEFAULT_PORT;
  const view = render(SettingsModal, { open: true });
  await tick();
  await fireEvent.click(view.getByRole('tab', { name: 'AI agents' }));
  return view;
}

describe('the AI tab in Settings', () => {
  it('is a Settings tab the palette can open', () => {
    expect(SETTINGS_TABS).toContain('ai');
    openSettings('ai');
    expect(settingsView).toMatchObject({ open: true, tab: 'ai' });
  });

  it('shows each connect line with the port and token', async () => {
    const view = await aiTab();
    const claude = view.getByLabelText('Claude Code line').textContent;
    expect(claude).toContain(`http://127.0.0.1:${DEFAULT_PORT}/mcp`);
    expect(claude).toContain(`Bearer ${door.token}`);
    expect(view.getByLabelText('Codex token line').textContent).toBe(`export TYPESETTER_TOKEN=${door.token}`);
    expect(JSON.parse(view.getByLabelText('Antigravity config').textContent).mcpServers.typesetter.serverUrl).toBe(
      `http://127.0.0.1:${DEFAULT_PORT}/mcp`,
    );
    expect(view.getByLabelText('Safe Claude Code start').textContent).toBe('claude --tools ""');
    // Once for the panel's key, once for the door.
    expect(view.getAllByText('Needs the desktop app')).toHaveLength(2);
  });

  it('Copy puts the line on the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const view = await aiTab();
    await fireEvent.click(view.getByRole('button', { name: 'Copy Codex line' }));
    await tick();
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^codex mcp add typesetter --url /));
    expect(app.toast.msg).toBe('Copied');
  });
});
