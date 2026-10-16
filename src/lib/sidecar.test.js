import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app, loadProjectPages } from './store.svelte.js';
import { jobs } from './jobs.svelte.js';
import { detectAllPages, detectCurrentPage, detectOnePage } from './sidecar.js';
import { prefs } from './prefs.svelte.js';
import * as chapter from './library.svelte.js';

const h = vi.hoisted(() => ({ calls: [], analyze: null }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd, args) => {
    h.calls.push([cmd, args]);
    if (h.analyze) return await h.analyze(args);
    return { img_width: 100, img_height: 100, panels: [], lines: [] };
  }),
}));

beforeEach(() => {
  h.calls.length = 0;
  h.analyze = null;
  prefs.keepEnglish = false;
  globalThis.window = { __TAURI_INTERNALS__: {} };
  globalThis.fetch = vi.fn().mockResolvedValue({
    arrayBuffer: async () => new ArrayBuffer(4),
  });
});

afterEach(() => { vi.restoreAllMocks(); });

describe('analyzeImage IPC invocation', () => {
  it('defaults language to ja when omitted', async () => {
    const { analyzeImage } = await import('./sidecar.js');
    await analyzeImage('blob:fake');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0][0]).toBe('detect_analyze');
    expect(h.calls[0][1].language).toBe('ja');
    expect(h.calls[0][1].ocr).toBe(true);
    // The second reader (OCR-1) is off until Settings turns it on.
    expect(h.calls[0][1].secondReader).toBe(false);
  });

  it('passes explicit lang option when provided', async () => {
    const { analyzeImage } = await import('./sidecar.js');
    await analyzeImage('blob:fake', { ocr: false, lang: 'ko' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0][0]).toBe('detect_analyze');
    expect(h.calls[0][1].language).toBe('ko');
    expect(h.calls[0][1].ocrModel).toBe('ko-ppocrv5-mobile');
    expect(h.calls[0][1].ocr).toBe(false);
  });

  it('supports lang passed as positional third arg', async () => {
    const { analyzeImage } = await import('./sidecar.js');
    await analyzeImage('blob:fake', { ocr: true }, 'ko');
    expect(h.calls.at(-1)[1].language).toBe('ko');
  });

  it('supports lang passed as second arg string', async () => {
    const { analyzeImage } = await import('./sidecar.js');
    await analyzeImage('blob:fake', 'ko');
    expect(h.calls.at(-1)[1].language).toBe('ko');
  });
});

// These waits guard document writes, not just progress text: a late OCR result
// must never mark or overwrite the chapter opened while the engine was busy.
describe('chapter detection jobs', () => {
  beforeEach(() => {
    jobs.items = [];
    app.sidecar = { status: 'ok' };
    app.detecting = false;
    app.detectBatch = null;
    loadProjectPages([1, 2, 3].map((id) => ({ id, raw: `blob:${id}`, w: 100, h: 100, lines: [], boxes: [] })));
  });

  it('keeps per-page failures and retries only those pages with the original options', async () => {
    let n = 0;
    h.analyze = async () => {
      if (++n === 2) throw new Error('bad page');
      return { img_width: 100, img_height: 100, panels: [], lines: [] };
    };
    const job = await detectAllPages({ ocr: false, language: 'ko' });
    expect(job.failed).toEqual([{ pageId: 2, error: 'bad page' }]);
    expect([job.done, job.total]).toEqual([3, 3]);
    expect(jobs.items).toHaveLength(1);
    expect(app.detecting).toBe(false);
    expect(app.detectBatch).toBeNull();

    globalThis.fetch.mockClear();
    await job.retry();
    expect(globalThis.fetch.mock.calls.map(([url]) => url)).toEqual(['blob:2']);
    expect(h.calls.at(-1)[1]).toMatchObject({ ocr: false, language: 'ko' });
    expect(job.failed).toEqual([]);
    expect(jobs.items).toEqual([]);
  });

  it('finishes the current page on cancel and stops before the next one', async () => {
    h.analyze = async () => {
      expect(app.detectBatch).toEqual({ done: 0, total: 3 });
      jobs.items[0].cancel();
      return { img_width: 100, img_height: 100, panels: [], lines: [] };
    };
    const job = await detectAllPages();
    expect(h.calls).toHaveLength(1);
    expect(app.pages[0].detect).toBeTruthy();
    expect(app.pages[1].detect).toBeFalsy();
    expect(job.done).toBe(1);
    expect(jobs.items).toEqual([]);
  });

  it('post-processes OCR before saving lines and detection geometry', async () => {
    h.analyze = async () => ({
      img_width: 100, img_height: 100, panels: [],
      lines: [
        { n: 1, jp: '今日はいい天気ですね', type: 'dialogue', box: [0, 0, 100, 100] },
        { n: 2, jp: 'いい天気', type: 'dialogue', box: [10, 10, 60, 60] },
        { n: 3, jp: '明日も', type: 'dialogue', box: [200, 0, 300, 100] },
      ],
    });
    const job = await detectAllPages();
    expect(job.failed).toEqual([]);
    for (const p of app.pages) {
      expect(p.lines.map((l) => [l.n, l.jp])).toEqual([[1, '今日はいい天気ですね'], [2, '明日も']]);
      expect(p.detect.boxes.map((b) => b.n)).toEqual([1, 2]);
    }
  });

  it.each([false, true])('passes keepEnglish=%s to detection post-processing and reports the surviving count', async (keepEnglish) => {
    prefs.keepEnglish = keepEnglish;
    h.analyze = async () => ({
      img_width: 100, img_height: 100, panels: [],
      lines: [
        { n: 1, jp: 'BANG!', type: 'sfx', box: [0, 0, 100, 100] },
        { n: 2, jp: '', type: 'dialogue', box: [10, 10, 60, 60] },
        { n: 3, jp: '明日も', type: 'dialogue', box: [200, 0, 300, 100] },
      ],
    });
    expect(await detectOnePage(app.pages[0])).toEqual({ lines: keepEnglish ? 2 : 1 });
    expect(app.pages[0].lines.map((l) => l.jp)).toEqual(keepEnglish ? ['BANG!', '明日も'] : ['明日も']);
    expect(app.pages[0].detect.boxes.map((b) => b.n)).toEqual(keepEnglish ? [1, 2] : [1]);
  });

  it('asks for the text mask and keeps it beside the chapter (MASK-1)', async () => {
    const write = vi.spyOn(chapter, 'writePageMask').mockResolvedValue('001.jpg.png');
    h.analyze = async () => ({ img_width: 100, img_height: 120, panels: [], lines: [], mask_png: [137, 80, 78, 71] });
    await detectOnePage(app.pages[0]);
    expect(h.calls[0][1].mask).toBe(true);
    expect(write).toHaveBeenCalledWith(app.pages[0], new Uint8Array([137, 80, 78, 71]));
    expect(app.pages[0].detect.mask).toEqual({ file: '001.jpg.png', w: 100, h: 120 });
    write.mockRestore();
  });

  it('detects without a mask when none can be written', async () => {
    const write = vi.spyOn(chapter, 'writePageMask').mockResolvedValue(null);
    h.analyze = async () => ({ img_width: 100, img_height: 120, panels: [], lines: [], mask_png: [1] });
    await detectOnePage(app.pages[0]);
    expect('mask' in app.pages[0].detect).toBe(false);
    write.mockRestore();
  });

  it.each([detectCurrentPage, detectAllPages])('%s drops a late result as soon as another open starts, before pages change', async (detect) => {
    const seq = vi.spyOn(chapter, 'chapterOpenSeq').mockReturnValue(1);
    let release, started;
    const waiting = new Promise((resolve) => { started = resolve; });
    h.analyze = () => { started(); return new Promise((resolve) => { release = resolve; }); };
    const pages = app.pages;
    app.saved = true;
    const running = detect();
    await waiting;
    seq.mockReturnValue(2);
    release({ img_width: 100, img_height: 100, panels: [], lines: [] });
    await running;
    expect(app.pages).toBe(pages);
    expect(app.pages.every((p) => !p.detect)).toBe(true);
    expect(app.saved).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(app.detecting).toBe(false);
    expect(jobs.items).toEqual([]);
  });
});
