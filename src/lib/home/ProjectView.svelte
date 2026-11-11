<script>
  import { projectById, deleteChapter, setChapterMode, setProjectOcrLanguage, lastToCheck } from '../library.svelte.js';
  import { route, goLibrary, goEditor } from '../route.svelte.js';
  import { toast, toastError } from '../store.svelte.js';
  import { relativeTime, plural } from '../format.js';
  import { exportChapterPackage, stayingNote } from '../package-flow.js';
  import RowMenu from './RowMenu.svelte';
  import { isComics } from '../prefs.svelte.js';
  import { word } from '../words.js';

  let { onNewChapter, onSources, onVersions } = $props();

  // Where a chapter stands, as a drawn mark and a word: no pages, raws only, or
  // typeset.
  function status(c) {
    if (!c.pageCount) return { kind: 'empty', label: 'No pages' };
    if (!c.typeset) return { kind: 'raws', label: `${word('raw')}s only` };
    return { kind: 'typeset', label: isComics() ? 'Typeset' : 'Text added' };
  }

  // How far through the chapter is, in the unit its mode counts: lines placed
  // for a typeset chapter, lines translated for a translate one. Null while
  // there is nothing to count - the stage word says why instead.
  function progressOf(c) {
    if (c.unreadable || !c.progress?.total) return null;
    const translate = c.mode === 'translate';
    const done = translate ? c.progress.translated : c.progress.placed;
    if (done == null) return null;
    return { done, total: c.progress.total, word: translate ? 'translated' : 'placed', share: done / c.progress.total };
  }

  // The sub-line under a chapter's title: independent facts, never one
  // sentence. "N to check" is the count this session left when it closed the
  // chapter, while nothing has touched it since (`lastToCheck`).
  function facts(c) {
    const list = [plural(c.pageCount, 'page')];
    // The check list is a comic tool (plan 2.1), so general use counts none.
    const left = c.mode === 'translate' || !isComics() ? 0 : lastToCheck(c);
    if (left) list.push(`${left} to check`);
    if (exportingId === c.id) list.push('exporting…');
    return list;
  }

  // What the row's menu offers. The mode is a choice of how the chapter opens,
  // so the item says what it changes it to.
  // General use has no translate chapters and no cleaned-page or translation
  // imports (plan 2.1), so it is never offered "Switch to translating" or the
  // sources. A chapter made translate under comics use still opens as one,
  // and keeps "Switch to typesetting" as its way out.
  function menuItems(c) {
    const comics = isComics();
    const mode = comics || c.mode === 'translate';
    return [
      { id: 'open', label: 'Open' },
      ...(mode ? [{ id: 'mode', label: c.mode === 'translate' ? 'Switch to typesetting' : 'Switch to translating', disabled: switchingId === c.id }] : []),
      { separator: true },
      { id: 'export', label: exportingId === c.id ? 'Exporting…' : 'Export package…', disabled: !!exportingId },
      ...(comics ? [{ id: 'sources', label: 'Cleaned pages and translations…' }] : []),
      { id: 'versions', label: 'Earlier versions…' },
      { separator: true },
      { id: 'delete', label: `Delete ${word('chapter').toLowerCase()}…`, danger: true },
    ];
  }

  function onMenu(c, id) {
    if (id === 'open') goEditor(project.id, c.id);
    else if (id === 'mode') onToggleMode(c);
    else if (id === 'export') onExport(c);
    else if (id === 'sources') onSources(project.id, c.id);
    else if (id === 'versions') onVersions(project.id, c.id);
    else if (id === 'delete') confirmingId = c.id;
  }

  // Right-click and the context-menu key open the same menu: at the pointer,
  // or over the row's right end from the keyboard.
  const menus = {};
  function onRowContext(e, c) {
    if (c.unreadable) return;
    e.preventDefault();
    menus[c.id]?.openAt(e.clientX, e.clientY);
  }
  function onRowKey(e, c) {
    const shiftF10 = e.key === 'F10' && e.shiftKey;
    if ((!shiftF10 && e.key !== 'ContextMenu') || c.unreadable) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    menus[c.id]?.openAt(r.left, r.top + r.height / 2, { focus: true, right: r.right });
  }

  const project = $derived(projectById(route.projectId));
  const pageTotal = $derived((project?.chapters ?? []).reduce((n, c) => n + c.pageCount, 0));

  let confirmingId = $state(null);
  // Track active row mode write.
  let switchingId = $state(null);
  // The row whose package is being built and written.
  let exportingId = $state(null);
  let changingLanguage = $state(false);

  async function onLanguageChange(event) {
    if (changingLanguage) return;
    const select = event.currentTarget;
    changingLanguage = true;
    try {
      await setProjectOcrLanguage(project.id, select.value);
    } catch (e) {
      select.value = project.ocrLanguage;
      toastError(`Could not change source language: ${e?.message ?? e}`);
    } finally {
      changingLanguage = false;
    }
  }

  // Build a package for one chapter and save it wherever the user says. A
  // cancelled save dialog resolves to null and is not worth a toast.
  async function onExport(c) {
    if (exportingId) return;
    exportingId = c.id;
    try {
      const saved = await exportChapterPackage(project.id, c.id);
      // With the Rust engine on, also which fonts went without a file: a
      // system font is not copied, and the other machine needs its own.
      const note = stayingNote(saved?.staying);
      if (saved) toast(note ? `Saved to ${saved.path}. ${note}` : `Saved to ${saved.path}`);
    } catch (e) {
      toastError(`Could not export: ${e?.message ?? e}`);
    } finally {
      exportingId = null;
    }
  }

  // Toggle chapter workflow mode.
  async function onToggleMode(c) {
    if (switchingId) return;
    switchingId = c.id;
    const next = c.mode === 'translate' ? 'typeset' : 'translate';
    try {
      await setChapterMode(project.id, c.id, next);
      toast(`Chapter ${c.number} is now a ${next} chapter`);
    } catch (e) {
      toastError(`Could not change the mode: ${e?.message ?? e}`);
    } finally {
      switchingId = null;
    }
  }

  async function onDelete(chapter) {
    confirmingId = null;
    try {
      await deleteChapter(project.id, chapter.id);
      toast(`Deleted ${word('chapter').toLowerCase()} ${chapter.number}`);
    } catch (e) {
      toastError(`Could not delete: ${e?.message ?? e}`);
    }
  }
</script>

{#if project}
<div class="project-page">
  <button class="back-link" onclick={goLibrary}>
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
    Projects
  </button>

  <div class="project-head">
    <div class="project-title">
      <h1 class="project-name">{project.name}</h1>
      <div class="project-meta">
        <span>{plural(project.chapters.length, word('chapter').toLowerCase())}</span>
        <span>{plural(pageTotal, 'page')}</span>
        <span>{project.layout === 'longstrip' ? 'Longstrip' : 'Pages'}</span>
        <!-- What Detect reads: general use has no Detect, so no language. -->
        {#if isComics()}
        <label class="project-language">
          <span class="sr-only">Source language</span>
          <select value={project.ocrLanguage} onchange={onLanguageChange} disabled={changingLanguage} title="What Detect reads on this series' pages, and which way it numbers the bubbles">
            <option value="ja">Japanese source · reads right to left</option>
            <option value="zh">Chinese source · reads left to right</option>
            <option value="ko">Korean source · reads left to right</option>
          </select>
        </label>
        {/if}
      </div>
    </div>
    <button class="accent-btn narrow" onclick={() => onNewChapter(project.id)}>{word('newChapter')}</button>
  </div>

  <h2 class="section-label spaced">{word('chapters').toUpperCase()}</h2>

  <ul class="chapter-table">
    {#each project.chapters as c (c.id)}
      <li
        class="chapter-row"
        class:unreadable={c.unreadable}
        class:confirming={confirmingId === c.id}
        oncontextmenu={(e) => onRowContext(e, c)}
      >
        <button
          class="chapter-open"
          onclick={() => goEditor(project.id, c.id)}
          onkeydown={(e) => onRowKey(e, c)}
          disabled={c.unreadable}
          aria-keyshortcuts="Shift+F10"
        >
          <span class="chapter-mark {c.unreadable ? 'bad' : status(c).kind}" aria-hidden="true" title={c.unreadable ? '' : status(c).label}>
            <svg viewBox="0 0 12 12" width="12" height="12">
              {#if c.unreadable}<path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              {:else if status(c).kind === 'typeset'}<circle cx="6" cy="6" r="4" fill="currentColor" />
              {:else if status(c).kind === 'raws'}<circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
              {:else}<path d="M3 6h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />{/if}
            </svg>
          </span>
          <span class="chapter-num">{c.unreadable ? '-' : c.number}</span>
          <span class="chapter-title">
            {#if c.duplicate}
              <span class="chapter-name warn">Same {word('chapter').toLowerCase()} as another folder</span>
              <span class="chapter-sub">{c.slug} - rename or remove the copy</span>
            {:else if c.unreadable}
              <span class="chapter-name warn">Unreadable {word('chapter').toLowerCase()}</span>
              <span class="chapter-sub">{c.slug} - check this folder</span>
            {:else}
              <!-- The number is already in its own column, so a chapter with no
                   title of its own does not say "Chapter 12" beside "12". -->
              <span class="chapter-name" class:untitled={!c.title}>{c.title || `${word('chapter')} ${c.number}`}</span>
              <span class="chapter-sub">{facts(c).join(' · ')}</span>
            {/if}
          </span>
          <span class="chapter-mode">
            {#if !c.unreadable && c.mode === 'translate' && isComics()}
              <span class="mode-chip" title="Opens as the page and the typing pane">
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h6M5.5 2.5V4M4 4c.4 2.6 2 4.4 4 5.5M7 4c-.5 2.4-2.2 4.6-4.5 6" /><path d="M8.5 13.5l2.8-7 2.8 7M9.6 11h3.4" /></svg>
                Translate
              </span>
            {/if}
          </span>
          <span class="chapter-progress">
            {#if progressOf(c)}
              {@const pr = progressOf(c)}
              <span class="cp-meter" aria-hidden="true"><span style="width:{(pr.share * 100).toFixed(1)}%"></span></span>
              <span class="cp-text">{pr.done} / {pr.total} {pr.word}</span>
            {:else if !c.unreadable}
              <span class="cp-stage">{status(c).label}</span>
            {/if}
          </span>
          <span class="chapter-time">{c.unreadable ? '' : relativeTime(c.updatedAt)}</span>
        </button>
        {#if c.unreadable}
          <button class="chapter-del" onclick={() => (confirmingId = c.id)} title="Delete {word('chapter').toLowerCase()}">Delete</button>
        {:else}
          <RowMenu bind:this={menus[c.id]} label="{word('chapter')} {c.number} actions" items={menuItems(c)} onpick={(id) => onMenu(c, id)} />
        {/if}
      </li>
      {#if confirmingId === c.id}
        <li class="confirm-row" role="alert">
          <span>Move {word('chapter').toLowerCase()} {c.number} and its {plural(c.pageCount, `copied ${word('raw').toLowerCase()}`)} to the trash?</span>
          <button class="soft-btn" onclick={() => (confirmingId = null)}>Cancel</button>
          <button class="soft-btn danger" onclick={() => onDelete(c)}>Move to trash</button>
        </li>
      {/if}
    {:else}
      <li class="home-empty">No {word('chapters').toLowerCase()} yet. {word('newChapter')} copies your {word('raw').toLowerCase()}s into this {word('series').toLowerCase()}.</li>
    {/each}
  </ul>
</div>
{:else}
  <div class="home-empty">That project is no longer in the library.</div>
{/if}
