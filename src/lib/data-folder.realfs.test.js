// ===== The data folder's modes, on a real disk =====
//
// data-folder.svelte.js decides legacy, pending, shared or unavailable from
// the Rust status (stood in for here) and this app's library root on a real
// temp folder, and the library must never create a missing root once a
// pointer is in force (SHARED_DATA_FOLDER.md section 5).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readdir, stat, rename, chmod } from 'node:fs/promises';
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
const { prefs, setPref } = await import('./prefs.svelte.js');
const df = await import('./data-folder.svelte.js');
const {
  dataFolder,
  _setDataFolderCommands,
  _resetDataFolderForTests,
  initDataFolder,
  recheckDataFolder,
  setUpSharedFolder,
  moveDataFolder,
  useSharedLibrary,
  useExistingFolder,
  rootForPick,
  moveLibraryIntoShared,
} = df;

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
  setPref('dataFolderFirstRun', { setup: null, join: null });
  setPref('onboarded', true);
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
    // The sister test answered nothing: no question, no quiet setup.
    expect(names()).toEqual(['data_folder_status', 'data_folder_sister']);
    expect(dataFolder.start).toBe(null);
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

  it('is unavailable when the subfolder is damaged', async () => {
    const { root } = await fixture();
    status = { state: 'damaged', pointer: { schema: 1, path: root, folderId: 'f1' }, detail: 'The Pear folder inside the data folder is damaged.', typesetter: 'damaged' };
    await initDataFolder();
    expect(dataFolder.mode).toBe('unavailable');
    expect(names()).not.toContain('data_folder_adopt');
  });

  it('never shows a Windows \\?\ prefix in what it says', async () => {
    const { root } = await fixture();
    status = { state: 'moving', pointer: { schema: 1, path: root, folderId: 'f1' }, detail: 'Your data is still at \\\\?\\D:\\Manga Library.' };
    await initDataFolder();
    expect(dataFolder.detail).toBe('Your data is still at D:\\Manga Library.');
  });
});

// SHARED_DATA_FOLDER.md section 5.1: every start lands in exactly one row.
describe('the start table', () => {
  const sister = (present) => (replies.data_folder_sister = () => ({ present, source: present ? 'appData' : null }));

  it('B: a journal is Unavailable, whatever else holds', async () => {
    const { root } = await fixture({ legacyProject: true });
    status = { state: 'moving', pointer: null };
    sister(true);
    await initDataFolder();
    expect(dataFolder.mode).toBe('unavailable');
    expect(dataFolder.start).toBe(null);
    expect(names()).not.toContain('data_folder_sister');
    void root;
  });

  it('A: the library file is there, so Shared and nothing asked', async () => {
    const { root, target } = await fixture();
    await mkdir(target, { recursive: true });
    status = ok(root, true);
    await initDataFolder();
    expect([dataFolder.mode, dataFolder.start]).toEqual(['shared', null]);
  });

  it('C: no subfolder on a first launch asks in the first-run setup, and moves nothing', async () => {
    const { root } = await fixture();
    setPref('onboarded', false);
    status = ok(root, false);
    await initDataFolder();
    expect([dataFolder.mode, dataFolder.start]).toEqual(['pending', 'joinStep']);
    expect(names()).not.toContain('data_folder_adopt');
    // Joining a new install makes the library in the shared folder.
    replies.data_folder_adopt = () => {
      status = ok(root, true);
      return { method: 'none' };
    };
    await moveLibraryIntoShared();
    expect(dataFolder.mode).toBe('shared');
  });

  it('C needs all three: an answer stored before, or a library with a title, is not a first launch', async () => {
    const { root } = await fixture({ legacyProject: true });
    setPref('onboarded', false);
    status = ok(root, false);
    await initDataFolder();
    expect(dataFolder.start).toBe('join');
    _resetDataFolderForTests();
    await fixture();
    setPref('dataFolderFirstRun', 'notNow');
    await initDataFolder();
    expect(dataFolder.start).toBe('join');
  });

  it('D: an app used before asks in the dialog, once, and never after Not now', async () => {
    const { root } = await fixture({ legacyProject: true });
    status = ok(root, false);
    await initDataFolder();
    expect([dataFolder.mode, dataFolder.start]).toEqual(['pending', 'join']);
    // Asked once a session: a dialog closed is not brought back on focus.
    df.dismissStart();
    await recheckDataFolder();
    expect(dataFolder.start).toBe(null);
    // Declined: not asked at the next start either.
    df.recordStartAnswer('join', 'declined');
    _resetDataFolderForTests();
    await setRoot(library.root);
    await initDataFolder();
    expect([dataFolder.mode, dataFolder.start]).toEqual(['pending', null]);
  });

  it('an empty subfolder after this app set up or joined is filled without asking', async () => {
    // Section 5.1: a v1 setup with nothing to move (or a crash) leaves the
    // pointer and an empty Typesetter/. v1 `moved`, setup or join accepted.
    for (const answer of ['moved', { setup: 'accepted', join: null }, { setup: null, join: 'accepted' }]) {
      _resetDataFolderForTests();
      calls = [];
      const { root, target } = await fixture();
      await mkdir(target, { recursive: true });
      setPref('dataFolderFirstRun', answer);
      status = { ...ok(root, false), typesetter: 'none' };
      replies.data_folder_adopt = (args) => {
        expect(args).toEqual({ legacy: null });
        status = { ...ok(root, true), typesetter: 'ready' };
        return { method: 'none' };
      };
      await initDataFolder();
      expect([dataFolder.mode, dataFolder.start]).toEqual(['shared', null]);
      expect(names().filter((c) => c === 'data_folder_adopt')).toHaveLength(1);
      expect(library.root).toBe(target);
    }
  });

  it('an accepted answer never fills the subfolder while the old place holds titles', async () => {
    const { root } = await fixture({ legacyProject: true });
    setPref('dataFolderFirstRun', { setup: 'accepted', join: null });
    status = { ...ok(root, false), typesetter: 'none' };
    await initDataFolder();
    expect([dataFolder.mode, dataFolder.start]).toEqual(['pending', 'join']);
    expect(names()).not.toContain('data_folder_adopt');
    // No answer stored: the empty subfolder is row D, asked, never filled.
    _resetDataFolderForTests();
    calls = [];
    const again = await fixture();
    setPref('dataFolderFirstRun', { setup: null, join: null });
    status = { ...ok(again.root, false), typesetter: 'none' };
    await initDataFolder();
    expect(dataFolder.start).toBe('join');
    expect(names()).not.toContain('data_folder_adopt');
  });

  it('D: a setup declined does not block the Join question', async () => {
    const { root } = await fixture({ legacyProject: true });
    setPref('dataFolderFirstRun', { setup: 'declined', join: null });
    status = ok(root, false);
    await initDataFolder();
    expect(dataFolder.start).toBe('join');
  });

  it('E: no sister runs the quiet setup, records it and leaves the notice', async () => {
    const { legacy, root, target } = await fixture({ legacyProject: true });
    status = { state: 'none', pointer: null };
    sister(false);
    replies.data_folder_default_root = () => root;
    replies.data_folder_quiet_setup = async (args) => {
      await mkdir(root, { recursive: true });
      await rename(legacy, target);
      status = ok(root, true);
      return { done: true, reason: null, report: { method: 'rename', oldCopy: null } };
    };
    await initDataFolder();
    expect(calls).toContainEqual(['data_folder_quiet_setup', { root, legacy }]);
    expect(dataFolder.mode).toBe('shared');
    expect(library.root).toBe(target);
    expect(dataFolder.quietRoot).toBe(root);
    expect(prefs.dataFolderFirstRun).toEqual({ setup: 'accepted', join: null });
    expect(dataFolder.start).toBe(null);
  });

  it('E: a check that fails stays Legacy and says nothing', async () => {
    const { legacy, root } = await fixture({ legacyProject: true });
    status = { state: 'none', pointer: null };
    sister(false);
    replies.data_folder_default_root = () => root;
    replies.data_folder_quiet_setup = () => ({ done: false, reason: 'on another drive', report: null });
    await initDataFolder();
    expect([dataFolder.mode, dataFolder.start, dataFolder.quietRoot]).toEqual(['legacy', null, '']);
    expect(library.root).toBe(legacy);
    expect(prefs.dataFolderFirstRun).toEqual({ setup: null, join: null });
    expect(dataFolder.busy).toBe(false);
  });

  it('E: a setup the user declined is not done quietly', async () => {
    await fixture({ legacyProject: true });
    setPref('dataFolderFirstRun', 'notNow');
    status = { state: 'none', pointer: null };
    sister(false);
    await initDataFolder();
    expect(names()).not.toContain('data_folder_quiet_setup');
    expect(names()).not.toContain('data_folder_sister');
  });

  it('F: the sister present asks the Set up dialog, once', async () => {
    await fixture({ legacyProject: true });
    status = { state: 'none', pointer: null };
    sister(true);
    await initDataFolder();
    expect([dataFolder.mode, dataFolder.start, dataFolder.sister]).toEqual(['legacy', 'setup', true]);
    expect(names()).not.toContain('data_folder_quiet_setup');
    df.recordStartAnswer('setup', 'declined');
    _resetDataFolderForTests();
    await initDataFolder();
    expect(dataFolder.start).toBe(null);
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

  it('puts it inside an empty pick too (a drive’s top folder), as Manga Cleaner does; a data folder is used as it is', async () => {
    const { base } = await fixture();
    const mount = join(base, 'mnt-d2');
    replies.data_folder_inspect = ({ path }) =>
      path === mount ? { exists: true, isDir: true, empty: true, marker: false } : { exists: false, isDir: false, empty: false, marker: false };
    expect((await rootForPick(mount)).root).toBe(join(mount, 'Manga Library'));
    replies.data_folder_inspect = () => ({ exists: true, isDir: true, empty: false, marker: true });
    expect((await rootForPick(mount)).root).toBe(mount);
  });
});

describe('a move that did not finish', () => {
  it('is unavailable while a journal is left, opens nothing, and notes what recovery did', async () => {
    const { root, target } = await fixture();
    await mkdir(target, { recursive: true });
    await setRoot(target);
    status = { state: 'moving', pointer: { schema: 1, path: root, folderId: 'f1' }, detail: 'Close Manga Cleaner to finish the move of the data folder.' };
    await initDataFolder();
    expect(dataFolder.mode).toBe('unavailable');
    expect(dataFolder.detail).toMatch(/Close Manga Cleaner/);
    expect(names()).not.toContain('data_folder_open');
    status = { ...ok(root, true), recovered: { note: 'A move that was stopped has been finished.', oldCopy: '/old.moved-2026-11-25-1000' } };
    await recheckDataFolder();
    expect(dataFolder.mode).toBe('shared');
    expect(dataFolder.notice).toMatch(/finished/);
    expect(dataFolder.oldCopies).toEqual([{ path: '/old.moved-2026-11-25-1000' }]);
  });

  it('says "Finishing the move" while the folder opens after a recovery, never "not found"', async () => {
    const { root, target } = await fixture();
    await mkdir(target, { recursive: true });
    await setRoot(target);
    status = { state: 'moving', pointer: { schema: 1, path: root, folderId: 'f1' }, detail: 'Manga Cleaner is moving the data folder. Wait for it to finish.' };
    await initDataFolder();
    expect([dataFolder.mode, dataFolder.finishing]).toEqual(['unavailable', false]);
    let release;
    const seen = [];
    replies.data_folder_open = () => {
      seen.push([dataFolder.mode, dataFolder.state, dataFolder.finishing]);
      return new Promise((r) => (release = r));
    };
    status = ok(root, true);
    const done = recheckDataFolder();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual(['unavailable', 'ok', true]);
    release();
    await done;
    expect([dataFolder.mode, dataFolder.finishing]).toEqual(['shared', false]);
  });

  it('a failure after a recovery is shown as it is, not as finishing', async () => {
    const { root, target } = await fixture();
    await mkdir(target, { recursive: true });
    await setRoot(target);
    status = { state: 'moving', pointer: { schema: 1, path: root, folderId: 'f1' } };
    await initDataFolder();
    replies.data_folder_open = () => {
      throw new Error('Another copy of the typesetter is using this data folder.');
    };
    status = ok(root, true);
    await recheckDataFolder();
    expect([dataFolder.mode, dataFolder.finishing]).toEqual(['unavailable', false]);
    expect(dataFolder.detail).toMatch(/Another copy/);
  });

  it('never runs on the shared library when its lock cannot be taken', async () => {
    const { root, target } = await fixture();
    await mkdir(target, { recursive: true });
    await setRoot(target);
    status = ok(root, true);
    replies.data_folder_open = () => {
      throw new Error('Another copy of the typesetter is using this data folder.');
    };
    await initDataFolder();
    expect(dataFolder.mode).toBe('unavailable');
    expect(dataFolder.detail).toMatch(/Another copy/);
  });

  it('a failed move asks where things stand, and does not open the old folder by guess', async () => {
    const { root, target } = await fixture();
    await mkdir(target, { recursive: true });
    await setRoot(target);
    status = ok(root, true);
    await initDataFolder();
    calls = [];
    replies.data_folder_move = () => {
      status = { state: 'moving', pointer: { schema: 1, path: root, folderId: 'f1' }, detail: 'not finished' };
      throw new Error('The pointer could not be written. The move is not finished.');
    };
    await expect(moveDataFolder(join(tmp, 'elsewhere'))).rejects.toThrow(/not finished/);
    expect(names()).toEqual(['data_folder_move_busy', 'data_folder_move', 'data_folder_status']);
    expect(dataFolder.mode).toBe('unavailable');
    expect(dataFolder.busy).toBe(false);
  });
});

describe('the pointer wins', () => {
  it('over a Shared root the other app moved away while this app was closed', async () => {
    // The data folder was at old/Manga Library; Manga Cleaner moved it.
    const { base, root, target } = await fixture();
    const stale = join(base, 'old', 'Manga Library', 'Typesetter');
    await mkdir(target, { recursive: true });
    await setRoot(stale);
    status = ok(root, true);
    await initDataFolder();
    expect([dataFolder.mode, dataFolder.bothLibraries, dataFolder.start]).toEqual(['shared', false, null]);
    expect(library.root).toBe(target);
  });

  it('over an old Shared root still there with its marker', async () => {
    const { base, root, target } = await fixture();
    const oldRoot = join(base, 'old', 'Manga Library');
    await mkdir(join(oldRoot, 'Typesetter', 'series'), { recursive: true });
    await writeFile(join(oldRoot, 'manga-library.json'), '{}');
    await writeFile(join(oldRoot, 'Typesetter', 'series', 'project.json'), JSON.stringify({ schema: 1, id: 'p_1', name: 'Series' }));
    await mkdir(target, { recursive: true });
    await setRoot(join(oldRoot, 'Typesetter'));
    status = ok(root, true);
    await initDataFolder();
    expect([dataFolder.mode, dataFolder.bothLibraries]).toEqual(['shared', false]);
    expect(library.root).toBe(target);
  });

  it('a library that cannot be read is never "a library to keep"', async () => {
    const { legacy, root, target } = await fixture({ legacyProject: true });
    await mkdir(target, { recursive: true });
    await chmod(legacy, 0o000);
    try {
      status = ok(root, true);
      await initDataFolder();
      expect([dataFolder.mode, dataFolder.bothLibraries]).toEqual(['shared', false]);
    } finally {
      await chmod(legacy, 0o755);
    }
  });
});

describe('two libraries', () => {
  it('says so in pending mode, and using the shared one leaves the old one where it is', async () => {
    const { legacy, root, target } = await fixture({ legacyProject: true });
    await mkdir(target, { recursive: true });
    status = ok(root, true);
    await initDataFolder();
    expect(dataFolder.mode).toBe('pending');
    expect(dataFolder.bothLibraries).toBe(true);
    await useSharedLibrary();
    expect(calls).toContainEqual(['data_folder_adopt', { legacy: null }]);
    expect(dataFolder.mode).toBe('shared');
    expect(library.root).toBe(target);
    expect(await readdir(legacy)).toEqual(['series']);
  });

  it('use existing asks when the drive cannot tell whether Manga Cleaner is open', async () => {
    const { root, target } = await fixture();
    status = { state: 'none', pointer: null };
    await initDataFolder();
    let tries = 0;
    replies.data_folder_use_existing = async ({ confirmed }) => {
      tries++;
      if (!confirmed) throw new Error('CANNOT_TELL: This drive cannot tell whether Manga Cleaner is open.');
      await mkdir(target, { recursive: true });
      status = ok(root, true);
      return { schema: 1, path: root, folderId: 'f1' };
    };
    await useExistingFolder(root, { confirm: async () => true });
    expect(tries).toBe(2);
    await expect(useExistingFolder(root, { confirm: async () => false })).rejects.toThrow('Nothing was moved.');
  });
});
