import { describe, expect, it } from 'vitest';
import { letteringIssues, luminance } from './lettering-checks.js';

const ellipse = { kind: 'ellipse', cx: 50, cy: 50, rx: 40, ry: 30 };
const box = (style, fit = ellipse) => ({ id: 'b1', fit, style: { font: 'A', color: '#000000', strokes: [], balloon: true, ...style } });

describe('luminance', () => {
  it('reads #rgb and #rrggbb, and nothing else', () => {
    expect(luminance('#fff')).toBeCloseTo(1);
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#ffffff80')).toBeCloseTo(1);
    expect(luminance('red')).toBeNull();
  });
});

describe('role', () => {
  it('flags a box not in the font its role or voice wants', () => {
    expect(letteringIssues(box({ font: 'B' }), { want: { font: 'A', tag: 'speech' }, tags: ['speech'] }))
      .toEqual([{ kind: 'role', detail: { want: 'A', have: 'B', tag: 'speech' } }]);
    expect(letteringIssues(box({ font: 'A' }), { want: { font: 'A', tag: 'speech' }, tags: ['speech'] })).toEqual([]);
  });

  it('leaves sound effects and boxes with no wanted font alone', () => {
    expect(letteringIssues(box({ font: 'B' }), { want: { font: 'A', tag: 'sfx' }, tags: ['sfx'] })).toEqual([]);
    expect(letteringIssues(box({ font: 'B' }), { want: { font: 'A', tag: 'voice-mom' }, tags: ['sfx-sharp'] })).toEqual([]);
    expect(letteringIssues(box({ font: 'B' }), { want: null, tags: ['speech'] })).toEqual([]);
  });
});

describe('contrast', () => {
  it('flags black text in a dark balloon and white in a light one', () => {
    expect(letteringIssues(box({ color: '#111111' }), { ink: '#ffffff' })[0]).toMatchObject({ kind: 'contrast', detail: { balloon: 'dark' } });
    expect(letteringIssues(box({ color: '#f5f5f5' }), { ink: '#000000' })[0]).toMatchObject({ kind: 'contrast', detail: { balloon: 'light' } });
  });

  it('passes text in the tone its balloon asks for, or carried by an outline of the other tone', () => {
    expect(letteringIssues(box({ color: '#ffffff' }), { ink: '#ffffff' })).toEqual([]);
    expect(letteringIssues(box({ color: '#000000', strokes: [{ color: '#ffffff', width: 3, opacity: 1 }] }), { ink: '#ffffff' })).toEqual([]);
    // A hairline does not carry it.
    expect(letteringIssues(box({ color: '#000000', strokes: [{ color: '#ffffff', width: 1, opacity: 1 }] }), { ink: '#ffffff' })).toHaveLength(1);
  });

  it('reads hollow letters by their outline and a gradient by its stops', () => {
    expect(letteringIssues(box({ noFill: true, strokes: [{ color: '#000000', width: 6 }] }), { ink: '#ffffff' })).toHaveLength(1);
    const grad = { on: true, stops: [{ color: '#ffffff' }, { color: '#dddddd' }] };
    expect(letteringIssues(box({ gradient: grad }), { ink: '#000000' })).toHaveLength(1);
  });

  it('says nothing without a balloon or a known inside', () => {
    expect(letteringIssues(box({ color: '#000000' }, null), { ink: '#ffffff' })).toEqual([]);
    expect(letteringIssues(box({ color: '#000000', balloon: false }), { ink: '#ffffff' })).toEqual([]);
    expect(letteringIssues(box({ color: '#000000' }), { ink: null })).toEqual([]);
  });
});
