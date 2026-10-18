<script>
  import { projectById, deleteChapter, setChapterMode, setProjectOcrLanguage, lastToCheck } from '../library.svelte.js';
  import { route, goLibrary, goEditor } from '../route.svelte.js';
  import { toast, toastError } from '../store.svelte.js';
  import { relativeTime, plural } from '../format.js';
  import { exportChapterPackage, stayingNote } from '../package-flow.js';
  import RowMenu from './RowMenu.svelte';

  let { onNewChapter, onSources, onVersions } = $props();

  // Where a chapter stands, as a drawn mark and a word: no pages, raws only, or
  // typeset.
  function status(c) {
    if (!c.pageCount) return { kind: 'empty', label: 'No pages' };
    if (!c.typeset) return { kind: 'raws', label: 'Raws only' };
    return { kind: 'typeset', label: 'Typeset' };
  }

  // "35 of 40 placed". Nothing for a translate chapter (it has its own count,
  // in the editor) or a chapter with no lines yet.
  function progressNote(c) {
    if (c.unreadable || c.mode === 'translate' || !c.progress?.total) return '';
    return `${c.progress.placed} of ${c.progress.total} placed`;
  }

  // The sub-line under a chapter's title: independent facts, never one
  // sentence. "N to check" is the count this session left when it closed the
  // chapter, while nothing has touched it since (`lastToCheck`).
  function facts(c) {
    const list = [plural(c.pageCount, 'page')];
    if (c.mode === 'translate') list.push('opens to translate');
    const left = c.mode === 'translate' ? 0 : lastToCheck(c);
    if (left) list.push(`${left} to check`);
    if (exportingId === c.id) list.push('exporting…');
    return list;
  }

  // What the row's menu offers. The mode is a choice of how the chapter opens,
  // so the item says what it changes it to.
  function menuItems(c) {
    return [
      { id: 'open', label: 'Open' },
      { id: 'mode', label: c.mode === 'translate' ? 'Switch to typesetting' : 'Switch to translating', disabled: switchingId === c.id },
      { separator: true },
      { id: 'export', label: exportingId === c.id ? 'Exporting…' : 'Export package…', disabled: !!exportingId },
      { id: 'sources', label: 'Cleaned pages and translations…' },
      { id: 'versions', label: 'Earlier versions…' },
      { separator: true },
      { id: 'delete', label: 'Delete chapter…', danger: true },
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
      toast(`Deleted chapter ${chapter.number}`);
    } catch (e) {
      toastError(`Could not delete: ${e?.message ?? e}`);
    }
  }
</script>

{#if project}
  <button class="back-link" onclick={goLibrary}>
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
    Projects
  </button>

  <div class="project-head">
    <div class="project-title">
      <h1 class="project-name">{project.name}</h1>
      <div class="project-meta">
        <span>{plural(project.chapters.length, 'chapter')}</span>
        <span>{plural(pageTotal, 'page')}</span>
        <span>{project.layout === 'longstrip' ? 'Longstrip' : 'Pages'}</span>
        <label class="project-language">
          <span class="sr-only">Source language</span>
          <select value={project.ocrLanguage} onchange={onLanguageChange} disabled={changingLanguage} title="What Detect reads on this series' pages">
            <option value="ja">Japanese source</option>
            <option value="zh">Chinese source</option>
            <option value="ko">Korean source</option>
          </select>
        </label>
      </div>
    </div>
    <button class="accent-btn narrow" onclick={() => onNewChapter(project.id)}>New chapter</button>
  </div>

  <h2 class="section-label spaced">CHAPTERS</h2>

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
          <span class="chapter-mark {c.unreadable ? 'bad' : status(c).kind}" aria-hidden="true">
            <svg viewBox="0 0 12 12" width="12" height="12">
              {#if c.unreadable}<path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              {:else if status(c).kind === 'typeset'}<circle cx="6" cy="6" r="4" fill="currentColor" />
              {:else if status(c).kind === 'raws'}<circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
              {:else}<path d="M3 6h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />{/if}
            </svg>
          </span>
          <span class="chapter-num">{c.unreadable ? '-' : `Ch. ${c.number}`}</span>
          <span class="chapter-title">
            {#if c.duplicate}
              <span class="chapter-name warn">Same chapter as another folder</span>
              <span class="chapter-sub">{c.slug} - rename or remove the copy</span>
            {:else if c.unreadable}
              <span class="chapter-name warn">Unreadable chapter</span>
              <span class="chapter-sub">{c.slug} - check this folder</span>
            {:else}
              <span class="chapter-name">{c.title || `Chapter ${c.number}`}</span>
              <span class="chapter-sub">{facts(c).join(' · ')}</span>
            {/if}
          </span>
          <span class="chapter-status">{c.unreadable ? '' : status(c).label}</span>
          <span class="chapter-progress">{progressNote(c)}</span>
          <span class="chapter-time">{c.unreadable ? '' : relativeTime(c.updatedAt)}</span>
        </button>
        {#if c.unreadable}
          <button class="chapter-del" onclick={() => (confirmingId = c.id)} title="Delete chapter">Delete</button>
        {:else}
          <RowMenu bind:this={menus[c.id]} label="Chapter {c.number} actions" items={menuItems(c)} onpick={(id) => onMenu(c, id)} />
        {/if}
      </li>
      {#if confirmingId === c.id}
        <li class="confirm-row" role="alert">
          <span>Move chapter {c.number} and its {plural(c.pageCount, 'copied raw')} to the trash?</span>
          <button class="soft-btn" onclick={() => (confirmingId = null)}>Cancel</button>
          <button class="soft-btn danger" onclick={() => onDelete(c)}>Move to trash</button>
        </li>
      {/if}
    {:else}
      <li class="home-empty">No chapters yet. New chapter copies your raws into this series.</li>
    {/each}
  </ul>
{:else}
  <div class="home-empty">That project is no longer in the library.</div>
{/if}
