// The agent's SFX tools on the real engine: the sound types listed and ranked
// (`sfx_kinds`), and edit's do "sfx_kind:<id>", "sfx_pick" and "clear_sfx",
// written through the store like any other edit.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rustEngine } from '../../../test/rust-engine.js';

let seq = 1;
vi.mock('../../library.svelte.js', async (orig) => ({ ...(await orig()), chapterOpenSeq: () => seq }));

const { textEngine, setTextEngine } = await import('../../text-engine/index.js');
const { clearLayoutMemo } = await import('../../measure.js');
const { app, loadProjectPages, pageById, settleEdits } = await import('../../store.svelte.js');
const { initHistory, resetHistory, undo } = await import('../../editor/history.svelte.js');
const { callContext, __resetRun } = await import('../run.svelte.js');
const { callTool } = await import('../registry.js');
const { defaultStyle } = await import('../../data.js');
const { sfxKinds, sfxPick, sfxPlacement } = await import('../../sfx.js');
const { isFenced } = await import('../fence.js');
await import('./read.js');
await import('./edit.js');

const defaultEngine = textEngine();
beforeAll(async () => {
  setTextEngine(await rustEngine());
  clearLayoutMemo();
});
afterAll(() => {
  setTextEngine(defaultEngine);
  clearLayoutMemo();
});

const box = (id, text, extra = {}) => ({
  id, lineN: null, text, x: 100, y: 100, w: 260, h: 120,
  style: { ...defaultStyle(), font: 'Bangers', size: 48, curve: 12 }, ...extra,
});
const edit = (ops) => callTool('edit', { ops }, callContext('mcp'));
const s = () => pageById(1).boxes.find((b) => b.id === 's');

beforeEach(() => {
  seq = 1;
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  app.chapterMode = 'typeset';
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('s', 'BOOM!!'), box('t', 'Caption?', { y: 400 })] }]);
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
  clearLayoutMemo();
});

describe('sfx_kinds', () => {
  it('lists every sound type with a one-line look, and changes nothing', async () => {
    const r = await callTool('sfx_kinds', {});
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.kinds.map((k) => k.id)).toEqual(sfxKinds().map((k) => k.id));
    expect(r.result.kinds).toHaveLength(12);
    for (const k of r.result.kinds) {
      expect(Object.keys(k)).toEqual(['id', 'name', 'example', 'tag', 'dir', 'look']);
      expect(k.look).toMatch(/letters.*, (a (thin )?\w+ rim|[\w ]+ rims|no rim), (sharp|round) corners$/);
    }
    expect(r.result.pick).toBeUndefined();
  });

  it('ranks the types for a box or a text, as the app\'s auto pick does', async () => {
    const byBox = (await callTool('sfx_kinds', { id: 's' })).result.pick;
    expect(byBox).toEqual({ id: 's', order: sfxPick('BOOM!!').order, strength: sfxPick('BOOM!!').strength });
    expect(byBox.order).toHaveLength(12);
    const byText = (await callTool('sfx_kinds', { text: 'ドン!!' })).result.pick;
    expect(isFenced(byText.text)).toBe(true);
    expect(byText.order[0]).toBe(sfxPick('ドン!!').order[0]);
    const both = await callTool('sfx_kinds', { id: 's', text: 'x' });
    expect(both.ok).toBe(false);
  });
});

describe('edit: sound types', () => {
  it('sfx_kind lays the box out as that type, in its look, one undo step', async () => {
    const before = JSON.stringify(s().style);
    const r = await edit([{ where: { ids: ['s'] }, do: 'sfx_kind:impact' }]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.ops[0].changed).toEqual(['s']);
    expect(s().style.sfx).toMatchObject({ on: true, kind: 'impact' });
    // SFX is one glyph layout among four: the arc it replaces is off.
    expect(s().style.curve).toBe(0);
    expect(s().style.strokes.length).toBeGreaterThan(0);
    expect(sfxPlacement('BOOM!!', s().style, 48)?.letters.length).toBeGreaterThan(0);
    // By name too, any case; again is nothing needed.
    expect((await edit([{ where: { ids: ['s'] }, do: 'sfx_kind:IMPACT' }])).result.ops[0].outcome).toBe('nothing needed');
    undo();
    expect(JSON.stringify(s().style)).toBe(before);
  });

  it('an unknown type changes nothing and names the close ones', async () => {
    const r = await edit([{ where: { ids: ['s'] }, do: 'sfx_kind:rumbel' }]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no sound type "rumbel"/);
    expect(r.hint).toMatch(/Rumble/);
    expect(s().style.sfx.on).toBe(false);
  });

  it('sfx_pick applies the best type for each box\'s own text, at the strength it asks for', async () => {
    const r = await edit([{ where: { ids: ['s', 't'] }, do: 'sfx_pick' }]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    for (const [id, text] of [['s', 'BOOM!!'], ['t', 'Caption?']]) {
      const b = pageById(1).boxes.find((x) => x.id === id);
      const pick = sfxPick(text);
      expect(b.style.sfx).toMatchObject({ on: true, kind: pick.order[0] });
      expect(b.style.sfx.strength).toBeCloseTo(Math.min(2, Math.max(0, pick.strength)), 5);
    }
  });

  it('field edits tune the type; the type and SFX itself go through the actions', async () => {
    await edit([{ where: { ids: ['s'] }, do: 'sfx_kind:rumble' }]);
    const r = await edit([{ where: { ids: ['s'] }, set: { style: {
      sfx: { seed: 77, strength: 1.4, paths: [{ a: [-2, 0], b: [2, -1], bend: 0.3 }], caption: { text: 'rumble' } },
      shake: { on: true },
    } } }]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(s().style.sfx).toMatchObject({ kind: 'rumble', seed: 77, strength: 1.4, caption: { text: 'rumble' } });
    expect(s().style.sfx.paths).toHaveLength(1);
    expect(s().style.shake.on).toBe(true);
    // The box read fences the caption: it is the user's translation.
    const read = await callTool('box', { id: 's' });
    expect(isFenced(read.result.style.sfx.caption.text)).toBe(true);

    for (const sfx of [{ kind: 'impact' }, { on: false }]) {
      const bad = await edit([{ where: { ids: ['s'] }, set: { style: { sfx } } }]);
      expect(bad.ok).toBe(false);
      expect(bad.hint).toMatch(/sfx_kind/);
    }
    // A new type keeps the seed, strength and caption.
    await edit([{ where: { ids: ['s'] }, do: 'sfx_kind:slash' }]);
    expect(s().style.sfx).toMatchObject({ kind: 'slash', seed: 77, strength: 1.4, caption: { text: 'rumble' } });
  });

  it('clear_sfx puts back the look and the bends SFX wrote over', async () => {
    const look = JSON.stringify([s().style.color, s().style.strokes, s().style.curve]);
    await edit([{ where: { ids: ['s'] }, do: 'sfx_kind:explosion' }]);
    expect(s().style.negative.on).toBe(true);
    const r = await edit([{ where: { ids: ['s'] }, do: 'clear_sfx' }]);
    expect(r.result.ops[0].changed).toEqual(['s']);
    expect(s().style.sfx.on).toBe(false);
    expect(s().style.negative.on).toBe(false);
    expect(JSON.stringify([s().style.color, s().style.strokes, s().style.curve])).toBe(look);
    expect((await edit([{ where: { ids: ['s'] }, do: 'clear_sfx' }])).result.ops[0].outcome).toBe('nothing needed');
  });
});
