<script>

  import { tick, untrack } from 'svelte';
  import { app, saveExportPrefs, toast, toastError } from './store.svelte.js';
  import { checkSidecar, modelsCacheInfo, clearModelsCache } from './sidecar.js';
  import ThemePicker from './ThemePicker.svelte';
  import { library, setRoot, scanLibrary, withinHome, projectById, setProjectOcrLanguage } from './library.svelte.js';
  import { settingsView, shownSettingsTab } from './settings-tabs.svelte.js';
  import SeriesGuide from './SeriesGuide.svelte';
  import LetteringSetup from './LetteringSetup.svelte';
  import TextStyles from './TextStyles.svelte';
  import { resetPanels } from './editor/panels.svelte.js';
  import { processMemory, ROLE_LABELS } from './memory.js';
  import { prefs, setPref, typesetDefaults } from './prefs.svelte.js';
  import { guide, setSeriesTypeset } from './guide.svelte.js';
  import { engineSwitch, engineHasNoFont } from './engine-switch.svelte.js';
  import ReaderChoice from './ReaderChoice.svelte';
  import ShortcutSettings from './ShortcutSettings.svelte';
  import { door, setDoorOn, setDoorPort, rotateToken, DEFAULT_PORT } from './agent/door.svelte.js';
  import { connectLines, doorUrl } from './agent/connect.js';
  import { getVersion } from '@tauri-apps/api/app';
  import { checkForUpdate } from './updater.js';
  import UpdateDialog from './home/UpdateDialog.svelte';

  // `tab` is bindable so the command palette can open Settings on one tab.
  let { open = $bindable() } = $props();

  // ---------- sections ----------
  // A full-window screen with the sections down a sidebar, the way Manga
  // Cleaner's Settings is laid out: one column of rows per section, a label on
  // the left and its control on the right. Two groups. The app's own sections
  // are saved on this computer; the series group, named after the open
  // chapter's series, is saved with that series (project.json) and is there
  // only while one of its chapters is open. The group a section sits in is
  // what says where its settings are kept.
  //
  // Design contract (2026-10-18). THESIS: one full-window column of rows -
  // label left, control right, a hairline, one sentence under the label -
  // instead of a popup of boxed cards and scope chips. OWN-WORLD: the app's
  // tokens only; the sidebar on --panel, the column on --bg. STORY: find a
  // setting by section in one click, and know from its group whether it is
  // yours or the series'. FIRST VIEWPORT: 224px sidebar, then a 680px column
  // with the section's h2. FORM: the structure the user named (Manga Cleaner's
  // Settings); a precisely specified Operate surface, so no concept roll.
  const icon = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const APP_TABS = [
    { id: 'general', label: 'General', icon: icon('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" /><path d="M1 14h6M9 8h6M17 16h6" />') },
    { id: 'typesetting', label: 'Typesetting', icon: icon('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-4.6A8.4 8.4 0 1 1 21 11.5z" />') },
    { id: 'detection', label: 'Detection', icon: icon('<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" />') },
    { id: 'ai', label: 'AI agents', icon: icon('<path d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z" /><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />') },
    { id: 'shortcuts', label: 'Shortcuts', icon: icon('<rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6" />') },
    { id: 'about', label: 'About', icon: icon('<circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />') },
  ];
  const SERIES_TABS = [
    { id: 'series', label: 'Series', icon: icon('<path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z" /><path d="M4 21V5" /><path d="M8 7h6" />') },
    { id: 'styles', label: 'Text styles', icon: icon('<path d="M4 7V4h16v3" /><path d="M9 20h6" /><path d="M12 4v16" />') },
    { id: 'guide', label: 'Guide', icon: icon('<path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" />') },
  ];

  // The open chapter's project, or null. The series group is shown only while
  // there is one: everything in it is that project's, and with no chapter open
  // there is no single project for it to mean.
  const project = $derived(app.chapterRef ? (projectById(app.chapterRef.projectId) ?? null) : null);
  const tabs = $derived(project ? [...APP_TABS, ...SERIES_TABS] : APP_TABS);
  // Which section is open lives in `settings-tabs.svelte.js`, so the command
  // palette and the panes that send the user here can choose it.
  const tab = $derived(shownSettingsTab(!!project));
  const current = $derived(tabs.find((t) => t.id === tab) ?? APP_TABS[0]);
  const inSeries = $derived(SERIES_TABS.some((t) => t.id === tab));

  // ---------- project ----------
  // The language goes through the same call the project screen makes, which
  // is also what tells detection in the open chapter.
  let changingLanguage = $state(false);
  async function onLanguage(language) {
    if (!project || changingLanguage || language === project.ocrLanguage) return;
    changingLanguage = true;
    try {
      await setProjectOcrLanguage(project.id, language);
    } catch (e) {
      toastError(`Could not change source language: ${e?.message ?? e}`);
    } finally {
      changingLanguage = false;
    }
  }


  // ---------- typesetting defaults: yours, or the series' (FLOW-13) ----------
  // Yours are edited under Typesetting, in the app group, and are kept on this
  // computer. A series can hold its own set instead: switched on under Series,
  // it starts as a copy of yours and is kept with the series. Each page edits
  // only its own set, so the group a row sits in is still where it is saved.
  const TS_KEYS = ['defaultAutoHeight', 'defaultHyphenate', 'defaultBalloon', 'defaultBlockShape', 'defaultMinOrphan'];
  const seriesTs = $derived(project ? guide.typeset : null);
  const mineTs = $derived(Object.fromEntries(TS_KEYS.map((k) => [k, prefs[k]])));
  // The series' set over yours for any key it leaves out: what its boxes get.
  const seriesValues = $derived(typesetDefaults());
  const setMine = (key, value) => setPref(key, value);
  const setSeries = (key, value) => setSeriesTypeset({ [key]: value });
  function useSeriesTs(on) {
    if (!project || on === !!seriesTs) return;
    if (!on) return setSeriesTypeset(null);
    setSeriesTypeset({ ...mineTs });
  }

  function selectTab(id) {
    settingsView.tab = id;
  }

  // The sidebar is one vertical tab list across both groups: Up and Down move
  // and open, Home and End go to the ends. Only the open section's tab is a
  // tab stop, so the list costs one Tab to cross.
  function onTabKey(e) {
    const i = tabs.findIndex((t) => t.id === tab);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    selectTab(next.id);
    tick().then(() => document.getElementById(`set-tab-${next.id}`)?.focus());
  }

  // Focus moves in when the screen opens - to the open section's tab - and
  // back to whatever had it when it closes. Tab and Shift+Tab stay inside:
  // the editor under the screen is still mounted, and still focusable.
  let screenEl = $state(null);
  let panelEl = $state(null);
  $effect(() => {
    if (!open) return;
    const before = document.activeElement;
    const id = untrack(() => tab);
    tick().then(() => document.getElementById(`set-tab-${id}`)?.focus());
    return () => {
      if (before?.isConnected) before.focus?.();
    };
  });
  // A section opens at its top, not at the last one's scroll.
  $effect(() => {
    tab;
    if (panelEl) panelEl.scrollTop = 0;
  });

  const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function onScreenKey(e) {
    if (e.key !== 'Tab' || !screenEl) return;
    const all = [...screenEl.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!all.length) return;
    const first = all[0];
    const last = all[all.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  let cache = $state(null); // { entries:[{path,exists,bytes}], total_bytes } | null
  let cacheLoading = $state(false);
  let clearing = $state(false);
  let confirmClear = $state(false); // inline two-step confirm (webviews may block window.confirm)
  let confirmResetPanels = $state(false); // same two-step; a reset cannot be undone

  // PSD export self-test (dev builds only).
  const DEV = !!import.meta.env?.DEV;
  let selfTesting = $state(false);
  let selfTest = $state(null); // the last report, or { error }

  async function onPsdSelfTest() {
    if (!app.pages.length) {
      toast('Open a chapter first - the self-test runs on the page you are looking at');
      return;
    }
    selfTesting = true;
    selfTest = null;
    try {

      const { psdSelfTest } = await import('./psd.js');
      selfTest = await psdSelfTest(app.pages[app.pageIndex]);
      selfTest.ok ? toast('PSD self-test passed') : toastError('PSD self-test FAILED - see Settings');
    } catch (e) {
      selfTest = { ok: false, error: String(e?.message ?? e) };
      toast('PSD self-test threw - see Settings');
    } finally {
      selfTesting = false;
    }
  }

  // Process memory tracking.
  let mem = $state(null); // MemoryReport | null (null = not the desktop app)
  let memLive = $state(false);

  async function loadMemory() {
    mem = await processMemory();
  }

  // Poll memory only while modal is open and live toggle is on.
  $effect(() => {
    if (!open || !memLive) return;
    const t = setInterval(loadMemory, 2000);
    return () => clearInterval(t);
  });


  $effect(() => {
    if (open) loadMemory();
  });

  function isTauri() {
    return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
  }

  // ---------- updates ----------
  // The home screen checks once on launch and shows a badge if something is
  // there. That leaves no way to ask, which is the one thing a user wants after
  // reading that a release exists - so the ask lives here, and it reuses the
  // same check and the same dialog rather than growing a second update path.
  let appVersion = $state('');
  let checking = $state(false);
  // null = never asked this session; the Update object, or false for "nothing".
  let upd = $state(null);
  let updDialogOpen = $state(false);
  let updError = $state('');

  $effect(() => {
    if (!open || appVersion || !isTauri()) return;
    getVersion()
      .then((v) => (appVersion = v))
      .catch(() => {});
  });

  async function onCheckUpdate() {
    if (checking) return;
    checking = true;
    updError = '';
    try {
      upd = (await checkForUpdate()) ?? false;
      // Found one: straight into the same dialog the home badge opens, because
      // the next thing the user wants is the notes and the Download button.
      if (upd) updDialogOpen = true;
    } catch (e) {
      upd = false;
      updError = e?.message ?? String(e);
    } finally {
      checking = false;
    }
  }

  function fmtBytes(n) {
    if (!n || n < 1) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  async function loadCache() {
    cacheLoading = true;
    cache = await modelsCacheInfo();
    cacheLoading = false;
  }

  async function onClearCache() {
    if (!confirmClear) {
      confirmClear = true;
      return;
    }
    confirmClear = false;
    clearing = true;
    try {
      const r = await clearModelsCache();
      r?.ok ? toast(`Cleared cache · freed ${fmtBytes(r.freed_bytes)}`) : toastError('Cache clear had errors - see logs');
      await loadCache();
    } catch (e) {
      toastError(`Clear cache failed: ${e}`);
    } finally {
      clearing = false;
    }
  }

  // ---------- AI ----------
  // The MCP door (agent/door.svelte.js): off by default, 127.0.0.1 only, and
  // every request needs the token. The token shows only inside the lines to
  // paste - it is the user's own, for their own clients.
  const lines = $derived(connectLines(door.port, door.token));
  const connectBlocks = $derived([
    { id: 'claude', name: 'Claude Code', lines: [{ text: lines.claude, label: 'Claude Code line' }] },
    {
      id: 'codex',
      name: 'Codex',
      lines: [
        { text: lines.codexEnv, label: 'Codex token line', note: 'Put this line in your shell profile (~/.zshrc or ~/.bashrc), then open a new terminal.' },
        { text: lines.codex, label: 'Codex line', note: 'Then run this once.' },
      ],
    },
    { id: 'agy', name: 'Antigravity', lines: [{ text: lines.agy, label: 'Antigravity config', note: 'Goes in ~/.gemini/config/mcp_config.json.' }] },
  ]);

  async function copyLine(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch (e) {
      toastError(`Could not copy: ${e?.message ?? e}`);
    }
  }

  async function onDoorPort(e) {
    const input = e.currentTarget;
    const raw = String(input.value).trim();
    await setDoorPort(raw === '' ? DEFAULT_PORT : +raw);
    // Out of range or not a number: setDoorPort keeps the old port, so show it.
    input.value = String(door.port);
  }

  async function onNewToken() {
    await rotateToken();
    toast('New token made');
  }

  // Reset floating panel layout.
  function onResetPanels() {
    if (!confirmResetPanels) {
      confirmResetPanels = true;
      return;
    }
    confirmResetPanels = false;

    resetPanels(window.innerWidth, window.innerHeight);
    toast('Panel layout reset');
  }

  async function onChangeExportDir() {
    if (!isTauri()) {
      toast('Choosing a folder needs the desktop app');
      return;
    }
    try {
      const { open: pickDir } = await import('@tauri-apps/plugin-dialog');
      const dir = await pickDir({ directory: true, defaultPath: app.exportDir || undefined });
      if (dir) {
        saveExportPrefs(dir, app.exportName);
        toast('Default export folder set');
      }
    } catch (e) {
      toast(`Couldn't set folder: ${e}`);
    }
  }

  async function chooseRoot() {
    if (!isTauri()) {
      toast('Choosing a folder needs the desktop app');
      return;
    }

    if (app.chapterRef) {
      toast('Close the open chapter before changing the library folder');
      return;
    }
    try {
      const { open: pick } = await import('@tauri-apps/plugin-dialog');
      const dir = await pick({ directory: true, defaultPath: library.root });
      if (!dir) return;
      // Library folder must be inside home directory.
      if (!(await withinHome(dir))) {
        toast('The library has to live inside your home folder for now.');
        return;
      }
      await setRoot(dir);
      await scanLibrary();
      toast('Library folder changed');
    } catch (e) {
      toast(`Couldn't set folder: ${e}`);
    }
  }


  $effect(() => {
    if (open) {
      confirmClear = false;
      confirmResetPanels = false;
      checkSidecar();
      loadCache();
    }
  });

  const sidecarOk = $derived(app.sidecar?.status === 'ok');

  const sidecarLabel = $derived(
    app.sidecar?.status === 'ok'
      ? `Ready · ${app.sidecar.info?.engine ?? 'onnx-rust'} · ${app.sidecar.device ?? '-'}`
      : app.sidecar?.status === 'unavailable'
        ? 'Unavailable - desktop app only'
        : app.sidecar?.status === 'error'
          ? 'Error - see logs'
          : 'Checking…',
  );

</script>

<!-- One switch, written once. Every preference toggle in here is the same three
     things - a knob, the preference it writes, and the name a screen reader
     reads - and the row that spells them out by hand is the row that ends up
     writing the wrong key. `disabled` is a look and a refusal, not an attribute:
     the element is a div, so it also leaves the tab order. `set` is for a
     switch whose preference is not a plain true/false (the text engine's is
     'rust' or 'browser'). -->
{#snippet toggle(key, label, on, disabled = false, set = null)}
  <div
    class="switch"
    class:on
    class:disabled
    role="switch"
    aria-checked={on}
    aria-label={label}
    aria-disabled={disabled}
    tabindex={disabled ? -1 : 0}
    onclick={() => !disabled && (set ? set(!on) : setPref(key, !on))}
    onkeydown={(e) => {
      if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        if (set) set(!on);
        else setPref(key, !on);
      }
    }}
  ><span class="knob"></span></div>
{/snippet}

<!-- A two-step button: the first press asks, the second does it. Webviews may
     block window.confirm, and a reset or a delete cannot be undone. -->
{#snippet confirmButton(armed, label, armedLabel, onpress, oncancel, disabled = false)}
  {#if armed}
    <button class="btn tiny" onclick={oncancel}>Cancel</button>
  {/if}
  <button class="btn tiny" class:danger={armed} {disabled} onclick={onpress}>{armed ? armedLabel : label}</button>
{/snippet}

<!-- The five defaults a new box is born with, for either set: yours (`v` is
     your prefs, `set` writes them) or the series' (`v` is what its boxes get,
     `set` writes its override). -->
{#snippet tsRows(v, set)}
  <div class="set-item">
    <div class="set-line">
      <span class="set-label">Auto height</span>
      {@render toggle('defaultAutoHeight', 'Auto height', v.defaultAutoHeight, false, (on) => set('defaultAutoHeight', on))}
    </div>
    <p class="set-desc">The box’s height follows its text inside the balloon.</p>
  </div>
  <div class="set-item">
    <div class="set-line">
      <span class="set-label">Hyphenate long words</span>
      {@render toggle('defaultHyphenate', 'Hyphenate long words', v.defaultHyphenate, false, (on) => set('defaultHyphenate', on))}
    </div>
    <p class="set-desc">Breaks lines to the balloon’s shape and hyphenates a word that fits nowhere. Off, lines wrap at the box edge.</p>
  </div>
  <!-- These mean nothing while hyphenation is off, so they dim with it rather
       than vanishing: a control that disappears is one nobody finds again. -->
  <div class="set-nested" class:dim={!v.defaultHyphenate}>
    <!-- The silhouette a shaped block aims for (BRK-3). Auto picks an oval in
         a balloon and a rectangle in a caption. -->
    <div class="set-item">
      <div class="set-line">
        <span class="set-label">Block shape</span>
        <div class="seg" role="group" aria-label="Block shape">
          {#each [['auto', 'Auto'], ['oval', 'Oval'], ['rect', 'Rectangle']] as [val, label]}
            <button class:on={v.defaultBlockShape === val} disabled={!v.defaultHyphenate} onclick={() => set('defaultBlockShape', val)}>{label}</button>
          {/each}
        </div>
      </div>
    </div>
    <div class="set-item">
      <div class="set-line">
        <span class="set-label">Fit text to balloon <span class="set-badge">Beta</span></span>
        {@render toggle('defaultBalloon', 'Fit text to balloon (beta)', v.defaultBalloon, !v.defaultHyphenate, (on) => set('defaultBalloon', on))}
      </div>
      <p class="set-desc">Breaks lines to the balloon’s curve instead of the box’s straight sides.</p>
    </div>
    <div class="set-item">
      <div class="set-line">
        <label class="set-label" for="ts-orphan">Shortest word left alone on a line</label>
        <input
          id="ts-orphan"
          class="set-num"
          type="number"
          min="1"
          max="8"
          step="1"
          disabled={!v.defaultHyphenate}
          value={v.defaultMinOrphan}
          title="A word shorter than this is never left alone at the end of a line"
          onchange={(e) => { set('defaultMinOrphan', Math.round(+e.currentTarget.value)); e.currentTarget.value = v.defaultMinOrphan; }}
        />
      </div>
    </div>
  </div>
{/snippet}

{#if open}
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={screenEl}
  class="settings-screen"
  role="dialog"
  aria-modal="true"
  aria-label="Settings"
  tabindex="-1"
  onkeydown={onScreenKey}
>
  <nav class="set-side" aria-label="Settings sections">
    <div class="set-side-head">
      <button class="set-back" aria-label="Close settings" title="Close (Esc)" onclick={() => (open = false)}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <h1>Settings</h1>
    </div>

    {#snippet tabButton(t)}
      <button
        role="tab"
        id="set-tab-{t.id}"
        class="set-tab"
        class:on={tab === t.id}
        aria-selected={tab === t.id}
        aria-controls="set-panel"
        tabindex={tab === t.id ? 0 : -1}
        onclick={() => selectTab(t.id)}
        onkeydown={onTabKey}
      >
        {@html t.icon}
        <span>{t.label}</span>
      </button>
    {/snippet}

    <div class="set-tabs" role="tablist" aria-orientation="vertical" aria-label="App settings, saved on this computer">
      {#each APP_TABS as t (t.id)}{@render tabButton(t)}{/each}
    </div>

    {#if project}
      <div class="set-group">
        <div class="set-group-name" id="set-group-series" title={project.name}>{project.name}</div>
        <div class="set-group-note">Saved with the series</div>
      </div>
      <div class="set-tabs" role="tablist" aria-orientation="vertical" aria-labelledby="set-group-series">
        {#each SERIES_TABS as t (t.id)}{@render tabButton(t)}{/each}
      </div>
    {/if}
  </nav>

  <main
    bind:this={panelEl}
    class="set-panel"
    id="set-panel"
    role="tabpanel"
    aria-labelledby="set-tab-{tab}"
  >
    <div class="set-column">
      <header class="set-page-head">
        <h2>{current.label}</h2>
        {#if inSeries}
          <p class="set-lead">Saved with <b>{project.name}</b>, for every chapter in it and whoever opens the folder.</p>
        {/if}
      </header>

      {#if tab === 'general'}
        <section class="settings-section">
          <h3 class="settings-title">Appearance</h3>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Theme</span>
            </div>
            <ThemePicker />
            <p class="set-desc">The app icon in the Dock and taskbar changes with it.</p>
          </div>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Panel layout</span>
              <div class="set-ctl">
                {@render confirmButton(confirmResetPanels, 'Reset', 'Reset panels', onResetPanels, () => (confirmResetPanels = false))}
              </div>
            </div>
            <p class="set-desc">Puts the Text Box Options and Text Queue windows back to their starting size and place.</p>
          </div>
        </section>

        <section class="settings-section">
          <h3 class="settings-title">Editor</h3>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Inherit previous box settings</span>
              {@render toggle('inheritBoxStyle', 'Inherit previous box settings', prefs.inheritBoxStyle)}
            </div>
            <p class="set-desc">A new box takes the previous box’s angle and text style. Off, it starts from the tag’s style.</p>
          </div>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Brush tool <span class="set-badge">Work in progress</span></span>
              {@render toggle('brushTool', 'Brush tool (work in progress)', prefs.brushTool)}
            </div>
            <p class="set-desc">Unfinished, and hidden until you turn it on.</p>
          </div>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">SFX tool <span class="set-badge">Beta</span></span>
              {@render toggle('sfxTool', 'SFX tool (beta)', prefs.sfxTool)}
            </div>
            <p class="set-desc">Draw sound effects on the page, and pick their type in Effects &gt; SFX.</p>
          </div>
        </section>

        <section class="settings-section">
          <h3 class="settings-title">Files</h3>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Library folder</span>
              <div class="set-ctl">
                <button
                  class="btn tiny"
                  disabled={!isTauri() || !!app.chapterRef}
                  title={app.chapterRef ? 'Close the open chapter first' : 'Pick a different library folder'}
                  onclick={chooseRoot}
                >Change…</button>
              </div>
            </div>
            <p class="set-desc">
              <span class="set-path" title={library.root}>{library.root || 'Not set'}</span>
              {#if app.chapterRef}<br />Close the open chapter to change it.{/if}
            </p>
          </div>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Default export folder</span>
              <div class="set-ctl">
                {#if app.exportDir}
                  <button class="btn tiny" onclick={() => { saveExportPrefs('', app.exportName); toast('Cleared default export folder'); }}>Clear</button>
                {/if}
                <button class="btn tiny" disabled={!isTauri()} onclick={onChangeExportDir}>Change…</button>
              </div>
            </div>
            <p class="set-desc">
              {#if app.exportDir}<span class="set-path" title={app.exportDir}>{app.exportDir}</span><br />{/if}
              Where Export saves unless you pick another folder at export time.{app.exportDir ? '' : ' Not set: Export asks each time.'}
              {#if !isTauri()} Choosing a folder needs the desktop app; the browser downloads to its own place.{/if}
            </p>
          </div>
        </section>
      {/if}

      {#if tab === 'typesetting'}
        <!-- The defaults a new box is born with. The line breaking used to be a
             switch per chapter, on here for new chapters and off for the ones
             made before, so every old chapter needed turning on by hand. It is
             each box's now, under one switch: "Hyphenate long words" is the
             smart breaker, and what it does is set under it. A chapter saved
             with the old switch off opens with its boxes plain, as they were
             drawn (`openTypesetting` in data.js); Bulk style changes them. -->
        <section class="settings-section">
          <h3 class="settings-title">New text boxes</h3>
          <p class="set-intro">
            What a new box starts with. Boxes already on a page keep theirs; Bulk style changes them.
            {#if seriesTs}
              <b>{project.name}</b> uses its own, set under
              <button class="set-link" onclick={() => selectTab('series')}>Series</button>; these are for every other series.
            {/if}
          </p>
          {@render tsRows(mineTs, setMine)}
        </section>

        <!-- Who measures text. Here with the rest of typesetting and not in the
             Inspector: it is one setting for the whole machine, and no box has a
             say in it. Disabled, and saying why, in a build made without the
             engine - the wasm is its own build step. -->
        <section class="settings-section" data-section="text-engine">
          <h3 class="settings-title">Text engine <span class="set-badge warn">Experimental</span></h3>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Measure text with the Rust engine</span>
              {@render toggle(
                'textEngine',
                'Measure text with the Rust engine',
                engineSwitch.available && prefs.textEngine === 'rust',
                !engineSwitch.available,
                (on) => setPref('textEngine', on ? 'rust' : 'browser'),
              )}
            </div>
            <p class="set-desc" title="Drawing is the same either way. Opening a chapter lettered before the engine changes nothing on disk; the Text Queue says what the engine would change.">
              {#if !engineSwitch.available}
                Not in this build, so text is measured by the browser.
              {:else if engineSwitch.phase === 'starting'}
                Starting: loading the engine and your fonts.
              {:else if engineSwitch.phase === 'failed'}
                Could not start - {engineSwitch.error}. Text is measured by the browser.
              {:else if engineHasNoFont()}
                Switched on, but nothing is measuring: the engine has no font it can read. Add one in the Font Library.
              {:else if engineSwitch.phase === 'on'}
                On. Line breaks and box sizes are measured from your font files; a font this computer lacks is set in {engineSwitch.lastResort}.
              {:else}
                Off: text is measured by the browser. On, line breaks come from your font files, the same on every computer.
              {/if}
            </p>
          </div>
        </section>
      {/if}

      {#if tab === 'detection'}
        <section class="settings-section">
          <h3 class="settings-title">Engine</h3>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Detection engine</span>
              <span class="set-status">
                <span class="dot {sidecarOk ? 'ok' : app.sidecar?.status === 'error' ? 'err' : 'off'}" aria-hidden="true"></span>
                {sidecarLabel}
              </span>
            </div>
            {#if sidecarOk && app.sidecar.info?.gpu_build === false}
              <p class="set-desc">
                CPU-only build. GPU acceleration needs the Linux (GPU) download, which runs on
                glibc 2.39 or newer: Ubuntu 24.04, Fedora 40, Debian 13, Arch or newer.
              </p>
            {/if}
          </div>
        </section>

        <section class="settings-section">
          <h3 class="settings-title">What Detect reads</h3>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Keep text that is already English</span>
              {@render toggle('keepEnglish', 'Keep text that is already English', prefs.keepEnglish)}
            </div>
            <p class="set-desc">Off: English lettering on the raw is not detected.</p>
          </div>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Check Japanese with a second reader</span>
              {@render toggle('secondReader', 'Check Japanese with a second reader', prefs.secondReader)}
            </div>
            <p class="set-desc">Reads each line again with PP-OCRv6 (77 MB) and lists the lines where the two readers differ.</p>
          </div>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Find bubbles</span>
              {@render toggle('secondDetector', 'Find bubbles', prefs.secondDetector)}
            </div>
            <p class="set-desc">A second detector (RT-DETR, 168 MB) finds the bubbles and tells text in a bubble from text on the art. It also finds text the main detector misses.</p>
          </div>
        </section>

        <section class="settings-section">
          <h3 class="settings-title">Text readers</h3>
          <p class="set-intro">The reader that turns each detected bubble into text, for each source language. A new choice downloads on the next Detect; the series’ language is not changed.</p>
          {#each [['ja', 'Japanese'], ['zh', 'Chinese'], ['ko', 'Korean']] as [lang, langName] (lang)}
            <div class="set-item">
              <div class="set-line"><span class="set-label">{langName}</span></div>
              <ReaderChoice language={lang} />
            </div>
          {/each}
        </section>

        <section class="settings-section">
          <h3 class="settings-title">Downloaded models</h3>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">
                On disk
                <span class="set-label-sub">
                  {#if cacheLoading}Measuring…{:else if cache}{fmtBytes(cache.total_bytes)}{:else}Unknown - desktop app only{/if}
                </span>
              </span>
              <div class="set-ctl">
                <button class="btn tiny" disabled={cacheLoading || !isTauri()} onclick={loadCache}>Recheck</button>
                {@render confirmButton(
                  confirmClear,
                  clearing ? 'Clearing…' : 'Clear',
                  'Delete the models',
                  onClearCache,
                  () => (confirmClear = false),
                  clearing || !sidecarOk || !cache || cache.total_bytes === 0,
                )}
              </div>
            </div>
            {#if cache?.entries?.length}
              <ul class="set-list">
                {#each cache.entries as e}
                  <li><span class="set-path" title={e.path}>{e.path}</span><span class="set-num-out">{e.exists ? fmtBytes(e.bytes) : '-'}</span></li>
                {/each}
              </ul>
            {/if}
            <p class="set-desc">
              Clearing frees the space; they download again on the next Detect.
              {#if !sidecarOk} The detection engine is not answering, so clearing needs the desktop app.{/if}
            </p>
          </div>
        </section>
      {/if}

      {#if tab === 'ai'}
        <section class="settings-section">
          <h3 class="settings-title">Access</h3>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Let AI agents use this app</span>
              {@render toggle('agentDoor', 'Let AI agents use this app', door.on, !isTauri(), (on) => setDoorOn(on))}
            </div>
            <p class="set-desc">Claude Code, Codex or Antigravity can then typeset through the app. It listens on 127.0.0.1 only, and every request needs the token.</p>
          </div>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Status</span>
              <span class="set-status">
                <span class="dot {isTauri() && door.running ? 'ok' : isTauri() && door.error ? 'err' : 'off'}" aria-hidden="true"></span>
                {#if !isTauri()}Needs the desktop app
                {:else if door.running}Listening on {doorUrl(door.port)}
                {:else if door.on && !door.error}Starting…
                {:else}Off{/if}
              </span>
            </div>
            {#if isTauri() && door.error}
              <p class="set-desc set-error">{door.error}</p>
            {/if}
          </div>
          <div class="set-item">
            <div class="set-line">
              <label class="set-label" for="ai-port">Port</label>
              <input
                id="ai-port"
                class="set-num"
                type="number"
                min="1024"
                max="65535"
                step="1"
                aria-label="Port"
                placeholder={String(DEFAULT_PORT)}
                value={door.port}
                onchange={onDoorPort}
              />
            </div>
          </div>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Token</span>
              <div class="set-ctl">
                <button class="btn tiny" onclick={onNewToken}>Make a new token</button>
              </div>
            </div>
            <p class="set-desc">Every connected agent must paste its line again.</p>
          </div>
        </section>

        <section class="settings-section">
          <h3 class="settings-title">Connect</h3>
          <p class="set-intro">Paste the line for your agent. Each line carries the port and the token.</p>
          {#each connectBlocks as b (b.id)}
            <div class="set-item set-connect">
              <div class="set-connect-name">{b.name}</div>
              {#each b.lines as l (l.label)}
                {#if l.note}<p class="set-desc set-connect-note">{l.note}</p>{/if}
                <div class="set-code-row">
                  <pre class="set-code" aria-label={l.label}>{l.text}</pre>
                  <button class="btn tiny" aria-label="Copy {l.label}" onclick={() => copyLine(l.text)}>Copy</button>
                </div>
              {/each}
            </div>
          {/each}

          <div class="set-note" role="note">
            <div class="set-note-title">Keep Claude Code to our tools</div>
            <p class="set-desc">
              Page text (OCR and translations) can carry instructions, and a Claude
              Code session can run commands. Start it this way so our tools are all
              it has.
            </p>
            <div class="set-code-row">
              <pre class="set-code" aria-label="Safe Claude Code start">{lines.claudeSafe}</pre>
              <button class="btn tiny" aria-label="Copy Safe Claude Code start" onclick={() => copyLine(lines.claudeSafe)}>Copy</button>
            </div>
          </div>
        </section>
      {/if}

      {#if tab === 'shortcuts'}
        <ShortcutSettings />
      {/if}

      {#if tab === 'about'}
        <section class="settings-section">
          <h3 class="settings-title">Updates</h3>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">
                Pear
                <span class="set-label-sub">
                  {#if appVersion}Version {appVersion}
                  {:else if isTauri()}Reading version…
                  {:else}Desktop app only - a browser tab cannot update itself.{/if}
                </span>
              </span>
              <div class="set-ctl">
                {#if upd}
                  <button class="btn tiny btn-accent" onclick={() => (updDialogOpen = true)}>Update to v{upd.version}</button>
                {/if}
                <button class="btn tiny" disabled={checking || !isTauri()} onclick={onCheckUpdate}>
                  {checking ? 'Checking…' : 'Check for updates'}
                </button>
              </div>
            </div>
            <p class="set-desc">
              {#if updError}Check failed: {updError}
              {:else if upd === false}You are on the newest version.
              {:else}A found update downloads and installs in place, then the app restarts.{/if}
            </p>
          </div>
        </section>

        <section class="settings-section">
          <h3 class="settings-title">Memory</h3>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">
                In use
                <span class="set-label-sub">
                  {#if !mem}Desktop app only - a browser tab cannot see its own host process.
                  {:else if !mem.supported}Not available on this platform.
                  {:else}{fmtBytes(mem.total)} across {mem.processes.length} process{mem.processes.length === 1 ? '' : 'es'}{/if}
                </span>
              </span>
              <div class="set-ctl">
                <button class="btn tiny" disabled={!isTauri()} onclick={loadMemory}>Refresh</button>
                <button class="btn tiny" class:btn-accent={memLive} disabled={!isTauri()} onclick={() => (memLive = !memLive)}>
                  {memLive ? 'Stop live' : 'Live'}
                </button>
              </div>
            </div>
            {#if mem?.supported && mem.processes.length}
              <ul class="set-list">
                {#each mem.processes as pr (pr.pid)}
                  <li>
                    <span class="set-path" title="{pr.name} · pid {pr.pid} · matched by {pr.via}">{ROLE_LABELS[pr.role] ?? pr.name}</span>
                    <span class="set-num-out">{fmtBytes(pr.bytes)}</span>
                  </li>
                {/each}
              </ul>
            {/if}
            <p class="set-desc" title="Physical footprint, not RSS. The web view holds the page images, so it is the row that grows with a long chapter.">
              The same measure as Activity Monitor’s Memory column.
              {#if mem?.supported && mem?.incomplete} A process went away while being measured, so the total is short.{/if}
              {#if mem?.processes?.some((pr) => pr.via === 'session')} Web view rows are matched by launch session: this is a development build started from a terminal.{/if}
            </p>
          </div>
        </section>

        {#if DEV}
          <section class="settings-section">
            <h3 class="settings-title">Developer</h3>
            <div class="set-item">
              <div class="set-line">
                <span class="set-label">
                  PSD export self-test
                  <span class="set-label-sub">Runs on the page you have open</span>
                </span>
                <div class="set-ctl">
                  <button class="btn tiny" disabled={selfTesting || !app.pages.length} onclick={onPsdSelfTest}>
                    {selfTesting ? 'Running…' : 'Run self-test'}
                  </button>
                </div>
              </div>
              <p class="set-desc">
                Builds a PSD from the current page, reads it back, and checks the
                round-tripped project, the per-layer pixels, the flat-white
                composite and the group structure.
                {#if !app.pages.length} Open a chapter first.{/if}
              </p>
              {#if selfTest}
                <pre class="set-code set-report" class:bad={!selfTest.ok}>{JSON.stringify(selfTest, null, 2)}</pre>
              {/if}
            </div>
          </section>
        {/if}
      {/if}

      {#if tab === 'series' && project}
        <section class="settings-section">
          <h3 class="settings-title">Pages</h3>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Source language</span>
              <div class="seg" role="group" aria-label="Source language">
                {#each [['ja', 'Japanese'], ['zh', 'Chinese'], ['ko', 'Korean']] as [v, label]}
                  <button
                    class:on={project.ocrLanguage === v}
                    disabled={changingLanguage}
                    onclick={() => onLanguage(v)}
                  >{label}</button>
                {/each}
              </div>
            </div>
            <p class="set-desc">What Detect reads on this series’ pages. Text already read is left as it is. The reader for each language is under Detection.</p>
          </div>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Layout</span>
              <span class="set-value">{project.layout === 'longstrip' ? 'Longstrip' : 'Pages'}</span>
            </div>
            <p class="set-desc">Set when the series was made. Longstrip pages are slices of one long image, so the two cannot be swapped.</p>
          </div>
        </section>

        <section class="settings-section">
          <h3 class="settings-title">New text boxes</h3>
          <div class="set-item">
            <div class="set-line">
              <span class="set-label">Own typesetting defaults</span>
              {@render toggle('seriesTypeset', 'Own typesetting defaults', !!seriesTs, false, useSeriesTs)}
            </div>
            <p class="set-desc">
              {#if seriesTs}This series starts new boxes with the settings below, not yours from Typesetting.
              {:else}Off: this series uses yours from Typesetting. On, it starts from a copy of them.{/if}
            </p>
          </div>
          {#if seriesTs}{@render tsRows(seriesValues, setSeries)}{/if}
        </section>
      {/if}

      {#if tab === 'styles' && project}
        <!-- Every look a box starts with, in one list: a font per kind of text,
             the user's own styles under each kind, and the characters' voices
             under Speech. Then how far the AI may go past them. -->
        <TextStyles />
        <LetteringSetup />
      {/if}

      {#if tab === 'guide' && project}
        <!-- The series guide (docs/AI_TYPESETTING_PLAN.md section 4), in
             project.json beside the text styles. -->
        <SeriesGuide />
      {/if}
    </div>
  </main>
</div>
{/if}

<!-- The same dialog the home badge opens, mounted here too so a check made
     from Settings lands somewhere. -->
<UpdateDialog bind:open={updDialogOpen} update={upd || null} />

<style>
  /* The layout and the row grammar (.settings-screen, .set-*) are global, in
     styles.css, because TextStyles, LetteringSetup and SeriesGuide draw their
     rows into this screen with the same classes. What is here is this file's
     own. */
  .btn.danger {
    background: color-mix(in srgb, var(--warn) 16%, transparent);
    border-color: var(--warn);
    color: var(--warn);
    font-weight: 600;
  }

  .set-status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-size: 12px;
    color: var(--t2);
    overflow-wrap: anywhere;
    text-align: right;
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--t3);
  }
  .dot.ok {
    background: var(--text);
  }
  .dot.err {
    background: var(--warn);
  }
  .set-error {
    color: var(--warn);
  }

  /* AI agents. The lines are what the user pastes, token and all, so they wrap
     rather than scroll: the whole line is always in sight, and the column never
     grows sideways. */
  .set-connect {
    padding: 12px 0 14px;
  }
  .set-connect-name {
    font-size: 12.5px;
    font-weight: 500;
    margin-bottom: 8px;
  }
  .set-connect-note {
    padding: 0 0 6px;
    margin: 0;
  }
  .set-code-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .set-code-row + .set-connect-note {
    margin-top: 10px;
  }
  .set-code-row .btn {
    flex: none;
  }
  .set-code {
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .set-report {
    max-height: 220px;
    overflow: auto;
    white-space: pre;
    margin-bottom: 12px;
    color: var(--t2);
  }
  .set-report.bad {
    color: var(--warn);
  }
  .set-note {
    margin-top: 20px;
    padding: 14px 16px 16px;
    border: 1px solid color-mix(in srgb, var(--warn) 55%, var(--line));
    border-radius: 8px;
    background: color-mix(in srgb, var(--warn) 6%, transparent);
  }
  .set-note-title {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--warn);
    margin-bottom: 4px;
  }
  .set-note .set-desc {
    padding-bottom: 10px;
  }

  /* Downloaded files and memory: name on the left, size on the right. */
  .set-list {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .set-list li {
    display: flex;
    align-items: baseline;
    gap: 12px;
    font-size: 11.5px;
  }
  .set-list .set-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .set-num-out {
    flex: none;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
</style>
