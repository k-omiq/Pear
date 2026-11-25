import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FIXTURE, inkStampsFixture } from '../../text-engine/parity/ink-stamps.mjs';

// The Rust engine lays a box's brush ink with its own port of `strokeStamps`
// (brush.js), text-engine/src/paint/ink/stamps.rs, and holds it to a file of
// the stamps brush.js lays for a fixed set of strokes. This is the other
// half: the file is what brush.js gives now.
//
// Numbers are held to 1e-9, the tolerance tests/ink.rs uses, not to the last
// bit: Math.sin and friends differ in the last digits between builds of Node
// (x64 and ARM, Node 20 and 26), and the file is written on one of them.
const TOL = 1e-9;

// The first place `got` and `want` part, or null when they agree.
function firstDifference(got, want, at = '') {
  if (typeof got === 'number' && typeof want === 'number') {
    return Math.abs(got - want) <= TOL ? null : `${at}: ${got} against ${want}`;
  }
  if (Array.isArray(got) || Array.isArray(want)) {
    if (!Array.isArray(got) || !Array.isArray(want)) return `${at}: not both lists`;
    if (got.length !== want.length) return `${at}: ${got.length} items against ${want.length}`;
    for (let i = 0; i < got.length; i++) {
      const d = firstDifference(got[i], want[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (got && want && typeof got === 'object' && typeof want === 'object') {
    const keys = new Set([...Object.keys(got), ...Object.keys(want)]);
    for (const k of keys) {
      const d = firstDifference(got[k], want[k], `${at}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return Object.is(got, want) ? null : `${at}: ${JSON.stringify(got)} against ${JSON.stringify(want)}`;
}

describe('the stamps the Rust port is held to', () => {
  it('are what brush.js gives', () => {
    // A failure here means brush.js moved a stamp. Run
    //   node text-engine/parity/ink-stamps.mjs
    // to write the file again, and port the change to
    // text-engine/src/paint/ink/stamps.rs, whose test (tests/ink.rs) reads it.
    const got = JSON.parse(inkStampsFixture());
    const want = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(firstDifference(got, want)).toBe(null);
  });

  it('notices a stamp that moved', () => {
    const want = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const moved = structuredClone(want);
    moved.cases[0].stamps[0][0] += 1e-6;
    expect(firstDifference(moved, want)).toMatch(/^\.cases\[0\]\.stamps\[0\]\[0\]/);
    expect(firstDifference(want, want)).toBe(null);
  });
});
