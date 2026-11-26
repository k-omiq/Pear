// ===== Matching Manga Cleaner's titles to this app's (SHARED_DATA_FOLDER.md 8.4) =====
// The rules only, no disk and no state, so the filer (handoff.svelte.js),
// the match screen and the tests share one copy of each:
//
//   normalizeName   how two titles are compared
//   isClose         whether a title is a candidate for another
//   candidatesFor   this app's projects a cleaner title may belong to, ranked
//   chapterKey      the number two chapters are compared by
//   pairPages       which page of a cleaner chapter is which page here

// Lowercase, Unicode NFKC, every character that is not a letter or a digit
// a space, the word "the" removed, runs of spaces one, trimmed. Lowercased
// again after NFKC, which can make capitals ("Ⅻ" is "XII").
export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w && w !== 'the')
    .join(' ');
}

// Edit distance on characters (code points), not on UTF-16 units.
export function levenshtein(a, b) {
  const x = [...a];
  const y = [...b];
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

// One name's words, in order, inside the other's.
function containsWords(longer, shorter) {
  const a = longer.split(' ');
  const b = shorter.split(' ');
  for (let i = 0; i + b.length <= a.length; i++) {
    if (b.every((w, k) => a[i + k] === w)) return true;
  }
  return false;
}

// How close two normalized names are, or null when they are not: within 20
// percent of the longer name (rounded down) by edit distance, or one holding
// the other as whole words when the shorter is at least 4 characters long.
export function closeness(a, b) {
  if (!a || !b) return null;
  const la = [...a].length;
  const lb = [...b].length;
  const distance = levenshtein(a, b);
  const near = distance <= Math.floor(0.2 * Math.max(la, lb));
  const [longer, shorter] = la >= lb ? [a, b] : [b, a];
  const within = Math.min(la, lb) >= 4 && containsWords(longer, shorter);
  if (!near && !within) return null;
  return { distance, near, within };
}

export const isClose = (a, b) => closeness(normalizeName(a), normalizeName(b)) != null;

// This app's projects a cleaner title may belong to: no cleaner link, or a
// link to another cleaner library (a reinstalled cleaner has a new one), and
// a close name. Smallest distance first, then containment, then name order.
export function candidatesFor(name, libraryId, projects) {
  const wanted = normalizeName(name);
  const out = [];
  for (const p of projects ?? []) {
    if (!p || p.unreadable || p.duplicate) continue;
    if (p.cleanerLink && p.cleanerLink.libraryId === libraryId) continue;
    const c = closeness(wanted, normalizeName(p.name));
    if (c) out.push({ project: p, ...c });
  }
  out.sort(
    (a, b) =>
      Number(b.near) - Number(a.near) ||
      (a.near && b.near ? a.distance - b.distance : 0) ||
      Number(b.within) - Number(a.within) ||
      String(a.project.name).localeCompare(String(b.project.name)),
  );
  return out;
}

// The number chapters are compared by: the label when it reads as a decimal
// number ("12.5", or "12,5" read as 12.5), else the number. A label that
// does not read as a number ("12-1", "Extra") has no key: such a chapter is
// always a new one.
export function chapterKey({ label = null, number = null } = {}) {
  const text = typeof label === 'string' ? label.trim() : label == null ? '' : String(label);
  if (text) return /^\d+(?:[.,]\d+)?$/.test(text) ? Number(text.replace(',', '.')) : null;
  return Number.isFinite(number) ? number : null;
}

// A chapter here that a cleaner chapter would link to: same key, and not
// linked to that cleaner library (one linked to another library counts as
// unlinked, section 8.4.2).
export function unlinkedChapterFor(project, key, libraryId) {
  if (key == null) return null;
  return (project?.chapters ?? []).find((c) => !c.unreadable && c.number === key && (!c.cleanerLink || c.cleanerLink.libraryId !== libraryId)) ?? null;
}

// Pairs a cleaner chapter's pages with a chapter's here (section 8.4.4).
// `message` and `pear` are in their own order: [{ sha, w, h }], `pear` with
// `pageId` too. The counts must match. Pages with the same raw sha256 pair
// first; the rest pair by position among the unpaired ones, and only when
// each such pair has the same pixel size. Returns { ok, pairs: [{ index,
// pageId, how }], identical, byPosition } or { ok: false, why }.
export function pairPages(message, pear) {
  const m = message ?? [];
  const p = pear ?? [];
  if (m.length !== p.length) return { ok: false, why: `Pages differ: ${m.length} in Manga Cleaner, ${p.length} in Pear` };
  const taken = new Set();
  const pairs = new Array(m.length).fill(null);
  m.forEach((pg, i) => {
    if (!pg?.sha) return;
    const j = p.findIndex((q, k) => !taken.has(k) && q?.sha === pg.sha);
    if (j < 0) return;
    taken.add(j);
    pairs[i] = { index: i, pageId: p[j].pageId, how: 'same', pear: j };
  });
  const restM = m.map((_, i) => i).filter((i) => !pairs[i]);
  const restP = p.map((_, j) => j).filter((j) => !taken.has(j));
  for (let k = 0; k < restM.length; k++) {
    const i = restM[k];
    const j = restP[k];
    if (!(m[i]?.w > 0) || m[i].w !== p[j]?.w || m[i].h !== p[j]?.h) {
      return { ok: false, why: `Page ${i + 1} is ${m[i]?.w ?? 0}x${m[i]?.h ?? 0} in Manga Cleaner and ${p[j]?.w ?? 0}x${p[j]?.h ?? 0} in Pear` };
    }
    pairs[i] = { index: i, pageId: p[j].pageId, how: 'position', pear: j };
  }
  const identical = pairs.filter((x) => x.how === 'same').length;
  return { ok: true, pairs, identical, byPosition: pairs.length - identical };
}

// "15 pages: 12 identical, 3 by position".
export function pairingLine(pairing) {
  if (!pairing?.ok) return pairing?.why ?? '';
  const n = pairing.pairs.length;
  const parts = [];
  if (pairing.identical) parts.push(`${pairing.identical} identical`);
  if (pairing.byPosition) parts.push(`${pairing.byPosition} by position`);
  return `${n} page${n === 1 ? '' : 's'}: ${parts.join(', ')}`;
}
