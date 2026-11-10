import { describe, it, expect } from 'vitest';
import { normalizeRuns, faceAt, faceSpans, toggleRuns, changedSpan, shiftRuns, putText, saveRuns, runsKey } from './runs.js';

const B = { bold: true, italic: false };
const I = { bold: false, italic: true };
const BI = { bold: true, italic: true };
const run = (start, end, f = B) => ({ start, end, ...f });

// Each letter's face as a run gives it, or null for the box's own: the model
// the shifts are checked against, letter by letter.
const letters = (runs, len) => {
  const out = new Array(len).fill(null);
  for (const r of runs ?? []) for (let i = r.start; i < r.end; i++) out[i] = `${r.bold ? 'b' : ''}${r.italic ? 'i' : ''}` || 'r';
  return out;
};
const fromLetters = (faces) => {
  const out = [];
  faces.forEach((f, i) => {
    if (f == null) return;
    const last = out[out.length - 1];
    if (last && last.end === i && last.f === f) last.end = i + 1;
    else out.push({ start: i, end: i + 1, f });
  });
  return out.map(({ start, end, f }) => ({ start, end, bold: f.includes('b'), italic: f.includes('i') }));
};

// What an edit of [a, b) to `ins` letters should leave, by the rule
// `shiftRuns` states: untouched letters keep their faces; inserted letters
// take the face before them (at the start, after them) when nothing was
// removed, else the one face every removed letter shared, if they did.
function expected(runs, oldLen, a, b, ins) {
  const old = letters(runs, oldLen);
  let face = null;
  if (a === b) face = a > 0 ? old[a - 1] : (old[0] ?? null);
  else {
    const gone = old.slice(a, b);
    // One run: the same face throughout, and no letter outside every run.
    if (gone.every((f) => f != null && f === gone[0])) face = gone[0];
  }
  return fromLetters([...old.slice(0, a), ...new Array(ins).fill(face), ...old.slice(b)]);
}

// A small, seeded generator, so a failing case can be run again.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('normalizeRuns', () => {
  it('is null for none', () => {
    expect(normalizeRuns(undefined, 'abc')).toBe(null);
    expect(normalizeRuns([], 'abc')).toBe(null);
    expect(normalizeRuns([run(1, 1)], 'abc')).toBe(null);
  });
  it('sorts, cuts to the text and merges runs of one face that touch', () => {
    expect(normalizeRuns([run(4, 9), run(0, 2), run(2, 4)], 'abcdef')).toEqual([run(0, 6)]);
  });
  it('gives the later of two overlapping runs the letters they share', () => {
    expect(normalizeRuns([run(0, 6), run(2, 4, I)], 'abcdef')).toEqual([run(0, 2), run(2, 4, I), run(4, 6)]);
  });
  it('drops junk and a run in the box face', () => {
    expect(normalizeRuns([null, { start: 'x', end: 3 }, run(0, 3, I)], 'abcdef', I)).toBe(null);
    expect(normalizeRuns([{ start: 1, end: 3, bold: 1 }], 'abcdef')).toEqual([{ start: 1, end: 3, bold: false, italic: false }]);
  });
});

describe('reading faces', () => {
  const runs = [run(2, 4), run(6, 8, BI)];
  it('faceAt answers the run or the box face', () => {
    expect(faceAt(runs, 0, I)).toEqual(I);
    expect(faceAt(runs, 2, I)).toEqual(B);
    expect(faceAt(runs, 4, I)).toEqual(I);
    expect(faceAt(runs, 7, null)).toEqual(BI);
  });
  it('faceSpans covers the text end to end', () => {
    expect(faceSpans(runs, 9, null)).toEqual([
      { start: 0, end: 2, bold: false, italic: false },
      run(2, 4),
      { start: 4, end: 6, bold: false, italic: false },
      run(6, 8, BI),
      { start: 8, end: 9, bold: false, italic: false },
    ]);
    expect(faceSpans(null, 0, B)).toEqual([{ start: 0, end: 0, ...B }]);
  });
});

describe('toggleRuns', () => {
  const t = 'hello brave world';
  it('turns a range bold, and off again when it all is', () => {
    const on = toggleRuns(null, t, 6, 11, 'bold', null);
    expect(on).toEqual([run(6, 11)]);
    expect(toggleRuns(on, t, 6, 11, 'bold', null)).toBe(null);
  });
  it('is on for a range only partly bold, and keeps the other half of each face', () => {
    const runs = [run(0, 5, I), run(6, 8)];
    expect(toggleRuns(runs, t, 3, 11, 'bold', null)).toEqual([run(0, 3, I), run(3, 5, BI), run(5, 11)]);
  });
  it('drops what comes to equal the box face', () => {
    expect(toggleRuns(null, t, 0, 5, 'bold', B)).toEqual([{ start: 0, end: 5, bold: false, italic: false }]);
    expect(toggleRuns([{ start: 0, end: 5, bold: false, italic: false }], t, 0, 5, 'bold', B)).toBe(null);
  });
});

describe('changedSpan', () => {
  it('finds the replaced range by common prefix and suffix', () => {
    expect(changedSpan('hello world', 'hello there world')).toEqual([6, 6]);
    expect(changedSpan('abc', 'abc')).toBe(null);
    expect(changedSpan('abc', 'xyz')).toEqual([0, 3]);
    expect(changedSpan('abcdef', 'abef')).toEqual([2, 4]);
  });
});

describe('shiftRuns', () => {
  const t = 'one two three';
  const two = [run(4, 7)];
  const cases = [
    ['insert at the start', 'xx' + t, [0, 0], [run(6, 9)]],
    ['insert in the middle, before the run', 'one xtwo three', [4, 4], [run(5, 8)]],
    ['insert at the end of the run takes its face', 'one twox three', [7, 7], [run(4, 8)]],
    ['insert inside the run', 'one txwo three', [5, 5], [run(4, 8)]],
    ['insert at the end of the text', t + '!', [13, 13], two],
    ['delete at the start', t.slice(2), [0, 2], [run(2, 5)]],
    ['delete across the run edge', 'one twthree', [6, 8], [run(4, 6)]],
    ['delete the whole run', 'one  three', [4, 7], null],
    ['delete at the end', 'one two thr', [11, 13], two],
    ['replace inside the run keeps its face', 'one tXo three', [5, 6], [run(4, 7)]],
    ['replace across the run edge trims it', 'one tXYthree', [5, 8], [run(4, 5)]],
    ['replace before the run moves it', 'ONE two three', [0, 3], two],
    ['replace the whole text', 'something else', [0, 13], null],
  ];
  for (const [name, after, span, want] of cases) {
    it(name, () => {
      expect(shiftRuns(two, t, after, span)).toEqual(want);
      // Found by the common prefix and suffix, the answer is the same.
      expect(shiftRuns(two, t, after)).toEqual(want);
    });
  }
  it('keeps a run across the whole text through a whole-text replace', () => {
    expect(shiftRuns([run(0, 13)], t, 'all new', [0, 13])).toEqual([run(0, 7)]);
  });
  it('a run at the very start takes letters typed in front of it', () => {
    expect(shiftRuns([run(0, 3)], 'one', 'xone', [0, 0])).toEqual([run(0, 4)]);
  });

  // Random edits of random runs, letter by letter against the stated rule.
  it('agrees with the letter model on random edits', () => {
    const next = rng(12345);
    const pick = (n) => Math.floor(next() * n);
    const faces = [B, I, BI, { bold: false, italic: false }];
    for (let k = 0; k < 3000; k++) {
      const len = pick(14);
      const old = Array.from({ length: len }, () => 'abcde '[pick(6)]).join('');
      const raw = [];
      for (let j = pick(4); j > 0; j--) {
        const s = pick(len + 1);
        raw.push(run(s, s + pick(len - s + 1), faces[pick(4)]));
      }
      const runs = normalizeRuns(raw, old);
      const a = pick(len + 1);
      const b = a + pick(len - a + 1);
      const ins = Array.from({ length: pick(4) }, () => 'xyz'[pick(3)]).join('');
      const now = old.slice(0, a) + ins + old.slice(b);
      const got = shiftRuns(runs, old, now, [a, b]) ?? [];
      const want = expected(runs, old.length, a, b, ins.length);
      expect(letters(got, now.length), `case ${k}: "${old}" [${a},${b}) -> "${ins}" runs ${runsKey(runs)}`).toEqual(letters(want, now.length));
    }
  });
});

describe('putText', () => {
  it('writes the text and shifts the runs with it', () => {
    const ln = { n: 1, en: 'one two', runs: [run(4, 7)] };
    putText(ln, 'en', 'one, two', { span: [3, 3] });
    expect(ln).toEqual({ n: 1, en: 'one, two', runs: [run(5, 8)] });
  });
  it('deletes the key when no run is left, and adds none when there was none', () => {
    const ln = { n: 1, en: 'one two', runs: [run(4, 7)] };
    putText(ln, 'en', 'one');
    expect('runs' in ln).toBe(false);
    const plain = { n: 2, en: 'a' };
    putText(plain, 'en', 'ab');
    expect(plain).toEqual({ n: 2, en: 'ab' });
  });
  it('puts recorded runs back as they are, and reads from another field', () => {
    const b = { text: null };
    putText(b, 'text', 'one two!', { from: { text: 'one two', runs: [run(4, 7)] } });
    expect(b.runs).toEqual([run(4, 8)]);
    putText(b, 'text', 'one two!', { runs: [run(0, 3, I)] });
    expect(b.runs).toEqual([run(0, 3, I)]);
    putText(b, 'text', null, { runs: null });
    expect(b).toEqual({ text: null });
  });
});

describe('saveRuns', () => {
  it('leaves items with no runs untouched and normalises the rest', () => {
    const plain = { n: 1, en: 'x' };
    const lines = saveRuns([plain, { n: 2, en: 'abc', runs: [run(1, 9)] }, { n: 3, en: 'ab', runs: [] }], 'en');
    expect(lines[0]).toBe(plain);
    expect(lines[1].runs).toEqual([run(1, 3)]);
    expect('runs' in lines[2]).toBe(false);
    const boxes = saveRuns([{ text: null, runs: [run(0, 1)] }, { text: 'ab', style: { bold: true }, runs: [run(0, 2)] }], 'text');
    expect('runs' in boxes[0]).toBe(false);
    expect('runs' in boxes[1]).toBe(false);
  });
});
