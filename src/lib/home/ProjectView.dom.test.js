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
  setProjectOcrLanguage: vi.fn(), lastToCheck: () => 0,
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
async function menuOf(view, n) {
  await fireEvent.click(view.getByRole('button', { name: `Chapter ${n} actions` }));
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
    const items = await menuOf(view, 1);
    expect(items).not.toContain('Switch to typesetting');
    expect(items).not.toContain('Cleaned pages and translations…');
    expect(items).toContain('Export package…');
    await fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    await fireEvent.click(view.container.querySelector('.chapter-open'));
    expect(mock.goEditor).toHaveBeenCalledWith('p', 'c1');
    // Switching usage changed nothing stored on the chapter.
    expect(mock.project.chapters[0].mode).toBe('translate');
    expect(mock.setChapterMode).not.toHaveBeenCalled();
  });
});
