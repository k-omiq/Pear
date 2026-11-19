<script>
  // The Font Library: every family the app can set text in, the user's own,
  // the built-ins and the ones installed on this computer, each with the one
  // switch that says whether the font menus offer it. The user's families are
  // also where files go in (a file, a pile, a folder) and where the sorting
  // gets fixed by hand: every face is a chip that drags to another slot or
  // another family, and every family drags onto another to merge.
  //
  // Its own window in the desktop app (font-window.svelte.js); in a browser it
  // fills the app's window, with a back button (`embedded`).
  import { SvelteSet } from 'svelte/reactivity';
  import { app, toast } from './store.svelte.js';
  import {
    addFontFile,
    addFontFaces,
    removeUserFont,
    removeFontFace,
    moveFontFace,
    renameUserFont,
    parseFontFilename,
    FACE_SLOTS,
    SLOT_LABEL,
    isBold,
    isItalic,
    scanSystemFonts,
    fontsWritten,
  } from './fonts.js';
  import { isFamilyOn, setFamilyOn, setFamiliesOn, carryFamilySwitch } from './font-menu.js';
  import { itemsFromFiles, itemsFromDrop, pickFolderTauri, readItems, planImport, needsConfirm, planWrites, FONT_EXTENSIONS } from './font-import.js';
  import { prefs, setPref } from './prefs.svelte.js';
  import {
    createCategory,
    renameCategory,
    deleteCategory,
    moveCategory,
    addToCategory,
    removeFromCategory,
    inCategory,
    categoriesOf,
    carryFamily,
    copyFamily,
    dropFamily,
    MAX_CATEGORIES,
    familiesInView,
    countIn,
  } from './font-categories.js';
  import { readMarketCache } from './font-market.js';
  import { isTauri } from './importer.js';
  import FontImportSheet from './FontImportSheet.svelte';
  import FontMarket from './FontMarket.svelte';

  let { embedded = false, onclose = null } = $props();

  const TABS = [
    { id: 'user', label: 'Your fonts', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/></svg>' },
    { id: 'builtin', label: 'Built-in', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 15l3-7 3 7M10 13h4"/></svg>' },
    { id: 'system', label: 'On this computer', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>' },
    { id: 'market', label: 'Marketplace', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9l1.5-5h13L20 9"/><path d="M4 9h16v2a3 3 0 0 1-5.3 2A3 3 0 0 1 12 14a3 3 0 0 1-2.7-1A3 3 0 0 1 4 11z"/><path d="M5 14v6h14v-6"/></svg>' },
  ];
  let tab = $state('user');
  // What Your fonts shows: every family (null), one category (its id), or the
  // families in no category ('bare'). Marketplace has the same: every list
  // ('all') or one (its url).
  let view = $state(null);
  let marketPick = $state('all');
  let marketCache = $state(readMarketCache());
  let addNonce = $state(0);
  function openTab(id) {
    tab = id;
    if (id === 'user') view = null;
    if (id === 'market') marketPick = 'all';
  }

  // ---- categories (font-categories.js) ----
  const cats = $derived(prefs.fontCategories);
  const viewCat = $derived(view && view !== 'bare' ? (cats.find((c) => c.id === view) ?? null) : null);
  // A category deleted in the other window closes its page here, and so does
  // "Not in a category" once there is no category left.
  $effect(() => {
    if (view && view !== 'bare' && !viewCat) view = null;
    else if (view === 'bare' && !cats.length) view = null;
  });
  // "Delete…" arms one category's page only: any move away disarms it.
  $effect(() => {
    view;
    tab;
    armedCatDelete = null;
  });
  function saveCats(list) {
    setPref('fontCategories', list);
    fontsWritten();
  }
  let naming = $state(null); // 'new' or a category id while its name is typed
  let nameValue = $state('');
  let pendingFamily = $state(null); // a family to put in the category being created
  function startNewCategory(family = null) {
    pendingFamily = family;
    naming = 'new';
    nameValue = '';
  }
  function startCategoryRename(c) {
    naming = c.id;
    nameValue = c.name;
  }
  function finishCategoryName(commit) {
    const which = naming;
    const name = nameValue.trim();
    const family = pendingFamily;
    naming = null;
    pendingFamily = null;
    if (!commit || !name || !which) return;
    if (which === 'new') {
      if (cats.length >= MAX_CATEGORIES) return toast(`You can have up to ${MAX_CATEGORIES} categories`);
      const made = createCategory(cats, name, family ? [family] : []);
      saveCats(made.list);
      if (!family) {
        tab = 'user';
        view = made.id;
      } else toast(`Added ${family} to "${made.list.at(-1).name}"`);
    } else saveCats(renameCategory(cats, which, name));
  }
  let armedCatDelete = $state(null); // the id of the category whose Delete is armed
  function removeCategory(id) {
    armedCatDelete = null;
    saveCats(deleteCategory(cats, id));
    if (view === id) view = null;
  }
  function toggleIn(id, family) {
    saveCats(inCategory(cats, id, family) ? removeFromCategory(cats, id, family) : addToCategory(cats, id, family));
  }
  async function dropOnCategory(e, id) {
    e.preventDefault();
    e.stopPropagation();
    filesOver = 0;
    const d = drag;
    endDrag();
    const c = cats.find((x) => x.id === id);
    if (!c) return;
    // Font files from outside: imported, into this category.
    if (!d) {
      if (!hasFiles(e)) return;
      tab = 'user';
      view = id;
      return startImport(await itemsFromDrop(e.dataTransfer));
    }
    if (d.type !== 'family') return;
    if (c.families.includes(d.family)) return toast(`${d.family} is already in "${c.name}"`);
    saveCats(addToCategory(cats, id, d.family));
    toast(`Added ${d.family} to "${c.name}"`);
  }

  // The per-family "Categories" menu: tick the ones it is in.
  let catMenu = $state(null); // { family, x, y, from }
  function openCatMenu(e, family) {
    const r = e.currentTarget.getBoundingClientRect();
    const below = window.innerHeight - r.bottom > 280;
    catMenu = { family, x: Math.max(8, Math.min(r.right - 240, window.innerWidth - 248)), y: below ? r.bottom + 4 : Math.max(8, r.top - 284), from: e.currentTarget };
  }
  // The menu takes the focus when it opens, and Tab stays inside it.
  function focusFirst(node) {
    (node.querySelector('input, button') ?? node).focus();
  }
  function trapTab(e) {
    if (e.key !== 'Tab') return;
    const els = [...e.currentTarget.querySelectorAll('input, button')];
    if (!els.length) return;
    const i = els.indexOf(document.activeElement);
    const next = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : i === els.length - 1 ? 0 : i + 1;
    e.preventDefault();
    els[next].focus();
  }
  function closeCatMenu() {
    const el = catMenu?.from;
    catMenu = null;
    el?.focus?.();
  }

  const faceStyle = (css, slot) =>
    `font-family:${css};font-weight:${isBold(slot) ? 700 : 400};font-style:${isItalic(slot) ? 'italic' : 'normal'}`;
  const faceCount = (f) => FACE_SLOTS.filter((s) => f.faces?.[s]).length;

  // ---- previews, only for what is on screen ----
  // A family's sample is drawn in its own face once its row has been in view;
  // until then in the UI face, so opening the library does not ask the
  // browser for every font it knows.
  const seen = new SvelteSet();
  let observer = null;
  function visible(node, name) {
    observer ??=
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(
            (entries) => {
              for (const e of entries) {
                if (!e.isIntersecting) continue;
                seen.add(e.target.dataset.preview);
                observer.unobserve(e.target);
              }
            },
            { rootMargin: '200px' },
          )
        : null;
    node.dataset.preview = name;
    if (!observer) seen.add(name);
    else observer.observe(node);
    return {
      update(next) {
        node.dataset.preview = next;
      },
      destroy() {
        observer?.unobserve(node);
      },
    };
  }

  // ---- the filter every list has ----
  let query = $state({ user: '', builtin: '', system: '' });
  let show = $state({ user: 'all', builtin: 'all', system: 'all' });
  function filtered(kind, list) {
    const q = query[kind].trim().toLowerCase();
    const s = show[kind];
    return list.filter((f) => (!q || f.name.toLowerCase().includes(q)) && (s === 'all' || (s === 'on') === isFamilyOn(kind, f.name)));
  }
  const userList = $derived(filtered('user', familiesInView(app.fonts.user, cats, view)));
  const userTotal = $derived(countIn(app.fonts.user, cats, view));
  const builtinList = $derived(filtered('builtin', app.fonts.builtin));
  const systemList = $derived(filtered('system', app.fonts.system));
  const onCount = (kind, list) => list.filter((f) => isFamilyOn(kind, f.name)).length;

  // ---- adding: files, folders, drops ----
  let fileInput = $state();
  let folderInput = $state();
  let slotInput = $state();
  let slotTarget = null;
  let reading = $state(null); // { done, total } while names are read
  let sheet = $state(null); // { items, unreadable } for the confirm step

  const importCtx = () => ({ existing: app.fonts.user, builtins: app.fonts.builtin.map((f) => f.name) });

  let invoker = null;
  const toSfnt = isTauri()
    ? async (bytes) => {
        invoker ??= (await import('@tauri-apps/api/core')).invoke;
        return invoker('font_to_sfnt', bytes);
      }
    : null;

  // The one way a pile goes in: read every file's names, sort them, and either
  // save at once (one clean family) or ask first (`needsConfirm`).
  async function startImport(items) {
    if (!items?.length) {
      toast(`No font files there (${FONT_EXTENSIONS.map((e) => '.' + e).join(' ')})`);
      return;
    }
    reading = { done: 0, total: items.length };
    try {
      await readItems(items, { toSfnt, onProgress: (done, total) => (reading = { done, total }) });
    } finally {
      reading = null;
    }
    const unreadable = items.filter((i) => i.unreadable);
    const good = items.filter((i) => !i.unreadable);
    if (!good.length) {
      toast(unreadable.length === 1 ? `"${unreadable[0].name}" is ${unreadable[0].unreadable}` : `None of the ${unreadable.length} files could be read as fonts`);
      return;
    }
    const plan = planImport(good, 'names', importCtx());
    if (!needsConfirm(plan) && !unreadable.length) return commitPlan(plan, good);
    sheet = { items: good, unreadable };
  }

  let saving = $state(null);
  async function commitPlan(plan, items) {
    sheet = null;
    const byId = new Map(items.map((i) => [i.id, i]));
    const faces = planWrites(plan).map((w) => {
      const it = byId.get(w.id);
      return { family: w.family, slot: w.slot, file: it.name, read: it.read };
    });
    if (!faces.length) return;
    saving = { done: 0, total: faces.length };
    const into = viewCat?.id ?? null;
    try {
      await addFontFaces(faces, { onProgress: (done, total) => (saving = { done, total }) });
    } finally {
      saving = null;
    }
    // Added while a category is open: the new families go in it.
    if (into) {
      let list = prefs.fontCategories;
      for (const f of new Set(faces.map((x) => x.family))) if (app.fonts.user.some((u) => u.name === f)) list = addToCategory(list, into, f);
      saveCats(list);
    }
  }

  function onPickFiles(e) {
    const items = itemsFromFiles(e.currentTarget.files);
    e.currentTarget.value = '';
    startImport(items);
  }
  async function addFolder() {
    if (!isTauri()) return folderInput?.click();
    let picked = null;
    try {
      picked = await pickFolderTauri();
    } catch (e) {
      toast(`Could not read that folder - ${e?.message || e}`);
      return;
    }
    if (picked) startImport(picked.items);
  }
  function pickForSlot(family, slot) {
    slotTarget = { family, slot };
    slotInput?.click();
  }
  async function onSlotPick(e) {
    const file = e.currentTarget.files?.[0];
    const target = slotTarget;
    slotTarget = null;
    e.currentTarget.value = '';
    if (file && target) await addFontFile(file, target);
  }

  // ---- dragging ----
  // `drag` is what the library's own drag carries (a face or a family); a drop
  // of files from outside carries `Files` and is an import. `over` is the
  // target under the pointer, for its highlight.
  let drag = $state(null);
  let over = $state(null);
  let filesOver = $state(0);
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  function startFaceDrag(e, family, slot) {
    drag = { type: 'face', family, slot };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${family} · ${SLOT_LABEL[slot]}`);
  }
  function startFamilyDrag(e, family) {
    drag = { type: 'family', family };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', family);
  }
  function endDrag() {
    drag = null;
    over = null;
  }
  function overTarget(e, key) {
    if (!drag && !hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = drag ? 'move' : 'copy';
    over = key;
  }

  async function dropOnSlot(e, family, slot) {
    e.preventDefault();
    e.stopPropagation();
    filesOver = 0;
    const d = drag;
    endDrag();
    if (d?.type === 'face') return moveFace({ family: d.family, slot: d.slot }, { family, slot });
    if (d?.type === 'family') return mergeFamily(d.family, family);
    if (!hasFiles(e)) return;
    const files = [...(e.dataTransfer.files || [])];
    // One file onto a slot is that slot's face, whatever its name says.
    if (files.length === 1 && !e.dataTransfer.items?.[0]?.webkitGetAsEntry?.()?.isDirectory) return addFontFile(files[0], { family, slot });
    startImport(await itemsFromDrop(e.dataTransfer));
  }
  async function dropOnFamily(e, family) {
    e.preventDefault();
    e.stopPropagation();
    filesOver = 0;
    const d = drag;
    endDrag();
    if (d?.type === 'family') return mergeFamily(d.family, family);
    if (d?.type === 'face') {
      if (d.family === family) return;
      const g = app.fonts.user.find((f) => f.name === family);
      const slot = !g?.faces?.[d.slot] ? d.slot : FACE_SLOTS.find((s) => !g.faces?.[s]);
      if (!slot) return toast(`"${family}" has all four faces - drop onto a slot to swap`);
      return moveFace({ family: d.family, slot: d.slot }, { family, slot });
    }
    if (hasFiles(e)) startImport(await itemsFromDrop(e.dataTransfer));
  }
  async function dropOnScreen(e) {
    e.preventDefault();
    filesOver = 0;
    const d = drag;
    endDrag();
    if (d || !hasFiles(e)) return;
    // Dropped on another tab: the fonts go to all of Your fonts, not into a
    // category page left open behind it.
    if (tab !== 'user') {
      tab = 'user';
      view = null;
    }
    startImport(await itemsFromDrop(e.dataTransfer));
  }

  // A face moved to another family, by drag, by "Move to…" or to a family of
  // its own. A family it empties is in effect renamed or merged, so its
  // categories go with the face; a new family split off a family that stays
  // joins the same categories, so it does not vanish from the page it was
  // made on.
  async function moveFace(from, to) {
    const existed = app.fonts.user.some((f) => f.name === to.family);
    await moveFontFace(from, to);
    if (from.family === to.family) return;
    const fromLeft = app.fonts.user.some((f) => f.name === from.family);
    const toNow = app.fonts.user.some((f) => f.name === to.family);
    if (!toNow) return;
    if (!fromLeft) saveCats(carryFamily(prefs.fontCategories, from.family, to.family));
    else if (!existed) saveCats(copyFamily(prefs.fontCategories, from.family, to.family));
  }
  async function removeFace(family, slot) {
    await removeFontFace(family, slot);
    if (!app.fonts.user.some((f) => f.name === family)) saveCats(dropFamily(prefs.fontCategories, family));
  }

  // A face of its own: named after its file, made unique.
  function ownFamilyName(family, slot) {
    const file = app.fonts.user.find((f) => f.name === family)?.faces?.[slot]?.file || family;
    const base = parseFontFilename(file).family || family;
    const taken = (n) => app.fonts.user.some((f) => f.name === n) || app.fonts.builtin.some((f) => f.name === n);
    let name = base === family ? `${base} 2` : base;
    for (let i = 3; taken(name); i++) name = `${base} ${i}`;
    return name;
  }
  async function moveToOwn(family, slot) {
    await moveFace({ family, slot }, { family: ownFamilyName(family, slot), slot: 'regular' });
  }
  async function dropOnNew(e) {
    e.preventDefault();
    e.stopPropagation();
    const d = drag;
    endDrag();
    if (d?.type === 'face') await moveToOwn(d.family, d.slot);
  }

  // After a rename or merge: the old family's categories move to the new name,
  // or, when the old family kept faces the other already had, both are in them.
  const keepOrCarry = (from, to) =>
    app.fonts.user.some((f) => f.name === from) ? copyFamily(prefs.fontCategories, from, to) : carryFamily(prefs.fontCategories, from, to);
  async function mergeFamily(from, into) {
    if (from === into) return;
    if (await renameUserFont(from, into)) saveCats(keepOrCarry(from, into));
  }
  async function removeFamily(name) {
    await removeUserFont(name);
    saveCats(dropFamily(prefs.fontCategories, name));
  }

  // ---- renaming and removing ----
  let renaming = $state(null);
  let renameValue = $state('');
  function startRename(name) {
    renaming = name;
    renameValue = name;
  }
  async function finishRename(commit) {
    const from = renaming;
    renaming = null;
    const to = renameValue.trim();
    if (!commit || !from || !to || to === from) return;
    const fresh = !app.fonts.user.some((f) => f.name === to);
    if (await renameUserFont(from, to)) {
      if (fresh) carryFamilySwitch(from, to);
      saveCats(keepOrCarry(from, to));
    }
  }
  function focusOnMount(node) {
    node.focus();
    node.select?.();
  }
  let armedRemove = $state(null);

  // ---- "Move to…": the keyboard way to do what the drag does ----
  let moveMenu = $state(null); // { family, slot, x, y, q, from: element }
  function openMove(e, family, slot) {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(r.left, window.innerWidth - 300);
    const below = window.innerHeight - r.bottom > 320;
    moveMenu = { family, slot, x: Math.max(8, x), y: below ? r.bottom + 4 : Math.max(8, r.top - 324), q: '', from: e.currentTarget };
  }
  function closeMove() {
    const el = moveMenu?.from;
    moveMenu = null;
    el?.focus?.();
  }
  const moveTargets = $derived.by(() => {
    if (!moveMenu) return [];
    const q = moveMenu.q.trim().toLowerCase();
    return app.fonts.user.filter((f) => !q || f.name.toLowerCase().includes(q)).slice(0, 60);
  });
  async function moveTo(family, slot) {
    const m = moveMenu;
    closeMove();
    if (m) await moveFace({ family: m.family, slot: m.slot }, { family, slot });
  }

  // ---- installed fonts ----
  let rescanning = $state(false);
  async function rescan() {
    rescanning = true;
    try {
      await scanSystemFonts();
    } finally {
      rescanning = false;
    }
  }
  // A virtual list: a machine has a thousand of these and only a screenful is
  // made. While it scrolls, names are set in the UI face; once it stops, in
  // their own - so a flick through the list does not load every font in it.
  const ROW_H = 44;
  let sysTop = $state(0);
  let sysView = $state(560);
  let sysScrolling = $state(false);
  let scrollTimer = null;
  function onSysScroll(e) {
    sysTop = e.currentTarget.scrollTop;
    sysScrolling = true;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => (sysScrolling = false), 140);
  }
  const sysFrom = $derived(Math.max(0, Math.floor(sysTop / ROW_H) - 6));
  const sysTo = $derived(Math.min(systemList.length, Math.ceil((sysTop + sysView) / ROW_H) + 6));

  function onScreenKey(e) {
    if (e.key !== 'Escape') return;
    if (moveMenu) {
      e.stopPropagation();
      closeMove();
      return;
    }
    if (catMenu) {
      e.stopPropagation();
      closeCatMenu();
      return;
    }
    if (renaming || naming) return;
    if (sheet) return;
    if (embedded && onclose) {
      e.stopPropagation();
      onclose();
    }
  }
</script>

{#snippet toggle(on, label, set)}
  <div
    class="switch"
    class:on
    role="switch"
    aria-checked={on}
    aria-label={label}
    tabindex="0"
    onclick={() => set(!on)}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        set(!on);
      }
    }}
  ><span class="knob"></span></div>
{/snippet}

{#snippet nameField(label)}
  <input
    class="fl-rename fl-sub-name"
    aria-label={label}
    placeholder="Category name"
    maxlength="60"
    bind:value={nameValue}
    use:focusOnMount
    onkeydown={(e) => {
      if (e.key === 'Enter') finishCategoryName(true);
      if (e.key === 'Escape') {
        e.stopPropagation();
        finishCategoryName(false);
      }
    }}
    onblur={() => finishCategoryName(true)}
  />
{/snippet}

{#snippet filterBar(kind, placeholder, list, total)}
  <div class="fl-bar">
    <input class="fl-search" type="search" {placeholder} aria-label={placeholder} bind:value={query[kind]} />
    <div class="seg" role="group" aria-label="Show">
      {#each [['all', 'All'], ['on', 'On'], ['off', 'Off']] as [v, label] (v)}
        <button class:on={show[kind] === v} aria-pressed={show[kind] === v} onclick={() => (show[kind] = v)}>{label}</button>
      {/each}
    </div>
    {#if list.length && list.length < total}
      <button class="btn tiny" onclick={() => setFamiliesOn(kind, list.map((f) => f.name), true)}>Turn {list.length} on</button>
      <button class="btn tiny" onclick={() => setFamiliesOn(kind, list.map((f) => f.name), false)}>Turn {list.length} off</button>
    {/if}
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="settings-screen font-library"
  class:files-over={filesOver > 0 && !drag}
  role="dialog"
  aria-label="Font Library"
  tabindex="-1"
  onkeydown={onScreenKey}
  ondragenter={(e) => hasFiles(e) && filesOver++}
  ondragleave={(e) => hasFiles(e) && (filesOver = Math.max(0, filesOver - 1))}
  ondragover={(e) => {
    if (drag || hasFiles(e)) e.preventDefault();
  }}
  ondrop={dropOnScreen}
>
  <nav class="set-side" aria-label="Font Library sections">
    <div class="set-side-head">
      {#if embedded}
        <button class="set-back" aria-label="Close the Font Library" title="Close (Esc)" onclick={() => onclose?.()}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
      {/if}
      <h1>Font Library</h1>
    </div>
    <div class="set-tabs">
      {#each TABS as t (t.id)}
        {@const top = tab === t.id && ((t.id !== 'user' && t.id !== 'market') || (t.id === 'user' && !view) || (t.id === 'market' && marketPick === 'all'))}
        <button class="set-tab" class:on={top} aria-current={top ? 'page' : undefined} onclick={() => openTab(t.id)}>
          {@html t.icon}
          <span>{t.label}</span>
          <span class="fl-count">
            {#if t.id === 'user'}{app.fonts.user.length}{:else if t.id === 'builtin'}{onCount('builtin', app.fonts.builtin)}{:else if t.id === 'system'}{prefs.shownSystemFonts.length ? onCount('system', app.fonts.system) : ''}{:else}{prefs.fontMarketplaces.length || ''}{/if}
          </span>
        </button>
        {#if t.id === 'user'}
          <div class="fl-subs" role="group" aria-label="Categories">
            {#each cats as c (c.id)}
                <button
                  class="set-tab fl-sub"
                  class:on={tab === 'user' && view === c.id}
                  class:target={over === `cat:${c.id}`}
                  aria-current={tab === 'user' && view === c.id ? 'page' : undefined}
                  title="{c.name} - drop a family or font files here to add them"
                  onclick={() => { tab = 'user'; view = c.id; }}
                  ondblclick={() => { tab = 'user'; view = c.id; startCategoryRename(c); }}
                  ondragover={(e) => (drag?.type === 'family' || (!drag && hasFiles(e))) && overTarget(e, `cat:${c.id}`)}
                  ondragleave={() => over === `cat:${c.id}` && (over = null)}
                  ondrop={(e) => dropOnCategory(e, c.id)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                  <span>{c.name}</span>
                  <span class="fl-count">{countIn(app.fonts.user, cats, c.id)}</span>
                </button>
            {/each}
            {#if cats.length}
              <button class="set-tab fl-sub" class:on={tab === 'user' && view === 'bare'} aria-current={tab === 'user' && view === 'bare' ? 'page' : undefined} onclick={() => { tab = 'user'; view = 'bare'; }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7" stroke-dasharray="3 3" /></svg>
                <span>Not in a category</span>
                <span class="fl-count">{countIn(app.fonts.user, cats, 'bare')}</span>
              </button>
            {/if}
            {#if naming === 'new' && !pendingFamily}
              {@render nameField('Name of the new category')}
            {:else if cats.length < MAX_CATEGORIES}
              <button class="set-tab fl-sub fl-add-sub" onclick={() => startNewCategory()}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 6v12M6 12h12" /></svg>
                <span>New category</span>
              </button>
            {/if}
          </div>
        {:else if t.id === 'market'}
          <div class="fl-subs" role="group" aria-label="Marketplaces">
            {#each prefs.fontMarketplaces as m (m.url)}
              {@const c = marketCache[m.url]}
              <button class="set-tab fl-sub" class:on={tab === 'market' && marketPick === m.url} aria-current={tab === 'market' && marketPick === m.url ? 'page' : undefined} title={m.url} onclick={() => { tab = 'market'; marketPick = m.url; }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16" /></svg>
                <span>{m.name || c?.manifest?.name || m.url}</span>
                <span class="fl-count">{c?.manifest?.fonts?.length ?? ''}</span>
              </button>
            {/each}
            <button class="set-tab fl-sub fl-add-sub" onclick={() => { tab = 'market'; marketPick = 'all'; addNonce++; }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 6v12M6 12h12" /></svg>
              <span>Add marketplace</span>
            </button>
          </div>
        {/if}
      {/each}
    </div>
  </nav>

  <main class="set-panel">
    <div class="fl-column">
      {#if tab === 'user'}
        {#if viewCat}
          <header class="set-page-head fl-cat-head">
            <div class="fl-cat-title">
              {#if naming === viewCat.id}
                {@render nameField(`New name for ${viewCat.name}`)}
              {:else}
                <h2>{viewCat.name}</h2>
              {/if}
              <div class="fl-cat-acts">
                <button class="btn tiny" onclick={() => startCategoryRename(viewCat)}>Rename</button>
                <button class="fl-icon" aria-label="Move {viewCat.name} up" title="Move up" disabled={cats[0]?.id === viewCat.id} onclick={() => saveCats(moveCategory(cats, viewCat.id, -1))}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
                </button>
                <button class="fl-icon" aria-label="Move {viewCat.name} down" title="Move down" disabled={cats.at(-1)?.id === viewCat.id} onclick={() => saveCats(moveCategory(cats, viewCat.id, 1))}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {#if armedCatDelete === viewCat.id}
                  <button class="btn tiny" onclick={() => (armedCatDelete = null)}>Cancel</button>
                  <button class="btn tiny danger" onclick={() => removeCategory(viewCat.id)}>Delete category</button>
                {:else}
                  <button class="btn tiny" onclick={() => (armedCatDelete = viewCat.id)}>Delete…</button>
                {/if}
              </div>
            </div>
            <p class="set-lead">{armedCatDelete === viewCat.id ? 'Deleting the category keeps every font in it. Only the group goes.' : 'A group of your fonts. A family can be in several categories. Fonts you add while this page is open go into it.'}</p>
          </header>
        {:else if view === 'bare'}
          <header class="set-page-head">
            <h2>Not in a category</h2>
            <p class="set-lead">Your families that are in no category yet. Drag one onto a category in the sidebar, or use its folder button.</p>
          </header>
        {:else}
          <header class="set-page-head">
            <h2>Your fonts</h2>
            <p class="set-lead">Fonts you added. Each family holds up to four real faces; a missing one is drawn faux. Drag a face to another slot or family to fix how it was sorted, or a family onto another to merge them. Drag a family onto a category in the sidebar to group it.</p>
          </header>
        {/if}

        <input bind:this={fileInput} type="file" accept=".ttf,.otf,.ttc,.woff,.woff2" multiple hidden onchange={onPickFiles} />
        <input bind:this={folderInput} type="file" webkitdirectory multiple hidden onchange={onPickFiles} />
        <input bind:this={slotInput} type="file" accept=".ttf,.otf,.ttc,.woff,.woff2" hidden onchange={onSlotPick} />

        <div class="fl-add">
          <button class="btn btn-accent" onclick={() => fileInput?.click()}>Add files…</button>
          <button class="btn" onclick={addFolder}>Add folder…</button>
          <span class="fl-add-note">
            {#if reading}Reading {reading.done} of {reading.total}…{:else if saving}Saving {saving.done} of {saving.total}…{:else}or drop files and folders anywhere here{/if}
          </span>
        </div>

        {@render filterBar('user', viewCat ? `Search ${viewCat.name}` : 'Search your fonts', userList, userTotal)}

        {#if !app.fonts.user.length}
          <p class="fl-empty">No fonts yet. Add a file or a whole folder; it stays in the library across launches.</p>
        {:else if viewCat && !userTotal}
          <p class="fl-empty">No fonts in this category yet. Drag a family onto it in the sidebar, use a family’s folder button, or add files while this page is open.</p>
        {:else if view === 'bare' && !userTotal}
          <p class="fl-empty">Every family is in a category.</p>
        {:else if !userList.length}
          <p class="fl-empty">Nothing matches.</p>
        {/if}

        <div class="fl-families">
          {#each userList as f (f.name)}
            {@const on = isFamilyOn('user', f.name)}
            {@const inCats = categoriesOf(cats, f.name)}
            <section
              class="fl-fam"
              class:off={!on}
              class:target={over === `fam:${f.name}`}
              class:dragging={drag?.type === 'family' && drag.family === f.name}
              aria-label={f.name}
              ondragover={(e) => overTarget(e, `fam:${f.name}`)}
              ondragleave={() => over === `fam:${f.name}` && (over = null)}
              ondrop={(e) => dropOnFamily(e, f.name)}
            >
              <div class="fl-fam-head">
                <span
                  class="fl-grip"
                  draggable="true"
                  role="button"
                  tabindex="-1"
                  aria-label="Drag {f.name} onto another family to merge"
                  title="Drag onto another family to merge"
                  ondragstart={(e) => startFamilyDrag(e, f.name)}
                  ondragend={endDrag}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" /><circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" /><circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" /></svg>
                </span>
                {#if renaming === f.name}
                  <input
                    class="fl-rename"
                    aria-label="New name for {f.name}"
                    bind:value={renameValue}
                    use:focusOnMount
                    onkeydown={(e) => {
                      if (e.key === 'Enter') finishRename(true);
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        finishRename(false);
                      }
                    }}
                    onblur={() => finishRename(true)}
                  />
                {:else}
                  <button class="fl-name" title="Rename" ondblclick={() => startRename(f.name)} onclick={() => startRename(f.name)}>{f.name}</button>
                {/if}
                <span class="fl-meta">{faceCount(f)} of 4 faces{on ? '' : ' · off'}{#if inCats.length}<span class="fl-in" title={inCats.map((c) => c.name).join(', ')}>{' · '}{inCats.map((c) => c.name).join(', ')}</span>{/if}</span>
                <button class="fl-icon" class:has={inCats.length} aria-label="Categories of {f.name}" title="Categories" aria-haspopup="dialog" onclick={(e) => openCatMenu(e, f.name)}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                </button>
                {#if armedRemove === f.name}
                  <button class="btn tiny" onclick={() => (armedRemove = null)}>Cancel</button>
                  <button class="btn tiny danger" onclick={() => { armedRemove = null; removeFamily(f.name); }}>Remove family</button>
                {:else}
                  <button class="fl-icon" aria-label="Remove {f.name}" title="Remove the family" onclick={() => (armedRemove = f.name)}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                {/if}
                {@render toggle(on, `Offer ${f.name} in the font menus`, (v) => setFamilyOn('user', f.name, v))}
              </div>
              <div class="fl-slots" use:visible={f.name}>
                {#each FACE_SLOTS as slot (slot)}
                  {@const face = f.faces?.[slot]}
                  <div
                    class="fl-slot"
                    class:empty={!face}
                    class:target={over === `slot:${f.name}::${slot}`}
                    ondragover={(e) => overTarget(e, `slot:${f.name}::${slot}`)}
                    ondragleave={() => over === `slot:${f.name}::${slot}` && (over = null)}
                    ondrop={(e) => dropOnSlot(e, f.name, slot)}
                    role="group"
                    aria-label="{SLOT_LABEL[slot]} of {f.name}"
                  >
                    <span class="fl-slot-label">{SLOT_LABEL[slot]}</span>
                    {#if face}
                      <div
                        class="fl-chip"
                        class:dragging={drag?.type === 'face' && drag.family === f.name && drag.slot === slot}
                        draggable="true"
                        role="listitem"
                        ondragstart={(e) => startFaceDrag(e, f.name, slot)}
                        ondragend={endDrag}
                        title="Drag to another slot or family"
                      >
                        <span class="fl-sample" style={seen.has(f.name) ? faceStyle(f.css, slot) : ''}>Kaboom! 123</span>
                        <span class="fl-file" title={face.file || ''}>{face.file || 'loaded'}</span>
                        <button class="fl-icon" aria-label="Move the {SLOT_LABEL[slot]} face of {f.name} to…" title="Move to…" onclick={(e) => openMove(e, f.name, slot)}>
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" /></svg>
                        </button>
                        <button class="fl-icon" aria-label="Remove the {SLOT_LABEL[slot]} face of {f.name}" title="Remove this face" onclick={() => removeFace(f.name, slot)}>
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
                        </button>
                      </div>
                    {:else}
                      <span class="fl-faux">Empty - drawn faux</span>
                      <button class="fl-icon" aria-label="Add a file as the {SLOT_LABEL[slot]} of {f.name}" title="Add a file for this face" onclick={() => pickForSlot(f.name, slot)}>
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                      </button>
                    {/if}
                  </div>
                {/each}
              </div>
            </section>
          {/each}
        </div>

        {#if drag?.type === 'face'}
          <div
            class="fl-newfam"
            class:target={over === 'new'}
            role="region"
            aria-label="New family"
            ondragover={(e) => overTarget(e, 'new')}
            ondragleave={() => over === 'new' && (over = null)}
            ondrop={dropOnNew}
          >Drop here to give this face a family of its own</div>
        {/if}
      {:else if tab === 'builtin'}
        <header class="set-page-head">
          <h2>Built-in</h2>
          <p class="set-lead">Web fonts the app offers out of the box. Turning one off takes it out of the font menus; boxes already set in it keep it.</p>
        </header>
        {@render filterBar('builtin', 'Search built-in fonts', builtinList, app.fonts.builtin.length)}
        <div class="fl-rows">
          {#each builtinList as f (f.name)}
            {@const on = isFamilyOn('builtin', f.name)}
            <div class="fl-row" class:off={!on} use:visible={f.name}>
              <span class="fl-row-name" style={seen.has(f.name) ? `font-family:${f.css}` : ''}>{f.name}</span>
              <span class="fl-meta">{faceCount(f)} of 4 faces</span>
              {@render toggle(on, `Offer ${f.name} in the font menus`, (v) => setFamilyOn('builtin', f.name, v))}
            </div>
          {:else}
            <p class="fl-empty">Nothing matches.</p>
          {/each}
        </div>
      {:else if tab === 'system'}
        <header class="set-page-head">
          <h2>On this computer</h2>
          <p class="set-lead">The fonts installed on this machine stay out of the menus until you turn them on, one family at a time. Turning one off again leaves the boxes set in it as they are.</p>
        </header>
        {#if !isTauri()}
          <p class="fl-empty">The fonts installed on this computer are read by the desktop app; a browser cannot see them.</p>
        {:else}
          <div class="fl-bar-wrap">
            {@render filterBar('system', 'Search installed fonts', systemList, app.fonts.system.length)}
            <button class="btn tiny" disabled={rescanning} onclick={rescan}>{rescanning ? 'Scanning…' : 'Rescan'}</button>
          </div>
          <p class="fl-sub">{app.fonts.system.length} families · {onCount('system', app.fonts.system)} on</p>
          {#if !app.fonts.system.length}
            <p class="fl-empty">{rescanning ? 'Reading the installed fonts…' : 'No installed fonts were found.'}</p>
          {:else}
            <div class="fl-vlist" bind:clientHeight={sysView} onscroll={onSysScroll}>
              <div class="fl-vlist-inner" style="height:{systemList.length * ROW_H}px">
                {#each systemList.slice(sysFrom, sysTo) as f, i (f.name)}
                  {@const on = isFamilyOn('system', f.name)}
                  <div class="fl-row abs" class:off={!on} style="top:{(sysFrom + i) * ROW_H}px">
                    <span class="fl-row-name" style={sysScrolling ? '' : `font-family:${f.css}`}>{f.name}</span>
                    <span class="fl-meta">{faceCount(f)} of 4 faces</span>
                    {@render toggle(on, `Offer ${f.name} in the font menus`, (v) => setFamilyOn('system', f.name, v))}
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        {/if}
      {:else}
        <FontMarket bind:pick={marketPick} bind:cache={marketCache} {addNonce} />
      {/if}
    </div>
  </main>

  {#if filesOver > 0 && !drag}
    <div class="fl-dropping" aria-hidden="true"><div>Drop fonts or folders to add them</div></div>
  {/if}

  {#if moveMenu}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="fl-menu-scrim" role="presentation" onclick={closeMove}></div>
    <div class="fl-menu" role="dialog" aria-label="Move to" style="left:{moveMenu.x}px;top:{moveMenu.y}px">
      <input class="fl-search" type="search" placeholder="Find a family" aria-label="Find a family" bind:value={moveMenu.q} use:focusOnMount />
      <button class="fl-menu-item own" onclick={() => { const m = moveMenu; closeMove(); moveToOwn(m.family, m.slot); }}>A family of its own</button>
      <div class="fl-menu-list">
        {#each moveTargets as t (t.name)}
          <div class="fl-menu-fam">{t.name}</div>
          <div class="fl-menu-slots">
            {#each FACE_SLOTS as s (s)}
              {@const here = t.name === moveMenu.family && s === moveMenu.slot}
              <button class="fl-menu-item" disabled={here} onclick={() => moveTo(t.name, s)} title={t.faces?.[s] && !here ? `Swaps with ${t.faces[s].file}` : ''}>
                {SLOT_LABEL[s]}{#if t.faces?.[s] && !here}<span class="fl-swap">swap</span>{/if}
              </button>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if catMenu}
    {@const fam = catMenu.family}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="fl-menu-scrim" role="presentation" onclick={closeCatMenu}></div>
    <div class="fl-menu fl-cat-menu" role="dialog" aria-modal="true" aria-label="Categories of {fam}" tabindex="-1" style="left:{catMenu.x}px;top:{catMenu.y}px" use:focusFirst onkeydown={trapTab}>
      <div class="fl-menu-fam">Categories of {fam}</div>
      <div class="fl-menu-list">
        {#each cats as c (c.id)}
          <label class="fl-menu-item fl-check">
            <input type="checkbox" checked={c.families.includes(fam)} onchange={() => toggleIn(c.id, fam)} />
            <span>{c.name}</span>
          </label>
        {:else}
          <p class="fl-menu-note">No categories yet.</p>
        {/each}
      </div>
      {#if naming === 'new' && pendingFamily === fam}
        {@render nameField('Name of the new category')}
      {:else}
        <button class="fl-menu-item own" onclick={() => startNewCategory(fam)}>New category with {fam}…</button>
      {/if}
    </div>
  {/if}

  {#if sheet}
    <FontImportSheet
      items={sheet.items}
      unreadable={sheet.unreadable}
      ctx={importCtx()}
      onconfirm={(plan) => commitPlan(plan, sheet.items)}
      oncancel={() => (sheet = null)}
    />
  {/if}
</div>

<style>
  .fl-column {
    max-width: 860px;
    margin: 0 auto;
    padding: 34px 32px 80px;
  }
  .fl-count {
    margin-left: auto;
    font-size: 11px;
    color: var(--t3);
    font-variant-numeric: tabular-nums;
  }
  .fl-add {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 22px;
  }
  .fl-add-note,
  .fl-sub {
    font-size: 11.5px;
    color: var(--t2);
  }
  .fl-add-note {
    margin-left: 6px;
  }
  .fl-sub {
    margin: 6px 0 8px;
  }
  .fl-bar-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .fl-bar-wrap > :global(.fl-bar) {
    flex: 1;
  }
  .fl-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 18px 0 10px;
    flex-wrap: wrap;
  }
  .fl-search {
    flex: 1 1 200px;
    min-width: 0;
    height: 28px;
    padding: 0 9px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font-size: 12px;
  }
  .fl-search:focus,
  .fl-rename:focus {
    outline: none;
    border-color: var(--accent);
  }
  .fl-empty {
    margin: 24px 0;
    font-size: 12px;
    color: var(--t2);
  }
  .btn.danger {
    color: var(--warn);
    border-color: var(--warn);
  }

  /* A family: a head row and its four slots, hairlines between. */
  .fl-families {
    display: flex;
    flex-direction: column;
  }
  .fl-fam {
    border-bottom: 1px solid var(--line);
    padding: 8px 0 10px;
    border-radius: 8px;
    transition: background 0.12s;
  }
  .fl-fam.target {
    background: var(--accent-soft);
    outline: 1.5px dashed var(--line2);
    outline-offset: -1px;
  }
  .fl-fam.dragging {
    opacity: 0.5;
  }
  .fl-fam.off .fl-slots {
    opacity: 0.55;
  }
  .fl-fam-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
  }
  .fl-grip {
    flex: none;
    width: 18px;
    height: 28px;
    display: grid;
    place-items: center;
    color: var(--t3);
    cursor: grab;
  }
  .fl-name {
    min-width: 0;
    padding: 2px 4px;
    margin-left: -4px;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: text;
  }
  .fl-name:hover {
    background: var(--accent-soft);
  }
  .fl-rename {
    flex: 0 1 320px;
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font-size: 13px;
  }
  .fl-meta {
    margin-right: auto;
    font-size: 11px;
    color: var(--t2);
    white-space: nowrap;
  }
  .fl-icon {
    flex: none;
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 6px;
    background: none;
    color: var(--t2);
    cursor: pointer;
  }
  .fl-icon:hover {
    background: var(--accent-soft);
    color: var(--text);
  }
  .fl-icon:focus-visible,
  .fl-name:focus-visible,
  .fl-menu-item:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .fl-slots {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    padding-left: 26px;
  }
  .fl-slot {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 40px;
    padding: 4px 6px 4px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
  }
  .fl-slot.empty {
    background: transparent;
    border-style: dashed;
  }
  .fl-slot.target {
    border-color: var(--accent);
    border-style: dashed;
    background: var(--accent-soft);
  }
  .fl-slot-label {
    flex: none;
    width: 66px;
    font-size: 11px;
    color: var(--t2);
  }
  .fl-chip {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: grab;
    border-radius: 6px;
  }
  .fl-chip.dragging {
    opacity: 0.4;
  }
  .fl-sample {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 18px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fl-file {
    flex: 0 1 120px;
    min-width: 0;
    font-size: 10.5px;
    color: var(--t3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: right;
  }
  .fl-faux {
    flex: 1;
    font-size: 11.5px;
    color: var(--t3);
  }
  .fl-newfam {
    margin-top: 12px;
    padding: 18px;
    border: 1.5px dashed var(--line2);
    border-radius: 9px;
    text-align: center;
    font-size: 12px;
    color: var(--t2);
  }
  .fl-newfam.target {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--text);
  }

  /* Plain rows: built-ins and installed fonts. */
  .fl-row {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 44px;
    border-bottom: 1px solid var(--line);
  }
  .fl-row.abs {
    position: absolute;
    left: 0;
    right: 8px;
  }
  .fl-row-name {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 16px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fl-row.off .fl-row-name {
    color: var(--t2);
  }
  .fl-row .fl-meta {
    margin-right: 0;
  }
  .fl-vlist {
    height: max(320px, calc(100vh - 290px));
    overflow-y: auto;
    overscroll-behavior: contain;
    border-top: 1px solid var(--line);
  }
  .fl-vlist-inner {
    position: relative;
  }

  .fl-dropping {
    position: fixed;
    inset: 0;
    z-index: 110;
    display: grid;
    place-items: center;
    background: var(--scrim);
    pointer-events: none;
  }
  .fl-dropping > div {
    padding: 28px 40px;
    border: 2px dashed var(--accent);
    border-radius: 12px;
    background: var(--panel);
    font-size: 13px;
    color: var(--text);
    box-shadow: var(--edge);
  }

  /* "Move to…" */
  .fl-menu-scrim {
    position: fixed;
    inset: 0;
    z-index: 120;
  }
  .fl-menu {
    position: fixed;
    z-index: 121;
    width: 292px;
    max-height: 320px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    border: 1px solid var(--line2);
    border-radius: 9px;
    background: var(--panel);
    box-shadow: var(--edge);
  }
  .fl-menu .fl-search {
    flex: none;
  }
  .fl-menu-list {
    overflow-y: auto;
    min-height: 0;
  }
  .fl-menu-fam {
    padding: 8px 6px 3px;
    font-size: 11px;
    color: var(--t2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fl-menu-slots {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
  }
  .fl-menu-item {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .fl-menu-item:hover:not(:disabled) {
    background: var(--accent-soft);
  }
  .fl-menu-item:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .fl-menu-item.own {
    flex: none;
    border-bottom: 1px solid var(--line);
    border-radius: 5px 5px 0 0;
  }
  .fl-swap {
    margin-left: auto;
    font-size: 10px;
    color: var(--t3);
  }

  /* The sidebar's second level: categories under Your fonts, marketplaces
     under Marketplace. */
  .fl-subs {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0 0 4px 16px;
    padding-left: 8px;
    border-left: 1px solid var(--line);
  }
  .fl-sub {
    height: 26px;
    gap: 8px;
    padding: 0 8px;
    font-size: 12px;
  }
  .fl-sub :global(svg) {
    width: 14px;
    height: 14px;
  }
  .fl-sub.target {
    background: var(--accent-soft);
    color: var(--text);
    outline: 1.5px dashed var(--accent);
    outline-offset: -1.5px;
  }
  .fl-add-sub {
    color: var(--t3);
  }
  .fl-sub-name {
    flex: none;
    width: 100%;
    height: 26px;
    font-size: 12px;
  }
  .fl-cat-title {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .fl-cat-title .fl-sub-name {
    width: 280px;
    height: 32px;
  }
  .fl-cat-acts {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
  }
  .fl-icon:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .fl-icon.has {
    color: var(--accent);
  }
  .fl-in {
    color: var(--t3);
  }
  .fl-cat-menu {
    width: 240px;
    max-height: 280px;
  }
  .fl-cat-menu .fl-sub-name {
    height: 28px;
  }
  .fl-check {
    cursor: pointer;
  }
  .fl-check input {
    margin: 0;
    accent-color: var(--accent);
  }
  .fl-menu-note {
    margin: 4px 6px 8px;
    font-size: 11.5px;
    color: var(--t2);
  }

  @media (max-width: 720px) {
    .fl-subs {
      display: none;
    }
    .fl-column {
      padding: 24px 18px 64px;
    }
    .fl-slots {
      grid-template-columns: 1fr;
      padding-left: 0;
    }
  }
</style>
