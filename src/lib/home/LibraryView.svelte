<script>
  import { onMount } from 'svelte';
  import { library, scanLibrary, createProject, deleteProject } from '../library.svelte.js';
  import { goProject } from '../route.svelte.js';
  import { toast, toastError } from '../store.svelte.js';
  import ProjectCard from './ProjectCard.svelte';
  import { word } from '../words.js';
  import { isComics } from '../prefs.svelte.js';

  let { onNewChapter } = $props();

  let confirmingId = $state(null); // inline two-step delete confirm
  let naming = $state(false);
  let newName = $state('');
  // Project reading layout.
  let layout = $state('pages');
  let ocrLanguage = $state('ja');

  onMount(scanLibrary);

  async function onCreate() {
    const name = newName.trim();
    if (!name) return;
    naming = false;
    newName = '';
    const chosen = layout;
    const chosenLanguage = ocrLanguage;
    layout = 'pages';
    ocrLanguage = 'ja';

    try {
      const p = await createProject(name, { layout: chosen, ocrLanguage: chosenLanguage });
      goProject(p.id);
    } catch (e) {
      toastError(`Could not create ${name}: ${e?.message ?? e}`);
    }
  }

  function pageCountOf(project) {
    return project.chapters.reduce((n, c) => n + c.pageCount, 0);
  }

  function cancelNew() {
    naming = false;
    newName = '';
    layout = 'pages';
    ocrLanguage = 'ja';
  }

  async function onDelete(project) {
    confirmingId = null;
    try {
      await deleteProject(project.id);
      toast(`Deleted ${project.name}`);
    } catch (e) {
      toastError(`Could not delete: ${e?.message ?? e}`);
    }
  }
</script>

<div class="home-actions">
  {#if naming}
    <!-- A new project: its name, how its pages are read, and the language
         Detect reads. One column, the width of the widest choice. -->
    <form class="new-project" onsubmit={(e) => { e.preventDefault(); onCreate(); }} onkeydown={(e) => e.key === 'Escape' && (e.stopPropagation(), cancelNew())}>
      <input class="name-input" placeholder={word('seriesName')} aria-label={word('seriesName')} bind:value={newName} autofocus />
      <div class="seg new-layout" role="group" aria-label="Layout">
        <button type="button" class:on={layout === 'pages'} onclick={() => (layout = 'pages')}>Pages</button>
        <button type="button" class:on={layout === 'longstrip'} onclick={() => (layout = 'longstrip')}>Longstrip</button>
      </div>
      <div class="seg new-language" role="group" aria-label="Source language">
        <button type="button" class:on={ocrLanguage === 'ja'} onclick={() => (ocrLanguage = 'ja')}>Japanese</button>
        <button type="button" class:on={ocrLanguage === 'zh'} onclick={() => (ocrLanguage = 'zh')}>Chinese</button>
        <button type="button" class:on={ocrLanguage === 'ko'} onclick={() => (ocrLanguage = 'ko')}>Korean</button>
      </div>
      <div class="new-project-foot">
        <button type="button" class="soft-btn" onclick={cancelNew}>Cancel</button>
        <button type="submit" class="accent-btn narrow" disabled={!newName.trim()}>Create project</button>
      </div>
    </form>
  {:else}
    <button class="accent-btn" onclick={onNewChapter}>{word('newChapter')}</button>
    <button class="soft-btn wide" onclick={() => (naming = true)}>New project</button>
  {/if}
</div>

<h2 class="section-label">PROJECTS</h2>

{#if library.error}
  <div class="home-error" role="alert">
    <div>{library.error}</div>
    <button class="soft-btn" onclick={scanLibrary}>Try again</button>
  </div>
{/if}

{#if library.projects.length}
  <div class="pgrid">
    {#each library.projects as project (project.id)}
      <ProjectCard
        {project}
        confirming={confirmingId === project.id}
        pages={pageCountOf(project)}
        onOpen={(p) => goProject(p.id)}
        onAskDelete={(p) => (confirmingId = p.id)}
        onCancelDelete={() => (confirmingId = null)}
        {onDelete}
      />
    {/each}
  </div>
{:else if library.loading}

  <div class="home-empty">Reading your library…</div>
{:else if !library.error}

  <!-- The two sentences differ in more than a noun, so they are written out
       per usage (plan 2.3), with the way to start right under them. -->
  <div class="home-empty">
    <div>No projects yet.</div>
    <div>{isComics() ? 'Start a chapter and the pages you pick are copied into your library.' : 'Add images and they are copied into your library.'}</div>
    <button class="accent-btn empty-start" onclick={onNewChapter}>{word('newChapter')}</button>
  </div>
{/if}

<style>
  /* The empty library's one way forward sits under its two lines. */
  .empty-start { margin-top: 14px; }
</style>
