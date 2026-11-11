<script>
  // New chapter dialog (plan 2.3). Three things are always asked: the files,
  // which project, and an optional title. One picker takes page images or one
  // chapter package, told apart by extension, so there is no source switch.
  // Comics use also sees the chapter number, and keeps everything else behind
  // one closed "More options" fold: the start mode, the cleaned pages and the
  // translation file, and the one page preparation that fits the layout.
  //
  // PSD import (chapterPagesFromPsdFiles / pickPsdFiles in psd.js) is parked
  // for now: the code stays, the dialog no longer offers it.
  import { untrack } from 'svelte';
  import { library, createProject, createChapter, setEmptyProjectLayout } from '../library.svelte.js';
  import { goEditor } from '../route.svelte.js';
  import { pickImageFiles, pickJsonFile, readTranslations } from '../importer.js';
  import { pickChapterSource, inspectPackage, importChapterPackage } from '../package-flow.js';
  import { toast, toastError } from '../store.svelte.js';
  import { plural, relativeTime } from '../format.js';
  import { resliceStripFiles, resliceWarning, RESLICE_H_DEFAULT, clampResliceHeight } from '../strip-reslice.js';
  import { preparePageFiles } from '../page-prep.js';
  import { isComics, startMode, prefs } from '../prefs.svelte.js';
  import { word } from '../words.js';
  import ProjectFields from './ProjectFields.svelte';
  import { guessLayout } from './layout-guess.js';

  // In-flight creation blocks dismissal.
  let { open = $bindable(), busy = $bindable(false), projectId = null } = $props();

  let target = $state('');
  let newProjectName = $state('');
  let newProjectLayout = $state('pages');
  let newProjectOcrLanguage = $state('ja');
  let number = $state(1);
  let title = $state('');
  // The picked page images, or the picked package with its description.
  let files = $state([]);
  let pkg = $state(null);
  let pkgSummary = $state(null);
  let pkgName = $state('');
  let reading = $state(false);
  // The layout the picked images read as, and whether the person chose a
  // layout by hand. A layout is permanent, so a guess never overrides a
  // choice; it only fills in until one is made.
  let guessedLayout = $state(null);
  let layoutTouched = $state(false);
  let error = $state('');
  // Behind "More options", which starts closed every time.
  let more = $state(false);
  let workflow = $state(startMode());
  let cleaned = $state([]);
  let translations = $state(null); // { name, pages } from a picked JSON
  let splitSpreads = $state(false);
  let recut = $state(false);
  let prepared = $state.raw(null);
  let prepareWarning = $state('');

  const isPackage = $derived(!!pkg);
  const selectedProject = $derived(library.projects.find((p) => p.id === target));
  const importLayout = $derived(target === '__new__' ? newProjectLayout : selectedProject?.layout ?? 'pages');
  const importLanguage = $derived(target === '__new__' ? newProjectOcrLanguage : selectedProject?.ocrLanguage ?? 'ja');
  // Cleaned pages and translations pair with the raws by position, so a
  // preparation that changes the page count cannot run beside them.
  const prepBlocked = $derived(cleaned.length > 0 || translations !== null);
  // The sources and the preparations are comic tools; general use never
  // sends them, whatever was left set.
  const sources = $derived(isComics() && !isPackage);

  $effect(() => {
    // Any change to the inputs invalidates the prepared-file review.
    files; recut; importLayout; prepBlocked; isPackage;
    prepared = null;
    prepareWarning = '';
  });

  function nextNumberFor(id) {
    const p = library.projects.find((x) => x.id === id);
    return p ? (p.chapters.at(-1)?.number ?? 0) + 1 : 1;
  }

  // Reset dialog state on open.
  $effect(() => {
    if (!open) return;
    const pid = projectId;
    untrack(() => {
      target = pid ?? library.projects.find((p) => !p.unreadable)?.id ?? '__new__';
      number = nextNumberFor(target);
      title = '';
      files = [];
      pkg = null;
      pkgSummary = null;
      pkgName = '';
      reading = false;
      error = '';
      newProjectName = '';
      newProjectLayout = 'pages';
      newProjectOcrLanguage = prefs.defaultOcrLanguage;
      more = false;
      guessedLayout = null;
      layoutTouched = false;
      workflow = startMode();
      cleaned = [];
      translations = null;
      splitSpreads = false;
      recut = false;
    });
  });

  function onTargetChange() {
    if (!isPackage) number = nextNumberFor(target);
  }

  // Native file pickers (Tauri only).
  async function picking(label, fn) {
    try {
      await fn();
    } catch (e) {
      error = `${label} - ${e?.message ?? e}`;
    }
  }

  const PICKER = 'Could not open the file picker';

  // The one picker. Images become the chapter's pages and preselect the new
  // project's layout; a package fills in what it knows - number, title, and
  // for a new project its name, layout and language - all still editable.
  // Neither overrides a layout the person picked by hand.
  async function pickSource() {
    error = '';
    reading = true;
    try {
      const got = await pickChapterSource();
      if (!got) return;
      if (got.package) {
        const read = await inspectPackage(got.package, target === '__new__' ? null : target);
        files = [];
        pkg = read.pkg;
        pkgSummary = read.summary;
        pkgName = got.package.name ?? '';
        number = read.summary.number;
        title = read.summary.title;
        if (!newProjectName.trim()) newProjectName = read.summary.projectName ?? '';
        guessedLayout = null;
        if (!layoutTouched) newProjectLayout = read.summary.layout;
        newProjectOcrLanguage = read.summary.ocrLanguage;
      } else {
        // Images after a package: what the package filled in is not theirs.
        if (pkgSummary) {
          number = nextNumberFor(target);
          if (title === pkgSummary.title) title = '';
          if (newProjectName === (pkgSummary.projectName ?? '')) newProjectName = '';
        }
        pkg = null;
        pkgSummary = null;
        pkgName = '';
        files = got.images;
        guessedLayout = await guessLayout(got.images);
        if (!layoutTouched) newProjectLayout = guessedLayout;
      }
    } catch (e) {
      error = `Could not read those files: ${e?.message ?? e}`;
    } finally {
      reading = false;
    }
  }

  const pickCleaned = () =>
    picking(PICKER, async () => {
      const picked = await pickImageFiles(true);
      if (picked) cleaned = [...picked];
    });

  const pickTranslations = () =>
    picking('Could not read that translation file', async () => {
      const picked = await pickJsonFile();
      if (!picked || !picked[0]) return;
      // Validate translation JSON on selection.
      translations = { name: picked[0].name, pages: await readTranslations(picked[0]) };
    });

  const layoutLabel = (l) => (l === 'longstrip' ? 'Longstrip' : 'Pages');

  const pickLabel = $derived(
    reading ? 'Reading…'
      : pkgName ? `${pkgName} - change`
      : files.length ? `${files.length} selected - change`
      : 'Choose images…',
  );

  // Preview positional page count.
  const summary = $derived.by(() => {
    if (isPackage) {
      const sm = pkgSummary;
      if (!sm) return [];
      const notes = [];
      let head = plural(sm.pageCount, 'page');
      if (sm.cleanedCount) head += ` · ${sm.cleanedCount} cleaned`;
      if (sm.boxCount) head += ` · ${plural(sm.boxCount, 'box', 'boxes')}`;
      // General use imports every package as typeset, so it names no mode.
      head += isComics() ? ` · ${sm.mode} ${word('chapter').toLowerCase()}` : ` · ${word('chapter').toLowerCase()}`;
      notes.push({ text: head, warn: false });
      const by = (st) => sm.fonts.filter((f) => f.status === st);
      const bits = [];
      if (by('install').length) bits.push(`${by('install').length} to install`);
      if (by('present').length) bits.push(`${by('present').length} already here`);
      // Only said with the Rust engine on (package-flow.js, `fontStatus`).
      if (by('system').length) bits.push(`${by('system').length} installed on this computer`);
      if (bits.length) notes.push({ text: `Fonts - ${bits.join(', ')}`, warn: false });
      const missing = by('missing').map((f) => f.name);
      if (missing.length) {
        notes.push({
          text: `${plural(missing.length, 'font')} not in the package - will use a fallback (${missing.join(', ')})`,
          warn: true,
        });
      }
      const fresh = sm.tags.filter((t) => t.status === 'new').length;
      if (sm.tags.length) {
        const tb = [];
        if (fresh) tb.push(`${fresh} new`);
        if (sm.tags.length - fresh) tb.push(`${sm.tags.length - fresh} known`);
        notes.push({ text: `Tags - ${tb.join(', ')}`, warn: false });
      }
      const tp = target === '__new__' ? null : library.projects.find((p) => p.id === target);
      if (tp && tp.layout !== sm.layout) {
        notes.push({
          text: `This package was made for a ${layoutLabel(sm.layout)} project. It will still import.`,
          warn: true,
        });
      }
      const src = [];
      if (sm.projectName) src.push(`From "${sm.projectName}"`);
      if (sm.app) src.push(`v${sm.app}`);
      const when = relativeTime(sm.exportedAt);
      if (when) src.push(`exported ${when}`);
      if (src.length) notes.push({ text: src.join(' · '), warn: false });
      return notes;
    }
    if (!files.length) return [];
    const notes = [{ text: `${plural(files.length, 'page')} in this ${word('chapter').toLowerCase()}.`, warn: false }];
    if (!sources) return notes;

    if (cleaned.length === files.length) {
      notes.push({ text: `All ${files.length} pages will use a cleaned image.`, warn: false });
    } else if (cleaned.length && cleaned.length < files.length) {
      notes.push({
        text: `${cleaned.length} of ${files.length} pages will use a cleaned image; pages ${cleaned.length + 1}–${files.length} keep their raw.`,
        warn: true,
      });
    } else if (cleaned.length) {
      notes.push({
        text: `${files.length} cleaned images pair with a page; the last ${cleaned.length - files.length} are ignored.`,
        warn: true,
      });
    }

    if (translations) {
      const covered = Math.min(translations.pages.length, files.length);
      const lines = translations.pages.slice(0, covered).reduce((n, pg) => n + pg.lines.length, 0);
      if (translations.pages.length === files.length) {
        notes.push({ text: `Translations for all ${files.length} pages - ${plural(lines, 'line')}.`, warn: false });
      } else if (translations.pages.length < files.length) {
        notes.push({
          text: `Translations cover pages 1–${translations.pages.length} of ${files.length} - ${plural(lines, 'line')}.`,
          warn: true,
        });
      } else {
        notes.push({
          text: `Translations describe ${translations.pages.length} pages; the last ${translations.pages.length - files.length} are ignored.`,
          warn: true,
        });
      }
    }
    return notes;
  });

  async function submit() {
    error = '';
    if (!isPackage && !files.length) {
      error = `Pick at least one ${word('raw').toLowerCase()}.`;
      return;
    }
    if (target === '__new__' && !newProjectName.trim()) {
      error = 'Name the new project.';
      return;
    }
    const n = number === null || number === undefined || number === '' ? 1 : Number(number);
    if (!Number.isFinite(n) || n < 0) {
      error = `Enter a valid ${word('chapter').toLowerCase()} number.`;
      return;
    }
    busy = true;

    let createdProject = null;
    try {
      let importFiles = files;
      const prep = sources && !prepBlocked;
      if (prep && importLayout === 'longstrip' && recut) {
        if (!prepared) {
          prepared = await resliceStripFiles([...files], clampResliceHeight(RESLICE_H_DEFAULT));
          prepareWarning = resliceWarning(prepared.warnings);
          // Keep fallback warnings visible before import. A second Create
          // uses these prepared files without decoding the chapter again.
          if (prepareWarning) return;
        }
        importFiles = prepared.files;
      }
      if (prep && importLayout === 'pages' && splitSpreads) {
        importFiles = await preparePageFiles([...files], { splitSpreads, ocrLanguage: importLanguage });
      }
      if (target === '__new__') {
        createdProject = await createProject(newProjectName.trim(), {
          layout: newProjectLayout,
          ocrLanguage: newProjectOcrLanguage,
        });
      }
      const pid = createdProject ? createdProject.id : target;
      // General use asks no layout, so a project it made from the library
      // reads as pages until its first document's images say otherwise. Only
      // a project marked so (`layoutGuessed`), and only while it is empty: a
      // layout someone chose, or one under existing work, never moves.
      if (!isComics() && !createdProject && !isPackage && guessedLayout && selectedProject?.layoutGuessed && !selectedProject.chapters.length) {
        await setEmptyProjectLayout(pid, guessedLayout);
      }

      let chapter;
      let note;
      if (isPackage) {
        const r = await importChapterPackage({ pkg, projectId: pid, number: n, title, mode: isComics() ? null : 'typeset' });
        chapter = r.chapter;
        const parts = [plural(pkgSummary.pageCount, 'page')];
        if (r.fontsInstalled) parts.push(`${plural(r.fontsInstalled, 'font')} installed`);
        if (r.fontsFailed) parts.push(`${plural(r.fontsFailed, 'font')} could not be installed`);
        if (r.tagsAdded) parts.push(`${plural(r.tagsAdded, 'tag')} added`);
        note = parts.join(' · ');
      } else {
        chapter = await createChapter({
          projectId: pid,
          number: n,
          title,
          files: importFiles,
          cleanedFiles: sources ? cleaned : [],
          translations: sources ? translations?.pages ?? null : null,
          mode: isComics() ? workflow : 'typeset',
        });
        note = `${plural(importFiles.length, 'page')} copied`;
        if (sources && cleaned.length) note += ` · ${Math.min(cleaned.length, files.length)} cleaned`;
      }
      open = false;
      toast(`Created ${word('chapter').toLowerCase()} ${chapter.number} · ${note}`);
      await goEditor(pid, chapter.id);
    } catch (e) {

      const orphan = createdProject
        ? ` The project "${createdProject.name}" was created and is now empty.`
        : '';
      error = `Could not create the ${word('chapter').toLowerCase()}: ${e?.message ?? e}.${orphan}`;

      toastError(error);
    } finally {
      busy = false;
    }
  }
</script>

{#if open}
  <div
    class="modal-overlay open"
    role="presentation"
    onclick={(e) => e.target.classList.contains('modal-overlay') && !busy && (open = false)}
  >
    <div class="modal dialog-narrow">
      <div class="modal-head">{word('newChapter')}</div>

      <div class="field">
        <span>{word('rawPages')}</span>
        <button class="soft-btn" onclick={pickSource} disabled={busy || reading}>{pickLabel}</button>
      </div>

      <label class="field">
        <span>Project</span>
        <select bind:value={target} onchange={onTargetChange} disabled={busy}>
          {#each library.projects.filter((p) => !p.unreadable) as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
          <option value="__new__">New project…</option>
        </select>
      </label>

      {#if target === '__new__'}
        <ProjectFields bind:name={newProjectName} bind:layout={newProjectLayout} bind:language={newProjectOcrLanguage} disabled={busy} onpicklayout={() => (layoutTouched = true)} />
      {/if}

      {#if isComics()}
        <label class="field">
          <span>{word('chapter')} number</span>
          <input type="number" min="0" bind:value={number} disabled={busy} />
        </label>
      {/if}

      <label class="field">
        <span>Title</span>
        <input bind:value={title} placeholder="Optional" disabled={busy} />
      </label>

      <!-- Everything a package carries is described in the notes below, so
           the fold is for picked images only. -->
      {#if sources}
        <details class="more" bind:open={more}>
          <summary>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
            More options
          </summary>
          <div class="more-body">
            <div class="field">
              <span id="nc-start">Start as</span>
              <div class="seg" role="group" aria-labelledby="nc-start">
                <button class:on={workflow === 'typeset'} aria-pressed={workflow === 'typeset'} onclick={() => (workflow = 'typeset')} disabled={busy}>Typeset</button>
                <button class:on={workflow === 'translate'} aria-pressed={workflow === 'translate'} onclick={() => (workflow = 'translate')} disabled={busy}>Translate</button>
              </div>
            </div>

            <div class="field">
              <span>Cleaned pages</span>
              <button class="soft-btn" onclick={pickCleaned} disabled={busy}>
                {cleaned.length ? `${cleaned.length} selected - change` : 'Choose files…'}
              </button>
              {#if cleaned.length}
                <button class="soft-btn slim" onclick={() => (cleaned = [])} disabled={busy}>Clear</button>
              {/if}
            </div>

            <div class="field">
              <span>Translation file</span>
              <button class="soft-btn" onclick={pickTranslations} disabled={busy}>
                {translations ? `${translations.name} - change` : 'Choose a JSON…'}
              </button>
              {#if translations}
                <button class="soft-btn slim" onclick={() => (translations = null)} disabled={busy}>Clear</button>
              {/if}
            </div>

            <!-- Dimmed, never hidden, beside cleaned pages or a translation
                 file: those pair with the pages by position, and a cut would
                 move every pairing after it. -->
            {#if importLayout === 'longstrip'}
              <label class="pair-note prep-option" title={prepBlocked ? 'Not with cleaned pages or a translation file: they pair with the pages by position.' : ''}>
                <input class="btick" type="checkbox" bind:checked={recut} disabled={busy || prepBlocked} />
                Re-cut long strips at clean gutters
              </label>
              {#if prepareWarning}<div class="pair-note warn">{prepareWarning}</div>{/if}
            {:else}
              <label class="pair-note prep-option" title={prepBlocked ? 'Not with cleaned pages or a translation file: they pair with the pages by position.' : ''}>
                <input class="btick" type="checkbox" bind:checked={splitSpreads} disabled={busy || prepBlocked} />
                Split spreads
              </label>
            {/if}
            <div class="pair-note">Re-encodes the pages as PNG.</div>
          </div>
        </details>
      {/if}

      {#each summary as note}
        <div class="pair-note" class:warn={note.warn}>{note.text}</div>
      {/each}

      {#if error}<div class="home-error">{error}</div>{/if}

      <div class="modal-foot">
        <button class="soft-btn" onclick={() => (open = false)} disabled={busy}>Cancel</button>
        <button class="accent-btn narrow" onclick={submit} disabled={busy}>
          {busy ? (isPackage ? 'Importing…' : 'Copying…') : prepareWarning ? 'Create with these cuts' : 'Create'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .prep-option { display: flex; align-items: center; gap: 8px; }
  /* One closed fold for everything a first chapter can do without. */
  .more { margin: 2px 0 12px; }
  .more summary {
    display: flex; align-items: center; gap: 6px; height: 30px; width: max-content;
    list-style: none; cursor: pointer; font-size: 11.5px; color: var(--t2);
  }
  .more summary::-webkit-details-marker { display: none; }
  .more summary:hover { color: var(--text); }
  .more summary svg { transition: transform 0.12s ease; }
  .more[open] summary svg { transform: rotate(90deg); }
  .more-body { padding-top: 8px; }
  @media (prefers-reduced-motion: reduce) {
    .more summary svg { transition: none; }
  }
</style>
