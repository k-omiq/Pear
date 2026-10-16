import { describe, expect, it } from 'vitest';
import { ocrComparableKey, postProcessDetection } from './detect-post.js';

const line = (jp, box = [0, 0, 100, 100], extra = {}) => ({
  n: 9, type: 'dialogue', lang: 'ja', jp, en: '', box, vertical: true, font_size: 20, ...extra,
});
const page = (lines) => ({ img_width: 1000, img_height: 2000, panels: [[0, 0, 1000, 1000]], lines });
const process = (...lines) => postProcessDetection(page(lines)).lines;

describe('OCR comparison key', () => {
  it('folds compatibility characters and ignores whitespace, format controls and separators', () => {
    expect(ocrComparableKey('Ａ\u200b B\nＣ—-~∼〜～＿_·•∙⋅・‧')).toBe('ABC');
    expect(ocrComparableKey('ﾄﾞｷ ﾄﾞｷ')).toBe('ドキドキ');
  });

  it('preserves letters, digits, sound-length marks and other punctuation', () => {
    expect(ocrComparableKey('コーヒー１２!?')).toBe('コーヒー12!?');
    expect(ocrComparableKey('え!')).not.toBe(ocrComparableKey('え?'));
  });
});

describe('duplicate OCR regions', () => {
  it.each([false, true])('keeps the tighter box for the same normalized text (reversed: %s)', (reverse) => {
    const lines = [line('「はい　はい」', [0, 0, 100, 100]), line('「はいはい」', [10, 10, 60, 60])];
    if (reverse) lines.reverse();
    expect(process(...lines)).toEqual([{ ...lines.find((l) => l.box[0] === 10), n: 1 }]);
  });

  it('keeps the first of equal-sized identical regions', () => {
    expect(process(line('同じ', undefined, { font_size: 21 }), line('同じ'))).toEqual([
      line('同じ', undefined, { n: 1, font_size: 21 }),
    ]);
  });

  it.each([[65, 1], [64, 2]])('requires 65 percent coverage for identical readings (%s percent)', (overlap, count) => {
    expect(process(line('はい'), line('はい', [100 - overlap, 0, 200 - overlap, 100]))).toHaveLength(count);
  });

  it('keeps the same text in separate regions', () => {
    expect(process(line('はい'), line('はい', [200, 0, 300, 100]))).toHaveLength(2);
  });

  it('removes a nested fragment when the parent has the fuller reading', () => {
    expect(process(line('今日はいい天気ですね'), line('いい天気', [10, 10, 60, 60]))).toEqual([
      line('今日はいい天気ですね', undefined, { n: 1 }),
    ]);
  });

  it('keeps unrelated readings even when their boxes overlap', () => {
    expect(process(line('今日は'), line('明日は', [10, 10, 60, 60]))).toHaveLength(2);
  });

  it.each([[8, true], [7, false]])('replaces a parent when two children spell at least 80 percent (%s/10)', (length, replaces) => {
    const parent = line('あいうえおかきくけこ');
    const children = [line('あいうえ', [0, 0, 40, 40]), line(parent.jp.slice(4, length), [50, 50, 90, 90])];
    expect(process(parent, ...children).map((l) => l.jp)).toEqual(replaces ? children.map((l) => l.jp) : [parent.jp]);
  });

  it('does not count the same substring twice toward parent coverage', () => {
    expect(process(line('あいうえおかきくけこ'), line('あいうえ', [0, 0, 40, 40]), line('あいうえ', [50, 50, 90, 90])))
      .toEqual([line('あいうえおかきくけこ', undefined, { n: 1 })]);
  });

  it('does not count a single child as a replacement for the parent', () => {
    expect(process(line('あいうえお'), line('あいうえ', [0, 0, 40, 40]))).toHaveLength(1);
    expect(process(line('あいうえお'), line('あいうえ', [0, 0, 40, 40]))[0].jp).toBe('あいうえお');
  });

  it('requires a child to be smaller than 85 percent of the parent', () => {
    expect(process(line('あいうえお'), line('あいうえ', [0, 0, 85, 100]))).toHaveLength(2);
  });

  it('strips OCR markup for comparison and drops empty regions on kept lettering', () => {
    expect(process(line('<b>今日</b>'), line('今日', [10, 10, 60, 60]), line('', [20, 20, 40, 40])))
      .toEqual([line('今日', [10, 10, 60, 60], { n: 1 })]);
  });

  it('keeps standalone empty and punctuation regions, including degenerate boxes', () => {
    expect(process(line(''), line('……', [200, 0, 300, 100]), line('', [1, 1, 1, 1]))).toHaveLength(3);
  });

  it('returns new lines in the original order, renumbered, without mutating the engine result', () => {
    const input = page([line('後', [200, 0, 300, 100], { n: 3 }), line('先', undefined, { n: 7 })]);
    Object.freeze(input);
    Object.freeze(input.lines);
    for (const l of input.lines) { Object.freeze(l); Object.freeze(l.box); }
    const output = postProcessDetection(input);
    expect(output).not.toBe(input);
    expect(output.lines.map((l) => [l.n, l.jp])).toEqual([[1, '後'], [2, '先']]);
    expect(input.lines.map((l) => l.n)).toEqual([3, 7]);
    expect(output.panels).toBe(input.panels);
    expect(output.lines[0]).not.toBe(input.lines[0]);
  });

  it('accepts a page without regions', () => {
    expect(postProcessDetection(page([]))).toEqual(page([]));
  });
});
