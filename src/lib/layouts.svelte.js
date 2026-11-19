// ===== The editor's layouts (UI combos) =====
// What the editor shows is a layout, not a mode: whether the typesetting tools
// are out, and whether the text queue and the Text box options sit docked in
// the column down the right or float as windows. See docs/UI_COMBOS.md.
//
// A chapter's kind (chapter.json `mode`, 'translate' or 'typeset') is data -
// what its lines are - and it only picks which layout the chapter opens with:
// `use[kind]`. Two presets, and one custom layout per kind.
//
// A leaf: it imports nothing of the store or the prefs, so both can import it.
// The prefs module persists it (inside the `mt.prefs` blob) through the hook
// it registers here, and the store reads it to answer `isTranslateMode`.

export const DOCK = ['docked', 'floating'];
export const LAYOUT_IDS = ['translate', 'typeset', 'custom'];
export const LAYOUT_KINDS = ['translate', 'typeset'];

export const PRESETS = Object.freeze({
  // The page beside the typing pane. With the tools turned on, the Text box
  // options dock above the queue, in the same column.
  translate: Object.freeze({ tools: false, queue: 'docked', options: 'docked' }),
  // Tools out, every panel a window over the page.
  typeset: Object.freeze({ tools: true, queue: 'floating', options: 'floating' }),
});

export const LAYOUT_NAMES = { translate: 'Translate', typeset: 'Typeset', custom: 'Custom' };

const pick = (v, list, d) => (list.includes(v) ? v : d);

export function normalizeCombo(raw, fallback = PRESETS.translate) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    tools: typeof r.tools === 'boolean' ? r.tools : fallback.tools,
    queue: pick(r.queue, DOCK, fallback.queue),
    options: pick(r.options, DOCK, fallback.options),
  };
}

export const sameCombo = (a, b) => a.tools === b.tools && a.queue === b.queue && a.options === b.options;

// The custom layout a kind starts with, before the user has made one.
const CUSTOM_DEFAULT = Object.freeze({ tools: true, queue: 'docked', options: 'docked' });

// The stored shape, every field checked; anything unreadable is its default.
// No blob at all is what every install before layouts has, and its answer is
// exactly how those installs opened chapters. Each kind has its own custom
// layout, so a mix made in a typeset chapter never changes a translate one.
export function normalizeLayouts(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const use = r.use && typeof r.use === 'object' ? r.use : {};
  const custom = r.custom && typeof r.custom === 'object' ? r.custom : {};
  return {
    use: {
      translate: pick(use.translate, LAYOUT_IDS, 'translate'),
      typeset: pick(use.typeset, LAYOUT_IDS, 'typeset'),
    },
    custom: {
      translate: normalizeCombo(custom.translate, CUSTOM_DEFAULT),
      typeset: normalizeCombo(custom.typeset, CUSTOM_DEFAULT),
    },
  };
}

export const layouts = $state(normalizeLayouts(null));

let persist = () => {};
// The prefs module's write, registered once it has loaded.
export function onLayoutsChange(fn) {
  persist = typeof fn === 'function' ? fn : () => {};
}

// Layouts another window saved, taken in here. The store registers how (so
// the tools it is holding are let go or kept the same way as any change); with
// nothing registered it is a plain set.
let adopt = (write) => write();
export function onLayoutsAdopt(fn) {
  adopt = typeof fn === 'function' ? fn : (write) => write();
}
export function adoptLayouts(raw) {
  adopt(() => setLayouts(raw));
}

export function setLayouts(raw) {
  const next = normalizeLayouts(raw);
  layouts.use.translate = next.use.translate;
  layouts.use.typeset = next.use.typeset;
  Object.assign(layouts.custom.translate, next.custom.translate);
  Object.assign(layouts.custom.typeset, next.custom.typeset);
}

export function snapshotLayouts() {
  return {
    use: { ...layouts.use },
    custom: { translate: { ...layouts.custom.translate }, typeset: { ...layouts.custom.typeset } },
  };
}

const kindOf = (kind) => (kind === 'translate' ? 'translate' : 'typeset');

// The layout a chapter of this kind shows now.
export function layoutIdFor(kind) {
  return layouts.use[kindOf(kind)];
}
export function comboFor(kind) {
  const id = layoutIdFor(kind);
  return id === 'custom' ? layouts.custom[kindOf(kind)] : PRESETS[id];
}

// Use a preset (or the custom slot) for this kind of chapter.
export function useLayout(kind, id) {
  if (!LAYOUT_IDS.includes(id)) return false;
  const k = kindOf(kind);
  if (layouts.use[k] === id) return true;
  layouts.use[k] = id;
  persist();
  return true;
}

// One field changed. A result that is a preset uses the preset and leaves the
// custom slot as it was; anything else is the custom slot.
export function setComboField(kind, field, value) {
  const now = comboFor(kind);
  if (!(field in now)) return false;
  const next = normalizeCombo({ ...now, [field]: value }, now);
  if (sameCombo(next, now)) return true;
  const k = kindOf(kind);
  const preset = Object.keys(PRESETS).find((id) => sameCombo(PRESETS[id], next));
  if (preset) layouts.use[k] = preset;
  else {
    Object.assign(layouts.custom[k], next);
    layouts.use[k] = 'custom';
  }
  persist();
  return true;
}
