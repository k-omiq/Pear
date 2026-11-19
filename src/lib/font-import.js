// ===== Sorting a pile of font files into families =====
// A folder of fonts goes in as files; what the library holds is families of
// up to four faces (fonts.js). This is the step between: every file gets a
// family and a slot, by one of a few rules the user picks from, and what does
// not fit cleanly - two files for one slot, a Light or a Condensed the four
// slots have no place for - is said out loud before anything is written.
//
// The planning half is pure (font-import.test.js). The other half finds the
// files: a picked folder (Tauri), a dropped folder (the webview's entries
// API), a browser folder input.
import { parseFontFilename, faceSlot, SLOT_LABEL, FACE_SLOTS } from './fonts.js';
import { readFontInfo, extraStyleWords, styleLabel } from './font-names.js';

export const FONT_EXTENSIONS = ['ttf', 'otf', 'ttc', 'woff', 'woff2'];
const FONT_RE = /\.(ttf|otf|ttc|woff2?)$/i;
export const isFontFileName = (name) => FONT_RE.test(String(name || ''));

// The most files one import reads, and the deepest folder it walks. A font
// folder past either is a whole disk, not a typeface.
export const MAX_FILES = 3000;
const MAX_DEPTH = 12;
// A font file past this is not a font anyone letters with.
export const MAX_FILE_BYTES = 128 * 1024 * 1024;

// The ways a pile can be sorted. `typeface` is offered only when some file
// says it belongs to a bigger typeface than its style-linked family.
export const SORT_MODES = [
  { id: 'names', label: 'By family name in the files', note: 'Each file says which family it belongs to. Light, Black and the other weights become families of their own.' },
  { id: 'typeface', label: 'By typeface', note: 'Every weight of a typeface in one family. Only four faces fit, so extra weights are left out.' },
  { id: 'filename', label: 'By file name', note: 'Foo-Bold.ttf is the Bold of Foo. For files whose names inside are wrong.' },
  { id: 'folder', label: 'One family per folder', note: 'Every file in a folder is one family, named after the folder.' },
];

// Which modes mean anything for these files.
export function sortModesFor(items) {
  const typo = items.some((it) => it.info?.typoFamily && it.info.typoFamily !== it.info.family);
  const folders = new Set(items.map((it) => it.dir || ''));
  return SORT_MODES.filter((m) => (m.id === 'typeface' ? typo : m.id === 'folder' ? folders.size >= 1 && items.some((it) => it.dir) : true));
}

const lastSegment = (dir) => String(dir || '').split(/[\\/]/).filter(Boolean).pop() || '';
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// One file's family and slot under `mode`, and what about it needs saying.
export function placeItem(item, mode) {
  const byName = parseFontFilename(item.name);
  const info = item.info || null;
  let family;
  if (mode === 'filename' || !info?.family) family = byName.family;
  else if (mode === 'typeface') family = info.typoFamily || info.family;
  else family = info.family;
  if (mode === 'folder') family = lastSegment(item.dir) || family;
  family = clean(family) || byName.family;

  let slot;
  if (mode === 'filename' || !info || info.kind === 'woff2') slot = byName.slot;
  else slot = faceSlot({ bold: info.bold || info.weight >= 600, italic: info.italic });

  // Weights and widths the four slots cannot name. A word already in the
  // family name ("Foo Light") is the family's own, not the face's.
  const famWords = new Set(family.toLowerCase().split(/\s+/));
  const style = info ? styleLabel(info) : '';
  const extra = info ? extraStyleWords(info.typoStyle || info.style || style).filter((w) => !famWords.has(w.toLowerCase())) : [];
  if (info && (info.width < 4 || info.width > 6) && !extra.length && !/condensed|expanded|narrow|wide/i.test(family)) extra.push('Width');
  return { family, slot, style, extra, weight: info?.weight ?? null };
}

// How close a face is to what its slot means: 400 for the plain slots, 700 for
// the bold ones, and a face with extra words is a poorer fit than one without.
function fitScore(p) {
  const want = p.slot === 'bold' || p.slot === 'boldItalic' ? 700 : 400;
  return Math.abs((p.weight ?? want) - want) + p.extra.length * 150;
}

// The whole pile under `mode`:
//
//   rows        one per file: { id, name, dir, family, slot | null, style,
//               note, include } - `slot: null` is a file left out
//   families    the family names the rows make, in order of first file
//
// `existing` is the families already in the library, as { name, faces };
// `builtins` the built-in names, which a user family may not take.
export function planImport(items, mode = 'names', { existing = [], builtins = [] } = {}) {
  const rows = [];
  const bySlot = new Map();
  for (const item of items) {
    const p = placeItem(item, mode);
    const row = {
      id: item.id,
      name: item.name,
      dir: item.dir || '',
      family: p.family,
      slot: p.slot,
      style: p.style,
      extra: p.extra,
      score: fitScore(p),
      note: p.extra.length ? `${p.extra.join(' ')} placed as ${SLOT_LABEL[p.slot]}` : '',
    };
    rows.push(row);
    const k = `${row.family}::${row.slot}`;
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k).push(row);
  }
  // Two files for one slot: the closer fit keeps it, the rest are left out
  // with the reason. Never "the later one wins" silently.
  for (const claim of bySlot.values()) {
    if (claim.length < 2) continue;
    const ranked = [...claim].sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    const keep = ranked[0];
    for (const r of ranked.slice(1)) {
      r.note = `${SLOT_LABEL[r.slot]} is taken by ${keep.name}`;
      r.slot = null;
    }
  }
  return finishPlan({ mode, rows }, { existing, builtins });
}

// The facts a plan's rows imply, recomputed after every edit the user makes in
// the confirm step: which families there are, which slots collide, which add
// to a family already in the library and what they replace there.
export function finishPlan(plan, { existing = [], builtins = [] } = {}) {
  const have = new Map(existing.map((f) => [f.name, f]));
  const builtin = new Set(builtins);
  const families = [];
  const seen = new Map();
  const clash = new Set();
  const taken = new Map();
  for (const r of plan.rows) {
    if (!r.family) continue;
    if (!seen.has(r.family)) {
      const old = have.get(r.family);
      const fam = { name: r.family, rows: [], existing: !!old, builtin: builtin.has(r.family), replaces: {} };
      seen.set(r.family, fam);
      families.push(fam);
    }
    const fam = seen.get(r.family);
    fam.rows.push(r);
    if (!r.slot) continue;
    const k = `${r.family}::${r.slot}`;
    if (taken.has(k)) {
      clash.add(k);
    } else taken.set(k, r);
    const old = have.get(r.family)?.faces?.[r.slot];
    if (old) fam.replaces[r.slot] = old.file || 'a face';
  }
  const rows = plan.rows.map((r) => ({ ...r, clash: !!r.slot && clash.has(`${r.family}::${r.slot}`) }));
  for (const fam of families) fam.rows = rows.filter((r) => r.family === fam.name);
  const placed = rows.filter((r) => r.slot && r.family && !r.clash);
  return {
    mode: plan.mode,
    rows,
    families,
    leftOut: rows.filter((r) => !r.slot || !r.family),
    clashes: clash.size,
    blocked: families.filter((f) => f.builtin).map((f) => f.name),
    faces: placed.length,
    // A family under a built-in's name is left out of the writes (`planWrites`)
    // and says so; it does not hold back the rest.
    ok: clash.size === 0,
  };
}

// Whether the user is asked before anything is saved: more than one family,
// a file left out, a face placed with words the slot does not name, a face
// that would replace one already in the library, or a name that cannot be used.
export function needsConfirm(plan) {
  return (
    plan.families.length > 1 ||
    plan.leftOut.length > 0 ||
    plan.rows.some((r) => r.slot && r.note) ||
    plan.families.some((f) => Object.keys(f.replaces).length || f.builtin) ||
    plan.clashes > 0
  );
}

// One edit in the confirm step, returning the new rows: a file moved to
// another family or slot (`slot: null` leaves it out), or a whole family
// renamed.
export function editRow(rows, id, change) {
  return rows.map((r) => (r.id === id ? { ...r, ...change, note: change.slot === undefined && change.family === undefined ? r.note : '' } : r));
}
export function renamePlanFamily(rows, from, to) {
  const name = clean(to);
  if (!name) return rows;
  return rows.map((r) => (r.family === from ? { ...r, family: name } : r));
}

// What to write: [{ id, family, slot }], one per placed, unclashing face.
export function planWrites(plan) {
  const out = [];
  for (const r of plan.rows) {
    if (!r.slot || !r.family || r.clash || !FACE_SLOTS.includes(r.slot)) continue;
    if (plan.blocked.includes(r.family)) continue;
    out.push({ id: r.id, family: r.family, slot: r.slot });
  }
  return out;
}

// ---- finding the files ----
// An item is { id, name, dir, size, read: () => Promise<ArrayBuffer> }, and
// gains `info` once read (`readItems`).

let seq = 0;
const nextId = () => `f${++seq}`;

export function itemsFromFiles(files) {
  const out = [];
  for (const f of [...(files || [])]) {
    if (!isFontFileName(f.name)) continue;
    const rel = f.webkitRelativePath || '';
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    out.push({ id: nextId(), name: f.name, dir, size: f.size ?? 0, read: () => f.arrayBuffer(), file: f });
  }
  return out;
}

// A drop: files and folders both. A folder comes in as an entry the webview
// can walk (`webkitGetAsEntry`); a plain file list is the fallback.
export async function itemsFromDrop(dataTransfer) {
  const entries = [];
  for (const it of [...(dataTransfer?.items || [])]) {
    const e = it.kind === 'file' && typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
    if (e) entries.push(e);
  }
  if (!entries.length) return itemsFromFiles(dataTransfer?.files);
  const out = [];
  const fileOf = (entry) => new Promise((res, rej) => entry.file(res, rej));
  const readAll = (reader) =>
    new Promise((res, rej) => {
      const got = [];
      const step = () =>
        reader.readEntries((batch) => {
          if (!batch.length) return res(got);
          got.push(...batch);
          step();
        }, rej);
      step();
    });
  async function walk(entry, dir, depth) {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
    if (entry.name.startsWith('.') || entry.name === '__MACOSX') return;
    if (entry.isFile) {
      if (!isFontFileName(entry.name)) return;
      try {
        const f = await fileOf(entry);
        out.push({ id: nextId(), name: f.name, dir, size: f.size ?? 0, read: () => f.arrayBuffer(), file: f });
      } catch {
        /* unreadable: skipped */
      }
    } else if (entry.isDirectory) {
      const here = dir ? `${dir}/${entry.name}` : entry.name;
      let kids = [];
      try {
        kids = await readAll(entry.createReader());
      } catch {
        return;
      }
      for (const k of kids) await walk(k, here, depth + 1);
    }
  }
  for (const e of entries) await walk(e, '', 0);
  return out;
}

// A folder picked in the native dialog, walked with the fs plugin. The dialog
// puts what was picked (and, with `recursive`, everything under it) in the fs
// scope, so a folder outside the home directory reads too.
export async function pickFolderTauri() {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const root = await open({ directory: true, multiple: false, recursive: true, title: 'Add a folder of fonts' });
  if (!root || Array.isArray(root)) return null;
  const fs = await import('@tauri-apps/plugin-fs');
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const top = lastSegment(root);
  const out = [];
  async function walk(path, dir, depth) {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries = [];
    try {
      entries = await fs.readDir(path);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (!e.name || e.name.startsWith('.') || e.name === '__MACOSX') continue;
      const full = `${path.replace(/[\\/]+$/, '')}${sep}${e.name}`;
      if (e.isDirectory) await walk(full, `${dir}/${e.name}`, depth + 1);
      else if (e.isFile && isFontFileName(e.name)) {
        out.push({ id: nextId(), name: e.name, dir, size: 0, read: async () => toBuffer(await fs.readFile(full)) });
      }
    }
  }
  await walk(root, top, 0);
  return { root, items: out };
}

const toBuffer = (u8) => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));

// Reads every item once for its names. The bytes are not kept: a folder of
// CJK fonts is gigabytes, and the import reads each again as it saves it.
// `toSfnt` turns a WOFF 2 into a plain font (Tauri); without it a WOFF 2 is
// sorted by its file name. `onProgress(done, total)` after each.
export async function readItems(items, { toSfnt = null, onProgress = null } = {}) {
  let done = 0;
  for (const item of items) {
    try {
      const buf = await item.read();
      if (buf.byteLength > MAX_FILE_BYTES) {
        item.unreadable = 'larger than 128 MB';
      } else {
        item.size = buf.byteLength;
        let info = readFontInfo(buf);
        if (info?.kind === 'woff2' && toSfnt) {
          try {
            const plain = await toSfnt(new Uint8Array(buf));
            const names = readFontInfo(plain);
            if (names) info = { ...names, kind: 'woff2' };
          } catch {
            /* sorted by file name */
          }
        }
        if (!info) item.unreadable = 'not a font file';
        item.info = info;
      }
    } catch (e) {
      item.unreadable = String(e?.message || e || 'could not be read');
    }
    done++;
    onProgress?.(done, items.length);
  }
  return items;
}
