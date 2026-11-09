// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { releaseLeavingImages } from './release-image.js';

describe('releaseLeavingImages', () => {
  it('takes the src off every matching <img> not kept, and leaves the kept ones and the rest alone', () => {
    const root = document.createElement('div');
    root.innerHTML = '<img class="page-img" src="asset://localhost/p0.png"><img class="page-img" src="asset://localhost/p1.png"><img class="page-img"><img class="other" src="asset://localhost/p2.png">';
    const [a, b, none, other] = root.querySelectorAll('img');
    expect(releaseLeavingImages(root, 'img.page-img', new Set(['asset://localhost/p1.png']))).toBe(1);
    expect(a.hasAttribute('src')).toBe(false);
    expect(b.getAttribute('src')).toBe('asset://localhost/p1.png');
    expect(none.hasAttribute('src')).toBe(false);
    expect(other.getAttribute('src')).toBe('asset://localhost/p2.png');
    expect(releaseLeavingImages(null, 'img', new Set())).toBe(0);
  });
});
