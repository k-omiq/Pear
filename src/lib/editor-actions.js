// ===== The editor's named actions: what they do, and when they can =====
// Every action in the shortcut registry (shortcuts.svelte.js) runs through a
// handler, whether it is reached by its key, the command palette or the box's
// right-click menu, so the three cannot disagree. Most handlers live here.
// The ones that need what only a component holds are registered there:
// App.svelte (tools, the box clipboard, undo, size steps, the palette, the
// font library) and EditorRoot.svelte (fit to window, which needs the canvas).
//
// `RUNS` is one line per action: `when` says whether it can do anything now,
// `run` does it. A handler declines (returns false) when `when` is false, so a
// key bound to it falls through to the browser. The palette lists only what
// `when` allows rather than offering it and then refusing.
import {
  app,
  byId,
  page,
  gotoPage,
  nextPage,
  prevPage,
  zoomIn,
  zoomOut,
  zoomReset,
  hasCopiedBox,
  isLongstrip,
  isTranslateMode,
  isTranslateChapter,
  openBulk,
  nextPageWithWork,
  placeDetectedInChapter,
  saveSidebar,
  boxTagName,
  resetBoxToTagStyle,
  saveBoxStyleAsTag,
  applyTagStyleToChapter,
  centreTextInOutline,
  outlineToBox,
  approvePageOutlines,
  editBoxes,
  refuseLocked,
  lineByN,
  snugSelectedBox,
  snugPageBoxes,
  boxText,
  boxRuns,
  setRangeFace,
  setLineRangeFace,
  faceRefusal,
} from './store.svelte.js';
import { typingSel, selectedRange, askPending, askFacePick, lineSel } from './typing-selection.svelte.js';
import { faceAt } from './runs.js';
import { sidecarReady, detectCurrentPage, detectAllPages } from './sidecar.js';
import { SHORTCUTS, keyLabel, hasShortcutHandler, matchesWords, runShortcut, actionOff } from './shortcuts.svelte.js';
import { sfxToolOn, isComics } from './prefs.svelte.js';
import { clipToBubble, toggleFade } from './box-mask-actions.js';
import { jobs } from './jobs.svelte.js';
import { startPatternPick, canPickPattern } from './pattern-pick.svelte.js';
import { drawRead } from './draw-read.svelte.js';
import { openSettings } from './settings-tabs.svelte.js';
import { panels, setHidden, showPanel } from './editor/panels.svelte.js';
import { setInspectorTab } from './inspector-tabs.svelte.js';
import { showActiveRow, drawLineBox, deleteLineWithUndo } from './Queue.svelte';
import { exportImages } from './exporter.js';
import { goProject, goLibrary } from './route.svelte.js';

// A chapter open in typeset mode: what nearly every action needs.
const typeset = () => app.loaded && !isTranslateMode();
const boxSelected = () => typeset() && app.selectedId != null && !!byId(app.selectedId);
const tagged = () => boxSelected() && !!boxTagName();
const fitted = () => boxSelected() && !!byId(app.selectedId)?.fit;
// Both detect scopes ask the engine for work, so both need it up and idle.
// Translate chapters detect too. General use has no detection at all.
const canDetect = () => isComics() && app.loaded && sidecarReady() && !app.detecting;
const paged = () => typeset() && !isLongstrip() && app.pages.length > 1;
// A translate chapter's typing pane with a line in it to act on.
const activeLine = () => app.loaded && isTranslateChapter() && page().activeLineN != null && !!lineByN(page(), page().activeLineN);
// The series sections of Settings are there only while a chapter is open.
const inChapter = () => !!app.chapterRef;

// One edit to the selected box's style: one undo step, fitted after, refused
// on a locked box with the toast that says so.
function editStyle(mutate) {
  const b = byId(app.selectedId);
  if (!b || refuseLocked(b)) return false;
  editBoxes([{ page: page(), box: b }], (box) => mutate(box.style));
}
const flip = (key) => () => editStyle((s) => { s[key] = !s[key]; });
const set = (key, v) => () => editStyle((s) => { s[key] = v; });
const effect = (key) => () => editStyle((s) => { if (s[key]) s[key].on = !s[key].on; else return false; });
// The words a face command acts on (typing-selection.svelte.js): the range
// selected in the box typed into, or in the Inspector's field for the
// selected box; a bare caret only while the box itself is typed into.
function faceTarget() {
  if (!typeset()) return null;
  const id = app.editingId ?? app.selectedId;
  const b = id != null ? byId(id) : null;
  const text = b ? (boxText(b) ?? '') : '';
  const r = b ? selectedRange(b.id, text) : null;
  return r ? { b, text, r, caret: r[0] === r[1], typing: app.editingId === b.id } : null;
}
// Words selected in a queue line's English field (typed into now): the line's.
function lineTarget() {
  if (!typeset() || lineSel.n == null || lineSel.a === lineSel.f || lineSel.pageId !== page()?.id) return null;
  const ln = lineByN(page(), lineSel.n);
  return ln && (ln.en ?? '') === lineSel.text ? { n: lineSel.n, a: lineSel.a, f: lineSel.f } : null;
}
const faceRange = () => {
  const t = faceTarget();
  return t && !t.caret ? t : null;
};
// Bold or Italic: on the selected words; at a bare caret, for the letters
// typed next (`askPending`: the face asked for there, else the one the
// letter before has); with nothing typed into, the whole box, as before. A
// key pressed in a text field with nothing selected there (the queue's, the
// Inspector's size) is not about the whole box, and falls through - except
// the Inspector's Text field, which holds the box's words: a caret there is
// the whole box, as the Inspector's own B and I say beside it.
const inField = (e) => !!e?.target?.closest?.('input, textarea, [contenteditable="true"]') && e.target.id !== 'insp-text';
// A locked box, or curved text (laid out in one face), takes no face on part
// of its words: said once, nothing written.
const refused = (t) => !!faceRefusal(t.b, page(), { toast: true });
const faceToggle = (key) => (e) => {
  const L = lineTarget();
  if (L) return void setLineRangeFace(page(), L.n, L.a, L.f, { toggle: key });
  const t = faceTarget();
  if (t && (!t.caret || t.typing) && refused(t)) return;
  if (t && !t.caret) return void setRangeFace(t.b, t.r[0], t.r[1], { toggle: key });
  if (t?.typing) {
    const at = t.r[0];
    const pend = typingSel.pending;
    const asked = pend?.boxId === t.b.id && pend.at === at && key in pend.patch ? pend.patch[key] : null;
    const now = asked ?? faceAt(boxRuns(t.b), at > 0 ? at - 1 : at, t.b.style)[key];
    return void askPending(t.b.id, t.text, at, { [key]: !now });
  }
  if (!boxSelected() || inField(e)) return false;
  return flip(key)();
};
const wrap180 = (v) => ((((v + 180) % 360) + 360) % 360) - 180;
const rotate = (d) => () => editStyle((s) => { s.rotation = wrap180(Math.round((s.rotation ?? 0) + d)); });

// The box's line becomes the queue's active row, and the queue is brought up
// and asked to scroll to it even when that row was active already.
function showInQueue() {
  const b = byId(app.selectedId);
  if (b?.lineN == null || !lineByN(page(), b.lineN)) return false;
  page().activeLineN = b.lineN;
  showPanel('queue');
  showActiveRow();
}

function togglePanel(id) {
  if (panels[id].hidden) showPanel(id);
  else setHidden(id, true);
}

// The rail's caret: the same flag and the same save.
function toggleRaw() {
  app.sidebarHidden = !app.sidebarHidden;
  saveSidebar();
}

// The newest finished job with failed pages it can run again (FLOW-5).
const retryable = () => jobs.items.findLast((j) => !j.running && j.failed.length && j.retry && j.current());

const SETTINGS_SERIES = new Set(['series', 'styles', 'guide']);

const RUNS = {
  'text.bold': { when: () => boxSelected() || !!faceTarget() || !!lineTarget(), run: faceToggle('bold') },
  'text.italic': { when: () => boxSelected() || !!faceTarget() || !!lineTarget(), run: faceToggle('italic') },
  // The family list is the Inspector's, on its Text tab: its panel is shown,
  // which draws the Inspector if it was hidden, and the Inspector takes the ask.
  'text.typeface': {
    when: () => !!faceRange(),
    run: () => {
      const t = faceRange();
      if (refused(t)) return;
      askFacePick(t.b.id, t.text, t.r[0], t.r[1]);
      setInspectorTab('text');
      showPanel('options');
    },
  },
  'text.clearFace': {
    when: () => !!faceRange() || !!lineTarget(),
    run: () => {
      const L = lineTarget();
      if (L) return void setLineRangeFace(page(), L.n, L.a, L.f, { clear: true });
      const t = faceRange();
      setRangeFace(t.b, t.r[0], t.r[1], { clear: true });
    },
  },
  'text.uppercase': { when: boxSelected, run: flip('uppercase') },
  'text.alignLeft': { when: boxSelected, run: set('align', 'left') },
  'text.alignCenter': { when: boxSelected, run: set('align', 'center') },
  'text.alignRight': { when: boxSelected, run: set('align', 'right') },
  'text.alignTop': { when: boxSelected, run: set('valign', 'top') },
  'text.alignMiddle': { when: boxSelected, run: set('valign', 'middle') },
  'text.alignBottom': { when: boxSelected, run: set('valign', 'bottom') },

  'box.rotateLeft': { when: boxSelected, run: rotate(-90) },
  'box.rotateRight': { when: boxSelected, run: rotate(90) },
  'box.flipH': { when: boxSelected, run: flip('flipH') },
  'box.flipV': { when: boxSelected, run: flip('flipV') },
  'tag.reset': { when: tagged, run: () => resetBoxToTagStyle() },
  'tag.save': { when: tagged, run: () => saveBoxStyleAsTag() },
  'tag.applyChapter': { when: tagged, run: () => applyTagStyleToChapter(boxTagName()) },
  'pattern.pick': { when: () => boxSelected() && canPickPattern(), run: () => startPatternPick(page().id, app.selectedId) },
  'fx.warp': { when: boxSelected, run: effect('warp') },
  'fx.motionBlur': { when: boxSelected, run: effect('motionBlur') },
  'fx.roughen': { when: boxSelected, run: effect('roughen') },
  'fx.wobble': { when: boxSelected, run: effect('wobble') },
  'fx.fade': { when: boxSelected, run: () => toggleFade(app.selectedId) },
  'box.snugWidth': { when: boxSelected, run: () => snugSelectedBox() },
  'page.snugWidths': { when: () => typeset() && page()?.boxes?.length > 0, run: () => snugPageBoxes() },
  'box.showInQueue': { when: () => boxSelected() && byId(app.selectedId)?.lineN != null, run: showInQueue },
  'bulk.open': { when: () => typeset() && !app.bulk.active, run: () => openBulk() },

  'bubble.centre': { when: fitted, run: () => centreTextInOutline(app.selectedId) },
  // Comics only: free text has no bubble to keep to.
  'mask.clipToBubble': { when: () => boxSelected() && isComics(), run: () => clipToBubble() },
  'bubble.outlineToBox': { when: boxSelected, run: () => outlineToBox(app.selectedId) },
  'bubble.approvePage': { when: typeset, run: () => approvePageOutlines() },

  'page.next': { when: paged, run: () => nextPage() },
  'page.prev': { when: paged, run: () => prevPage() },
  'page.nextWork': { when: () => typeset() && app.pages.length > 1, run: () => nextPageWithWork() },
  'view.zoomIn': { when: () => app.loaded, run: () => zoomIn() },
  'view.zoomOut': { when: () => app.loaded, run: () => zoomOut() },
  'view.zoomActual': { when: () => app.loaded, run: () => zoomReset() },
  'view.raw': { when: typeset, run: toggleRaw },
  'panel.options': { when: typeset, run: () => togglePanel('options') },
  'panel.queue': { when: typeset, run: () => togglePanel('queue') },
  'panel.sfx': { when: () => typeset() && sfxToolOn(), run: () => togglePanel('sfx') },
  'panel.ai': { when: typeset, run: () => togglePanel('ai') },

  'detect.page': { when: canDetect, run: () => detectCurrentPage() },
  'detect.chapter': { when: canDetect, run: () => detectAllPages() },
  'queue.placeChapter': { when: () => typeset() && app.pages.length > 0 && !app.chapterPlace, run: () => placeDetectedInChapter() },
  'jobs.retry': { when: () => !!retryable() && sidecarReady() && !app.detecting, run: () => retryable()?.retry() },
  'ocr.draw': { when: () => true, run: () => { drawRead.open = true; } },

  'translate.cleaned': { when: () => isTranslateChapter() && app.translateTypeset, run: () => { app.viewCleaned = !app.viewCleaned; } },
  // The typing pane's active line. Delete's keys are the row's own (Queue.svelte);
  // this is the action they name, for whatever runs it by id.
  'line.delete': { when: activeLine, run: () => deleteLineWithUndo(page().activeLineN) },
  'line.drawBox': { when: activeLine, run: () => drawLineBox(page().activeLineN) },

  'chapter.export': { when: () => typeset() && !app.exporting, run: () => { app.exportOpen = true; } },
  'chapter.saveJson': { when: () => app.loaded && !app.exporting, run: () => { exportImages('JSON', 'all'); } },
  'app.back': {
    when: () => !!app.chapterRef,
    run: () => {
      const pid = app.chapterRef?.projectId;
      pid ? goProject(pid) : goLibrary();
    },
  },
  ...Object.fromEntries(
    SHORTCUTS.filter((s) => s.id.startsWith('settings.')).map((s) => {
      const tab = s.id.slice('settings.'.length);
      return [s.id, { when: SETTINGS_SERIES.has(tab) ? inChapter : () => true, run: () => openSettings(tab) }];
    }),
  ),
};

// The handlers for `RUNS`, for App.svelte to register while the editor runs.
// Each refuses an action the usage does not have (`actionOff`) as well as one
// whose own condition fails, so no path to a handler - a key, the palette, a
// menu - can run a comic tool under general use.
export function editorActionHandlers() {
  return Object.fromEntries(Object.entries(RUNS).map(([id, a]) => [id, (e) => (!actionOff(id) && a.when() ? a.run(e) : false)]));
}

// What each component-owned action needs before it can do anything. Their
// handlers refuse on their own too - this only keeps the palette from
// offering what would be refused.
const BOX_PREFIXES = ['box.', 'style.'];
function shortcutWhen(id) {
  // A tool switched off, or one the usage does not have, first: it is not
  // offered whatever its own condition says.
  if (actionOff(id)) return false;
  const r = RUNS[id];
  if (r) return r.when();
  if (id === 'box.paste') return typeset() && hasCopiedBox();
  if (id === 'fonts.open') return !isTranslateMode();
  if (BOX_PREFIXES.some((p) => id.startsWith(p))) return boxSelected();
  return typeset();
}

// The registry, as palette entries. Built per call rather than once: the key
// shown is the one bound now, and the handlers come and go with the editor.
export function shortcutActions() {
  return SHORTCUTS.filter((s) => s.id !== 'palette.open' && !s.altOf && !s.ctx && !s.inField).map((s) => ({
    id: s.id,
    label: s.label,
    group: s.group,
    keywords: s.keywords ?? '',
    shortcut: s.id,
    when: () => hasShortcutHandler(s.id) && shortcutWhen(s.id),
    run: () => runShortcut(s.id),
  }));
}

// "page 12", "p12", "p 12" or a bare "12": the one entry built from what was
// typed. Paged chapters only - a strip has no pages to turn, its index follows
// the scroll (see the Pager, which a strip does not mount either).
const PAGE_QUERY = /^(?:page|pg|p)?\s*(\d+)$/i;
export function pageAction(query) {
  const m = PAGE_QUERY.exec(query.trim());
  if (!m || !app.loaded || isLongstrip()) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > app.pages.length) return null;
  return {
    id: 'page.go',
    label: `Go to page ${n}`,
    group: 'View',
    keywords: '',
    when: () => true,
    run: () => gotoPage(n - 1),
  };
}

// Every word must appear somewhere in the label, the group or the keywords.
export const matchesQuery = (entry, query) => matchesWords(`${entry.label} ${entry.group} ${entry.keywords}`, query);

// What the palette lists for a query: the page jump first when the query is a
// page, then everything runnable now that matches every word.
export function paletteResults(query = '') {
  const out = [];
  const jump = pageAction(query);
  if (jump) out.push(jump);
  for (const a of shortcutActions()) {
    if (a.when() && matchesQuery(a, query)) out.push(a);
  }
  return out;
}

// The key shown beside an entry, or '' when it has none.
export const entryKey = (entry) => (entry.shortcut ? keyLabel(entry.shortcut) : '');

