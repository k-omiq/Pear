// ===== The data folder shared with Manga Cleaner =====
// SHARED_DATA_FOLDER.md at the repository root is the contract. One folder
// holds both apps' data; this app's library is its `Typesetter/` subfolder.
// The pointer, `move.lock` and the move journal are in a state folder that
// never moves, and every move is done in Rust (src-tauri/src/data_folder.rs)
// under that lock. This module decides the mode and calls those commands.
//
//   legacy       no pointer: the library stays where it always was
//                (localStorage `mt.libraryRoot`), exactly as before.
//   pending      the pointer is good, but this app's library is still in its
//                old place: a card offers to move it in.
//   shared       the library root is `<data folder>/Typesetter`.
//   unavailable  a pointer exists but its folder is missing (an unplugged
//                drive), has no marker, has another folder id, or is from a
//                newer version, or a move journal is left (state "moving"):
//                a blocking screen in place of the app, and nothing is
//                created. Recovery runs in Rust at every status check.

import { addNotice } from './data-folder-notices.svelte.js';
import { fsx } from './fsx.js';
import { library, setRoot, setRootMustExist, scanLibrary, setOpenGate } from './library.svelte.js';
import { app } from './store.svelte.js';
import { jobs } from './jobs.svelte.js';
import { chapterWindows, windowRole } from './agent/windows.js';
import { prefs, setPref } from './prefs.svelte.js';
import { shownText } from './data-folder-words.js';

export const SUBFOLDER = 'Typesetter';
export const DEFAULT_NAME = 'Manga Library';
const MARKER_FILE = 'manga-library.json';
const OLD_COPIES_KEY = 'mt.oldDataCopies';

export const dataFolder = $state({
  mode: 'legacy',
  // False until the first status check has decided the mode: the first-run
  // card waits for it rather than showing for the moment before.
  checked: false,
  // The data folder the pointer names, or null.
  root: null,
  // Rust's word for the pointer's state ("none", "ok", "missing",
  // "noMarker", "idMismatch", "newer", "invalid", "moving") and any detail.
  state: 'none',
  detail: '',
  // A move or a switch is running; the handoff check waits for it.
  busy: false,
  // What the recovery of a stopped move did, once.
  notice: '',
  // Pending mode with a library in the shared folder already: the user
  // picks the shared one, the old one stays where it is.
  bothLibraries: false,
  // Why a setup or move cannot start now ('' when it can): `local` is this
  // app (an open chapter, a job, an AI window), `cleaner` is Manga Cleaner
  // being open. Kept fresh by `refreshBlockers`.
  blocked: { local: '', cleaner: '' },
  // Old copies a cross-volume move set aside: [{ path }].
  oldCopies: readOldCopies(),
  // The start question to ask (SHARED_DATA_FOLDER.md section 5.1), or null:
  // 'joinStep' (row C, a step of the first-run setup), 'join' (row D, the
  // dialog's Join variant) or 'setup' (row F, its Set up variant).
  start: null,
  // Manga Cleaner has run on this computer (section 4.1), once asked.
  sister: null,
  // After a quiet setup (row E): where the library now lives, for the one
  // notice that says so. Cleared once shown.
  quietRoot: '',
  // A stopped move was just finished (or rolled back) and the folder is
  // being opened: the Unavailable screen says "Finishing the move…", never
  // "not found", until the mode is decided (section 11).
  finishing: false,
});

// The start answers (section 5.3), as prefs keeps them.
export const startAnswers = () => prefs.dataFolderFirstRun;
export function recordStartAnswer(question, how) {
  setPref('dataFolderFirstRun', { ...prefs.dataFolderFirstRun, [question]: how });
}
// Each question is asked at most once a session, even before it is
// answered: a dialog closed after a failure does not come back on focus.
const askedThisSession = new Set();
function ask(question) {
  if (askedThisSession.has(question)) return;
  askedThisSession.add(question);
  dataFolder.start = question;
}
export function dismissStart() {
  dataFolder.start = null;
}

function readOldCopies() {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(OLD_COPIES_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x?.path === 'string') : [];
  } catch {
    return [];
  }
}
function saveOldCopies() {
  try {
    globalThis.localStorage?.setItem(OLD_COPIES_KEY, JSON.stringify(dataFolder.oldCopies));
  } catch {
    /* a convenience list; Settings says where the copy is anyway */
  }
}

const inTauri = () => !!globalThis.window?.__TAURI_INTERNALS__;
let core = null;
async function tauriCall(cmd, args) {
  if (!inTauri()) throw new Error('This needs the desktop app');
  core ??= await import('@tauri-apps/api/core');
  return core.invoke(cmd, args);
}
let call = tauriCall;
// Tests stand in for the Rust commands.
export function _setDataFolderCommands(fn) {
  call = fn ?? tauriCall;
}
const available = () => call !== tauriCall || inTauri();

// One spelling per folder for comparisons: both separators folded, no
// trailing one, and case folded on Windows drive paths.
export function samePath(a, b) {
  const norm = (s) =>
    String(s ?? '')
      .replace(/[\\/]+/g, '/')
      .replace(/(.)\/+$/, '$1');
  const x = norm(a);
  const y = norm(b);
  return /^[a-zA-Z]:/.test(x) || /^[a-zA-Z]:/.test(y) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export const typesetterRoot = (root) => fsx.join(root, SUBFOLDER);

// Nothing may be written in place inside a library (fsx.writeFileAtomic).
fsx.guardInPlaceWrites?.(() => [library.root, dataFolder.root].filter(Boolean));

// Whether a legacy library folder holds anything to move: a project folder.
// A folder that cannot be read (outside the file scope, a drive gone) holds
// nothing this app can move, so it is never "a library" (section 11).
async function holdsLibrary(dir) {
  try {
    if (!dir || !(await fsx.exists(dir))) return false;
    for (const e of await fsx.readDir(dir)) {
      if (e.isDirectory && (await fsx.exists(await fsx.join(dir, e.name, 'project.json')))) return true;
    }
    return false;
  } catch (e) {
    console.warn('[data folder] could not read', dir, e);
    return false;
  }
}

// A library root this app last used in Shared mode: `<data folder>/Typesetter`,
// whose data folder has its marker, or cannot be read or is gone (the other
// app moved it, a drive is out). The pointer wins over such a root: it is
// never the old private library.
async function wasSharedRoot(dir) {
  const parts = String(dir ?? '').split(/[\\/]+/).filter(Boolean);
  if (parts.at(-1) !== SUBFOLDER) return false;
  const parent = String(dir).replace(/[\\/]+[^\\/]+[\\/]*$/, '');
  try {
    if (!(await fsx.exists(parent))) return true;
    return await fsx.exists(await fsx.join(parent, MARKER_FILE));
  } catch {
    return true;
  }
}

function enter(mode) {
  dataFolder.finishing = false;
  dataFolder.mode = mode;
  dataFolder.checked = true;
  setRootMustExist(mode === 'shared' || mode === 'unavailable');
}

function noteRecovered(r) {
  if (!r) return;
  if (r.note) {
    // Said once, in a notice that stays until closed (data-folder-notices).
    dataFolder.notice = shownText(r.note);
    addNotice({ id: `recovered:${dataFolder.notice}`, text: dataFolder.notice });
  }
  noteOldCopy(r);
}

// Opens the shared library: the scope and this app's lock, then the root.
// A failure is Unavailable, never the shared library without the lock.
async function openShared(root, target) {
  try {
    await call('data_folder_open', { root });
  } catch (e) {
    dataFolder.detail = `The shared data folder could not be opened: ${e?.message ?? e}`;
    return enter('unavailable');
  }
  if (!samePath(library.root, target)) await setRoot(target);
  return enter('shared');
}

// Decides the mode from Rust's status of the pointer and this app's root.
async function settle(st) {
  // Leaving a stopped move: until the mode is decided the screen says the
  // move is finishing, not "not found" (the state changes before the mode).
  if (dataFolder.mode === 'unavailable' && (dataFolder.state === 'moving' || st?.recovered) && st?.state !== 'moving') dataFolder.finishing = true;
  dataFolder.state = st?.state ?? 'none';
  dataFolder.detail = shownText(st?.detail ?? '');
  dataFolder.root = st?.pointer?.path ?? null;
  dataFolder.bothLibraries = false;
  noteRecovered(st?.recovered);
  if (dataFolder.state === 'none') return enter('legacy');
  if (dataFolder.state !== 'ok') return enter('unavailable');
  const root = dataFolder.root;
  const target = await typesetterRoot(root);
  const here = samePath(library.root, target);
  // The pointer wins over a stale Shared root (the folder moved while this
  // app was closed): it is not an old library to keep.
  const stale = !here && (await wasSharedRoot(library.root));
  const legacyHolds = !here && !stale && (await holdsLibrary(library.root));
  if (st.typesetterReady && (here || !legacyHolds)) return openShared(root, target);
  // Section 5.1: this app set up or joined this folder before (a stored
  // accepted answer, or v1 `moved`), but its subfolder is empty, as a v1
  // setup with nothing to move (or a crash) can leave it. Its library file
  // is made without asking. Not when the old place still holds titles:
  // those are offered as a move (row D), never left behind.
  const accepted = () => {
    const a = startAnswers();
    return a.setup === 'accepted' || a.join === 'accepted';
  };
  if (here || (st.typesetter === 'none' && !legacyHolds && accepted())) {
    // Switched to a data folder whose Typesetter library is not made yet:
    // made now, empty. Anything else in its place is never run on.
    try {
      await call('data_folder_adopt', { legacy: null });
    } catch (e) {
      dataFolder.detail = String(e?.message ?? e);
      return enter('unavailable');
    }
    return openShared(root, target);
  }
  dataFolder.bothLibraries = !!st.typesetterReady && legacyHolds;
  enter('pending');
  if (dataFolder.bothLibraries) return;
  // Rows C and D: this app has no subfolder yet. A first launch asks in the
  // first-run setup, an app used before asks in the dialog; either once.
  const answers = startAnswers();
  if (answers.join) return;
  const firstLaunch = !legacyHolds && !answers.setup && !prefs.onboarded;
  ask(firstLaunch ? 'joinStep' : 'join');
}

async function refresh() {
  await settle(await call('data_folder_status'));
}

// After any change, failed or not: what the disk now says. A move stopped
// past its copy leaves a journal, so this is Unavailable, never the old root
// opened again by guess.
async function settleAfter() {
  try {
    await refresh();
  } catch (e) {
    dataFolder.detail = `The shared data folder could not be checked: ${e?.message ?? e}`;
    enter(dataFolder.mode === 'legacy' ? 'legacy' : 'unavailable');
  }
}

// At start, after initRoot and before the first scan. Never throws: a data
// folder that cannot be used leaves the reason in `detail`.
export async function initDataFolder() {
  if (!available()) return;
  try {
    const role = await windowRole();
    if (role?.agent) {
      // An AI window works in the main window's library and holds no lock.
      const st = await call('data_folder_status');
      dataFolder.state = st?.state ?? 'none';
      dataFolder.root = st?.pointer?.path ?? null;
      enter(st?.state === 'none' ? 'legacy' : st?.state === 'ok' ? 'shared' : 'unavailable');
      return;
    }
    await refresh();
    if (dataFolder.mode === 'legacy') await startWithoutPointer();
  } catch (e) {
    dataFolder.detail = `The shared data folder could not be used: ${e?.message ?? e}`;
    // Pending only while this app still runs on its own old library.
    const onShared = dataFolder.root && samePath(library.root, await typesetterRoot(dataFolder.root).catch(() => ''));
    enter(dataFolder.state === 'none' ? 'legacy' : dataFolder.state === 'ok' && !onShared ? 'pending' : 'unavailable');
  }
}

// Rows E and F (section 5.1): no pointer. Without Manga Cleaner on this
// computer the library moves into the shared layout by itself (a quiet
// setup, one rename or nothing); with it, the dialog asks. A setup the user
// declined is neither asked nor done again.
async function startWithoutPointer() {
  const answers = startAnswers();
  if (answers.setup === 'declined') return;
  const sister = await call('data_folder_sister').catch(() => null);
  dataFolder.sister = typeof sister?.present === 'boolean' ? sister.present : null;
  if (dataFolder.sister === true) {
    if (!answers.setup) ask('setup');
    return;
  }
  if (dataFolder.sister === false) await quietSetup();
}

// Row E. Every check is Rust's, made twice, the second time under
// move.lock just before the rename (section 5.2); any that fails leaves
// Legacy mode and says nothing.
async function quietSetup() {
  if (jobs.items.some((j) => j.running) || app.chapterRef) return;
  let root;
  try {
    root = await call('data_folder_default_root');
    const legacy = (await holdsLibrary(library.root)) ? library.root : null;
    setOpenGate(openGate);
    dataFolder.busy = true;
    const r = await call('data_folder_quiet_setup', { root, legacy });
    if (!r?.done) {
      if (r?.reason) console.info('[data folder] no quiet setup:', r.reason);
      return;
    }
    noteOldCopy(r.report);
  } catch (e) {
    console.warn('[data folder] quiet setup', e);
    return;
  } finally {
    dataFolder.busy = false;
  }
  recordStartAnswer('setup', 'accepted');
  await settleAfter();
  if (dataFolder.mode === 'shared') dataFolder.quietRoot = root;
}

// On window focus: the cleaner may have set the folder up, a drive may have
// come back or gone. Returns true when the library root or mode changed (the
// caller rescans).
export async function recheckDataFolder() {
  if (dataFolder.busy || !available()) return false;
  const was = [library.root, dataFolder.mode];
  await settleAfter();
  return !samePath(was[0], library.root) || was[1] !== dataFolder.mode;
}

// ---------- what a change needs ----------

// The reason this app cannot set up or move its library now, or ''.
export async function whyNotNow() {
  if (dataFolder.busy) return 'A move is already running.';
  if (app.chapterRef) return 'Close the open chapter first.';
  if (jobs.items.some((j) => j.running)) return 'Wait for the running job to finish.';
  const me = await windowRole();
  const others = Object.values(await chapterWindows()).filter((w) => w.window !== me.label);
  if (others.length) return 'Close the AI chapter windows first.';
  if (await call('data_folder_move_busy').catch(() => false)) {
    return 'Manga Cleaner is setting up or moving the data folder. Try again when it finishes.';
  }
  return '';
}

// Whether Manga Cleaner runs in the data folder: '' when it does not or the
// drive cannot tell (the move then asks).
async function cleanerBlocker() {
  if (!dataFolder.root || dataFolder.mode === 'legacy' || dataFolder.mode === 'unavailable') return '';
  const running = await call('data_folder_cleaner_running', { root: dataFolder.root }).catch(() => null);
  return running === true ? 'Close Manga Cleaner first.' : '';
}

// Legacy mode has no data folder to ask about, but the place a first setup
// would use may already be one (joined, not made), and then setup refuses
// while Manga Cleaner runs there. The first-run card asks about that place.
export async function cleanerBlockerAt(root) {
  if (!root || !available()) return '';
  const running = await call('data_folder_cleaner_running', { root }).catch(() => null);
  return running === true ? 'Close Manga Cleaner first.' : '';
}

// Settings and the library card show the reasons before a button is pressed.
export async function refreshBlockers() {
  if (!available()) return dataFolder.blocked;
  const [local, cleaner] = await Promise.all([whyNotNow().catch(() => ''), cleanerBlocker()]);
  if (local !== dataFolder.blocked.local || cleaner !== dataFolder.blocked.cleaner) dataFolder.blocked = { local, cleaner };
  return dataFolder.blocked;
}

// A refusal Rust marks CANNOT_TELL: the drive has no locks, so the user is
// asked to confirm Manga Cleaner is closed. `confirm(text)` answers.
const CANNOT_TELL = 'CANNOT_TELL:';
async function withConfirm(run, confirm) {
  try {
    return await run(false);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!msg.startsWith(CANNOT_TELL)) throw e;
    if (!(await confirm?.(msg.slice(CANNOT_TELL.length).trim()))) throw new Error('Nothing was moved.');
    return run(true);
  }
}

// No chapter opens while the library is being moved or switched.
const openGate = () => (dataFolder.busy ? 'The data folder is being moved. Wait for it to finish.' : '');

async function busyWith(fn) {
  const why = await whyNotNow();
  if (why) throw new Error(why);
  setOpenGate(openGate);
  dataFolder.busy = true;
  try {
    return await fn();
  } catch (e) {
    await settleAfter();
    throw e;
  } finally {
    dataFolder.busy = false;
  }
}

function noteOldCopy(report) {
  if (!report?.oldCopy) return;
  dataFolder.oldCopies = [...dataFolder.oldCopies.filter((c) => !samePath(c.path, report.oldCopy)), { path: report.oldCopy }];
  saveOldCopies();
}

async function afterChange(report) {
  noteOldCopy(report);
  await refresh();
  if (dataFolder.mode !== 'unavailable') await scanLibrary();
  return report;
}

export const inspectFolder = (path) => call('data_folder_inspect', { path });
export const defaultDataRoot = () => call('data_folder_default_root');

// Where a folder the user picked puts the data folder, as Manga Cleaner
// does: a `Manga Library` folder inside it, always, unless the pick is a data
// folder already (then that one is used). A picked empty folder is never
// used as the root itself: it may be a drive's top folder, which cannot be
// renamed or removed.
export async function rootForPick(picked) {
  const info = await inspectFolder(picked);
  if (info.marker) return { root: picked, info };
  const inside = await fsx.join(picked, DEFAULT_NAME);
  return { root: inside, info: await inspectFolder(inside) };
}

// "Set up shared folder": legacy mode. This app's library moves into
// `<root>/Typesetter`; a folder that already is a data folder is joined.
export function setUpSharedFolder(root, { confirm } = {}) {
  return busyWith(async () => {
    const legacy = (await holdsLibrary(library.root)) ? library.root : null;
    const report = await withConfirm((confirmed) => call('data_folder_setup', { root, legacy, confirmed }), confirm);
    return afterChange(report);
  });
}

// "Move your library into the shared folder": pending mode.
export function moveLibraryIntoShared({ confirm } = {}) {
  return busyWith(async () => {
    const legacy = (await holdsLibrary(library.root)) ? library.root : null;
    const report = await withConfirm((confirmed) => call('data_folder_adopt', { legacy, confirmed }), confirm);
    return afterChange(report);
  });
}

// Pending mode with a library in the shared folder already: use that one.
// This app's old library is not moved or changed; it stays where it is.
export function useSharedLibrary() {
  return busyWith(async () => {
    const report = await call('data_folder_adopt', { legacy: null });
    await setRoot(await typesetterRoot(dataFolder.root));
    return afterChange(report);
  });
}

// "Move data folder": the whole folder, both apps' data, to `to`.
export function moveDataFolder(to, { confirm } = {}) {
  return busyWith(async () => {
    if (dataFolder.mode !== 'shared') throw new Error('Set up the shared folder first.');
    // On a failure `busyWith` asks Rust where things stand: a move undone
    // opens the old folder again, one stopped past its copy is Unavailable
    // until recovery finishes it.
    const report = await withConfirm((confirmed) => call('data_folder_move', { to, confirmed }), confirm);
    return afterChange(report);
  });
}

// "Use existing folder": point at a folder that already holds
// `manga-library.json`. Nothing is moved; from legacy mode the old library
// is then offered for a move, as when the cleaner set the folder up.
export function useExistingFolder(root, { confirm } = {}) {
  return busyWith(async () => {
    await withConfirm((confirmed) => call('data_folder_use_existing', { root, confirmed }), confirm);
    if (dataFolder.mode === 'shared' || dataFolder.mode === 'unavailable') {
      // The old shared library is not ours to bring along: switch to the
      // new folder's own Typesetter library.
      await setRoot(await typesetterRoot(root));
    }
    return afterChange(null);
  });
}

export async function oldCopySize(path) {
  return call('data_folder_size', { path });
}

export async function deleteOldCopy(path) {
  await call('data_folder_delete_old', { path });
  dataFolder.oldCopies = dataFolder.oldCopies.filter((c) => !samePath(c.path, path));
  saveOldCopies();
}

export function forgetOldCopy(path) {
  dataFolder.oldCopies = dataFolder.oldCopies.filter((c) => !samePath(c.path, path));
  saveOldCopies();
}

export function _resetDataFolderForTests() {
  Object.assign(dataFolder, {
    mode: 'legacy',
    checked: false,
    root: null,
    state: 'none',
    detail: '',
    busy: false,
    notice: '',
    oldCopies: [],
    bothLibraries: false,
    blocked: { local: '', cleaner: '' },
    start: null,
    sister: null,
    quietRoot: '',
    finishing: false,
  });
  askedThisSession.clear();
  setRootMustExist(false);
}

// What a setup or a join would move, for the dialog (section 5.4).
export async function startPlan(root) {
  const legacy = (await holdsLibrary(library.root)) ? library.root : null;
  return call('data_folder_plan', { root, legacy });
}
export const copyProgress = () => call('data_folder_progress');
export const revealDataFolder = (path) => call('data_folder_reveal', { path });
export async function sisterPresent() {
  if (dataFolder.sister != null) return dataFolder.sister;
  const r = await call('data_folder_sister').catch(() => null);
  return r?.present === true;
}

// Exposed for the tests of the mode decision.
export const _settleForTests = settle;
