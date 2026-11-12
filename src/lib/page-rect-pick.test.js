// The one-shot rectangle on the page (page-rect-pick.svelte.js) and its first
// caller, the pattern pick, which must behave as it did before it shared it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageRectPick, PICK_MIN } from './page-rect-pick.svelte.js';
import { patternPick, startPatternPick, cancelPatternPick } from './pattern-pick.svelte.js';
import { app } from './store.svelte.js';

afterEach(() => {
  pageRectPick.cancel();
  cancelPatternPick();
});

describe('pageRectPick', () => {
  it('hands one sorted rect in page px to onDone, once, and then stands down', () => {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    pageRectPick.start({ hint: 'Drag a box', onDone, onCancel });
    expect([pageRectPick.active, pageRectPick.hint]).toEqual([true, 'Drag a box']);
    const pg = { id: 7 };
    pageRectPick.finish(pg, 120, 90, 20, 10);
    expect(onDone).toHaveBeenCalledWith([20, 10, 120, 90], pg);
    expect([pageRectPick.active, pageRectPick.hint]).toEqual([false, '']);
    pageRectPick.finish(pg, 0, 0, 50, 50);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it(`cancels a drag under ${PICK_MIN} px on either side, and an Escape`, () => {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    pageRectPick.start({ onDone, onCancel });
    pageRectPick.finish({}, 0, 0, PICK_MIN - 1, 100);
    expect(onCancel).toHaveBeenLastCalledWith('small');
    pageRectPick.start({ onDone, onCancel });
    expect(pageRectPick.cancel()).toBe(true);
    expect(onCancel).toHaveBeenLastCalledWith('escape');
    expect(pageRectPick.cancel()).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('tells a waiting pick it was replaced when another starts', () => {
    const first = vi.fn();
    const second = vi.fn();
    pageRectPick.start({ onCancel: first });
    pageRectPick.start({ onDone: second });
    expect(first).toHaveBeenCalledWith('replaced');
    pageRectPick.finish({}, 0, 0, 40, 40);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('the pattern pick, as a caller', () => {
  it('raises its flag and the layer together, and Escape lowers both', () => {
    startPatternPick(1, 'b1', 'pattern');
    expect([patternPick.active, pageRectPick.active]).toEqual([true, true]);
    expect(pageRectPick.hint).toBe('Drag over the tone to take it · Esc to cancel');
    pageRectPick.cancel();
    expect([patternPick.active, pageRectPick.active]).toEqual([false, false]);
  });

  it('says a click is too small to take a pattern from, as before', () => {
    startPatternPick(1, 'b1', 'pattern');
    pageRectPick.finish({ id: 1 }, 10, 10, 12, 12);
    expect(patternPick.active).toBe(false);
    expect(app.toast.msg).toBe('Drag a larger region to take a pattern from');
  });

  it('lets cancelPatternPick end its own pick and leave anyone else’s', () => {
    startPatternPick(1, 'b1', 'pattern');
    cancelPatternPick();
    expect(pageRectPick.active).toBe(false);
    pageRectPick.start({});
    cancelPatternPick();
    expect(pageRectPick.active).toBe(true);
  });
});
