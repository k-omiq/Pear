// ===== A style patch, applied =====
// One way to change part of a box's style, shared by the bulk panel and the AI
// tool layer (docs/AI_TYPESETTING_PLAN.md section 1): a partial style, merged
// key by key over the box's own, then through `normalizeStyle`, which is the
// trust boundary for every value.
//
//   numbers   `12`, or relative to the box's own value: "+2", "-2", "*1.1"
//   objects   merged field by field: `{ gradient: { angle: 90 } }`
//   arrays    an array replaces the list whole; an object of indexes patches
//             items in place: `{ strokes: { 0: { width: "+2" } } }`
//
// A colour or a stroke set here is set by hand, so the bubble stops picking
// the text colour (`autoContrast`, LET-3) unless the patch says otherwise.
//
// Pure: the caller hands over a plain style (`$state.snapshot` or `cloneStyle`)
// and gets a new one back. Nothing half-applies: a patch with any bad relative
// value changes nothing and says why.
import { normalizeStyle } from './data.js';

const REL = /^([+\-*])(\d+(?:\.\d+)?)$/;
const isPlain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const copy = (v) => (Array.isArray(v) ? v.map(copy) : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)])) : v);

// A relative number against the value it changes. Null when it is not one.
export function resolveRelative(value, current) {
  if (typeof value !== 'string') return null;
  const m = REL.exec(value.trim());
  if (!m) return null;
  if (typeof current !== 'number' || !Number.isFinite(current)) return { error: `"${value}" needs a number to change, and there is none` };
  const n = Number(m[2]);
  const out = m[1] === '+' ? current + n : m[1] === '-' ? current - n : current * n;
  return { value: Math.round(out * 1000) / 1000 };
}

function merge(base, patch, path, errors) {
  if (Array.isArray(patch)) return patch.map((it, i) => (isPlain(it) ? merge({}, it, `${path}.${i}`, errors) : copy(it)));
  if (!isPlain(patch)) {
    const rel = resolveRelative(patch, base);
    if (rel?.error) errors.push({ path, error: rel.error });
    return rel ? rel.value : copy(patch);
  }
  // An object over a list patches items by index.
  if (Array.isArray(base)) {
    const out = base.map(copy);
    for (const [k, v] of Object.entries(patch)) {
      const i = Number(k);
      if (!Number.isInteger(i) || i < 0 || i >= out.length) {
        errors.push({ path: `${path}.${k}`, error: `no item ${k} (the list has ${out.length})` });
        continue;
      }
      out[i] = merge(out[i], v, `${path}.${i}`, errors);
    }
    return out;
  }
  const out = isPlain(base) ? copy(base) : {};
  for (const [k, v] of Object.entries(patch)) out[k] = merge(out[k], v, path ? `${path}.${k}` : k, errors);
  return out;
}

// `style` with `patch` over it. Returns `{ style, errors }`; with errors, the
// style is the one handed in, normalised.
export function applyStylePatch(style, patch) {
  const errors = [];
  const base = normalizeStyle(copy(style));
  if (!isPlain(patch)) return { style: base, errors: patch == null ? [] : [{ path: '', error: 'a style patch is an object' }] };
  const merged = merge(base, patch, '', errors);
  if (errors.length) return { style: base, errors };
  if (('color' in patch || 'strokes' in patch) && !('autoContrast' in patch)) merged.autoContrast = false;
  return { style: normalizeStyle(merged), errors };
}
