import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BOX_WIRE_VERSION, WIRE_VERSION, encodeBox, paintsBoxes } from '../../../text-engine/js/paint.mjs';
import { request } from '../../../text-engine/tests/data/box_wire_distinct.request.mjs';

// The Rust test text-engine/tests/paint_wire.rs decodes this fixture and
// checks every field against a value of its own (review F72). This keeps the
// fixture what `encodeBox` writes, so a change to either side of the wire
// fails one of the two.
describe('the box wire fixture the Rust decoder is checked against', () => {
  it('is what encodeBox writes for its request', () => {
    const file = fileURLToPath(new URL('../../../text-engine/tests/data/box_wire_distinct.hex', import.meta.url));
    const kept = readFileSync(file, 'utf8').replace(/\s+/g, '');
    expect(Buffer.from(encodeBox(request)).toString('hex')).toBe(kept);
  });
});

// A box job carries the glyph job: a wasm of the right box version but an
// older glyph version (a stale build after a glyph bump) does not paint boxes.
describe('paintsBoxes', () => {
  const wasm = (box, glyph) => ({ exports: { mt_paint_box: () => 0, mt_paint_box_wire_version: () => box, mt_paint_wire_version: () => glyph } });
  it('needs both the box and the glyph wire version', () => {
    expect(paintsBoxes(wasm(BOX_WIRE_VERSION, WIRE_VERSION))).toBe(true);
    expect(paintsBoxes(wasm(BOX_WIRE_VERSION, WIRE_VERSION - 1))).toBe(false);
    expect(paintsBoxes(wasm(BOX_WIRE_VERSION - 1, WIRE_VERSION))).toBe(false);
  });
});
