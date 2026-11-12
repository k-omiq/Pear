import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Let the real fit run on the deterministic node metric, and observe the floor
// handed to each ladder without replacing its answer.
vi.mock('./measure.js', async (original) => ({ ...(await original()), canMeasure: () => true }));
vi.mock('./contain.js', async (original) => {
  const mod = await original();
  return { ...mod, fitBox: vi.fn(mod.fitBox) };
});
vi.mock('./auto-layout.js', async (original) => {
  const mod = await original();
  return { ...mod, solveLayout: vi.fn(mod.solveLayout) };
});

import {
  app, loadProjectPages, page, byId, setRecorder, cloneStyle, fitGeom,
  resetBoxToTagStyle, saveBoxStyleAsTag, applyTagStyleToChapter,
  autoFitBox, setMinFontSize, activateLine, placeActiveAt, openBulk, closeBulk, setBulkProp,
  applyBulkToTag, inheritedStyleFor,
} from './store.svelte.js';
import { bindTags, unbindTags, findTag, TAG_STYLE_KEYS } from './tags.svelte.js';
import { normalizePaint } from './box-paint.js';
import { normalizeSpecial } from './special.js';
import { defaultStyle, normalizeAuto } from './data.js';
import { fitBox } from './contain.js';
import { solveLayout } from './auto-layout.js';
import { initHistory, resetHistory, loadStack, undo, redo } from './editor/history.svelte.js';

const box = (id, lineN = 1) => ({
  id, lineN, x: 100, y: 100, w: 100, h: 40,
  style: { ...defaultStyle(), shape: 'off', strokeEffects: [], size: 40 },
});
const doc = () => [1, 2].map((id) => ({
  id, w: 800, h: 1200,
  lines: [{ n: 1, en: 'AAAA BBBB CCCC DDDD', tags: ['voice', 'accent'] }, { n: 2, en: 'Other', tags: [] }],
  boxes: [box(`b${id}`), box(`other${id}`, 2)],
}));

let writes;
beforeEach(() => {
  app.chapterRef = null;
  writes = [];
  bindTags({ list: [
    { name: 'voice', style: { italic: true, color: '#123456', lineHeight: 2 }, size: 60, minSize: 18 },
    { name: 'accent', style: { color: '#abcdef', bold: true } },
  ] }, (next) => writes.push(next));
  loadProjectPages(doc());
  initHistory();
  resetHistory();
  app.saved = true;
  app.selectedId = 'b1';
  setMinFontSize(12);
});
afterEach(() => {
  unbindTags();
  resetHistory();
  setMinFontSize(12);
});

describe('explicit tag style commands', () => {
  it('resets the selected box, fits it and undoes the style and geometry together', () => {
    const b = byId('b1');
    const before = cloneStyle(b.style);
    const geomBefore = fitGeom(b);
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      expect(resetBoxToTagStyle()).toBe(1);
    } finally {
      off();
    }
    expect(b.style).toMatchObject({ italic: true, color: '#123456', bold: true, lineHeight: 2 });
    expect(b.h).toBeGreaterThan(geomBefore.h);
    const after = cloneStyle(b.style);
    const geomAfter = fitGeom(b);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ t: 'style', pageId: 1, boxId: 'b1', before, after, geomBefore, geomAfter });
    expect(app.saved).toBe(false);
    undo();
    expect(b.style).toEqual(before);
    expect(fitGeom(b)).toEqual(geomBefore);
    redo();
    expect(b.style).toEqual(after);
    expect(fitGeom(b)).toEqual(geomAfter);
    expect(writes).toEqual([]);
  });

  it('records and dirties nothing for an unchanged, untagged or absent box', () => {
    resetBoxToTagStyle();
    app.saved = true;
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      expect(resetBoxToTagStyle()).toBe(0);
      expect(resetBoxToTagStyle('other1')).toBe(0);
      expect(resetBoxToTagStyle('missing')).toBe(0);
    } finally {
      off();
    }
    expect(log).toEqual([]);
    expect(app.saved).toBe(true);
    expect(app.toast.msg).toBe('No tag style changes');
  });

  it('saves the whole lettering style to the primary tag with no document history', () => {
    const b = byId('b1');
    Object.assign(b.style, { color: '#654321', rotation: 17, italic: false, size: 55 });
    const log = [];
    const off = setRecorder((e) => log.push(e));
    let entry;
    try {
      entry = saveBoxStyleAsTag();
    } finally {
      off();
    }
    const expected = cloneStyle(b.style);
    expect(entry.name).toBe('voice');
    expect(entry.style).toEqual(Object.fromEntries(TAG_STYLE_KEYS.map((k) => [k, expected[k]])));
    expect(entry).toMatchObject({ size: 60, minSize: 18 });
    expect(findTag('accent').style).toEqual({ color: '#abcdef', bold: true });
    expect(log).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(app.saved).toBe(true);
    entry.style.strokeEffects.push({ size: 4, position: 'outside', color: '#ffffff', opacity: 1 });
    expect(b.style.strokeEffects).toEqual([]);
  });

  it('admits a primary tag known only to the chapter and rejects an untagged line', () => {
    page().lines[0].tags = ['new'];
    expect(saveBoxStyleAsTag().name).toBe('new');
    expect(findTag('new').style.font).toBe(defaultStyle().font);
    expect(saveBoxStyleAsTag('other1')).toBeNull();
    expect(app.toast.msg).toBe('Tag the line first');
    expect(saveBoxStyleAsTag('missing')).toBeNull();
  });

  it('applies the line merge across pages with one bulk entry per page', () => {
    page().boxes.push(box('twin'));
    const untouched = cloneStyle(byId('other1').style);
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      // Accent selects these boxes, but voice still wins its keys on each line.
      expect(applyTagStyleToChapter('accent')).toBe(3);
      expect(applyTagStyleToChapter('accent')).toBe(0);
    } finally {
      off();
    }
    expect(log.map((e) => [e.t, e.pageId, e.items.length])).toEqual([['bulk', 1, 2], ['bulk', 2, 1]]);
    for (const e of log) for (const item of e.items) {
      expect(item.after).toMatchObject({ color: '#123456', italic: true, bold: true });
      expect(item.geomAfter.h).toBeGreaterThan(item.geomBefore.h);
    }
    expect(byId('other1').style).toEqual(untouched);
    expect(app.saved).toBe(false);
    // The app stores offscreen pages separately; load page 1's recorded stack.
    loadStack(1, { undo: [log[0]], redo: [] });
    undo();
    expect(byId('b1').style.italic).toBe(false);
    expect(byId('twin').style.italic).toBe(false);
    expect(app.pages[1].boxes[0].style.italic).toBe(true);
    expect(writes).toEqual([]);
  });

  it('honors an explicit page scope and records nothing when no boxes match', () => {
    expect(applyTagStyleToChapter('voice', [app.pages[1]])).toBe(1);
    expect(byId('b1').style.italic).toBe(false);
    expect(app.pages[1].boxes[0].style.italic).toBe(true);
    app.saved = true;
    expect(applyTagStyleToChapter('unknown')).toBe(0);
    expect(app.saved).toBe(true);
  });
});

describe('the primary tag minimum in both fit ladders', () => {
  it.each([
    [null, 30], [8, 12], [20, 20], [36, 36],
  ])('uses minSize %s with a floor of %s', (minSize, floor) => {
    bindTags({ list: [{ name: 'voice', minSize }, { name: 'accent', minSize: 39 }] });
    const b = byId('b1');
    b.style.size = 40;
    b.auto = null;
    fitBox.mockClear();
    autoFitBox(b, page(), { solve: true });
    expect(fitBox).toHaveBeenCalled();
    expect(fitBox.mock.lastCall[1].minSize).toBe(floor);
    expect(b.style.size).toBeGreaterThanOrEqual(floor);

    b.style.size = 40;
    b.auto = normalizeAuto({ on: true, refSize: 40 });
    solveLayout.mockClear();
    autoFitBox(b, page(), { solve: true });
    expect(solveLayout).toHaveBeenCalled();
    expect(solveLayout.mock.lastCall[0].opts.minSize).toBe(floor);
    expect(b.style.size).toBeGreaterThanOrEqual(floor);
  });
});

// Paint marks are drawn over one box's letters, in its frame: a tag style
// never carries them to another box and never takes them off one.
describe('paint marks stay on the box they were drawn on', () => {
  const MARKS = () => normalizePaint({ on: true, marks: [{ kind: 'stroke', size: 6, pts: [[10, 10], [60, 30]], color: '#ff0000' }] });
  const painted = () => {
    const b = byId('b1');
    b.style.paint = MARKS();
    return b;
  };

  it('a tag style saved from a painted box holds no marks, nor one stored before', () => {
    painted();
    const entry = saveBoxStyleAsTag();
    expect(TAG_STYLE_KEYS).not.toContain('paint');
    expect(Object.hasOwn(entry.style, 'paint')).toBe(false);
    bindTags({ list: [{ name: 'voice', style: { italic: true, paint: MARKS() } }] }, () => {});
    expect(Object.hasOwn(findTag('voice').style, 'paint')).toBe(false);
  });

  it('a box born on a tagged line has none (bornBox)', () => {
    painted();
    saveBoxStyleAsTag();
    app.lastStyle = defaultStyle();
    // A line of the tag with no box yet.
    page().lines.push({ n: 3, en: 'EEEE FFFF', tags: ['voice'] });
    const before = page().boxes.length;
    activateLine(3);
    placeActiveAt(300, 300);
    expect(page().boxes).toHaveLength(before + 1);
    const born = page().boxes[page().boxes.length - 1];
    expect(born.lineN).toBe(3);
    expect(born.style.paint).toEqual({ on: false, marks: [] });
  });

  it('applying the tag to the chapter keeps each box\'s own marks (applyTagStyleToChapter)', () => {
    const b = painted();
    saveBoxStyleAsTag();
    applyTagStyleToChapter('voice');
    expect(b.style.paint).toEqual(MARKS());
    expect(app.pages[1].boxes[0].style.paint).toEqual({ on: false, marks: [] });
  });

  it('a bulk edit over the tag keeps each box\'s own marks (applyBulkToTag)', () => {
    const b = painted();
    app.selectedId = 'b1';
    openBulk();
    try {
      setBulkProp('color', true);
      app.bulk.style.color = '#00ff00';
      expect(applyBulkToTag('voice')).toBe(2);
    } finally {
      closeBulk();
    }
    expect(b.style.color).toBe('#00ff00');
    expect(b.style.paint).toEqual(MARKS());
    expect(app.pages[1].boxes[0].style.color).toBe('#00ff00');
    expect(app.pages[1].boxes[0].style.paint).toEqual({ on: false, marks: [] });
  });
});

// Special effects travel only by an explicit act: a tag style that has them
// gives them to its line's new boxes, the last-used style never does.
describe('special effects come from a tag style, not the last box', () => {
  const CRACK = () => normalizeSpecial({ crack: { on: true, amount: 60, seed: 7 } });

  it('a tag style that carries special gives it through inheritedStyleFor', () => {
    bindTags({ list: [{ name: 'voice', style: { italic: true, special: CRACK() } }] }, () => {});
    expect(findTag('voice').style.special).toEqual(CRACK());
    const s = inheritedStyleFor({ n: 3, en: 'EEEE', tags: ['voice'] });
    expect(s.italic).toBe(true);
    expect(s.special).toEqual(CRACK());
  });

  it('a new box that only inherits the last-used style gets none', () => {
    const before = app.lastStyle;
    try {
      app.lastStyle = { ...defaultStyle(), color: '#123456', special: CRACK() };
      // The tag here sets no special: only the last-used style has one.
      const s = inheritedStyleFor({ n: 3, en: 'EEEE', tags: ['accent'] });
      expect(s.color).toBe('#abcdef');
      expect(s.special).toEqual(normalizeSpecial(undefined));
      const plain = inheritedStyleFor({ n: 4, en: 'FFFF', tags: [] });
      expect(plain.color).toBe('#123456');
      expect(plain.special).toEqual(normalizeSpecial(undefined));
    } finally {
      app.lastStyle = before;
    }
  });
});
