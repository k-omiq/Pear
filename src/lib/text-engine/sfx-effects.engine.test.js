import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine } from '../../../text-engine/js/engine.mjs';
import { encodeJob, paintBox, paintJob } from '../../../text-engine/js/paint.mjs';
import { engineWasm, fixtureFont } from '../../test/rust-engine.js';

let engine, font;
beforeAll(async () => {
  engine = await createEngine(engineWasm());
  font = engine.addFont(fixtureFont('ComicNeue-Regular.ttf'));
});

const letter = (x, more = {}) => ({ text: 'I', x, y: 60, ...more });
const job = (runs, more = {}) => ({
  curved: true, align: 'left', bands: [{ color: '#ff0000', opacity: 1, line: 12 }],
  fill: { kind: 'solid', color: '#000000' }, runs, ...more,
});
const paint = (j) => paintJob(engine, { font, size: 60, job: j });
const same = (a, b) => a.width === b.width && a.height === b.height && a.data.every((v, i) => v === b.data[i]);

describe('SFX effects on the wire', () => {
  it('writes the join, the negative and each run’s pen and afterimage flag', () => {
    const j = job([letter(40, { pen: 0.5, ghost: true })], {
      strokeOrder: 'each', strokeJoin: 'miter', negative: { color: '#0000ff', grow: 3 },
    });
    const b = encodeJob({ font, size: 60, job: j }).slice();
    const w = new DataView(b.buffer);
    // flags after the face (24), size, transform and weight (64), at 88.
    expect(w.getUint32(88, true)).toBe(1 | 8 | 16);
    // join, the negative's colour and grow after the align, spacing and silhouette.
    expect(w.getUint32(108, true)).toBe(1);
    expect([...b.slice(112, 116)]).toEqual([0, 0, 255, 255]);
    expect(w.getFloat64(116, true)).toBe(3);
    expect(() => encodeJob({ font, job: job([], { strokeJoin: 'bevel' }) })).toThrow(/strokeJoin/);
  });

  it('paints each effect differently from the plain job', () => {
    const runs = [letter(40), letter(52)];
    const plain = paint(job(runs));
    for (const more of [
      { strokeOrder: 'each' },
      { strokeJoin: 'miter' },
      { negative: { color: '#0000ff', grow: 4 } },
    ]) {
      expect(same(paint(job(runs, more)), plain), JSON.stringify(more)).toBe(false);
    }
    expect(same(paint(job([letter(40, { pen: 0.5 }), letter(52)])), plain)).toBe(false);
    const ghost = paint(job([...runs, letter(20, { ghost: true, fill: { kind: 'solid', color: '#808080' } })]));
    expect(ghost.width).toBeGreaterThan(plain.width);
  });

  it('paints a run of alike shadows, each moved, and a grown one wider', () => {
    const box = (shadows) => paintBox(engine, { width: 200, height: 120, font, size: 60, job: job([letter(40)]), shadows });
    const sh = (x, grow = 0) => ({ color: '#0000ff', opacity: 1, x, y: 0, blur: 0, grow });
    const steps = box([sh(20), sh(40), sh(60)]);
    expect(steps.width).toBeGreaterThan(box([sh(20)]).width);
    expect(box([sh(60, 6)]).width).toBeGreaterThan(box([sh(60)]).width);
  });
});
