// ===== App preferences =====
// Preferences that belong to the person, not to a document: they survive a
// chapter close and are never written into a saved file - the defaults a new
// text box is born with, and the keyboard rebindings. The
// shape is one `$state` object, one localStorage key holding all of it, and a
// single setter, so a preference can never be changed without being persisted
// and applied in the same breath.
//
// The module APPLIES on import, not on some `initPrefs()` call, because what it
// feeds is read the moment a box or a chapter is made. App.svelte imports it at
// boot for exactly that reason.
//
// Both consumers are leaves or near-leaves and neither imports this module back,
// which is what keeps that import-time apply safe: nothing here can run before
// the module it is writing into has finished evaluating.
import { setBoxDefaults, setLegacyTypeset, setFxDefaults, normalizeFxDefaults, fxStored } from './data.js';
import { app, setTool, setBrushToolAllowed, setHomeTool, setMinFontSize, setInheritBoxStyle } from './store.svelte.js';
import { normalizeOcrModels } from './ocr-models.js';
import { cleanCategories } from './font-categories.js';
import { useTextEngine } from './engine-switch.svelte.js';
import { setPaintWorkerAllowed } from './text-engine/paint-mirror.js';
import { setTextEdges } from './text-edges.svelte.js';
import { guide, onSeriesTypeset, SERIES_TYPESET_KEYS } from './guide.svelte.js';
import { setLayouts, adoptLayouts, snapshotLayouts, onLayoutsChange, normalizeLayouts } from './layouts.svelte.js';

const KEY = 'mt.prefs';

// Not a preference: what this machine laid chapters out with before a chapter
// carried its own line breaker (DET-3), for the chapters that still do not.
// 'smart' only when the stored blob said `typeset: true` - the user turned the
// beta on - the first time a build with the field ran. Frozen from then on and
// saved in the same blob. The `typeset` key itself (the old new-chapter
// switch) is only ever read for this; nothing sets it any more.
let legacyTypeset = 'plain';

// Which set of defaults the stored blob was written under. Every write stores
// every key, so a blob carries the defaults of its day written out as values,
// and a default changed since would never reach anyone who had ever touched a
// setting. A blob from before a revision has that revision's changes made
// once, in `load`; the stamp says they are made.
//   1  2026-10-20: "Fit text to balloon" is a beta and starts off; the Rust
//      engine measures text.
//   2  2026-11-03: the second detector is on. It tells text in a bubble from
//      text on the art and finds the bubbles, which placement now relies on.
//   3  2026-11-08: the effects' own defaults (`fxDefaults`, Make Default). A
//      blob from before has none, which is the factory's answer: nothing to
//      change. Each stored default is read through `normalizeFxDefaults`, so
//      a default saved by an older build takes today's fields.
//   4  2026-11-10: the first-run setup. An install from before it is already
//      set up and is a comics install, so it never sees the setup and keeps
//      every comic tool and word. New chapters start as Translate on a new
//      install; one from before keeps Typeset, which is what it always did.
const DEFAULTS_REV = 4;
// The engine a build starts on: the Rust engine, unless the build says
// otherwise (`VITE_MT_TEXT_ENGINE=browser`; the test lanes do, and measure
// with the engine only where a test asks for it).
const ENGINE_DEFAULT = import.meta.env?.VITE_MT_TEXT_ENGINE === 'browser' ? 'browser' : 'rust';

export const prefs = $state({
  // The brush drawing tool (work in progress). Off by default until ready.
  brushTool: false,
  // The SFX tab of the Text box options (beta). On by default; turned off,
  // the tab goes, and boxes that have SFX keep it. The key keeps its old
  // name (it was the SFX tool's), so a stored choice still reads.
  sfxTool: true,
  // The plain mouse wheel zooms at the pointer in a paged chapter. Off, it
  // scrolls, and Ctrl/Cmd + wheel zooms (always, in either case).
  wheelZoom: true,
  // How the raw page is seen while typesetting: 'side', the reference column
  // beside the page; 'peek', no column, and the page itself swaps to the raw
  // from a button or a held key, the way a translate chapter does.
  rawView: 'side',
  // Place and Text tools can start from defaults instead of the last box's style.
  inheritBoxStyle: true,
  // ---- typesetting defaults for NEW text boxes ----
  // These five are per-BOX style properties (`style.autoHeight`, `style.shape`
  // and friends - see `defaultStyle` in data.js). What lives here is only the
  // value a box is BORN with; once a box exists its own style is what answers,
  // and a bulk edit is how one is changed after the fact. The Inspector used to
  // carry a switch per box for each of them, which put five engine settings in
  // front of someone trying to move a bubble; they are one set of defaults, so
  // they are set once, here.
  //
  // Their starting values are exactly `defaultStyle()`'s, which is what makes
  // an absent key in storage indistinguishable from a fresh install.
  defaultAutoHeight: true,
  // Smart line breaking, under its one switch: "Hyphenate long words". On, a
  // box is born with the shaped breaker (`style.shape` is the block shape
  // beside it, BRK-3), hyphenation, and the balloon fit and orphan threshold
  // below; off, with the plain wrap (`shape: 'off'`), no hyphenation and no
  // balloon layout. `applyBoxDefaults` does the translation.
  defaultHyphenate: true,
  defaultBlockShape: 'auto',
  // "Fit text to balloon" (beta): lines broken to the balloon's rows. Off by
  // default.
  defaultBalloon: false,
  defaultMinOrphan: 3,
  // The smallest size, in page px, the fit ladder may shrink a box's text to
  // when it does not fit (see `autoFitBox` in the store). The ladder's working
  // floor is relative - three quarters of the size the box's tag is set at - and
  // this is the absolute one under it, for a tag that is small to begin with.
  // 12: scan pages are mostly 1100-1600px wide and read fit-to-width at around
  // 700-1000 CSS px, which puts 12 page px at 7-8px on screen - the bottom of
  // what anything sets text at to be read rather than glanced at. Past that the
  // ladder would be trading an overflow it can report for text nobody can read,
  // and the flag is the better failure. No Settings control: it is a guard rail
  // for the machine, not a style anyone is choosing.
  minFontSize: 12,
  // Keyboard shortcut overrides, as { shortcutId: combo }. Only the ones the
  // user changed are in here; everything else answers to its default, so a
  // build that moves a default moves it for everyone who never rebound it.
  // The vocabulary of ids and the combo spelling both live in shortcuts.svelte.js.
  shortcuts: {},
  // ---- which fonts the menus offer ----
  // Two lists of family names, and deliberately not one list of "visible fonts":
  // a built-in is offered until the user hides it, a font installed on this
  // machine is hidden until the user shows it, so each list holds only the
  // exceptions and a fresh install has both empty. A hidden family still draws -
  // a box already set in it keeps its face - it just stops being offered. Both
  // are machine preferences, not document facts: the system list describes this
  // computer, and another machine's copy of the chapter has its own.
  hiddenBuiltinFonts: [],
  shownSystemFonts: [],
  // The user's own families switched off in the Font Library: still in the
  // library, still drawn by any box set in them, just not offered. Exceptions
  // again - a font the user adds is on.
  disabledUserFonts: [],
  // The font marketplaces the user added, as [{ url, name }]: a JSON manifest
  // each (docs/FONT_MARKETPLACE.md). Only the addresses; what they list is
  // fetched when the user asks.
  fontMarketplaces: [],
  // The user's own groups of their families in the Font Library, as
  // [{ id, name, families: [name] }] (font-categories.js). A family can be in
  // several or in none.
  fontCategories: [],
  // The families last picked in a font picker, newest first (`noteRecentFont`
  // in font-menu.js). A machine preference like the two above.
  recentFonts: [],
  // Recognition quality/size is a preference of this installation, separate
  // for each project language. Project files continue to store only language.
  ocrModels: normalizeOcrModels(null),
  // Keep Latin lettering on the raw in the detection queue as well.
  keepEnglish: false,
  // Japanese pages read again with PP-OCRv6 (OCR-1): about twice the OCR
  // time and a one-off model download, so off until asked for.
  secondReader: false,
  // A second detector (DTC-2, RT-DETR) votes with the first and says which
  // text sits in a bubble. A 168 MB download, so off until asked for.
  secondDetector: true,
  // Who measures text: 'rust', the Rust text engine on the user's own font
  // files (engine-switch.svelte.js), or 'browser', as the app did before it.
  // A machine preference like the rest: it says how this computer measures,
  // and a chapter carries nothing of it. A build without the engine measures
  // with the browser whatever this says (`start`).
  textEngine: ENGINE_DEFAULT,
  // A box's full paint in a Web Worker (text-engine/paint-mirror.js), so the
  // window does not wait for it. Off, every box paints on the main thread as
  // before; read when the engine starts, and before each paint. No Settings
  // control: a way out without a rebuild.
  paintWorker: true,
  // How letter edges sit on the pixel grid: 'smooth' exactly where the outline
  // falls, 'crisp' with each line's baseline, x-height and cap height on whole
  // page pixels (text-edges.svelte.js). Rust engine only. Per machine, like
  // the engine switch.
  textEdges: 'smooth',
  // The layer effects' own defaults (Photoshop's Make Default), one per kind
  // (`FX_KINDS` in data.js), in the stored form `fxStored` gives. Only the
  // kinds the person saved are here; the rest start from the factory. Per
  // person, as Photoshop's are: never in a chapter or a series.
  fxDefaults: {},
  // True once the first-run setup has been finished or skipped.
  onboarded: false,
  // What the person said they use the app for: 'comics' keeps every comic tool
  // and word, 'general' hides the comic tools (`isComics`, words.js).
  usage: 'comics',
  // The mode a new chapter starts in. Translate for a new comics install (the
  // owner's choice, 2026-11-10); an install from before revision 4 keeps
  // Typeset (`load`). General use never starts a translate chapter, whatever
  // this says.
  defaultChapterMode: 'translate',
  // The source language a new series starts with. The codes are the ones a
  // project stores (`OCR_LANGUAGES` in store.svelte.js).
  defaultOcrLanguage: 'ja',
});

// One gate for every comic-only tool and word.
export function isComics() { return prefs.usage !== 'general'; }

// The mode a new chapter starts in, and the only reader of
// `defaultChapterMode`: general use has no translate chapters to start, so it
// is always typeset there whatever the stored pref says.
export function startMode() { return isComics() ? prefs.defaultChapterMode : 'typeset'; }

// SFX is a comic tool: general use treats it as off without changing the
// stored switch, so switching back to comics brings it back.
export function sfxToolOn() { return prefs.sfxTool && isComics(); }

// What the usage changes outside this module, applied at load and on every
// change of usage. Only what is shown and which tool is
// in hand: no chapter, box or setting is touched. General use starts on the
// Text tool, since the Place tool places detected lines it does not have.
// That switch is made only when the usage itself is new (`usageNew`), so a
// general user who picks the Place tool keeps it when some other pref changes.
function applyUsage(usageNew) {
  setHomeTool(isComics() ? 'place' : 'text');
  if (usageNew && !isComics() && app.tool === 'place') setTool('text');
}

// The two font lists are string arrays; anything else in them is dropped.
const NAME_LIST_KEYS = ['hiddenBuiltinFonts', 'shownSystemFonts', 'disabledUserFonts', 'recentFonts'];
const cleanNames = (v) =>
  Array.isArray(v) ? [...new Set(v.filter((n) => typeof n === 'string' && n.trim()))] : null;
// [{ url, name }], https addresses only, one entry per address.
const MAX_MARKETS = 50;
function cleanMarkets(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const m of v) {
    const url = typeof m?.url === 'string' ? m.url.trim() : '';
    if (!/^https?:\/\//i.test(url) || out.some((o) => o.url === url)) continue;
    out.push({ url, name: typeof m.name === 'string' ? m.name.slice(0, 120) : '' });
    if (out.length >= MAX_MARKETS) break;
  }
  return out;
}

// The box defaults, split by what a value of theirs may be. Named once so the
// setter's validation and the loader's validation cannot drift apart.
const BOOL_KEYS = ['defaultAutoHeight', 'defaultHyphenate', 'defaultBalloon', 'brushTool', 'sfxTool', 'wheelZoom', 'inheritBoxStyle', 'keepEnglish', 'secondReader', 'secondDetector', 'paintWorker', 'onboarded'];
const NUM_KEYS = { defaultMinOrphan: [1, 8], minFontSize: [4, 48] };
const ENUM_KEYS = { defaultBlockShape: ['auto', 'oval', 'rect'], textEngine: ['browser', 'rust'], textEdges: ['smooth', 'crisp'],
  usage: ['comics', 'general'],
  rawView: ['side', 'peek'],
  defaultChapterMode: ['typeset', 'translate'],
  defaultOcrLanguage: ['ja', 'zh', 'ko'],
};

// Push the box defaults to where a box is actually born. The store seeds a new
// box's style through `applyBoxDefaults` in data.js, and data.js is a leaf - it
// imports nothing - so it cannot read `prefs` itself. The preference is stored
// here and MIRRORED into the module that consumes it, by the one function that
// is allowed to write a preference, so the copy can never be a version behind.
//
// A series may override them (FLOW-13): the open project's guide holds its own
// values for some or all of the five, and those win while it is open. The
// person's own stay as they are, underneath, for every other series. The
// guide tells this module when the override changes - a project opened or
// closed, or edited in Settings - since it cannot import this one back.
export function typesetDefaults() {
  const out = {};
  for (const k of Object.keys(SERIES_TYPESET_KEYS)) out[k] = guide.typeset?.[k] ?? prefs[k];
  return out;
}

function applyBoxDefaults() {
  // One switch for the line breaking, translated once, at the edge, so nothing
  // downstream has to know: off is the plain wrap whatever the rest say.
  const d = typesetDefaults();
  const smart = d.defaultHyphenate;
  setBoxDefaults({
    autoHeight: d.defaultAutoHeight,
    shape: smart ? d.defaultBlockShape : 'off',
    hyphenate: smart,
    balloon: smart && d.defaultBalloon,
    minOrphan: d.defaultMinOrphan,
  });
}
onSeriesTypeset(applyBoxDefaults);

function persist() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        defaultAutoHeight: prefs.defaultAutoHeight,
        defaultBlockShape: prefs.defaultBlockShape,
        defaultHyphenate: prefs.defaultHyphenate,
        defaultBalloon: prefs.defaultBalloon,
        defaultMinOrphan: prefs.defaultMinOrphan,
        minFontSize: prefs.minFontSize,
        brushTool: prefs.brushTool,
        sfxTool: prefs.sfxTool,
        wheelZoom: prefs.wheelZoom,
        rawView: prefs.rawView,
        inheritBoxStyle: prefs.inheritBoxStyle,
        shortcuts: $state.snapshot(prefs.shortcuts),
        hiddenBuiltinFonts: $state.snapshot(prefs.hiddenBuiltinFonts),
        shownSystemFonts: $state.snapshot(prefs.shownSystemFonts),
        disabledUserFonts: $state.snapshot(prefs.disabledUserFonts),
        fontMarketplaces: $state.snapshot(prefs.fontMarketplaces),
        fontCategories: $state.snapshot(prefs.fontCategories),
        ocrModels: $state.snapshot(prefs.ocrModels),
        keepEnglish: prefs.keepEnglish,
        secondReader: prefs.secondReader,
        secondDetector: prefs.secondDetector,
        textEngine: prefs.textEngine,
        paintWorker: prefs.paintWorker,
        textEdges: prefs.textEdges,
        fxDefaults: $state.snapshot(prefs.fxDefaults),
        onboarded: prefs.onboarded,
        usage: prefs.usage,
        defaultChapterMode: prefs.defaultChapterMode,
        defaultOcrLanguage: prefs.defaultOcrLanguage,
        // The editor's layouts (layouts.svelte.js): which panes each kind of
        // chapter opens with, and the custom one.
        layouts: snapshotLayouts(),
        legacyTypeset,
        defaultsRev: DEFAULTS_REV,
      }),
    );
  } catch {
    /* ignore - a preference that cannot be stored just starts at its default next launch */
  }
}

export function setPref(key, value) {
  if (!(key in prefs)) return;
  // The one non-boolean, non-numeric preference. A caller handing this anything
  // but a plain object would leave every shortcut lookup reading properties off
  // a number - and an array is an object too, but not the kind of map this is.
  if (key === 'shortcuts' && (!value || typeof value !== 'object' || Array.isArray(value))) return;
  if (key === 'ocrModels') value = normalizeOcrModels(value);
  if (key === 'fxDefaults') value = normalizeFxDefaults(value);
  if (NAME_LIST_KEYS.includes(key)) {
    value = cleanNames(value);
    if (!value) return;
  }
  if (key === 'fontMarketplaces') {
    value = cleanMarkets(value);
    if (!value) return;
  }
  if (key === 'fontCategories') {
    value = cleanCategories(value);
    if (!value) return;
  }
  // A number preference is stored as a number in range or not at all: a NaN from
  // a half-typed field would reach the line breaker as a threshold nothing can
  // satisfy, and it would be persisted as `null`.
  if (key in NUM_KEYS) {
    const [lo, hi] = NUM_KEYS[key];
    const n = Math.round(+value);
    if (!Number.isFinite(n)) return;
    value = Math.min(hi, Math.max(lo, n));
  } else if (BOOL_KEYS.includes(key)) {
    value = !!value;
  } else if (key in ENUM_KEYS && !ENUM_KEYS[key].includes(value)) {
    return;
  }
  prefs[key] = value;
  // Applying is part of setting. Nothing else in the app watches `prefs`, so a
  // caller that only wrote the field would leave the engine on the old answer.
  // Turning the brush tool off falls back to the start tool so brush mode
  // disarms cleanly.
  if (key === 'brushTool') {
    setBrushToolAllowed(!!value);
    if (!value && app.tool === 'brush') {
      setTool(isComics() ? 'place' : 'text');
    }
  }
  if (key === 'usage') applyUsage(true);
  // The raw is seen one way at a time: leaving the peek puts the page back.
  if (key === 'rawView' && value !== 'peek') app.viewRaw = false;
  // Mirrored into the store the way the box defaults are mirrored into data.js.
  // No relayout: it bounds what the next fit may do, and moves nothing already
  // on the page.
  if (key === 'minFontSize') setMinFontSize(value);
  if (key === 'inheritBoxStyle') setInheritBoxStyle(value);
  // The one preference that re-measures everything, and it does so itself:
  // the engine is swapped and every box laid out again once it is in.
  if (key === 'textEngine') useTextEngine(value);
  if (key === 'paintWorker') setPaintWorkerAllowed(value);
  if (key === 'textEdges') setTextEdges(value);
  // Mirrored into data.js, where every new effect is made.
  if (key === 'fxDefaults') setFxDefaults(value);
  // No relayout for these: they are what the NEXT box is born with, and boxes
  // already on the page keep the flags they carry. Re-measuring here would be
  // re-measuring nothing.
  if (key.startsWith('default')) applyBoxDefaults();
  persist();
}

// Read whatever is on disk. Only booleans we know about are taken - a value
// written by a newer build, or a corrupt blob, leaves the defaults standing.
function load() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    /* ignore */
  }
  if (!saved || typeof saved !== 'object') saved = null;
  // Key by key, and only a value of the right type is taken. A build that never
  // wrote the box defaults leaves every one of them absent, and absent is the
  // fresh-install answer - which is `defaultStyle()`'s answer, so a chapter made
  // before this preference existed keeps behaving the way it did.
  for (const k of BOOL_KEYS) {
    if (saved && typeof saved[k] === 'boolean') prefs[k] = saved[k];
  }
  // A blob from before the line breaking had one switch: "Shaped line breaks"
  // off was the plain wrap, which is that switch off now.
  if (saved?.defaultShape === false) prefs.defaultHyphenate = false;
  for (const [k, [lo, hi]] of Object.entries(NUM_KEYS)) {
    const n = saved && typeof saved[k] === 'number' ? Math.round(saved[k]) : NaN;
    if (Number.isFinite(n)) prefs[k] = Math.min(hi, Math.max(lo, n));
  }
  for (const [k, values] of Object.entries(ENUM_KEYS)) {
    if (saved && values.includes(saved[k])) prefs[k] = saved[k];
  }
  // Shortcut overrides are a string->string map and nothing else; a value of
  // any other shape is dropped rather than handed to the key matcher. What is
  // loaded here is still only shape-checked: whether an id means anything and
  // whether a combo can fire is the registry's business, and shortcuts.svelte.js
  // prunes both once its tables exist.
  if (
    saved &&
    typeof saved === 'object' &&
    saved.shortcuts &&
    typeof saved.shortcuts === 'object' &&
    !Array.isArray(saved.shortcuts)
  ) {
    const clean = {};
    for (const [id, combo] of Object.entries(saved.shortcuts)) {
      // '' is a key the user took away; whitespace is nothing at all.
      if (typeof id === 'string' && typeof combo === 'string' && (combo === '' || combo.trim())) clean[id] = combo;
    }
    prefs.shortcuts = clean;
  }
  for (const k of NAME_LIST_KEYS) {
    const names = saved ? cleanNames(saved[k]) : null;
    if (names) prefs[k] = names;
  }
  const markets = saved ? cleanMarkets(saved.fontMarketplaces) : null;
  if (markets) prefs.fontMarketplaces = markets;
  const categories = saved ? cleanCategories(saved.fontCategories) : null;
  if (categories) prefs.fontCategories = categories;
  prefs.ocrModels = normalizeOcrModels(saved?.ocrModels);
  // No `layouts` at all (every blob from before them) is the presets: a
  // translate chapter opens as the page and the typing pane, a typeset one
  // with its tools and floating panels, as they always did.
  setLayouts(saved?.layouts);
  // Each kind read on its own: one unreadable default is dropped (that effect
  // starts from the factory), the rest stand.
  const fx = normalizeFxDefaults(saved?.fxDefaults);
  prefs.fxDefaults = fx;
  setFxDefaults(fx);
  // A blob written under older defaults (`DEFAULTS_REV`). Nothing is written
  // here: the next write stamps it, and until then each launch makes the same
  // change to the same blob.
  if (saved && !(saved.defaultsRev >= 1)) {
    prefs.defaultBalloon = false;
    prefs.textEngine = 'rust';
  }
  if (saved && !(saved.defaultsRev >= 2)) prefs.secondDetector = true;
  // Revision 4: a blob from before the first-run setup belongs to an install
  // that is already set up, and every install before it was comics only.
  if (saved && !(saved.defaultsRev >= 4)) {
    prefs.onboarded = true;
    prefs.usage = 'comics';
    prefs.defaultChapterMode = 'typeset';
  }
  // No blob at all is either a fresh install or an old one from before the app
  // wrote preferences; the library root, the theme and the tag list tell them
  // apart. A fresh install is the one case where `load` writes: the setup's
  // theme step stores the theme key, so without a blob of its own a person who
  // quit halfway would look like an existing install on the next launch and
  // never see the setup again. This is a deliberate exception to the "nothing
  // is written here" note above.
  let freshInstall = false;
  if (!saved) {
    let existing = false;
    try {
      existing = ['mt.libraryRoot', 'mt.theme', 'mt.tags'].some((k) => localStorage.getItem(k) !== null);
    } catch {
      /* a storage that throws is a fresh install that cannot remember */
    }
    if (existing) {
      prefs.onboarded = true;
      prefs.usage = 'comics';
      prefs.defaultChapterMode = 'typeset';
    } else {
      freshInstall = true;
    }
  }
  // Read before anything this session can persist, so the blob it reads is the
  // one the last build left. Until the first write stamps it, every launch
  // derives the same answer from the same unchanged blob.
  legacyTypeset =
    saved?.legacyTypeset === 'smart' || saved?.legacyTypeset === 'plain'
      ? saved.legacyTypeset
      : saved?.typeset === true
        ? 'smart'
        : 'plain';
  setLegacyTypeset(legacyTypeset);
  applyBoxDefaults();
  setMinFontSize(prefs.minFontSize);
  setBrushToolAllowed(prefs.brushTool);
  applyUsage(true);
  setInheritBoxStyle(prefs.inheritBoxStyle);
  // Before the engine starts: the worker starts with it, or not at all.
  setPaintWorkerAllowed(prefs.paintWorker);
  setTextEdges(prefs.textEdges);
  // Here and not at first use: a chapter can open before anything asks, and
  // the engine has to be standing in the way of its first fit by then. A
  // no-op for 'browser', which is every install that never touched the switch.
  // The Font Library's own window lays out no text, and the engine would hold
  // a copy of every font there for nothing (main.js says which window it is).
  if (globalThis.__MT_WINDOW__ !== 'fonts') useTextEngine(prefs.textEngine);
  if (freshInstall) persist();
}

// Other windows (an agent's chapter window, a second main window) load the
// blob once and write all of it back on their next change. Without this, a
// window that loaded while the setup was open would write back
// `onboarded: false` and the old usage over what the setup just chose. Only
// the setup's four are adopted, each checked the way `load` checks it: the
// rest are this window's own until it writes them. Nothing is persisted
// here, so two windows cannot echo a change back and forth.
// The Font Library's lists are adopted the same way: the library is a window
// of its own (font-window.svelte.js), and a family switched on there has to
// reach the menus of the window the user letters in.
const SHARED_KEYS = ['onboarded', 'usage', 'defaultChapterMode', 'defaultOcrLanguage'];
const SHARED_FONT_KEYS = ['hiddenBuiltinFonts', 'shownSystemFonts', 'disabledUserFonts'];
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export function adoptSharedPrefs(raw) {
  let saved = null;
  try {
    saved = JSON.parse(raw ?? 'null');
  } catch {
    return;
  }
  if (!saved || typeof saved !== 'object') return;
  const usageWas = prefs.usage;
  for (const k of SHARED_KEYS) {
    const v = saved[k];
    const ok = BOOL_KEYS.includes(k) ? typeof v === 'boolean' : ENUM_KEYS[k].includes(v);
    if (ok && prefs[k] !== v) prefs[k] = v;
  }
  for (const k of SHARED_FONT_KEYS) {
    const names = cleanNames(saved[k]);
    if (names && !sameList(names, prefs[k])) prefs[k] = names;
  }
  const markets = cleanMarkets(saved.fontMarketplaces);
  if (markets && JSON.stringify(markets) !== JSON.stringify(prefs.fontMarketplaces)) prefs.fontMarketplaces = markets;
  const categories = cleanCategories(saved.fontCategories);
  if (categories && JSON.stringify(categories) !== JSON.stringify(prefs.fontCategories)) prefs.fontCategories = categories;
  if (saved.layouts && typeof saved.layouts === 'object') {
    const next = normalizeLayouts(saved.layouts);
    if (JSON.stringify(next) !== JSON.stringify(snapshotLayouts())) adoptLayouts(next);
  }
  applyUsage(prefs.usage !== usageWas);
}
// The same adoption, from whatever is stored now: what a window runs when
// another tells it the fonts changed.
export function adoptStoredPrefs() {
  try {
    adoptSharedPrefs(localStorage.getItem(KEY));
  } catch {
    /* nothing stored, or no storage */
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) adoptSharedPrefs(e.newValue);
  });
}

// Make Default for one effect: `effect` is a plain copy (`$state.snapshot`),
// stripped of what is the instance's own on the way in (`fxStored`).
export function setFxDefault(kind, effect) {
  const v = fxStored(kind, effect);
  if (!v) return;
  setPref('fxDefaults', { ...$state.snapshot(prefs.fxDefaults), [kind]: v });
}
// Reset to factory: the saved default is forgotten.
export function clearFxDefault(kind) {
  if (!prefs.fxDefaults[kind]) return;
  const { [kind]: _gone, ...rest } = $state.snapshot(prefs.fxDefaults);
  setPref('fxDefaults', rest);
}

load();
// A layout picked in the editor is written with the rest of the blob.
onLayoutsChange(persist);
