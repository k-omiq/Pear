import { describe, it, expect } from 'vitest';
import { defaultStyle, normalizeStyle, normalizeStrokeEffect, normalizeShadow, normalizeInnerShadow, normalizeOverlay, normalizeSfx, newGradientOverlay, newStrokeEffect, FX_INSTANCES_MAX } from '../data.js';
import { STYLE_SCHEMA, validateStylePatch, styleSchemaText } from './style-schema.js';
import { applyStylePatch } from '../style-patch.js';

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const join = (path, key) => path ? `${path}.${key}` : key;

// Check both directions, collecting every discrepancy in one failure. Arrays
// with default items are walked too; empty-array item shapes are checked below
// against their normalizers. readOnly payloads still have a schema entry.
function drift(value, schema, path = '', errors = []) {
  if (schema.readOnly && schema.type === 'any') return errors;
  // A nullable field's default is null: the type's own value stands in.
  if (value === null && schema.nullable) return errors;
  if (plain(value)) {
    if (schema.type !== 'object' || !schema.fields) {
      errors.push(`${path || '$'}: missing object fields`);
      return errors;
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = join(path, key);
      if (!Object.hasOwn(schema.fields, key)) errors.push(`${childPath}: missing schema`);
      else drift(child, schema.fields[key], childPath, errors);
    }
    for (const key of Object.keys(schema.fields)) {
      if (!Object.hasOwn(value, key) && !schema.fields[key].optional) errors.push(`${join(path, key)}: stale schema`);
    }
  } else if (Array.isArray(value)) {
    if (schema.type !== 'array' || !schema.items) errors.push(`${path}: missing array items`);
    else for (const child of value) drift(child, schema.items, `${path}[]`, errors);
  } else if (schema.fields || schema.items) {
    errors.push(`${path}: stale schema fields/items`);
  }
  return errors;
}

function entries(fields, path = '') {
  return Object.entries(fields).flatMap(([key, entry]) => {
    const entryPath = join(path, key);
    const children = entry.fields ?? entry.items?.fields;
    return [[entryPath, entry], ...(children ? entries(children, entry.fields ? entryPath : `${entryPath}[]`) : [])];
  });
}

const allEntries = entries(STYLE_SCHEMA);
const numericEntries = allEntries.filter(([, e]) => e.type === 'number' || e.type === 'integer');
const stroke = { color: '#fff', size: 3, position: 'outside', opacity: 1 };
const shadow = { x: -2, y: 4, size: 3, color: '#1234', opacity: 0.5 };
const stop = { color: '#fff', pos: 0, opacity: 1 };
const anchor = { x: 10, y: 20, ix: -5, iy: 0, ox: 5, oy: 0 };
const sfxPath = { a: [0, 0], b: [1, 0], bend: 0 };
// A drawable item for each list whose default is empty.
const innerShadow = { x: 2, y: 3, size: 4, color: '#000', opacity: 0.75, choke: 0.1 };
const overlay = { color: '#f00', opacity: 1, blend: 'normal' };
const gradientOverlay = newGradientOverlay();
const strokeEffect = newStrokeEffect();
const EMPTY_ITEMS = { shadows: shadow, innerShadows: innerShadow, colorOverlays: overlay, gradientOverlays: gradientOverlay, strokeEffects: strokeEffect, paths: sfxPath, pts: anchor };

describe('STYLE_SCHEMA drift', () => {
  it('covers exactly every default key and nested field', () => {
    const errors = drift(defaultStyle(), { type: 'object', fields: STYLE_SCHEMA });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('reports all missing and stale fields, including inside nested objects', () => {
    const schema = structuredClone(STYLE_SCHEMA);
    delete schema.font;
    delete schema.gradient.fields.cx;
    schema.retired = { type: 'number', desc: 'old' };
    schema.pattern.fields.retired = { type: 'number', desc: 'old' };
    expect(drift(defaultStyle(), { type: 'object', fields: schema })).toEqual([
      'font: missing schema', 'gradient.cx: missing schema',
      'pattern.retired: stale schema', 'retired: stale schema',
    ]);
  });

  it('covers item fields even for arrays whose defaults are empty', () => {
    for (const [key, value] of [
      ['shadows', normalizeShadow({})],
      ['innerShadows', normalizeInnerShadow({})], ['colorOverlays', normalizeOverlay({})],
      ['gradientOverlays', newGradientOverlay()], ['strokeEffects', newStrokeEffect()],
      ['sfx.paths', normalizeSfx({ paths: [sfxPath] }).paths[0]],
      ['path.pts', normalizeStyle({ path: { pts: [{ x: 1, y: 2 }] } }).path.pts[0]],
    ]) {
      const [top, sub] = key.split('.');
      const item = sub ? STYLE_SCHEMA[top].fields[sub].items : STYLE_SCHEMA[key].items;
      expect(drift(value, item, `${key}[]`)).toEqual([]);
    }
  });

  it('has short descriptions, known types, and only read-only opaque payloads', () => {
    for (const [path, entry] of allEntries) {
      expect(['number', 'integer', 'boolean', 'string', 'enum', 'color', 'object', 'array', 'any'], path).toContain(entry.type);
      expect(entry.desc, path).toBeTruthy();
      expect(entry.desc, path).not.toContain('\n');
      if (entry.type === 'any') {
        expect(entry.readOnly, path).toBe(true);
        expect(entry.desc, path).toMatch(/^set through /);
      }
    }
  });
});

describe('validateStylePatch', () => {
  it('accepts an empty patch and a valid, deeply partial patch without mutation', () => {
    const patch = {
      font: 'Bangers', size: 40, bold: true, color: '#A1B', shape: 'oval',
      gradient: { on: true, radius: 2, stops: { 1: { opacity: 0.4 } } },
      pattern: { kind: 'crosshatch' }, roughen: { grit: 2 },
      path: { on: true }, ink: { on: false }, warp: { cols: 4 },
      sfx: { kind: 'impact', flow: null, paths: [{ a: [0, 0], b: [1.5, -2], bend: 0.3 }] }, extrude: { on: true, edge: '' },
    };
    const before = structuredClone(patch);
    expect(validateStylePatch({})).toEqual([]);
    expect(validateStylePatch(patch)).toEqual([]);
    expect(patch).toEqual(before);
    expect(validateStylePatch(Object.assign(Object.create(null), { size: 26 }))).toEqual([]);
  });

  it('suggests the three nearest keys, scoped to the current object', () => {
    const [top, nested] = validateStylePatch({ siez: 30, gradient: { radus: 1 } });
    expect(top.path).toBe('siez');
    expect(top.error).toBe('unknown key');
    expect(top.hint).toBe('nearest keys: size, ink, sfx');
    expect(nested.path).toBe('gradient.radus');
    expect(nested.hint).toBe('nearest keys: radius, stops, angle');
    const [inherited] = validateStylePatch(JSON.parse('{"__proto__":{},"constructor":5}'));
    expect(inherited.error).toBe('unknown key');
  });

  it('rejects out-of-range values, naming the actual clamp', () => {
    expect(validateStylePatch({ motionBlur: { x: 51 }, gradient: { radius: 0 }, blur: -1 })).toEqual([
      { path: 'motionBlur.x', error: 'expected range -50..50' },
      { path: 'gradient.radius', error: 'expected range 0.1..4' },
      { path: 'blur', error: 'expected range 0..Infinity' },
    ]);
  });

  it('enforces every declared numeric bound and integer type', () => {
    for (const [path, entry] of numericEntries) {
      for (const bound of ['min', 'max']) {
        if (entry[bound] === undefined) continue;
        const value = entry[bound] + (bound === 'min' ? -1 : 1);
        expect(validateStylePatch(patchAt(path, value)).some((e) => e.error.includes('range')), path).toBe(true);
      }
      if (entry.type === 'integer') {
        expect(validateStylePatch(patchAt(path, 2.5)).some((e) => e.error.includes('integer')), path).toBe(true);
      }
    }
  });

  it('does not invent slider bounds for values passed through by normalizeStyle', () => {
    const patch = { lineHeight: 4, letterSpacing: -100, curve: 200, roughen: { amount: 100 } };
    expect(validateStylePatch(patch)).toEqual([]);
    const normalized = normalizeStyle({ ...defaultStyle(), ...patch });
    for (const key of Object.keys(patch)) {
      expect(normalized[key]).toEqual(key === 'roughen' ? { ...defaultStyle().roughen, ...patch.roughen } : patch[key]);
    }
  });

  // The exceptions: ranges the normalizer does not clamp, set so a model's
  // slip is refused rather than drawn.
  it('bounds size and opacity, and names the alignments', () => {
    expect(validateStylePatch({ size: 1000, opacity: 2 }).map((e) => e.path)).toEqual(['size', 'opacity']);
    expect(validateStylePatch({ align: 'justify' })[0].error).toContain('center');
    expect(validateStylePatch({ size: 400, opacity: 1, align: 'right', valign: 'bottom' })).toEqual([]);
  });

  it('lists every allowed value for each enum', () => {
    for (const [path, entry] of allEntries.filter(([, e]) => e.type === 'enum')) {
      for (const value of entry.values) expect(validateStylePatch(patchAt(path, value)), path).toEqual([]);
      const [error] = validateStylePatch(patchAt(path, 'wrong'));
      // An item field's error names the item the patch reached.
      expect(error.path).toBe(path.replaceAll('[]', '[0]'));
      for (const value of entry.values) expect(error.error).toContain(value);
    }
  });

  it('accepts exactly the CSS hex lengths allowed by the normalizer', () => {
    for (const value of ['#abc', '#ABCD', '#012abc', '#0123abcd']) {
      expect(validateStylePatch({ color: value, pattern: { fg: value }, strokeEffects: { 0: { color: value } } })).toEqual([]);
      expect(normalizeStrokeEffect({ color: value }).color).toBe(value);
    }
    for (const value of ['red', 'rgb(0,0,0)', 'abc', '#12', '#abcde', '#1234567', '#GGG', '', null, 123]) {
      expect(validateStylePatch({ color: value })[0]).toMatchObject({ path: 'color', error: expect.stringContaining('hex') });
    }
  });

  it('accepts relative strings on every numeric field, including integers', () => {
    for (const [path] of numericEntries) {
      for (const value of ['+2', '-2', '*1.1', '+0.25', '*0', '-99999']) {
        expect(validateStylePatch(patchAt(path, value)), path).toEqual([]);
      }
    }
  });

  it('rejects malformed relatives, nonfinite numbers, and coercible nonnumbers', () => {
    for (const value of ['2', '+.2', '*-2', '/2', '+2e3', '+2.', ' +2', '--2', '', NaN, Infinity, -Infinity, null, true, {}, [], '+'.concat('9'.repeat(400))]) {
      expect(validateStylePatch({ size: value })).not.toEqual([]);
    }
  });

  it('requires actual booleans and strings', () => {
    for (const value of [0, 1, 'true', 'false', null, {}, []]) expect(validateStylePatch({ bold: value })).not.toEqual([]);
    for (const value of [0, false, null, {}, []]) expect(validateStylePatch({ font: value })).not.toEqual([]);
    expect(validateStylePatch({ sfx: { kind: '' } })).not.toEqual([]);
  });

  it('accepts full array replacements and partial index patches', () => {
    expect(validateStylePatch({ strokeEffects: [stroke], shadows: [shadow], gradient: { stops: [stop, { ...stop, pos: 1 }] } })).toEqual([]);
    expect(validateStylePatch({ strokeEffects: [], shadows: [], sfx: { paths: [] } })).toEqual([]);
    expect(validateStylePatch({ strokeEffects: { 0: { size: '+2' } }, shadows: { 2: { x: -10 } }, gradient: { stops: { 0: { pos: 0.2 } } } })).toEqual([]);
    expect(validateStylePatch({ strokeEffects: [{ ...stroke, size: -1 }] })[0].path).toBe('strokeEffects[0].size');
    expect(validateStylePatch({ strokeEffects: [{ size: 2 }] })).toEqual([]);
    expect(validateStylePatch({ shadows: { 0: { sizee: 2 } } })[0]).toMatchObject({ path: 'shadows[0].sizee', hint: expect.stringContaining('size') });
  });

  it('enforces normalized array lengths and reachable indexes', () => {
    expect(validateStylePatch({ gradient: { stops: [stop] } })[0].error).toContain('at least 2');
    expect(validateStylePatch({ gradient: { stops: Array.from({ length: 9 }, () => stop) } })[0].error).toContain('at most 8');
    expect(validateStylePatch({ sfx: { paths: Array.from({ length: 33 }, () => sfxPath) } })[0].error).toContain('at most 32');
    expect(validateStylePatch({ gradient: { stops: { 7: { pos: 1 } } } })).toEqual([]);
    expect(validateStylePatch({ gradient: { stops: { 8: { pos: 1 } } } })[0].error).toContain('below 8');
    // The strokes are a Photoshop effect that comes more than once: at most
    // FX_INSTANCES_MAX of them, as the normalizer keeps.
    expect(validateStylePatch({ strokeEffects: Array.from({ length: FX_INSTANCES_MAX }, () => stroke) })).toEqual([]);
    expect(validateStylePatch({ strokeEffects: Array.from({ length: FX_INSTANCES_MAX + 1 }, () => stroke) })[0].error).toContain(`at most ${FX_INSTANCES_MAX}`);
    for (const key of ['-1', '1.2', '01', 'word', '9007199254740992']) {
      expect(validateStylePatch({ strokeEffects: { [key]: { size: 2 } } })[0].error).toContain('non-negative integer');
    }
    expect(validateStylePatch({ strokeEffects: new Array(1) })).not.toEqual([]);
  });

  it('refuses every read-only payload with its setting instructions', () => {
    for (const [path, entry] of allEntries.filter(([, e]) => e.readOnly && !Object.hasOwn(e, 'same'))) {
      for (const value of [null, [], {}, { 0: {} }]) {
        expect(validateStylePatch(patchAt(path, value))).toEqual([{ path: path.replaceAll('[]', '[0]'), error: entry.desc }]);
      }
    }
  });

  it('never throws for junk, cyclic/deep objects, or hostile JS objects', () => {
    const cyclic = {};
    cyclic.gradient = cyclic;
    let deep = null;
    for (let i = 0; i < 20000; i++) deep = { gradient: deep };
    const getter = Object.defineProperty({}, 'size', { enumerable: true, get() { throw new Error('unreadable'); } });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const value of [null, undefined, '', 'style', 1, NaN, true, Symbol('x'), 1n, [], () => {}, new Date(), new Map(), cyclic, deep, getter, proxy]) {
      let result;
      expect(() => { result = validateStylePatch(value); }).not.toThrow();
      expect(result.length).toBeGreaterThan(0);
    }
    for (const value of [{ gradient: null }, { motionBlur: [] }, { strokeEffects: 'bad' }, { shadows: { 0: null } }, { gradient: { stops: [null, 'bad'] } }]) {
      expect(() => validateStylePatch(value)).not.toThrow();
      expect(validateStylePatch(value).length).toBeGreaterThan(0);
    }
  });
});

// Construct index patches for validation, including paths inside item schemas.
function patchAt(path, value) {
  return path.replaceAll('[]', '.0').split('.').reduceRight((child, key) => ({ [key]: child }), value);
}

function numericCases(fields, defaults, path = []) {
  return Object.entries(fields).flatMap(([key, entry]) => {
    const next = [...path, key];
    if (entry.fields) return numericCases(entry.fields, defaults[key], next);
    if (entry.items?.fields) {
      // Empty arrays need a drawable complete item to exercise their numbers.
      const item = defaults[key][0] ?? EMPTY_ITEMS[key];
      return numericCases(entry.items.fields, item, [...next, 0]);
    }
    if (entry.type !== 'number' && entry.type !== 'integer') return [];
    const values = [...new Set([entry.min, entry.max].filter((v) => v !== undefined))];
    if (!values.length) values.push(defaults[key]);
    return values.map((value) => ({ path: next, value }));
  });
}

describe('normalizer numeric sanity', () => {
  for (const { path, value } of numericCases(STYLE_SCHEMA, defaultStyle())) {
    it(`${path.join('.')} = ${value} survives normalization`, () => {
      const style = defaultStyle();
      style.shadows = [{ ...shadow }];
      style.innerShadows = [{ ...innerShadow }];
      style.colorOverlays = [{ ...overlay }];
      style.gradientOverlays = [structuredClone(gradientOverlay)];
      style.strokeEffects = [structuredClone(strokeEffect)];
      style.sfx.paths = [structuredClone(sfxPath)];
      style.path.pts = [{ ...anchor }];
      let target = style;
      // A nullable object (null by default) is given the one number.
      for (const key of path.slice(0, -1)) target = target[key] ??= {};
      target[path.at(-1)] = value;
      // A shadow keeps its own angle only where x, y cannot say it (F48).
      if (/^(inner)?[sS]hadows\.0\.angle$/.test(path.join('.'))) Object.assign(target, { x: 0, y: 0, useGlobalLight: false });
      const normalized = normalizeStyle({ ...defaultStyle(), ...style });
      expect(path.reduce((v, key) => v[key], normalized)).toBe(value);
    });
  }
});

// F53: a read-only field sent back as every target box stores it is no edit.
describe('validateStylePatch with the stored styles', () => {
  const picked = { kind: 'picked', src: '0123456789abcdef0123456789abcdef.png', cell: [8, 0, 0, 8] };
  const withPick = normalizeStyle({ ...defaultStyle(), strokeEffects: [newStrokeEffect(), { ...newStrokeEffect(), fill: 'pattern', pattern: picked }] });
  const plainStroke = normalizeStyle({ ...defaultStyle(), strokeEffects: [newStrokeEffect()] });
  const echo = (st) => JSON.parse(JSON.stringify(st.strokeEffects));

  it('passes a stored list echoed whole, and one with an item added or removed', () => {
    const list = echo(withPick);
    expect(list[1].pattern).toMatchObject(picked);
    expect(validateStylePatch({ strokeEffects: list })).not.toEqual([]); // no stored styles: refused as before
    expect(validateStylePatch({ strokeEffects: list }, withPick)).toEqual([]);
    expect(validateStylePatch({ strokeEffects: [...list, newStrokeEffect()] }, withPick)).toEqual([]);
    // The first removed: the picked item is at index 0 now, stored at 1.
    expect(validateStylePatch({ strokeEffects: [list[1]] }, withPick)).toEqual([]);
  });

  it('passes an index patch only against the item at that index', () => {
    const list = echo(withPick);
    expect(validateStylePatch({ strokeEffects: { 1: { pattern: list[1].pattern } } }, withPick)).toEqual([]);
    expect(validateStylePatch({ strokeEffects: { 0: { pattern: list[1].pattern } } }, withPick).map((e) => e.path)).toEqual(['strokeEffects[0].pattern.kind', 'strokeEffects[0].pattern.src', 'strokeEffects[0].pattern.cell']);
  });

  it('refuses a tile that is not stored, or not on every target', () => {
    const list = echo(withPick);
    const other = structuredClone(list);
    other[1].pattern.src = 'ffffffffffffffffffffffffffffffff.png';
    expect(validateStylePatch({ strokeEffects: other }, withPick)[0]).toMatchObject({ path: 'strokeEffects[1].pattern.src', error: 'set through Pick from page' });
    expect(validateStylePatch({ strokeEffects: list }, [withPick, plainStroke]).map((e) => e.path)).toEqual(['strokeEffects[1].pattern.kind', 'strokeEffects[1].pattern.src', 'strokeEffects[1].pattern.cell']);
    expect(validateStylePatch({ strokeEffects: list }, [withPick, withPick])).toEqual([]);
    expect(validateStylePatch({ strokeEffects: list }, [])).not.toEqual([]);
  });

  it('passes any other read-only payload echoed as stored', () => {
    const pts = [];
    for (let y = 0; y <= 2; y++) for (let x = 0; x <= 2; x++) pts.push([x * 10, y * 10]);
    const st = normalizeStyle({ ...defaultStyle(), warp: { on: true, cols: 2, rows: 2, pts } });
    expect(st.warp.pts).toHaveLength(9);
    expect(validateStylePatch({ warp: { pts: st.warp.pts } }, st)).toEqual([]);
    expect(validateStylePatch({ warp: { pts: [...st.warp.pts].reverse() } }, st)).not.toEqual([]);
  });
});

describe('styleSchemaText', () => {
  // The budget grew from 5200 when the path anchors and the mask shapes
  // became writable: about 900 characters for two whole new item schemas,
  // and to 8600 for the sound types' layout fields and the SFX effects, and
  // to 8800 for the bold weight, the italic angle and the two dither kinds,
  // and to 10200 for the layer style: the shadow's Photoshop fields, Fill
  // Opacity, and the blend mode list, and to 12400 for the glows, the inner
  // shadows and the colour overlays (the blend mode and contour lists are
  // printed once, under their names), and to 14400 for the Photoshop
  // strokes, the gradient and pattern overlays and the gradient glows (a
  // gradient and a pattern are printed whole once), and to 15000 for the
  // noise gradient's fields and Shape Burst, and to 15500 for the Satin, and
  // to 17000 for the Bevel & Emboss (Structure, Shading, Contour, Texture),
  // and to 17200 for the Advanced Blending options (interior, knockout),
  // and to 17800 for Channels and Blend If (one slider pair printed once),
  // and to 17900 for the glows' Jitter, to 18000 for the shadows' kept
  // angle at Distance 0, to 18500 for the multi effects' own switches and
  // their cap of 10, and Blend Clipped Layers as Group, Transparency Shapes
  // Layer and Vector Mask Hides Effects, and to 19000 for the effect
  // gradient's opacity stops, midpoints, Smoothness, Method and Dither,
  // and to 19100 for the Photoshop stroke's Overprint.
  // To 19200 for the twelve pattern kinds of 2026-11-10, and to 19300 for
  // the letters' Wobble the same day; to 19600 for the four special
  // effects (crack, lightning, splash, scratches) of 2026-11-11, and to
  // 19700 the same day for the crack's focus and spread, the lightning's
  // core and glow and the splash's colour; to 19800 for the crack's break
  // off and its motion, and to 19900 for the box stroke at the cuts; to
  // 20300 for the text outline at the cuts, the lightning's aim and the
  // splash's landing (fix round 1, 2026-11-11); to 20500 for vertical text
  // and its Latin letters, and the SFX curve line switch (2026-11-16).
  it('describes every key, field and item in under 20500 characters', () => {
    const text = styleSchemaText();
    expect(text.length).toBeLessThan(20500);
    expect(text).toMatch(/^BLEND = normal\|dissolve\|/);
    expect(text).toContain('outerGlow.blend: enum BLEND - ');
    // A shared object is printed whole once; after, its path points back.
    const like = text.split('\n').filter((line) => / like \S+ - /.test(line)).map((line) => line.split(':')[0]);
    for (const [path, entry] of allEntries) {
      if (like.some((p) => path.startsWith(`${p}.`) || path.startsWith(`${p}[]`))) continue;
      expect(text.split('\n').some((line) => line.startsWith(`${path}: ${entry.type}`)), path).toBe(true);
    }
    expect(text).toContain('strokeEffects[].pattern: object like pattern - ');
    expect(text).toContain('gradient.radius: number 0.1..4');
    expect(text).toContain('gradient.stops: array 2..8 items');
    expect(text).toContain('warp.pts: any readOnly - set through');
    expect(text).toContain('path.pts: array 2..64 items - anchors');
    expect(text).toContain('path.pts[].x: number required - ');
    expect(text).toContain('path.pts[].ix: number - ');
    // The mask is the box's, pinned to the page, and not in a style.
    expect(text).not.toContain('clip.');
  });
});

describe('writable geometry: path anchors', () => {
  const arch = [{ x: 0, y: 60 }, { x: 80, y: 0, ix: -40, ox: 40 }, { x: 160, y: 60 }];

  it('accepts a path given whole, and anchors patched by index', () => {
    expect(validateStylePatch({ path: { on: true, pts: arch } })).toEqual([]);
    expect(validateStylePatch({ path: { pts: { 1: { y: '-20', ox: 50 } } } })).toEqual([]);
    expect(validateStylePatch({ path: { pts: { 63: { x: 1 } } } })).toEqual([]);
    expect(validateStylePatch({ path: { pts: { 64: { x: 1 } } } })[0].error).toContain('below 64');
  });

  it('refuses a new anchor without x and y, too few or too many anchors, and unknown handle names', () => {
    expect(validateStylePatch({ path: { pts: [{ x: 0, y: 0 }, { x: 5 }] } })).toEqual([
      { path: 'path.pts[1].y', error: 'required in a new item' },
    ]);
    expect(validateStylePatch({ path: { pts: [{ x: 0, y: 0 }] } })[0].error).toContain('at least 2');
    expect(validateStylePatch({ path: { pts: Array.from({ length: 65 }, () => ({ x: 0, y: 0 })) } })[0].error).toContain('at most 64');
    expect(validateStylePatch({ path: { pts: [{ x: 0, y: 0, hx: 3 }, { x: 1, y: 1 }] } })[0]).toMatchObject({ path: 'path.pts[0].hx', error: 'unknown key' });
  });

  it('applies what it accepts: lists replace whole, index patches move one point', () => {
    const base = defaultStyle();
    const one = applyStylePatch(base, { path: { on: true, pts: arch } });
    expect(one.errors).toEqual([]);
    expect(one.style.path.on).toBe(true);
    expect(one.style.path.pts).toEqual([
      { x: 0, y: 60, ix: 0, iy: 0, ox: 0, oy: 0 },
      { x: 80, y: 0, ix: -40, iy: 0, ox: 40, oy: 0 },
      { x: 160, y: 60, ix: 0, iy: 0, ox: 0, oy: 0 },
    ]);

    const two = applyStylePatch(one.style, { path: { pts: { 1: { y: '-10' } } } });
    expect(two.errors).toEqual([]);
    expect(two.style.path.pts[1]).toMatchObject({ x: 80, y: -10, ix: -40, ox: 40 });
  });

  it('a relative number inside a list given whole has nothing to change, and says so', () => {
    const r = applyStylePatch(defaultStyle(), { path: { on: true, pts: [{ x: '+5', y: 0 }, { x: 1, y: 1 }] } });
    expect(r.errors).toEqual([{ path: 'path.pts.0.x', error: expect.stringContaining('needs a number') }]);
    expect(r.style.path.pts).toEqual([]);
  });
});

describe('the bevel in the schema', () => {
  it('takes a whole Bevel & Emboss patch, and refuses what Photoshop has no name for', () => {
    const patch = { bevel: { on: true, style: 'emboss', technique: 'chisel-hard', depth: 2, direction: 'down', size: 12, soften: 3, useGlobalLight: false, angle: 45, altitude: 60, highlight: { blend: 'screen', opacity: 0.5 }, contour: { on: true, curve: { preset: 'cone' }, range: 0.3 }, texture: { on: true, scale: 2, depth: -1, link: false } } };
    expect(validateStylePatch(patch)).toEqual([]);
    const r = applyStylePatch(defaultStyle(), patch);
    expect(r.errors).toEqual([]);
    expect(r.style.bevel).toMatchObject({ on: true, style: 'emboss', technique: 'chisel-hard', depth: 2, direction: 'down', size: 12, soften: 3, angle: 45, altitude: 60, highlight: { blend: 'screen', color: '#ffffff', opacity: 0.5 }, contour: { on: true, curve: { preset: 'cone' }, range: 0.3 }, texture: { on: true, scale: 2, depth: -1, link: false } });
    expect(validateStylePatch({ bevel: { style: 'ridge' } }).length).toBeGreaterThan(0);
    expect(validateStylePatch({ bevel: { technique: 'chisel' } }).length).toBeGreaterThan(0);
    expect(validateStylePatch({ bevel: { depth: 11 } }).length).toBeGreaterThan(0);
    expect(validateStylePatch({ bevel: { highlight: { blend: 'glow' } } }).length).toBeGreaterThan(0);
  });

  it('takes a glow\'s Jitter, 0 to 1, on both glows', () => {
    const patch = { outerGlow: { on: true, fill: 'gradient', jitter: 0.6 }, innerGlow: { jitter: 0.2 } };
    expect(validateStylePatch(patch)).toEqual([]);
    const r = applyStylePatch(defaultStyle(), patch);
    expect([r.style.outerGlow.jitter, r.style.innerGlow.jitter]).toEqual([0.6, 0.2]);
    expect(validateStylePatch({ outerGlow: { jitter: 2 } }).length).toBeGreaterThan(0);
    expect(styleSchemaText()).toContain('outerGlow.jitter');
  });

  it('prints the blend and contour lists by name, and the shadow half like the highlight', () => {
    const text = styleSchemaText();
    expect(text).toContain('bevel.style: enum inner|outer|emboss|pillow|stroke - ');
    expect(text).toContain('bevel.highlight.blend: enum BLEND - ');
    expect(text).toContain('shadows[].contour.preset: enum CONTOUR - ');
    expect(text).toContain('bevel.gloss: object like shadows[].contour - ');
    expect(text).toContain('bevel.shadow: object like bevel.highlight - ');
    expect(text).toContain('bevel.texture.pattern: object like pattern - ');
  });
});

describe('the advanced blending options in the schema', () => {
  it('takes Blend Interior Effects as Group and a Knockout, and refuses a knockout Photoshop has no name for', () => {
    const patch = { blendMode: 'screen', blending: { interior: true, knockout: 'deep' } };
    expect(validateStylePatch(patch)).toEqual([]);
    const r = applyStylePatch(defaultStyle(), patch);
    expect(r.errors).toEqual([]);
    expect(r.style.blendMode).toBe('screen');
    expect(r.style.blending).toMatchObject({ interior: true, knockout: 'deep' });
    expect(validateStylePatch({ blending: { knockout: 'full' } }).length).toBeGreaterThan(0);
    expect(validateStylePatch({ blending: { interior: 'yes' } }).length).toBeGreaterThan(0);
    expect(styleSchemaText()).toContain('blending.knockout: enum none|shallow|deep - ');
  });
});

describe('Channels and Blend If in the schema', () => {
  it('takes a channel off and a Blend If slider, and refuses one that is not four levels', () => {
    const patch = { blending: { channels: { r: false }, blendIf: { gray: { under: [64, 128, 255, 255] } } } };
    expect(validateStylePatch(patch)).toEqual([]);
    const r = applyStylePatch(defaultStyle(), patch);
    expect(r.errors).toEqual([]);
    expect(r.style.blending.channels).toEqual({ r: false, g: true, b: true });
    expect(r.style.blending.blendIf.gray).toEqual({ this: [0, 0, 255, 255], under: [64, 128, 255, 255] });
    expect(r.style.blending.blendIf.red).toEqual({ this: [0, 0, 255, 255], under: [0, 0, 255, 255] });
    expect(validateStylePatch({ blending: { blendIf: { gray: { this: [0, 0, 255] } } } }).length).toBeGreaterThan(0);
    expect(validateStylePatch({ blending: { blendIf: { gray: { this: [0, 0, 255, 300] } } } }).length).toBeGreaterThan(0);
    expect(validateStylePatch({ blending: { blendIf: { cyan: { this: [0, 0, 255, 255] } } } }).length).toBeGreaterThan(0);
    expect(validateStylePatch({ blending: { channels: { r: 'off' } } }).length).toBeGreaterThan(0);
    const text = styleSchemaText();
    expect(text).toContain('blending.blendIf.gray.under: array 4..4 items of integer - ');
    expect(text).toContain('blending.blendIf.blue: object like blending.blendIf.gray - ');
  });
});

describe('review fixes: stored values, custom contours, order checks', () => {
  it('lets a stored strokeEffects list go back whole, empty pick fields included', () => {
    const list = [newStrokeEffect()];
    expect(list[0].pattern.src).toBe('');
    expect(validateStylePatch({ strokeEffects: list })).toEqual([]);
    expect(validateStylePatch({ strokeEffects: [{ pattern: { src: 'data:x' } }] }).length).toBeGreaterThan(0);
  });

  it('takes a custom contour with its points', () => {
    const contour = { preset: 'custom', aa: false, pts: [[0, 0, false], [128, 200], [255, 255, true]] };
    expect(validateStylePatch({ shadows: [{ contour }] })).toEqual([]);
    expect(validateStylePatch({ shadows: [{ contour: { preset: 'custom', pts: [[0, 300]] } }] }).length).toBeGreaterThan(0);
  });

  it('refuses falling Blend If levels and a noise min above its max, by name', () => {
    const bad = validateStylePatch({ blending: { blendIf: { gray: { this: [0, 0, 255, 128] } } } });
    expect(bad[0].path).toBe('blending.blendIf.gray.this');
    expect(bad[0].error).toContain('levels must not fall');
    expect(validateStylePatch({ blending: { blendIf: { gray: { this: [0, 10, 200, 255] } } } })).toEqual([]);
    const noise = validateStylePatch({ gradientOverlays: [{ gradient: { noise: { min: [0.9, 0, 0], max: [0.1, 1, 1] } } }] });
    expect(noise[0].error).toContain('noise min must not pass max');
  });
});

describe('review fixes round 2', () => {
  it('refuses on:false in an effect pattern but takes the stored on:true', () => {
    expect(validateStylePatch({ patternOverlay: { pattern: { on: false } } }).length).toBe(1);
    expect(validateStylePatch({ strokeEffects: [{ pattern: { on: true } }] })).toEqual([]);
  });

  it('appends an item at the index just past the end of a list', () => {
    const base = normalizeStyle({ ...defaultStyle(), strokeEffects: [{ color: '#000', size: 2 }] });
    const r = applyStylePatch(base, { strokeEffects: { 1: { color: '#fff', size: 3 } } });
    expect(r.errors).toEqual([]);
    expect(r.style.strokeEffects).toHaveLength(2);
    expect(applyStylePatch(base, { strokeEffects: { 3: { size: 3 } } }).errors).toHaveLength(1);
  });
});
