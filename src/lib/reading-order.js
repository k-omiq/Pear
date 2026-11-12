// Line numbers are page-local joins, not labels. Change every live join in one
// synchronous pass, using a complete map so swaps never read a number already
// written by this pass. Free rows keep both their numbers and their slots.
export const orderMap = (entry, dir = 'redo') =>
  new Map(entry.numbers.map(([before, after]) => dir === 'undo' ? [after, before] : [before, after]));

// Why `entry` cannot be crossed in direction `dir` on a page holding these
// lines and these references (`activeLineN`, box and block numbers), or null
// when it can. Apart from the page so a caller about to put lines back can ask
// it of the page as it would be, before changing anything.
export function lineOrderProblem(lines, refs, entry, dir = 'redo') {
  const numbers = orderMap(entry, dir);
  const order = dir === 'undo' ? entry.before : entry.numbers.map(([, n]) => n);
  const imported = lines.filter((l) => !(l.n < 0));
  const targets = new Set(numbers.values());
  if (
    imported.length !== numbers.size || new Set(imported.map((l) => l.n)).size !== numbers.size ||
    imported.some((l) => !Number.isFinite(l.n) || l.n <= 0 || !numbers.has(l.n)) ||
    targets.size !== numbers.size || order.length !== numbers.size ||
    new Set(order).size !== numbers.size || order.some((n) => !Number.isFinite(n) || n <= 0 || !targets.has(n))
  ) return 'the queue line numbers are not unique or have changed';
  // An orphan must not silently become attached when a sparse page is numbered
  // from one. Refuse that ambiguous edit before touching any part of the page.
  if (refs.some((n) => n > 0 && !numbers.has(n) && targets.has(n))) return 'a line number has no queue line';
  return null;
}
export const lineRefs = (p) => [p.activeLineN, ...p.boxes.map((b) => b.lineN), ...(p.detect?.boxes ?? []).map((d) => d.n)];

export function applyLineOrder(p, entry, dir = 'redo') {
  const problem = lineOrderProblem(p.lines, lineRefs(p), entry, dir);
  if (problem) throw new Error(problem);
  const numbers = orderMap(entry, dir);
  const order = dir === 'undo' ? entry.before : entry.numbers.map(([, n]) => n);
  const imported = p.lines.filter((l) => !(l.n < 0));
  const remap = (n) => numbers.get(n) ?? n;
  for (const l of imported) l.n = remap(l.n);
  const byN = new Map(imported.map((l) => [l.n, l]));
  let i = 0;
  p.lines = p.lines.map((l) => l.n < 0 ? l : byN.get(order[i++]));
  for (const b of p.boxes) if (b.lineN > 0) b.lineN = remap(b.lineN);
  p.activeLineN = remap(p.activeLineN);
  for (const d of p.detect?.boxes ?? []) if (d.n > 0) d.n = remap(d.n);
}

// Ordinary history entries use the page's CURRENT numbering, even when their
// box is temporarily deleted. Order entries instead describe transitions:
// their maps and before-order stay immutable, and are crossed in stack order.
// Copy on change because the history file also holds these same entry objects.
export function remapLineEntry(e, pageId, numbers) {
  if (e.pageId !== pageId || isOrderStep(e)) return e;
  // A group's items are entries of their own (history.svelte.js `group`).
  if (e.t === 'group') {
    const items = (e.items ?? []).map((it) => remapLineEntry(it, pageId, numbers));
    return items.some((it, i) => it !== e.items[i]) ? { ...e, items } : e;
  }
  let out = e;
  const put = (key, value) => {
    if (value === e[key]) return;
    if (out === e) out = { ...e };
    out[key] = value;
  };
  const remap = (n) => numbers.get(n) ?? n;
  const box = (b) => b && remap(b.lineN) !== b.lineN ? { ...b, lineN: remap(b.lineN) } : b;
  for (const key of ['lineN', 'activeBefore', 'activeAfter']) put(key, remap(e[key]));
  put('box', box(e.box));
  if (e.line && remap(e.line.n) !== e.line.n) put('line', { ...e.line, n: remap(e.line.n) });
  if (e.items) {
    const items = e.items.map((it) => {
      const b = box(it.box);
      return b === it.box ? it : { ...it, box: b };
    });
    if (items.some((it, i) => it !== e.items[i])) put('items', items);
  }
  return out;
}

export function remapLineStack(stack, entry, dir = 'redo') {
  const numbers = orderMap(entry, dir);
  const remap = (e) => remapLineEntry(e, entry.pageId, numbers);
  return { undo: stack.undo.map(remap), redo: stack.redo.map(remap) };
}

// Entries that move every line number they cross: a reading-order edit, and a
// numbered line's delete (which is one such edit followed by a removal - see
// `deleteOrder`). Their own numbers describe the transition, so a renumber
// never rewrites them, and they are walked only from the top of a stack.
export const isOrderStep = (e) => e?.t === 'order' || (e?.t === 'lineDelete' && Array.isArray(e.numbers));

// The order step a numbered line's delete starts with: line `n` carried to
// the end of the imported rows, and every imported row numbered by its place,
// as `moveLine` numbers them. Taking the line out of the last place then
// leaves 1..N-1 with no gap, and the map stays one to one, so its reverse puts
// back every number exactly - including that of an entry lower on the stack
// that still names the deleted line, which a map that dropped `n` would hand
// to its neighbour. Null when the line is already last and numbered by its
// place, because then there is nothing to renumber.
export function deleteOrder(p, n) {
  const imported = p.lines.filter((l) => !(l.n < 0));
  const from = imported.findIndex((l) => l.n === n);
  if (from < 0) return null;
  const before = imported.map((l) => l.n);
  const after = [...imported.slice(0, from), ...imported.slice(from + 1), imported[from]];
  const numbers = after.map((l, i) => [l.n, i + 1]);
  if (numbers.every(([a, b]) => a === b) && from === imported.length - 1) return null;
  return { before, numbers };
}

// What a row and its page mark are called: the number of a numbered line, and
// T1, T2... for the free lines in the order they sit on the page. One map for
// the pane and the page, so the two can never call one line by two names.
export function lineLabels(lines) {
  const out = new Map();
  let t = 0;
  for (const l of lines ?? []) out.set(l.n, l.n < 0 ? `T${++t}` : String(l.n));
  return out;
}
