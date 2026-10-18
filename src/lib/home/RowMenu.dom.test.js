import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

const { default: RowMenu } = await import('./RowMenu.svelte');

afterEach(cleanup);

const items = [
  { id: 'open', label: 'Open' },
  { separator: true },
  { id: 'off', label: 'Not now', disabled: true },
  { id: 'delete', label: 'Delete chapter…', danger: true },
];

describe("a home row's … menu", () => {
  it('opens from its button and runs the picked item after closing', async () => {
    const onpick = vi.fn();
    const view = render(RowMenu, { items, label: 'Chapter 1 actions', onpick });
    const button = view.getByRole('button', { name: 'Chapter 1 actions' });
    expect(view.queryByRole('menu')).toBeNull();
    await fireEvent.click(button);
    await tick();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(view.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Open', 'Not now', 'Delete chapter…']);
    await fireEvent.click(view.getByRole('menuitem', { name: 'Delete chapter…' }));
    await tick();
    expect(view.queryByRole('menu')).toBeNull();
    expect(onpick).toHaveBeenCalledWith('delete');
  });

  it('closes on Escape without picking', async () => {
    const onpick = vi.fn();
    const view = render(RowMenu, { items, label: 'Chapter 1 actions', onpick });
    await fireEvent.click(view.getByRole('button', { name: 'Chapter 1 actions' }));
    await tick();
    await fireEvent.keyDown(window, { key: 'Escape' });
    await tick();
    expect(view.queryByRole('menu')).toBeNull();
    expect(onpick).not.toHaveBeenCalled();
  });

  it('skips disabled items with the arrow keys', async () => {
    const view = render(RowMenu, { items, label: 'Chapter 1 actions', onpick: () => {} });
    await fireEvent.click(view.getByRole('button', { name: 'Chapter 1 actions' }));
    await tick();
    const [open, , del] = view.getAllByRole('menuitem');
    open.focus();
    await fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(del);
  });
});
