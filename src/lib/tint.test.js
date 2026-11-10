import { describe, expect, it } from 'vitest';
import { defaultStyle, normalizeStyle, normalizeOverlay, normalizeGradientOverlay, tintOf, olderOverlays, setTintKind } from './data.js';

// The Fill tab's Tint (2026-11-10) sits on the overlays' own data: the top
// colour overlay, or with none the top gradient overlay. Nothing is rewritten
// on load, so an old box keeps every overlay and paints as it did.
const style = (over) => normalizeStyle({ ...defaultStyle(), ...over });

describe('the Tint', () => {
  it('is off on a new box: no overlay at all', () => {
    const s = style({});
    expect(tintOf(s)).toBeNull();
    expect(olderOverlays(s)).toEqual([]);
  });
  it('is the top colour overlay; the rest come from an older file, untouched', () => {
    const a = { color: '#ff0000', blend: 'multiply', opacity: 0.5 };
    const b = { color: '#0000ff' };
    const g = { blend: 'screen' };
    const s = style({ colorOverlays: [a, b], gradientOverlays: [g] });
    expect(s.colorOverlays).toEqual([normalizeOverlay(a), normalizeOverlay(b)]);
    expect(s.gradientOverlays).toEqual([normalizeGradientOverlay(g)]);
    expect(tintOf(s)).toEqual({ kind: 'color', fx: s.colorOverlays[0] });
    expect(olderOverlays(s).map((o) => [o.kind, o.i])).toEqual([['color', 1], ['gradient', 0]]);
  });
  it('is the top gradient overlay when there is no colour one', () => {
    const s = style({ gradientOverlays: [{ blend: 'color' }, {}] });
    expect(tintOf(s)).toEqual({ kind: 'gradient', fx: s.gradientOverlays[0] });
    expect(olderOverlays(s).map((o) => [o.kind, o.i])).toEqual([['gradient', 1]]);
  });
  it('turns from a colour to a gradient of that colour and back, keeping its switch, mode and amount', () => {
    const s = style({ colorOverlays: [{ color: '#20a040', blend: 'multiply', opacity: 0.4, on: false }] });
    expect(setTintKind(s, 'color')).toBe(false);
    expect(setTintKind(s, 'gradient')).toBe(true);
    expect(s.colorOverlays).toEqual([]);
    const g = s.gradientOverlays[0];
    expect([g.on, g.blend, g.opacity]).toEqual([false, 'multiply', 0.4]);
    expect(g.gradient.stops.map((k) => k.color)).toEqual(['#20a040', '#20a040']);
    expect(setTintKind(s, 'color')).toBe(true);
    expect(s.gradientOverlays).toEqual([]);
    expect(s.colorOverlays[0]).toMatchObject({ on: false, color: '#20a040', blend: 'multiply', opacity: 0.4 });
  });
});
