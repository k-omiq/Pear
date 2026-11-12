import { afterEach, expect, it, vi } from 'vitest';

// The agent's detect tool is a comic tool: under general use it refuses and
// says where the switch is, before it looks at anything else.
vi.mock('../../library.svelte.js', () => ({ chapterOpenSeq: () => 1 }));
const { setPref } = await import('../../prefs.svelte.js');
const { callTool } = await import('../registry.js');
await import('./place.js');

afterEach(() => setPref('usage', 'comics'));

it('refuses under general use and names the setting', async () => {
  setPref('usage', 'general');
  const reply = await callTool('detect', {});
  expect(reply.ok).toBe(false);
  expect(reply.error).toMatch(/general use/);
  expect(reply.hint).toMatch(/Settings, General/);
  setPref('usage', 'comics');
  expect((await callTool('detect', {})).error ?? '').not.toMatch(/general use/);
});
