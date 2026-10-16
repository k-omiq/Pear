import { describe, expect, it } from 'vitest';
import { isAlreadyEnglish, ocrComparableKey, postProcessDetection } from './detect-post.js';
import { classifyRegionLineType, looksLikeDialogue, looksLikeOnomatopoeia, sfxMeaning } from './sfx-meanings.js';

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

describe('dialogue evidence', () => {
  it.each(['家族', 'こんにちは', '기다려', '응!', '기다려 주세요', 'ﾏｯﾃください'])('recognizes speech: %s', (text) => {
    expect(looksLikeDialogue(text)).toBe(true);
  });

  it.each(['', 'ふわっ', 'ドキドキ', '두근두근', '하아', '다다다', 'ズバババ'])('does not treat lettering as dialogue: %s', (text) => {
    expect(looksLikeDialogue(text)).toBe(false);
  });
});

describe('onomatopoeia shape rules', () => {
  it.each([
    'ズバババ', 'ババババ', 'ちゅううううう', 'ちゅるるっ', 'ズバズバ', 'ハンハッ', 'チッ', 'バシャッ',
    'ﾊﾞﾊﾞﾊﾞﾊﾞ！', '쿵쿵쿵', '다다다', '뱌뱌뱌', '뱌뵤뱌뵤', '뱌아아', '뱌오오', 'ㅋㅋㅋ',
  ])('recognizes repeated, stretched and cut-off sounds: %s', (text) => {
    expect(looksLikeOnomatopoeia(text)).toBe(true);
  });

  it.each([
    '', 'ア', 'バ'.repeat(13), '待って待って', 'はいはい', 'いやいや', 'うんうん', 'ええええ',
    'そうそう', 'だめだめ', 'まってまって', 'ねえねえ', '응응', '네네네', '기다려 주세요',
    '뱌'.repeat(13) + '아', '뱌뵤오오', '사람', '人バババ',
  ])('rejects speech, non-kana text and unsupported stretches: %s', (text) => {
    expect(looksLikeOnomatopoeia(text)).toBe(false);
  });
});

describe('SFX, dialogue and narration classification', () => {
  it.each([
    ['bubble', 'ドキドキ', 'sfx'], ['unknown', 'どきどき！', 'sfx'],
    ['bubble', 'はあ……', 'dialogue'], ['free', 'はあ……', 'sfx'],
    ['bubble', 'ちゅううううう', 'sfx'], ['bubble', 'ババババ', 'sfx'],
    ['bubble', 'パパパパ', 'dialogue'], ['unknown', 'パパパパ', 'sfx'],
    ['unknown', 'ババババ', 'sfx'], ['unknown', 'ズバズバ', 'sfx'],
    ['free', '待って！', 'narration'], ['free', 'こんにちは', 'narration'],
    ['free', 'ズギャーン', 'sfx'], ['bubble', 'ズギャーン', 'dialogue'],
    ['free', '', 'sfx'], ['unknown', '', 'dialogue'],
    ['bubble', 'ホラ斉藤！', 'dialogue'], ['unknown', 'そうだっ', 'dialogue'],
    ['unknown', 'ハーイ', 'dialogue'], ['free', '家族', 'narration'],
  ])('%s / %s → %s', (kind, text, type) => {
    expect(classifyRegionLineType(kind, text)).toBe(type);
  });

  it.each(['東京都', 'ありがとうね', '食べたい', 'そう！', 'はい', 'きたよ', 'きたね', 'きただ', 'きたぞ', 'きたぜ', 'きたか', 'きたな', 'きたわ'])
    ('protects sentences and spoken particles from a strong SFX hint: %s', (text) => {
      expect(classifyRegionLineType('free', text, { sfxDetector: true })).toBe('narration');
      expect(classifyRegionLineType('bubble', text, { sfxDetector: true })).toBe('dialogue');
    });

  it('requires a stem before a spoken particle so two-mora sounds stay eligible', () => {
    expect(sfxMeaning('ふね')).toBeNull();
    expect(classifyRegionLineType('free', 'ふね', { sfxDetector: true })).toBe('sfx');
    for (const text of ['ぐわ', 'かさ', 'ふわっ', 'ババババ']) {
      expect(classifyRegionLineType('free', text, { sfxDetector: true })).toBe('sfx');
    }
  });

  it('distinguishes a font-size hint from a dedicated SFX detector', () => {
    expect(classifyRegionLineType('unknown', '家族', { type: 'sfx' })).toBe('dialogue');
    expect(classifyRegionLineType('unknown', 'ありがとう', { type: 'sfx' })).toBe('dialogue');
    expect(classifyRegionLineType('unknown', '家族', { sfxDetector: true })).toBe('sfx');
    expect(classifyRegionLineType('unknown', '', { type: 'sfx' })).toBe('sfx');
    expect(classifyRegionLineType('bubble', '', { type: 'sfx' })).toBe('dialogue');
    expect(classifyRegionLineType('unknown', 'ホラ', { type: 'sfx' })).toBe('sfx');
    expect(classifyRegionLineType('unknown', 'ドキドキ', { type: 'dialogue' })).toBe('sfx');
  });

  it.each([
    ['bubble', '두근두근', 'sfx'], ['bubble', '하아……', 'sfx'], ['bubble', '탁', 'sfx'],
    ['bubble', '기다려 주세요', 'dialogue'], ['free', '오늘은 학교 분위기가 어수선하다', 'narration'],
    ['free', '응!', 'narration'], ['free', '미안. 나도 어떻게 말해야 할지 잘 몰랐어.', 'narration'],
    ['unknown', '다다다', 'sfx'], ['unknown', '기다려', 'dialogue'], ['unknown', '네네네', 'dialogue'],
  ])('classifies Korean %s / %s → %s', (kind, text, type) => {
    expect(classifyRegionLineType(kind, text, { lang: 'ko', sfxDetector: true })).toBe(type);
  });

  it('uses only generic speech evidence for Chinese and never applies the Japanese/Korean dictionary', () => {
    expect(classifyRegionLineType('free', '今天的天气真好', { lang: 'zh', type: 'sfx' })).toBe('narration');
    expect(classifyRegionLineType('unknown', '今天', { lang: 'zh', type: 'sfx' })).toBe('dialogue');
    expect(classifyRegionLineType('bubble', '今天', { lang: 'zh' })).toBe('dialogue');
    for (const text of ['ドキドキ', '두근두근', 'ババババ']) {
      expect(classifyRegionLineType('unknown', text, { lang: 'zh', type: 'dialogue' })).toBe('dialogue');
    }
    expect(classifyRegionLineType('unknown', '', { lang: 'zh', type: 'sfx' })).toBe('sfx');
  });

  it('uses optional detector kinds and per-line languages without changing order or metadata', () => {
    const lines = process(
      line('ドキドキ', [0, 0, 20, 20]),
      line('待って！', [30, 0, 50, 20], { kind: 'free', type: 'sfx' }),
      line('今天', [60, 0, 80, 20], { kind: 'bubble', lang: 'zh', type: 'sfx' }),
      line('기다려', [90, 0, 110, 20], { lang: 'ko', type: 'sfx' }),
    );
    expect(lines.map((l) => [l.n, l.type])).toEqual([[1, 'sfx'], [2, 'narration'], [3, 'dialogue'], [4, 'dialogue']]);
    expect(lines[1]).toMatchObject({ kind: 'free', vertical: true, font_size: 20 });
    expect(lines[2].lang).toBe('zh');
    expect(postProcessDetection({ ...page([line('ドキドキ', undefined, { lang: undefined })]), lang: 'zh' }).lines[0].type)
      .toBe('dialogue');
  });

  it('treats an absent kind as unknown and preserves font-size types when OCR is off', () => {
    expect(process(line('ババババ'))[0].type).toBe('sfx');
    expect(process(line('', undefined, { type: 'sfx' }))[0].type).toBe('sfx');
    expect(process(line('', undefined, { type: 'dialogue' }))[0].type).toBe('dialogue');
  });
});

describe('already-English lettering', () => {
  it.each(['OK', 'BANG! 123', 'ＨＥＬＬＯ１２', 'ﬁ', 'éà', '<b>Hello</b>', 'ABCDβ', 'GO\nGO'])
    ('recognizes Latin lettering after NFKC: %s', (text) => {
      expect(isAlreadyEnglish(text)).toBe(true);
    });

  it.each(['', '!?', '1234', 'A', 'Ａ1', '<unk>', 'АВ', 'βγ', 'ABCβ', 'HELLO漢', 'HELLOあ', 'HELLOア', 'HELLO한', 'HELLO가'])
    ('keeps readings that fail the letter, script or Latin-share rule: %s', (text) => {
      expect(isAlreadyEnglish(text)).toBe(false);
    });

  it('drops English by default, keeps source-script text and renumbers the survivors', () => {
    expect(process(
      line('HELLO'), line('こんにちは', [200, 0, 300, 100], { n: 5, en: 'Hello' }),
      line('今天', [400, 0, 500, 100], { lang: 'zh' }), line('기다려', [600, 0, 700, 100], { lang: 'ko' }),
    ).map((l) => [l.n, l.jp])).toEqual([[1, 'こんにちは'], [2, '今天'], [3, '기다려']]);
  });

  it('keeps English when requested, still removes duplicates, and does not change the input', () => {
    const lines = [line('ＨＥＬＬＯ'), line('HELLO', [10, 10, 60, 60])];
    const input = page(lines);
    for (const l of lines) Object.freeze(l);
    const result = postProcessDetection(input, { keepEnglish: true });
    expect(result.lines).toEqual([{ ...lines[1], n: 1 }]);
    expect(input.lines).toHaveLength(2);
    expect(input.lines.map((l) => l.n)).toEqual([9, 9]);
  });

  it.each([false, true])('removes empty regions on English whether it is skipped or kept (%s)', (keepEnglish) => {
    const result = postProcessDetection(page([
      line('BANG!'), line('', [10, 10, 30, 30]), line('<unk>', [40, 40, 60, 60]),
      line('', [200, 0, 300, 100]),
    ]), { keepEnglish });
    expect(result.lines.map((l) => l.jp)).toEqual(keepEnglish ? ['BANG!', ''] : ['']);
  });

  it.each([[65, 0], [64, 1]])('requires 65 percent coverage to drop an empty region on skipped English (%s percent)', (overlap, count) => {
    expect(process(line('HELLO'), line('', [100 - overlap, 0, 200 - overlap, 100]))).toHaveLength(count);
  });

  it('skips English before deciding whether children replace a parent', () => {
    const input = page([
      line('HELLO今日は'), line('HELLO', [0, 0, 40, 40]), line('今日は', [50, 50, 90, 90]),
    ]);
    expect(postProcessDetection(input).lines.map((l) => l.jp)).toEqual(['HELLO今日は']);
    expect(postProcessDetection(input, { keepEnglish: true }).lines.map((l) => l.jp)).toEqual(['HELLO', '今日は']);
  });

  it('preserves digit-only and mark-only source when not covered by another region', () => {
    expect(process(line('1234'), line('……', [200, 0, 300, 100]))).toHaveLength(2);
  });
});

describe('a second reader (OCR-1)', () => {
  const line = (jp, jp2) => ({ n: 1, type: 'dialogue', lang: 'ja', jp, jp2, en: '', box: [0, 0, 50, 80], vertical: true, font_size: 20 });
  const one = (jp, jp2) => postProcessDetection({ img_width: 100, img_height: 100, panels: [], lines: [line(jp, jp2)] }).lines[0];

  it('keeps the other reading only when the two disagree', () => {
    expect(one('猫が好き', '描が好き').jp2).toBe('描が好き');
  });

  it('drops it when they agree up to spacing, width and dashes', () => {
    expect('jp2' in one('ねえ、ちょっと〜', 'ねえ、 ちょっと～')).toBe(false);
    expect('jp2' in one('そうだ！', 'そうだ!')).toBe(false);
  });

  it('drops an empty or unread second reading', () => {
    expect('jp2' in one('猫', '')).toBe(false);
    expect('jp2' in one('猫', '……')).toBe(false);
    expect('jp2' in one('猫', undefined)).toBe(false);
  });
});
