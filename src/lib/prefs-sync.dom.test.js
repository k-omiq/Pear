import { afterEach, describe, expect, it, vi } from 'vitest';

// Two windows share one stored blob. A window that loaded before the setup
// finished adopts what the other window stored for the setup's four
// preferences, so its next write does not put the old answers back.
const { prefs, setPref } = await import('./prefs.svelte.js');

const KEY = 'mt.prefs';
const storageEvent = (newValue, key = KEY) => window.dispatchEvent(new StorageEvent('storage', { key, newValue }));

afterEach(() => {
  vi.unstubAllGlobals();
  setPref('onboarded', false);
  setPref('usage', 'comics');
  setPref('defaultChapterMode', 'translate');
  setPref('defaultOcrLanguage', 'ja');
  setPref('keepEnglish', false);
});

describe('preferences another window stored', () => {
  it('adopts the setup\'s four, and writes them back as adopted', () => {
    expect(prefs.onboarded).toBe(false);
    storageEvent(JSON.stringify({ onboarded: true, usage: 'general', defaultChapterMode: 'typeset', defaultOcrLanguage: 'ko' }));
    expect(prefs).toMatchObject({ onboarded: true, usage: 'general', defaultChapterMode: 'typeset', defaultOcrLanguage: 'ko' });
    // This window's next write of anything carries them, not its old answers.
    const stored = {};
    vi.stubGlobal('localStorage', { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = String(v); } });
    setPref('keepEnglish', true);
    expect(JSON.parse(stored[KEY])).toMatchObject({ onboarded: true, usage: 'general' });
  });

  it('takes nothing else, nothing invalid, and nothing from another key', () => {
    storageEvent(JSON.stringify({ keepEnglish: true, usage: 'banana', onboarded: 'yes', defaultOcrLanguage: 'fr' }));
    expect(prefs).toMatchObject({ keepEnglish: false, usage: 'comics', onboarded: false, defaultOcrLanguage: 'ja' });
    storageEvent(JSON.stringify({ usage: 'general' }), 'mt.theme');
    expect(prefs.usage).toBe('comics');
    storageEvent('{not json');
    storageEvent(null);
    expect(prefs.usage).toBe('comics');
  });
});
