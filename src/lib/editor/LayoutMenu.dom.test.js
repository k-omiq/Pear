// The rail's Layout menu: drawn on top of everything but modals, and with no
// Translate layout in general use.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import LayoutMenu from './LayoutMenu.svelte';
import { app, loadProjectPages } from '../store.svelte.js';
import { prefs } from '../prefs.svelte.js';
import { setLayouts } from '../layouts.svelte.js';

let usage;
let anchor;
beforeEach(() => {
  usage = prefs.usage;
  anchor = document.createElement('button');
  document.body.appendChild(anchor);
  app.chapterMode = 'typeset';
  setLayouts(null);
  loadProjectPages([{ id: 1, w: 800, h: 1200, boxes: [], lines: [] }]);
});
afterEach(() => {
  cleanup();
  anchor.remove();
  prefs.usage = usage;
  loadProjectPages([]);
  setLayouts(null);
});

const names = () => [...document.querySelectorAll('.lay-menu .lay-row .lay-text > span:first-child')].map((e) => e.textContent);

it('opens on the body, fixed beside its button, above the dock and the panels', async () => {
  const view = render(LayoutMenu, { props: { anchor, onClose: () => {} } });
  await tick();
  const menu = document.querySelector('.lay-menu');
  expect(menu).not.toBeNull();
  // Out of the rail (z 21) and of the editor's container.
  expect(menu.parentElement).toBe(document.body);
  expect(view.container.contains(menu)).toBe(false);
  // Placed from its button (the stacking itself is CSS, checked in the browser).
  expect(menu.style.left).toMatch(/px$/);
  expect(menu.style.top).toMatch(/px$/);
  view.unmount();
  expect(document.querySelector('.lay-menu')).toBeNull();
});

it('has no Translate layout in general use, unless the chapter is a translate one', async () => {
  prefs.usage = 'comics';
  render(LayoutMenu, { props: { anchor, onClose: () => {} } });
  await tick();
  expect(names()).toEqual(['Translate', 'Typeset', 'Custom', 'Typesetting tools']);
  cleanup();
  prefs.usage = 'general';
  render(LayoutMenu, { props: { anchor, onClose: () => {} } });
  await tick();
  expect(names()).toEqual(['Typeset', 'Custom', 'Typesetting tools']);
  cleanup();
  app.chapterMode = 'translate';
  render(LayoutMenu, { props: { anchor, onClose: () => {} } });
  await tick();
  expect(names()[0]).toBe('Translate');
});
