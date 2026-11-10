import { describe, expect, it } from 'vitest';
import { guessLayout, pngSize } from './layout-guess.js';

// A PNG header of the given size: all the guess reads.
function png(w, h) {
  const head = new Uint8Array(24);
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(head.buffer).setUint32(16, w);
  new DataView(head.buffer).setUint32(20, h);
  return new File([head], 'p.png');
}

describe('the layout guess', () => {
  it('reads a PNG\'s size from its header and nothing from anything else', async () => {
    expect(await pngSize(png(800, 1200))).toEqual({ w: 800, h: 1200 });
    expect(await pngSize(new File(['not a png at all, long enough'], 'x.jpg'))).toBe(null);
    expect(await pngSize(new File([new Uint8Array(8)], 'short.png'))).toBe(null);
    expect(await pngSize(png(0, 10))).toBe(null);
  });

  it('is a long strip only when the median page is over 2.5 times as tall as wide', async () => {
    expect(await guessLayout([png(800, 1200)])).toBe('pages');
    expect(await guessLayout([png(800, 2000)])).toBe('pages');
    expect(await guessLayout([png(800, 2001)])).toBe('longstrip');
    // One tall page among ordinary ones does not make a strip, and the
    // reverse: a short last slice does not make the strip pages.
    expect(await guessLayout([png(800, 1200), png(800, 1200), png(800, 9000)])).toBe('pages');
    expect(await guessLayout([png(800, 9000), png(800, 9000), png(800, 900)])).toBe('longstrip');
    // An even count takes the middle two.
    expect(await guessLayout([png(100, 200), png(100, 300), png(100, 400), png(100, 500)])).toBe('longstrip');
    expect(await guessLayout([])).toBe('pages');
  });
});
