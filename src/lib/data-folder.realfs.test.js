// ===== The data folder's modes, on a real disk =====
//
// data-folder.svelte.js decides legacy, pending, shared or unavailable from
// the Rust status (stood in for here) and this app's library root on a real
// temp folder, and the library must never create a missing root once a
// pointer is in force (SHARED_DATA_FOLDER.md section 5).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readdir, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./fsx.js', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  return {
    fsx: {
      async readDir(p) {
        const entries = await fs.readdir(p, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
      },
      readTextFile: (p) => fs.readFile(p, 'utf8'),
      writeTextFileAtomic: (p, c) => fs.writeFile(p, c, 'utf8'),
      liveTemps: () => new Set(),
      readFile: async (p) => new Uint8Array(await fs.readFile(p)),
      writeFile: (p, b) => fs.writeFile(p, b),
      mkdir: (p) => fs.mkdir(p, { recursive: true }),
      remove: (p) => fs.rm(p, { recursive: true, force: true }),
      rename: (a, b) => fs.rename(a, b),
      async exists(p) {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      },
      join: async (...parts) => path.join(...parts),
      homeDir: async () => tmpdir(),
    },
  };
});

const { library, setRoot, scanLibrary, createProject } = await import('./library.svelte.js');
const df = await import('./data-folder.svelte.js');
const { dataFolder, _setDataFolderCommands, _resetDataFolderForTests, initDataFolder, setUpSharedFolder, rootForPick } = df;

let tmp;
let n = 0;
let calls;
let status;
let replies;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mt-data-folder-'));
});
afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  _setDataFolderCommands(null);
});

// The Rust commands, recorded; `status` is what data_folder_status answers.
beforeEach(() => {
  _resetDataFolderForTests();
  library.projects = [];
  calls = [];
  replies = {};
  _setDataFolderCommands(async (cmd, args) => {
    calls.push([cmd, args]);
    if (replies[cmd]) return replies[cmd](args);
    if (cmd === 'data_folder_status') return status;
    if (cmd === 'data_folder_move_busy') return false;
    return null;
  });
});

async function fixture({ legacyProject = false } = {}) {
  const base = join(tmp, `case-${++n}`);
  const legacy = join(base, 'Documents', 'MangaTypesetter');
  const root = join(base, 'Manga Library');
  await mkdir(legacy, { recursive: true });
  if (legacyProject) {
    await mkdir(join(legacy, 'series'), { recursive: true });
    await writeFile(join(legacy, 'series', 'project.json'), JSON.stringify({ schema: 1, id: 'p_1', name: 'Series' }));
  }
  await setRoot(legacy);
  return { base, legacy, root, target: join(root, 'Typesetter') };
}
const ok = (root, ready) => ({ state: 'ok', pointer: { schema: 1, path: root, folderId: 'f1' }, typesetterReady: ready });
const names = () => calls.map(([c]) => c);

describe('the mode', () => {
  it('is legacy without a pointer, and the library is untouched', async () => {
    const { legacy } = await fixture();
    status = { state: 'none', pointer: null };
    await initDataFolder();
    expect(dataFolder.mode).toBe('legacy');
    expect(library.root).toBe(legacy);
    expect(names()).toEqual(['data_folder_recover', 'data_folder_status']);
  });

  it('is unavailable when the folder is missing, and nothing makes it', async () => {
    const { root, target } = await fixture();
    for (const state of ['missing', 'noMarker', 'idMismatch', 'newer']) {
      status = { state, pointer: { schema: 1, path: root, folderId: 'f1' } };
      await initDataFolder();
      expect(dataFolder.mode).toBe('unavailable');
    }
    // Even pointed at the missing subfolder, the scan and a new project do
    // not bring it into being.
    await setRoot(target);
    await scanLibrary();
    expect(library.error).toMatch(/missing/);
    await expect(createProject('New')).rejects.toThrow(/missing/);
    await expect(stat(root)).rejects.toThrow();
    expect(names()).not.toContain('data_folder_open');
  });

  it('is shared when the library is already the shared one', async () => {
    const { root, target } = await fixture();
    await mkdir(target, { recursive: true });
    await setRoot(target);
    status = ok(root, true);
    await initDataFolder();
    expect(dataFolder.mode).toBe('shared');
    expect(calls).toContainEqual(['data_folder_open', { root }]);
  });

  it('is pending while this app’s library is still in its old place', async () => {
    const { legacy, root } = await fixture({ legacyProject: true });
    status = ok(root, false);
    await initDataFolder();
    expect(dataFolder.mode).toBe('pending');
    expect(library.root).toBe(legacy);
    expect(names()).not.toContain('data_folder_adopt');
  });

  it('makes the shared library at once when the old place holds nothing', async () => {
    const { root, target } = await fixture();
    status = ok(root, false);
    await initDataFolder();
    expect(names()).toContain('data_folder_adopt');
    expect(dataFolder.mode).toBe('shared');
    expect(library.root).toBe(target);
  });
});

describe('setting up', () => {
  it('moves the legacy library only when it holds one, and asks when the drive cannot tell', async () => {
    const { legacy, root, target } = await fixture({ legacyProject: true });
    status = { state: 'none', pointer: null };
    await initDataFolder();
    let tries = 0;
    replies.data_folder_setup = async ({ confirmed }) => {
      tries++;
      if (!confirmed) throw new Error('CANNOT_TELL: This drive cannot tell whether Manga Cleaner is open.');
      await mkdir(root, { recursive: true });
      await rename(legacy, target);
      status = ok(root, true);
      return { method: 'copy', oldCopy: `${legacy}.moved-2026-11-25-1000` };
    };
    const asked = [];
    await setUpSharedFolder(root, { confirm: async (text) => (asked.push(text), true) });
    expect(tries).toBe(2);
    expect(asked[0]).toMatch(/cannot tell/);
    expect(calls.find(([c]) => c === 'data_folder_setup')[1]).toMatchObject({ root, legacy });
    expect(dataFolder.mode).toBe('shared');
    expect(library.root).toBe(target);
    expect(library.projects.map((p) => p.name)).toEqual(['Series']);
    expect(dataFolder.oldCopies).toEqual([{ path: `${legacy}.moved-2026-11-25-1000` }]);
  });

  it('refuses while a chapter window or a move of the cleaner is busy', async () => {
    const { root } = await fixture();
    replies.data_folder_move_busy = () => true;
    await expect(setUpSharedFolder(root)).rejects.toThrow(/Manga Cleaner is setting up or moving/);
    expect(names()).not.toContain('data_folder_setup');
  });

  it('puts the data folder inside a picked folder that has other things in it', async () => {
    const { base } = await fixture();
    replies.data_folder_inspect = ({ path }) =>
      path === base ? { exists: true, isDir: true, empty: false, marker: false } : { exists: false, isDir: false, empty: false, marker: false };
    expect((await rootForPick(base)).root).toBe(join(base, 'Manga Library'));
    expect(await readdir(base)).toEqual(['Documents']);
  });
});
