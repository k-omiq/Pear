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
//                newer version: a blocking screen, and nothing is created.

import { fsx } from './fsx.js';
import { library, setRoot, setRootMustExist, scanLibrary } from './library.svelte.js';
import { app } from './store.svelte.js';
import { jobs } from './jobs.svelte.js';
import { chapterWindows, windowRole } from './agent/windows.js';

export const SUBFOLDER = 'Typesetter';
export const DEFAULT_NAME = 'Manga Library';
const OLD_COPIES_KEY = 'mt.oldDataCopies';

export const dataFolder = $state({
  mode: 'legacy',
  // The data folder the pointer names, or null.
  root: null,
  // Rust's word for the pointer's state ("none", "ok", "missing",
  // "noMarker", "idMismatch", "newer", "invalid") and any detail.
  state: 'none',
  detail: '',
  // A move or a switch is running; the handoff check waits for it.
  busy: false,
  // What the start-up recovery of a stopped move did, once.
  notice: '',
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
  setRootMustExist(mode === 'shared' || mode === 'unavailable');
}

// Decides the mode from Rust's status of the pointer and this app's root.
async function settle(st) {
  dataFolder.state = st?.state ?? 'none';
  dataFolder.detail = st?.detail ?? '';
  dataFolder.root = st?.pointer?.path ?? null;
  if (dataFolder.state === 'none') return enter('legacy');
  if (dataFolder.state !== 'ok') return enter('unavailable');
  const root = dataFolder.root;
  const target = await typesetterRoot(root);
  const here = samePath(library.root, target);
  const legacyHolds = !here && (await holdsLibrary(library.root));
  if (st.typesetterReady && (here || !legacyHolds)) {
    await call('data_folder_open', { root });
    if (!here) await setRoot(target);
    return enter('shared');
  }
  // Nothing of ours to bring: the empty library is made in the shared
  // folder (an adopt with nothing to move), under move.lock like any setup.
  if (!legacyHolds && !app.chapterRef) {
    try {
      await call('data_folder_adopt', { legacy: null });
      await call('data_folder_open', { root });
      await setRoot(target);
      return enter('shared');
    } catch {
      /* the cleaner is moving the folder, say: offered again on focus */
    }
  }
  enter('pending');
}

async function refresh() {
  await settle(await call('data_folder_status'));
}

// At start, after initRoot and before the first scan. Never throws: a data
// folder that cannot be used leaves the reason in `detail`.
export async function initDataFolder() {
  if (!available()) return;
  try {
    const role = await windowRole();
    if (!role?.agent) {
      const note = await call('data_folder_recover').catch((e) => `A stopped move could not be finished: ${e?.message ?? e}`);
      if (note) dataFolder.notice = note;
    }
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
    enter(dataFolder.state === 'ok' ? 'pending' : dataFolder.mode);
  }
}

// On window focus: the cleaner may have set the folder up, a drive may have
// come back or gone. Returns true when the library root or mode changed (the
// caller rescans).
export async function recheckDataFolder() {
  if (dataFolder.busy || !available()) return false;
  const was = [library.root, dataFolder.mode];
  try {
    await refresh();
  } catch (e) {
    dataFolder.detail = `The shared data folder could not be used: ${e?.message ?? e}`;
  }
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

async function busyWith(fn) {
  const why = await whyNotNow();
  if (why) throw new Error(why);
  dataFolder.busy = true;
  try {
    return await fn();
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
  await scanLibrary();
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

// "Move data folder": the whole folder, both apps' data, to `to`.
export function moveDataFolder(to, { confirm } = {}) {
  return busyWith(async () => {
    if (dataFolder.mode !== 'shared') throw new Error('Set up the shared folder first.');
    const from = dataFolder.root;
    let report;
    try {
      report = await withConfirm((confirmed) => call('data_folder_move', { to, confirmed }), confirm);
    } catch (e) {
      // The move let go of this app's lock; take it back on the old folder.
      await call('data_folder_open', { root: from }).catch(() => {});
      throw e;
    }
    return afterChange(report);
  });
}

// "Use existing folder": point at a folder that already holds
// `manga-library.json`. Nothing is moved; from legacy mode the old library
// is then offered for a move, as when the cleaner set the folder up.
export function useExistingFolder(root) {
  return busyWith(async () => {
    await call('data_folder_use_existing', { root });
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
  Object.assign(dataFolder, { mode: 'legacy', root: null, state: 'none', detail: '', busy: false, notice: '', oldCopies: [] });
  setRootMustExist(false);
}

// Exposed for the tests of the mode decision.
export const _settleForTests = settle;
