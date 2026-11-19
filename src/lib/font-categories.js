// ===== Font categories =====
// The user's own groups of their own families ("Dialogue", "SFX", "Titles"),
// shown under Your fonts in the Font Library. A family can sit in any number
// of them, or in none: a family in none is "bare" and is listed on its own.
//
// Stored as the pref `fontCategories`: [{ id, name, families: [name] }]. Only
// names, like every other font list in prefs, so a category outlives a font
// being removed and added again. Every function here is pure: it takes the
// list and returns a new one, and the caller writes it with setPref.

export const MAX_CATEGORIES = 200;
const MAX_NAME = 60;
const MAX_FAMILIES = 5000;

const cleanName = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME) : '');

// What the stored value may hold: anything else is dropped, never trusted.
export function cleanCategories(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  const ids = new Set();
  for (const c of v) {
    const id = typeof c?.id === 'string' ? c.id.trim().slice(0, 40) : '';
    const name = cleanName(c?.name);
    if (!id || !name || ids.has(id)) continue;
    ids.add(id);
    const families = Array.isArray(c.families)
      ? [...new Set(c.families.filter((n) => typeof n === 'string' && n.trim()))].slice(0, MAX_FAMILIES)
      : [];
    out.push({ id, name, families });
    if (out.length >= MAX_CATEGORIES) break;
  }
  return out;
}

const newId = () => `cat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// A name no other category has: "New category", "New category 2", …
export function freeName(list, base = 'New category') {
  const name = cleanName(base) || 'New category';
  const taken = (n) => list.some((c) => c.name.toLowerCase() === n.toLowerCase());
  if (!taken(name)) return name;
  // The number stays inside the name limit, so the stored (cut) name is
  // still one no other category has.
  for (let i = 2; ; i++) {
    const tail = ` ${i}`;
    const n = `${name.slice(0, MAX_NAME - tail.length).trimEnd()}${tail}`;
    if (!taken(n)) return n;
  }
}

// Returns { list, id }. `families` start inside it.
export function createCategory(list, name, families = [], id = newId()) {
  const cat = { id, name: freeName(list, name), families: [...new Set(families)] };
  return { list: [...list, cat], id };
}

export function renameCategory(list, id, name) {
  const n = cleanName(name);
  if (!n) return list;
  const others = list.filter((c) => c.id !== id);
  return list.map((c) => (c.id === id ? { ...c, name: freeName(others, n) } : c));
}

export function deleteCategory(list, id) {
  return list.filter((c) => c.id !== id);
}

// Moves a category one step up (-1) or down (+1) in the sidebar.
export function moveCategory(list, id, step) {
  const i = list.findIndex((c) => c.id === id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export function addToCategory(list, id, family) {
  return list.map((c) => (c.id === id && !c.families.includes(family) ? { ...c, families: [...c.families, family] } : c));
}

export function removeFromCategory(list, id, family) {
  return list.map((c) => (c.id === id && c.families.includes(family) ? { ...c, families: c.families.filter((n) => n !== family) } : c));
}

export const inCategory = (list, id, family) => !!list.find((c) => c.id === id)?.families.includes(family);

// The categories a family sits in, in sidebar order.
export const categoriesOf = (list, family) => list.filter((c) => c.families.includes(family));

// A family renamed, or merged into another: its memberships go with it. When
// `to` already had some, it keeps those and gains `from`'s.
export function carryFamily(list, from, to) {
  if (!from || !to || from === to) return list;
  return list.map((c) => {
    if (!c.families.includes(from)) return c;
    const families = c.families.filter((n) => n !== from);
    if (!families.includes(to)) families.push(to);
    return { ...c, families };
  });
}

// A new family split off one that stays: it joins every category `from` is in.
export function copyFamily(list, from, to) {
  if (!from || !to || from === to) return list;
  return list.map((c) => (c.families.includes(from) && !c.families.includes(to) ? { ...c, families: [...c.families, to] } : c));
}

// A family removed from the library leaves every category.
export function dropFamily(list, family) {
  return list.map((c) => (c.families.includes(family) ? { ...c, families: c.families.filter((n) => n !== family) } : c));
}

// The families of `fonts` that a view shows: one category, the bare ones, or
// all (`view` null).
export function familiesInView(fonts, list, view) {
  if (!view) return fonts;
  if (view === 'bare') {
    const placed = new Set(list.flatMap((c) => c.families));
    return fonts.filter((f) => !placed.has(f.name));
  }
  const cat = list.find((c) => c.id === view);
  if (!cat) return fonts;
  const names = new Set(cat.families);
  return fonts.filter((f) => names.has(f.name));
}

// How many of the library's families a category holds (names of families no
// longer in the library are not counted).
export function countIn(fonts, list, view) {
  return familiesInView(fonts, list, view).length;
}
