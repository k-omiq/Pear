// The check reads the text against its bubble outline with real metrics: a
// block hanging past the outline is `outside`, by side and px; the same block
// set inside is not flagged.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../library.svelte.js', () => ({ chapterOpenSeq: () => 1 }));

const { app, loadProjectPages } = await import('../../store.svelte.js');
const { normalizeStyle } = await import('../../data.js');
const { setTypesetEnabled } = await import('../../measure.js');
const { checksFor, fitsOf } = await import('./check.js');
const { selectBoxes } = await import('../select.js');

const style = normalizeStyle({ font: 'Comic Neue', size: 18, bold: false, align: 'center', valign: 'middle', strokeEffects: [] });
const oval = { kind: 'ellipse', cx: 200, cy: 200, rx: 110, ry: 80 };
const box = (id, y) => ({ id, lineN: null, text: 'WE CAN STILL CATCH THE LAST TRAIN', x: 120, y, w: 160, h: 80, style, fit: oval, outline: { source: 'ring', confidence: 1, approved: null } });

beforeAll(() => setTypesetEnabled(true));
afterEach(() => loadProjectPages([]));

describe('check against the outline', () => {
  it('flags ink past the outline and passes ink inside it', () => {
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('in', 160), box('low', 250)] }]);
    const { matches } = selectBoxes({ pages: 'all' });
    const by = Object.fromEntries(checksFor(matches).map((p) => [p.id, p.issues.map((i) => i.kind)]));
    expect(by.in ?? []).not.toContain('outside');
    expect(by.low).toContain('outside');
    const fits = Object.fromEntries(fitsOf(matches).map((f) => [f.id, f]));
    expect(fits.in.inside).toBe(true);
    expect(fits.low.overflow.b).toBeGreaterThan(10);
    expect(fits.in.widths.length).toBe(fits.in.lines);
  });
});

describe('the glyph check', () => {
  it('names the letters a box\'s font has no glyph for, and passes a font that has them', () => {
    const text = (id, font) => ({ ...box(id, 160), fit: null, outline: undefined, text: 'LOVE YOU ♥ ☆', style: { ...style, font } });
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [text('comic', 'Comic Neue'), text('dejavu', 'DejaVu Sans')] }]);
    const { matches } = selectBoxes({ pages: 'all' });
    const by = Object.fromEntries(checksFor(matches).map((p) => [p.id, p.issues]));
    expect(by.comic.find((i) => i.kind === 'glyph')?.detail).toEqual({ font: 'Comic Neue', letters: ['♥', '☆'] });
    expect((by.dejavu ?? []).some((i) => i.kind === 'glyph')).toBe(false);
  });
});
