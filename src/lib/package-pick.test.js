import { describe, expect, it, vi } from 'vitest';

// The new-chapter dialog's one picker tells page images from a package by
// extension, and refuses a package picked with anything else.
const picked = vi.hoisted(() => ({ files: null }));
vi.mock('./importer.js', async (original) => ({
  ...(await original()),
  isTauri: () => true,
  pickFilesTauri: async () => picked.files,
  toPng: async (f) => ({ converted: f.name }),
}));
const { pickChapterSource, isPackageName } = await import('./package-flow.js');
const file = (name) => new File(['x'], name);

describe('the chapter source picker', () => {
  it('gives images back converted, and one package back as it is', async () => {
    picked.files = [file('1.jpg'), file('2.png')];
    expect(await pickChapterSource()).toEqual({ images: [{ converted: '1.jpg' }, { converted: '2.png' }] });
    const pkg = file('Ch 3.MTCHAPTER');
    picked.files = [pkg];
    expect(await pickChapterSource()).toEqual({ package: pkg });
    picked.files = [file('old.zip')];
    expect((await pickChapterSource()).package.name).toBe('old.zip');
  });

  it('refuses a package with images or a second package, and is null when cancelled', async () => {
    picked.files = [file('a.mtchapter'), file('1.png')];
    await expect(pickChapterSource()).rejects.toThrow(/one \.mtchapter package on its own/);
    picked.files = [file('a.mtchapter'), file('b.mtchapter')];
    await expect(pickChapterSource()).rejects.toThrow(/on its own/);
    picked.files = null;
    expect(await pickChapterSource()).toBe(null);
    expect(isPackageName('x.mtchapter.png')).toBe(false);
  });
});
