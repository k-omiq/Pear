// ===== Which window this is, and the chapters it holds =====
// Each window of the app is a whole app with one chapter open (agent_mcp.rs):
// the main window, the user's, and one window per chapter an AI agent opened
// for itself (`open_chapter`). A chapter is never open in two windows, or each
// would autosave over the other: a window claims a chapter before it opens it
// (`claimChapter`, refused when another window has it) and says which it holds
// after every open and close (`syncChapters`).
//
// Outside the desktop app there is one window and nothing to claim.
import { isTauri } from '../importer.js';

const MAIN_ROLE = { label: 'main', agent: false, chapter: null };

// `projectId/chapterId`: how agents and windows name a chapter.
export const chapterKey = (projectId, chapterId) => `${projectId}/${chapterId}`;
export function parseChapterKey(key) {
  const s = typeof key === 'string' ? key.trim() : '';
  const i = s.indexOf('/');
  return i > 0 && i < s.length - 1 ? { projectId: s.slice(0, i), chapterId: s.slice(i + 1) } : null;
}

let invoker = null;
async function invoke(cmd, args) {
  invoker ??= import('@tauri-apps/api/core').then((m) => m.invoke);
  return (await invoker)(cmd, args);
}

let role = null;
// { label, agent, chapter }: what this window was opened for.
export function windowRole() {
  if (!isTauri()) return Promise.resolve(MAIN_ROLE);
  role ??= invoke('agent_window_role').catch(() => MAIN_ROLE);
  return role;
}

// Throws, with the reason to show, when another window has the chapter open
// (that window is brought to the front).
export async function claimChapter(projectId, chapterId) {
  if (!isTauri()) return;
  try {
    await invoke('chapter_claim', { key: chapterKey(projectId, chapterId) });
  } catch (e) {
    throw new Error(String(e?.message ?? e));
  }
}

// In order, one after the other: a late answer to an older sync must never
// land over a newer one.
let syncs = Promise.resolve();
export function syncChapters(keys) {
  if (!isTauri()) return;
  syncs = syncs.then(() =>
    invoke('chapter_sync', { keys }).catch(() => {
      /* the registry is the Rust side's; a lost sync is put right by the next */
    }),
  );
}

// key -> { window, agent } for every chapter open in any window.
export async function chapterWindows() {
  if (!isTauri()) return {};
  return invoke('chapter_windows').catch(() => ({}));
}

export const openChapterWindow = (key, title) => invoke('agent_window_open', { key, title });
export const closeChapterWindow = (key) => invoke('agent_window_close', { key });
export const agentWindowReady = (ok, error = null) => (isTauri() ? invoke('agent_window_ready', { ok, error }).catch(() => {}) : Promise.resolve());
// Every AI window saves and closes; resolves when they are gone (the main
// window's quit waits for it).
export const closeAgentWindows = () => (isTauri() ? invoke('agent_windows_close').catch(() => 0) : Promise.resolve(0));

// Runs `fn` holding record `path` against every other window's rewrite of it
// (project.json: read, merged and written whole). Outside the desktop app
// there is no other window to wait for.
export async function withRecordLock(path, fn) {
  if (!isTauri()) return fn();
  await invoke('record_lock', { path }).catch(() => {});
  try {
    return await fn();
  } finally {
    invoke('record_unlock', { path }).catch(() => {});
  }
}

// Tells every other window that a project's record changed on disk.
export async function announceRecord(dir) {
  if (!isTauri()) return;
  try {
    const [{ emit }, me] = await Promise.all([import('@tauri-apps/api/event'), windowRole()]);
    await emit('project:changed', { dir, from: me.label });
  } catch {
    /* the others read it again at their own next write */
  }
}

// `fn(dir)` whenever another window changed a project's record on disk.
export async function onRecordChanged(fn) {
  if (!isTauri()) return () => {};
  const [{ listen }, me] = await Promise.all([import('@tauri-apps/api/event'), windowRole()]);
  return listen('project:changed', (e) => {
    if (e.payload?.from !== me.label && typeof e.payload?.dir === 'string') fn(e.payload.dir);
  });
}
