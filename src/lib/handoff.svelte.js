// ===== Chapters sent by Manga Cleaner =====
// The filing half of the handoff (SHARED_DATA_FOLDER.md section 8.3). The
// cleaner's Save drops one message folder per chapter in
// `<data folder>/handoff/to-typesetter/<key>/`, key
// `cleaner-<libraryId>-<projectId>-<chapterId>`:
//
//   handoff.json, raws/<NNN>.<ext>, cleaned/<NNN>.png
//
// This module claims a message by renaming it, checks it, files it as a new
// chapter or as a newer send of a chapter already here (library.svelte.js,
// `createChapterFromHandoff` and `applyHandoffToChapter`), and deletes the
// claim. A chapter that is open waits: the claim goes back and the message is
// filed once the chapter closes. A message that does not check out goes to
// `handoff/rejected/` with the reason.
//
// The claimed folder's name starts with a dot, which the webview's file scope
// does not reach, so every move of a message file is done by the Rust side
// (src-tauri/src/handoff.rs) through `io`. Tests swap `io` for node:fs.

import {
  library,
  scanLibrary,
  createProject,
  projectByCleanerLink,
  chapterByCleanerLink,
  chapterBusy,
  createChapterFromHandoff,
  applyHandoffToChapter,
} from './library.svelte.js';
import { toast, toastError } from './store.svelte.js';
import { startMode } from './prefs.svelte.js';
import { dataFolder, samePath, typesetterRoot } from './data-folder.svelte.js';

const POLL_MS = 3000;

let core = null;
const invoke = async (cmd, args) => {
  core ??= await import('@tauri-apps/api/core');
  return core.invoke(cmd, args);
};
const tauriIO = {
  list: (root) => invoke('handoff_list', { root }),
  recover: (root) => invoke('handoff_recover', { root }),
  claim: (root, key) => invoke('handoff_claim', { root, key }),
  read: (root, claim) => invoke('handoff_read', { root, claim }),
  take: (root, claim, rel, dest) => invoke('handoff_take', { root, claim, rel, dest }),
  giveBack: (root, claim, rel, from) => invoke('handoff_give_back', { root, claim, rel, from }),
  putBack: (root, claim, key) => invoke('handoff_put_back', { root, claim, key }),
  reject: (root, claim, key, reason) => invoke('handoff_reject', { root, claim, key, reason }),
  done: (root, claim) => invoke('handoff_done', { root, claim }),
  moveBusy: () => invoke('data_folder_move_busy'),
};
let io = tauriIO;
export function _setHandoffIO(next) {
  io = next ?? tauriIO;
}

const isPlain = (name) =>
  typeof name === 'string' && name.length > 0 && !/[\\/]/.test(name) && name !== '.' && name !== '..';

// `raws/001.jpg` -> `001.jpg`, or null for anything else.
function entryFile(rel, folder) {
  if (typeof rel !== 'string') return null;
  const parts = rel.split('/');
  return parts.length === 2 && parts[0] === folder && isPlain(parts[1]) ? parts[1] : null;
}

const positiveInt = (v) => Number.isInteger(v) && v > 0;

// The message as this app will use it, or the reason it cannot be filed.
// Every listed file must exist, and each cleaned image must be the size of
// its raw and of `w`/`h`.
export function checkMessage(msg) {
  if (msg?.error) return { error: msg.error };
  const doc = msg?.doc;
  const files = msg?.files ?? {};
  if (doc?.schema !== 1) return { error: `handoff.json has schema ${doc?.schema ?? 'none'}; this version reads schema 1` };
  const ids = doc.cleaner ?? {};
  for (const k of ['libraryId', 'projectId', 'chapterId']) {
    if (typeof ids[k] !== 'string' || !ids[k]) return { error: `handoff.json has no cleaner ${k}` };
  }
  if (!Number.isFinite(Date.parse(doc.sentAt))) return { error: 'handoff.json has no sentAt time' };
  if (!Array.isArray(doc.pages) || !doc.pages.length) return { error: 'handoff.json lists no pages' };
  const seen = new Set();
  const pages = [];
  const ordered = [...doc.pages].sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0));
  for (const pg of ordered) {
    const at = `page ${pg?.position ?? '?'}`;
    if (!Number.isInteger(pg?.sourceIdx) || pg.sourceIdx < 0) return { error: `${at} has no sourceIdx` };
    if (seen.has(pg.sourceIdx)) return { error: `${at} repeats sourceIdx ${pg.sourceIdx}` };
    seen.add(pg.sourceIdx);
    if (!positiveInt(pg.w) || !positiveInt(pg.h)) return { error: `${at} has no size` };
    const rawName = entryFile(pg.raw, 'raws');
    if (!rawName) return { error: `${at} has no usable raw path` };
    const raw = files[pg.raw];
    if (!raw?.exists) return { error: `${at}: ${pg.raw} is missing` };
    if (raw.w !== pg.w || raw.h !== pg.h) return { error: `${at}: ${pg.raw} is ${raw.w}x${raw.h}, not ${pg.w}x${pg.h}` };
    let cleanedName = null;
    if (pg.cleaned != null) {
      cleanedName = entryFile(pg.cleaned, 'cleaned');
      if (!cleanedName) return { error: `${at} has no usable cleaned path` };
      const cl = files[pg.cleaned];
      if (!cl?.exists) return { error: `${at}: ${pg.cleaned} is missing` };
      if (cl.w !== pg.w || cl.h !== pg.h) return { error: `${at}: ${pg.cleaned} is ${cl.w}x${cl.h}, not the raw's ${pg.w}x${pg.h}` };
    }
    pages.push({
      sourceIdx: pg.sourceIdx,
      rawRel: pg.raw,
      rawName,
      cleanedRel: cleanedName ? pg.cleaned : null,
      cleanedName,
      w: pg.w,
      h: pg.h,
    });
  }
  const ch = doc.chapter ?? {};
  const number = Number.isFinite(ch.number) ? ch.number : null;
  const label = typeof ch.label === 'string' && ch.label.trim() ? ch.label.trim() : null;
  return {
    link: { libraryId: ids.libraryId, projectId: ids.projectId, chapterId: ids.chapterId, sentAt: doc.sentAt },
    project: {
      name: String(doc.project?.name ?? '').trim() || 'Untitled',
      layout: doc.project?.layout === 'longstrip' ? 'longstrip' : 'pages',
    },
    chapter: { title: String(ch.title ?? '').trim(), number, label },
    pages,
  };
}

const chapterName = (m) =>
  m.chapter.title ||
  (m.chapter.label ? `Chapter ${m.chapter.label}` : m.chapter.number != null ? `Chapter ${m.chapter.number}` : 'a chapter');
const pagesText = (n) => `${n} page${n === 1 ? '' : 's'}`;

// Said once per send, not every three seconds.
const told = new Set();
function tellOnce(id, say) {
  if (told.has(id)) return;
  told.add(id);
  say();
}
// Message key -> the open chapter it waits for.
const waiting = new Map();
let recovered = false;
let running = null;

export function _resetHandoffForTests() {
  told.clear();
  waiting.clear();
  recovered = false;
  running = null;
}

const DEFER_TEXT = 'Cleaner sent new pages for this chapter. They apply when you close it.';

// Files one claimed message. Returns what happened.
async function fileClaim(root, claim, key) {
  const msg = checkMessage(await io.read(root, claim));
  if (msg.error) {
    await io.reject(root, claim, key, msg.error);
    toastError(`A chapter from Manga Cleaner could not be filed: ${msg.error}. It was set aside in handoff/rejected.`);
    return { outcome: 'rejected', reason: msg.error };
  }
  const mover = {
    take: (rel, dest) => io.take(root, claim, rel, dest),
    giveBack: (rel, from) => io.giveBack(root, claim, rel, from),
  };
  const { link } = msg;
  const found = chapterByCleanerLink(link.libraryId, link.projectId, link.chapterId);
  if (found) {
    const { p, c } = found;
    const last = Date.parse(c.cleanerLink?.sentAt ?? '');
    if (Number.isFinite(last) && !(Date.parse(link.sentAt) > last)) {
      await io.done(root, claim);
      return { outcome: 'stale' };
    }
    const wait = async () => {
      await io.putBack(root, claim, key);
      waiting.set(key, c.id);
      tellOnce(`${key}@${link.sentAt}`, () => toast(DEFER_TEXT));
      return { outcome: 'deferred' };
    };
    if (chapterBusy(c.id)) return wait();
    let result;
    try {
      result = await applyHandoffToChapter(p.id, c.id, { pages: msg.pages, link, mover });
    } catch (e) {
      if (e?.chapterOpen) return wait();
      await io.putBack(root, claim, key);
      throw e;
    }
    await io.done(root, claim);
    if (result.stale) return { outcome: 'stale' };
    toast(`Cleaner sent ${chapterName(msg)} (${pagesText(msg.pages.length)}).`);
    return { outcome: 'updated', chapterId: c.id, ...result };
  }

  // A new chapter. Its project is the one linked to the same cleaner
  // project, never one found by name: an unlinked project with the same name
  // is someone else's series and is left alone.
  try {
    let p = projectByCleanerLink(link.libraryId, link.projectId);
    if (!p) {
      p = await createProject(msg.project.name, {
        layout: msg.project.layout,
        cleanerLink: { libraryId: link.libraryId, projectId: link.projectId },
      });
    }
    const numbers = (p.chapters ?? []).map((c) => c.number).filter(Number.isFinite);
    const fromLabel = Number.parseFloat(msg.chapter.label ?? '');
    const number = msg.chapter.number ?? (Number.isFinite(fromLabel) ? fromLabel : numbers.length ? Math.max(...numbers) + 1 : 1);
    const c = await createChapterFromHandoff({
      projectId: p.id,
      number,
      title: msg.chapter.title,
      pages: msg.pages,
      link,
      mover,
      mode: startMode(),
    });
    await io.done(root, claim);
    toast(`Cleaner sent ${chapterName(msg)} (${pagesText(msg.pages.length)}).`);
    return { outcome: 'created', projectId: p.id, chapterId: c.id, pages: msg.pages.length };
  } catch (e) {
    // A project made for a first chapter that then failed stays, empty and
    // linked: the next try files into it.
    await io.putBack(root, claim, key).catch(() => {});
    throw e;
  }
}

// One pass over the inbox. `root` is the data folder; the library root must
// be its `Typesetter/` and the mode Shared (checked here, so a pass never
// files into a legacy library). Single flight.
export function checkHandoffs(root, { rescan = true } = {}) {
  running ??= runPass(root, rescan).finally(() => {
    running = null;
  });
  return running;
}

async function runPass(root, rescan) {
  const results = [];
  if (!root || dataFolder.mode !== 'shared' || !samePath(library.root, await typesetterRoot(root))) return results;
  if (await io.moveBusy().catch(() => true)) return results;
  if (!recovered) {
    recovered = true;
    await io.recover(root).catch(() => 0);
  }
  // A send waiting for its open chapter is not claimed again until it closes.
  const keys = (await io.list(root)).filter((key) => !(waiting.has(key) && chapterBusy(waiting.get(key))));
  if (!keys.length) return results;
  // The catalogue has to be the disk's before a send is matched to a chapter:
  // a chapter missing from it would be filed a second time.
  await scanLibrary();
  let filed = false;
  for (const key of keys) {
    const claim = await io.claim(root, key).catch(() => null);
    if (!claim) continue; // gone, or someone else has it
    waiting.delete(key);
    try {
      const r = await fileClaim(root, claim, key);
      results.push({ key, ...r });
      if (r.outcome === 'created' || r.outcome === 'updated') filed = true;
    } catch (e) {
      const why = String(e?.message ?? e);
      results.push({ key, outcome: 'failed', error: why });
      tellOnce(`${key}:failed:${why}`, () => toastError(`A chapter from Manga Cleaner could not be filed: ${why}`));
    }
  }
  if (filed && rescan) await scanLibrary();
  return results;
}

// At start, on window focus and every three seconds while the window is
// visible, in Shared mode. Main window only (the caller checks). Returns the
// stop function.
export function watchHandoffs() {
  if (typeof window === 'undefined') return () => {};
  const tick = () => {
    if (dataFolder.busy || dataFolder.mode !== 'shared' || !dataFolder.root) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    checkHandoffs(dataFolder.root).catch((e) => console.warn('Handoff check failed', e));
  };
  const timer = setInterval(tick, POLL_MS);
  window.addEventListener('focus', tick);
  tick();
  return () => {
    clearInterval(timer);
    window.removeEventListener('focus', tick);
  };
}
