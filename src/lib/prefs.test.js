import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let storage;
beforeEach(() => {
  vi.resetModules();
  storage = {};
  vi.stubGlobal('localStorage', {
    getItem: (key) => storage[key] ?? null,
    setItem: (key, value) => { storage[key] = String(value); },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('previous-box inheritance preference', () => {
  it.each([
    [undefined, true],
    [true, true],
    [false, false],
    ['false', true],
  ])('loads %s as %s and applies it to new-box styling', async (saved, enabled) => {
    storage['mt.prefs'] = JSON.stringify({ inheritBoxStyle: saved });
    const { prefs } = await import('./prefs.svelte.js');
    const { app, inheritedStyleFor } = await import('./store.svelte.js');
    app.lastStyle.rotation = 45;

    expect(prefs.inheritBoxStyle).toBe(enabled);
    expect(inheritedStyleFor({ n: 1, tags: [] }).rotation).toBe(enabled ? 45 : 0);
  });

  it('saves the choice and restores it on the next launch', async () => {
    const { setPref } = await import('./prefs.svelte.js');
    setPref('inheritBoxStyle', false);
    expect(JSON.parse(storage['mt.prefs']).inheritBoxStyle).toBe(false);

    vi.resetModules();
    const { prefs } = await import('./prefs.svelte.js');
    const { app, inheritedStyleFor } = await import('./store.svelte.js');
    app.lastStyle.rotation = 45;

    expect(prefs.inheritBoxStyle).toBe(false);
    expect(inheritedStyleFor({ n: 1, tags: [] }).rotation).toBe(0);
  });
});

describe('keeping English lettering during detection', () => {
  it.each([
    [undefined, false],
    [true, true],
    [false, false],
    ['true', false],
    [1, false],
    [null, false],
  ])('loads %s as %s', async (saved, enabled) => {
    storage['mt.prefs'] = JSON.stringify({ keepEnglish: saved });
    const { prefs } = await import('./prefs.svelte.js');
    expect(prefs.keepEnglish).toBe(enabled);
  });

  it('saves a boolean choice and restores it on the next launch', async () => {
    const { prefs, setPref } = await import('./prefs.svelte.js');
    setPref('keepEnglish', 1);
    expect(prefs.keepEnglish).toBe(true);
    expect(JSON.parse(storage['mt.prefs']).keepEnglish).toBe(true);

    vi.resetModules();
    const reloaded = await import('./prefs.svelte.js');
    expect(reloaded.prefs.keepEnglish).toBe(true);
    reloaded.setPref('keepEnglish', false);
    expect(JSON.parse(storage['mt.prefs']).keepEnglish).toBe(false);
    vi.resetModules();
    expect((await import('./prefs.svelte.js')).prefs.keepEnglish).toBe(false);
  });
});

describe('the second reader switch (OCR-1)', () => {
  it('is off until chosen and survives a relaunch', async () => {
    const { prefs, setPref } = await import('./prefs.svelte.js');
    expect(prefs.secondReader).toBe(false);
    setPref('secondReader', true);
    vi.resetModules();
    expect((await import('./prefs.svelte.js')).prefs.secondReader).toBe(true);
  });
});

describe('the second detector switch (DTC-2)', () => {
  it('is off until chosen and survives a relaunch', async () => {
    const { prefs, setPref } = await import('./prefs.svelte.js');
    expect(prefs.secondDetector).toBe(false);
    setPref('secondDetector', true);
    vi.resetModules();
    expect((await import('./prefs.svelte.js')).prefs.secondDetector).toBe(true);
  });
});
