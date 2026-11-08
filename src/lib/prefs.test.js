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
  it('is on until turned off and survives a relaunch', async () => {
    const { prefs, setPref } = await import('./prefs.svelte.js');
    expect(prefs.secondDetector).toBe(true);
    setPref('secondDetector', false);
    vi.resetModules();
    expect((await import('./prefs.svelte.js')).prefs.secondDetector).toBe(false);
  });
});

describe('the layer effects\' defaults (Make Default)', () => {
  it('are none on a fresh install, and a new shadow is the factory\'s', async () => {
    const { prefs } = await import('./prefs.svelte.js');
    const { newShadow } = await import('./data.js');
    expect(prefs.fxDefaults).toEqual({});
    expect(newShadow({ angle: 120 })).toMatchObject({ size: 5, opacity: 0.75 });
  });

  it('save one, stamped, and bring it back on the next launch, mirrored where effects are made', async () => {
    const { setFxDefault, clearFxDefault } = await import('./prefs.svelte.js');
    const data = await import('./data.js');
    setFxDefault('dropShadow', { ...data.newShadow({ angle: 120 }), size: 17, opacity: 0.3 });
    const blob = JSON.parse(storage['mt.prefs']);
    expect(blob.defaultsRev).toBe(3);
    expect(blob.fxDefaults.dropShadow).toMatchObject({ size: 17, opacity: 0.3, distance: 5, useGlobalLight: true });
    expect(blob.fxDefaults.dropShadow).not.toHaveProperty('x');
    expect(data.newShadow({ angle: 120 }).size).toBe(17);

    vi.resetModules();
    const again = await import('./prefs.svelte.js');
    const data2 = await import('./data.js');
    expect(again.prefs.fxDefaults.dropShadow.size).toBe(17);
    expect(data2.newShadow({ angle: 120 })).toMatchObject({ size: 17, opacity: 0.3 });
    // Reset to factory forgets it.
    again.clearFxDefault('dropShadow');
    expect(JSON.parse(storage['mt.prefs']).fxDefaults).toEqual({});
    expect(data2.newShadow({ angle: 120 }).size).toBe(5);
    expect(clearFxDefault).toBeTypeOf('function');
  });

  it('drop a corrupted stored default and keep the readable ones', async () => {
    storage['mt.prefs'] = JSON.stringify({ defaultsRev: 2, fxDefaults: { dropShadow: 'junk', satin: { size: 3 }, outerGlow: [1] } });
    const { prefs } = await import('./prefs.svelte.js');
    const { newShadow, fxDefault } = await import('./data.js');
    expect(Object.keys(prefs.fxDefaults)).toEqual(['satin']);
    expect(fxDefault('satin').size).toBe(3);
    expect(fxDefault('outerGlow')).toBeNull();
    expect(newShadow({ angle: 120 }).size).toBe(5);
  });
});
