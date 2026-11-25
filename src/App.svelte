<script module>
  // Holds page-switch unsubscribe across component remounts.
  let releasePageSwitch = null;
</script>

<script>
  import EditorRoot from './lib/editor/EditorRoot.svelte';
  import { focusActiveField } from './lib/Queue.svelte';
  import FontLibrary from './lib/FontLibrary.svelte';
  import BrushModal from './lib/BrushModal.svelte';
  import SettingsModal from './lib/SettingsModal.svelte';
  import ExportDialog from './lib/ExportDialog.svelte';
  import CommandPalette from './lib/CommandPalette.svelte';
  import DrawReadModal from './lib/DrawReadModal.svelte';
  import { drawRead } from './lib/draw-read.svelte.js';
  import Toast from './lib/Toast.svelte';
  import HomeFrame from './lib/home/HomeFrame.svelte';
  import LibraryView from './lib/home/LibraryView.svelte';
  import ProjectView from './lib/home/ProjectView.svelte';
  import NewChapterDialog from './lib/home/NewChapterDialog.svelte';
  import ChapterSourcesSheet from './lib/home/ChapterSourcesSheet.svelte';
  import ChapterVersionsSheet from './lib/home/ChapterVersionsSheet.svelte';
  import Onboarding from './lib/onboarding/Onboarding.svelte';
  import DataFolderCard from './lib/home/DataFolderCard.svelte';
  import DataFolderMissing from './lib/home/DataFolderMissing.svelte';
  import { dataFolder, initDataFolder, recheckDataFolder } from './lib/data-folder.svelte.js';
  import { watchHandoffs } from './lib/handoff.svelte.js';
  import { onboarding, offerOnboardingAtBoot, finishOnboarding } from './lib/onboarding/onboarding.svelte.js';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { app, byId, page, selectBox, settleEdits, deleteBox, duplicateBox, copyBox, pasteBox, hasCopiedBox, nudgeBox, deselect, nextPage, prevPage, setTool, resetBoxRotation, refuseLocked, toggleBalloonFit, refitBalloon, approveOutline, toggleBoxLock, placeDetectedOnPage, checks, goNextCheck, closeBulk, toast, toastError, setPageSwitchHook, flushSidebar, noteFontsChanged, chapterSetIn, isLongstrip, isTranslateMode, isTranslateChapter, stepLine, chapterSaveCycle } from './lib/store.svelte.js';
  import { copyStyle, pasteStyle } from './lib/presets.svelte.js';
  import { editBurst } from './lib/edit-burst.js';
  import { sizeSetting, setSizeSetting, steppedSize } from './lib/data.js';
  import { dispatchShortcut, pressed, registerShortcutHandlers, comboFor, eventKeyName } from './lib/shortcuts.svelte.js';
  import { editorActionHandlers } from './lib/editor-actions.js';
  import { setInspectorTab, cycleInspectorTab } from './lib/inspector-tabs.svelte.js';
  import { settingsView, openSettings, closeSettings } from './lib/settings-tabs.svelte.js';
  import { brushTool, closeBrushManager } from './lib/brush-tool.svelte.js';
  import { pageRectPick } from './lib/page-rect-pick.svelte.js';
  import { initHistory, stepHere } from './lib/editor/history.svelte.js';
  import { flushPanels } from './lib/editor/panels.svelte.js';
  import { switchHistoryPage } from './lib/editor/history-file.svelte.js';
  import { restoreFonts, scanSystemFonts } from './lib/fonts.js';
  import { fontLibraryView, openFontLibrary, closeFontLibrary, closeFontLibraryWindow, followFontChanges } from './lib/font-window.svelte.js';
  import { isTauri } from './lib/importer.js';
  import { checkSidecar } from './lib/sidecar.js';
  import { initDoor, initChapterWindowDoor, closeDoorForQuit } from './lib/agent/door.svelte.js';
  import { windowRole, parseChapterKey, agentWindowReady, closeAgentWindows } from './lib/agent/windows.js';
  import { initTheme } from './lib/theme.svelte.js';
  // Importing the preferences also reads and applies them, and the
  // typesetting switch has to be applied before the first line is measured.
  import { isComics } from './lib/prefs.svelte.js';
  import { library, initRoot, scanLibrary, openChapter, flushBeforeLeaving, leaveApprovalCurrent, checkOutsideChange, watchProjectRecords } from './lib/library.svelte.js';
  import { route, goBack, goEditor } from './lib/route.svelte.js';
  import { watchFontLoads, installContextMenuGuard, isReloadKey, isEditableTarget, ownsArrowKeys } from './lib/shell-guards.js';

  let paletteOpen = $state(false);
  let newChapterOpen = $state(false);
  let newChapterBusy = $state(false);
  let newChapterProject = $state(null);
  let sourcesOpen = $state(false);
  let sourcesBusy = $state(false);
  let sourcesRef = $state({ projectId: null, chapterId: null });
  let versionsOpen = $state(false);
  let versionsBusy = $state(false);
  let versionsRef = $state({ projectId: null, chapterId: null });
  // Library root resolves asynchronously before child views mount.
  let booted = $state(false);
  // Releases the beforeunload/pagehide fallback - see `armUnloadFlush`.
  let releaseUnloadFlush = null;
  let releaseFontWatch = null;
  let releaseContextMenu = null;
  let releaseHandoffs = null;

  // Back from another app: Manga Cleaner may have set the shared folder up
  // or a drive may have come back, and a chapter.json changed elsewhere is
  // picked up now, not at the next save (SAV-2).
  async function onWindowFocus() {
    if (route.name === 'editor') checkOutsideChange();
    if (role.agent) return;
    if ((await recheckDataFolder()) && route.name !== 'editor') scanLibrary();
  }

  // What this window is for: the user's main window, or one opened for an AI
  // agent's chapter (agent/windows.js), which opens that chapter at boot.
  // Read once at boot; until it answers this is the main window.
  let role = { label: 'main', agent: false, chapter: null };
  const roleRead = windowRole().then((r) => (role = r));

  // The detection engine is probed (Tauri only) once the library is read,
  // and only for comics use: general use has no detection, so starting the
  // engine would cost memory for nothing. Switching to comics later starts it
  // then, once.
  let sidecarProbed = false;
  $effect(() => {
    if (!booted || sidecarProbed || !isComics()) return;
    sidecarProbed = true;
    checkSidecar().then((h) => {
      if (h && !role.agent) toast(`Detection ready · ${h.device}`);
    });
  });

  onMount(async () => {
    initTheme();
    if (typeof document !== 'undefined') {
      releaseContextMenu = installContextMenuGuard(document);
      releaseFontWatch = watchFontLoads(document.fonts, (families) => {
        if (chapterSetIn(families)) noteFontsChanged();
      }, 150);
    }
    // Register history and page-switch hooks.
    initHistory();
    releasePageSwitch?.();
    releasePageSwitch = setPageSwitchHook(switchHistoryPage);
    try {
      await initRoot();
      // The shared data folder (SHARED_DATA_FOLDER.md) may put the library
      // somewhere else, so it is settled before the first scan.
      await initDataFolder();
    } catch (e) {
      // Display root resolution failure on the library screen.
      library.error = `Could not work out where your library lives: ${e?.message ?? e}`;
    } finally {
      // Mark booted regardless of success.
      booted = true;
    }
    // Every window writes the series records it shares with the others, so
    // each follows the others' writes.
    watchProjectRecords();
    restoreFonts();
    // The Font Library is a window of its own: what it changes, this window
    // reads again.
    followFontChanges();
    // What this machine has installed, so a system font the user shows is in
    // the menus from the start. Not awaited: nothing on screen needs it yet.
    scanSystemFonts();
    // Recompute measurements when web fonts finish loading.
    document.fonts?.ready.then(() => noteFontsChanged());
    armQuitFlush();
    await roleRead;
    // The first-run setup, decided once the library is read (`booted`) and
    // the window's role is known: never in an agent's window, and never for an
    // install that is already set up.
    offerOnboardingAtBoot(role);
    if (role.agent) {
      await initChapterWindowDoor(role.label);
      await openAgentChapter(role.chapter);
    } else {
      // The AI door opens only if the user left it on (Settings, AI).
      initDoor();
      if (dataFolder.notice) toast(dataFolder.notice);
      // Chapters Manga Cleaner sends: main window only.
      releaseHandoffs = watchHandoffs();
    }
  });

  // A window opened for an agent goes straight to its chapter, and tells the
  // main window it is ready (or why not: the window then closes).
  let agentChapterShown = $state(false);
  // It exists for that one chapter. Leaving it (the back pill) has already
  // saved and let go of the chapter, so the window goes too: kept, it would sit
  // on the project screen holding nothing while the agent's next open_chapter
  // built a second window, and a chapter picked there would be open in a
  // window the door routes no calls to.
  $effect(() => {
    if (!agentChapterShown || route.name === 'editor') return;
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().close());
  });
  async function openAgentChapter(key) {
    const ref = parseChapterKey(key);
    try {
      if (!ref) throw new Error('no chapter was named for this window');
      // The catalogue first: a new window has read none of the library yet.
      await scanLibrary();
      for (let i = 0; library.loading && i < 300; i++) await new Promise((r) => setTimeout(r, 100));
      await openChapter(ref.projectId, ref.chapterId);
      await goEditor(ref.projectId, ref.chapterId);
      agentChapterShown = true;
      await agentWindowReady(true);
    } catch (e) {
      await agentWindowReady(false, String(e?.message ?? e));
    }
  }

  // The last thing that can be done synchronously on the way out of the process.
  //
  // Registered on EVERY platform and in the browser dev server too, which is the
  // whole point: the routes below it (the close button, the macOS Quit item) are
  // Tauri's and cover the ways a user asks this window to close, and nothing
  // covered the ways the page goes away underneath them - a reload, a devtools
  // restart, the updater's `relaunch()`, an OS-initiated logout that tears the
  // webview down without a close request. Each of those cost up to DOC_SAVE_MS
  // of edits.
  //
  // Synchronous by necessity: `beforeunload` cannot await, so the two debounced
  // preference tiers (which write synchronously to localStorage) are the part
  // that is guaranteed, and the chapter's own save is kicked off with whatever
  // time the platform then gives it. `settleEdits` first, for the same reason
  // `flushBeforeLeaving` does it first - an edit inside its settle window has
  // been applied to the document and is not yet in anything that gets written.
  function armUnloadFlush() {
    if (typeof window === 'undefined') return () => {};
    const onUnload = () => {
      try {
        settleEdits();
        flushSidebar();
        flushPanels();
        // Not awaited - there is nothing here that can await. A chapter with
        // nothing pending resolves immediately and this costs nothing.
        if (app.chapterRef) flushBeforeLeaving('quit');
      } catch (e) {
        console.error('Could not flush on unload', e);
      }
    };
    window.addEventListener('beforeunload', onUnload);
    // `pagehide` as well, because a webview backgrounded and then killed by the
    // OS never fires `beforeunload` at all.
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
    };
  }

  // Quitting with the editor open flushes pending debounced writes.
  async function armQuitFlush() {
    // First and unconditionally, so the fallback is in place before anything
    // below can fail - and so it exists at all under `vite dev`, where there is
    // no Tauri window to hang a close handler on.
    releaseUnloadFlush?.();
    releaseUnloadFlush = armUnloadFlush();
    if (!isTauri()) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const w = getCurrentWindow();
      // Track single in-flight quit flush.
      let inFlight = null;
      const safeToQuit = () => {
        // Flush preference tiers and open chapter before quitting.
        flushSidebar();
        flushPanels();
        if (!app.chapterRef) return Promise.resolve(true);
        const ref = app.chapterRef, turn = chapterSaveCycle();
        if (!inFlight || inFlight.ref !== ref || inFlight.turn !== turn) {
          const original = flushBeforeLeaving('quit');
          const own = { ref, turn, original };
          inFlight = own;
          original.finally(() => { if (inFlight === own) inFlight = null; }).catch(() => {});
        }
        return inFlight.original;
      };

      // Route 1: window close button. The only route that exists on every
      // platform - Alt+F4, the titlebar X, the dock's Quit.
      await w.onCloseRequested(async (e) => {
        if (!app.chapterRef) {
          // Flush preferences when closing without an open chapter.
          flushSidebar();
          flushPanels();
          // The main window going takes the AI windows with it, each saved.
          if (!role.agent) {
            e.preventDefault();
            if (await agentWindowsClosed()) await w.destroy();
          }
          return;
        }
        e.preventDefault();
        await destroyWhenSaved(safeToQuit, w);
      });

      // Route 2: Cmd+Q and the Quit menu item. macOS only because the MENU is
      // macOS only - see `patchDefaultMenu`. The menu is the app's, so only the
      // main window puts its Quit there: an AI window's would close only itself.
      await roleRead;
      if (!role.agent) await patchDefaultMenu(safeToQuit, w);
    } catch (e) {
      // Not swallowed any more. This used to be a bare `catch {}`, so a build
      // where the window API moved, or a platform that refused the menu, quietly
      // lost every route above and took the last 800ms of edits with it on every
      // quit - with nothing anywhere to say so. The unload fallback registered at
      // the top is still standing, which is what makes this a degradation and not
      // a silent data loss.
      console.error('Could not arm the quit flush', e);
      toastError(`Quitting may not save the last edits: ${e?.message ?? e}`);
    }
  }

  // Before the main window quits: the AI door shut, so no agent edits it while
  // it saves, and every AI window saved and closed. False when one would not
  // close (its save failed and it is asking the user): the main window stays.
  async function agentWindowsClosed() {
    if (role.agent) return true;
    await closeDoorForQuit();
    // Not waited for: the library saves as it goes, so it has nothing to
    // finish, and the quit should not wait on it.
    closeFontLibraryWindow();
    const left = await closeAgentWindows();
    if (left > 0) {
      toastError(`An AI window could not close (${left} left) - save or close it first, then quit again`);
      return false;
    }
    return true;
  }

  async function destroyWhenSaved(safeToQuit, w) {
    if (!(await agentWindowsClosed())) return;
    const ref = app.chapterRef, turn = chapterSaveCycle();
    const original = safeToQuit();
    if (!(await original)) return;
    // Approval belongs to this exact public Promise/document, including the
    // deliberate discard path. A new load or edit cannot inherit it.
    if (app.chapterRef !== ref || chapterSaveCycle() !== turn || (ref && !leaveApprovalCurrent(original))) return;
    await w.destroy();
  }

  // Strip predefined Undo/Redo from the macOS application menu so DOM keydowns
  // work, and put our own Quit in front of the predefined one.
  async function patchDefaultMenu(safeToQuit, w) {
    // macOS only, and deliberately: Tauri installs a default application menu on
    // macOS alone. On Windows and Linux there is no menu to patch - building one
    // here and calling `setAsAppMenu` would ADD a menu bar the app has never had.
    // The close-button route above is what covers those platforms for the window,
    // and `armUnloadFlush` is what covers the ways the page goes away without one.
    if (!/Mac/i.test(navigator.userAgent)) return;
    const { Menu, MenuItem } = await import('@tauri-apps/api/menu');
    const menu = await Menu.default();
    let changed = false;
    let quitDone = false;
    for (const sub of await menu.items()) {
      if (sub.kind !== 'Submenu') continue;
      const items = await sub.items();
      // Descending so removals do not shift unvisited indices.
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind !== 'Predefined') continue;

        const text = (await items[i].text()) ?? '';
        if (/^&?(un|re)do\b/i.test(text)) {
          await sub.removeAt(i);
          changed = true;
          continue;
        }
        // Replace only the first Quit item.
        if (quitDone || !/^&?quit\b/i.test(text)) continue;
        const replacement = await MenuItem.new({
          id: 'mt-quit',
          text,
          accelerator: 'CmdOrCtrl+Q',
          action: async () => {
            await destroyWhenSaved(safeToQuit, w);
          },
        });
        await sub.removeAt(i);
        await sub.insert(replacement, i);
        quitDone = true;
        changed = true;
      }
    }
    if (changed) await menu.setAsAppMenu();
  }

  // Hydrate editor when routing to a chapter.
  $effect(() => {
    if (route.name !== 'editor') return;
    const { projectId, chapterId } = route;
    if (untrack(() => app.chapterRef?.projectId === projectId && app.chapterRef?.chapterId === chapterId)) return;
    let active = true;
    openChapter(projectId, chapterId).catch((e) => {
      if (!active || route.name !== 'editor' || route.projectId !== projectId || route.chapterId !== chapterId) return;
      toastError(`Could not open that chapter: ${e?.message ?? e}`);
      goBack();
    });
    return () => { active = false; };
  });

  function openNewChapter(projectId = null) {
    newChapterProject = projectId;
    newChapterOpen = true;
  }

  function openVersions(projectId, chapterId) {
    versionsRef = { projectId, chapterId };
    versionsOpen = true;
  }

  function openSources(projectId, chapterId) {
    sourcesRef = { projectId, chapterId };
    sourcesOpen = true;
  }

  // The raw-page peek (FLOW-7, "Peek at the raw page", \ by default) ends with
  // its key, wherever focus went meanwhile: the key half of whatever it is
  // bound to. A modifier let go first does not end it; the key itself, or the
  // window losing focus, does.
  function onKeyup(e) {
    if (!app.peekRaw) return;
    const key = comboFor('view.peekRaw')?.split('+').pop();
    if (key && eventKeyName(e) === key) app.peekRaw = false;
  }

  // Arrow keys, as the step they move a box by. Shift multiplies it.
  const NUDGE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const NUDGE_FAST = 10;

  // The bigger/smaller keys. A held key or a run of presses is one undo step,
  // as a scrub in the Inspector is: the same burst, not one entry per press.
  // An Inspector edit still pending is settled before the run starts, so the
  // two never record the same change.
  const sizeBurst = editBurst(() => byId(app.selectedId));
  function stepSelectedSize(d) {
    if (!app.selectedId || isTranslateMode()) return false;
    const b = byId(app.selectedId);
    if (!b?.style || refuseLocked(b)) return;
    if (!sizeBurst.isOpen()) settleEdits();
    sizeBurst.arm();
    setSizeSetting(b.style, steppedSize(sizeSetting(b.style), d));
    sizeBurst.touch();
  }

  // Every named shortcut in the app dispatches through here - the registry in
  // shortcuts.svelte.js owns which keys reach which of these, and the settings
  // screen rebinds them. A handler returning exactly `false` declines the press
  // (nothing selected, wrong chapter mode) and lets the key fall through to the
  // browser; anything else counts as handled and the default is prevented.
  const releaseShortcuts = registerShortcutHandlers({
    // Modes. `setTool` refuses every tool but the hand in a translate chapter,
    // so there is nothing to guard here - but the press is still swallowed, because
    // Cmd+1 falling through to the webview is not a better outcome than nothing.
    'tool.place': () => setTool('place'),
    'tool.text': () => setTool('text'),
    'tool.brush': () => setTool('brush'),

    'box.duplicate': () => {
      // Swallowed either way, so the browser's bookmark dialog never opens over
      // a translate chapter that has nothing to duplicate.
      if (!isTranslateMode()) duplicateBox();
    },
    // A switch, not a one-shot: pressing it again on the same box turns balloon
    // fit back off. The re-measure is `box.retypeset` below, the Inspector's
    // button - see `toggleBalloonFit` for why the two are different actions.
    'box.fitBalloon': () => {
      if (isTranslateMode() || !app.selectedId) return false;
      toggleBalloonFit(app.selectedId);
    },
    // The Inspector's Refit button, from the keyboard: one undo step, and a
    // second press changes nothing.
    'box.retypeset': () => {
      if (isTranslateMode() || !app.selectedId) return false;
      refitBalloon(app.selectedId);
    },
    'box.approveOutline': () => {
      if (isTranslateMode() || !app.selectedId) return false;
      approveOutline(app.selectedId);
    },
    'view.regions': () => {
      if (isTranslateMode()) return false;
      app.showRegions = !app.showRegions;
    },
    // Lock, as a switch on the selected box. The padlock on the page only
    // shows on a locked box, so this and the box menu are how one is locked.
    'box.layoutLock': () => {
      if (isTranslateMode() || !app.selectedId) return false;
      toggleBoxLock(app.selectedId);
    },
    // Declined whenever the press could mean copying text instead - text
    // selected somewhere on screen - so the browser's own copy still runs.
    'box.copy': () => {
      if (!app.selectedId || isTranslateMode() || hasTextSelection()) return false;
      if (!copyBox(app.selectedId)) return false;
      toast('Box copied');
    },
    'box.paste': () => {
      if (isTranslateMode() || !hasCopiedBox()) return false;
      pasteBox();
    },
    'box.delete': deleteSelected,
    'box.deleteAlt': deleteSelected,
    'box.resetRotation': () => {
      if (!app.selectedId || isTranslateMode()) return false;
      if (!resetBoxRotation(app.selectedId) && !byId(app.selectedId)?.locked) toast('That box is already straight');
    },
    'box.sizeUp': () => stepSelectedSize(1),
    'box.sizeDown': () => stepSelectedSize(-1),
    'style.copy': () => {
      if (!app.selectedId || isTranslateMode()) return false;
      const b = byId(app.selectedId);
      if (b) copyStyle(b);
    },
    'style.paste': () => {
      if (!app.selectedId || isTranslateMode()) return false;
      const b = byId(app.selectedId);
      // A debounced Inspector edit still pending on this box would settle
      // AFTER the paste and record on top of it; settle first, so undo takes
      // the paste back in one press. Same reason `duplicateBox` settles.
      settleEdits();
      if (b) pasteStyle(b);
    },

    'queue.placeDetected': () => {
      if (isTranslateMode()) return false;
      placeDetectedOnPage();
    },
    'review.next': () => {
      if (isTranslateMode() || !app.loaded) return false;
      goNextCheck(checks.items);
    },

    'edit.undo': () => {
      stepHere('undo');
    },
    'edit.redo': redoShortcut,
    'edit.redoAlt': redoShortcut,

    'inspector.tabNext': () => cycleInspectorTab(1),
    'inspector.tabPrev': () => cycleInspectorTab(-1),
    'inspector.tabText': () => setInspectorTab('text'),
    'inspector.tabFill': () => setInspectorTab('fill'),
    'inspector.tabEffects': () => setInspectorTab('effects'),
    'inspector.tabLayout': () => setInspectorTab('layout'),

    // The palette (FLOW-4). It closes itself on its own key: while it is up,
    // the modal guard in `onKeydown` keeps this dispatch from running at all.
    'palette.open': () => {
      paletteOpen = true;
    },
    'fonts.open': () => {
      if (isTranslateMode()) return false;
      openFontLibrary();
    },
  });
  // The rest of the named actions: editor-actions.js.
  const releaseActions = registerShortcutHandlers(editorActionHandlers());
  onDestroy(() => {
    releaseShortcuts();
    releaseActions();
    sizeBurst.dispose();
    releaseUnloadFlush?.();
    releaseUnloadFlush = null;
    releaseFontWatch?.();
    releaseFontWatch = null;
    releaseContextMenu?.();
    releaseContextMenu = null;
    releaseHandoffs?.();
    releaseHandoffs = null;
  });

  function hasTextSelection() {
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
    return !!sel && !sel.isCollapsed && sel.toString().trim() !== '';
  }
  function deleteSelected() {
    if (!app.selectedId || isTranslateMode()) return false;
    deleteBox(app.selectedId);
  }
  // Through the translate gate (`stepHere`), as the dock's buttons are.
  function redoShortcut() {
    stepHere('redo');
  }

  // Is the caret somewhere that owns the keyboard? Text fields and the canvas's
  // own in-place editor both count, and `app.editingId` is the second because
  // the box being typed into is a contenteditable that may have lost focus to a
  // panel button without the edit ending. Context menu guards do not exempt
  // <select>, but typing targets still include it.
  function isTypingTarget(t) {
    if (!(t instanceof Element)) return false;
    return isEditableTarget(t) || t.matches('select');
  }

  function onKeydown(e) {
    // Reload is never wanted in a desktop app: Mod+R, Mod+Shift+R and F5
    // tear down the webview and lose unsaved edits. The page's default is
    // blocked everywhere, even while typing, but the key carries on below so a
    // shortcut the user has bound to one of these combos still fires.
    if (isReloadKey(e)) e.preventDefault();
    // An IME mid-composition owns the keyboard: isComposing is the standard
    // flag, keyCode 229 is how some engines mark the synthetic keys. Acting
    // on either would steal keystrokes from the composition window.
    if (e.isComposing || e.keyCode === 229) return;
    // Not an early return any more. It used to be one - three lines at the top
    // of this handler that gave up the moment the caret was in a text field -
    // and since a letterer's caret lives in the Inspector's text field or a
    // queue row nearly all the time, that is what made the old bare v/t/h mode
    // keys look dead. What survives is: the shortcuts that cannot be part of
    // typing (the Cmd/Ctrl combos for modes, tabs and rotation) still fire, and
    // everything else stands down. The registry decides which is which.
    // The setup sits over everything else, so its Escape goes first and
    // before the typing gate: a box left in edit under the screen must not
    // keep the way out shut. Its own screen takes the Escape that arrives with
    // focus inside it; this is for one that arrives with focus outside.
    if (e.key === 'Escape' && onboarding.open) return finishOnboarding();
    const typing = isTypingTarget(e.target) || !!app.editingId;
    if (e.key === 'Escape' && pageRectPick.active) return void pageRectPick.cancel(); // a pick ends on Escape, typing or not
    if (!typing && e.key === 'Escape') {
      // Focus is in the palette's field nearly always, and the field takes its
      // own Escape; this is for the press that arrives with focus elsewhere.
      if (paletteOpen) return (paletteOpen = false);
      if (newChapterOpen) {
        // In-flight chapter copy is not dismissible.
        if (!newChapterBusy) newChapterOpen = false;
        return;
      }
      if (sourcesOpen) {
        // In-flight copy is not dismissible.
        if (!sourcesBusy) sourcesOpen = false;
        return;
      }
      if (versionsOpen) {
        // Nor is a restore half-written.
        if (!versionsBusy) versionsOpen = false;
        return;
      }
      if (app.exportOpen) return (app.exportOpen = false);
      if (drawRead.open) return (drawRead.open = false);
      if (app.bulk.active) return closeBulk();
      if (settingsView.open) return closeSettings();
      if (fontLibraryView.open) return closeFontLibrary();
      if (brushTool.manager) return closeBrushManager();
      return deselect();
    }
    // Suppress global editor shortcuts while a modal overlay is open. Markup
    // contract, relied on by this query: every app modal renders a root
    // `.modal-overlay` element and carries the `open` class only while it is
    // showing (ExportDialog does; so must any modal added later, or
    // this line has to be taught about it). Settings, the first-run setup and
    // the in-window Font Library are full-window screens, `.settings-screen`
    // and `.onboarding-screen`,
    // mounted only while open.
    if (typeof document !== 'undefined' && document.querySelector('.modal-overlay.open, .settings-screen, .onboarding-screen')) return;
    if (route.name !== 'editor') return;
    // Every named shortcut, in one line: undo, redo, duplicate, delete, the
    // style clipboard, the three modes, the Inspector's tabs and the rotation
    // reset. What each of them is bound to is the registry's business, and the
    // user's - nothing below this line knows a combo.
    if (dispatchShortcut(e, { typing })) return;
    // Past here is the contextual half of the keyboard: keys whose meaning
    // depends on what has focus and what is selected, which is exactly what a
    // rebindable shortcut cannot be. None of it runs while typing, nor for a
    // press a focused control already answered (a tab strip's arrows, a
    // widget's own keys): that control has said what the key meant there.
    if (typing || e.defaultPrevented) return;
    const mod = e.metaKey || e.ctrlKey;
    // Tab / Shift+Tab: cycle box selection in document order, but only when
    // focus is not on a focusable UI control (e.g. sidebar inputs or inspector buttons).
    if (!mod && e.key === 'Tab' && app.selectedId) {
      const ae = typeof document !== 'undefined' ? document.activeElement : null;
      const isCanvasFocus =
        !ae || ae === document.body || !!ae.closest?.('.editor-scroll') || !!ae.closest?.('.page-frame');
      if (isCanvasFocus) {
        const boxes = page().boxes;
        if (boxes?.length) {
          const idx = boxes.findIndex((b) => b.id === app.selectedId);
          if (idx !== -1) {
            e.preventDefault();
            settleEdits();
            const nextIdx = e.shiftKey
              ? (idx - 1 + boxes.length) % boxes.length
              : (idx + 1) % boxes.length;
            selectBox(boxes[nextIdx].id);
            return;
          }
        }
      }
    }
    // The tool keys used to be here, as bare v / t / h. They are Cmd/Ctrl+1/2/3
    // in the registry now: a bare letter is typing before it is a shortcut, so
    // it could only ever fire with focus nowhere at all, and it collided with
    // the letter itself the moment focus moved into a field.
    // A translate chapter, with focus on the page rather than a control: the
    // row keys of the registry's Translation group (↑ ↓ step through the
    // lines, Enter goes into the active one's English, ← → turn the page by
    // default). Rebindable, so the plain arrows below do not also turn the
    // page here.
    if (isTranslateChapter() && !app.selectedId) {
      const t = e.target;
      const onPage = !(t instanceof Element) || t === document.body || !!t.closest?.('.editor-scroll, .page-frame');
      if (onPage) {
        if (pressed(e, 'translate.lineDown') || pressed(e, 'translate.lineUp')) {
          e.preventDefault();
          stepLine(pressed(e, 'translate.lineDown') ? 1 : -1);
          return;
        }
        if (pressed(e, 'translate.edit')) {
          e.preventDefault();
          focusActiveField('en');
          return;
        }
      }
      if (!isLongstrip() && (pressed(e, 'translate.pageNext') || pressed(e, 'translate.pagePrev'))) {
        e.preventDefault();
        if (pressed(e, 'translate.pageNext')) nextPage();
        else prevPage();
        return;
      }
    }
    // The arrows nudge the selected box and turn the page when nothing is
    // selected - one key, and which it means is what the user is looking at.
    // A focused slider or radio keeps its own arrow keys.
    if (NUDGE[e.key] && ownsArrowKeys(e.target)) return;
    const step = !mod ? NUDGE[e.key] : null;
    if (step && app.selectedId && !isTranslateMode()) {
      e.preventDefault();
      const k = e.shiftKey ? NUDGE_FAST : 1;
      nudgeBox(app.selectedId, step[0] * k, step[1] * k);
      return;
    }
    // Longstrip navigation is handled by scroll container; paged chapters
    // consume the arrow for the turn, so the default (scrolling the page
    // under a caret-less keypress) is prevented with it.
    if (!isLongstrip() && !isTranslateChapter()) {
      if (e.key === 'ArrowRight' && !e.shiftKey) {
        e.preventDefault();
        nextPage();
      }
      if (e.key === 'ArrowLeft' && !e.shiftKey) {
        e.preventDefault();
        prevPage();
      }
    }
  }
</script>

<!-- Back from another app: a chapter.json changed there is picked up now,
     not at the next save (SAV-2). Leaving the window lets go of the raw-page
     peek, whose key-up went to the other app. -->
<svelte:window
  onkeydown={onKeydown}
  onkeyup={onKeyup}
  onfocus={onWindowFocus}
  onblur={() => (app.peekRaw = false)}
/>

{#if route.name === 'editor'}
  <EditorRoot onFontLib={openFontLibrary} onSettings={openSettings} />
{:else if booted}
  <HomeFrame onSettings={openSettings}>
    <DataFolderCard />
    {#if route.name === 'project'}
      <ProjectView
        onNewChapter={(id) => openNewChapter(id)}
        onSources={openSources}
        onVersions={openVersions}
      />
    {:else}
      <LibraryView
        onNewChapter={() => openNewChapter(null)}
      />
    {/if}
  </HomeFrame>
{:else}
  <div class="boot"></div>
{/if}

<NewChapterDialog
  bind:open={newChapterOpen}
  bind:busy={newChapterBusy}
  projectId={newChapterProject}
/>
<ChapterSourcesSheet
  bind:open={sourcesOpen}
  bind:busy={sourcesBusy}
  projectId={sourcesRef.projectId}
  chapterId={sourcesRef.chapterId}
/>
<ChapterVersionsSheet
  bind:open={versionsOpen}
  bind:busy={versionsBusy}
  projectId={versionsRef.projectId}
  chapterId={versionsRef.chapterId}
/>
<!-- The Font Library is its own window in the desktop app; here only when
     there is no second window to open (a browser). -->
{#if fontLibraryView.open}<FontLibrary embedded onclose={closeFontLibrary} />{/if}
<BrushModal />
<SettingsModal bind:open={settingsView.open} />
<ExportDialog />
<DrawReadModal />
<CommandPalette bind:open={paletteOpen} />
<!-- Over the route rather than in place of it, as Settings is, so running
     the setup again from the editor keeps the chapter mounted. -->
{#if onboarding.open}<Onboarding />{/if}
<DataFolderMissing />
<Toast />
