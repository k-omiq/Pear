import { afterEach, describe, expect, it, vi } from 'vitest';

// The usage gate (plan 2.1): general use hides the comic tools through one
// switch, `isComics()`, and switching changes only what is shown and which
// tool is in hand, never a stored setting or a chapter.
vi.hoisted(() => {
  const storage = {};
  globalThis.localStorage = {
    getItem: (key) => storage[key] ?? null,
    setItem: (key, value) => { storage[key] = String(value); },
  };
});

const { prefs, setPref, startMode, sfxToolOn, isComics, adoptSharedPrefs } = await import('./prefs.svelte.js');
const { app, setTool } = await import('./store.svelte.js');
const { actionOff, shortcutGroups, dispatchShortcut, runShortcut, registerShortcutHandlers, setCombo, resetCombo, setMacKeyboard } = await import('./shortcuts.svelte.js');

const shownIds = () => shortcutGroups().flatMap((g) => g.items.map((s) => s.id));

afterEach(() => {
  setPref('usage', 'comics');
  setPref('sfxTool', false);
  setPref('defaultChapterMode', 'translate');
  setTool('place');
});

describe('the start mode', () => {
  it('is the Settings pick for comics use', () => {
    setPref('defaultChapterMode', 'translate');
    expect(startMode()).toBe('translate');
    setPref('defaultChapterMode', 'typeset');
    expect(startMode()).toBe('typeset');
  });

  it('is always typeset for general use, and the stored pick survives', () => {
    setPref('defaultChapterMode', 'translate');
    setPref('usage', 'general');
    expect(startMode()).toBe('typeset');
    expect(prefs.defaultChapterMode).toBe('translate');
    setPref('usage', 'comics');
    expect(startMode()).toBe('translate');
  });
});

describe('the comic tools under general use', () => {
  const comicIds = ['detect.page', 'detect.chapter', 'ocr.draw', 'box.fitBalloon', 'bubble.centre', 'mask.clipToBubble', 'review.next', 'view.regions', 'settings.detection', 'settings.guide'];

  it('have no row and no key, and come back with comics use', () => {
    expect(comicIds.every((id) => !actionOff(id))).toBe(true);
    expect(shownIds()).toEqual(expect.arrayContaining(comicIds));
    setPref('usage', 'general');
    expect(isComics()).toBe(false);
    for (const id of comicIds) expect(actionOff(id), id).toBe(true);
    expect(shownIds().filter((id) => comicIds.includes(id))).toEqual([]);
    // What general use keeps: text styles and the text list.
    expect(actionOff('settings.styles')).toBe(false);
    expect(actionOff('tool.text')).toBe(false);
    expect(actionOff('queue.placeChapter')).toBe(false);
    setPref('usage', 'comics');
    expect(comicIds.every((id) => !actionOff(id))).toBe(true);
  });

  it('refuse a comic tool\'s key even when one is bound', () => {
    setMacKeyboard(true);
    let ran = 0;
    registerShortcutHandlers({ 'detect.page': () => { ran++; } });
    expect(setCombo('detect.page', 'Mod+Alt+F9').ok).toBe(true);
    const press = () => ({ code: 'F9', key: 'F9', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, preventDefault() {} });
    expect(dispatchShortcut(press())).toBe('detect.page');
    setPref('usage', 'general');
    expect(dispatchShortcut(press())).toBe(null);
    expect(runShortcut('detect.page')).toBe(false);
    expect(ran).toBe(1);
    resetCombo('detect.page');
  });

  it('treat SFX as off without changing its switch', () => {
    setPref('sfxTool', true);
    expect(sfxToolOn()).toBe(true);
    setPref('usage', 'general');
    expect(sfxToolOn()).toBe(false);
    expect(prefs.sfxTool).toBe(true);
    setPref('usage', 'comics');
    expect(sfxToolOn()).toBe(true);
  });
});

describe('the tool in hand', () => {
  it('is the Text tool once general use is picked', () => {
    setTool('place');
    setPref('usage', 'general');
    expect(app.tool).toBe('text');
  });

  it('stays the Place tool a general user picks when another pref changes', () => {
    setPref('usage', 'general');
    setTool('place');
    setPref('sfxTool', true);
    expect(app.tool).toBe('place');
    // Another window writing its prefs with the same usage changes nothing.
    adoptSharedPrefs(JSON.stringify({ usage: 'general', onboarded: true }));
    expect(app.tool).toBe('place');
    // Another window picking general use does.
    setPref('usage', 'comics');
    adoptSharedPrefs(JSON.stringify({ usage: 'general' }));
    expect(app.tool).toBe('text');
  });
});
