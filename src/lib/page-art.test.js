import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { artImage, artReady, art, forgetArt } from './page-art.svelte.js';

// A fake Image that loads when the test says so.
let made;
const had = 'Image' in globalThis;
const old = globalThis.Image;
beforeEach(() => {
  made = [];
  globalThis.Image = class {
    naturalWidth = 0;
    set src(v) {
      this._src = v;
      made.push(this);
    }
    load() {
      this.naturalWidth = 10;
      this.onload?.();
    }
  };
  forgetArt();
});
afterEach(() => {
  forgetArt();
  if (had) globalThis.Image = old;
  else delete globalThis.Image;
});

describe('the held page art', () => {
  it('does not evict an image that is still loading, so its art arrives', () => {
    for (let i = 0; i < 9; i++) artImage(`p${i}`);
    expect(artImage('p0')).toBe(null);
    const v = art.version;
    made[0].load();
    expect(art.version).toBe(v + 1);
    expect(artReady('p0')).toBe(true);
    expect(artImage('p0')).toBe(made[0]);
  });

  it('evicts the oldest ready image past the limit', () => {
    for (let i = 0; i < 6; i++) artImage(`p${i}`);
    for (const m of made) m.load();
    artImage('p6');
    expect(artReady('p0')).toBe(false);
    expect(artReady('p1')).toBe(true);
  });
});

describe('a failed load', () => {
  it('does not drop a newer entry for the same src', () => {
    artImage('a');
    const first = made[0];
    forgetArt();
    artImage('a');
    first.onerror();
    expect(artImage('a')).toBe(null);
    expect(made.length).toBe(2);
  });
});
