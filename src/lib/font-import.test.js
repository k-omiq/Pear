import { describe, expect, it } from 'vitest';
import { planImport, finishPlan, needsConfirm, planWrites, editRow, renamePlanFamily, sortModesFor, itemsFromFiles, isFontFileName } from './font-import.js';

// Sorting a pile of font files into families, and when the user is asked
// first. `info` is what font-names.js reads from a file; a null one is a file
// sorted by its name alone.

let n = 0;
const info = (family, style, more = {}) => ({
  kind: 'ttf',
  family,
  style,
  typoFamily: null,
  typoStyle: null,
  weight: /bold/i.test(style) ? 700 : 400,
  width: 5,
  bold: /bold/i.test(style),
  italic: /italic|oblique/i.test(style),
  ...more,
});
const item = (name, i, dir = '') => ({ id: `t${++n}`, name, dir, info: i });
const slots = (plan, family) => Object.fromEntries(plan.rows.filter((r) => r.family === family && r.slot).map((r) => [r.slot, r.name]));

// A typeface as a foundry ships it: four style-linked faces and two more
// weights that are families of their own by their legacy names.
const foundry = () => [
  item('Foo-Regular.ttf', info('Foo', 'Regular', { typoFamily: 'Foo', typoStyle: 'Regular' }), 'Foo'),
  item('Foo-Bold.ttf', info('Foo', 'Bold', { typoFamily: 'Foo', typoStyle: 'Bold' }), 'Foo'),
  item('Foo-Italic.ttf', info('Foo', 'Italic', { typoFamily: 'Foo', typoStyle: 'Italic' }), 'Foo'),
  item('Foo-BoldItalic.ttf', info('Foo', 'Bold Italic', { typoFamily: 'Foo', typoStyle: 'Bold Italic' }), 'Foo'),
  item('Foo-Light.ttf', info('Foo Light', 'Regular', { typoFamily: 'Foo', typoStyle: 'Light', weight: 300 }), 'Foo'),
  item('Foo-Black.ttf', info('Foo Black', 'Regular', { typoFamily: 'Foo', typoStyle: 'Black', weight: 900 }), 'Foo'),
];

describe('sorting by the names inside the files', () => {
  it('makes one family per style-linked name, every face in its slot', () => {
    const plan = planImport(foundry(), 'names');
    expect(plan.families.map((f) => f.name)).toEqual(['Foo', 'Foo Light', 'Foo Black']);
    expect(slots(plan, 'Foo')).toEqual({ regular: 'Foo-Regular.ttf', bold: 'Foo-Bold.ttf', italic: 'Foo-Italic.ttf', boldItalic: 'Foo-BoldItalic.ttf' });
    expect(slots(plan, 'Foo Light')).toEqual({ regular: 'Foo-Light.ttf' });
    expect(plan.leftOut).toEqual([]);
    // Three families from one folder: asked before anything is saved.
    expect(needsConfirm(plan)).toBe(true);
    expect(planWrites(plan)).toHaveLength(6);
  });

  it('saves a single clean family without asking', () => {
    const plan = planImport(foundry().slice(0, 4), 'names');
    expect(plan.families).toHaveLength(1);
    expect(needsConfirm(plan)).toBe(false);
  });

  it('falls back on the file name for a file whose names could not be read', () => {
    const plan = planImport([item('Wild_Words-BoldItalic.woff2', null), item('Wild_Words.woff2', null)], 'names');
    expect(slots(plan, 'Wild Words')).toEqual({ boldItalic: 'Wild_Words-BoldItalic.woff2', regular: 'Wild_Words.woff2' });
  });
});

describe('sorting by typeface', () => {
  it('is offered only when a file belongs to a bigger typeface', () => {
    expect(sortModesFor(foundry()).map((m) => m.id)).toContain('typeface');
    expect(sortModesFor(foundry().slice(0, 4)).map((m) => m.id)).not.toContain('typeface');
  });

  it('keeps the closest weight for each slot and leaves the rest out, saying why', () => {
    const plan = planImport(foundry(), 'typeface');
    expect(plan.families.map((f) => f.name)).toEqual(['Foo']);
    expect(slots(plan, 'Foo')).toEqual({ regular: 'Foo-Regular.ttf', bold: 'Foo-Bold.ttf', italic: 'Foo-Italic.ttf', boldItalic: 'Foo-BoldItalic.ttf' });
    const out = plan.leftOut.map((r) => [r.name, r.note]);
    expect(out).toEqual([
      ['Foo-Light.ttf', 'Regular is taken by Foo-Regular.ttf'],
      ['Foo-Black.ttf', 'Bold is taken by Foo-Bold.ttf'],
    ]);
    expect(needsConfirm(plan)).toBe(true);
  });

  it('flags a weight placed in a slot that does not name it', () => {
    const plan = planImport([item('Bar-Light.ttf', info('Bar Light', 'Regular', { typoFamily: 'Bar', typoStyle: 'Light', weight: 300 }))], 'typeface');
    expect(plan.rows[0]).toMatchObject({ family: 'Bar', slot: 'regular', note: 'Light placed as Regular' });
    expect(needsConfirm(plan)).toBe(true);
  });
});

describe('sorting by file name and by folder', () => {
  it('reads the family and slot off the file name', () => {
    const plan = planImport(foundry(), 'filename');
    // Black is a heavy word: the file name puts it on Bold, where Foo-Bold is.
    expect(slots(plan, 'Foo').bold).toBe('Foo-Bold.ttf');
    expect(plan.leftOut.map((r) => r.name)).toEqual(['Foo-Black.ttf']);
    expect(slots(plan, 'Foo Light')).toEqual({ regular: 'Foo-Light.ttf' });
  });

  it('makes one family of each folder', () => {
    const items = [
      item('a.ttf', info('Alpha', 'Regular'), 'Pack/Alpha'),
      item('b.ttf', info('Beta', 'Bold'), 'Pack/Alpha'),
      item('c.ttf', info('Gamma', 'Regular'), 'Pack/Other'),
    ];
    const plan = planImport(items, 'folder');
    expect(plan.families.map((f) => f.name)).toEqual(['Alpha', 'Other']);
    expect(slots(plan, 'Alpha')).toEqual({ regular: 'a.ttf', bold: 'b.ttf' });
  });
});

describe('what the confirm step shows and changes', () => {
  it('says a family adds to one already in the library, and what it replaces', () => {
    const existing = [{ name: 'Foo', faces: { regular: { file: 'old-foo.ttf' }, bold: null, italic: null, boldItalic: null } }];
    const plan = planImport(foundry().slice(0, 2), 'names', { existing });
    expect(plan.families[0]).toMatchObject({ name: 'Foo', existing: true, replaces: { regular: 'old-foo.ttf' } });
    expect(needsConfirm(plan)).toBe(true);
  });

  it('will not import under a built-in font’s name until it is renamed, and imports the rest', () => {
    let plan = planImport([item('Bangers.ttf', info('Bangers', 'Regular')), item('Mine.ttf', info('Mine', 'Regular'))], 'names', { builtins: ['Bangers'] });
    expect(plan.blocked).toEqual(['Bangers']);
    expect(needsConfirm(plan)).toBe(true);
    expect(planWrites(plan).map((w) => w.family)).toEqual(['Mine']);
    plan = finishPlan({ mode: plan.mode, rows: plan.rows.filter((r) => r.family === 'Bangers') }, { builtins: ['Bangers'] });
    expect(planWrites(plan)).toEqual([]);
    plan = finishPlan({ mode: plan.mode, rows: renamePlanFamily(plan.rows, 'Bangers', 'Bangers Mine') }, { builtins: ['Bangers'] });
    expect(plan.ok).toBe(true);
    expect(planWrites(plan)).toEqual([{ id: plan.rows[0].id, family: 'Bangers Mine', slot: 'regular' }]);
  });

  it('marks two files moved onto one slot and imports neither until fixed', () => {
    let plan = planImport(foundry(), 'names');
    const light = plan.rows.find((r) => r.name === 'Foo-Light.ttf');
    plan = finishPlan({ mode: 'names', rows: editRow(plan.rows, light.id, { family: 'Foo' }) });
    expect(plan.clashes).toBe(1);
    expect(plan.ok).toBe(false);
    expect(plan.rows.filter((r) => r.clash).map((r) => r.name)).toEqual(['Foo-Regular.ttf', 'Foo-Light.ttf']);
    // Left out, the clash is gone.
    plan = finishPlan({ mode: 'names', rows: editRow(plan.rows, light.id, { slot: null }) });
    expect(plan.ok).toBe(true);
    expect(plan.leftOut.map((r) => r.name)).toEqual(['Foo-Light.ttf']);
    expect(planWrites(plan).map((w) => w.id)).not.toContain(light.id);
  });
});

describe('finding the files', () => {
  it('takes only font files, with the folder each came from', () => {
    const f = (name, rel = '') => ({ name, size: 1, webkitRelativePath: rel, arrayBuffer: async () => new ArrayBuffer(1) });
    const items = itemsFromFiles([f('a.ttf', 'Pack/Sub/a.ttf'), f('readme.txt', 'Pack/readme.txt'), f('b.OTF'), f('c.woff2')]);
    expect(items.map((i) => [i.name, i.dir])).toEqual([
      ['a.ttf', 'Pack/Sub'],
      ['b.OTF', ''],
      ['c.woff2', ''],
    ]);
    expect(isFontFileName('x.ttc')).toBe(true);
    expect(isFontFileName('x.png')).toBe(false);
  });
});
