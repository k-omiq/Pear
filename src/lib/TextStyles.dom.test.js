import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// Settings ▸ Project ▸ Text styles: one list. Each kind of text with its
// font, the user's own styles under their kind, the characters' voices under
// Speech, and tags under no kind last.
const { default: TextStyles } = await import('./TextStyles.svelte');
const { app, loadProjectPages } = await import('./store.svelte.js');
const { bindTags, unbindTags, findTag } = await import('./tags.svelte.js');
const { bindGuide, unbindGuide } = await import('./guide.svelte.js');

const originalFonts = app.fonts;
beforeEach(() => {
  app.fonts = { user: [{ name: 'Anime Ace' }, { name: 'SSGirlKisser' }], builtin: [], system: [] };
  bindTags({ list: [
    { name: 'speech', style: { font: 'Anime Ace' } },
    { name: 'angry', kind: 'speech', style: { bold: true } },
    { name: 'flashback', kind: 'narration' },
    { name: 'radio' },
    { name: 'voice-mother', style: { font: 'SSGirlKisser' } },
  ] }, vi.fn());
  bindGuide({ glossary: [{ id: 'mom', source: 'ママ', target: 'Mother', character: true, tag: 'voice-mother' }] }, vi.fn());
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [] }]);
});
afterEach(() => {
  cleanup();
  loadProjectPages([]);
  unbindGuide();
  unbindTags();
  app.fonts = originalFonts;
});

// The rows' names, top to bottom.
const rows = (view) => [...view.container.querySelectorAll('.ts-row .ts-name > span:first-child')].map((e) => e.textContent.replace('↳', '> ').trim());

describe('Text styles', () => {
  it('lists each kind, with its voices and the user\'s styles under it, and loose tags last', () => {
    const view = render(TextStyles);
    const names = rows(view);
    const at = (n) => names.indexOf(n);
    expect(at('Main speech')).toBe(0);
    expect(names.slice(1, 3)).toEqual(['> Mother', '> angry']);
    expect(at('> flashback')).toBe(at('Narration') + 1);
    expect(names.at(-1)).toBe('> radio');
    // A voice is not listed again as a tag of its own.
    expect(names).not.toContain('> voice-mother');
    expect(view.getByLabelText('Main speech font').textContent.trim()).toBe('Anime Ace');
    expect(view.getByLabelText('Mother font').textContent.trim()).toBe('SSGirlKisser');
  });

  it('adds a style under a kind, and moves one under another', async () => {
    const view = render(TextStyles);
    await fireEvent.input(view.getByLabelText('New style name'), { target: { value: 'Whisper' } });
    await fireEvent.change(view.getByLabelText('Kind of the new style'), { target: { value: 'thought' } });
    await fireEvent.click(view.getByRole('button', { name: 'Add' }));
    await tick();
    expect(findTag('whisper').kind).toBe('thought');
    // Its form is open: put it under Side text and save.
    await fireEvent.change(view.getByLabelText('Under'), { target: { value: 'side' } });
    await fireEvent.click(view.getByRole('button', { name: 'Save' }));
    await tick();
    expect(findTag('whisper').kind).toBe('side');
    const names = rows(view);
    expect(names.indexOf('> whisper')).toBe(names.indexOf('Side text') + 1);
  });

  it('a font picked on a style row is that tag\'s font', async () => {
    const view = render(TextStyles);
    await fireEvent.click(view.getByLabelText('angry font'));
    await tick();
    const row = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === 'Anime Ace');
    await fireEvent.click(row);
    expect(findTag('angry').style).toEqual({ bold: true, font: 'Anime Ace' });
  });
});
