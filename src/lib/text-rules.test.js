import { describe, it, expect } from 'vitest';
import { ruleBreaks, applyTextRules, textRuleEdits } from './text-rules.js';

const cases = [
  [{ dashes: 'ascii' }, 'Wait—no', 'Wait-no'],
  [{ dashes: 'em' }, 'Wait--no', 'Wait—no'],
  [{ dashes: 'em' }, 'Wait - no', 'Wait—no'],
  [{ ellipsis: 'dots' }, 'Well…', 'Well...'],
  [{ ellipsis: 'dots' }, 'Well. . .', 'Well...'],
  [{ ellipsis: 'char' }, 'Well...', 'Well…'],
];

describe('the text rules', () => {
  it('flags a line that breaks a rule, and the fix keeps it', () => {
    for (const [rules, bad, good] of cases) {
      expect(ruleBreaks(bad, rules).length).toBe(1);
      expect(applyTextRules(bad, rules)).toBe(good);
      expect(ruleBreaks(good, rules)).toEqual([]);
    }
  });

  it('checks nothing under keep, and leaves hyphenated words alone', () => {
    expect(ruleBreaks('Wait—no…', { dashes: 'keep', ellipsis: 'keep' })).toEqual([]);
    expect(ruleBreaks('A well-known half-elf', { dashes: 'em', ellipsis: 'char' })).toEqual([]);
    expect(applyTextRules('A well-known half-elf', { dashes: 'em', ellipsis: 'char' })).toBe('A well-known half-elf');
  });
});

describe('the text rules as edits', () => {
  it('are the same rules, one exact edit per change, each on the text the ones before left', () => {
    const rules = { dashes: 'em', ellipsis: 'char' };
    const text = 'Wait -- no... and - so. . . ok';
    let t = text;
    for (const e of textRuleEdits(text, rules)) t = t.slice(0, e.span[0]) + e.put + t.slice(e.span[1]);
    expect(t).toBe(applyTextRules(text, rules));
    expect(t).toBe('Wait — no… and—so… ok');
    // A spaced hyphen keeps the letter before it: only " - " is replaced.
    expect(textRuleEdits('a - b', { dashes: 'em' })).toEqual([{ span: [1, 4], put: '—' }]);
  });
});
