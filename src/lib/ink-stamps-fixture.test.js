import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FIXTURE, inkStampsFixture } from '../../text-engine/parity/ink-stamps.mjs';

// The Rust engine lays a box's brush ink with its own port of `strokeStamps`
// (brush.js), text-engine/src/paint/ink/stamps.rs, and holds it to a file of
// the stamps brush.js lays for a fixed set of strokes. This is the other
// half: the file is what brush.js gives now.
describe('the stamps the Rust port is held to', () => {
  it('are what brush.js gives', () => {
    // A failure here means brush.js moved a stamp. Run
    //   node text-engine/parity/ink-stamps.mjs
    // to write the file again, and port the change to
    // text-engine/src/paint/ink/stamps.rs, whose test (tests/ink.rs) reads it.
    expect(inkStampsFixture() === readFileSync(FIXTURE, 'utf8')).toBe(true);
  });
});
