// `split`: one box's text shared out over the bubbles it belongs in - the two
// halves of a joined outline, cut at its neck, or a bubble elsewhere at a point.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let seq = 1;
vi.mock('../../library.svelte.js', async (orig) => ({ ...(await orig()), chapterOpenSeq: () => seq }));

const { app, loadProjectPages, pageById, settleEdits, boxText } = await import('../../store.svelte.js');
const { initHistory, resetHistory, undo } = await import('../../editor/history.svelte.js');
const { callContext, __resetRun } = await import('../run.svelte.js');
const { callTool } = await import('../registry.js');
const { defaultStyle } = await import('../../data.js');
const { normalizeSpecial } = await import('../../special.js');
const { fitPolygon } = await import('../../outline-geom.js');
const { checksOf } = await import('./edit.js');
const { partsOf, readsFirst } = await import('./split.js');
await import('./index.js');

// Two round bubbles, centres (200, 200) and (420, 200), radius 80, joined by
// a neck 30 px high: one outline, as the finder sees two touching bubbles.
function joinedOutline() {
  const r = 80;
  const a = Math.asin(15 / r);
  const pts = [];
  const arc = (cx, from, to) => {
    for (let k = 0; k <= 24; k++) {
      const t = from + ((to - from) * k) / 24;
      pts.push([Math.round((cx + r * Math.cos(t)) * 10) / 10, Math.round((200 + r * Math.sin(t)) * 10) / 10]);
    }
  };
  arc(200, a, 2 * Math.PI - a); // the left bubble, round from the neck's bottom to its top
  arc(420, Math.PI + a, 3 * Math.PI - a); // the right one, round from the neck's top to its bottom
  return pts;
}

const TEXT = 'Where are you going? Wait for me!';
const style = () => ({ ...defaultStyle(), size: 20, margin: 0.5 });
const call = (args) => callTool('split', args, callContext('mcp'));
const box = (id) => pageById(1).boxes.find((b) => b.id === id);
const centreX = (b) => {
  const xs = fitPolygon(b.fit).map(([x]) => x);
  return (Math.min(...xs) + Math.max(...xs)) / 2;
};

function load(fit, detect = [170, 170, 230, 230]) {
  loadProjectPages([
    {
      id: 1, w: 800, h: 1200,
      lines: [{ n: 1, en: TEXT, tags: ['speech'] }],
      detect: { boxes: [{ n: 1, box: detect }] },
      boxes: [{ id: 'a', lineN: 1, text: null, x: 140, y: 150, w: 120, h: 100, style: style(), fit, outline: { source: 'ring', confidence: 0.9, approved: null } }],
    },
  ]);
}

beforeEach(() => {
  vi.useFakeTimers();
  seq = 1;
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.chapterMode = 'typeset';
  initHistory();
  resetHistory();
  __resetRun();
});
afterEach(() => {
  settleEdits();
  resetHistory();
  __resetRun();
  app.chapterRef = null;
  loadProjectPages([]);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('split', () => {
  it('cuts a joined outline at its neck and gives the parts to the bubbles in reading order', async () => {
    load({ kind: 'poly', pts: joinedOutline() });
    const r = await call({ id: 'a', parts: ['WHERE ARE YOU GOING?', 'Wait for me!'] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const [first, second] = r.result.ids.map(box);
    expect(r.result.pieces.map((x) => x.bubble)).toEqual(['cut', 'cut']);
    // The text's own capitals, whatever the parts were written in.
    expect(boxText(first, pageById(1))).toBe('Where are you going?');
    expect(boxText(second, pageById(1))).toBe('Wait for me!');
    // Manga reads right to left: the first part takes the right bubble.
    expect(centreX(first)).toBeGreaterThan(330);
    expect(centreX(second)).toBeLessThan(290);
    // Each outline is one bubble now: no neck left to report.
    expect(checksOf(['a']).flatMap((c) => c.issues).some((i) => i.kind === 'joined')).toBe(false);
  });

  it('takes the other bubble at a point: inside the joined outline it cuts there, the parts in the order given', async () => {
    load({ kind: 'poly', pts: joinedOutline() });
    const r = await call({ id: 'a', parts: ['Where are you going?', 'Wait for me!'], at: [[420, 200]] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const [first, second] = r.result.ids.map(box);
    expect(centreX(first)).toBeLessThan(290);
    expect(centreX(second)).toBeGreaterThan(330);
  });

  it('moves a part to a separate bubble at a point', async () => {
    load({ kind: 'ellipse', cx: 200, cy: 200, rx: 80, ry: 70 });
    const r = await call({ id: 'a', parts: ['Where are you going?', 'Wait for me!'], at: [[600, 800]] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const [first, second] = r.result.ids.map(box);
    expect(first.fit.kind).toBe('ellipse');
    // No page pixels here to find a balloon in: said, and the box stands at the point.
    expect(r.result.pieces[1].bubble).toBe('none');
    expect(second.x + second.w / 2).toBeCloseTo(600, 0);
    expect(second.y + second.h / 2).toBeCloseTo(800, 0);
    expect(boxText(second, pageById(1))).toBe('Wait for me!');
  });

  it('is one undo step', async () => {
    load({ kind: 'poly', pts: joinedOutline() });
    await call({ id: 'a', parts: ['Where are you going?', 'Wait for me!'] });
    expect(pageById(1).boxes).toHaveLength(2);
    undo();
    expect(pageById(1).boxes).toHaveLength(1);
    expect(boxText(pageById(1).boxes[0], pageById(1))).toBe(TEXT);
  });

  it('takes the paint marks off every part, in the same undo step', async () => {
    load({ kind: 'poly', pts: joinedOutline() });
    const marks = { on: true, marks: [{ kind: 'stroke', size: 6, pts: [[10, 10], [60, 30]], color: '#ff0000', opacity: 100, soft: 0 }] };
    box('a').style.paint = structuredClone(marks);
    const r = await call({ id: 'a', parts: ['Where are you going?', 'Wait for me!'] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    for (const b of r.result.ids.map(box)) expect(b.style.paint).toEqual({ on: false, marks: [] });
    undo();
    expect(pageById(1).boxes).toHaveLength(1);
    expect(box('a').style.paint).toEqual(marks);
  });

  it('keeps the mask and fade on the first part; the others keep only a bubble link', async () => {
    load({ kind: 'poly', pts: joinedOutline() });
    const mask = { on: true, shapes: [{ kind: 'bubble', op: 'keep', inset: 2 }, { kind: 'poly', op: 'hide', pts: [[10, 10], [60, 10], [10, 60]] }] };
    const fade = { on: true, shapes: [{ kind: 'ellipse', cx: 40, cy: 40, rx: 20, ry: 20, strength: 70, soft: 30 }] };
    box('a').mask = structuredClone(mask);
    box('a').fade = structuredClone(fade);
    const r = await call({ id: 'a', parts: ['Where are you going?', 'Wait for me!'] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const [first, second] = r.result.ids.map(box);
    expect(first.mask.shapes).toHaveLength(2);
    expect(first.fade.shapes).toHaveLength(1);
    expect(second.mask.shapes).toEqual([mask.shapes[0]]);
    expect(second.mask.on).toBe(true);
    expect(second.fade.shapes).toEqual([]);
    expect(second.fade.on).toBe(false);
    undo();
    expect(pageById(1).boxes).toHaveLength(1);
    expect(box('a').mask).toEqual(mask);
  });

  it('every part keeps the special effects; the paint marks, drawn mask and fade still go as above', async () => {
    // A whole-box copy (duplicate, paste, a split part) carries style.special:
    // it is the look of the box, laid over whatever text it holds. What was
    // drawn over the first part's letters or bubble is not.
    load({ kind: 'poly', pts: joinedOutline() });
    const special = normalizeSpecial({ crack: { on: true, amount: 55, seed: 7 }, lightning: { on: true, amount: 30 } });
    box('a').style.special = structuredClone(special);
    box('a').style.paint = { on: true, marks: [{ kind: 'stroke', size: 6, pts: [[10, 10], [60, 30]], color: '#ff0000', opacity: 100, soft: 0 }] };
    box('a').mask = { on: true, shapes: [{ kind: 'bubble', op: 'keep', inset: 2 }, { kind: 'poly', op: 'hide', pts: [[10, 10], [60, 10], [10, 60]] }] };
    box('a').fade = { on: true, shapes: [{ kind: 'ellipse', cx: 40, cy: 40, rx: 20, ry: 20, strength: 70, soft: 30 }] };
    const r = await call({ id: 'a', parts: ['Where are you going?', 'Wait for me!'] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const parts = r.result.ids.map(box);
    expect(parts).toHaveLength(2);
    for (const b of parts) {
      expect(b.style.special).toEqual(special);
      expect(b.style.paint).toEqual({ on: false, marks: [] });
    }
    // Not one object shared between the parts.
    expect(parts[1].style.special).not.toBe(parts[0].style.special);
    expect(parts[0].mask.shapes).toHaveLength(2);
    expect(parts[1].mask.shapes.map((sh) => sh.kind)).toEqual(['bubble']);
    expect(parts[1].fade).toMatchObject({ on: false, shapes: [] });
  });

  it('refuses parts that are not the text, and a single bubble with nowhere to put the rest', async () => {
    load({ kind: 'ellipse', cx: 200, cy: 200, rx: 80, ry: 70 });
    let r = await call({ id: 'a', parts: ['Where are you going?', 'Wait for him!'] });
    expect(r.error).toMatch(/not box a's text/);
    r = await call({ id: 'a', parts: ['Where are you going?', 'Wait for me!'] });
    expect(r.error).toMatch(/one bubble/);
    expect(r.hint).toMatch(/give at/);
    r = await call({ id: 'a', parts: ['Where are', 'you going?', 'Wait for me!'] });
    expect(r.error).toMatch(/more than two parts/);
    expect(pageById(1).boxes).toHaveLength(1);
  });
});

describe('check names a joined outline', () => {
  it('with a point in the other bubble', () => {
    load({ kind: 'poly', pts: joinedOutline() });
    const joined = checksOf(['a']).flatMap((c) => c.issues).find((i) => i.kind === 'joined');
    expect(joined).toBeTruthy();
    expect(joined.detail.far[0]).toBeGreaterThan(340);
  });

  it('not for a single bubble', () => {
    load({ kind: 'ellipse', cx: 200, cy: 200, rx: 80, ry: 70 });
    expect(checksOf(['a']).flatMap((c) => c.issues).some((i) => i.kind === 'joined')).toBe(false);
  });
});

// Two bubbles drawn overlapping, with no neck: a column set higher on the
// right, another lower on the left (the outline the finder drew on a real
// page). The text's detected block is the right column.
const STEPPED = [[368.5, 88.5], [402.5, 103.5], [426.5, 134.5], [457.5, 453.5], [458.5, 577.5], [435.5, 632.5], [389.5, 633.5], [375.5, 627.5], [364.5, 633.5], [357.5, 646.5], [354.5, 755.5], [304.5, 798.5], [295.5, 800.5], [224.5, 765.5], [217.5, 754.5], [218.5, 735.5], [201.5, 675.5], [192.5, 603.5], [197.5, 353.5], [204.5, 296.5], [234.5, 257.5], [248.5, 249.5], [299.5, 255.5], [307.5, 211.5], [309.5, 142.5], [337.5, 107.5]];

describe('two bubbles drawn overlapping', () => {
  it('check names the outline joined, with a point in the lower bubble', () => {
    load({ kind: 'poly', pts: STEPPED }, [334, 184, 410, 524]);
    const joined = checksOf(['a']).flatMap((c) => c.issues).find((i) => i.kind === 'joined');
    expect(joined).toBeTruthy();
    expect(joined.detail.far[0]).toBeLessThan(330);
    expect(joined.detail.far[1]).toBeGreaterThan(420);
  });

  it('split cuts between them: the first part in the higher bubble, the second in the lower', async () => {
    load({ kind: 'poly', pts: STEPPED }, [334, 184, 410, 524]);
    const r = await call({ id: 'a', parts: ['Where are you going?', 'Wait for me!'] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.pieces.map((x) => x.bubble)).toEqual(['cut', 'cut']);
    const [first, second] = r.result.ids.map(box);
    expect(centreX(first)).toBeGreaterThan(centreX(second));
    expect(checksOf(r.result.ids).flatMap((c) => c.issues).some((i) => i.kind === 'joined')).toBe(false);
  });

  it('not a balloon with a tail, a spiky one or a cloud', async () => {
    const { farLobe } = await import('../../bubble-outline.js');
    const ring = (n, r) => Array.from({ length: n }, (_, k) => {
      const t = (k / n) * 2 * Math.PI;
      return [200 + r(t, k) * Math.cos(t) * 1.3, 200 + r(t, k) * Math.sin(t)];
    });
    const oval = ring(48, () => 80);
    const tail = oval.slice(0, 10).concat([[230, 330]], oval.slice(14));
    const spiky = ring(40, (t, k) => (k % 2 ? 60 : 95));
    const cloud = ring(120, (t) => 100 - 10 * Math.abs(Math.sin(t * 6)));
    for (const pts of [oval, tail, spiky, cloud]) expect(farLobe(pts, [180, 180, 220, 220])).toBeNull();
  });
});

describe('the pieces', () => {
  it('parts are the text\'s own words, capitals aside', () => {
    expect(partsOf('Hey you. Come here!', ['HEY YOU.', 'come here!'])).toEqual([
      { text: 'Hey you.', start: 0, end: 8 },
      { text: 'Come here!', start: 9, end: 19 },
    ]);
    expect(partsOf('Hey you. Come here!', ['Hey you.', 'Go away!'])).toBeNull();
  });

  it('reading order: the higher first, else the one to the right', () => {
    expect(readsFirst([100, 100], [100, 400])).toBe(true);
    expect(readsFirst([500, 200], [100, 220])).toBe(true);
    expect(readsFirst([100, 200], [500, 220])).toBe(false);
  });
});
