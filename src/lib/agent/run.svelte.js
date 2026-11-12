// ===== An AI run =====
// What one agent did, held together so the user can stop it and take it back
// (docs/AI_TYPESETTING_PLAN.md section 5):
//
//   one undo per page   every edit the run makes on a page joins one history
//                       group there (`inRun`, history.svelte.js)
//   Revert run          before the run first writes a page, the page is kept;
//                       Revert puts every kept page back, even after later
//                       edits, as one undo step per page (kind `restore`)
//   Stop                ends the run between tool calls. Done work stays.
//                       Writes are refused until the agent has been quiet for
//                       QUIET_MS, so a door that keeps calling cannot simply
//                       start a new run over the user's Stop
//   pinned              a run belongs to the chapter open when it began
//                       (`chapterOpenSeq`); a chapter switch ends it, and a
//                       write after that is refused
//
// A run through the MCP door (Door A) begins at its first write and ends after
// IDLE_MS with no call. An agent thinks between calls - reads a page view,
// weighs a fix - often for longer than a few seconds, so the run waits minutes
// for it: a run ended early would start Revert over at its next write. Quiet
// for QUIET_MS, the bar says the agent is thinking. The in-app panel (Door B,
// M6) will begin and end its own around one prompt.
import { app, pageById, settleEdits, markUnsaved, recordEdit, toast, quietly, gotoPage } from '../store.svelte.js';
import { chapterOpenSeq } from '../library.svelte.js';
import { inRun } from '../editor/history.svelte.js';
import { guideBound, snapshotGuide, restoreGuide } from '../guide.svelte.js';
import { snapshotTags, emptyTagChanges, keepTagChanges, tagChangesKept, restoreTagChanges } from '../tags.svelte.js';
import { ToolError } from './registry.js';

export const QUIET_MS = 20000;
export const IDLE_MS = 5 * 60 * 1000;

// What the "AI is editing" bar reads.
export const aiRun = $state({
  active: false,
  door: null,
  edits: 0,
  pages: 0,
  stopped: false,
  // No call for QUIET_MS: the agent is thinking, the run goes on.
  quiet: false,
  // A finished run can still be reverted, until the next one begins or the
  // chapter changes.
  canRevert: false,
});

let current = null; // { id, seq, door, kept: Map(pageId -> page copy), guideBefore: { key: value }, tagsBefore }
let seqCounter = 0;
let idleT = null;
let quietT = null;
let quiet = false;
let stoppedUntilQuiet = false;
// Bumped by Stop, Revert and a chapter change. A call that began before a bump
// writes nothing after it - a slow tool (place, detect) included.
let epoch = 0;

// What Revert puts back: the boxes, the lines and the detection (a run's
// `detect` writes both).
const keep = (p) => ({
  boxes: $state.snapshot(p.boxes ?? []),
  lines: $state.snapshot(p.lines ?? []),
  activeLineN: p.activeLineN ?? null,
  detect: p.detect ? $state.snapshot(p.detect) : null,
});

function sync() {
  aiRun.active = !!current?.active;
  aiRun.door = current?.door ?? null;
  aiRun.edits = current?.edits ?? 0;
  aiRun.pages = current?.kept.size ?? 0;
  aiRun.stopped = stoppedUntilQuiet;
  aiRun.quiet = quiet;
  aiRun.canRevert = !!current && current.seq === chapterOpenSeq() && (current.kept.size > 0 || seriesChanged(current));
}

const seriesChanged = (run) => Object.keys(run.guideBefore).length > 0 || tagChangesKept(run.tagsBefore);

function begin(door) {
  current = {
    id: `run${Date.now().toString(36)}${(seqCounter++).toString(36)}`,
    seq: chapterOpenSeq(),
    door,
    active: true,
    edits: 0,
    kept: new Map(),
    guideBefore: {},
    tagsBefore: emptyTagChanges(),
  };
  sync();
  return current;
}

// The run ends; what it did can still be reverted.
export function endRun() {
  if (current) current.active = false;
  clearTimeout(idleT);
  idleT = null;
  sync();
}

// Every call through a door, read or write, keeps the run alive and the Stop
// standing. Quiet for QUIET_MS lifts the Stop and shows the agent thinking;
// quiet for IDLE_MS ends the run.
export function noteCall() {
  clearTimeout(quietT);
  clearTimeout(idleT);
  quiet = false;
  quietT = setTimeout(() => {
    quietT = null;
    quiet = true;
    stoppedUntilQuiet = false;
    sync();
  }, QUIET_MS);
  idleT = setTimeout(() => {
    idleT = null;
    endRun();
  }, IDLE_MS);
  sync();
}

// The in-app panel's run (Door B) is one prompt: a new prompt ends whatever
// run went before - its Revert lasts until the new one first writes - and a
// Stop the user gave an earlier prompt does not hold this one back. The new
// run itself begins at its first write, as a door's does.
export function beginPromptRun() {
  clearTimeout(quietT);
  clearTimeout(idleT);
  quietT = null;
  idleT = null;
  quiet = false;
  stoppedUntilQuiet = false;
  if (current?.active) endRun();
  sync();
}

export function stopRun() {
  if (!current?.active) return false;
  epoch++;
  stoppedUntilQuiet = true;
  endRun();
  // Still counted from here, so the agent's next call keeps the Stop up.
  noteCall();
  toast('AI run stopped - its edits stay, Revert takes them back');
  return true;
}

// Refused unless the chapter the run began in is still the open one.
function pinned(run) {
  return run.seq === chapterOpenSeq() && !!app.chapterRef;
}

// The chapter changed under the run: it ends, and what it did can no longer
// be reverted from here. Called by the AI bar whenever the open chapter moves.
export function checkPin() {
  if (current && current.seq !== chapterOpenSeq()) {
    epoch++;
    endRun();
  }
  sync();
}

const STOPPED = 'the user stopped this AI run. Do not continue; tell the user what was done.';

// Whether a call may change anything: not after a Stop, a Revert or a chapter
// change that came since it began, and not while the user's Stop stands.
function guard(since) {
  if (since !== epoch) throw new ToolError('the user stopped or reverted the AI run, or the chapter changed, while this call ran. Nothing more was changed.');
  if (stoppedUntilQuiet) throw new ToolError(STOPPED);
}

// The run a write joins: the one going on, or a new one.
function runForWrite(door, since) {
  guard(since);
  if (!app.chapterRef || !app.pages.length) throw new ToolError('no chapter is open in the app');
  if (current?.active && !pinned(current)) {
    endRun();
    throw new ToolError('the chapter changed in the app, so the run ended. Ask the user before going on.');
  }
  return current?.active ? current : begin(door);
}

// A window opened for an agent shows what the agent does: each write turns it
// to the page written. The user's own window stays where the user put it.
let followWrites = false;
export function followWritesOnScreen(on) {
  followWrites = !!on;
}

function showWritten(pages) {
  if (!followWrites) return;
  const i = app.pages.indexOf(pages?.[0]);
  if (i >= 0 && i !== app.pageIndex) gotoPage(i);
}

// The context a tool's `run` gets (registry.js). `write(pages, fn)` is the one
// way a tool changes the document: it checks the run may write, keeps each
// page before its first change, and runs `fn` - synchronous, store calls
// only - with its history folded into the run's group on each page.
export function callContext(door) {
  const since = epoch;
  return {
    door,
    // For a write that is not chapter data (Settings): the same refusals.
    guard: () => guard(since),
    write(pages, fn) {
      const run = runForWrite(door, since);
      for (const p of pages ?? []) {
        if (p && !run.kept.has(p.id)) run.kept.set(p.id, keep(p));
      }
      // The user's own edit still settling is recorded now, as theirs, before
      // the run's group opens.
      settleEdits();
      const out = inRun(run.id, () => quietly(fn));
      run.edits++;
      sync();
      showWritten(pages);
      return out;
    },
    // The series record is part of a run too: the guide (`guide`,
    // `lettering`) and the tag registry beside it (`tag`, `lettering`). Each
    // part the run changes - a guide key, a tag, a tag size - is kept as it
    // was before the run first changed it, so Revert puts back those and
    // leaves the user's own changes to the rest, made since, alone.
    writeGuide(fn) {
      const run = runForWrite(door, since);
      if (!guideBound()) throw new ToolError('no series is open, so there is no guide to change');
      const guidePre = snapshotGuide();
      const tagsPre = snapshotTags();
      try {
        const out = quietly(fn);
        run.edits++;
        return out;
      } finally {
        // Kept even when `fn` threw halfway: what it did change, Revert undoes.
        const guideNow = snapshotGuide();
        for (const [k, v] of Object.entries(guidePre)) {
          if (!Object.hasOwn(run.guideBefore, k) && JSON.stringify(v) !== JSON.stringify(guideNow[k])) run.guideBefore[k] = v;
        }
        keepTagChanges(run.tagsBefore, tagsPre, snapshotTags());
        sync();
      }
    },
    // A long tool (detection, the chapter placer) asks between its steps.
    stillPinned() {
      if (since !== epoch || stoppedUntilQuiet) return false;
      return !current?.active || pinned(current);
    },
  };
}

// Every page the run touched back as it was before the run, one undo step per
// page, and the guide too when the run changed it. Allowed after the run ended,
// and over edits made since, until another run begins or the chapter changes.
export function revertRun() {
  const run = current;
  if (!run || run.seq !== chapterOpenSeq()) {
    sync();
    return 0;
  }
  epoch++;
  if (run.active) endRun();
  settleEdits();
  let n = 0;
  for (const [pageId, kept] of run.kept) {
    const p = pageById(pageId);
    if (!p) continue;
    const before = keep(p);
    const after = { ...kept };
    // The detection rides along only when the run changed it.
    if (JSON.stringify(before.detect) === JSON.stringify(kept.detect)) {
      delete before.detect;
      delete after.detect;
    }
    recordEdit({ t: 'restore', pageId, before, after });
    p.boxes = structuredClone(kept.boxes);
    p.lines = structuredClone(kept.lines);
    p.activeLineN = kept.activeLineN;
    if ('detect' in after) p.detect = after.detect ? structuredClone(after.detect) : null;
    n++;
  }
  if (Object.keys(run.guideBefore).length) restoreGuide({ ...snapshotGuide(), ...run.guideBefore });
  restoreTagChanges(run.tagsBefore);
  if (n) markUnsaved();
  current = null;
  sync();
  toast(n ? `Reverted the AI run on ${n} page${n === 1 ? '' : 's'} - Undo on each page brings it back` : 'Reverted the AI run');
  return n;
}

// Test seam.
export function __resetRun() {
  clearTimeout(idleT);
  clearTimeout(quietT);
  idleT = null;
  quietT = null;
  quiet = false;
  current = null;
  stoppedUntilQuiet = false;
  epoch = 0;
  sync();
}
