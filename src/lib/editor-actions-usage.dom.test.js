import { afterEach, describe, expect, it, vi } from 'vitest';

// The editor's action handlers refuse the comic tools under general use on
// their own, whatever path reaches them, with the engine up and a chapter open.
const engine = vi.hoisted(() => ({ reads: 0 }));
vi.mock('./sidecar.js', async (original) => ({
  ...(await original()),
  sidecarReady: () => true,
  detectCurrentPage: () => { engine.reads++; },
  detectAllPages: () => { engine.reads++; },
}));
vi.mock('./library.svelte.js', async (original) => ({ ...(await original()), chapterOpenSeq: () => 1 }));

const { app, loadProjectPages } = await import('./store.svelte.js');
const { setPref } = await import('./prefs.svelte.js');
const { editorActionHandlers } = await import('./editor-actions.js');
const { settingsView, closeSettings } = await import('./settings-tabs.svelte.js');

afterEach(() => {
  setPref('usage', 'comics');
  closeSettings();
  loadProjectPages([]);
  app.chapterRef = null;
});

describe('the comic actions under general use', () => {
  it('detect nothing and open no comic Settings tab, and run under comics use', async () => {
    loadProjectPages([{ id: 1, w: 800, h: 1200, boxes: [], lines: [] }]);
    app.loaded = true;
    app.chapterRef = { projectId: 'p', chapterId: 'c' };
    const run = editorActionHandlers();
    engine.reads = 0;
    setPref('usage', 'general');
    for (const id of ['detect.page', 'detect.chapter', 'ocr.draw', 'bubble.approvePage', 'settings.detection', 'settings.guide', 'panel.sfx']) {
      expect(run[id](), id).toBe(false);
    }
    expect(engine.reads).toBe(0);
    expect(settingsView.open).toBe(false);
    // What general use keeps still runs.
    expect(run['settings.styles']()).not.toBe(false);
    closeSettings();
    setPref('usage', 'comics');
    expect(run['detect.page']()).not.toBe(false);
    expect(run['detect.chapter']()).not.toBe(false);
    expect(engine.reads).toBe(2);
  });
});
