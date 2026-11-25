// ===== The data folder's buttons =====
// What Settings, the library card and the "not found" screen do when a
// data folder button is pressed: pick a folder, ask what has to be asked
// (a sync folder, a folder that already is a data folder, a drive that
// cannot tell whether Manga Cleaner is open), run the change and say how it
// went. The changes themselves are data-folder.svelte.js.

import { toast, toastError } from './store.svelte.js';
import {
  dataFolder,
  rootForPick,
  defaultDataRoot,
  inspectFolder,
  setUpSharedFolder,
  moveLibraryIntoShared,
  moveDataFolder,
  useExistingFolder,
  deleteOldCopy,
  oldCopySize,
} from './data-folder.svelte.js';

async function dialog() {
  return import('@tauri-apps/plugin-dialog');
}

async function ask(text, okLabel = 'Continue') {
  const { ask: tauriAsk } = await dialog();
  return tauriAsk(text, { title: 'Data folder', kind: 'warning', okLabel, cancelLabel: 'Cancel' });
}

const confirmClosed = (text) => ask(`${text}\n\nIs Manga Cleaner closed?`, 'It is closed');

async function pickFolder(defaultPath) {
  const { open } = await dialog();
  const dir = await open({ directory: true, defaultPath: defaultPath || undefined });
  return typeof dir === 'string' ? dir : null;
}

async function warnIfSynced(info) {
  if (!info?.syncWarning) return true;
  return ask(`${info.syncWarning}\n\nUse this folder anyway?`, 'Use it');
}

function report(e, what) {
  const msg = String(e?.message ?? e);
  if (msg === 'Nothing was moved.') return;
  toastError(`${what}: ${msg}`);
}

const moved = (r) =>
  r?.oldCopy ? ` The old copy is kept at ${r.oldCopy} until you delete it in Settings.` : '';

// Legacy mode: "Set up shared folder…".
export async function pickAndSetUp() {
  try {
    const suggested = await defaultDataRoot();
    const parent = suggested.replace(/[\\/][^\\/]+$/, '');
    const picked = await pickFolder(parent);
    if (!picked) return;
    const { root, info } = await rootForPick(picked);
    if (!(await warnIfSynced(info))) return;
    const r = await setUpSharedFolder(root, { confirm: confirmClosed });
    toast(`Your library is now in the shared folder at ${root}.${moved(r)}`);
  } catch (e) {
    report(e, 'Could not set up the shared folder');
  }
}

// Pending mode: "Move your library into the shared folder".
export async function adoptNow() {
  try {
    const r = await moveLibraryIntoShared({ confirm: confirmClosed });
    toast(`Your library is now in the shared folder.${moved(r)}`);
  } catch (e) {
    report(e, 'Could not move your library');
  }
}

// Shared mode: "Move data folder…".
export async function pickAndMove() {
  try {
    const picked = await pickFolder(dataFolder.root);
    if (!picked) return;
    const { root, info } = await rootForPick(picked);
    if (info.marker) {
      const use = await ask(`${root} is already a data folder. Use it instead? Nothing is moved.`, 'Use it');
      if (use) await useExistingFolder(root);
      return;
    }
    if (!(await warnIfSynced(info))) return;
    const r = await moveDataFolder(root, { confirm: confirmClosed });
    toast(`The data folder is now at ${root}.${moved(r)}`);
  } catch (e) {
    report(e, 'Could not move the data folder');
  }
}

// Any mode: "Use existing folder…" (a folder holding manga-library.json).
export async function pickExisting() {
  try {
    const picked = await pickFolder(dataFolder.root);
    if (!picked) return;
    const info = await inspectFolder(picked);
    if (!info.marker) {
      toastError('That folder is not a shared data folder (it has no manga-library.json).');
      return;
    }
    await useExistingFolder(picked);
    toast(`Using the data folder at ${picked}.`);
  } catch (e) {
    report(e, 'Could not use that folder');
  }
}

// Unavailable mode: "Choose another folder…". A data folder is used as it
// is; an empty one becomes a new, empty data folder after a question.
export async function pickInstead() {
  try {
    const picked = await pickFolder(dataFolder.root);
    if (!picked) return;
    const { root, info } = await rootForPick(picked);
    if (info.marker) {
      await useExistingFolder(root);
      return;
    }
    const make = await ask(`Make a new, empty data folder at ${root}? Your library at the old place is not touched.`, 'Make it');
    if (!make || !(await warnIfSynced(info))) return;
    await setUpSharedFolder(root, { confirm: confirmClosed });
  } catch (e) {
    report(e, 'Could not use that folder');
  }
}

export async function askDeleteOldCopy(path) {
  try {
    const bytes = await oldCopySize(path).catch(() => null);
    const size = bytes == null ? '' : `, ${(bytes / 1e9).toFixed(1)} GB`;
    if (!(await ask(`Old copy at ${path}${size}. Delete it? This cannot be undone.`, 'Delete'))) return;
    await deleteOldCopy(path);
    toast('Old copy deleted.');
  } catch (e) {
    report(e, 'Could not delete the old copy');
  }
}
