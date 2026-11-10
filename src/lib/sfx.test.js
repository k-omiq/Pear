import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { defaultStyle, normalizeStyle, normalizeSfx, applyBoxDefaults, SFX_MAX_GROUPS, strokesFromBands, outlineBands } from './data.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { clearLayoutMemo } from './measure.js';
import { placeBlock, curvedStyle, isAutoBox, manualReason, turnedInk, boxInkRect, REVIEW_REASONS } from './contain.js';
import { glyphJob } from './exporter.js';
import { isRasterOnly } from './psd.js';
import { boxShadows, effectShadows, strokeReach, strokeExtent } from './text-paint.js';
import {
  sfxActive, sfxAvailable, sfxLayout, sfxKinds, sfxKind, sfxPick, sfxParams, sfxResolved, sfxEdits,
  applySfxKind, clearSfx, enableSfx, rebaseSfx, sfxPlacement,
  sfxHit, sfxTurn, sfxScale, sfxMove, sfxBendFor, sfxCurve, bendHandle, bendFor, sfxOutline,
} from './sfx.js';

// ===========================================================================
// SFX lettering: the style model, the glue to the engine, the effects
// ===========================================================================
// The Rust engine lays SFX out, and the unit lane has none, so these tests
// bring an engine of arithmetic: it measures the stand-in way and answers
// `sfxPlace` with a layout it can be checked against. The real one is
// exercised in sfx.engine.test.js.

const KINDS = [
  {
    id: 'impact', name: 'Impact', example: 'ドン', tag: 'no-such-tag', dir: 'h',
    flow: { from: 1, to: 1.4, pow: 1 }, follow: 0.6, gap: -0.05, slant: 0, rise: 0,
    jitter: { rot: 4, size: 0.1, off: 0.05 },
  },
  {
    id: 'small', name: 'Small', example: 'コソ', tag: 'no-such-tag', dir: 'v',
    flow: { from: 1, to: 1, pow: 1 }, follow: 0.2, gap: 0.1, slant: 5, rise: 0,
    jitter: { rot: 0, size: 0, off: 0 },
  },
];
const CALLS = [];
function fakeEngine({ sfx = true } = {}) {
  const ink = (face, text) => ({ width: [...text].length * face.size * 0.55, left: 0, right: [...text].length * face.size * 0.55, ascent: face.size * 0.7, descent: face.size * 0.2 });
  const e = {
    id: sfx ? 'rust' : 'browser',
    advance: (face, text) => [...text].length * face.size * 0.55,
    fontBox: (face) => ({ ascent: face.size * 0.8, descent: face.size * 0.2 }),
    lineInk: ink,
    // Offsets from a centred, middle-baseline anchor: left/right are the
    // distances to either side (measure.js negates left), as the engine gives.
    glyphInk: (face) => ({ width: face.size * 0.55, left: face.size * 0.25, right: face.size * 0.25, ascent: face.size * 0.4, descent: face.size * 0.4 }),
    loading: () => false,
    onFontsChange: () => () => {},
    faceReady: () => true,
  };
  if (sfx) {
    e.sfxKinds = () => ({ kinds: KINDS });
    e.sfxPick = (text) => ({ order: /ン/.test(text) ? ['impact', 'small'] : ['small', 'impact'], scores: [0.9, 0.1], power: 60, rough: 55, momentum: 52 });
    // Fills what is unset from the type (or plain), as the engine does; the
    // macros are left out here, the engine's own tests have them.
    e.sfxResolve = (p) => {
      const k = KINDS.find((x) => x.id === p.kind) ?? {};
      const or = (v, d) => (v == null ? d : v);
      return {
        vertical: p.vertical == null ? k.dir === 'v' : p.vertical,
        flow: p.flow ?? k.flow ?? { from: 1, to: 1, pow: 1 },
        follow: or(p.follow, k.follow ?? 0.5),
        gap: or(p.gap, k.gap ?? 0),
        bigTighter: or(p.bigTighter, 0.5),
        slant: or(p.slant, k.slant ?? 0),
        rise: or(p.rise, k.rise ?? 0),
        jitter: p.jitter ?? k.jitter ?? { rot: 0, size: 0, off: 0 },
      };
    };
    // The handles' maths answer with what they were handed, so a test can
    // see that sfx.js forwards and does no sums of its own.
    for (const name of ['sfxHit', 'sfxTurn', 'sfxScale', 'sfxMove', 'sfxBendFor', 'sfxCurve', 'sfxOutline']) {
      e[name] = (...args) => {
        CALLS.push({ name, args });
        if (name === 'sfxHit') return 7;
        if (name === 'sfxCurve') return { ctrl: [1, 2], mid: [3, 4] };
        if (name === 'sfxOutline') return 'M0 0L1 0L1 1Z';
        return name;
      };
    }
    // A letter for each code point but spaces, newlines and `/`, a step to
    // the right and a step bigger than the one before; a run of long bars is
    // one letter, as the engine joins them.
    // `cp` names, per code point, the letter that draws it.
    e.sfxPlace = (face, text, params) => {
      CALLS.push({ face, text, params });
      const letters = [];
      const cp = [];
      let u = 0;
      let i = 0;
      for (const ch of text) {
        const last = letters.at(-1);
        if (ch === 'ー' && last && last.end === u && text.slice(last.start, last.end).endsWith('ー')) {
          last.end += ch.length;
          cp.push(-1);
        } else if (!/[\s/]/.test(ch)) {
          const quad = [[i * 10 - 4, -5], [i * 10 + 4, -5], [i * 10 + 4, 5], [i * 10 - 4, 5]];
          letters.push({
            x: i * 10, y: 0, rot: 0.1, sx: 1 + i * 0.5, sy: 1, skew: 0.2, start: u, end: u + ch.length, group: 0, index: i,
            dir: [1, 0], em: face.size, adv: face.size * 0.55, unit: face.size, quad, centre: [i * 10, 0], pen: 1 + i,
          });
          cp.push(i);
          i++;
        } else cp.push(-1);
        u += ch.length;
      }
      return { paths: [{ a: [-1, 0], b: [1, 0], bend: 0, ctrl: [0, 0], mid: [0, 0] }], bounds: [-10, -10, i * 10, 10], letters, cp };
    };
  }
  return e;
}

const original = textEngine();
beforeEach(() => {
  CALLS.length = 0;
  setTextEngine(fakeEngine());
  clearLayoutMemo();
});
afterEach(() => {
  setTextEngine(original);
  clearLayoutMemo();
});

const sfxStyle = (over = {}) => {
  const s = defaultStyle();
  s.size = 20;
  s.sfx = normalizeSfx({ on: true, kind: 'impact', seed: 3 });
  return Object.assign(s, over);
};
const cand = (style, text = 'BOOM') => ({ x: 0, y: 0, w: 200, h: 100, style, text, fit: null });

describe('the sfx field of a style', () => {
  it('is off, with no type, paths or edits, in a new style and in an old chapter', () => {
    for (const s of [defaultStyle(), normalizeStyle({})]) {
      expect(s.sfx).toMatchObject({ on: false, kind: null, seed: 1, power: 50, rough: 50, momentum: 50, paths: [], glyphs: {}, before: null });
      expect(s.sfx.caption).toEqual({ text: '', side: 'below', size: 0.3, color: '#111111' });
    }
  });

  it('round-trips a good recipe', () => {
    const x = {
      on: true, kind: 'impact', seed: 42, power: 75, rough: 20, momentum: 60, dir: 'v', joinBars: false, kern: false,
      flow: { from: 0.8, to: 2, pow: 1.5 }, follow: 0.3, gap: 0.2, bigTighter: 0.4, slant: -10, rise: 5,
      jitter: { rot: 10, size: 0.2, off: 0.1 },
      paths: [{ a: [-1, 0.5], b: [1.5, -0.5], bend: 0.3 }],
      glyphs: { '0:2': { dx: 0.1, dy: -0.2, rot: 15, s: 1.2 } },
      caption: { text: 'boom', side: 'right', size: 0.5, color: '#ff0000' },
      before: { curve: 10, circle: false, path: true },
    };
    expect(normalizeSfx(x)).toEqual(x);
    expect(normalizeSfx(JSON.parse(JSON.stringify(normalizeSfx(x))))).toEqual(x);
  });

  it('repairs every field it can and drops what it cannot', () => {
    const s = normalizeSfx({
      on: 'yes', kind: '', seed: 0, power: 900, rough: -5, momentum: 'x', dir: 'up', flow: { from: 0, to: 'x' }, follow: 3, gap: NaN,
      slant: 90, rise: -90, jitter: { rot: 99 },
      paths: [{ a: [0, 0] }, { a: [0, 0], b: [1, Infinity] }, { a: [0, 0], b: [1, 1], bend: 7 }],
      glyphs: { bad: { dx: 1 }, '1:1': { dx: 0, dy: 0, rot: 0, s: 1 }, '0:0': { dx: 50, s: 0 } },
      caption: { text: 3, side: 'middle', size: 5, color: 'red' },
    });
    expect(s).toMatchObject({ on: false, kind: null, seed: 1, power: 100, rough: 0, momentum: 50, dir: null, follow: 1, gap: null, slant: 45, rise: -30 });
    expect(s.flow).toEqual({ from: 0.1, to: 1, pow: 1 });
    expect(s.jitter).toEqual({ rot: 45, size: 0, off: 0 });
    // A path with an end missing or not a number is dropped; a bend clamped.
    expect(s.paths).toEqual([{ a: [0, 0], b: [1, 1], bend: 2 }]);
    // A key that is no letter, and an edit that moves nothing, are dropped.
    expect(s.glyphs).toEqual({ '0:0': { dx: 20, dy: 0, rot: 0, s: 0.1 } });
    expect(s.caption).toEqual({ text: '', side: 'below', size: 1, color: '#111111' });
  });

  it('reads a recipe saved with one strength as all three dials', () => {
    expect(normalizeSfx({ strength: 1.5 })).toMatchObject({ power: 75, rough: 75, momentum: 75 });
    expect(normalizeSfx({ strength: 0 })).toMatchObject({ power: 0, rough: 0, momentum: 0 });
    expect('strength' in normalizeSfx({ strength: 1.5 })).toBe(false);
  });

  it('keeps at most one path per group the engine lays out', () => {
    const p = { a: [0, 0], b: [1, 0], bend: 0 };
    expect(normalizeSfx({ paths: Array.from({ length: 9 }, () => p) }).paths).toHaveLength(SFX_MAX_GROUPS);
  });

  it('is plain text again on a newborn box', () => {
    const s = applyBoxDefaults(sfxStyle());
    expect(s.sfx.on).toBe(false);
    expect(s.sfx.kind).toBe(null);
  });
});

// Decision D4 (docs/giongo): a box saved by the move-based SFX opens as the
// closest sound type, laid out fresh, with its own gaps and the look it has.
describe('an SFX box from before the sound types', () => {
  const old = (over = {}) => ({ on: true, amount: 1.2, seed: 77, flow: 'row', rowShift: 0.5, moves: [{ kind: 'tilt', a: 0, b: 0 }], ...over });

  it('opens as the closest type, with its seed', () => {
    expect(normalizeSfx(old())).toMatchObject({ on: true, kind: 'impact', seed: 77, power: 50, rough: 50, momentum: 50, paths: [], glyphs: {} });
    expect(normalizeSfx(old({ flow: 'stack' })).kind).toBe('small');
    expect(normalizeSfx(old({ on: false })).on).toBe(false);
    expect(normalizeSfx({ amount: 1 }).kind).toBe('impact');
  });

  it('gets its own gaps back, and Remove SFX its bends', () => {
    const s = normalizeStyle({
      ...defaultStyle(), letterSpacing: -8, lineHeight: 0.7, color: '#123456',
      sfx: old({ before: { letterSpacing: 2, lineHeight: 1.3, curve: 25, circle: true, path: false } }),
    });
    expect(s.letterSpacing).toBe(2);
    expect(s.lineHeight).toBe(1.3);
    expect(s.color).toBe('#123456');
    expect(s.sfx.before).toEqual({ curve: 25, circle: true, path: false });
    clearSfx(s);
    expect(s.curve).toBe(25);
    expect(s.circle.on).toBe(true);
    expect(s.color).toBe('#123456');
    expect(s.sfx.on).toBe(false);
  });

  it('is left as it is when it was off', () => {
    const s = normalizeStyle({ ...defaultStyle(), letterSpacing: -8, sfx: old({ on: false, before: { letterSpacing: 2 } }) });
    expect(s.letterSpacing).toBe(-8);
    expect(s.sfx.before).toBe(null);
  });
});

describe('the effects of a style', () => {
  it('default to none, and normalise to their ranges', () => {
    const d = defaultStyle();
    expect(d).toMatchObject({ strokeOrder: 'merged', strokeJoin: 'round', strokeShade: 0 });
    for (const k of ['negative', 'extrude', 'shake', 'trail']) expect(d[k].on).toBe(false);
    const s = normalizeStyle({
      ...d, strokeOrder: 'zigzag', strokeJoin: 'miter', strokeShade: 4,
      negative: { on: true, grow: 9 }, extrude: { on: true, length: -1, edge: 'nope' },
      shake: { on: true, count: 10, amp: 3 }, trail: { on: true, count: 0, dist: 5 },
    });
    expect(s).toMatchObject({ strokeOrder: 'merged', strokeJoin: 'miter', strokeShade: 1 });
    expect(s.negative).toEqual({ on: true, grow: 1, color: '#111111' });
    expect(s.extrude).toMatchObject({ on: true, length: 0, edge: '' });
    expect(s.shake).toMatchObject({ count: 4, amp: 1 });
    expect(s.trail).toEqual({ on: true, count: 1, dist: 2 });
  });

  it('cast nothing while SFX is off', () => {
    const s = sfxStyle({ strokeShade: 0.5, shake: { on: true, count: 2, amp: 0.1, angle: 0 }, extrude: { on: true, angle: 90, length: 0.3, color: '#ff0000', edge: '#000000' } });
    s.sfx.on = false;
    expect(effectShadows(s)).toEqual({ top: [], under: [] });
    expect(boxShadows(s)).toBe(s.shadows);
  });

  it('cast the shade and the shake on top of the box’s own shadows, the extrude under', () => {
    const own = { color: '#00ff00', opacity: 1, x: 1, y: 1, blur: 0 };
    const s = sfxStyle({
      size: 30, strokeShade: 0.5, shadows: [own],
      shake: { on: true, count: 2, amp: 0.1, angle: 0 },
      extrude: { on: true, angle: 90, length: 0.3, color: '#ff0000', edge: '#0000ff' },
    });
    const { top, under } = effectShadows(s);
    expect(boxShadows(s)).toEqual([...top, own, ...under]);
    // Every copy is laid at its exact throw; the box's own shadow is not
    // marked, so the engine lays it on whole pixels as Photoshop does.
    expect([...top, ...under].every((sh) => sh.exact === true)).toBe(true);
    expect(own.exact).toBeUndefined();
    // The shade, then the shake's copies each side.
    expect(top).toHaveLength(1 + 2 * 2);
    expect(top[1].x).toBeCloseTo(1.5);
    expect(top[2].x).toBeCloseTo(-1.5);
    // 9 px of extrude straight down, a step every 1.5 px, then the edge.
    const steps = under.filter((x) => x.color === '#ff0000');
    expect(steps).toHaveLength(6);
    expect(steps.at(-1).x).toBeCloseTo(0);
    expect(steps.at(-1).y).toBeCloseTo(9);
    expect(under.filter((x) => x.color === '#0000ff').every((x) => x.grow === 1)).toBe(true);
  });

  it('a negative reaches past the strokes, and an SFX box reaches half as far again', () => {
    const s = sfxStyle({ size: 20, strokeEffects: strokesFromBands([{ color: '#fff', width: 4, opacity: 1 }]), negative: { on: true, grow: 0.5, color: '#000000' } });
    expect(strokeReach(s)).toBeCloseTo((strokeExtent(outlineBands(s)) + 10) * 1.5);
    s.sfx.on = false;
    expect(strokeReach(s)).toBeCloseTo(strokeExtent(outlineBands(s)));
  });
});

describe('applying a sound type', () => {
  it('refuses a type the engine does not know', () => {
    const s = defaultStyle();
    expect(applySfxKind(s, 'nope')).toBe(false);
    expect(s.sfx.on).toBe(false);
  });

  it('writes the type and SFX on, keeps only the seed and the caption, and resets the rest as a preset click', () => {
    const s = defaultStyle();
    s.size = 40;
    s.curve = 30;
    s.path.on = true;
    const path = { a: [-1, 0], b: [1, -0.5], bend: 0.2 };
    s.sfx = normalizeSfx({
      seed: 9, power: 80, rough: 10, momentum: 70, slant: 20, kern: false, joinBars: false, dir: 'v',
      paths: [path], caption: { text: 'bang' },
    });
    expect(applySfxKind(s, 'impact')).toBe(true);
    expect(s.sfx).toMatchObject({
      on: true, kind: 'impact', seed: 9, power: 50, rough: 50, momentum: 50, slant: null, dir: null,
      kern: true, joinBars: true, paths: [], glyphs: {},
    });
    expect(s.sfx.caption.text).toBe('bang');
    expect(s.sfx.before).toEqual({ curve: 30, circle: false, path: true });
    expect(s.curve).toBe(0);
    expect(s.path.on).toBe(false);
  });

  it('is a layout only: the font, the fill and the outlines stay the box’s own', () => {
    const s = defaultStyle();
    s.color = '#336699';
    s.strokeEffects = strokesFromBands([{ color: '#ff0000', width: 3, opacity: 1 }]);
    const look = (st) => JSON.stringify([st.font, st.color, st.strokeEffects, st.pattern, st.gradient, st.negative, st.strokeJoin, st.noFill]);
    const was = look(s);
    applySfxKind(s, 'impact');
    expect(look(s)).toBe(was);
    applySfxKind(s, 'small');
    expect(look(s)).toBe(was);
  });

  it('takes the letters’ hand edits and the drawn paths off, so they follow the new type', () => {
    const s = defaultStyle();
    applySfxKind(s, 'impact');
    s.sfx.glyphs = { '0:1': { dx: 0.5, dy: 0, rot: 20, s: 1.2 } };
    s.sfx.paths = [{ a: [-1, 0], b: [1, 0], bend: 0.3 }];
    s.sfx.follow = 0.9;
    s.sfx.power = 90;
    applySfxKind(s, 'small');
    expect(s.sfx.glyphs).toEqual({});
    expect(s.sfx.paths).toEqual([]);
    expect(s.sfx.follow).toBe(null);
    expect(s.sfx.power).toBe(50);
    // The before is the one taken when SFX went on, not the first type's.
    expect(s.sfx.before).toEqual({ curve: 0, circle: false, path: false });
  });

  it('puts the box’s own bends back on Remove, after any number of types', () => {
    const s = defaultStyle();
    s.circle.on = true;
    applySfxKind(s, 'impact');
    applySfxKind(s, 'small');
    // Through a save and a load, and an undo snapshot.
    const back = normalizeStyle(JSON.parse(JSON.stringify(s)));
    clearSfx(back);
    expect(back.circle.on).toBe(true);
    expect(back.sfx).toMatchObject({ on: false, before: null, kind: 'small' });
  });

  it('gives back the look a first-build SFX box saved, on Remove', () => {
    const s = defaultStyle();
    s.color = '#123456';
    applySfxKind(s, 'impact');
    const saved = JSON.parse(JSON.stringify(s));
    saved.color = '#ffffff';
    saved.sfx.before.look = { color: '#123456' };
    const back = normalizeStyle(saved);
    clearSfx(back);
    expect(back.color).toBe('#123456');
    expect(back.sfx.before).toBe(null);
  });

  it('leaves the bends to a caller that is switching one on', () => {
    const s = defaultStyle();
    s.curve = 25;
    applySfxKind(s, 'impact');
    s.path.on = true;
    clearSfx(s, true);
    expect(s.curve).toBe(0);
    expect(s.path.on).toBe(true);
  });

  it('enableSfx switches the other glyph layouts off', () => {
    const s = defaultStyle();
    s.curve = 10;
    s.circle.on = true;
    s.path.on = true;
    enableSfx(s);
    expect([s.sfx.on, s.curve, s.circle.on, s.path.on]).toEqual([true, 0, false, false]);
  });

  it('a pasted recipe puts back this box’s path switch, not the copied one’s', () => {
    const s = sfxStyle();
    s.sfx.before = { curve: 0, circle: false, path: true };
    s.path.on = false;
    rebaseSfx(s);
    expect(s.sfx.before.path).toBe(false);
  });
});

describe('the recipe the engine is handed', () => {
  it('asks the engine for every layout number, the box’s null ones filled from the type', () => {
    const r = sfxResolved(normalizeSfx({ kind: 'small', gap: 0.5 }));
    expect(r).toEqual({ vertical: true, flow: KINDS[1].flow, follow: 0.2, gap: 0.5, bigTighter: 0.5, slant: 5, rise: 0, jitter: KINDS[1].jitter });
    // No type: the plain values.
    expect(sfxResolved(normalizeSfx({ dir: 'v' })).vertical).toBe(true);
    expect(sfxResolved(normalizeSfx({})).flow).toEqual({ from: 1, to: 1, pow: 1 });
    // Without the engine there is nothing to say.
    setTextEngine(fakeEngine({ sfx: false }));
    expect(sfxResolved(normalizeSfx({ kind: 'small' }))).toBe(null);
  });

  it('hands the box’s nulls over as nulls: no type default is copied in JS', () => {
    const p = sfxParams(normalizeSfx({ kind: 'small', gap: 0.5, power: 70 }));
    expect(p).toMatchObject({
      kind: 'small', vertical: null, flow: null, follow: null, gap: 0.5, bigTighter: null, slant: null, rise: null,
      jitter: null, power: 70, rough: 50, momentum: 50,
    });
    expect('strength' in p).toBe(false);
    expect(sfxParams(normalizeSfx({ dir: 'h' })).vertical).toBe(false);
  });

  it('passes the hand edits by group and letter, and a type only when the engine knows it', () => {
    expect(sfxEdits({ '1:3': { dx: 0.5, dy: 0, rot: 10, s: 2 } })).toEqual([{ group: 1, index: 3, dx: 0.5, dy: 0, rot: 10, scale: 2 }]);
    const p = sfxParams(normalizeSfx({ kind: 'gone', seed: 5, kern: false }));
    expect(p).toMatchObject({ kind: null, seed: 5, kern: false, joinBars: true, paths: [], edits: [] });
  });
});

describe('under the browser engine SFX is inert', () => {
  beforeEach(() => {
    setTextEngine(fakeEngine({ sfx: false }));
    clearLayoutMemo();
  });

  it('is not available and never active', () => {
    expect(sfxAvailable()).toBe(false);
    expect(sfxActive(sfxStyle())).toBe(false);
    expect(sfxLayout('BOOM', sfxStyle(), 20)).toEqual([]);
    expect(sfxKinds()).toEqual([]);
    expect(sfxKind('impact')).toBe(null);
    expect(sfxPick('ドン')).toBe(null);
    expect(applySfxKind(defaultStyle(), 'impact')).toBe(false);
  });

  it('is not available with no engine at all', () => {
    setTextEngine(null);
    expect(sfxAvailable()).toBe(false);
    expect(sfxActive(sfxStyle())).toBe(false);
  });

  it('places an SFX box exactly as the same style with the switch off', () => {
    for (const text of ['BOOM', 'GR\nIP!', '']) {
      const on = placeBlock(cand(sfxStyle(), text));
      const off = placeBlock(cand(sfxStyle({ sfx: { ...sfxStyle().sfx, on: false } }), text));
      expect(on.isCurve).toBe(false);
      expect({ ...on, s: null }).toEqual({ ...off, s: null });
    }
    expect(curvedStyle(sfxStyle())).toBe(false);
    expect(isAutoBox(cand(sfxStyle()))).toBe(true);
    expect(isRasterOnly(sfxStyle())).toBe(false);
  });

  it('keeps an arc an arc', () => {
    const arc = placeBlock(cand(sfxStyle({ curve: 40 })));
    expect(arc.isCurve).toBe(true);
    expect(arc.layout.every((g) => g.sx === undefined)).toBe(true);
  });
});

describe('sfxActive and the type table', () => {
  it('wants the switch and an engine that can', () => {
    expect(sfxActive(sfxStyle())).toBe(true);
    expect(sfxActive(sfxStyle({ sfx: { ...sfxStyle().sfx, on: false } }))).toBe(false);
    expect(sfxActive({})).toBe(false);
    expect(sfxActive(null)).toBe(false);
  });

  it('asks the engine once and keeps its table', () => {
    const spy = vi.spyOn(textEngine(), 'sfxKinds');
    expect(sfxKinds().map((k) => k.id)).toEqual(['impact', 'small']);
    expect(sfxKind('small').dir).toBe('v');
    expect(sfxKinds()).toBe(sfxKinds());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('ranks the types for a sound', () => {
    expect(sfxPick('ドン').order[0]).toBe('impact');
    expect(sfxPick('コソ').order[0]).toBe('small');
    textEngine().sfxPick = () => {
      throw new Error('no');
    };
    expect(sfxPick('x')).toBe(null);
  });

  // The table is kept by the engine that gave it: kept beside the last one,
  // switching Rust off would leave the Rust engine, and all of its wasm
  // memory, held for as long as the app ran.
  it('does not keep alive an engine the app has let go of', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc');
    let ref;
    (() => {
      const e = fakeEngine();
      ref = new WeakRef(e);
      setTextEngine(e);
      expect(sfxKinds()).toHaveLength(2);
    })();
    setTextEngine(fakeEngine({ sfx: false }));
    expect(sfxKinds()).toEqual([]);
    clearLayoutMemo();
    await new Promise((r) => setTimeout(r, 0));
    gc();
    expect(ref.deref()).toBeUndefined();
  });
});

describe('placeBlock with the Rust engine', () => {
  it('lays an SFX box out glyph by glyph, before the arc, the ring and the path', () => {
    const s = sfxStyle({ curve: 50 });
    s.circle.on = true;
    const p = placeBlock(cand(s));
    expect(p.isCurve).toBe(true);
    expect(p.layout.map((g) => g.ch)).toEqual([...'BOOM']);
    for (const g of p.layout) for (const k of ['x', 'y', 'rot', 'sx', 'sy', 'skew', 'w', 'em', 'pen']) expect(Number.isFinite(g[k])).toBe(true);
  });

  it('is a manual box, never fitted', () => {
    const c = cand(sfxStyle());
    expect(curvedStyle(c.style)).toBe(true);
    expect(isAutoBox(c)).toBe(false);
    expect(manualReason(c)).toBe(REVIEW_REASONS.curve);
    expect(isRasterOnly(c.style)).toBe(true);
  });

  it('hands the engine the face at the size, the text and the resolved recipe, once', () => {
    const s = sfxStyle({ size: 20 });
    s.sfx.glyphs = { '0:1': { dx: 0.5, dy: 0, rot: 0, s: 1 } };
    sfxLayout('GR\nIP!', s, 40);
    sfxLayout('GR\nIP!', s, 40);
    expect(CALLS).toHaveLength(1);
    const { face, text, params } = CALLS[0];
    expect(face.size).toBe(40);
    expect(text).toBe('GR\nIP!');
    expect(params).toMatchObject({ kind: 'impact', seed: 3, vertical: null, follow: null, edits: [{ group: 0, index: 1, dx: 0.5, dy: 0, rot: 0, scale: 1 }] });
    s.sfx.seed = 4;
    sfxLayout('GR\nIP!', s, 40);
    expect(CALLS).toHaveLength(2);
  });

  it('keeps one entry per code point, what draws nothing empty where the letter before it is', () => {
    const l = sfxLayout('GR\nIーー!', sfxStyle(), 20);
    expect(l.map((g) => g.ch)).toEqual(['G', 'R', '', 'I', 'ーー', '', '!']);
    expect(l[2]).toEqual({ ch: '', x: l[1].x, y: l[1].y, rot: l[1].rot, sx: 1, sy: 1, skew: 0, w: 0, drip: 0 });
    // The pen is the engine's, as the letter carries it.
    expect(l[4]).toMatchObject({ group: 0, index: 3, dir: [1, 0], em: 20, pen: 4 });
    expect(sfxLayout('', sfxStyle(), 20)).toEqual([]);
    expect(placeBlock(cand(sfxStyle(), '   ')).isCurve).toBe(false);
  });

  it('is the plain block when the engine refuses the recipe', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    textEngine().sfxPlace = () => {
      throw new Error('BadSpec');
    };
    expect(sfxLayout('BOOM', sfxStyle({ size: 21 }), 21)).toEqual([]);
    const p = placeBlock(cand(sfxStyle({ size: 22 })));
    expect(p.isCurve).toBe(false);
    expect(p.lines).toEqual(['BOOM']);
    // Said once for the whole session, not once a frame.
    expect(err.mock.calls.length).toBeLessThanOrEqual(1);
    err.mockRestore();
  });
});

describe('the glyph job of an SFX box', () => {
  const layoutOf = (s, text = 'BOOM') => ({ ...placeBlock(cand(s, text)), ox: 0, oy: 0 });

  it('puts the scale, the lean and the pen on each run, and only on the SFX ones', () => {
    const s = sfxStyle();
    const layout = { s, ox: 0, oy: 0, isCurve: true, layout: [{ ch: 'B', x: 1, y: 2, rot: 0.1, sx: 2, sy: 1.5, skew: -0.3, w: 5, pen: 1.3 }, { ch: 'O', x: 3, y: 4, rot: 0, w: 5 }] };
    const runs = glyphJob({ w: 100, h: 50 }, layout).runs;
    expect(runs[0]).toMatchObject({ text: 'B', x: 51, y: 27, rot: 0.1, sx: 2, sy: 1.5, skew: -0.3, pen: 1.3 });
    expect(Object.keys(runs[1]).sort()).toEqual(['fill', 'rot', 'text', 'x', 'y']);
  });

  it('carries the rim order, the corners and the negative only while SFX is on', () => {
    const s = sfxStyle({ strokeOrder: 'each', strokeJoin: 'miter', negative: { on: true, grow: 0.5, color: '#0000ff' } });
    const job = glyphJob({ w: 200, h: 100 }, layoutOf(s));
    expect(job).toMatchObject({ strokeOrder: 'each', strokeJoin: 'miter', negative: { color: '#0000ff', grow: 10 } });
    const off = sfxStyle({ ...s, sfx: { ...s.sfx, on: false } });
    const plainJob = glyphJob({ w: 200, h: 100 }, layoutOf(off));
    for (const k of ['strokeOrder', 'strokeJoin', 'negative']) expect(plainJob).not.toHaveProperty(k);
  });

  it('paints a trail as afterimages first, back along each letter’s path', () => {
    const s = sfxStyle({ trail: { on: true, count: 2, dist: 0.5 } });
    const runs = glyphJob({ w: 200, h: 100 }, layoutOf(s, 'BO')).runs;
    const ghosts = runs.filter((r) => r.ghost);
    expect(ghosts).toHaveLength(4);
    expect(runs.slice(0, 4).every((r) => r.ghost)).toBe(true);
    const b = runs.find((r) => !r.ghost && r.text === 'B');
    const back = ghosts.filter((r) => r.text === 'B').map((r) => b.x - r.x).sort((x, y) => x - y);
    expect(back[0]).toBeCloseTo(10);
    expect(back[1]).toBeCloseTo(20);
  });
});

describe('the ink of a scaled and leaned glyph', () => {
  const k = { left: -5, right: 5, ascent: 8, descent: 4 };

  it('is the old rectangle for a glyph without the fields', () => {
    const old = turnedInk(k, 0.4, 100, 50);
    expect(turnedInk(k, 0.4, 100, 50, undefined, undefined, undefined)).toEqual(old);
    expect(turnedInk(k, 0.4, 100, 50, 1, 1, 0)).toEqual(old);
    expect(turnedInk(k, 0, 100, 50)).toEqual([95, 42, 105, 54]);
  });

  it('scales about the glyph centre', () => {
    expect(turnedInk(k, 0, 100, 50, 2, 3, 0)).toEqual([90, 26, 110, 62]);
  });

  it('reaches sideways by the lean times the height', () => {
    const [x0, y0, x1, y1] = turnedInk(k, 0, 100, 50, 1, 1, Math.atan(0.5));
    expect([y0, y1]).toEqual([42, 54]);
    // A positive skew leans the top right: the top (v = -8) slides +4, the
    // bottom (v = 4) slides -2.
    expect(x0).toBeCloseTo(100 - 5 - 2);
    expect(x1).toBeCloseTo(100 + 5 + 4);
  });

  it('boxInkRect grows with a scaled glyph and is unchanged without', () => {
    const s = { ...defaultStyle(), size: 20, strokeEffects: [], shadows: [] };
    const c = cand(s);
    const plain = { s, text: 'A', isCurve: true, layout: [{ ch: 'A', x: 0, y: 0, rot: 0, w: 11 }] };
    const same = { ...plain, layout: [{ ...plain.layout[0], sx: 1, sy: 1, skew: 0 }] };
    const big = { ...plain, layout: [{ ...plain.layout[0], sx: 2, sy: 1, skew: 0 }] };
    const r0 = boxInkRect(c, plain);
    expect(boxInkRect(c, same)).toEqual(r0);
    const r2 = boxInkRect(c, big);
    expect(r2.w).toBeCloseTo(r0.w * 2);
    expect(r2.h).toBeCloseTo(r0.h);
  });
});

describe('the handles’ maths', () => {
  // The fake engine echoes its call: sfx.js forwards and adds nothing.
  const last = () => CALLS.at(-1);

  it('forwards every call to the engine as it was handed', () => {
    const letters = sfxPlacement('BOOM', sfxStyle(), 20).letters;
    expect(sfxHit(letters, 3, 4, 2)).toBe(7);
    expect(last()).toEqual({ name: 'sfxHit', args: [letters, 3, 4, 2] });
    expect(sfxTurn([0, 0], [1, 0], [0, 1], 10, 15)).toBe('sfxTurn');
    expect(last().args).toEqual([[0, 0], [1, 0], [0, 1], 10, 15]);
    expect(sfxScale([0, 0], [1, 0], [2, 0], 1, true)).toBe('sfxScale');
    expect(last().args).toEqual([[0, 0], [1, 0], [2, 0], 1, true]);
    expect(sfxMove(letters[1], [0, 0], [5, 5], 0.1, 0.2)).toBe('sfxMove');
    expect(last().args).toEqual([letters[1], [0, 0], [5, 5], 0.1, 0.2]);
    const path = { a: [0, 0], b: [2, 0], bend: 0.1 };
    expect(sfxBendFor(path, [1, 1])).toBe('sfxBendFor');
    expect(bendFor(path, [1, 1])).toBe('sfxBendFor');
    expect(sfxCurve(path)).toEqual({ ctrl: [1, 2], mid: [3, 4] });
    expect(bendHandle(path)).toEqual([3, 4]);
  });

  it('asks for a letter’s outline with the face and the recipe sfxPlacement uses, once', () => {
    const s = sfxStyle();
    expect(sfxOutline('BOOM', s, 20, 1)).toBe('M0 0L1 0L1 1Z');
    const { args } = last();
    expect(args[0].size).toBe(20);
    expect(args.slice(1)).toEqual(['BOOM', sfxParams(s.sfx), 1]);
    const n = CALLS.length;
    sfxOutline('BOOM', s, 20, 1);
    expect(CALLS.length).toBe(n);
    expect(sfxOutline('BOOM', s, 20, -1)).toBe('');
  });

  it('answers null without the engine, and no hit with no letters', () => {
    expect(sfxHit([], 0, 0)).toBe(-1);
    setTextEngine(fakeEngine({ sfx: false }));
    const path = { a: [0, 0], b: [2, 0], bend: 0 };
    for (const v of [sfxHit([{ quad: [] }], 0, 0), sfxTurn([0, 0], [1, 0], [0, 1], 0), sfxScale([0, 0], [1, 0], [2, 0], 1),
      sfxMove({ unit: 1 }, [0, 0], [1, 1], 0, 0), sfxBendFor(path, [1, 1]), sfxCurve(path), bendHandle(path)]) {
      expect(v).toBe(null);
    }
    expect(sfxOutline('BOOM', sfxStyle(), 20, 0)).toBe('');
  });
});
