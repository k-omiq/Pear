<script>
  // A translate chapter that has never been read is read on its own, the first
  // time it is opened, because a translate chapter with no lines has nothing to
  // type against. Nothing drawn: it lives in the editor shell (EditorRoot) and
  // not in the typing pane, so it runs wherever the layout puts the queue -
  // docked, floating, or a floating window the user hid.
  //
  // A chapter that has lines from anywhere (a JSON import, a previous run) is
  // never re-read behind the user's back - that is the Detect menu's job.
  import { untrack } from 'svelte';
  import { app } from '../store.svelte.js';
  import { sidecarReady, detectAllPages } from '../sidecar.js';
  import { isComics } from '../prefs.svelte.js';

  const engineReady = $derived(sidecarReady());
  const neverRead = $derived(app.pages.length > 0 && !app.pages.some((q) => q.detect || q.lines?.length));

  // Once per chapter opened.
  const tried = new Set();
  $effect(() => {
    const ref = app.chapterRef;
    const ready = engineReady;
    const fresh = neverRead;
    if (!ref || !app.loaded || app.chapterMode !== 'translate') return;
    const key = `${ref.projectId}/${ref.chapterId}`;
    untrack(() => {
      if (tried.has(key) || app.detecting) return;
      if (!fresh) return void tried.add(key);
      // General use has no detection: an old translate chapter is typed by hand.
      if (!ready || !isComics()) return;
      tried.add(key);
      detectAllPages();
    });
  });
</script>
