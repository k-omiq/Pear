import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';

const mock = vi.hoisted(() => ({
  createChapter: vi.fn(), createProject: vi.fn(), goEditor: vi.fn(),
  pickImageFiles: vi.fn(), pickJsonFile: vi.fn(), readTranslations: vi.fn(),
  preparePageFiles: vi.fn(), resliceStripFiles: vi.fn(), toast: vi.fn(), toastError: vi.fn(),
  usage: 'comics', chapterMode: 'translate',
}));
// The usage gate as prefs.svelte.js has it, with the usage set per test.
vi.mock('../prefs.svelte.js', () => ({
  isComics: () => mock.usage !== 'general',
  startMode: () => (mock.usage !== 'general' ? mock.chapterMode : 'typeset'),
}));
vi.mock('../library.svelte.js', () => ({
  library: { projects: [
    { id: 'ja', name: 'Japanese', layout: 'pages', ocrLanguage: 'ja', chapters: [] },
    { id: 'ko', name: 'Korean', layout: 'pages', ocrLanguage: 'ko', chapters: [] },
    { id: 'strip', name: 'Webtoon', layout: 'longstrip', ocrLanguage: 'ko', chapters: [] },
  ] },
  createChapter: mock.createChapter, createProject: mock.createProject,
}));
vi.mock('../route.svelte.js', () => ({ goEditor: mock.goEditor }));
vi.mock('../importer.js', () => ({ pickImageFiles: mock.pickImageFiles, pickJsonFile: mock.pickJsonFile, readTranslations: mock.readTranslations }));
vi.mock('../package-flow.js', () => ({ pickPackageFile: vi.fn(), inspectPackage: vi.fn(), importChapterPackage: vi.fn() }));
vi.mock('../store.svelte.js', () => ({ toast: mock.toast, toastError: mock.toastError }));
vi.mock('../page-prep.js', () => ({ preparePageFiles: mock.preparePageFiles }));
vi.mock('../strip-reslice.js', () => ({
  resliceStripFiles: mock.resliceStripFiles, resliceWarning: () => '', RESLICE_H_DEFAULT: 8000, RESLICE_H_MAX: 10666, clampResliceHeight: (value) => value,
}));
vi.mock('../editor/strip-cuts.js', () => ({ SLICE_H_MIN: 1000 }));
const { default: NewChapterDialog } = await import('./NewChapterDialog.svelte');
let raw;
let prepared;
beforeEach(() => {
  vi.resetAllMocks();
  mock.usage = 'comics';
  mock.chapterMode = 'translate';
  raw = new File(['raw'], 'raw.jpg');
  prepared = new File(['png'], '001.png');
  mock.pickImageFiles.mockResolvedValue([raw]);
  mock.preparePageFiles.mockResolvedValue([prepared]);
  mock.resliceStripFiles.mockResolvedValue({ files: [prepared], warnings: [] });
  mock.createChapter.mockResolvedValue({ id: 'chapter', number: 1 });
  mock.createProject.mockResolvedValue({ id: 'new', name: 'New' });
});
afterEach(cleanup);
async function mount(projectId = 'ja') {
  const view = render(NewChapterDialog, { open: true, projectId });
  await tick();
  return view;
}
async function pickRaw(view) {
  await fireEvent.click(view.getAllByRole('button', { name: 'Choose files…' })[0]);
  await waitFor(() => expect(view.getByRole('button', { name: '1 selected - change' })).toBeTruthy());
}
async function create(view) {
  await fireEvent.click(view.getByRole('button', { name: 'Create', exact: true }));
  await waitFor(() => expect(mock.createChapter).toHaveBeenCalledOnce());
}

describe('page preparation in new chapter import', () => {
  it('offers three unchecked options and copies the originals by default', async () => {
    const view = await mount();
    expect(view.getAllByRole('checkbox')).toHaveLength(3);
    for (const input of view.getAllByRole('checkbox')) expect(input.checked).toBe(false);
    expect(view.getByText('Re-encodes the pages as PNG.')).toBeTruthy();
    await pickRaw(view);
    await create(view);
    expect(mock.preparePageFiles).not.toHaveBeenCalled();
    expect(mock.createChapter.mock.calls[0][0].files).toEqual([raw]);
  });

  it('passes the selected page options and existing project language, then imports the PNG Files', async () => {
    const view = await mount('ko');
    await pickRaw(view);
    for (const name of ['Split spreads', 'Auto-crop', 'Auto-align']) await fireEvent.click(view.getByRole('checkbox', { name }));
    await create(view);
    expect(mock.preparePageFiles).toHaveBeenCalledWith([raw], { splitSpreads: true, autoCrop: true, autoAlign: true, ocrLanguage: 'ko' });
    expect(mock.createChapter.mock.calls[0][0].files).toEqual([prepared]);
    expect(mock.goEditor).toHaveBeenCalledWith('ko', 'chapter');
  });

  it('uses the language chosen for a new project', async () => {
    const view = await mount();
    await fireEvent.change(view.getByRole('combobox'), { target: { value: '__new__' } });
    await fireEvent.input(view.getByLabelText('Project name'), { target: { value: 'New' } });
    await fireEvent.click(view.getByRole('button', { name: 'Chinese', exact: true }));
    await pickRaw(view);
    await fireEvent.click(view.getByRole('checkbox', { name: 'Split spreads' }));
    await create(view);
    expect(mock.preparePageFiles).toHaveBeenCalledWith([raw], expect.objectContaining({ ocrLanguage: 'zh' }));
    expect(mock.createProject).toHaveBeenCalledWith('New', { layout: 'pages', ocrLanguage: 'zh' });
  });

  it('disables selected preparation options when cleaned pages are attached and preserves positional pairing', async () => {
    const view = await mount();
    await pickRaw(view);
    await fireEvent.click(view.getByRole('checkbox', { name: 'Auto-crop' }));
    const clean = new File(['clean'], 'clean.png');
    mock.pickImageFiles.mockResolvedValueOnce([clean]);
    await fireEvent.click(view.getByRole('button', { name: 'Choose files…' }));
    await waitFor(() => expect(view.getByRole('checkbox', { name: 'Auto-crop' }).disabled).toBe(true));
    expect(view.getByText(/unavailable with cleaned pages or translations/)).toBeTruthy();
    await create(view);
    expect(mock.preparePageFiles).not.toHaveBeenCalled();
    expect(mock.createChapter.mock.calls[0][0]).toMatchObject({ files: [raw], cleanedFiles: [clean] });
  });

  it('disables preparation for attached translations and re-enables it after they are cleared', async () => {
    const view = await mount();
    mock.pickJsonFile.mockResolvedValue([new File(['{}'], 'translations.json')]);
    mock.readTranslations.mockResolvedValue([{ lines: [] }]);
    await fireEvent.click(view.getByRole('button', { name: 'Choose a JSON…' }));
    await waitFor(() => expect(view.getByRole('checkbox', { name: 'Split spreads' }).disabled).toBe(true));
    await fireEvent.click(view.getByRole('button', { name: 'Clear', exact: true }));
    expect(view.getByRole('checkbox', { name: 'Split spreads' }).disabled).toBe(false);
  });

  it('offers only strip preparation for longstrip projects, ignoring page options kept from a different target', async () => {
    const view = await mount();
    await pickRaw(view);
    await fireEvent.click(view.getByRole('checkbox', { name: 'Auto-crop' }));
    await fireEvent.change(view.getByRole('combobox'), { target: { value: 'strip' } });
    expect(view.queryByRole('checkbox', { name: 'Auto-crop' })).toBeNull();
    expect(view.getByRole('checkbox', { name: 'Re-cut at clean gutters' })).toBeTruthy();
    await create(view);
    expect(mock.preparePageFiles).not.toHaveBeenCalled();
    expect(mock.createChapter.mock.calls[0][0].files).toEqual([raw]);
  });

  it('reports preparation errors before creating an empty new project', async () => {
    const view = await mount();
    await fireEvent.change(view.getByRole('combobox'), { target: { value: '__new__' } });
    await fireEvent.input(view.getByLabelText('Project name'), { target: { value: 'New' } });
    await pickRaw(view);
    await fireEvent.click(view.getByRole('checkbox', { name: 'Auto-align' }));
    mock.preparePageFiles.mockRejectedValueOnce(new Error('Page is too large'));
    await fireEvent.click(view.getByRole('button', { name: 'Create', exact: true }));
    await waitFor(() => expect(view.getByText(/Could not create the chapter: Page is too large/)).toBeTruthy());
    expect(mock.createProject).not.toHaveBeenCalled();
    expect(mock.createChapter).not.toHaveBeenCalled();
  });
});

describe('usage', () => {
  it('starts a comics chapter in the mode Settings names', async () => {
    const view = await mount();
    expect(view.getByRole('button', { name: 'Translate', exact: true }).classList.contains('on')).toBe(true);
    await pickRaw(view);
    await create(view);
    expect(mock.createChapter.mock.calls[0][0].mode).toBe('translate');
  });

  it('asks general use for no mode and no sources, and always makes a typeset chapter', async () => {
    mock.usage = 'general';
    const view = await mount();
    expect(view.queryByText('Mode')).toBeNull();
    expect(view.queryByText('Cleaned pages')).toBeNull();
    expect(view.queryByText('Translations')).toBeNull();
    await pickRaw(view);
    await create(view);
    expect(mock.createChapter.mock.calls[0][0]).toMatchObject({ mode: 'typeset', cleanedFiles: [], translations: null });
  });
});
