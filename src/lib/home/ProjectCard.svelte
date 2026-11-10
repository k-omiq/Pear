<script>
  import { convertFileSrc } from '@tauri-apps/api/core';
  import { relativeTime, plural } from '../format.js';
  import { joinPath } from '../paths.js';
  import RowMenu from './RowMenu.svelte';
  import { word } from '../words.js';

  // One series on the home screen: its cover opens it, and the "…" beside its
  // name holds the rest. Deleting asks first, on the card itself.
  let { project, confirming = false, pages = 0, onOpen, onAskDelete, onCancelDelete, onDelete } = $props();

  const thumb = $derived(convertFileSrc(joinPath(project.dir, 'thumb.png')));
  const chapterLine = $derived(plural(project.chapters.length, word('chapter').toLowerCase()));
  // Format chapter count and relative timestamp.
  const touched = $derived(relativeTime(project.updatedAt));

  let menu = $state(null);
  const items = [
    { id: 'open', label: 'Open' },
    { separator: true },
    { id: 'delete', label: 'Delete project…', danger: true },
  ];
  function onpick(id) {
    if (id === 'open') onOpen(project);
    else if (id === 'delete') onAskDelete(project);
  }
  function oncontextmenu(e) {
    if (project.unreadable) return;
    e.preventDefault();
    menu?.openAt(e.clientX, e.clientY);
  }
</script>

<div class="pcard" class:unreadable={project.unreadable} {oncontextmenu}>
  <button class="pcard-cover" onclick={() => onOpen(project)} disabled={project.unreadable} aria-label="Open {project.name}">
    {#if !project.unreadable}
      <img src={thumb} alt="" onerror={(e) => (e.currentTarget.style.visibility = 'hidden')} />
    {/if}
  </button>
  <div class="pcard-meta">
    <div class="pcard-text">
      <div class="pcard-name" title={project.name}>{project.name}</div>
      {#if project.duplicate}
        <div class="pcard-sub warn">Same project as another folder - rename or remove {project.slug}</div>
      {:else if project.unreadable}
        <div class="pcard-sub warn">Unreadable - check this folder</div>
      {:else}
        <div class="pcard-sub">{chapterLine} · {plural(pages, 'page')}</div>
        {#if touched}<div class="pcard-sub small">{touched}</div>{/if}
      {/if}
    </div>
    {#if project.unreadable}
      <button class="pcard-del" onclick={() => onAskDelete(project)} title="Delete project">Delete</button>
    {:else}
      <RowMenu bind:this={menu} label="{project.name} actions" {items} {onpick} />
    {/if}
  </div>
  {#if confirming}
    <div class="pcard-confirm" role="alert">
      <div>Move {project.name} and all {plural(pages, 'page')} to the trash?</div>
      <div class="pcard-confirm-actions">
        <button class="soft-btn" onclick={onCancelDelete}>Cancel</button>
        <button class="soft-btn danger" onclick={() => onDelete(project)}>Move to trash</button>
      </div>
    </div>
  {/if}
</div>
