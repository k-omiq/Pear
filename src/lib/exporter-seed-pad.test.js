import { describe, expect, it } from 'vitest';
import { shadowSeed } from './exporter.js';

describe('shadowSeed', () => {
  it('gives different boxes with non-numeric ids different seeds', () => {
    expect(shadowSeed('b3', 0)).not.toBe(shadowSeed('b4', 0));
    expect(shadowSeed('b3', 0)).toBe(shadowSeed('b3', 0));
    expect(shadowSeed('b3', 0)).not.toBe(shadowSeed('b3', 1));
  });
});

