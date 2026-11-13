// ===== Which Inspector tab is open =====
// The Text Box Options panel is four tabs across the top, and which one is
// showing is remembered for the session rather than saved: a letterer working
// through a page of strokes selects twenty boxes in a row and wants the same
// tab each time; a letterer who quits and comes back is starting a different
// job.
//
// It lives out here rather than in Inspector.svelte's module script because the
// keyboard has to reach it too - the tab-hop shortcuts are dispatched from
// App.svelte, which has no handle on the panel and should not grow one. The
// panel reads this state and writes it; the shortcuts write it; nothing else
// needs to know the panel exists.
import { drawTool, clearDrawTool, DRAW_PANELS } from './box-draw-tool.svelte.js';
import { sfxToolOn } from './prefs.svelte.js';

// `sfx` is the box's sound effect (SfxPanel), a tab only while SFX is on in
// Settings (`sfxToolOn`); `shownInspectorTabs` is the strip as drawn.
export const INSPECTOR_TABS = ['text', 'fill', 'effects', 'layout', 'sfx'];
export const shownInspectorTabs = () => INSPECTOR_TABS.filter((t) => t !== 'sfx' || sfxToolOn());

// A draw tool is its panel's: once another tab or sub-tab is in front, the
// tool is put down (`DRAW_PANELS`). Every change of tab comes through here.
function drawToolFollowsPanel() {
  const panel = DRAW_PANELS[drawTool.target];
  if (panel && !(inspectorTab.id === 'effects' && effectsSubTab.id === panel)) clearDrawTool();
}

export const inspectorTab = $state({ id: 'text' });

export function setInspectorTab(id) {
  if (!shownInspectorTabs().includes(id)) return false;
  inspectorTab.id = id;
  drawToolFollowsPanel();
  return true;
}

// +1 / -1, wrapping. Wrapping rather than stopping at the ends because four
// tabs is a ring you flick through, not a list you scroll.
export function cycleInspectorTab(step = 1) {
  const tabs = shownInspectorTabs();
  const i = tabs.indexOf(inspectorTab.id);
  const from = i === -1 ? 0 : i;
  const n = tabs.length;
  inspectorTab.id = tabs[(((from + step) % n) + n) % n];
  drawToolFollowsPanel();
  return inspectorTab.id;
}

// ===== Which Effects sub-tab is open =====
// Session-only state, same reasoning as the main tabs.
// `warp` is the arc / circle / bezier-path group and has been since before the
// mesh existed; `transform` is the mesh - free transform at a 1x1 grid, mesh
// transform above it. Two different features with two adjacent names, so the
// panel labels them "Warp" and "Transform" and the design says so in as many
// words: they must not be confused.
// `liquify` sits beside `transform` because it edits the same mesh with a
// round tool instead of handles.
// SFX is not a sub-tab: it is a main tab of its own (`sfx` above).
//
// The sub-tabs come in four groups, a segment above them, so the panel shows
// four words and then at most four more instead of a row of mystery icons.
// The group is never stored on its own: it is read off the sub-tab, so
// anything that picks a sub-tab (the panel, a test, a shortcut) has picked
// its group too.
export const EFFECTS_GROUPS = [
  { id: 'styles', label: 'Styles' },
  { id: 'shape', label: 'Shape' },
  { id: 'surface', label: 'Surface' },
  { id: 'paint', label: 'Paint' },
];

export const EFFECTS_TABS = [
  { id: 'stroke', label: 'Stroke', group: 'styles' },
  { id: 'shadow', label: 'Shadow', group: 'styles' },
  { id: 'glow', label: 'Glow', group: 'styles' },
  { id: 'bevel', label: 'Bevel', group: 'styles' },
  { id: 'warp', label: 'Warp', group: 'shape' },
  { id: 'transform', label: 'Transform', group: 'shape' },
  { id: 'liquify', label: 'Liquify', group: 'shape' },
  // Wobble moves each letter on its own; the three above move the whole box.
  { id: 'wobble', label: 'Wobble', group: 'shape' },
  { id: 'edges', label: 'Edges', group: 'surface' },
  { id: 'blur', label: 'Blur', group: 'surface' },
  // Crack, Lightning, Splash and Scratches: seeded patterns over the box.
  { id: 'special', label: 'Special', group: 'surface' },
  { id: 'mask', label: 'Mask', group: 'paint' },
  { id: 'fade', label: 'Fade', group: 'paint' },
  { id: 'colour', label: 'Colour', group: 'paint' },
];

export const EFFECTS_SUBTABS = EFFECTS_TABS.map((t) => t.id);

export const effectsSubTab = $state({ id: 'stroke' });

// The sub-tab each group last showed, so going back to a group finds the
// sub-tab that was in front there - kept for the session like the rest.
const lastInGroup = {};

export function effectsGroupOf(id) {
  return EFFECTS_TABS.find((t) => t.id === id)?.group ?? null;
}

export function effectsTabsIn(group) {
  return EFFECTS_TABS.filter((t) => t.group === group);
}

export function setEffectsSubTab(id) {
  const group = effectsGroupOf(id);
  if (!group) return false;
  effectsSubTab.id = id;
  lastInGroup[group] = id;
  drawToolFollowsPanel();
  return true;
}

export function setEffectsGroup(group) {
  const tabs = effectsTabsIn(group);
  if (!tabs.length) return false;
  const last = lastInGroup[group];
  return setEffectsSubTab(tabs.some((t) => t.id === last) ? last : tabs[0].id);
}
