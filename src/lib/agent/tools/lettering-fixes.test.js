// The faults the two real-app runs found in the agent's tools, each fixed:
// outline_to_box keeps the size aimed for, an op's outcome is plain, a sizing
// change is an edit, an SFX is drawn over its original (place, match_original,
// the sound types), and a result names a box's sizes apart.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let seq = 1;
vi.mock('../../library.svelte.js', async (orig) => ({ ...(await orig()), chapterOpenSeq: () => seq }));
// The page images, as pictures made of numbers: the raw scan has a dark bar
// the cleaned page does not - the original SFX the cleaner took away.
const pictures = { raw: null, clean: null };
vi.mock('../render.js', async (orig) => ({
  ...(await orig()),
  regionPixels: vi.fn(async (p, rect, { source }) => ({ ...pictures[source], rect, scale: 1 })),
}));

const { app, loadProjectPages, pageById, settleEdits } = await import('../../store.svelte.js');
const { initHistory, resetHistory, undo } = await import('../../editor/history.svelte.js');
const { callContext, __resetRun } = await import('../run.svelte.js');
const { callTool } = await import('../registry.js');
const { bindTags, unbindTags } = await import('../../tags.svelte.js');
const { defaultStyle, normalizeStrokeEffect } = await import('../../data.js');
const { layOutNew } = await import('./place.js');
await import('./footprint.js');

const box = (id, lineN, extra = {}) => ({ id, lineN, text: null, x: 100, y: 100, w: 160, h: 60, style: { ...defaultStyle(), size: 20 }, ...extra });
const call = (args) => callTool('edit', args, callContext('mcp'));
const a = () => pageById(1).boxes.find((b) => b.id === 'a');

function picture(w, h, fill, bar = null) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...fill, 255], i * 4);
  if (bar) {
    const t = (bar.deg * Math.PI) / 180;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - bar.cx;
        const dy = y - bar.cy;
        if (Math.abs(dx * Math.cos(t) + dy * Math.sin(t)) <= bar.len / 2 && Math.abs(-dx * Math.sin(t) + dy * Math.cos(t)) <= bar.thick / 2) data.set([...bar.ink, 255], (y * w + x) * 4);
      }
    }
  }
  return { data, width: w, height: h };
}

beforeEach(() => {
  vi.useFakeTimers();
  seq = 1;
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.chapterMode = 'typeset';
  app.fonts = { user: [{ name: 'Anime Ace' }], builtin: [{ name: 'Comic Neue' }], system: [] };
  bindTags({ list: [{ name: 'narration', size: 26 }, { name: 'sfx', size: 64 }] });
  loadProjectPages([
    {
      id: 1, w: 800, h: 1200, raw: 'raw.png', cleaned: 'clean.png',
      lines: [
        { n: 1, en: 'Hello there friend', tags: [] },
        { n: 2, en: 'PLINK', tags: ['sfx'] },
        { n: 3, en: 'It was a long night.', tags: ['narration'] },
      ],
      detect: { boxes: [{ n: 2, box: [400, 600, 560, 640] }] },
      boxes: [box('a', 1), box('s', 2, { x: 300, y: 300, w: 300, h: 300, fit: { kind: 'ellipse', cx: 450, cy: 450, rx: 150, ry: 150 }, outline: { source: 'dark', confidence: 0.3, approved: null } }), box('n', 3, { y: 400 })],
    },
  ]);
  for (const b of pageById(1).boxes) b.auto = { on: true, refSize: 20, locks: { size: false, width: false, height: false, pos: false, breaks: false }, status: null, reason: null, stamp: null };
  initHistory();
  resetHistory();
  __resetRun();
});
afterEach(() => {
  settleEdits();
  resetHistory();
  __resetRun();
  unbindTags();
  app.chapterRef = null;
  loadProjectPages([]);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('outline_to_box', () => {
  it('makes the outline for the size the box aims for, with air, and says it is still shrunk', async () => {
    Object.assign(a().style, { size: 14, margin: 0.5 });
    const r = await call({ ops: [{ where: { ids: ['a'] }, do: 'outline_to_box' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const xs = a().fit.pts.map(([x]) => x);
    const ys = a().fit.pts.map(([, y]) => y);
    // 160 x 60 at 14 is 229 x 86 at 20, and half an em of air each side.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo((160 * 20) / 14 + 20, 0);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo((60 * 20) / 14 + 20, 0);
    // About the box's centre.
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(180, 0);
    // Nothing measures here, so the text is still at 14: said, with the size it aims for.
    expect(r.result.ops[0].shrunk.boxes).toEqual([{ id: 'a', size: 14, ref: 20 }]);
  });

  it('keeps a box sized by hand exactly', async () => {
    a().auto.locks.width = true;
    await call({ ops: [{ where: { ids: ['a'] }, do: 'outline_to_box' }] });
    const xs = a().fit.pts.map(([x]) => x);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([100, 260]);
  });
});

describe('an op says what it came to', () => {
  it('changed, nothing needed, refused, nothing matched', async () => {
    const r = await call({
      ops: [
        { where: { ids: ['a'] }, set: { style: { size: 30 } } },
        { where: { ids: ['a'] }, set: { style: { size: 30 } } },
        { where: { ids: ['a'] }, do: 'approve_outline' },
        { where: { pages: 'all', text: 'no such words' }, do: 'typeset' },
      ],
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.ops.map((o) => o.outcome)).toEqual(['changed', 'nothing needed', 'refused', 'nothing matched']);
    expect(r.result.ops[2].notApproved.count).toBe(1);
  });

  it('a sizing change alone is a change, and one undo takes it back', async () => {
    const r = await call({ ops: [{ where: { ids: ['a'] }, set: { sizing: { min: 15 } } }] });
    expect(r.result.ops[0]).toMatchObject({ changed: ['a'], outcome: 'changed' });
    expect(a().auto.minSize).toBe(15);
    undo();
    expect(a().auto.minSize).toBeUndefined();
  });
});

describe('an SFX is drawn over its original', () => {
  it('place draws an SFX line free on its detected block; speech keeps outline fit', () => {
    layOutNew(['s', 'a']);
    const s = pageById(1).boxes.find((b) => b.id === 's');
    expect(s.fit).toBeNull();
    expect(s.outline.open).toBe(true);
    expect(s.style.balloon).toBe(false);
    expect(s.style.margin).toBe(0);
    expect(s.x + s.w / 2).toBeCloseTo(480, 0);
    expect(s.y + s.h / 2).toBeCloseTo(620, 0);
    expect(a().style.margin).toBe(0.5);
  });

  it('match_original turns, sizes, places and colours a box over the original the cleaner removed', async () => {
    // The region round box s's detected line: a dark bar, 120 by 24, turned -20.
    pictures.clean = picture(200, 90, [250, 250, 250]);
    pictures.raw = picture(200, 90, [250, 250, 250], { cx: 100, cy: 45, len: 120, thick: 24, deg: -20, ink: [10, 10, 10] });
    const r = await call({ ops: [{ where: { ids: ['s'] }, do: 'match_original' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.ops[0].outcome).toBe('changed');
    const s = pageById(1).boxes.find((b) => b.id === 's');
    expect(s.fit).toBeNull();
    expect(s.style.margin).toBe(0);
    expect(s.style.rotation).toBeGreaterThanOrEqual(-22);
    expect(s.style.rotation).toBeLessThanOrEqual(-18);
    // Exactly the original's colours: its near-black, and no outline, as it had none.
    expect(s.style.color).toBe('#000000');
    expect(s.style.strokeEffects).toEqual([]);
    expect(s.style.gradient.on).toBe(false);
    // PLINK runs the bar's ~118 px at 118 / 2.75, no taller than its 24.
    expect(s.auto.refSize).toBe(24);
    expect(s.auto.locks.pos).toBe(true);
  });

  it('check names an SFX whose fill or outline is not its original\'s, until it is', async () => {
    pictures.clean = picture(200, 90, [120, 120, 120]);
    pictures.raw = picture(200, 90, [120, 120, 120], { cx: 100, cy: 45, len: 150, thick: 40, deg: 0, ink: [5, 5, 5] });
    const inner = picture(200, 90, [0, 0, 0], { cx: 100, cy: 45, len: 136, thick: 26, deg: 0, ink: [252, 252, 252] });
    for (let i = 0; i < inner.data.length; i += 4) if (inner.data[i] === 252) pictures.raw.data.set([252, 252, 252, 255], i);
    await import('./check.js');
    const check = () => callTool('check', { where: { ids: ['s'] } }, callContext('mcp'));
    const s = () => pageById(1).boxes.find((b) => b.id === 's');
    Object.assign(s().style, { color: '#ffd400', strokeEffects: [normalizeStrokeEffect({ size: 3, position: 'outside', color: '#ffffff', opacity: 1 })] });
    let r = await check();
    const issue = r.result.problems[0]?.issues.find((i) => i.kind === 'sfx_colour');
    expect(issue?.detail).toEqual({ fill: { want: '#ffffff', got: '#ffd400' }, outline: { want: '#000000', got: ['#ffffff'] } });
    await call({ ops: [{ where: { ids: ['s'] }, do: 'match_original' }] });
    expect(s().style.color).toBe('#ffffff');
    expect(s().style.strokeEffects[0].color).toBe('#000000');
    r = await check();
    expect(r.result.problems.flatMap((p) => p.issues).some((i) => i.kind === 'sfx_colour')).toBe(false);
  });

  it('check reads the colours under a box set apart from its line\'s block', async () => {
    // s sits at 300-600 by 300-600; its line's block (400-560 by 600-640) is
    // below it, not under it. Placed there on purpose, it is checked where it is.
    const { regionPixels } = await import('../render.js');
    regionPixels.mockClear();
    pictures.clean = picture(200, 90, [120, 120, 120]);
    pictures.raw = picture(200, 90, [120, 120, 120], { cx: 100, cy: 45, len: 150, thick: 40, deg: 0, ink: [5, 5, 5] });
    await import('./check.js');
    await callTool('check', { where: { ids: ['s'] } }, callContext('mcp'));
    const [x, y, w, h] = regionPixels.mock.calls.at(-1)[1];
    expect(x).toBeLessThanOrEqual(300);
    expect(y).toBeLessThanOrEqual(300);
    expect(x + w).toBeGreaterThanOrEqual(600);
    expect(y + h).toBeGreaterThanOrEqual(600);
  });

  it('match_original finds the original on a page whose images are not loaded yet', async () => {
    // A page names its images by file; the loaded pictures come and go.
    Object.assign(pageById(1), { raw: null, cleaned: null, file: 'raw.png', cleanedFile: 'clean.png' });
    pictures.clean = picture(200, 90, [250, 250, 250]);
    pictures.raw = picture(200, 90, [250, 250, 250], { cx: 100, cy: 45, len: 120, thick: 24, deg: -20, ink: [10, 10, 10] });
    const r = await call({ ops: [{ where: { ids: ['s'] }, do: 'match_original' }] });
    expect(r.result.ops[0].noOriginal).toBeUndefined();
    expect(r.result.ops[0].outcome).toBe('changed');
  });

  it('match_original leaves out a neighbour\'s words the cleaner removed too', async () => {
    // Line 1's dialogue sits in the region round s's line (page px 370-420 by
    // 590-640; the region starts at 360, 588): its letters are gone from the
    // cleaned page as well.
    pageById(1).detect.boxes.push({ n: 1, box: [370, 590, 420, 640] });
    const dialogue = (pic) => {
      for (let y = 4; y < 50; y++) for (let x = 12; x < 58; x++) pic.data.set([10, 10, 10, 255], (y * pic.width + x) * 4);
      return pic;
    };
    pictures.clean = picture(200, 90, [250, 250, 250]);
    // The SFX itself was left uncleaned: nothing of its own to match.
    pictures.raw = dialogue(picture(200, 90, [250, 250, 250]));
    let r = await call({ ops: [{ where: { ids: ['s'] }, do: 'match_original' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.ops[0].noOriginal.ids).toEqual(['s']);
    // A bar of its own beside the dialogue: centred on the bar, not pulled to the words.
    pictures.raw = dialogue(picture(200, 90, [250, 250, 250], { cx: 140, cy: 45, len: 80, thick: 20, deg: 0, ink: [10, 10, 10] }));
    r = await call({ ops: [{ where: { ids: ['s'] }, do: 'match_original' }] });
    expect(r.result.ops[0].outcome).toBe('changed');
    const s = pageById(1).boxes.find((b) => b.id === 's');
    expect(s.x + s.w / 2).toBeCloseTo(360 + 140, -1);
  });

  it('match_original with no cleaned original lays the box on its line and says so', async () => {
    pageById(1).cleaned = null;
    const r = await call({ ops: [{ where: { ids: ['s'] }, do: 'match_original' }] });
    expect(r.result.ops[0].noOriginal.ids).toEqual(['s']);
    const s = pageById(1).boxes.find((b) => b.id === 's');
    expect(s.x + s.w / 2).toBeCloseTo(480, 0);
  });

  it('the sound types need the Rust engine: on the browser engine they change nothing and say so', async () => {
    const before = JSON.stringify(pageById(1).boxes.find((b) => b.id === 's').style);
    for (const d of ['sfx_kind:impact', 'sfx_pick']) {
      const r = await call({ ops: [{ where: { ids: ['s'] }, do: d }] });
      expect(r.ok, d).toBe(false);
      expect(r.error).toMatch(/needs the Rust text engine/);
    }
    // clear_sfx on a box with no SFX is nothing to do, on any engine.
    const r = await call({ ops: [{ where: { ids: ['s'] }, do: 'clear_sfx' }] });
    expect(r.result.ops[0].outcome).toBe('nothing needed');
    // The old looks are gone.
    expect((await call({ ops: [{ where: { ids: ['s'] }, do: 'sfx_look:impact' }] })).ok).toBe(false);
    expect(JSON.stringify(pageById(1).boxes.find((b) => b.id === 's').style)).toBe(before);
  });
});

describe('sizes are named apart', () => {
  it('a narration box names the size it got, the size it aims for and its tag\'s size', async () => {
    const n = pageById(1).boxes.find((b) => b.id === 'n');
    n.style.size = 28;
    n.auto.refSize = 32;
    const { sizesOf } = await import('./check.js');
    expect(sizesOf(n, pageById(1))).toEqual({ size: 28, aimedFor: 32, tag: 'narration', tagSize: 26 });
  });
});

describe('words named in other capitals', () => {
  it('set.breaks takes lines in the face\'s capitals for mixed-case text', async () => {
    pageById(1).lines[0].en = 'And at long last';
    a().style.margin = 0.5;
    const r = await call({ ops: [{ where: { ids: ['a'] }, set: { breaks: ['AND AT', 'LONG LAST'] } }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(a().auto.breaks.at).toEqual([0, 7]);
  });

  it('sizes an upright original across, as long as the mean of its sides', async () => {
    const { sizeToCover } = await import('../../measure.js');
    const st = { ...defaultStyle(), size: 20 };
    expect(sizeToCover('RISE', st, 400, 100, { upright: true })).toBeCloseTo(sizeToCover('RISE', st, 200, 100), 6);
  });
});

describe('a dramatic line', () => {
  it('check names a line the original letters far bigger than its kind, until ours has the weight', async () => {
    const { checksOf } = await import('./edit.js');
    const lines = [1, 2, 3, 4].map((n) => ({ n, en: `Line ${n}.`, tags: ['narration'] }));
    loadProjectPages([
      {
        id: 1, w: 800, h: 1200, lines,
        // Three narration lines in letters about 44 px; the fourth in 170.
        detect: { boxes: lines.map(({ n }) => ({ n, box: [100, n * 200, 300, n * 200 + 100], font_size: n === 4 ? 170 : 44 })) },
        boxes: lines.map(({ n }) => box(`n${n}`, n, { y: n * 200, style: { ...defaultStyle(), size: 26 } })),
      },
    ]);
    const issue = () => checksOf(['n4']).flatMap((c) => c.issues).find((i) => i.kind === 'emphasis');
    expect(issue()?.detail).toEqual({ original: 3.9, ours: 1, tag: 'narration' });
    expect(checksOf(['n1']).flatMap((c) => c.issues).some((i) => i.kind === 'emphasis')).toBe(false);
    pageById(1).boxes.find((b) => b.id === 'n4').style.size = 56;
    expect(issue()).toBeUndefined();
  });
});
