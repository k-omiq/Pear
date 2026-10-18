import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import LockChip from './LockChip.svelte';
import { app, loadProjectPages, page } from './store.svelte.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// The lock chip says what is locked, and lets each lock go by itself
// ===========================================================================

const NONE = { size: false, width: false, height: false, pos: false, breaks: false };

function mount(locks, rotation = 0) {
  app.chapterRef = null;
  loadProjectPages([
    {
      id: 1, w: 800, h: 1200, lines: [],
      boxes: [{
        id: 'b', lineN: null, text: 'RIIISE...', x: 100, y: 100, w: 220, h: 60,
        style: normalizeStyle({ ...defaultStyle(), size: 40, rotation }),
        auto: { on: true, refSize: 40, locks: { ...NONE, ...locks }, status: 'ok' },
      }],
    },
  ]);
  const box = page().boxes[0];
  const view = render(LockChip, { box });
  return { box, view };
}

async function menu(view) {
  view.container.querySelector('.lock-chip').click();
  await tick();
  return [...view.container.querySelectorAll('.lock-menu [role="menuitem"]')].map((el) => el.textContent.trim());
}

afterEach(() => {
  cleanup();
  loadProjectPages([]);
});

describe('the lock chip', () => {
  it('stands upright on a turned box, where a padlock on its side read as a cup', () => {
    const { view } = mount({ width: true, height: true, pos: true }, -84);
    expect(view.container.querySelector('.lock-chip-wrap').getAttribute('style')).toContain('rotate(84deg)');
  });

  it('is not turned on a box that is not', () => {
    const { view } = mount({ width: true });
    expect(view.container.querySelector('.lock-chip-wrap').getAttribute('style') ?? '').not.toContain('rotate');
  });

  it('offers one Unlock for each lock that is on, and Unlock all', async () => {
    const { view } = mount({ width: true, height: true, pos: true });
    expect(view.container.querySelector('.lock-chip').getAttribute('title')).toContain('Locked: width, height, position');
    expect(await menu(view)).toEqual(['Unlock width', 'Unlock height', 'Unlock position', 'Unlock all', 'Lock layout']);
  });

  it('lets the height go by itself', async () => {
    const { box, view } = mount({ width: true, height: true });
    await menu(view);
    [...view.container.querySelectorAll('.lock-menu [role="menuitem"]')].find((el) => el.textContent.includes('height')).click();
    await tick();
    expect({ ...box.auto.locks }).toEqual({ ...NONE, width: true });
  });

  it('calls held lines alone line breaks, not a locked layout', async () => {
    const { view } = mount({ breaks: true });
    const chip = view.container.querySelector('.lock-chip');
    expect(chip.classList.contains('layout')).toBe(false);
    expect(chip.getAttribute('title')).toContain('Locked: line breaks');
    expect(await menu(view)).toEqual(['Unlock line breaks', 'Lock layout']);
  });

  it('calls the four layout locks a locked layout', async () => {
    const { view } = mount({ size: true, width: true, pos: true, breaks: true });
    const chip = view.container.querySelector('.lock-chip');
    expect(chip.classList.contains('layout')).toBe(true);
    expect(chip.getAttribute('title')).toContain('Layout locked');
    expect(await menu(view)).toEqual(['Unlock all']);
  });
});
