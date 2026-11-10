import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';

// The first-run setup, mounted over the real preferences. The opener is a
// stub: the tests check which link each button asks for, not the browser.
vi.mock('../open-external.js', () => ({ openExternal: vi.fn(async () => {}) }));

const { default: Onboarding } = await import('./Onboarding.svelte');
const { onboarding, offerOnboarding, offerOnboardingAtBoot, finishOnboarding } = await import('./onboarding.svelte.js');
const { prefs, setPref } = await import('../prefs.svelte.js');
const { theme, setTheme } = await import('../theme.svelte.js');
const { openExternal } = await import('../open-external.js');

beforeEach(() => {
  // A fresh install: never set up, and the factory usage.
  setPref('onboarded', false);
  setPref('usage', 'comics');
  setPref('defaultChapterMode', 'translate');
  setPref('defaultOcrLanguage', 'ja');
  setTheme('system');
});

afterEach(() => {
  cleanup();
  onboarding.open = false;
  vi.clearAllMocks();
});

/** Open the setup the way a first launch does, on one of its steps. */
function open(step = 'welcome') {
  expect(offerOnboarding()).toBe(true);
  onboarding.step = step;
  return render(Onboarding);
}

const heading = (view) => view.getByRole('heading', { level: 1 });
const press = (view, name) => fireEvent.click(view.getByRole('button', { name }));

describe('leaving early', () => {
  it('Skip setup closes it from any step and records that it was offered', async () => {
    const view = open('scope');
    await press(view, 'Skip setup');
    expect(onboarding.open).toBe(false);
    expect(prefs.onboarded).toBe(true);
    // No usage was picked, so the factory one stands and nothing is hidden.
    expect(prefs.usage).toBe('comics');

    // The next launch does not ask again; Settings still can, from the top.
    expect(offerOnboarding()).toBe(false);
    expect(onboarding.open).toBe(false);
    expect(offerOnboarding({ force: true })).toBe(true);
    expect(onboarding.step).toBe('welcome');
  });

  it('Escape closes it the same way, even from the welcome step', async () => {
    const view = open('welcome');
    await waitFor(() => expect(document.activeElement).toBe(heading(view)));
    await fireEvent.keyDown(heading(view), { key: 'Escape' });
    expect(onboarding.open).toBe(false);
    expect(prefs.onboarded).toBe(true);
    expect(prefs.usage).toBe('comics');
  });

  it('keeps a usage picked before the skip', async () => {
    const view = open('usage');
    await fireEvent.click(view.getByRole('radio', { name: /General use/ }));
    await press(view, 'Skip setup');
    expect(prefs.usage).toBe('general');
    expect(prefs.onboarded).toBe(true);
  });
});

describe('when it is offered', () => {
  it('an install that is already set up is not offered it', () => {
    setPref('onboarded', true);
    expect(offerOnboardingAtBoot({ label: 'main', agent: false })).toBe(false);
    expect(onboarding.open).toBe(false);
  });

  it('a fresh install is offered it in the main window', () => {
    expect(offerOnboardingAtBoot({ label: 'main', agent: false })).toBe(true);
    expect(onboarding).toMatchObject({ open: true, step: 'welcome', usage: null });
  });

  it('an agent window is never offered it, and leaves it for the main window', () => {
    expect(offerOnboardingAtBoot({ label: 'agent-1', agent: true, chapter: 'p/c' })).toBe(false);
    expect(onboarding.open).toBe(false);
    expect(prefs.onboarded).toBe(false);
  });

  it('run again, the usage on record starts picked', () => {
    setPref('usage', 'general');
    finishOnboarding();
    expect(offerOnboarding({ force: true })).toBe(true);
    expect(onboarding.usage).toBe('general');
  });
});

describe('the two paths', () => {
  /** Walk from the welcome step to the usage step with the mouse. */
  async function toUsage(view) {
    await press(view, 'Set up the app');
    expect(heading(view).textContent).toBe('Pick a theme');
    await press(view, 'Continue');
    expect(heading(view).textContent).toBe('Pear changes text, not pictures');
    await press(view, 'Continue');
    expect(heading(view).textContent).toBe('What will you use Pear for?');
  }

  it('comics has the detection step, with Translate preselected, and six steps', async () => {
    const view = open();
    expect(view.queryByRole('progressbar')).toBeNull();
    await toUsage(view);

    // Continue waits for a pick.
    const next = /** @type {HTMLButtonElement} */ (view.getByRole('button', { name: 'Continue' }));
    expect(next.disabled).toBe(true);
    await fireEvent.click(view.getByRole('radio', { name: /^Comics/ }));
    expect(prefs.usage).toBe('comics');
    expect(next.disabled).toBe(false);
    const bar = view.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemax')).toBe('6');
    expect(bar.getAttribute('aria-valuetext')).toBe('Step 4 of 6');

    await press(view, 'Continue');
    expect(heading(view).textContent).toBe('Detection and OCR');
    expect(view.getByRole('note').textContent).toContain('These models are not a translator.');
    const modes = view.getByRole('group', { name: 'New chapters start as' });
    expect([...modes.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Translate', 'Typeset']);
    expect(view.getByRole('button', { name: 'Translate' }).getAttribute('aria-pressed')).toBe('true');
    expect(view.getByRole('button', { name: 'Typeset' }).getAttribute('aria-pressed')).toBe('false');
    expect(view.getByText('Translate opens the page beside a typing pane. Typeset goes straight to lettering. You can change this in Settings.')).toBeTruthy();
    expect(view.getByText('Models download the first time Detect runs (about 170 MB). A Translate chapter runs it when it first opens.')).toBeTruthy();

    await press(view, 'Korean');
    expect(prefs.defaultOcrLanguage).toBe('ko');
    expect(view.getByRole('radiogroup', { name: 'Korean text reader' })).toBeTruthy();
    await press(view, 'Typeset');
    expect(prefs.defaultChapterMode).toBe('typeset');

    await press(view, 'Continue');
    expect(heading(view).textContent).toBe('Join the community');
    expect(view.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('Step 6 of 6');
    await press(view, 'Finish');
    expect(onboarding.open).toBe(false);
    expect(prefs.onboarded).toBe(true);
    expect(prefs.usage).toBe('comics');
  });

  it('general use skips the detection step and has five steps', async () => {
    const view = open();
    await toUsage(view);
    await fireEvent.click(view.getByRole('radio', { name: /General use/ }));
    expect(prefs.usage).toBe('general');
    expect(view.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('5');

    await press(view, 'Continue');
    expect(heading(view).textContent).toBe('Join the community');
    expect(view.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('Step 5 of 5');

    // Back goes to the usage step, not to a detection step it never showed.
    await press(view, 'Back');
    expect(heading(view).textContent).toBe('What will you use Pear for?');
    expect(/** @type {HTMLInputElement} */ (view.getByRole('radio', { name: /General use/ })).checked).toBe(true);
  });
});

describe('the steps', () => {
  it('applies a theme the moment it is picked', async () => {
    const view = open('theme');
    await fireEvent.click(view.getByRole('radio', { name: /Jade/ }));
    expect(theme.mode).toBe('jade');
  });

  it('opens each outside link through the opener', async () => {
    let view = open('welcome');
    await fireEvent.click(view.getByRole('link', { name: 'GitHub' }));
    expect(openExternal).toHaveBeenLastCalledWith('https://github.com/komiq-cc/manga-typesetter');
    cleanup();

    view = open('scope');
    await fireEvent.click(view.getByRole('link', { name: 'Manga Cleaner' }));
    expect(openExternal).toHaveBeenLastCalledWith('https://cleaner.komiq.cc');
    cleanup();

    view = open('community');
    await fireEvent.click(view.getByRole('link', { name: /Join our Discord server/ }));
    expect(openExternal).toHaveBeenLastCalledWith('https://discord.gg/3ueKc9PaX7');
  });
});

describe('the keyboard', () => {
  it('moves focus to each step heading, and Enter there presses the primary button', async () => {
    const view = open('welcome');
    await waitFor(() => expect(document.activeElement).toBe(heading(view)));
    await fireEvent.keyDown(heading(view), { key: 'Enter' });
    expect(onboarding.step).toBe('theme');
    await waitFor(() => expect(document.activeElement).toBe(heading(view)));
    expect(heading(view).textContent).toBe('Pick a theme');

    // Not a repeat, not with a modifier, not while composing.
    await fireEvent.keyDown(heading(view), { key: 'Enter', repeat: true });
    await fireEvent.keyDown(heading(view), { key: 'Enter', shiftKey: true });
    await fireEvent.keyDown(heading(view), { key: 'Enter', isComposing: true });
    expect(onboarding.step).toBe('theme');
  });

  it('does not pass the usage step on Enter without a pick', async () => {
    const view = open('usage');
    await waitFor(() => expect(document.activeElement).toBe(heading(view)));
    await fireEvent.keyDown(heading(view), { key: 'Enter' });
    expect(onboarding.step).toBe('usage');
  });

  it('keeps Tab inside the screen', async () => {
    const view = open('scope');
    await waitFor(() => expect(document.activeElement).toBe(heading(view)));
    // jsdom lays nothing out, so every element would count as hidden; give the
    // buttons a parent the way a real layout does.
    for (const el of view.container.querySelectorAll('a, button')) {
      Object.defineProperty(el, 'offsetParent', { get: () => document.body, configurable: true });
    }
    const last = view.getByRole('button', { name: 'Continue' });
    last.focus();
    await fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(view.getByRole('link', { name: 'Manga Cleaner' }));
    await fireEvent.keyDown(document.activeElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('is a modal dialog with a progress bar that says where you are', () => {
    const view = open('theme');
    const dialog = view.getByRole('dialog', { name: 'Set up Pear' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const bar = view.getByRole('progressbar', { name: 'Setup progress' });
    expect(bar.getAttribute('aria-valuetext')).toBe('Step 2 of 5');
  });
});
