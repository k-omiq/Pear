import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../library.svelte.js', () => ({ chapterOpenSeq: () => 1 }));

const { app, loadProjectPages, settleEdits, setSaver, markSaved, DOC_SAVE_MS } = await import('../../store.svelte.js');
const { initHistory, resetHistory } = await import('../../editor/history.svelte.js');
const { bindGuide, unbindGuide, SERIES_TYPESET_KEYS } = await import('../../guide.svelte.js');
const prefModule = await import('../../prefs.svelte.js');
const { prefs, setPref, typesetDefaults } = prefModule;
const { defaultStyle, applyBoxDefaults } = await import('../../data.js');
const { callTool, toolByName } = await import('../registry.js');
const { aiRun, __resetRun } = await import('../run.svelte.js');
await import('./settings.js');

const keys = Object.keys(SERIES_TYPESET_KEYS);
const copy = (v) => JSON.parse(JSON.stringify(v));
const values = () => Object.fromEntries(keys.map((key) => [key, prefs[key]]));
let before;
let storage;
let chapterSave;
let unhook;
let setter;
beforeEach(() => {
  vi.useFakeTimers();
  storage = {};
  vi.stubGlobal('localStorage', { getItem: (key) => storage[key] ?? null, setItem: vi.fn((key, value) => { storage[key] = value; }) });
  before = values();
  unbindGuide();
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  initHistory();
  resetHistory();
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [{ id: 'b', lineN: null, text: 'Hi', x: 10, y: 10, w: 100, h: 50 }] }]);
  markSaved();
  __resetRun();
  chapterSave = vi.fn();
  unhook = setSaver(chapterSave);
  setter = vi.spyOn(prefModule, 'setPref');
});
afterEach(() => {
  setter.mockRestore();
  for (const [key, value] of Object.entries(before)) setPref(key, value);
  unhook();
  settleEdits();
  resetHistory();
  __resetRun();
  loadProjectPages([]);
  unbindGuide();
  app.chapterRef = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const call = (args, ctx) => callTool('settings', args, ctx);

describe('settings', () => {
  it('registers exactly the five new-box preference keys with allowed values/ranges', async () => {
    const tool = toolByName('settings');
    expect(Object.keys(tool.input.properties.values.properties)).toEqual(keys);
    const reply = await call({ action: 'get' });
    expect(reply).toEqual({ ok: true, result: {
      values: before,
      allowed: {
        defaultAutoHeight: { type: 'boolean' }, defaultHyphenate: { type: 'boolean' }, defaultBalloon: { type: 'boolean' },
        defaultBlockShape: { enum: ['auto', 'oval', 'rect'] }, defaultMinOrphan: { type: 'integer', minimum: 1, maximum: 8 },
      },
    } });
    expect(setter).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    reply.result.allowed.defaultBlockShape.enum.push('bad');
    reply.result.values.defaultAutoHeight = !before.defaultAutoHeight;
    expect((await call({ action: 'get' })).result.allowed.defaultBlockShape.enum).toEqual(['auto', 'oval', 'rect']);
    expect(values()).toEqual(before);
  });

  it('applies all validated values with setPref and persists without touching the chapter', async () => {
    const pages = copy(app.pages);
    const patch = { defaultAutoHeight: false, defaultHyphenate: true, defaultBalloon: false, defaultBlockShape: 'rect', defaultMinOrphan: 8 };
    const ctx = { write: vi.fn(() => { throw new Error('chapter write'); }), writeGuide: vi.fn(() => { throw new Error('guide write'); }) };
    expect(await call({ action: 'set', values: patch }, ctx)).toMatchObject({ ok: true, result: { values: patch } });
    expect(setter.mock.calls).toEqual(Object.entries(patch));
    expect(JSON.parse(storage['mt.prefs'])).toMatchObject(patch);
    expect(applyBoxDefaults(defaultStyle())).toMatchObject({ autoHeight: false, hyphenate: true, balloon: false, shape: 'rect', minOrphan: 8 });
    await vi.advanceTimersByTimeAsync(DOC_SAVE_MS + 1);
    expect(copy(app.pages)).toEqual(pages);
    expect(app.saved).toBe(true);
    expect(chapterSave).not.toHaveBeenCalled();
    expect(ctx.write).not.toHaveBeenCalled();
    expect(ctx.writeGuide).not.toHaveBeenCalled();
    expect(aiRun.active).toBe(false);
  });

  it('changes personal defaults beneath series overrides and also works without a chapter', async () => {
    bindGuide({ typeset: { defaultAutoHeight: true } }, vi.fn());
    const reply = await call({ action: 'set', values: { defaultAutoHeight: false } });
    expect(reply.result.values.defaultAutoHeight).toBe(false);
    expect(typesetDefaults().defaultAutoHeight).toBe(true);
    app.chapterRef = null;
    loadProjectPages([]);
    expect(await call({ action: 'set', values: { defaultMinOrphan: 1 } })).toMatchObject({ ok: true, result: { values: { defaultMinOrphan: 1 } } });
  });

  it.each([
    [{ defaultAutoHeigh: true }, 'setting', 'defaultAutoHeight'],
    [{ minFontSize: 24 }, 'setting', 'defaultMinOrphan'],
    [{ textEngine: 'rust' }, 'setting', 'Allowed'],
    [{ inheritBoxStyle: false }, 'setting', 'Allowed'],
    [{ shortcuts: {} }, 'setting', 'Allowed'],
    [{ defaultBlockShape: 'rectangle' }, 'value', 'rect'],
    [{ defaultBalloon: 'false' }, 'value', 'true or false'],
    [{ defaultMinOrphan: 0 }, 'value', '1 to 8'],
    [{ defaultMinOrphan: 9 }, 'value', '1 to 8'],
    [{ defaultMinOrphan: 2.5 }, 'value', 'integer'],
    [{ defaultMinOrphan: NaN }, 'value', 'integer'],
    [{ defaultMinOrphan: Infinity }, 'value', 'integer'],
    [{ defaultMinOrphan: '3' }, 'value', 'integer'],
    [{ constructor: true }, 'setting', 'Allowed'],
  ])('rejects %j before applying any part of a patch', async (patch, error, hint) => {
    const pages = copy(app.pages);
    const reply = await call({ action: 'set', values: { defaultAutoHeight: !before.defaultAutoHeight, ...patch } });
    expect(reply).toEqual({ ok: false, error: expect.stringContaining(error), hint: expect.stringContaining(hint) });
    expect(values()).toEqual(before);
    expect(setter).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(copy(app.pages)).toEqual(pages);
  });

  it.each([
    [{ action: 'sett' }, 'action', 'set'],
    [{ action: 'set' }, 'object', 'Choose'],
    [{ action: 'set', values: [] }, 'object', 'Choose'],
    [{ action: 'get', values: {} }, 'only', 'set'],
    [{ action: 'get', value: {} }, 'argument', 'values'],
  ])('returns useful errors for malformed calls: %j', async (args, error, hint) => {
    expect(await call(args)).toEqual({ ok: false, error: expect.stringContaining(error), hint: expect.stringContaining(hint) });
    expect(setter).not.toHaveBeenCalled();
  });
});
