import { describe, it, expect } from 'vitest';
import { breaksFor, brokenLines, breaksKey } from './measure.js';

// Kept line breaks: offsets into the text, keyed to the text and face. The
// lines come back as they went in; a line that ends inside a word gets back the
// hyphen the breaker drew; a key for other text gives no lines.
const style = { font: 'Comic Neue', bold: true, italic: false, letterSpacing: 0 };

describe('kept line breaks', () => {
  it('round-trips plain lines', () => {
    const text = 'WE CAN STILL CATCH THE LAST TRAIN';
    const lines = ['WE CAN', 'STILL CATCH', 'THE LAST TRAIN'];
    const b = breaksFor(text, style, 18, lines);
    expect(b.at).toEqual([0, 7, 19]);
    expect(brokenLines(text, style, 18, b)).toEqual(lines);
  });

  it('gives back an added hyphen, and keeps one the text has', () => {
    const text = 'SO SOCIALLY AWK-WARD';
    const b = breaksFor(text, style, 18, ['SO SOCI-', 'ALLY AWK-', 'WARD']);
    expect(brokenLines(text, style, 18, b)).toEqual(['SO SOCI-', 'ALLY AWK-', 'WARD']);
  });

  it('refuses lines that are not the text', () => {
    expect(breaksFor('ONE TWO', style, 18, ['ONE', 'THREE'])).toBeNull();
    expect(breaksFor('ONE TWO', style, 18, ['ONE'])).toBeNull();
  });

  it('gives no lines for another text, face or size', () => {
    const b = breaksFor('ONE TWO', style, 18, ['ONE', 'TWO']);
    expect(brokenLines('ONE TWO!', style, 18, b)).toBeNull();
    expect(brokenLines('ONE TWO', { ...style, font: 'Bangers' }, 18, b)).toBeNull();
    expect(brokenLines('ONE TWO', style, 17, b)).toBeNull();
    expect(brokenLines('ONE TWO', style, 18, null)).toBeNull();
    expect(b.key).toBe(breaksKey('ONE TWO', style, 18));
  });
});
