import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The export and the record write are stood in for: what is under test is the
// Size row, what it offers and what it hands the export. The limit itself is
// the real one (`scaleBlock`).
const calls = vi.hoisted(() => ({ exports: [], sizes: [] }));
vi.mock('./exporter.js', async (importOriginal) => ({
  ...(await importOriginal()),
  exportImages: async (...args) => void calls.exports.push(args),
  exportPreflight: async () => ({ items: [], boxes: 0, lines: 0, text: 0, raster: 0 }),
}));
vi.mock('./library.svelte.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    setProjectExportScale: async (id, scale) => {
      calls.sizes.push([id, scale]);
      real.projectById(id).exportScale = scale;
      return scale;
    },
  };
});

const { default: ExportDialog } = await import('./ExportDialog.svelte');
const { app, loadProjectPages } = await import('./store.svelte.js');
const { library } = await import('./library.svelte.js');

const HELP = 'Text is sharper. The page is enlarged, not redrawn. Files are about 4 times larger.';
const seg = (view) => [...view.container.querySelectorAll('.seg[aria-labelledby="exp-size"] button')];
const button = (view, label) => seg(view).find((b) => b.textContent.trim() === label);
const text = (view) => view.container.textContent;

function open({ exportScale = 1, pages }) {
  library.projects = [{ id: 'p1', name: 'Nine Skies', layout: 'pages', ocrLanguage: 'ja', exportScale, chapters: [] }];
  app.chapterRef = { projectId: 'p1', chapterId: 'c1' };
  app.projectLayout = 'pages';
  app.fmt = 'PNG';
  loadProjectPages(pages);
  app.exportOpen = true;
  return render(ExportDialog);
}

beforeEach(() => {
  calls.exports = [];
  calls.sizes = [];
});
afterEach(() => {
  cleanup();
  app.exportOpen = false;
  app.chapterRef = null;
  app.projectLayout = 'pages';
  library.projects = [];
  loadProjectPages([]);
});

const small = [{ id: 1, w: 800, h: 1200, lines: [], boxes: [] }, { id: 2, w: 800, h: 1200, lines: [], boxes: [] }];
const tooBig = [{ id: 1, w: 800, h: 1200, lines: [], boxes: [] }, { id: 2, w: 9000, h: 9000, lines: [], boxes: [] }];

describe('the Size row', () => {
  it('is Original for a series that never chose, and exports at the page’s own size', async () => {
    const view = open({ pages: small });
    await tick();
    expect(button(view, 'Original').classList.contains('on')).toBe(true);
    expect(button(view, '2x').classList.contains('on')).toBe(false);
    expect(text(view)).not.toContain(HELP);
    view.container.querySelectorAll('.exp-card')[1].click();
    await tick();
    expect(calls.exports).toEqual([['PNG', 'all', 1]]);
  });

  it('saves 2x with the series, says what it does, and exports at it', async () => {
    const view = open({ pages: small });
    await tick();
    button(view, '2x').click();
    await tick();
    expect(calls.sizes).toEqual([['p1', 2]]);
    expect(button(view, '2x').classList.contains('on')).toBe(true);
    expect(text(view)).toContain(HELP);
    view.container.querySelectorAll('.exp-card')[0].click();
    await tick();
    expect(calls.exports).toEqual([['PNG', 'current', 2]]);
  });

  it('dims 2x for a chapter with a page too large for it, with the reason, and exports at Original', async () => {
    const view = open({ exportScale: 2, pages: tooBig });
    await tick();
    const two = button(view, '2x');
    expect(two.disabled).toBe(true);
    expect(two.classList.contains('on')).toBe(false);
    expect(button(view, 'Original').classList.contains('on')).toBe(true);
    expect(text(view)).toContain('Page 2 is too large for 2x.');
    expect(text(view)).not.toContain(HELP);
    view.container.querySelectorAll('.exp-card')[1].click();
    await tick();
    expect(calls.exports).toEqual([['PNG', 'all', 1]]);
    // The series' own choice is left as it was.
    expect(library.projects[0].exportScale).toBe(2);
  });

  it('dims All pages for a strip whose slices are past a WebP at 2x, names a Slice height, and lets one page go', async () => {
    const tall = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, w: 800, h: 3000, lines: [], boxes: [] }));
    const view = open({ exportScale: 2, pages: tall });
    app.projectLayout = 'longstrip';
    app.fmt = 'WebP';
    await tick();
    const [current, all] = view.container.querySelectorAll('.exp-card');
    expect(all.disabled).toBe(true);
    expect(current.disabled).toBe(false);
    expect(text(view)).toContain('At 2x, set Slice height to 4096 or less.');
    // 2x itself stays on: a single page of the strip fits.
    expect(button(view, '2x').classList.contains('on')).toBe(true);
    current.click();
    await tick();
    expect(calls.exports).toEqual([['WebP', 'current', 2]]);
    // At Original there is nothing to say.
    button(view, 'Original').click();
    await tick();
    expect(all.disabled).toBe(false);
    expect(text(view)).not.toContain('Slice height to');
  });

  it('dims both for JSON, which has no pictures', async () => {
    const view = open({ exportScale: 2, pages: small });
    app.fmt = 'JSON';
    await tick();
    expect(seg(view).every((b) => b.disabled)).toBe(true);
    expect(text(view)).toContain('JSON has text only, no pictures.');
  });
});
