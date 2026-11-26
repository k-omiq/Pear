// ===== Chapters sent by Manga Cleaner, on a real disk =====
//
// The filer (handoff.svelte.js) against node:fs in a temp folder: the library
// through the same `fsx` seam library.realfs.test.js swaps, and the message
// file moves through src/test/handoff-io.js, the node twin of
// src-tauri/src/handoff.rs. Messages are written the way the cleaner writes
// them (SHARED_DATA_FOLDER.md section 8): staged under a dot name, renamed to
// their key, raws as hard links to a "cleaner copy".
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { mkdtemp, rm, readFile, writeFile, mkdir, link, stat, readdir, rename as fsRename, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { nodeHandoffIO } from '../test/handoff-io.js';

vi.mock('./fsx.js', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const live = new Set();
  let tmpSeq = 0;
  return {
    fsx: {
      async readDir(p) {
        const entries = await fs.readdir(p, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
      },
      readTextFile: (p) => fs.readFile(p, 'utf8'),
      writeTextFile: (p, c) => fs.writeFile(p, c, 'utf8'),
      async writeTextFileAtomic(p, c) {
        const tmp = `${p}.${++tmpSeq}.tmp`;
        live.add(tmp);
        try {
          await fs.writeFile(tmp, c, 'utf8');
          await fs.rename(tmp, p);
        } finally {
          live.delete(tmp);
        }
      },
      liveTemps: () => new Set(live),
      readFile: async (p) => new Uint8Array(await fs.readFile(p)),
      writeFile: (p, bytes) => fs.writeFile(p, bytes),
      mkdir: (p) => fs.mkdir(p, { recursive: true }),
      remove: (p) => fs.rm(p, { recursive: true, force: true }),
      trash: (p) => fs.rm(p, { recursive: true, force: true }),
      rename: (from, to) => fs.rename(from, to),
      async exists(p) {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      },
      stat: (p) => fs.stat(p),
      join: async (...parts) => path.join(...parts),
      homeDir: async () => tmpdir(),
    },
  };
});

const { library, setRoot, setRootMustExist, createProject, createChapterFromPages, openChapter, closeChapter, saveOpenChapter, scanLibrary } =
  await import('./library.svelte.js');
const { app } = await import('./store.svelte.js');
const { dataFolder } = await import('./data-folder.svelte.js');
const { checkHandoffs, _resetHandoffForTests, _setHandoffIO, handoffMatch, openMatch, closeMatch, applyMatch, pairingFor, chapterTarget } =
  await import('./handoff.svelte.js');

// ---------- fixtures ----------

const crcTable = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
}
// A small 8-bit greyscale PNG, one level per file so two files differ.
function png(level, w = 40, h = 60) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(w, level)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function jpeg(level, w = 40, h = 60) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = `rgb(${level},${level},${level})`;
  ctx.fillRect(0, 0, w, h);
  return c.toBuffer('image/jpeg');
}

let tmp;
let caseSeq = 0;
let dataRoot;
let cleanerCopies;
let io;

const LIB = 'lib-0000-1111';
const KEY = `cleaner-${LIB}-p3-c7`;
const inbox = () => join(dataRoot, 'handoff', 'to-typesetter');

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mt-handoff-'));
});
afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  closeChapter();
  _resetHandoffForTests();
  vi.restoreAllMocks();
  dataRoot = join(tmp, `data-${++caseSeq}`);
  cleanerCopies = join(dataRoot, 'Cleaner', 'pages');
  await mkdir(join(dataRoot, 'Typesetter'), { recursive: true });
  await mkdir(inbox(), { recursive: true });
  await mkdir(cleanerCopies, { recursive: true });
  await setRoot(join(dataRoot, 'Typesetter'));
  setRootMustExist(true);
  dataFolder.mode = 'shared';
  dataFolder.root = dataRoot;
  library.projects = [];
  io = nodeHandoffIO();
  _setHandoffIO(io);
});

const pad = (n) => String(n).padStart(3, '0');

// Writes a message as the cleaner does: staged under a dot name, then
// renamed to its key. Each page is { src, raw: level, cleaned: level | null,
// w, h, jpeg }. The raw is a hard link to a file in the cleaner's folder.
async function send({ chapterId = 'c7', projectId = 'p3', sentAt, pages, name = 'Series Name', layout = 'pages', title = 'Chapter 12', number = 12, label = '12', kind }) {
  const key = `cleaner-${LIB}-${projectId}-${chapterId}`;
  const staging = join(inbox(), `.staging-${key}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(staging, 'raws'), { recursive: true });
  await mkdir(join(staging, 'cleaned'), { recursive: true });
  const list = [];
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    const position = i + 1;
    const [w, h] = [pg.w ?? 40, pg.h ?? 60];
    const ext = pg.jpeg ? 'jpg' : 'png';
    const own = join(cleanerCopies, `${chapterId}-${pg.src}-${w}x${h}.${ext}`);
    try {
      await stat(own);
    } catch {
      await writeFile(own, pg.jpeg ? jpeg(pg.raw, w, h) : png(pg.raw, w, h));
    }
    await link(own, join(staging, 'raws', `${pad(position)}.${ext}`));
    if (pg.cleaned != null) await writeFile(join(staging, 'cleaned', `${pad(position)}.png`), png(pg.cleaned, w, h));
    list.push({
      sourceIdx: pg.src,
      position,
      raw: `raws/${pad(position)}.${ext}`,
      rawFormat: pg.jpeg ? 'jpeg' : 'png',
      cleaned: pg.cleaned != null ? `cleaned/${pad(position)}.png` : null,
      w,
      h,
    });
  }
  await writeFile(
    join(staging, 'handoff.json'),
    JSON.stringify({
      schema: 1,
      from: 'manga-cleaner',
      appVersion: '1.0.0-beta.22',
      sentAt,
      cleaner: { libraryId: LIB, projectId, chapterId },
      project: { name, layout, readingDirection: 'rtl' },
      chapter: { title, number, label },
      pages: list,
      ...(kind ? { send: kind } : null),
    }),
  );
  // A message not filed yet is set aside first, as the cleaner does (8.2).
  const stale = join(inbox(), `.stale-${key}-${Math.random().toString(36).slice(2)}`);
  if (await stat(join(inbox(), key)).then(() => true, () => false)) await fsRename(join(inbox(), key), stale);
  await fsRename(staging, join(inbox(), key));
  await rm(stale, { recursive: true, force: true });
  return key;
}

const inboxNames = () => readdir(inbox());
const record = async (c) => JSON.parse(await readFile(join(c.dir, 'chapter.json'), 'utf8'));
const projectRecord = async (p) => JSON.parse(await readFile(join(p.dir, 'project.json'), 'utf8'));
const onlyChapter = () => {
  expect(library.projects).toHaveLength(1);
  expect(library.projects[0].chapters).toHaveLength(1);
  return { p: library.projects[0], c: library.projects[0].chapters[0] };
};

const T1 = '2026-11-25T10:00:00.000Z';
const T2 = '2026-11-25T11:00:00.000Z';
const T3 = '2026-11-25T12:00:00.000Z';
const THREE = [
  { src: 0, raw: 10, cleaned: 210, jpeg: true },
  { src: 1, raw: 20, cleaned: 220 },
  { src: 2, raw: 30, cleaned: null },
];

describe('a send for a chapter this app does not have', () => {
  it('creates a linked project and chapter, moves the files in and keeps the raw a hard link', async () => {
    await send({ sentAt: T1, pages: THREE, layout: 'longstrip' });
    const results = await checkHandoffs(dataRoot);
    expect(results.map((r) => r.outcome)).toEqual(['created']);

    const { p, c } = onlyChapter();
    expect([p.name, p.layout]).toEqual(['Series Name', 'longstrip']);
    expect((await projectRecord(p)).cleanerLink).toEqual({ libraryId: LIB, projectId: 'p3' });
    expect([c.title, c.number, c.pageCount]).toEqual(['Chapter 12', 12, 3]);
    expect(c.cleanerLink).toEqual({ libraryId: LIB, projectId: 'p3', chapterId: 'c7', sentAt: T1 });

    const rec = await record(c);
    expect(rec.pages.map((pg) => [pg.id, pg.file, pg.cleaned, pg.w, pg.h])).toEqual([
      [1, '001.jpg', '001.png', 40, 60],
      [2, '002.png', '002.png', 40, 60],
      [3, '003.png', null, 40, 60],
    ]);
    expect(rec.cleanerLink).toEqual({
      libraryId: LIB,
      projectId: 'p3',
      chapterId: 'c7',
      sentAt: T1,
      pages: [
        { sourceIdx: 0, pageId: 1 },
        { sourceIdx: 1, pageId: 2 },
        { sourceIdx: 2, pageId: 3 },
      ],
    });
    // Renamed, not copied: one file on disk under two names, JPEG kept.
    const mine = await stat(join(c.dir, 'raws', '001.jpg'));
    const theirs = await stat(join(cleanerCopies, 'c7-0-40x60.jpg'));
    expect([mine.ino, mine.nlink]).toEqual([theirs.ino, 2]);
    expect(await readFile(join(c.dir, 'cleaned', '002.png'))).toEqual(png(220));
    expect(await inboxNames()).toEqual([]);
  });

  it('files a chapter by its key, so 12.5 is never 12, and a label that is no number goes last', async () => {
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    for (const [chapterId, number, label] of [
      ['c8', 12, '12.5'],
      ['c9', 13, '13,5'],
      ['c10', 14, 'Extra'],
      ['c11', 15, null],
    ]) {
      await send({ chapterId, sentAt: T1, pages: THREE, title: '', number, label });
      await checkHandoffs(dataRoot);
    }
    const linked = library.projects.find((p) => p.cleanerLink);
    expect(linked.chapters.map((c) => c.number)).toEqual([12, 12.5, 13.5, 14, 15]);
    // A later real chapter 14 shares the number given to "Extra" but is never
    // linked onto it: "Extra" is linked already, so 14 is its own chapter.
    await send({ chapterId: 'c12', sentAt: T1, pages: THREE, title: '', number: 14, label: '14' });
    const [r] = (await checkHandoffs(dataRoot)).filter((x) => x.key.endsWith('-c12'));
    expect(r.outcome).toBe('created');
    const after = library.projects.find((p) => p.cleanerLink);
    expect(after.chapters.filter((c) => c.number === 14).map((c) => c.cleanerLink.chapterId).sort()).toEqual(['c10', 'c12']);
  });
});

describe('a newer send of a chapter this app has', () => {
  it('replaces cleaned pages matched by sourceIdx, keeps the old ones and takes a snapshot', async () => {
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    await send({
      sentAt: T2,
      pages: [
        { src: 0, raw: 10, cleaned: 211, jpeg: true },
        { src: 1, raw: 20, cleaned: 221 },
        { src: 2, raw: 30, cleaned: null },
      ],
    });
    const [r] = await checkHandoffs(dataRoot);
    expect(r).toMatchObject({ outcome: 'updated', replaced: 2, added: 0, pageCount: 3 });

    const { c } = onlyChapter();
    const rec = await record(c);
    expect(rec.pages.map((pg) => [pg.id, pg.file, pg.cleaned])).toEqual([
      [1, '001.jpg', '001-2.png'],
      [2, '002.png', '002-2.png'],
      [3, '003.png', null],
    ]);
    expect(await readFile(join(c.dir, 'cleaned', '001-2.png'))).toEqual(png(211));
    expect(await readFile(join(c.dir, 'logs', 'previous-cleaned', '001.png'))).toEqual(png(210));
    expect([rec.cleanerLink.sentAt, c.cleanerLink.sentAt]).toEqual([T2, T2]);
    const shelf = await readdir(join(c.dir, 'logs', 'snapshots'));
    expect(shelf.some((n) => n.endsWith('--before-cleaner.json'))).toBe(true);
    // The message's raws were the same pages: deleted with the claim, and the
    // chapter's raw is still the one link to the cleaner's copy.
    expect(await inboxNames()).toEqual([]);
    expect((await stat(join(cleanerCopies, 'c7-0-40x60.jpg'))).nlink).toBe(2);
  });

  it('replaces the raw of a re-sourced page with a new size and moves its boxes', async () => {
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    let { c } = onlyChapter();
    const rec0 = await record(c);
    rec0.pages[1].boxes = [{ id: 'b1', lineN: null, text: 'typeset', x: 10, y: 20, w: 30, h: 10, style: {} }];
    await writeFile(join(c.dir, 'chapter.json'), JSON.stringify(rec0, null, 2));
    await send({ sentAt: T2, pages: [{ src: 1, raw: 25, cleaned: 225, w: 80, h: 120 }] });
    const [r] = await checkHandoffs(dataRoot);
    expect(r).toMatchObject({ outcome: 'updated', replaced: 1, added: 0 });
    ({ c } = onlyChapter());
    const pg = (await record(c)).pages[1];
    expect([pg.file, pg.cleaned, pg.w, pg.h]).toEqual(['001.png', '001-2.png', 80, 120]);
    expect(pg.boxes[0]).toMatchObject({ x: 20, y: 40, w: 60, h: 20 });
    // The old raw stays for the snapshot that names it; the new one is a new
    // file, never written over the old.
    expect(await readFile(join(c.dir, 'raws', '002.png'))).toEqual(png(20));
    expect(await readFile(join(c.dir, 'raws', '001.png'))).toEqual(png(25, 80, 120));
  });

  it('inserts new pages in the cleaner order next to their matched neighbours', async () => {
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    await send({
      sentAt: T2,
      pages: [
        { src: 5, raw: 50, cleaned: 250 },
        { src: 0, raw: 10, cleaned: null, jpeg: true },
        { src: 6, raw: 60, cleaned: 260 },
        { src: 2, raw: 30, cleaned: null },
        { src: 7, raw: 70, cleaned: null },
      ],
    });
    const [r] = await checkHandoffs(dataRoot);
    expect(r).toMatchObject({ outcome: 'updated', replaced: 0, added: 3, pageCount: 6 });
    const { c } = onlyChapter();
    const rec = await record(c);
    // 5 before page 1, 6 after page 1, page 2 (not in the send) kept, 7 after page 3.
    expect(rec.pages.map((pg) => pg.id)).toEqual([4, 1, 5, 2, 3, 6]);
    expect(rec.cleanerLink.pages).toEqual(
      expect.arrayContaining([
        { sourceIdx: 5, pageId: 4 },
        { sourceIdx: 6, pageId: 5 },
        { sourceIdx: 7, pageId: 6 },
      ]),
    );
    expect(c.pageCount).toBe(6);
  });

  it('drops a send that is not newer than the one filed, so filing twice changes nothing', async () => {
    await send({ sentAt: T2, pages: THREE });
    await checkHandoffs(dataRoot);
    const { c } = onlyChapter();
    const before = await readFile(join(c.dir, 'chapter.json'), 'utf8');
    for (const sentAt of [T1, T2]) {
      await send({ sentAt, pages: [{ src: 0, raw: 10, cleaned: 99, jpeg: true }] });
      const [r] = await checkHandoffs(dataRoot);
      expect(r.outcome).toBe('stale');
      expect(await inboxNames()).toEqual([]);
    }
    expect(await readFile(join(c.dir, 'chapter.json'), 'utf8')).toBe(before);
  });
});

describe('a send for the chapter that is open', () => {
  it('waits for the chapter to close, then files it; the save keeps the link', async () => {
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    const { p, c } = onlyChapter();
    await openChapter(p.id, c.id);
    // The open chapter's save rebuilds the pages from the editor; the link is
    // a chapter field and rides along.
    await saveOpenChapter();
    expect((await record(c)).cleanerLink.sentAt).toBe(T1);

    await send({ sentAt: T2, pages: [{ src: 0, raw: 10, cleaned: 212, jpeg: true }] });
    const before = await readFile(join(c.dir, 'chapter.json'), 'utf8');
    const [r] = await checkHandoffs(dataRoot);
    expect(r.outcome).toBe('deferred');
    expect(await inboxNames()).toEqual([KEY]);
    expect(await readFile(join(c.dir, 'chapter.json'), 'utf8')).toBe(before);
    // While it stays open the message is not claimed again.
    expect(await checkHandoffs(dataRoot)).toEqual([]);

    closeChapter();
    const [after] = await checkHandoffs(dataRoot);
    expect(after).toMatchObject({ outcome: 'updated', replaced: 1 });
    expect((await record(onlyChapter().c)).pages[0].cleaned).toBe('001-2.png');
  });

  it('gives its claim up to a newer send that arrived while it waited', async () => {
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    const { p, c } = onlyChapter();
    await openChapter(p.id, c.id);
    await send({ sentAt: T2, pages: [{ src: 0, raw: 10, cleaned: 213, jpeg: true }] });
    // The cleaner sends again just as the claim is about to go back.
    const realPutBack = io.putBack;
    io.putBack = async (root, claim, key) => {
      await send({ sentAt: T3, pages: [{ src: 0, raw: 10, cleaned: 214, jpeg: true }] });
      return realPutBack(root, claim, key);
    };
    const [r] = await checkHandoffs(dataRoot);
    expect(r.outcome).toBe('deferred');
    expect(await inboxNames()).toEqual([KEY]);
    const doc = JSON.parse(await readFile(join(inbox(), KEY, 'handoff.json'), 'utf8'));
    expect(doc.sentAt).toBe(T3);
  });

  it('holds the open of a chapter until an apply in progress has landed', async () => {
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    const { p, c } = onlyChapter();
    await send({ sentAt: T2, pages: [{ src: 1, raw: 20, cleaned: 230 }] });
    const realTake = io.take;
    let opening = null;
    io.take = async (...args) => {
      // The user opens the chapter while its files are being moved in.
      opening ??= openChapter(p.id, c.id);
      return realTake(...args);
    };
    const [r] = await checkHandoffs(dataRoot);
    expect(r.outcome).toBe('updated');
    await opening;
    // The open waited for the apply: it shows the new page, and a save from
    // it keeps both the page and the link.
    expect(app.pages[1].cleanedFile).toBe('001-2.png');
    await saveOpenChapter();
    const rec = await record(c);
    expect([rec.pages[1].cleaned, rec.cleanerLink.sentAt]).toEqual(['001-2.png', T2]);
    closeChapter();
  });
});

describe('claims and refusals', () => {
  it('skips a message someone else claimed first', async () => {
    await send({ sentAt: T1, pages: THREE });
    const realClaim = io.claim;
    io.claim = async (root, key) => {
      await fsRename(join(inbox(), key), join(inbox(), `.claimed-${key}-other`));
      return realClaim(root, key);
    };
    expect(await checkHandoffs(dataRoot)).toEqual([]);
    expect(library.projects.flatMap((p) => p.chapters)).toHaveLength(0);
    expect(await inboxNames()).toEqual([`.claimed-${KEY}-other`]);
  });

  it('puts back a claim a stopped run left behind, and files it', async () => {
    await send({ sentAt: T1, pages: THREE });
    await fsRename(join(inbox(), KEY), join(inbox(), `.claimed-${KEY}-dead1`));
    const [r] = await checkHandoffs(dataRoot);
    expect(r.outcome).toBe('created');
    expect(await inboxNames()).toEqual([]);
  });

  it('files nothing while the cleaner holds move.lock, or outside Shared mode', async () => {
    await send({ sentAt: T1, pages: THREE });
    io.busy = true;
    expect(await checkHandoffs(dataRoot)).toEqual([]);
    io.busy = false;
    dataFolder.mode = 'pending';
    expect(await checkHandoffs(dataRoot)).toEqual([]);
    dataFolder.mode = 'shared';
    await setRoot(join(tmp, 'legacy-library'));
    expect(await checkHandoffs(dataRoot)).toEqual([]);
    expect(await inboxNames()).toEqual([KEY]);
  });

  it('never reads names that start with a dot', async () => {
    await send({ sentAt: T1, pages: THREE });
    await fsRename(join(inbox(), KEY), join(inbox(), `.staging-${KEY}-x`));
    expect(await checkHandoffs(dataRoot)).toEqual([]);
  });

  it('sets aside a message that does not check out, with the reason', async () => {
    await send({ sentAt: T1, pages: THREE });
    // A cleaned page that is not the raw's size.
    await writeFile(join(inbox(), KEY, 'cleaned', '002.png'), png(1, 41, 60));
    const [r] = await checkHandoffs(dataRoot);
    expect(r.outcome).toBe('rejected');
    const rejected = await readdir(join(dataRoot, 'handoff', 'rejected'));
    expect(rejected).toHaveLength(1);
    expect(rejected[0].startsWith(`${KEY}-`)).toBe(true);
    const reason = await readFile(join(dataRoot, 'handoff', 'rejected', rejected[0], 'reason.txt'), 'utf8');
    expect(reason).toMatch(/cleaned\/002\.png is 41x60/);
    expect(await inboxNames()).toEqual([]);
    await scanLibrary();
    expect(library.projects).toHaveLength(0);
  });

  it('puts every file back when a send cannot be applied', async () => {
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    const { c } = onlyChapter();
    const before = await readFile(join(c.dir, 'chapter.json'), 'utf8');
    await send({ sentAt: T2, pages: [{ src: 0, raw: 10, cleaned: 240, jpeg: true }, { src: 9, raw: 90, cleaned: 290 }] });
    const realTake = io.take;
    let n = 0;
    io.take = async (...args) => {
      if (++n === 3) throw new Error('disk full');
      return realTake(...args);
    };
    const [r] = await checkHandoffs(dataRoot);
    expect(r).toMatchObject({ outcome: 'failed', error: 'disk full' });
    expect(await readFile(join(c.dir, 'chapter.json'), 'utf8')).toBe(before);
    // The message is whole again, under its key, for the next try.
    expect(await inboxNames()).toEqual([KEY]);
    expect((await readdir(join(inbox(), KEY, 'cleaned'))).sort()).toEqual(['001.png', '002.png']);
    io.take = realTake;
    _resetHandoffForTests();
    const [again] = await checkHandoffs(dataRoot);
    expect(again).toMatchObject({ outcome: 'updated', replaced: 1, added: 1 });
  });
});

describe('a claim stays whole until it is filed', () => {
  it('a failed delete of the claim puts back a whole message, and the next pass drops it as stale', async () => {
    await send({ sentAt: T1, pages: THREE });
    const realDone = io.done;
    io.done = async () => {
      throw new Error('the drive went away');
    };
    const [r] = await checkHandoffs(dataRoot);
    expect(r.outcome).toBe('failed');
    const { c } = onlyChapter();
    // Linked in, not moved: every file is still in the message.
    expect(await inboxNames()).toEqual([KEY]);
    expect((await readdir(join(inbox(), KEY, 'raws'))).sort()).toEqual(['001.jpg', '002.png', '003.png']);
    expect((await readdir(join(inbox(), KEY, 'cleaned'))).sort()).toEqual(['001.png', '002.png']);
    io.done = realDone;
    _resetHandoffForTests();
    const before = await readFile(join(c.dir, 'chapter.json'), 'utf8');
    const [again] = await checkHandoffs(dataRoot);
    expect(again.outcome).toBe('stale');
    expect(await readFile(join(c.dir, 'chapter.json'), 'utf8')).toBe(before);
    expect(await inboxNames()).toEqual([]);
    expect((await stat(join(cleanerCopies, 'c7-0-40x60.jpg'))).nlink).toBe(2);
  });

  it('copies where the drive has no hard links', async () => {
    io.noLinks = true;
    await send({ sentAt: T1, pages: THREE });
    const [r] = await checkHandoffs(dataRoot);
    expect(r.outcome).toBe('created');
    const { c } = onlyChapter();
    expect(await readFile(join(c.dir, 'cleaned', '002.png'))).toEqual(png(220));
  });

  it('drops an old send as stale before its files are checked', async () => {
    await send({ sentAt: T2, pages: THREE });
    await checkHandoffs(dataRoot);
    const key = await send({ sentAt: T1, pages: THREE });
    await rm(join(inbox(), key, 'cleaned', '002.png'));
    const [r] = await checkHandoffs(dataRoot);
    expect(r.outcome).toBe('stale');
    await expect(stat(join(dataRoot, 'handoff', 'rejected'))).rejects.toThrow();
    expect(await inboxNames()).toEqual([]);
  });

  it('a failure that says "open" is a failure, not a wait for the chapter', async () => {
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    await send({ sentAt: T2, pages: [{ src: 0, raw: 10, cleaned: 250, jpeg: true }] });
    io.failTake = () => {
      throw new Error('Could not open the page file');
    };
    const [r] = await checkHandoffs(dataRoot);
    expect(r).toMatchObject({ outcome: 'failed', error: 'Could not open the page file' });
    expect(await inboxNames()).toEqual([KEY]);
  });
});

describe('a re-send that did not change a page', () => {
  it('leaves a cleaned page with the same bytes as it is, with nothing in previous-cleaned', async () => {
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    await send({
      sentAt: T2,
      pages: [
        { src: 0, raw: 10, cleaned: 210, jpeg: true },
        { src: 1, raw: 20, cleaned: 221 },
        { src: 2, raw: 30, cleaned: null },
      ],
    });
    const [r] = await checkHandoffs(dataRoot);
    expect(r).toMatchObject({ outcome: 'updated', replaced: 1, added: 0 });
    const { c } = onlyChapter();
    const rec = await record(c);
    expect(rec.pages.map((pg) => pg.cleaned)).toEqual(['001.png', '002-2.png', null]);
    expect(await readdir(join(c.dir, 'logs', 'previous-cleaned'))).toEqual(['002.png']);
    expect(await readdir(join(c.dir, 'cleaned'))).toEqual(['001.png', '002-2.png']);
    // The same send again, newer: nothing changes on disk but the time.
    await send({
      sentAt: T3,
      pages: [
        { src: 0, raw: 10, cleaned: 210, jpeg: true },
        { src: 1, raw: 20, cleaned: 221 },
        { src: 2, raw: 30, cleaned: null },
      ],
    });
    const [r3] = await checkHandoffs(dataRoot);
    expect(r3).toMatchObject({ outcome: 'updated', replaced: 0 });
    expect(await readdir(join(c.dir, 'logs', 'previous-cleaned'))).toEqual(['002.png']);
    expect((await record(c)).pages.map((pg) => pg.cleaned)).toEqual(['001.png', '002-2.png', null]);
  });
});

// The message the cleaner's writer test compares its output to
// (SHARED_DATA_FOLDER.md section 10), checked into both repositories.
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'handoff', 'golden');
const haveGolden = await stat(join(GOLDEN, 'handoff.json')).then(() => true, () => false);

describe.skipIf(!haveGolden)('the golden message', () => {
  it('is filed as a new chapter with every page', async () => {
    const doc = JSON.parse(await readFile(join(GOLDEN, 'handoff.json'), 'utf8'));
    const ids = doc.cleaner;
    const key = `cleaner-${ids.libraryId}-${ids.projectId}-${ids.chapterId}`;
    await cp(GOLDEN, join(inbox(), key), { recursive: true });
    const [r] = await checkHandoffs(dataRoot);
    expect(r.outcome).toBe('created');
    const { c } = onlyChapter();
    const rec = await record(c);
    expect(rec.pages).toHaveLength(doc.pages.length);
    expect(rec.pages.map((pg) => [pg.w, pg.h])).toEqual(doc.pages.map((pg) => [pg.w, pg.h]));
    expect(rec.pages.some((pg) => /\.jpe?g$/i.test(pg.file))).toBe(true);
    expect(rec.cleanerLink.pages.map((m) => m.sourceIdx)).toEqual(doc.pages.map((pg) => pg.sourceIdx));
  });
});

// ===== Version 2: waiting to match, the match screen, linking (8.4) =====

const sha = async (p) => (await import('node:crypto')).createHash('sha256').update(await readFile(p)).digest('hex');
// A chapter made here by hand: raws (and cleaned pages) of the given levels,
// a text box on every page so nothing typeset may change.
async function pearChapter(p, number, pages) {
  return createChapterFromPages({
    projectId: p.id,
    number,
    title: `Chapter ${number}`,
    pages: pages.map((pg, i) => ({
      rawName: `${pad(i + 1)}.png`,
      rawBytes: pg.bytes ?? png(pg.raw, pg.w ?? 40, pg.h ?? 60),
      cleanedName: pg.cleaned != null ? `${pad(i + 1)}.png` : undefined,
      cleanedBytes: pg.cleaned != null ? png(pg.cleaned, pg.w ?? 40, pg.h ?? 60) : undefined,
      w: pg.w ?? 40,
      h: pg.h ?? 60,
      boxes: [{ id: `b${i}`, lineN: null, text: `hello ${i}`, x: 1, y: 2, w: 10, h: 5, style: { fontSize: 20 } }],
    })),
  });
}
// Every file of a chapter folder (but logs and the record) by its sha256.
async function hashes(dir) {
  const out = {};
  for (const sub of ['raws', 'cleaned']) {
    for (const n of await readdir(join(dir, sub)).catch(() => [])) out[`${sub}/${n}`] = await sha(join(dir, sub, n));
  }
  return out;
}
const planFor = (choice, chapters = {}) => handoffMatch.rows.map((r) => ({ rowId: r.id, choice: typeof choice === 'function' ? choice(r) : choice, chapters }));
const PLAIN3 = [
  { src: 0, raw: 10, cleaned: 210 },
  { src: 1, raw: 20, cleaned: 220 },
  { src: 2, raw: 30, cleaned: 230 },
];

describe('waiting to match', () => {
  it('a close name makes a single Save wait, untouched and not read again; the screen opens for it', async () => {
    const theirs = await createProject('Series name!');
    await send({ sentAt: T1, pages: THREE });
    const before = await stat(join(inbox(), KEY));
    expect(await checkHandoffs(dataRoot)).toEqual([]);
    expect(await inboxNames()).toEqual([KEY]);
    const after = await stat(join(inbox(), KEY));
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    expect(library.projects).toHaveLength(1);
    expect(library.projects[0].chapters).toHaveLength(0);
    expect(handoffMatch.rows).toHaveLength(1);
    expect(handoffMatch.rows[0]).toMatchObject({ name: 'Series Name', candidates: [theirs.id], fixed: null });
    expect([handoffMatch.bulk, handoffMatch.autoOpen]).toEqual([false, true]);
    // Judged: the next checks neither read nor claim it.
    const peeks = io.peeks;
    await checkHandoffs(dataRoot);
    await checkHandoffs(dataRoot);
    expect(io.peeks).toBe(peeks);
    // A project made here judges it again.
    await createProject('Something else');
    await checkHandoffs(dataRoot);
    expect(io.peeks).toBe(peeks + 1);
    // Its raws are read in place only for the match screen, never by the poll.
    expect(io.inPlaceFacts).toBe(0);
  });

  it('a Send to Pear shows the banner and never opens the screen by itself', async () => {
    await createProject('Series Name');
    await send({ sentAt: T1, pages: THREE, kind: 'bulk' });
    await checkHandoffs(dataRoot);
    expect([handoffMatch.rows.length, handoffMatch.bulk, handoffMatch.autoOpen]).toEqual([1, true, false]);
  });

  it('a linked project with an unlinked chapter of that number waits as one row with that project fixed', async () => {
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    const p = library.projects[0];
    await pearChapter(p, 13, PLAIN3);
    await send({ chapterId: 'c8', sentAt: T1, pages: PLAIN3, title: 'Chapter 13', number: 13, label: '13' });
    await checkHandoffs(dataRoot);
    expect(handoffMatch.rows).toHaveLength(1);
    expect(handoffMatch.rows[0].fixed).toBe(p.id);
    expect(library.projects[0].chapters.map((c) => c.number)).toEqual([12, 13]);
    // A row that may link: the poll still reads none of its raws.
    await checkHandoffs(dataRoot);
    expect(io.inPlaceFacts).toBe(0);
    // A chapter with no key never waits on a clash: it is always new.
    await send({ chapterId: 'c9', sentAt: T1, pages: PLAIN3, title: 'Extra', number: null, label: 'Extra' });
    const [r] = (await checkHandoffs(dataRoot)).filter((x) => x.key.endsWith('-c9'));
    expect(r.outcome).toBe('created');
  });
});

describe('content candidates', () => {
  const WIZ = 'The Wizard Who Lay with 10,000 Girls';
  it('a renamed title with a byte-identical raw waits for that title, ranked first, and links its chapter', async () => {
    const theirs = await createProject(WIZ);
    const ch3 = await pearChapter(theirs, 3, PLAIN3);
    const named = await createProject('Wizard who killed 10k!');
    await send({ sentAt: T1, pages: PLAIN3, name: 'wizard who killed 10k', title: 'Ch 3', number: 3, label: '3' });
    expect(await checkHandoffs(dataRoot)).toEqual([]);
    expect(await inboxNames()).toEqual([KEY]);
    expect(handoffMatch.rows).toHaveLength(1);
    // Content first, then the name that is close.
    expect(handoffMatch.rows[0].candidates).toEqual([theirs.id, named.id]);
    // Judged once: the next polls stat and hash nothing.
    const [stats, hashed] = [io.statCalls, io.hashCalls];
    await checkHandoffs(dataRoot);
    await checkHandoffs(dataRoot);
    expect([io.statCalls, io.hashCalls]).toEqual([stats, hashed]);
    const results = await applyMatch(dataRoot, planFor(theirs.id));
    expect(results.map((r) => r.outcome)).toEqual(['linked']);
    expect(library.projects.find((p) => p.id === theirs.id).chapters.map((c) => c.id)).toEqual([ch3.id]);
  });

  it('hashes nothing when no size is equal, and skips a title linked to that cleaner library', async () => {
    const other = await createProject('Nothing alike');
    await pearChapter(other, 1, [{ raw: 1, w: 300, h: 500 }, { raw: 2, w: 300, h: 500 }, { raw: 3, w: 300, h: 500 }]);
    await send({ sentAt: T1, pages: PLAIN3, name: 'wizard who killed 10k' });
    expect((await checkHandoffs(dataRoot)).map((r) => r.outcome)).toEqual(['created']);
    expect(io.hashCalls).toBe(0);
    // The new title is linked to this cleaner library: its raws make it no
    // candidate for another of the cleaner's titles.
    await send({ projectId: 'p4', chapterId: 'c9', sentAt: T1, pages: PLAIN3, name: 'Something else entirely' });
    expect((await checkHandoffs(dataRoot)).map((r) => r.outcome)).toEqual(['created']);
    expect(handoffMatch.rows).toEqual([]);
  });

  // The rehearsal's split: Ch 2 shares nothing with Pear, Ch 3 has raws
  // identical to a title here. One cleaner title must stay one title.
  const OWN = [
    { src: 0, raw: 77, cleaned: 177, w: 33 },
    { src: 1, raw: 78, cleaned: 178, w: 33 },
  ];
  const ch2 = (kind, sentAt = T1) => send({ chapterId: 'c2', sentAt, pages: OWN, name: 'wizard who killed 10k', title: 'Ch 2', number: 2, label: '2', kind });
  const ch3 = (kind, sentAt = T1) => send({ chapterId: 'c3', sentAt, pages: PLAIN3, name: 'wizard who killed 10k', title: 'Ch 3', number: 3, label: '3', kind });
  const wizardRow = () => handoffMatch.rows.find((r) => r.name === 'wizard who killed 10k');

  it('judges a title as a whole: a chapter with no candidate waits with one that has a content candidate (one poll)', async () => {
    const theirs = await createProject(WIZ);
    await pearChapter(theirs, 3, PLAIN3);
    await ch2();
    await ch3();
    expect(await checkHandoffs(dataRoot)).toEqual([]);
    expect(library.projects.map((p) => p.name)).toEqual([WIZ]);
    expect(handoffMatch.rows).toHaveLength(1);
    expect(wizardRow().candidates).toEqual([theirs.id]);
    expect(wizardRow().messages.map((m) => m.title)).toEqual(['Ch 2', 'Ch 3']);
    // And stays so on the next checks.
    await checkHandoffs(dataRoot);
    expect(library.projects).toHaveLength(1);
    expect(wizardRow().messages).toHaveLength(2);
    // Apply: both chapters go to that one title.
    const results = await applyMatch(dataRoot, planFor(theirs.id));
    expect(results.map((r) => r.outcome).sort()).toEqual(['created', 'linked']);
    expect(library.projects).toHaveLength(1);
    expect(library.projects[0].chapters.map((c) => c.number)).toEqual([2, 3]);
  });

  it('a bulk title waits with no candidate, and a later chapter with a content candidate joins its row (two polls)', async () => {
    const theirs = await createProject(WIZ);
    await pearChapter(theirs, 3, PLAIN3);
    await ch2('bulk');
    expect(await checkHandoffs(dataRoot)).toEqual([]);
    expect(library.projects).toHaveLength(1);
    expect(wizardRow()).toMatchObject({ candidates: [] });
    expect([handoffMatch.bulk, handoffMatch.autoOpen]).toEqual([true, false]);
    await ch3('bulk', T2);
    expect(await checkHandoffs(dataRoot)).toEqual([]);
    expect(library.projects).toHaveLength(1);
    expect(handoffMatch.rows).toHaveLength(1);
    expect(wizardRow().candidates).toEqual([theirs.id]);
    expect(wizardRow().messages).toHaveLength(2);
    expect(await inboxNames()).toHaveLength(2);
  });

  it('a Save with no candidate still files as version 1 did', async () => {
    await ch2();
    expect((await checkHandoffs(dataRoot)).map((r) => r.outcome)).toEqual(['created']);
    expect(library.projects.map((p) => p.name)).toEqual(['wizard who killed 10k']);
  });

  it('builds the size index once and judges a message against 3,000 raws quickly', async () => {
    const big = await createProject('Big library');
    // 3,000 raws: synthetic chapters written straight to disk, then read in.
    for (let c = 0; c < 100; c++) {
      const pages = [];
      for (let i = 0; i < 30; i++) pages.push({ raw: (c * 30 + i) % 250, w: 10 + (i % 7), h: 12 + ((c + i) % 11) });
      await pearChapter(big, c + 100, pages);
    }
    const theirs = await createProject(WIZ);
    await pearChapter(theirs, 3, PLAIN3);
    await scanLibrary();
    await send({ sentAt: T1, pages: PLAIN3, name: 'wizard who killed 10k', number: 3, label: '3' });
    const t0 = performance.now();
    await checkHandoffs(dataRoot);
    const first = performance.now() - t0;
    expect(handoffMatch.rows[0].candidates[0]).toBe(theirs.id);
    const indexStats = io.statCalls;
    expect(indexStats).toBeGreaterThanOrEqual(3003);
    // A second message: the index is not built again.
    await send({ chapterId: 'c8', sentAt: T1, pages: PLAIN3, name: 'wizard who killed 10k', number: 4, label: '4' });
    const t1 = performance.now();
    await checkHandoffs(dataRoot);
    const second = performance.now() - t1;
    expect(io.statCalls - indexStats).toBeLessThan(20);
    console.info(`[content candidates] 3,006 raws: first judge ${first.toFixed(0)} ms (index built), next ${second.toFixed(0)} ms`);
  }, 60000);
});

describe('the match screen applies', () => {
  it('a single Save into its candidate makes no second title', async () => {
    const theirs = await createProject('Series Name');
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    const results = await applyMatch(dataRoot, planFor(theirs.id));
    expect(results.map((r) => r.outcome)).toEqual(['created']);
    await scanLibrary();
    expect(library.projects).toHaveLength(1);
    expect(library.projects[0].chapters.map((c) => c.number)).toEqual([12]);
    expect((await projectRecord(library.projects[0])).cleanerLink).toEqual({ libraryId: LIB, projectId: 'p3' });
    expect(await inboxNames()).toEqual([]);
    // The next Save of that title files into it with no question.
    await send({ chapterId: 'c8', sentAt: T2, pages: THREE, number: 13, label: '13' });
    expect((await checkHandoffs(dataRoot)).map((r) => r.outcome)).toEqual(['created']);
    expect(library.projects).toHaveLength(1);
  });

  it('writing the link adds that one key to project.json and changes nothing else', async () => {
    // Section 8.4.3: an older record (a tag with `strokes`, no exportScale,
    // no guide, a key this version does not know) is not rewritten in the
    // current form by a match.
    const theirs = await createProject('Series Name');
    await pearChapter(theirs, 12, PLAIN3);
    const path = join(theirs.dir, 'project.json');
    const { exportScale, guide, tagSizes, ocrLanguage, ...kept } = JSON.parse(await readFile(path, 'utf8'));
    const old = {
      ...kept,
      updatedAt: '2026-01-02T03:04:05.000Z',
      tags: [{ id: 't1', name: 'Speech', style: { fontSize: 30, strokes: [{ width: 3, color: '#ffffff' }] } }],
      somethingNewer: { kept: true },
    };
    await writeFile(path, JSON.stringify(old, null, 2));
    await scanLibrary();
    const before = JSON.parse(await readFile(path, 'utf8'));
    expect(before).toEqual(old);
    await send({ sentAt: T1, pages: PLAIN3 });
    await checkHandoffs(dataRoot);
    expect(handoffMatch.rows[0].candidates[0]).toBe(theirs.id);
    const results = await applyMatch(dataRoot, planFor(theirs.id));
    expect(results.map((r) => r.outcome)).toEqual(['linked']);
    const after = JSON.parse(await readFile(path, 'utf8'));
    expect(after.cleanerLink).toEqual({ libraryId: LIB, projectId: 'p3' });
    const { cleanerLink, ...rest } = after;
    expect(rest).toEqual(before);
    expect(Object.keys(rest)).toEqual(Object.keys(before));
    expect(library.projects.find((p) => p.id === theirs.id).cleanerLink).toEqual({ libraryId: LIB, projectId: 'p3' });
  });

  it('a chapter filed into a title here patches only the keys it sets in project.json', async () => {
    // An older record again; filing sets the cover (first chapter) or only
    // the time (a later one), and nothing else changes.
    const theirs = await createProject('Series Name');
    const path = join(theirs.dir, 'project.json');
    const { exportScale, guide, tagSizes, ocrLanguage, ...kept } = JSON.parse(await readFile(path, 'utf8'));
    const old = {
      ...kept,
      updatedAt: '2026-01-02T03:04:05.000Z',
      tags: [{ id: 't1', name: 'Speech', style: { fontSize: 30, strokes: [{ width: 3, color: '#ffffff' }] } }],
      somethingNewer: { kept: true },
    };
    await writeFile(path, JSON.stringify(old, null, 2));
    await scanLibrary();
    const without = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
    // Through the match screen: link, then the first chapter sets the cover.
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    expect((await applyMatch(dataRoot, planFor(theirs.id))).map((r) => r.outcome)).toEqual(['created']);
    const first = JSON.parse(await readFile(path, 'utf8'));
    expect(first.coverChapterId).toBe(library.projects.find((p) => p.id === theirs.id).chapters[0].id);
    expect(without(first, ['cleanerLink', 'coverChapterId', 'coverPageId', 'updatedAt'])).toEqual(without(old, ['coverChapterId', 'coverPageId', 'updatedAt']));
    // The 3-second check files the next chapter: only updatedAt changes.
    await send({ chapterId: 'c8', sentAt: T2, pages: THREE, number: 13, label: '13' });
    expect((await checkHandoffs(dataRoot)).map((r) => r.outcome)).toEqual(['created']);
    const second = JSON.parse(await readFile(path, 'utf8'));
    expect(without(second, ['updatedAt'])).toEqual(without(first, ['updatedAt']));
    expect(Object.keys(second)).toEqual(Object.keys(first));
  });

  it('link, keep Pear’s pages: the page map, no image, box or lettering changed, a missing cleaned page taken', async () => {
    const theirs = await createProject('Series Name');
    const c = await pearChapter(theirs, 12, [
      { raw: 11, cleaned: 111 },
      { raw: 21, cleaned: 121 },
      { raw: 31, cleaned: null },
    ]);
    const before = await hashes(c.dir);
    const boxes = (await record(c)).pages.map((pg) => pg.boxes);
    await send({ sentAt: T1, pages: PLAIN3 });
    await checkHandoffs(dataRoot);
    const m = handoffMatch.rows[0].messages[0];
    expect(chapterTarget(handoffMatch.rows[0], theirs.id, m)).toMatchObject({ action: 'link' });
    const pairing = await pairingFor(dataRoot, KEY, m, c, theirs.id);
    expect([pairing.ok, pairing.identical, pairing.byPosition, pairing.thumbs.length]).toEqual([true, 0, 3, 3]);
    const [r] = await applyMatch(dataRoot, planFor(theirs.id));
    expect(r.outcome).toBe('linked');
    const rec = await record(c);
    expect(rec.cleanerLink).toMatchObject({ libraryId: LIB, projectId: 'p3', chapterId: 'c7', sentAt: T1 });
    expect(rec.cleanerLink.pages).toEqual([
      { sourceIdx: 0, pageId: 1 },
      { sourceIdx: 1, pageId: 2 },
      { sourceIdx: 2, pageId: 3 },
    ]);
    const after = await hashes(c.dir);
    for (const [name, h] of Object.entries(before)) expect(after[name]).toBe(h);
    expect(rec.pages.map((pg) => pg.boxes)).toEqual(boxes);
    expect(rec.pages.map((pg) => pg.file)).toEqual(['001.png', '002.png', '003.png']);
    expect(rec.pages.map((pg) => pg.cleaned)).toEqual(['001.png', '002.png', '003.png']);
    expect(await readFile(join(c.dir, 'cleaned', '003.png'))).toEqual(png(230));
    expect(await inboxNames()).toEqual([]);
    // From now on a Save updates it like any linked chapter.
    await send({ sentAt: T2, pages: [{ src: 0, raw: 10, cleaned: 212 }] });
    const [u] = await checkHandoffs(dataRoot);
    expect(u).toMatchObject({ outcome: 'updated', replaced: 1 });
  });

  it('replace: the message’s cleaned pages replace these, the old ones kept', async () => {
    const theirs = await createProject('Series Name');
    const c = await pearChapter(theirs, 12, [
      { raw: 11, cleaned: 111 },
      { raw: 21, cleaned: 121 },
      { raw: 31, cleaned: 131 },
    ]);
    await send({ sentAt: T1, pages: [{ src: 0, raw: 10, cleaned: 210 }, { src: 1, raw: 20, cleaned: 121 }, { src: 2, raw: 30, cleaned: null }] });
    await checkHandoffs(dataRoot);
    const [r] = await applyMatch(dataRoot, planFor(theirs.id, { [KEY]: 'replace' }));
    expect(r.outcome).toBe('linked');
    const rec = await record(c);
    // Page 2's bytes were the same: no churn. Page 3 had none to give.
    expect(rec.pages.map((pg) => pg.cleaned)).toEqual(['001-2.png', '002.png', '003.png']);
    expect(await readFile(join(c.dir, 'cleaned', '001-2.png'))).toEqual(png(210));
    expect(await readdir(join(c.dir, 'logs', 'previous-cleaned'))).toEqual(['001.png']);
  });

  it('separate: a new linked chapter next to the one here', async () => {
    const theirs = await createProject('Series Name');
    await pearChapter(theirs, 12, PLAIN3);
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    const [r] = await applyMatch(dataRoot, planFor(theirs.id, { [KEY]: 'separate' }));
    expect(r.outcome).toBe('created');
    const p = library.projects.find((x) => x.id === theirs.id);
    expect(p.chapters.map((c) => [c.number, !!c.cleanerLink])).toEqual([
      [12, false],
      [12, true],
    ]);
  });

  it('a new title in Pear, as version 1 would have filed it', async () => {
    await createProject('Series Name');
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    const [r] = await applyMatch(dataRoot, planFor('new'));
    expect(r.outcome).toBe('created');
    expect(library.projects.filter((p) => p.cleanerLink)).toHaveLength(1);
    expect(library.projects).toHaveLength(2);
  });

  it('pairing is refused on the page count and on a page size, and then nothing is linked', async () => {
    const theirs = await createProject('Series Name');
    const two = await pearChapter(theirs, 12, PLAIN3.slice(0, 2));
    await send({ sentAt: T1, pages: PLAIN3 });
    await checkHandoffs(dataRoot);
    const m = handoffMatch.rows[0].messages[0];
    expect(await pairingFor(dataRoot, KEY, m, two, theirs.id)).toEqual({ ok: false, why: 'Pages differ: 3 in Manga Cleaner, 2 in Pear' });
    const before = await readFile(join(two.dir, 'chapter.json'), 'utf8');
    const [r] = await applyMatch(dataRoot, planFor(theirs.id, { [KEY]: 'link' }));
    expect(r).toMatchObject({ outcome: 'unpaired', reason: 'Pages differ: 3 in Manga Cleaner, 2 in Pear' });
    expect(await readFile(join(two.dir, 'chapter.json'), 'utf8')).toBe(before);
    expect(await inboxNames()).toEqual([KEY]);

    const sized = await pearChapter(await createProject('Other one'), 1, [{ raw: 1 }, { raw: 2, w: 41 }, { raw: 3 }]);
    const p2 = library.projects.find((p) => p.chapters.some((c) => c.id === sized.id));
    const bad = await pairingFor(dataRoot, KEY, m, sized, p2.id);
    expect(bad.ok).toBe(false);
    expect(bad.why).toMatch(/Page 2 is 40x60 in Manga Cleaner and 41x60 in Pear/);
  });

  it('keep waiting, and a new chapter beside one Pear has, claim nothing and add no chapter', async () => {
    const theirs = await createProject('Series Name');
    const two = await pearChapter(theirs, 12, PLAIN3.slice(0, 2));
    await send({ sentAt: T1, pages: PLAIN3 });
    await checkHandoffs(dataRoot);
    for (const action of ['wait', 'new']) {
      const results = await applyMatch(dataRoot, planFor(theirs.id, { [KEY]: action }));
      closeMatch();
      expect(results.map((r) => r.outcome)).toEqual(['waiting']);
      expect(await inboxNames()).toEqual([KEY]);
      expect(library.projects.find((p) => p.id === theirs.id).chapters.map((c) => c.id)).toEqual([two.id]);
      await checkHandoffs(dataRoot);
      expect(handoffMatch.rows).toHaveLength(1);
    }
    // Shown again, but the screen does not open itself a second time.
    expect(handoffMatch.autoOpen).toBe(false);
  });

  it('identical raws: the raw here becomes the cleaner’s file, only once the link is written', async () => {
    const theirs = await createProject('Series Name');
    // The same bytes the cleaner's pages have, imported here by hand.
    const c = await pearChapter(theirs, 12, [{ raw: 10, cleaned: 111 }, { raw: 20, cleaned: 121 }, { raw: 99, cleaned: 131 }]);
    await send({ sentAt: T1, pages: PLAIN3 });
    await checkHandoffs(dataRoot);
    const m = handoffMatch.rows[0].messages[0];
    const pairing = await pairingFor(dataRoot, KEY, m, c, theirs.id);
    expect([pairing.identical, pairing.byPosition]).toEqual([2, 1]);
    const shares = [];
    const realShare = io.shareRaw;
    io.shareRaw = async (root, claim, rel, dest) => {
      shares.push((await record(c)).cleanerLink?.chapterId ?? null);
      return realShare(root, claim, rel, dest);
    };
    await applyMatch(dataRoot, planFor(theirs.id));
    expect(shares).toEqual(['c7', 'c7']);
    const mine = await stat(join(c.dir, 'raws', '001.png'));
    const theirsCopy = await stat(join(cleanerCopies, 'c7-0-40x60.png'));
    expect(mine.ino).toBe(theirsCopy.ino);
    expect(await readFile(join(c.dir, 'raws', '001.png'))).toEqual(png(10));
    expect((await stat(join(c.dir, 'raws', '003.png'))).ino).not.toBe((await stat(join(cleanerCopies, 'c7-2-40x60.png'))).ino);
  });

  it('identical raws on a drive without links: skipped, nothing else changes', async () => {
    const theirs = await createProject('Series Name');
    const c = await pearChapter(theirs, 12, [{ raw: 10, cleaned: 111 }, { raw: 20, cleaned: 121 }, { raw: 30, cleaned: 131 }]);
    const before = await hashes(c.dir);
    io.noShare = true;
    await send({ sentAt: T1, pages: PLAIN3 });
    await checkHandoffs(dataRoot);
    const [r] = await applyMatch(dataRoot, planFor(theirs.id));
    expect(r.outcome).toBe('linked');
    expect(await hashes(c.dir)).toEqual(before);
  });

  it('a chapter open here is not linked; it keeps waiting', async () => {
    const theirs = await createProject('Series Name');
    const c = await pearChapter(theirs, 12, PLAIN3);
    await send({ sentAt: T1, pages: PLAIN3 });
    await checkHandoffs(dataRoot);
    await openChapter(theirs.id, c.id);
    const [r] = await applyMatch(dataRoot, planFor(theirs.id));
    expect(r.outcome).toBe('open');
    expect(await inboxNames()).toEqual([KEY]);
    closeChapter();
    // The title is linked now, so the chapter waits on its number, fixed.
    await checkHandoffs(dataRoot);
    expect(handoffMatch.rows.map((r) => r.fixed)).toEqual([theirs.id]);
    const [again] = await applyMatch(dataRoot, planFor(theirs.id));
    expect(again.outcome).toBe('linked');
    expect((await record(c)).cleanerLink.chapterId).toBe('c7');
  });

  it('re-reads each message: one replaced by a newer Save is put back and shown again', async () => {
    const theirs = await createProject('Series Name');
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    await send({ sentAt: T2, pages: THREE });
    const [r] = await applyMatch(dataRoot, planFor(theirs.id));
    expect(r.outcome).toBe('changed');
    expect(await inboxNames()).toEqual([KEY]);
    expect(library.projects.find((p) => p.id === theirs.id).chapters).toHaveLength(0);
  });

  it('runs in the single flight: no check files a row while the screen is open', async () => {
    await createProject('Series Name');
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    openMatch();
    expect(handoffMatch.open).toBe(true);
    // Something that would file at once waits too.
    await send({ projectId: 'p9', chapterId: 'c1', sentAt: T1, pages: THREE, name: 'Unrelated' });
    expect(await checkHandoffs(dataRoot)).toEqual([]);
    expect((await inboxNames()).sort()).toEqual([KEY, `cleaner-${LIB}-p9-c1`].sort());
    closeMatch();
    expect((await checkHandoffs(dataRoot)).map((x) => x.outcome)).toEqual(['created']);
  });
});

describe('skip', () => {
  const skipsFile = () => join(dataRoot, 'Typesetter', 'handoff-skips.json');

  it('a title: deleted, recorded here; a later bulk send goes unasked, a later Save asks again', async () => {
    await createProject('Series Name');
    await send({ sentAt: T1, pages: THREE, kind: 'bulk' });
    await checkHandoffs(dataRoot);
    const [r] = await applyMatch(dataRoot, planFor('skip'));
    expect(r.outcome).toBe('skipped');
    expect(await inboxNames()).toEqual([]);
    const rec = JSON.parse(await readFile(skipsFile(), 'utf8'));
    expect(rec.titles).toEqual([{ libraryId: LIB, projectId: 'p3', skippedAt: expect.any(String) }]);
    _resetHandoffForTests();
    // Another Send to Pear: deleted unasked.
    await send({ chapterId: 'c8', sentAt: new Date(Date.now() + 1000).toISOString(), pages: THREE, kind: 'bulk' });
    expect((await checkHandoffs(dataRoot)).map((x) => x.outcome)).toEqual(['skipped']);
    expect(await inboxNames()).toEqual([]);
    // A Save after the skip waits again.
    await send({ sentAt: new Date(Date.now() + 2000).toISOString(), pages: THREE });
    expect(await checkHandoffs(dataRoot)).toEqual([]);
    expect(handoffMatch.rows).toHaveLength(1);
    // Matched: the skip record goes.
    await applyMatch(dataRoot, planFor('new'));
    expect(JSON.parse(await readFile(skipsFile(), 'utf8')).titles).toEqual([]);
  });

  it('a chapter: only that one is skipped', async () => {
    const theirs = await createProject('Series Name');
    await send({ sentAt: T1, pages: THREE });
    await send({ chapterId: 'c8', sentAt: T1, pages: THREE, number: 13, label: '13' });
    await checkHandoffs(dataRoot);
    const results = await applyMatch(dataRoot, planFor(theirs.id, { [KEY]: 'skip' }));
    expect(results.map((x) => x.outcome).sort()).toEqual(['created', 'skipped']);
    expect(JSON.parse(await readFile(skipsFile(), 'utf8')).chapters).toEqual([
      { libraryId: LIB, projectId: 'p3', chapterId: 'c7', skippedAt: expect.any(String) },
    ]);
    _resetHandoffForTests();
    await send({ sentAt: new Date(Date.now() + 1000).toISOString(), pages: THREE, kind: 'bulk' });
    expect((await checkHandoffs(dataRoot)).map((x) => x.outcome)).toEqual(['skipped']);
  });
});

// The version 2 golden messages (SHARED_DATA_FOLDER.md section 10), checked
// into both repositories next to the version 1 one.
const GOLDEN2 = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'handoff', 'golden-v2');
const haveGolden2 = await stat(join(GOLDEN2, 'candidate', 'handoff.json')).then(() => true, () => false);
const goldenKey = (doc) => `cleaner-${doc.cleaner.libraryId}-${doc.cleaner.projectId}-${doc.cleaner.chapterId}`;

describe.skipIf(!haveGolden2)('the version 2 golden messages', () => {
  it('candidate: "Dungeon streamer" waits for "Dungeon Steamer", nothing here changes, and the row preselects it', async () => {
    const theirs = await createProject('Dungeon Steamer');
    const projectBefore = await readFile(join(theirs.dir, 'project.json'), 'utf8');
    const doc = JSON.parse(await readFile(join(GOLDEN2, 'candidate', 'handoff.json'), 'utf8'));
    expect([doc.send, doc.chapter.cleanedPages]).toEqual(['bulk', 3]);
    await cp(join(GOLDEN2, 'candidate'), join(inbox(), goldenKey(doc)), { recursive: true });
    expect(await checkHandoffs(dataRoot)).toEqual([]);
    expect(await inboxNames()).toEqual([goldenKey(doc)]);
    await scanLibrary();
    expect(library.projects).toHaveLength(1);
    expect(await readFile(join(theirs.dir, 'project.json'), 'utf8')).toBe(projectBefore);
    expect(handoffMatch.bulk).toBe(true);
    const row = handoffMatch.rows[0];
    expect(row).toMatchObject({ name: 'Dungeon streamer', candidates: [theirs.id] });
    expect(row.messages[0]).toMatchObject({ numberKey: 1, cleanedPages: 3, send: 'bulk' });
  });

  it('link: "link, keep Pear’s pages" writes the page map and changes no image, box or lettering', async () => {
    const doc = JSON.parse(await readFile(join(GOLDEN2, 'link', 'handoff.json'), 'utf8'));
    const theirs = await createProject('Surviving the Apocalypse');
    // Chapter 3 here: the same count and sizes, its own pages.
    const c = await pearChapter(
      theirs,
      3,
      doc.pages.map((pg, i) => ({ bytes: png(60 + i, pg.w, pg.h), cleaned: 160 + i, w: pg.w, h: pg.h })),
    );
    const before = await hashes(c.dir);
    const recBefore = await record(c);
    await cp(join(GOLDEN2, 'link'), join(inbox(), goldenKey(doc)), { recursive: true });
    expect(await checkHandoffs(dataRoot)).toEqual([]);
    expect([handoffMatch.bulk, handoffMatch.autoOpen]).toEqual([false, true]);
    const [r] = await applyMatch(dataRoot, planFor(theirs.id));
    expect(r.outcome).toBe('linked');
    const rec = await record(c);
    expect(rec.cleanerLink.pages).toEqual(doc.pages.map((pg, i) => ({ sourceIdx: pg.sourceIdx, pageId: i + 1 })));
    expect(rec.cleanerLink.sentAt).toBe(doc.sentAt);
    expect(await hashes(c.dir)).toEqual(before);
    expect(rec.pages.map(({ boxes, file, cleaned, w, h }) => ({ boxes, file, cleaned, w, h }))).toEqual(
      recBefore.pages.map(({ boxes, file, cleaned, w, h }) => ({ boxes, file, cleaned, w, h })),
    );
    expect((await projectRecord(library.projects.find((p) => p.id === theirs.id))).cleanerLink).toEqual({
      libraryId: doc.cleaner.libraryId,
      projectId: 'p5',
    });
    expect(await inboxNames()).toEqual([]);
  });
});
