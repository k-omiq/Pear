// The handoff's file side (src-tauri/src/handoff.rs) over node:fs, for the
// filer's tests. Same names, same checks, same results; the Rust side has its
// own unit tests for the real thing.
import { readdir, readFile, rename, rm, mkdir, stat, writeFile, lstat, link, copyFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, sep } from 'node:path';

const plain = (n) => typeof n === 'string' && n && n !== '.' && n !== '..' && !/[\\/]/.test(n);
const inbox = (root) => join(root, 'handoff', 'to-typesetter');
const exists = (p) => lstat(p).then(() => true, () => false);

function messageFile(claimDir, rel) {
  const parts = String(rel).split('/');
  if (parts.length !== 2 || !['raws', 'cleaned'].includes(parts[0]) || !plain(parts[1])) throw new Error(`${rel} is not a message file`);
  return join(claimDir, parts[0], parts[1]);
}

// Width and height off a PNG's IHDR or a JPEG's SOF marker.
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const m = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

export function nodeHandoffIO(lib = (root) => join(root, 'Typesetter')) {
  const ours = new Set();
  let seq = 0;
  const claimDir = (root, claim) => {
    if (!plain(claim) || !claim.startsWith('.claimed-')) throw new Error(`${claim} is not a claimed message`);
    return join(inbox(root), claim);
  };
  const inLibrary = (root, p) => p.startsWith(lib(root) + sep);
  const io = {
    busy: false,
    async list(root) {
      let entries;
      try {
        entries = await readdir(inbox(root), { withFileTypes: true });
      } catch {
        return [];
      }
      return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
    },
    async recover(root) {
      let n = 0;
      for (const e of await readdir(inbox(root), { withFileTypes: true }).catch(() => [])) {
        const m = e.isDirectory() && !ours.has(e.name) && /^\.claimed-(.+)-[^-]+$/.exec(e.name);
        if (m) {
          await io.putBack(root, e.name, m[1]);
          n++;
        }
      }
      return n;
    },
    async claim(root, key) {
      if (!plain(key) || key.startsWith('.')) throw new Error(`${key} is not a message name`);
      const name = `.claimed-${key}-t${++seq}`;
      ours.add(name);
      try {
        await rename(join(inbox(root), key), join(inbox(root), name));
        return name;
      } catch {
        ours.delete(name);
        return null;
      }
    },
    async read(root, claim) {
      const dir = claimDir(root, claim);
      let doc;
      try {
        doc = JSON.parse(await readFile(join(dir, 'handoff.json'), 'utf8'));
      } catch (e) {
        return { doc: null, error: `handoff.json could not be read (${e.message})`, files: {} };
      }
      const files = {};
      for (const pg of Array.isArray(doc.pages) ? doc.pages : []) {
        for (const k of ['raw', 'cleaned']) {
          const rel = pg?.[k];
          if (typeof rel !== 'string') continue;
          try {
            const buf = await readFile(messageFile(dir, rel));
            const size = imageSize(buf);
            files[rel] = { exists: true, w: size?.w ?? 0, h: size?.h ?? 0, size: buf.length };
          } catch {
            files[rel] = { exists: false, w: 0, h: 0, size: 0 };
          }
        }
      }
      return { doc, error: null, files };
    },
    // Linked in (a copy where linking fails): the claim stays whole.
    noLinks: false,
    async take(root, claim, rel, dest) {
      const src = messageFile(claimDir(root, claim), rel);
      if (!inLibrary(root, dest)) throw new Error(`${dest} is not inside the library`);
      if (await exists(dest)) throw new Error(`${dest} is already there`);
      if (io.failTake?.(rel)) throw new Error(`Could not bring ${rel} into the library`);
      if (!io.noLinks) {
        try {
          await link(src, dest);
          return;
        } catch {
          /* copied below */
        }
      }
      await copyFile(src, dest);
    },
    async giveBack(root, claim, rel, from) {
      const kept = messageFile(claimDir(root, claim), rel);
      if (!inLibrary(root, from)) throw new Error(`${from} is not inside the library`);
      if (!(await exists(kept))) throw new Error(`${rel} is not in the message any more`);
      await unlink(from);
    },
    async same(root, claim, rel, path) {
      const src = messageFile(claimDir(root, claim), rel);
      if (!inLibrary(root, path)) throw new Error(`${path} is not inside the library`);
      const [a, b] = await Promise.all([stat(src).catch(() => null), stat(path).catch(() => null)]);
      if (!a || !b || a.size !== b.size) return false;
      const sha = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');
      return (await sha(src)) === (await sha(path));
    },
    async putBack(root, claim, key) {
      const from = claimDir(root, claim);
      const home = join(inbox(root), key);
      ours.delete(claim);
      if (!(await exists(home))) {
        try {
          await rename(from, home);
          return 'back';
        } catch {
          /* a newer one landed */
        }
      }
      await rm(from, { recursive: true, force: true });
      return 'dropped';
    },
    async reject(root, claim, key, reason) {
      const dir = join(root, 'handoff', 'rejected');
      await mkdir(dir, { recursive: true });
      let to = join(dir, `${key}-2026-11-25-1000`);
      for (let i = 2; await exists(to); i++) to = join(dir, `${key}-2026-11-25-1000-${i}`);
      await rename(claimDir(root, claim), to);
      ours.delete(claim);
      await writeFile(join(to, 'reason.txt'), `${reason}\n`);
      return to;
    },
    async done(root, claim) {
      ours.delete(claim);
      await rm(claimDir(root, claim), { recursive: true, force: true });
    },
    async moveBusy() {
      return io.busy;
    },
  };
  return io;
}

export const isDir = (p) => stat(p).then((s) => s.isDirectory(), () => false);
