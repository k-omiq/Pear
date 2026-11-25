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

import { fsx } from './fsx.js';
import { library, setRoot, setRootMustExist, scanLibrary, setOpenGate } from './library.svelte.js';
import { app } from './store.svelte.js';
import { jobs } from './jobs.svelte.js';
import { chapterWindows, windowRole } from './agent/windows.js';

export const SUBFOLDER = 'Typesetter';
export const DEFAULT_NAME = 'Manga Library';
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
});

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
// An unreadable folder counts as holding something, so it is offered rather
// than abandoned.
async function holdsLibrary(dir) {
  try {
    if (!dir || !(await fsx.exists(dir))) return false;
    for (const e of await fsx.readDir(dir)) {
      if (e.isDirectory && (await fsx.exists(await fsx.join(dir, e.name, 'project.json')))) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function enter(mode) {
  dataFolder.mode = mode;
  dataFolder.checked = true;
  setRootMustExist(mode === 'shared' || mode === 'unavailable');
}

function noteRecovered(r) {
  if (!r) return;
  if (r.note) dataFolder.notice = r.note;
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
  dataFolder.state = st?.state ?? 'none';
  dataFolder.detail = st?.detail ?? '';
  dataFolder.root = st?.pointer?.path ?? null;
  dataFolder.bothLibraries = false;
  noteRecovered(st?.recovered);
  if (dataFolder.state === 'none') return enter('legacy');
  if (dataFolder.state !== 'ok') return enter('unavailable');
  const root = dataFolder.root;
  const target = await typesetterRoot(root);
  const here = samePath(library.root, target);
  const legacyHolds = !here && (await holdsLibrary(library.root));
  if (st.typesetterReady && (here || !legacyHolds)) return openShared(root, target);
  if (here) {
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
  // Nothing of ours to bring: the empty library is made in the shared
  // folder (an adopt with nothing to move), under move.lock like any setup.
  if (!legacyHolds && !app.chapterRef) {
    try {
      await call('data_folder_adopt', { legacy: null });
    } catch {
      /* the cleaner is moving the folder, say: offered again on focus */
      return enter('pending');
    }
    return openShared(root, target);
  }
  enter('pending');
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
  } catch (e) {
    dataFolder.detail = `The shared data folder could not be used: ${e?.message ?? e}`;
    // Pending only while this app still runs on its own old library.
    const onShared = dataFolder.root && samePath(library.root, await typesetterRoot(dataFolder.root).catch(() => ''));
    enter(dataFolder.state === 'none' ? 'legacy' : dataFolder.state === 'ok' && !onShared ? 'pending' : 'unavailable');
  }
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

// Where a folder the user picked puts the data folder: the folder itself when
// it is empty, missing or already a data folder, else a `Manga Library`
// folder inside it.
export async function rootForPick(picked) {
  const info = await inspectFolder(picked);
  if (info.marker || (info.isDir && info.empty) || !info.exists) return { root: picked, info };
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
  });
  setRootMustExist(false);
}

// Exposed for the tests of the mode decision.
export const _settleForTests = settle;
