import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The library screen in each usage's words, and its empty state's one way in.
const lib = vi.hoisted(() => ({ createProject: vi.fn(async (name) => ({ id: 'new', name })) }));
vi.mock('../library.svelte.js', () => ({
  library: { projects: [], loading: false, error: '' },
  scanLibrary: vi.fn(), createProject: lib.createProject, deleteProject: vi.fn(),
}));
vi.mock('../route.svelte.js', () => ({ goProject: vi.fn() }));

const { default: LibraryView } = await import('./LibraryView.svelte');
const { setPref } = await import('../prefs.svelte.js');

afterEach(() => {
  cleanup();
  setPref('usage', 'comics');
});

async function mount() {
  const onNewChapter = vi.fn();
  const view = render(LibraryView, { onNewChapter });
  await tick();
  return { view, onNewChapter };
}

describe('the empty library', () => {
  it('tells comics use to start a chapter, with the button under it', async () => {
    setPref('usage', 'comics');
    const { view, onNewChapter } = await mount();
    expect(view.getByText('No projects yet.')).toBeTruthy();
    expect(view.getByText('Start a chapter and the pages you pick are copied into your library.')).toBeTruthy();
    const starts = view.getAllByRole('button', { name: 'New chapter' });
    expect(starts).toHaveLength(2);
    await fireEvent.click(starts[1]);
    expect(onNewChapter).toHaveBeenCalledOnce();
  });

  it('tells general use to add images, and names a new document', async () => {
    setPref('usage', 'general');
    const { view } = await mount();
    expect(view.getByText('Add images and they are copied into your library.')).toBeTruthy();
    expect(view.getAllByRole('button', { name: 'New document' })).toHaveLength(2);
    expect(view.queryByRole('button', { name: 'New chapter' })).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'New project' }));
    expect(view.getByLabelText('Project name')).toBeTruthy();
  });
});

describe('a project made here', () => {
  it('is marked as having a default layout under general use, and a chosen one under comics', async () => {
    setPref('usage', 'general');
    let { view } = await mount();
    await fireEvent.click(view.getByRole('button', { name: 'New project' }));
    await fireEvent.input(view.getByLabelText('Project name'), { target: { value: 'Mine' } });
    await fireEvent.click(view.getByRole('button', { name: 'Create project' }));
    expect(lib.createProject).toHaveBeenLastCalledWith('Mine', expect.objectContaining({ layout: 'pages', layoutGuessed: true }));
    cleanup();
    setPref('usage', 'comics');
    ({ view } = await mount());
    await fireEvent.click(view.getByRole('button', { name: 'New project' }));
    await fireEvent.input(view.getByLabelText('Series name'), { target: { value: 'Strip' } });
    await fireEvent.click(view.getByRole('button', { name: 'Longstrip' }));
    await fireEvent.click(view.getByRole('button', { name: 'Create project' }));
    expect(lib.createProject).toHaveBeenLastCalledWith('Strip', expect.objectContaining({ layout: 'longstrip', layoutGuessed: false }));
  });
});
