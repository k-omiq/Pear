import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The project screen under each usage: general use has no translate mode, no
// source imports and no Detect language, but a translate chapter made under
// comics use still opens.
const mock = vi.hoisted(() => ({
  goEditor: vi.fn(), setChapterMode: vi.fn(),
  project: {
    id: 'p', name: 'Mine', layout: 'pages', ocrLanguage: 'ja',
    chapters: [
      { id: 'c1', number: 1, title: '', pageCount: 3, typeset: false, mode: 'translate' },
      { id: 'c2', number: 2, title: 'Two', pageCount: 2, typeset: true, mode: 'typeset' },
    ],
  },
}));
vi.mock('../library.svelte.js', () => ({
  projectById: () => mock.project, deleteChapter: vi.fn(), setChapterMode: mock.setChapterMode,
  setProjectOcrLanguage: vi.fn(), lastToCheck: () => 4,
}));
vi.mock('../route.svelte.js', () => ({ route: { projectId: 'p' }, goLibrary: vi.fn(), goEditor: mock.goEditor }));
vi.mock('../package-flow.js', () => ({ exportChapterPackage: vi.fn(), stayingNote: () => '' }));

const { default: ProjectView } = await import('./ProjectView.svelte');
const { setPref } = await import('../prefs.svelte.js');

beforeEach(() => setPref('usage', 'comics'));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPref('usage', 'comics');
});

async function mount() {
  const view = render(ProjectView, { onNewChapter: vi.fn(), onSources: vi.fn(), onVersions: vi.fn() });
  await tick();
  return view;
}
async function menuOf(view, n, noun = 'Chapter') {
  await fireEvent.click(view.getByRole('button', { name: `${noun} ${n} actions` }));
  await tick();
  return view.getAllByRole('menuitem').map((m) => m.textContent.trim());
}

describe('the project screen', () => {
  it('offers comics use the mode switch, the sources and the Detect language', async () => {
    const view = await mount();
    expect(view.getByText('Translate')).toBeTruthy();
    expect(view.getByLabelText('Source language')).toBeTruthy();
    const items = await menuOf(view, 1);
    expect(items).toContain('Switch to typesetting');
    expect(items).toContain('Cleaned pages and translations…');
  });

  it('offers general use none of them, and still opens a translate chapter', async () => {
    setPref('usage', 'general');
    const view = await mount();
    expect(view.queryByText('Translate')).toBeNull();
    expect(view.queryByLabelText('Source language')).toBeNull();
    // A translate chapter made under comics use keeps its way out.
    const items = await menuOf(view, 1, 'Document');
    expect(items).toContain('Switch to typesetting');
    expect(items).not.toContain('Cleaned pages and translations…');
    expect(items).toContain('Export package…');
    await fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    await fireEvent.click(view.container.querySelector('.chapter-open'));
    expect(mock.goEditor).toHaveBeenCalledWith('p', 'c1');
    // Switching usage changed nothing stored on the chapter.
    expect(mock.project.chapters[0].mode).toBe('translate');
    expect(mock.setChapterMode).not.toHaveBeenCalled();
  });

  it('names what it lists by the usage', async () => {
    let view = await mount();
    expect(view.getByRole('heading', { name: 'CHAPTERS' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'New chapter' })).toBeTruthy();
    expect(view.getByText('Chapter 1')).toBeTruthy();
    expect(view.getByText('2 chapters')).toBeTruthy();
    expect(view.getByText('Raws only')).toBeTruthy();
    expect(view.getByText('2 pages · 4 to check')).toBeTruthy();
    cleanup();
    setPref('usage', 'general');
    view = await mount();
    expect(view.getByRole('heading', { name: 'DOCUMENTS' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'New document' })).toBeTruthy();
    expect(view.getByText('Document 1')).toBeTruthy();
    expect(view.getByText('2 documents')).toBeTruthy();
    expect(view.getByText('Images only')).toBeTruthy();
    expect(view.getByText('Text added')).toBeTruthy();
    // The check list is a comic tool.
    expect(view.queryByText(/to check/)).toBeNull();
    const items = await menuOf(view, 2, 'Document');
    expect(items).toContain('Delete document…');
    // Never offered a way into translate mode.
    expect(items).not.toContain('Switch to translating');
  });

  it('says what an empty project holds in the usage\'s words', async () => {
    const chapters = mock.project.chapters;
    mock.project.chapters = [];
    try {
      let view = await mount();
      expect(view.getByText('No chapters yet. New chapter copies your raws into this series.')).toBeTruthy();
      cleanup();
      setPref('usage', 'general');
      view = await mount();
      expect(view.getByText('No documents yet. New document copies your images into this project.')).toBeTruthy();
    } finally {
      mock.project.chapters = chapters;
    }
  });
});
