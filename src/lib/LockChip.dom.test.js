import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import LockChip from './LockChip.svelte';
import { app, loadProjectPages, page, boxLocked } from './store.svelte.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// The padlock on a locked box: upright, and one click unlocks it
// ===========================================================================

function mount(rotation = 0) {
  app.chapterRef = null;
  loadProjectPages([
    {
      id: 1, w: 800, h: 1200, lines: [],
      boxes: [{
        id: 'b', lineN: null, text: 'RIIISE...', x: 100, y: 100, w: 220, h: 60,
        style: normalizeStyle({ ...defaultStyle(), size: 40, rotation }),
        locked: true,
      }],
    },
  ]);
  const box = page().boxes[0];
  const view = render(LockChip, { box });
  return { box, view };
}

afterEach(() => {
  cleanup();
  loadProjectPages([]);
});

describe('the lock chip', () => {
  it('stands upright on a turned box, where a padlock on its side read as a cup', () => {
    const { view } = mount(-84);
    expect(view.container.querySelector('.lock-chip').getAttribute('style')).toContain('rotate(84deg)');
  });

  it('is not turned on a box that is not', () => {
    const { view } = mount();
    expect(view.container.querySelector('.lock-chip').getAttribute('style') ?? '').not.toContain('rotate');
  });

  it('unlocks the box in one click, with no menu', async () => {
    const { box, view } = mount();
    const chip = view.container.querySelector('.lock-chip');
    expect(chip.getAttribute('title')).toContain('click to unlock');
    chip.click();
    await tick();
    expect(boxLocked(box)).toBe(false);
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
  });
});
