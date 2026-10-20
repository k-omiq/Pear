import { describe, it, expect, beforeEach, vi } from 'vitest';

// ===========================================================================
// Locks
// ===========================================================================
// Two kinds, and this proves both. The user's lock (`box.locked`): one lock
// that holds everything - nothing moves, sizes, restyles or fits the box until
// it is unlocked - set by the keyboard, the box menu, the Inspector and the
// Bulk panel, each press one undo step. And the solver's locks (`auto.locks`,
// FIT-5), which the agent's tools set and clear: which each command touches,
// one undo step that puts them back exactly, and a manual box left alone.
//
// `canMeasure` is granted for the tests that run a fit, as autofit.test.js
// grants it: the stand-in metric is deterministic.
vi.mock('./measure.js', async (importOriginal) => ({
  ...(await importOriginal()),
  canMeasure: () => true,
}));

const {
  app,
  page,
  loadProjectPages,
  selectBox,
  openBulk,
  closeBulk,
  toggleBulkTarget,
  boxLocks,
  lockableBox,
  setBoxLocks,
  unlockBoxes,
  boxLocked,
  setBoxLocked,
  toggleBoxLock,
  lockBulkTargets,
  refitBalloon,
  resizeBox,
  nudgeBox,
  deleteBox,
  beginEdit,
  editBoxes,
} = await import('./store.svelte.js');
const hist = await import('./editor/history.svelte.js');

const NONE = { size: false, width: false, height: false, pos: false, breaks: false };
const auto = (locks = {}, refSize = 30) => ({ on: true, refSize, locks: { ...NONE, ...locks }, status: 'ok' });
const box = (id, extra = {}) => ({
  id,
  lineN: null,
  text: 'SOME WORDS TO SET',
  x: 100,
  y: 100,
  w: 120,
  h: 80,
  style: { size: 24 },
  fit: null,
  ...extra,
});

const doc = () => [
  {
    id: 1,
    w: 800,
    h: 1200,
    lines: [],
    boxes: [
      box('b1', { auto: auto({ size: true, width: true }) }),
      box('b2', { auto: auto({ width: true }) }),
      box('b3', { auto: auto() }),
      // Hand-drawn ink makes a box manual, whatever its record says.
      box('ink', {
        auto: auto({ size: true }),
        style: { size: 24, ink: { on: true, strokes: [{ pts: [[0, 0, 1], [10, 10, 1]], size: 4 }] } },
      }),
      // Sizing switched off: manual too.
      box('off', { auto: { ...auto({ width: true }), on: false } }),
    ],
  },
  {
    id: 2,
    w: 800,
    h: 1200,
    lines: [],
    boxes: [box('c1', { auto: auto({ size: true }) }), box('c2', { auto: auto({ width: true, pos: true }) })],
  },
];

const byId = (id) => app.pages.flatMap((p) => p.boxes).find((b) => b.id === id);
const locksOf = (id) => ({ ...byId(id).auto.locks });
const undoDepth = () => hist.peekStack().undo.length;

beforeEach(() => {
  app.chapterRef = null;
  closeBulk();
  hist.initHistory();
  loadProjectPages(doc());
  hist.resetHistory();
});

describe('the lock', () => {
  it('is on only where it was set, and is saved with the box', () => {
    expect(boxLocked(byId('b1'))).toBe(false);
    expect(setBoxLocked('b1', true)).toBe(1);
    expect(boxLocked(byId('b1'))).toBe(true);
    const saved = JSON.parse(JSON.stringify(app.pages));
    expect(saved[0].boxes.find((b) => b.id === 'b1').locked).toBe(true);
    expect(saved[0].boxes.find((b) => b.id === 'b2')).not.toHaveProperty('locked');
    loadProjectPages(saved);
    expect(boxLocked(byId('b1'))).toBe(true);
    expect(boxLocked(byId('b2'))).toBe(false);
  });

  it('locks any box, a manual one too', () => {
    expect(setBoxLocked(['ink', 'off'], true)).toBe(2);
    expect(boxLocked(byId('ink'))).toBe(true);
    expect(boxLocked(byId('off'))).toBe(true);
  });

  it('leaves the solver locks as they were', () => {
    setBoxLocked('b1', true);
    expect(locksOf('b1')).toEqual({ ...NONE, size: true, width: true });
  });

  it('holds the box: no resize, move, delete, typing, restyle or refit', () => {
    setBoxLocked('b3', true);
    const b = byId('b3');
    const geom = () => [b.x, b.y, b.w, b.h, b.style.size];
    const was = geom();
    expect(resizeBox(1, 'b3', { w: 300, h: 200 })).toBeNull();
    selectBox('b3');
    expect(nudgeBox('b3', 10, 0)).toBe(false);
    refitBalloon('b3', page());
    expect(geom()).toEqual(was);
    deleteBox('b3');
    expect(byId('b3')).toBeTruthy();
    beginEdit('b3');
    expect(app.editingId).toBeNull();
    expect(editBoxes([{ page: page(), box: b }], (x) => void (x.style.size = 40))).toEqual([]);
    expect(b.style.size).toBe(24);
    expect(undoDepth()).toBe(1);
  });

  it('is one undo step each way', () => {
    setBoxLocked('b2', true);
    setBoxLocked('b2', false);
    expect(undoDepth()).toBe(2);
    hist.undo();
    expect(boxLocked(byId('b2'))).toBe(true);
    hist.undo();
    expect(boxLocked(byId('b2'))).toBe(false);
    hist.redo();
    expect(boxLocked(byId('b2'))).toBe(true);
  });

  it('records nothing when nothing changes', () => {
    expect(setBoxLocked('b2', false)).toBe(0);
    expect(undoDepth()).toBe(0);
  });

  it('switches from the keyboard', () => {
    selectBox('b1');
    expect(toggleBoxLock()).toBe(true);
    expect(boxLocked(byId('b1'))).toBe(true);
    expect(toggleBoxLock()).toBe(true);
    expect(boxLocked(byId('b1'))).toBe(false);
    expect(undoDepth()).toBe(2);
  });

  it('is set and let go from the Bulk panel, one step per page', () => {
    openBulk();
    for (const id of ['b1', 'ink', 'c1']) toggleBulkTarget(id);
    expect(lockBulkTargets(true)).toBe(3);
    expect(['b1', 'ink', 'c1'].every((id) => boxLocked(byId(id)))).toBe(true);
    expect(hist.peekStack().undo.map((e) => [e.t, e.pageId, e.items.length])).toEqual([
      ['locks', 1, 2],
      ['locks', 2, 1],
    ]);
    // The panel stays open: a lock is not the style it is there to apply.
    expect(app.bulk.active).toBe(true);
    expect(lockBulkTargets(false)).toBe(3);
    expect(['b1', 'ink', 'c1'].some((id) => boxLocked(byId(id)))).toBe(false);
  });

  it('does nothing from the Bulk panel with nothing picked', () => {
    openBulk();
    expect(lockBulkTargets(true)).toBe(0);
    expect(undoDepth()).toBe(0);
  });
});

describe('the solver locks', () => {
  it('reads only the locks a box has on, and nothing on a manual box', () => {
    expect(boxLocks(byId('b1'))).toEqual({ size: true, width: true });
    expect(boxLocks(byId('b2'))).toEqual({ width: true });
    expect(boxLocks(byId('b3'))).toBeNull();
    expect(lockableBox(byId('ink'))).toBe(false);
    expect(boxLocks(byId('ink'))).toBeNull();
    expect(lockableBox(byId('off'))).toBe(false);
    expect(boxLocks(byId('off'))).toBeNull();
  });

  it('sets a lock, and leaves the rest as they are', () => {
    expect(setBoxLocks('b3', { width: true })).toBe(1);
    expect(locksOf('b3')).toEqual({ ...NONE, width: true });
  });

  it('unlocks one, or all', () => {
    expect(unlockBoxes('b1', 'size')).toBe(1);
    expect(locksOf('b1')).toEqual({ ...NONE, width: true });
    expect(unlockBoxes('c2', 'all')).toBe(1);
    expect(locksOf('c2')).toEqual(NONE);
  });

  // The solver's size lock holds the reference size: turned on by itself at
  // 24 on a box whose reference is 30, the next edit set the text at 30.
  it('holds the size on the box when the size lock is turned on by itself', () => {
    expect(setBoxLocks('b3', { size: true })).toBe(1);
    expect(byId('b3').auto.refSize).toBe(24);
    hist.undo();
    expect(byId('b3').auto.refSize).toBe(30);
  });

  it('lets the breaks go with the size or the width, which they hold', () => {
    setBoxLocks('b3', { size: true, width: true, breaks: true });
    unlockBoxes('b3', 'size');
    expect(locksOf('b3')).toEqual({ ...NONE, width: true });
  });

  it('records nothing and leaves a manual box alone', () => {
    expect(unlockBoxes('b3', 'all')).toBe(0);
    expect(unlockBoxes(['ink', 'off'], 'all')).toBe(0);
    expect(locksOf('ink')).toEqual({ ...NONE, size: true });
    expect(undoDepth()).toBe(0);
  });

  it('puts the locks back exactly on undo, and selects the box', () => {
    selectBox('b2');
    unlockBoxes('b1', 'size');
    selectBox('b2');
    hist.undo();
    expect(locksOf('b1')).toEqual({ ...NONE, size: true, width: true });
    expect(app.selectedId).toBe('b1');
  });
});
