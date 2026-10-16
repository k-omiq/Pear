import { describe, it, expect } from 'vitest';
import { defaultStyle, normalizeStyle, normalizeStroke, normalizeShadow, normalizeSfx } from '../data.js';
import { STYLE_SCHEMA, validateStylePatch, styleSchemaText } from './style-schema.js';

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const join = (path, key) => path ? `${path}.${key}` : key;

// Check both directions, collecting every discrepancy in one failure. Arrays
// with default items are walked too; empty-array item shapes are checked below
// against their normalizers. readOnly payloads still have a schema entry.
function drift(value, schema, path = '', errors = []) {
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
      if (!Object.hasOwn(value, key)) errors.push(`${join(path, key)}: stale schema`);
    }
  } else if (Array.isArray(value)) {
    if (schema.readOnly && schema.type === 'any') return errors;
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
const stroke = { color: '#fff', width: 3, opacity: 1 };
const shadow = { x: -2, y: 4, blur: 3, color: '#1234', opacity: 0.5 };
const stop = { color: '#fff', pos: 0, opacity: 1 };

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
      ['strokes', normalizeStroke({})], ['shadows', normalizeShadow({})],
      ['sfx.moves', normalizeSfx({ moves: [{ kind: 'tilt', a: 0, b: 0 }] }).moves[0]],
    ]) {
      const item = key === 'sfx.moves' ? STYLE_SCHEMA.sfx.fields.moves.items : STYLE_SCHEMA[key].items;
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
      sfx: { moves: [{ kind: 'engine-defined-kind', a: 1.5, b: -2 }] },
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
    const patch = { size: 1000, lineHeight: 4, letterSpacing: -100, curve: 200, opacity: 2, roughen: { amount: 100 } };
    expect(validateStylePatch(patch)).toEqual([]);
    const normalized = normalizeStyle({ ...defaultStyle(), ...patch });
    for (const key of Object.keys(patch)) {
      expect(normalized[key]).toEqual(key === 'roughen' ? { ...defaultStyle().roughen, ...patch.roughen } : patch[key]);
    }
  });

  it('lists every allowed value for each enum', () => {
    for (const [path, entry] of allEntries.filter(([, e]) => e.type === 'enum')) {
      for (const value of entry.values) expect(validateStylePatch(patchAt(path, value)), path).toEqual([]);
      const [error] = validateStylePatch(patchAt(path, 'wrong'));
      expect(error.path).toBe(path);
      for (const value of entry.values) expect(error.error).toContain(value);
    }
  });

  it('accepts exactly the CSS hex lengths allowed by the normalizer', () => {
    for (const value of ['#abc', '#ABCD', '#012abc', '#0123abcd']) {
      expect(validateStylePatch({ color: value, pattern: { fg: value }, strokes: { 0: { color: value } } })).toEqual([]);
      expect(normalizeStroke({ color: value }).color).toBe(value);
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
    expect(validateStylePatch({ sfx: { moves: [{ kind: '', a: 0, b: 0 }] } })).not.toEqual([]);
  });

  it('accepts full array replacements and partial index patches', () => {
    expect(validateStylePatch({ strokes: [stroke], shadows: [shadow], gradient: { stops: [stop, { ...stop, pos: 1 }] } })).toEqual([]);
    expect(validateStylePatch({ strokes: [], shadows: [], sfx: { moves: [] } })).toEqual([]);
    expect(validateStylePatch({ strokes: { 0: { width: '+2' } }, shadows: { 2: { x: -10 } }, gradient: { stops: { 0: { pos: 0.2 } } } })).toEqual([]);
    expect(validateStylePatch({ strokes: [{ ...stroke, width: -1 }] })[0].path).toBe('strokes[0].width');
    expect(validateStylePatch({ strokes: [{ width: 2 }] })).toEqual([]);
    expect(validateStylePatch({ shadows: { 0: { blurr: 2 } } })[0]).toMatchObject({ path: 'shadows[0].blurr', hint: expect.stringContaining('blur') });
  });

  it('enforces normalized array lengths and reachable indexes', () => {
    expect(validateStylePatch({ gradient: { stops: [stop] } })[0].error).toContain('at least 2');
    expect(validateStylePatch({ gradient: { stops: Array.from({ length: 9 }, () => stop) } })[0].error).toContain('at most 8');
    expect(validateStylePatch({ sfx: { moves: Array.from({ length: 9 }, () => ({ kind: 'tilt', a: 0, b: 0 })) } })[0].error).toContain('at most 8');
    expect(validateStylePatch({ gradient: { stops: { 7: { pos: 1 } } } })).toEqual([]);
    expect(validateStylePatch({ gradient: { stops: { 8: { pos: 1 } } } })[0].error).toContain('below 8');
    // Strokes and shadows have no length cap in the normalizers.
    expect(validateStylePatch({ strokes: Array.from({ length: 30 }, () => stroke) })).toEqual([]);
    for (const key of ['-1', '1.2', '01', 'word', '9007199254740992']) {
      expect(validateStylePatch({ strokes: { [key]: { width: 2 } } })[0].error).toContain('non-negative integer');
    }
    expect(validateStylePatch({ strokes: new Array(1) })).not.toEqual([]);
  });

  it('refuses every read-only payload with its setting instructions', () => {
    for (const [path, entry] of allEntries.filter(([, e]) => e.readOnly)) {
      for (const value of [null, [], {}, { 0: {} }]) {
        expect(validateStylePatch(patchAt(path, value))).toEqual([{ path, error: entry.desc }]);
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
    for (const value of [{ gradient: null }, { motionBlur: [] }, { strokes: 'bad' }, { shadows: { 0: null } }, { gradient: { stops: [null, 'bad'] } }]) {
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
      const item = defaults[key][0] ?? (key === 'shadows' ? shadow : { kind: 'tilt', a: 0, b: 0 });
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
      style.sfx.moves = [{ kind: 'tilt', a: 0, b: 0 }];
      let target = style;
      for (const key of path.slice(0, -1)) target = target[key];
      target[path.at(-1)] = value;
      const normalized = normalizeStyle({ ...defaultStyle(), ...style });
      // normalizeStroke preserves the 0 boundary; normalizeStyle then removes
      // invisible bands. This intentional filtering is separate from clamping.
      if (path.join('.') === 'strokes.0.width' && value === 0) {
        expect(normalizeStroke(style.strokes[0]).width).toBe(0);
        expect(normalized.strokes).toEqual([]);
      } else {
        expect(path.reduce((v, key) => v[key], normalized)).toBe(value);
      }
    });
  }
});

describe('styleSchemaText', () => {
  it('describes every key, field and item in under 4000 characters', () => {
    const text = styleSchemaText();
    expect(text.length).toBeLessThan(4000);
    for (const [path, entry] of allEntries) {
      expect(text.split('\n').some((line) => line.startsWith(`${path}: ${entry.type}`)), path).toBe(true);
    }
    expect(text).toContain('gradient.radius: number 0.1..4');
    expect(text).toContain('gradient.stops: array 2..8 items');
    expect(text).toContain('path.pts: any readOnly - set through');
  });
});
