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

const { library, setRoot, setRootMustExist, createProject, openChapter, closeChapter, saveOpenChapter, scanLibrary } =
  await import('./library.svelte.js');
const { app } = await import('./store.svelte.js');
const { dataFolder } = await import('./data-folder.svelte.js');
const { checkHandoffs, _resetHandoffForTests, _setHandoffIO } = await import('./handoff.svelte.js');

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
async function send({ chapterId = 'c7', projectId = 'p3', sentAt, pages, name = 'Series Name', layout = 'pages', title = 'Chapter 12', number = 12, label = '12' }) {
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
    }),
  );
  await fsRename(staging, join(inbox(), key));
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

  it('leaves an unlinked project with the same name alone and makes a new one', async () => {
    const theirs = await createProject('Series Name');
    await send({ sentAt: T1, pages: THREE });
    await checkHandoffs(dataRoot);
    expect(library.projects).toHaveLength(2);
    expect(library.projects.find((p) => p.id === theirs.id).chapters).toHaveLength(0);
    // A second chapter of the same cleaner project goes into the linked one.
    await send({ chapterId: 'c8', sentAt: T1, pages: THREE, title: '', number: null, label: '13.5' });
    await checkHandoffs(dataRoot);
    const linked = library.projects.find((p) => p.cleanerLink);
    expect(linked.chapters.map((c) => c.number)).toEqual([12, 13.5]);
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
