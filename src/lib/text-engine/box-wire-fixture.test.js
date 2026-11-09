import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeBox } from '../../../text-engine/js/paint.mjs';
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
