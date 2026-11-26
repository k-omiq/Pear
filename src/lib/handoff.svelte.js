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
// claim. Files are linked in, so the claim stays whole until it is deleted: a
// crash or a failed apply puts back a message with every file in it, and one
// filed already is dropped as stale when it comes round again. A chapter that is open waits: the claim goes back and the message is
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
  projectById,
  projectByCleanerLink,
  chapterByCleanerLink,
  chapterBusy,
  chapterOpenAnywhere,
  createChapterFromHandoff,
  applyHandoffToChapter,
  linkHandoffToChapter,
  setProjectCleanerLink,
  readChapterRecord,
} from './library.svelte.js';
import { toast, toastError } from './store.svelte.js';
import { startMode } from './prefs.svelte.js';
import { fsx } from './fsx.js';
import { dataFolder, samePath, typesetterRoot } from './data-folder.svelte.js';
import { candidatesFor, rankCandidates, chapterKey, unlinkedChapterFor, pairPages } from './handoff-match.js';

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
  same: (root, claim, rel, path) => invoke('handoff_same', { root, claim, rel, path }),
  putBack: (root, claim, key) => invoke('handoff_put_back', { root, claim, key }),
  reject: (root, claim, key, reason) => invoke('handoff_reject', { root, claim, key, reason }),
  done: (root, claim) => invoke('handoff_done', { root, claim }),
  moveBusy: () => invoke('data_folder_move_busy'),
  // Version 2 (section 8.4): the names with a stamp, a waiting message's
  // handoff.json read in place, page facts for pairing, a shared raw.
  scan: (root) => invoke('handoff_scan', { root }),
  peek: (root, key) => invoke('handoff_peek', { root, key }),
  facts: (root, name, rels, pear) => invoke('handoff_facts', { root, name, rels, pear }),
  shareRaw: (root, claim, rel, dest) => invoke('handoff_share_raw', { root, claim, rel, dest }),
  // Content candidates (8.4.2), per title, on a Rust blocking thread: sizes
  // by stat, a hash only on equal size, an early stop and a budget.
  contentScan: (root, dirs, titles) => invoke('handoff_content_scan', { root, dirs, titles }),
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
  judged.clear();
  judgedSig = '';
  titleScans.clear();
  autoOpened.clear();
  skips = null;
  recovered = false;
  running = null;
  Object.assign(handoffMatch, { rows: [], bulk: false, open: false, autoOpen: false });
}

const DEFER_TEXT = 'Cleaner sent new pages for this chapter. They apply when you close it.';

// A send no newer than the last one filed for its chapter.
const isStale = (sentAt, last) => Number.isFinite(Date.parse(last ?? '')) && !(Date.parse(sentAt) > Date.parse(last));

// The number a new chapter gets: its key (section 8.4.2), so 12.5 is never
// filed as 12; with no key, the whole number after the project's last.
function numberFor(p, chapter) {
  const key = chapterKey(chapter);
  if (key != null) return key;
  const numbers = (p.chapters ?? []).map((c) => c.number).filter(Number.isFinite);
  return numbers.length ? Math.floor(Math.max(...numbers)) + 1 : 1;
}

// Files one claimed message. Returns what happened.
async function fileClaim(root, claim, key, entry = null) {
  const read = await io.read(root, claim);
  // Staleness before the files are checked: a send filed already (its claim
  // was not deleted, say) is dropped, never rejected for what it lacks.
  const ids = read?.doc?.cleaner;
  const known = ids && [ids.libraryId, ids.projectId, ids.chapterId].every((v) => typeof v === 'string' && v);
  const filed = known ? chapterByCleanerLink(ids.libraryId, ids.projectId, ids.chapterId) : null;
  if (filed && isStale(read.doc.sentAt, filed.c.cleanerLink?.sentAt)) {
    await io.done(root, claim);
    return { outcome: 'stale' };
  }
  const msg = checkMessage(read);
  if (msg.error) {
    await io.reject(root, claim, key, msg.error);
    toastError(`A chapter from Manga Cleaner could not be filed: ${msg.error}. It was set aside in handoff/rejected.`);
    return { outcome: 'rejected', reason: msg.error };
  }
  const mover = {
    take: (rel, dest) => io.take(root, claim, rel, dest),
    giveBack: (rel, from) => io.giveBack(root, claim, rel, from),
    same: (rel, path) => io.same(root, claim, rel, path),
  };
  const { link } = msg;
  const found = chapterByCleanerLink(link.libraryId, link.projectId, link.chapterId);
  if (found) {
    const { p, c } = found;
    if (isStale(link.sentAt, c.cleanerLink?.sentAt)) {
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
      // Written already: the claim goes, it is not filed a second time.
      if (e?.committed) await io.done(root, claim).catch(() => {});
      else await io.putBack(root, claim, key);
      throw e;
    }
    await io.done(root, claim);
    if (result.stale) return { outcome: 'stale' };
    toast(`Cleaner sent ${chapterName(msg)} (${pagesText(msg.pages.length)}).`);
    return { outcome: 'updated', chapterId: c.id, ...result };
  }

  // A new chapter (section 8.3, step 5). It waits, put back before anything
  // here changes, when its linked project has an unlinked chapter with its
  // number, or when no project is linked and some are close by name (the
  // match screen asks). Otherwise its project is the one linked to the same
  // cleaner project, or a new one: never one found by name.
  const verdict = verdictFor(summarize(read.doc), entry?.content ?? []);
  if (verdict.verdict === 'wait') {
    await io.putBack(root, claim, key);
    if (entry) judged.set(key, { ...judge(read.doc), stamp: entry.stamp, content: entry.content ?? [], ...verdict, own: verdictFor(summarize(read.doc)) });
    return { outcome: 'waiting' };
  }
  if (verdict.verdict === 'delete') {
    await io.done(root, claim);
    return { outcome: 'skipped' };
  }
  try {
    let p = projectByCleanerLink(link.libraryId, link.projectId);
    if (!p) {
      p = await createProject(msg.project.name, {
        layout: msg.project.layout,
        cleanerLink: { libraryId: link.libraryId, projectId: link.projectId },
      });
    }
    const number = numberFor(p, msg.chapter);
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

// ---------- waiting to match (section 8.4.2) ----------

// What the match screen and the banner read. `rows`: one per waiting
// cleaner title. `bulk`: some message came from Send to Pear (a banner);
// else only single Saves wait and the screen opens itself (`autoOpen`).
export const handoffMatch = $state({ rows: [], bulk: false, open: false, autoOpen: false });

// Key -> { stamp, summary, verdict, fixed, candidates }: what a message not
// filed yet was judged to be. A waiting message is neither claimed nor read
// again while its folder (`stamp`) and this app's projects (`judgedSig`)
// stay the same. Memory only.
const judged = new Map();
let judgedSig = '';
// Messages the screen opened itself for once (`key@sentAt`).
const autoOpened = new Set();

// ---------- content candidates (section 8.4.2) ----------
// A per-title question, since titles are judged as a whole: does a title
// here hold byte-identical raws? Rust answers it on a blocking thread, never
// the webview's (`handoff_content_scan`), from one listing of the library:
// sizes by stat, hashes only on equal size, a stop once one title here has 3
// identical raws, at most 24 files hashed per title. A pass with a Save waits
// for it at most SCAN_WAIT_MS (a single Save is answered in the same pass), a
// bulk title not at all (it waits for the screen anyway); a longer
// scan goes on in the background, its row says "Looking for matches…", and
// the pass after it applies the answer. Title id -> { sig, state, found }.
const titleScans = new Map();
const SCAN_WAIT_MS = 300;

// What a scan's answer depends on: the title's messages and the chapters here.
function chaptersSig() {
  let out = '';
  for (const p of library.projects) {
    out += `${p.id}\u0001`;
    for (const c of p.chapters ?? []) out += `${c.id}:${c.pageCount ?? ''},`;
    out += '\u0002';
  }
  return out;
}

// Starts the scans `want` names ([{ id, sig, libraryId, messages: [{ key, rels }] }])
// in one call. Never awaited by its caller beyond SCAN_WAIT_MS.
function startScans(root, want) {
  const dirs = [];
  for (const p of library.projects) {
    if (p.unreadable) continue;
    for (const c of p.chapters ?? []) if (!c.unreadable && c.dir) dirs.push({ project: p.id, dir: c.dir });
  }
  const titles = [];
  for (const w of want) {
    const allow = library.projects
      .filter((p) => !p.unreadable && !p.duplicate && !(p.cleanerLink && p.cleanerLink.libraryId === w.libraryId))
      .map((p) => p.id);
    if (!allow.length || !dirs.length || !io.contentScan) {
      titleScans.set(w.id, { sig: w.sig, state: 'done', found: [] });
      continue;
    }
    titleScans.set(w.id, { sig: w.sig, state: 'running', found: [] });
    titles.push({ id: w.id, allow, messages: w.messages.map((m) => ({ name: m.key, rels: m.rels })) });
  }
  if (!titles.length) return Promise.resolve();
  const sigs = new Map(want.map((w) => [w.id, w.sig]));
  const run = io
    .contentScan(root, dirs, titles)
    .then((results) => {
      for (const r of results ?? []) {
        titleScans.set(r.id, { sig: sigs.get(r.id), state: 'done', found: (r.found ?? []).map((f) => ({ projectId: f.project, identical: f.identical })) });
      }
    })
    .catch((e) => console.warn('[handoff] content scan', e))
    .finally(() => {
      for (const t of titles) if (titleScans.get(t.id)?.state === 'running') titleScans.set(t.id, { sig: sigs.get(t.id), state: 'done', found: [] });
      afterScans(root);
    });
  return run;
}

// A scan that ended after its pass: the rows learn its answer now (the
// screen may be open), and a pass files what no longer waits.
function afterScans(root) {
  if (running) {
    running.finally(() => afterScans(root));
    return;
  }
  const keys = [...judged.keys()];
  judgeTitles(keys, null);
  publishRows(keys.filter((k) => judged.get(k)?.verdict === 'wait'));
  if (!handoffMatch.open && dataFolder.mode === 'shared' && root) checkHandoffs(root).catch((e) => console.warn('Handoff check failed', e));
}

// The projects and chapters a verdict depends on: a project made, renamed,
// deleted or linked, or a chapter added, judges every message again.
function librarySig() {
  let out = '';
  for (const p of library.projects) {
    out += `${p.id}\u0001${p.name}\u0001${p.cleanerLink?.libraryId ?? ''}:${p.cleanerLink?.projectId ?? ''}`;
    for (const c of p.chapters ?? []) out += `\u0002${c.number}:${c.cleanerLink?.libraryId ?? ''}:${c.cleanerLink?.chapterId ?? ''}`;
    out += '\u0003';
  }
  return out;
}

// The fields of a message the judging and the screen use, from its
// handoff.json, or null when it cannot be told apart (it is then filed, and
// the check sets it aside).
function summarize(doc) {
  const ids = doc?.cleaner;
  if (!ids || ![ids.libraryId, ids.projectId, ids.chapterId].every((v) => typeof v === 'string' && v)) return null;
  const ch = doc.chapter ?? {};
  const pages = Array.isArray(doc.pages) ? doc.pages : [];
  const label = typeof ch.label === 'string' && ch.label.trim() ? ch.label.trim() : null;
  const number = Number.isFinite(ch.number) ? ch.number : null;
  return {
    libraryId: ids.libraryId,
    projectId: ids.projectId,
    chapterId: ids.chapterId,
    sentAt: String(doc.sentAt ?? ''),
    send: doc.send === 'bulk' ? 'bulk' : 'save',
    name: String(doc.project?.name ?? '').trim() || 'Untitled',
    layout: doc.project?.layout === 'longstrip' ? 'longstrip' : 'pages',
    title: String(ch.title ?? '').trim(),
    number,
    label,
    numberKey: chapterKey({ label, number }),
    pageCount: pages.length,
    cleanedPages: Number.isInteger(ch.cleanedPages) ? ch.cleanedPages : pages.filter((pg) => pg?.cleaned != null).length,
  };
}

// ---------- skips (section 8.4.5), in this app's own folder ----------

const SKIPS_FILE = 'handoff-skips.json';
let skips = null; // { titles: [{ libraryId, projectId, skippedAt }], chapters: [... chapterId] }

async function skipsPath() {
  return fsx.join(library.root, SKIPS_FILE);
}
async function loadSkips() {
  if (skips) return skips;
  try {
    const v = JSON.parse(await fsx.readTextFile(await skipsPath()));
    const list = (x) => (Array.isArray(x) ? x.filter((r) => r && typeof r.libraryId === 'string' && typeof r.projectId === 'string' && typeof r.skippedAt === 'string') : []);
    skips = { titles: list(v?.titles), chapters: list(v?.chapters).filter((r) => typeof r.chapterId === 'string') };
  } catch {
    skips = { titles: [], chapters: [] };
  }
  return skips;
}
async function saveSkips() {
  await fsx.writeTextFileAtomic(await skipsPath(), JSON.stringify({ schema: 1, ...skips }, null, 2));
}
const sameTitle = (r, s) => r.libraryId === s.libraryId && r.projectId === s.projectId;
function skipOf(s) {
  if (!skips || !s) return null;
  return skips.chapters.find((r) => sameTitle(r, s) && r.chapterId === s.chapterId) ?? skips.titles.find((r) => sameTitle(r, s)) ?? null;
}
async function recordSkip(s, chapter) {
  await loadSkips();
  const at = new Date().toISOString();
  if (chapter) {
    skips.chapters = [...skips.chapters.filter((r) => !(sameTitle(r, s) && r.chapterId === s.chapterId)), { libraryId: s.libraryId, projectId: s.projectId, chapterId: s.chapterId, skippedAt: at }];
  } else {
    skips.titles = [...skips.titles.filter((r) => !sameTitle(r, s)), { libraryId: s.libraryId, projectId: s.projectId, skippedAt: at }];
  }
  await saveSkips();
}
async function forgetTitleSkip(s) {
  await loadSkips();
  if (!skips.titles.some((r) => sameTitle(r, s))) return;
  skips.titles = skips.titles.filter((r) => !sameTitle(r, s));
  await saveSkips();
}

// What to do with a message not filed yet: 'file' it (section 8.3), let it
// 'wait' for the match screen, or 'delete' it (a skipped title's bulk send,
// or one older than the skip). `fixed` is the linked project of a chapter
// number clash; `candidates` the projects close by name.
// `content`: the content candidates of its title (titleScans), ranked first.
function verdictFor(s, content = []) {
  if (!s) return { verdict: 'file' };
  if (chapterByCleanerLink(s.libraryId, s.projectId, s.chapterId)) return { verdict: 'file' };
  const linked = projectByCleanerLink(s.libraryId, s.projectId);
  const skip = skipOf(s);
  const ranked = () => rankCandidates(content, candidatesFor(s.name, s.libraryId, library.projects).map((c) => c.project.id));
  if (skip) {
    // A Save after the skip is a clear wish to send: it asks again.
    if (s.send === 'bulk' || !(Date.parse(s.sentAt) > Date.parse(skip.skippedAt))) return { verdict: 'delete' };
    return { verdict: 'wait', fixed: linked?.id ?? null, candidates: linked ? [] : ranked() };
  }
  if (linked) return unlinkedChapterFor(linked, s.numberKey, s.libraryId) ? { verdict: 'wait', fixed: linked.id, candidates: [] } : { verdict: 'file' };
  const candidates = ranked();
  // A bulk send always waits: Pear sees all its chapters before it decides
  // a title (the screen then preselects "New title in Pear").
  return candidates.length || s.send === 'bulk' ? { verdict: 'wait', fixed: null, candidates } : { verdict: 'file' };
}

// Section 8.3 step 5, per title: the messages of one cleaner title with no
// title linked here are judged together. If any waits (or its title has
// content candidates, or its content scan has not answered yet), all wait,
// with the candidates of all of them, and none makes a new title, so a
// cleaner title never splits across two titles here. Each message's own
// verdict (`own`) is kept, so this is redone on every pass from what is in
// the inbox now, in memory only. With `root`, the scans it lacks are started
// and returned; without, it only applies the answers there are.
function judgeTitles(keys, root) {
  const groups = new Map();
  for (const k of keys) {
    const j = judged.get(k);
    const s = j?.summary;
    if (!s || !j.own || j.own.verdict === 'delete') continue;
    if (chapterByCleanerLink(s.libraryId, s.projectId, s.chapterId) || projectByCleanerLink(s.libraryId, s.projectId)) continue;
    const id = `${s.libraryId}|${s.projectId}`;
    if (!groups.has(id)) groups.set(id, { libraryId: s.libraryId, keys: [], js: [] });
    groups.get(id).keys.push(k);
    groups.get(id).js.push(j);
  }
  const lib = chaptersSig();
  const want = [];
  for (const [id, g] of groups) {
    const sig = `${[...g.keys].sort().join('\u0001')}\u0002${lib}`;
    const scan = titleScans.get(id);
    const answered = scan?.state === 'done' && scan.sig === sig;
    if (!answered && scan?.state !== 'running' && root) {
      const save = g.js.some((j) => j.summary.send !== 'bulk');
      want.push({ id, sig, save, libraryId: g.libraryId, messages: g.keys.map((k) => ({ key: k, rels: judged.get(k).rels ?? [] })) });
    }
    const found = answered ? scan.found : [];
    const scanning = !answered;
    const named = [];
    for (const j of g.js) for (const pid of j.own.candidates ?? []) if (!named.includes(pid)) named.push(pid);
    if (!scanning && !found.length && !g.js.some((j) => j.own.verdict === 'wait')) {
      for (const j of g.js) Object.assign(j, j.own, { content: [], scanning: false });
      continue;
    }
    const candidates = rankCandidates(found, named);
    for (const j of g.js) Object.assign(j, { verdict: 'wait', fixed: null, candidates, content: found, scanning });
  }
  if (!want.length) return null;
  // Worth a moment's wait only for a Save, which files when its scan finds
  // nothing; a bulk title waits for the screen anyway.
  return { run: startScans(root, want), save: want.some((w) => w.save) };
}

// The verdict of one message on its own (its title's content candidates
// come per title, judgeTitles). The raws it lists are kept for the scan.
function judge(doc) {
  const summary = doc ? summarize(doc) : null;
  const verdict = verdictFor(summary);
  const rels = [...(doc?.pages ?? [])]
    .sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0))
    .map((pg) => pg?.raw)
    .filter((r) => typeof r === 'string' && r);
  return { summary, rels, ...verdict, own: verdict };
}

// The rows of the screen and the banner, from the waiting messages: one per
// cleaner title, its chapters in chapter order. Written only when it changed.
function publishRows(keys) {
  const byTitle = new Map();
  for (const key of keys) {
    const j = judged.get(key);
    if (j?.verdict !== 'wait' || !j.summary) continue;
    const s = j.summary;
    const id = `${s.libraryId}|${s.projectId}`;
    let row = byTitle.get(id);
    if (!row) {
      row = { id, libraryId: s.libraryId, projectId: s.projectId, name: s.name, layout: s.layout, fixed: j.fixed ?? null, candidates: j.candidates ?? [], scanning: false, messages: [] };
      byTitle.set(id, row);
    }
    if (j.fixed) row.fixed = j.fixed;
    // Its content scan has not answered yet: "Looking for matches…".
    if (j.scanning) row.scanning = true;
    row.messages.push({ key, stamp: j.stamp, ...s });
  }
  const rows = [...byTitle.values()];
  for (const r of rows) r.messages.sort((a, b) => (a.numberKey ?? Infinity) - (b.numberKey ?? Infinity) || a.chapterId.localeCompare(b.chapterId));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const bulk = rows.some((r) => r.messages.some((m) => m.send === 'bulk'));
  if (JSON.stringify(rows) !== JSON.stringify(handoffMatch.rows)) handoffMatch.rows = rows;
  if (handoffMatch.bulk !== bulk) handoffMatch.bulk = bulk;
  // Only single Saves: the screen opens itself, once for each send.
  const fresh = rows.flatMap((r) => r.messages.map((m) => `${m.key}@${m.sentAt}`)).filter((k) => !autoOpened.has(k));
  if (!bulk && fresh.length) {
    for (const k of fresh) autoOpened.add(k);
    handoffMatch.autoOpen = true;
  }
}

// The messages, each with a stamp that changes with its folder. A Rust side
// without `scan` (older tests) stamps nothing, and every message is judged
// on each pass.
async function listEntries(root) {
  if (io.scan) return io.scan(root);
  return (await io.list(root)).map((key) => ({ key, stamp: '' }));
}

// One pass over the inbox. `root` is the data folder; the library root must
// be its `Typesetter/` and the mode Shared (checked here, so a pass never
// files into a legacy library). Single flight, and paused while the match
// screen is open, so nothing files a row between the user's choice and Apply.
export function checkHandoffs(root, { rescan = true } = {}) {
  if (handoffMatch.open) return running ?? Promise.resolve([]);
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
  const entries = (await listEntries(root)).filter((e) => !(waiting.has(e.key) && chapterBusy(waiting.get(e.key))));
  if (!entries.length) {
    judged.clear();
    publishRows([]);
    return results;
  }
  const keys = entries.map((e) => e.key);
  for (const k of [...judged.keys()]) if (!keys.includes(k)) judged.delete(k);
  if (librarySig() !== judgedSig) judged.clear();
  // Only something new costs a scan and a read: messages that wait as they
  // did cost one listing.
  const unjudged = entries.filter((e) => !e.stamp || judged.get(e.key)?.stamp !== e.stamp);
  if (unjudged.length) {
    // The catalogue has to be the disk's before a send is matched to a
    // chapter: a chapter missing from it would be filed a second time.
    await scanLibrary();
    if (librarySig() !== judgedSig) judged.clear();
    await loadSkips();
    for (const e of entries) {
      const had = judged.get(e.key);
      if (e.stamp && had?.stamp === e.stamp) continue;
      const peeked = io.peek ? await io.peek(root, e.key).catch(() => null) : null;
      if (peeked?.gone) continue;
      judged.set(e.key, { stamp: e.stamp, ...judge(peeked?.doc ?? null) });
    }
  }
  judgedSig = librarySig();
  // Content scans a title lacks: waited for a moment, then left running.
  const scans = judgeTitles(keys, root);
  if (scans?.save) {
    let timer;
    await Promise.race([scans.run, new Promise((r) => (timer = setTimeout(r, SCAN_WAIT_MS)))]);
    clearTimeout(timer);
    judgeTitles(keys, null);
  }
  let filed = false;
  for (const { key, stamp } of entries) {
    const j = judged.get(key);
    if (!j || j.verdict === 'wait') continue;
    judged.delete(key);
    const claim = await io.claim(root, key).catch(() => null);
    if (!claim) continue; // gone, or someone else has it
    waiting.delete(key);
    if (j.verdict === 'delete') {
      await io.done(root, claim).catch(() => {});
      results.push({ key, outcome: 'skipped' });
      continue;
    }
    try {
      const r = await fileClaim(root, claim, key, { stamp, content: j.content ?? [] });
      results.push({ key, ...r });
      if (r.outcome === 'created' || r.outcome === 'updated') filed = true;
    } catch (e) {
      const why = String(e?.message ?? e);
      results.push({ key, outcome: 'failed', error: why });
      tellOnce(`${key}:failed:${why}`, () => toastError(`A chapter from Manga Cleaner could not be filed: ${why}`));
    }
  }
  if (filed && rescan) await scanLibrary();
  publishRows(keys.filter((k) => judged.get(k)?.verdict === 'wait'));
  return results;
}

// ---------- the match screen (section 8.4.3) ----------

export function openMatch() {
  handoffMatch.autoOpen = false;
  if (handoffMatch.rows.length) handoffMatch.open = true;
}
export function closeMatch() {
  handoffMatch.open = false;
  handoffMatch.autoOpen = false;
}

// A row's choices: a fixed project (a chapter number clash in a linked
// project), else its candidates best first, then "New title in Pear" and
// "Skip". `taken`: projects other rows chose, not offered here.
export function rowOptions(row, taken = new Set()) {
  if (row.fixed) return [{ value: row.fixed, label: projectById(row.fixed)?.name ?? 'This title', fixed: true }];
  const out = [];
  for (const id of row.candidates) {
    const p = projectById(id);
    if (p && !taken.has(id)) out.push({ value: id, label: p.name });
  }
  out.push({ value: 'new', label: 'New title in Pear' }, { value: 'skip', label: 'Skip' });
  return out;
}

const pearRaw = async (c, pg) => fsx.join(c.dir, 'raws', pg.file);

// How a waiting chapter's pages pair with the chapter here it would link to
// (section 8.4.4), read off the disk: { ok, why, pairs, identical,
// byPosition, thumbs }. `name` is the message's key (waiting) or claim.
export async function pairingFor(root, name, message, c, projectId) {
  const record = await readChapterRecord(projectId, c.id);
  const pages = record.pages ?? [];
  const doc = name.startsWith('.claimed-') ? (await io.read(root, name)).doc : (await io.peek(root, name)).doc;
  const raws = [...(doc?.pages ?? [])].sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0)).map((pg) => pg.raw);
  if (raws.length !== pages.length) return pairPages(raws, pages);
  const facts = await io.facts(root, name, raws, await Promise.all(pages.map((pg) => pearRaw(c, pg))));
  const pairing = pairPages(
    facts.message.map((f, i) => ({ ...f, rel: raws[i] })),
    facts.pear.map((f, i) => ({ ...f, pageId: pages[i].id })),
  );
  if (!pairing.ok) return pairing;
  const inbox = await fsx.join(root, 'handoff', 'to-typesetter', name);
  pairing.thumbs = await Promise.all(
    pairing.pairs
      .filter((x) => x.how === 'position')
      .map(async (x) => ({
        index: x.index,
        cleaner: (await fsx.assetUrl?.(await fsx.join(inbox, ...raws[x.index].split('/')))) ?? null,
        pear: (await fsx.assetUrl?.(await pearRaw(c, pages[x.pear]))) ?? null,
      })),
  );
  pairing.rawRels = raws;
  pairing.pearRaws = await Promise.all(pages.map((pg) => pearRaw(c, pg)));
  return pairing;
}

// What a chapter of a row does with the row's choice, before the user picks:
// 'new' (no chapter here with its number, or a new title), else the chapter
// here it would link to and 'link'.
export function chapterTarget(row, choice, message) {
  if (choice === 'new' || choice === 'skip') return { action: choice === 'skip' ? 'skip' : 'new', chapter: null };
  const p = projectById(choice);
  const c = p ? unlinkedChapterFor(p, message.numberKey, row.libraryId) : null;
  return c ? { action: 'link', chapter: c } : { action: 'new', chapter: null };
}

// Files every waiting message of the rows not skipped, in order, inside the
// filer's single flight (section 8.4.3). `plan`: [{ rowId, choice, chapters:
// { [key]: 'new' | 'link' | 'replace' | 'separate' | 'wait' | 'skip' } }]. Each
// chapter is one apply with the version 1 claim, check and lock rules.
export async function applyMatch(root, plan) {
  while (running) await running.catch(() => {});
  running = applyPlan(root, plan).finally(() => {
    running = null;
  });
  return running;
}

async function applyPlan(root, plan) {
  const results = [];
  await scanLibrary();
  await loadSkips();
  const rows = new Map(handoffMatch.rows.map((r) => [r.id, r]));
  for (const step of plan) {
    const row = rows.get(step.rowId);
    if (!row) continue;
    const title = { libraryId: row.libraryId, projectId: row.projectId };
    if (step.choice === 'skip') {
      for (const m of row.messages) {
        const claim = await io.claim(root, m.key).catch(() => null);
        if (claim) await io.done(root, claim).catch(() => {});
        judged.delete(m.key);
        results.push({ key: m.key, outcome: 'skipped' });
      }
      await recordSkip(title, false);
      continue;
    }
    let p;
    try {
      if (step.choice === 'new') {
        p = projectByCleanerLink(row.libraryId, row.projectId) ?? (await createProject(row.name, { layout: row.layout, cleanerLink: title }));
      } else {
        p = projectById(step.choice);
        if (!p) throw new Error('That title is not in the library any more');
        const l = p.cleanerLink;
        if (!l || l.libraryId !== row.libraryId || l.projectId !== row.projectId) await setProjectCleanerLink(p.id, title);
      }
      await forgetTitleSkip(title);
    } catch (e) {
      results.push({ key: row.id, outcome: 'failed', error: String(e?.message ?? e) });
      toastError(`${row.name} could not be matched: ${e?.message ?? e}`);
      continue;
    }
    for (const m of row.messages) {
      judged.delete(m.key);
      const target = chapterTarget(row, p.id, m);
      const action = step.chapters?.[m.key] ?? target.action;
      results.push({ key: m.key, ...(await applyChapter(root, p, m, action, target.chapter)) });
    }
  }
  await scanLibrary();
  judgedSig = '';
  handoffMatch.rows = [];
  const filed = results.filter((r) => ['created', 'linked'].includes(r.outcome)).length;
  if (filed) toast(`Matched ${filed} chapter${filed === 1 ? '' : 's'} from Manga Cleaner.`);
  return results;
}

async function applyChapter(root, p, m, action, c) {
  const s = m;
  // "Keep waiting" (the default for pages that do not pair), and any 'new'
  // that would land beside a chapter Pear has: nothing is claimed, the
  // message waits (section 8.4.3, no default adds a chapter beside one).
  if (action === 'wait' || (action === 'new' && c)) return { outcome: 'waiting' };
  if (action === 'skip') {
    const claim = await io.claim(root, m.key).catch(() => null);
    if (claim) await io.done(root, claim).catch(() => {});
    await recordSkip(s, true);
    return { outcome: 'skipped' };
  }
  const linking = action === 'link' || action === 'replace';
  if (linking && (!c || (await chapterOpenAnywhere(c.id)))) return { outcome: 'open' };
  const claim = await io.claim(root, m.key).catch(() => null);
  if (!claim) return { outcome: 'gone' };
  try {
    const read = await io.read(root, claim);
    // Re-read: a newer Save replaced the message after the screen showed it.
    if (String(read?.doc?.sentAt ?? '') !== m.sentAt) {
      await io.putBack(root, claim, m.key);
      return { outcome: 'changed' };
    }
    const msg = checkMessage(read);
    if (msg.error) {
      await io.reject(root, claim, m.key, msg.error);
      toastError(`A chapter from Manga Cleaner could not be filed: ${msg.error}. It was set aside in handoff/rejected.`);
      return { outcome: 'rejected', reason: msg.error };
    }
    const mover = {
      take: (rel, dest) => io.take(root, claim, rel, dest),
      giveBack: (rel, from) => io.giveBack(root, claim, rel, from),
      same: (rel, path) => io.same(root, claim, rel, path),
    };
    if (linking) {
      const pairing = await pairingFor(root, claim, m, c, p.id);
      if (!pairing.ok) {
        await io.putBack(root, claim, m.key);
        return { outcome: 'unpaired', reason: pairing.why };
      }
      try {
        await linkHandoffToChapter(p.id, c.id, { pages: msg.pages, pairs: pairing.pairs, link: msg.link, mover, replace: action === 'replace' });
      } catch (e) {
        if (e?.chapterOpen) {
          await io.putBack(root, claim, m.key);
          return { outcome: 'open' };
        }
        throw e;
      }
      // Identical raws share the cleaner's file, only once the link is
      // written; any failure leaves the page as it was.
      for (const x of pairing.pairs) {
        if (x.how === 'same') await io.shareRaw?.(root, claim, msg.pages[x.index].rawRel, pairing.pearRaws[x.pear]).catch(() => false);
      }
      await io.done(root, claim);
      return { outcome: 'linked', chapterId: c.id };
    }
    const created = await createChapterFromHandoff({
      projectId: p.id,
      number: numberFor(p, msg.chapter),
      title: msg.chapter.title,
      pages: msg.pages,
      link: msg.link,
      mover,
      mode: startMode(),
    });
    await io.done(root, claim);
    return { outcome: 'created', chapterId: created.id };
  } catch (e) {
    if (e?.committed) await io.done(root, claim).catch(() => {});
    else await io.putBack(root, claim, m.key).catch(() => {});
    const why = String(e?.message ?? e);
    toastError(`A chapter from Manga Cleaner could not be filed: ${why}`);
    return { outcome: 'failed', error: why };
  }
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
