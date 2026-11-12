// ===== The Claude API key, from the webview's side =====
// The key itself is Rust's (src-tauri/src/ai_api.rs): the webview hands it
// over once and from then on only knows whether one is set and where it is
// kept. Nothing here ever holds it after `saveKey` returns.
import { isTauri } from '../importer.js';

export const aiKey = $state({
  // null until asked
  set: null,
  // 'keychain' | 'session' | null
  store: null,
  busy: false,
  error: null,
  // The last "Test key" answer: null, 'ok' or an error message.
  test: null,
});

async function invoke(cmd, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

function take(status) {
  aiKey.set = !!status?.set;
  aiKey.store = status?.store ?? null;
}

export async function refreshKey() {
  if (!isTauri()) {
    aiKey.set = false;
    return;
  }
  try {
    take(await invoke('ai_key_status'));
  } catch (err) {
    // Not stuck on "Checking…": no key we can use, and why.
    aiKey.set = false;
    aiKey.error = String(err?.message ?? err);
  }
}

export async function saveKey(key) {
  aiKey.busy = true;
  aiKey.error = null;
  aiKey.test = null;
  try {
    take(await invoke('ai_key_set', { key: String(key ?? '') }));
    return true;
  } catch (err) {
    aiKey.error = String(err?.message ?? err);
    return false;
  } finally {
    aiKey.busy = false;
  }
}

export async function clearKey() {
  aiKey.test = null;
  aiKey.error = null;
  try {
    take(await invoke('ai_key_clear'));
    return true;
  } catch (err) {
    aiKey.error = String(err?.message ?? err);
    return false;
  }
}

// One cheap call (the model list) that says whether the key works.
export async function testKey() {
  aiKey.busy = true;
  aiKey.test = null;
  try {
    const { claudeClient } = await import('./transport.js');
    const client = await claudeClient();
    await client.models.list({ limit: 1 });
    aiKey.test = 'ok';
  } catch (err) {
    aiKey.test = keyError(err);
  } finally {
    aiKey.busy = false;
  }
}

// An API failure in words the user can act on.
export function keyError(err) {
  const status = err?.status;
  const msg = err?.error?.error?.message ?? err?.message ?? String(err);
  if (status === 401) return 'The key was refused. Check it in the Claude Console and paste it again.';
  if (status === 403) return 'This key may not use the API. Check its permissions in the Claude Console.';
  if (status === 429) return 'Too many requests, or the account is out of credit. Wait a little, or check billing in the Claude Console.';
  if (status === 529 || status === 503) return 'The Claude API is busy. Try again in a moment.';
  if (status >= 500) return `The Claude API failed (${status}). Try again.`;
  return msg;
}
