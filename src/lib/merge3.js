// ===== A three-way merge of two edits of one record =====
// Two windows of the app can write the same project.json (the series guide,
// the tag registry): each holds the record as it last read it (`base`), its
// own edit of it (`mine`), and finds another window's edit on disk (`theirs`).
// What each changed from the base survives; where both changed the same value,
// `mine` wins, as the write being made now.
//
// Objects merge key by key. Lists of records with an `id` or a `name` (glossary
// terms, tags) merge record by record, in `theirs`' order with this window's
// new records after. Anything else is one value.
//
// Pure: JSON-shaped values in, a new value out.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const keyOf = (v) => (plain(v) ? (typeof v.id === 'string' ? `id:${v.id}` : typeof v.name === 'string' ? `name:${v.name}` : null) : null);
const keyed = (list) => Array.isArray(list) && list.every((v) => keyOf(v) != null) && new Set(list.map(keyOf)).size === list.length;

export function merge3(base, mine, theirs) {
  if (same(mine, base)) return theirs;
  if (same(theirs, base) || same(mine, theirs)) return mine;
  if (plain(mine) && plain(theirs)) {
    const b = plain(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      const inM = Object.hasOwn(mine, k);
      const inT = Object.hasOwn(theirs, k);
      const inB = Object.hasOwn(b, k);
      // Taken away on one side and left alone on the other: gone.
      if (!inM && inB && same(theirs[k], b[k])) continue;
      if (!inT && inB && same(mine[k], b[k])) continue;
      if (!inM) out[k] = theirs[k];
      else if (!inT) out[k] = mine[k];
      else out[k] = merge3(inB ? b[k] : undefined, mine[k], theirs[k]);
    }
    return out;
  }
  if (keyed(mine) && keyed(theirs) && (base === undefined || keyed(base))) {
    const index = (list) => new Map((list ?? []).map((v) => [keyOf(v), v]));
    const B = index(base);
    const M = index(mine);
    const T = index(theirs);
    const out = [];
    const take = (k) => {
      const inM = M.has(k);
      const inT = T.has(k);
      if (!inM && B.has(k) && same(T.get(k), B.get(k))) return;
      if (!inT && B.has(k) && same(M.get(k), B.get(k))) return;
      out.push(!inM ? T.get(k) : !inT ? M.get(k) : merge3(B.get(k), M.get(k), T.get(k)));
    };
    for (const k of T.keys()) take(k);
    for (const k of M.keys()) if (!T.has(k)) take(k);
    return out;
  }
  return mine;
}
