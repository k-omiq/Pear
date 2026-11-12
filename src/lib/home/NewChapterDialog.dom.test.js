import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';

// The new-chapter dialog (plan 2.3): three things always asked, the chapter
// number for comics, the new project's fields, and one closed fold for the
// rest, under each usage.
const mock = vi.hoisted(() => ({
  createChapter: vi.fn(), createProject: vi.fn(), goEditor: vi.fn(), setEmptyProjectLayout: vi.fn(),
  pickChapterSource: vi.fn(), inspectPackage: vi.fn(), importChapterPackage: vi.fn(),
  pickImageFiles: vi.fn(), pickJsonFile: vi.fn(), readTranslations: vi.fn(),
  preparePageFiles: vi.fn(), resliceStripFiles: vi.fn(), toast: vi.fn(), toastError: vi.fn(),
  usage: 'comics', chapterMode: 'translate', ocrLanguage: 'ko',
}));
vi.mock('../library.svelte.js', () => ({
  library: { projects: [
    { id: 'ja', name: 'Japanese', layout: 'pages', ocrLanguage: 'ja', chapters: [{ number: 4 }] },
    { id: 'ko', name: 'Korean', layout: 'pages', ocrLanguage: 'ko', chapters: [], layoutGuessed: true },
    { id: 'strip', name: 'Webtoon', layout: 'longstrip', ocrLanguage: 'ko', chapters: [] },
  ] },
  createChapter: mock.createChapter, createProject: mock.createProject, setEmptyProjectLayout: mock.setEmptyProjectLayout,
}));
// The usage gate as prefs.svelte.js has it, with the usage set per test.
vi.mock('../prefs.svelte.js', () => ({
  isComics: () => mock.usage !== 'general',
  startMode: () => (mock.usage !== 'general' ? mock.chapterMode : 'typeset'),
  prefs: { get defaultOcrLanguage() { return mock.ocrLanguage; } },
}));
vi.mock('../route.svelte.js', () => ({ goEditor: mock.goEditor }));
vi.mock('../importer.js', () => ({ pickImageFiles: mock.pickImageFiles, pickJsonFile: mock.pickJsonFile, readTranslations: mock.readTranslations }));
vi.mock('../package-flow.js', () => ({
  pickChapterSource: mock.pickChapterSource, inspectPackage: mock.inspectPackage, importChapterPackage: mock.importChapterPackage,
}));
vi.mock('../store.svelte.js', () => ({ toast: mock.toast, toastError: mock.toastError }));
vi.mock('../page-prep.js', () => ({ preparePageFiles: mock.preparePageFiles }));
vi.mock('../strip-reslice.js', () => ({
  resliceStripFiles: mock.resliceStripFiles, resliceWarning: () => '', RESLICE_H_DEFAULT: 8000, clampResliceHeight: (value) => value,
}));
const { default: NewChapterDialog } = await import('./NewChapterDialog.svelte');

// A PNG header of the given size: all the layout guess reads.
function png(name, w, h) {
  const head = new Uint8Array(24);
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(head.buffer).setUint32(16, w);
  new DataView(head.buffer).setUint32(20, h);
  return new File([head], name, { type: 'image/png' });
}

let raw;
let prepared;
beforeEach(() => {
  vi.resetAllMocks();
  mock.usage = 'comics';
  mock.chapterMode = 'translate';
  mock.ocrLanguage = 'ko';
  raw = png('raw.png', 800, 1200);
  prepared = new File(['png'], '001.png');
  mock.pickChapterSource.mockResolvedValue({ images: [raw] });
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
async function pick(view) {
  await fireEvent.click(view.getByRole('button', { name: 'Choose images…' }));
  await waitFor(() => expect(view.getByRole('button', { name: /- change$/ })).toBeTruthy());
}
async function create(view, call = mock.createChapter) {
  await fireEvent.click(view.getByRole('button', { name: 'Create', exact: true }));
  await waitFor(() => expect(call).toHaveBeenCalledOnce());
}
const fold = (view) => view.container.querySelector('details.more');
async function openFold(view) {
  fold(view).open = true;
  fold(view).dispatchEvent(new Event('toggle'));
  await tick();
}
const newProject = (view) => fireEvent.change(view.getByRole('combobox'), { target: { value: '__new__' } });

describe('what is always asked', () => {
  it('is the images, the project and a title, with no source switch and no removed options', async () => {
    const view = await mount();
    expect(view.getByRole('button', { name: 'Choose images…' })).toBeTruthy();
    expect(view.getByRole('combobox')).toBeTruthy();
    expect(view.getByLabelText('Title')).toBeTruthy();
    for (const gone of ['Source', 'Package', 'Auto-crop', 'Auto-align', 'Target height (px)', 'Mode']) {
      expect(view.queryByText(gone)).toBeNull();
    }
    expect(view.queryByText(/Page preparation is unavailable/)).toBeNull();
  });

  it('gives comics use the chapter number, last plus one, and the closed fold', async () => {
    const view = await mount();
    expect(view.getByLabelText('Chapter number').value).toBe('5');
    expect(fold(view).open).toBe(false);
    expect(view.getByText('More options')).toBeTruthy();
  });

  it('copies the picked images as they are and starts the chapter in the Settings mode', async () => {
    const view = await mount();
    await pick(view);
    await create(view);
    expect(mock.preparePageFiles).not.toHaveBeenCalled();
    expect(mock.createChapter.mock.calls[0][0]).toMatchObject({ projectId: 'ja', number: 5, files: [raw], mode: 'translate' });
    expect(mock.goEditor).toHaveBeenCalledWith('ja', 'chapter');
  });
});

describe('More options', () => {
  it('starts as the Settings mode and can be switched to Typeset', async () => {
    const view = await mount();
    await openFold(view);
    expect(view.getByRole('group', { name: 'Start as' }).querySelector('[aria-pressed="true"]').textContent).toBe('Translate');
    await fireEvent.click(view.getByRole('button', { name: 'Typeset' }));
    await pick(view);
    await create(view);
    expect(mock.createChapter.mock.calls[0][0].mode).toBe('typeset');
  });

  it('splits spreads for a pages project in the project\'s reading order', async () => {
    const view = await mount('ko');
    await openFold(view);
    expect(view.queryByLabelText('Re-cut long strips at clean gutters')).toBeNull();
    await pick(view);
    await fireEvent.click(view.getByRole('checkbox', { name: 'Split spreads' }));
    await create(view);
    expect(mock.preparePageFiles).toHaveBeenCalledWith([raw], { splitSpreads: true, ocrLanguage: 'ko' });
    expect(mock.createChapter.mock.calls[0][0].files).toEqual([prepared]);
  });

  it('re-cuts a long strip at the fixed 8000 px target', async () => {
    const view = await mount('strip');
    await openFold(view);
    expect(view.queryByRole('checkbox', { name: 'Split spreads' })).toBeNull();
    await pick(view);
    await fireEvent.click(view.getByRole('checkbox', { name: 'Re-cut long strips at clean gutters' }));
    await create(view);
    expect(mock.resliceStripFiles).toHaveBeenCalledWith([raw], 8000);
    expect(mock.createChapter.mock.calls[0][0].files).toEqual([prepared]);
  });

  it('dims the split beside cleaned pages, which pair by position, and sends both untouched', async () => {
    const view = await mount();
    await openFold(view);
    await pick(view);
    await fireEvent.click(view.getByRole('checkbox', { name: 'Split spreads' }));
    const clean = new File(['clean'], 'clean.png');
    mock.pickImageFiles.mockResolvedValueOnce([clean]);
    await fireEvent.click(view.getByRole('button', { name: 'Choose files…' }));
    await waitFor(() => expect(view.getByRole('checkbox', { name: 'Split spreads' }).disabled).toBe(true));
    await create(view);
    expect(mock.preparePageFiles).not.toHaveBeenCalled();
    expect(mock.createChapter.mock.calls[0][0]).toMatchObject({ files: [raw], cleanedFiles: [clean] });
  });

  it('takes a translation file and lets it go again', async () => {
    const view = await mount();
    await openFold(view);
    mock.pickJsonFile.mockResolvedValue([new File(['{}'], 'translations.json')]);
    mock.readTranslations.mockResolvedValue([{ lines: [] }]);
    await fireEvent.click(view.getByRole('button', { name: 'Choose a JSON…' }));
    await waitFor(() => expect(view.getByRole('checkbox', { name: 'Split spreads' }).disabled).toBe(true));
    await fireEvent.click(view.getByRole('button', { name: 'Clear', exact: true }));
    expect(view.getByRole('checkbox', { name: 'Split spreads' }).disabled).toBe(false);
  });
});

describe('a new project', () => {
  it('asks comics use for a name, a layout and the Settings language', async () => {
    const view = await mount();
    await newProject(view);
    expect(view.getByRole('group', { name: 'Language' }).querySelector('[aria-pressed="true"]').textContent).toBe('Korean');
    expect(view.getByRole('group', { name: 'Layout' }).querySelector('[aria-pressed="true"]').textContent).toBe('Pages');
    await fireEvent.input(view.getByLabelText('Series name'), { target: { value: 'New' } });
    await fireEvent.click(view.getByRole('button', { name: 'Chinese' }));
    await pick(view);
    await create(view);
    expect(mock.createProject).toHaveBeenCalledWith('New', { layout: 'pages', ocrLanguage: 'zh', exportScale: 1 });
    expect(mock.createChapter.mock.calls[0][0]).toMatchObject({ projectId: 'new', number: 1 });
  });

  it('preselects Longstrip when the median picked image is over 2.5 times as tall as wide', async () => {
    mock.pickChapterSource.mockResolvedValue({ images: [png('1.png', 800, 1200), png('2.png', 800, 2400), png('3.png', 800, 2401)] });
    const view = await mount();
    await newProject(view);
    await pick(view);
    await waitFor(() => expect(view.getByRole('button', { name: 'Longstrip' }).getAttribute('aria-pressed')).toBe('true'));
    // Still the person's choice.
    await fireEvent.click(view.getByRole('button', { name: 'Pages' }));
    await fireEvent.input(view.getByLabelText('Series name'), { target: { value: 'New' } });
    await create(view);
    expect(mock.createProject).toHaveBeenCalledWith('New', expect.objectContaining({ layout: 'pages' }));
  });

  it('keeps a layout picked by hand when images are picked after it', async () => {
    mock.pickChapterSource.mockResolvedValue({ images: [png('1.png', 800, 4000)] });
    const view = await mount();
    await newProject(view);
    await fireEvent.click(view.getByRole('button', { name: 'Pages' }));
    await pick(view);
    await tick();
    expect(view.getByRole('button', { name: 'Pages' }).getAttribute('aria-pressed')).toBe('true');
    await fireEvent.input(view.getByLabelText('Series name'), { target: { value: 'New' } });
    await create(view);
    expect(mock.createProject).toHaveBeenCalledWith('New', expect.objectContaining({ layout: 'pages' }));
  });

  it('reports a preparation error before making an empty project', async () => {
    const view = await mount();
    await newProject(view);
    await fireEvent.input(view.getByLabelText('Series name'), { target: { value: 'New' } });
    await pick(view);
    await openFold(view);
    await fireEvent.click(view.getByRole('checkbox', { name: 'Split spreads' }));
    mock.preparePageFiles.mockRejectedValueOnce(new Error('Page is too large'));
    await fireEvent.click(view.getByRole('button', { name: 'Create', exact: true }));
    await waitFor(() => expect(view.getByText(/Could not create the chapter: Page is too large/)).toBeTruthy());
    expect(mock.createProject).not.toHaveBeenCalled();
    expect(mock.createChapter).not.toHaveBeenCalled();
  });
});

function translatePackage() {
  mock.pickChapterSource.mockResolvedValue({ package: new File(['zip'], 'ch7.mtchapter') });
  mock.inspectPackage.mockResolvedValue({
    pkg: { record: {} },
    summary: { number: 7, title: 'Seven', projectName: 'Theirs', layout: 'longstrip', ocrLanguage: 'ja', mode: 'translate',
      pageCount: 3, cleanedCount: 0, boxCount: 0, fonts: [], tags: [] },
  });
  mock.importChapterPackage.mockResolvedValue({ chapter: { id: 'pkg', number: 7 } });
}
const choose = async (view, label) => {
  await fireEvent.click(view.getByRole('button', { name: label }));
  await waitFor(() => expect(view.getByRole('button', { name: /- change$/ })).toBeTruthy());
};

describe('a picked package', () => {
  it('keeps its own translate mode under comics use', async () => {
    translatePackage();
    const view = await mount();
    await choose(view, 'Choose images…');
    expect(view.getByText('3 pages · translate chapter')).toBeTruthy();
    await create(view, mock.importChapterPackage);
    expect(mock.importChapterPackage.mock.calls[0][0].mode).toBe(null);
  });

  it('comes in as typeset under general use, and its note names no mode', async () => {
    mock.usage = 'general';
    translatePackage();
    const view = await mount();
    await choose(view, 'Choose images…');
    expect(view.getByText('3 pages · document')).toBeTruthy();
    await create(view, mock.importChapterPackage);
    expect(mock.importChapterPackage.mock.calls[0][0].mode).toBe('typeset');
  });

  it('leaves no title, name or number behind when images are picked instead', async () => {
    translatePackage();
    const view = await mount();
    await newProject(view);
    await choose(view, 'Choose images…');
    expect(view.getByLabelText('Title').value).toBe('Seven');
    expect(view.getByLabelText('Series name').value).toBe('Theirs');
    mock.pickChapterSource.mockResolvedValue({ images: [raw] });
    await choose(view, 'ch7.mtchapter - change');
    await waitFor(() => expect(view.getByLabelText('Title').value).toBe(''));
    expect(view.getByLabelText('Series name').value).toBe('');
    expect(view.getByLabelText('Chapter number').value).toBe('1');
  });

  it('is told apart from images, fills in what it knows and imports whole', async () => {
    const file = new File(['zip'], 'ch7.mtchapter');
    mock.pickChapterSource.mockResolvedValue({ package: file });
    mock.inspectPackage.mockResolvedValue({
      pkg: { record: {} },
      summary: { number: 7, title: 'Seven', projectName: 'Theirs', layout: 'pages', ocrLanguage: 'ja', mode: 'typeset',
        pageCount: 3, cleanedCount: 0, boxCount: 2, fonts: [], tags: [] },
    });
    mock.importChapterPackage.mockResolvedValue({ chapter: { id: 'pkg', number: 7 } });
    const view = await mount();
    await fireEvent.click(view.getByRole('button', { name: 'Choose images…' }));
    await waitFor(() => expect(view.getByRole('button', { name: 'ch7.mtchapter - change' })).toBeTruthy());
    expect(view.getByLabelText('Chapter number').value).toBe('7');
    expect(view.getByLabelText('Title').value).toBe('Seven');
    expect(fold(view)).toBe(null);
    expect(view.getByText('3 pages · 2 boxes · typeset chapter')).toBeTruthy();
    await create(view, mock.importChapterPackage);
    expect(mock.importChapterPackage).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'ja', number: 7, title: 'Seven' }));
    expect(mock.createChapter).not.toHaveBeenCalled();
  });

  it('shows why a pick was refused', async () => {
    mock.pickChapterSource.mockRejectedValue(new Error('Choose page images, or one .mtchapter package on its own.'));
    const view = await mount();
    await fireEvent.click(view.getByRole('button', { name: 'Choose images…' }));
    await waitFor(() => expect(view.getByText(/one \.mtchapter package on its own/)).toBeTruthy());
  });
});

describe('general use', () => {
  beforeEach(() => { mock.usage = 'general'; });

  it('asks only the three things, in its own words, and makes a typeset document', async () => {
    const view = await mount();
    expect(view.getByText('New document')).toBeTruthy();
    expect(view.getByText('Images')).toBeTruthy();
    expect(view.queryByText('Document number')).toBeNull();
    expect(fold(view)).toBe(null);
    await pick(view);
    await create(view);
    expect(mock.createChapter.mock.calls[0][0]).toMatchObject({ number: 5, mode: 'typeset', cleanedFiles: [], translations: null });
    expect(mock.toast).toHaveBeenCalledWith(expect.stringMatching(/^Created document 1 · /));
  });

  it('names a new project only, and picks its layout from the images', async () => {
    mock.pickChapterSource.mockResolvedValue({ images: [png('1.png', 800, 4000)] });
    const view = await mount();
    await newProject(view);
    expect(view.queryByRole('group', { name: 'Layout' })).toBeNull();
    expect(view.queryByRole('group', { name: 'Language' })).toBeNull();
    await fireEvent.input(view.getByLabelText('Project name'), { target: { value: 'Mine' } });
    await pick(view);
    await create(view);
    expect(mock.createProject).toHaveBeenCalledWith('Mine', { layout: 'longstrip', ocrLanguage: 'ko', exportScale: 1 });
  });

  it('lets the first document of an empty project set its layout, and no later one', async () => {
    mock.pickChapterSource.mockResolvedValue({ images: [png('1.png', 800, 4000)] });
    let view = await mount('ko');
    await pick(view);
    await create(view);
    expect(mock.setEmptyProjectLayout).toHaveBeenCalledWith('ko', 'longstrip');
    cleanup();
    vi.clearAllMocks();
    // 'strip' was made with Longstrip picked by hand (no marker), say under
    // comics before a switch to general use: portrait pages leave it alone.
    mock.pickChapterSource.mockResolvedValue({ images: [png('1.png', 800, 1200)] });
    view = await mount('strip');
    await pick(view);
    await create(view);
    expect(mock.setEmptyProjectLayout).not.toHaveBeenCalled();
    cleanup();
    vi.clearAllMocks();
    mock.pickChapterSource.mockResolvedValue({ images: [png('1.png', 800, 4000)] });
    // 'ja' already holds a chapter: its layout stays.
    view = await mount('ja');
    await pick(view);
    await create(view);
    expect(mock.setEmptyProjectLayout).not.toHaveBeenCalled();
  });
});

describe('comics use and an empty project', () => {
  it('never changes the project\'s layout from the images', async () => {
    mock.pickChapterSource.mockResolvedValue({ images: [png('1.png', 800, 4000)] });
    const view = await mount('ko');
    await pick(view);
    await create(view);
    expect(mock.setEmptyProjectLayout).not.toHaveBeenCalled();
  });
});

// Export at 2x is a series setting: a series made from a package takes the
// Size of the series the package came from.
describe('a new series from a package', () => {
  it('exports at the Size of the series the package came from', async () => {
    mock.pickChapterSource.mockResolvedValue({ package: new File(['zip'], 'seven.mtchapter') });
    mock.inspectPackage.mockResolvedValue({
      pkg: { manifest: {} },
      summary: { number: 7, title: 'Seven', pageCount: 2, projectName: 'Sharp', layout: 'longstrip', ocrLanguage: 'ko', exportScale: 2, fonts: [], tags: [] },
    });
    mock.importChapterPackage.mockResolvedValue({ chapter: { id: 'chapter', number: 7 } });
    const view = await mount();
    await newProject(view);
    await choose(view, 'Choose images…');
    await create(view, mock.importChapterPackage);
    expect(mock.createProject).toHaveBeenCalledWith('Sharp', { layout: 'longstrip', ocrLanguage: 'ko', exportScale: 2 });
  });
});
