// The series guide meets the chapter: the check list reads what a box shows,
// a speaker pick undoes in the right order, and a bad source field off disk
// does not break the list.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, loadProjectPages, page, pageCheckItems, setLineText, setLineSpeaker, settleEdits, lineByN, resolveOtherReading } from './store.svelte.js';
import { initHistory, resetHistory, undo } from './editor/history.svelte.js';
import { bindGuide, unbindGuide } from './guide.svelte.js';

const terms = [
  { id: 'mk', source: '誠', target: 'Makoto', character: true },
  { id: 'tm', source: '巴', target: 'Tomoe', character: true },
  { id: 'hy', source: 'ヒューマン', target: 'hume' },
];

beforeEach(() => {
  vi.useFakeTimers();
  app.chapterRef = null;
  app.chapterMode = 'typeset';
  bindGuide({ glossary: terms });
  initHistory();
  resetHistory();
});
afterEach(() => {
  settleEdits();
  resetHistory();
  loadProjectPages([]);
  unbindGuide();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const glossaryItems = (pg) => pageCheckItems(pg, 0).filter((it) => it.reason === 'glossary');

describe('glossary checks on a boxed line', () => {
  it('reads the text the box shows, not the line under it', () => {
    loadProjectPages([{
      id: 1, w: 800, h: 1200,
      lines: [{ n: 1, jp: 'ヒューマンだ', en: 'A human' }],
      boxes: [{ id: 'b1', lineN: 1, text: 'A hume', x: 0, y: 0, w: 90, h: 50 }],
    }]);
    expect(glossaryItems(page())).toEqual([]);
    page().boxes[0].text = 'A person';
    expect(glossaryItems(page())).toHaveLength(1);
  });

  it('reads a line split over two boxes as both', () => {
    loadProjectPages([{
      id: 1, w: 800, h: 1200,
      lines: [{ n: 1, jp: 'ヒューマンだ', en: 'It is a person' }],
      boxes: [
        { id: 'b1', lineN: 1, text: 'It is', x: 0, y: 0, w: 90, h: 50 },
        { id: 'b2', lineN: 1, text: 'a hume', x: 0, y: 60, w: 90, h: 50 },
      ],
    }]);
    expect(glossaryItems(page())).toEqual([]);
  });
});

describe('a source field that is not text', () => {
  it('is dropped on load and the check list still builds', () => {
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, jp: 123, en: '' }], boxes: [] }]);
    expect(lineByN(page(), 1).jp).toBeUndefined();
    expect(() => pageCheckItems(page(), 0)).not.toThrow();
  });
});

describe('picking a speaker', () => {
  it('is undone before the typing that came just before it', () => {
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, jp: '誠', en: 'Hi' }], boxes: [] }]);
    const p = page();
    setLineText(p, 1, 'Hi there');
    setLineSpeaker(p, 1, 'mk');
    expect(undo()).toBe(true);
    expect(lineByN(p, 1).speaker).toBeUndefined();
    expect(lineByN(p, 1).en).toBe('Hi there');
    expect(undo()).toBe(true);
    expect(lineByN(p, 1).en).toBe('Hi');
  });
});

describe('a second reader that disagreed (OCR-1)', () => {
  const ocrItems = (pg) => pageCheckItems(pg, 0).filter((it) => it.reason === 'ocr');
  const load = () => loadProjectPages([{
    id: 1, w: 800, h: 1200,
    lines: [{ n: 1, jp: '猫だ', jp2: '描だ', en: 'A cat' }, { n: 2, jp: '犬', en: '' }],
    boxes: [{ id: 'b1', lineN: 1, text: 'A cat', x: 0, y: 0, w: 90, h: 50 }],
  }]);

  it('is one check on the line, on its box, naming the other reading', () => {
    load();
    expect(ocrItems(page())).toEqual([expect.objectContaining({ boxId: 'b1', lineN: 1, alt: '描だ' })]);
  });

  it('clears when the user keeps their reading, leaving the source alone', () => {
    load();
    resolveOtherReading(page(), 1, false);
    expect(ocrItems(page())).toEqual([]);
    expect(lineByN(page(), 1).jp).toBe('猫だ');
  });

  it('takes the other reading as the source, one undo step back', () => {
    load();
    resolveOtherReading(page(), 1, true);
    expect(ocrItems(page())).toEqual([]);
    expect(lineByN(page(), 1).jp).toBe('描だ');
    undo();
    expect(lineByN(page(), 1).jp).toBe('猫だ');
  });
});
