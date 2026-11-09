import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Canvas from './Canvas.svelte';
import { app, loadProjectPages } from '../store.svelte.js';
import { installFakeCanvas } from '../../test/fake-canvas.js';

// A page's <img> that leaves the editor gives its picture back first
// (`releaseLeavingImages`): WebKit keeps the bytes of every page an unmounted <img>
// loaded until the element itself is gone, which is a chapter's worth.

let restoreCanvas;
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterAll(() => {
  vi.unstubAllGlobals();
  restoreCanvas();
});
afterEach(() => {
  cleanup();
  loadProjectPages([]);
});

describe('a page image leaving the editor', () => {
  it('has its src taken off, so the picture is not held', async () => {
    app.projectLayout = 'pages';
    loadProjectPages(Array.from({ length: 8 }, (_, i) => ({ id: i + 1, w: 800, h: 1200, raw: `asset://localhost/p${i}.png`, lines: [], boxes: [] })));
    app.pageIndex = 0;
    const view = render(Canvas, { props: { onReady: () => {} } });
    await tick();
    const first = view.container.querySelector('.page-frame[data-page-id="1"] img.page-img');
    expect(first?.getAttribute('src')).toBe('asset://localhost/p0.png');
    // WebKit lets the bytes go only for an element still in the document.
    const cleared = [];
    const remove = first.removeAttribute.bind(first);
    first.removeAttribute = (name) => (cleared.push([name, first.isConnected]), remove(name));
    app.pageIndex = 7;
    await vi.waitFor(() => expect(first.isConnected).toBe(false));
    expect(first.hasAttribute('src')).toBe(false);
    expect(cleared).toEqual([['src', true]]);
    // The page on screen keeps its picture.
    const shown = view.container.querySelector('.page-frame[data-page-id="8"] img.page-img');
    expect(shown?.getAttribute('src')).toBe('asset://localhost/p7.png');
  });
});
