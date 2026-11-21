// The editor's layouts (UI combos): presets, the per-kind custom layout, and
// the migration from installs that never had them.
import { afterEach, describe, expect, it } from 'vitest';
import {
  PRESETS,
  layouts,
  normalizeLayouts,
  setLayouts,
  snapshotLayouts,
  comboFor,
  layoutIdFor,
  useLayout,
  setComboField,
  onLayoutsChange,
} from './layouts.svelte.js';

afterEach(() => {
  setLayouts(null);
  onLayoutsChange(null);
});

describe('migration', () => {
  it('opens each kind of chapter the way it opened before layouts existed', () => {
    for (const raw of [null, undefined, {}, 'junk', { use: 7 }, { custom: [] }]) {
      setLayouts(raw);
      expect(comboFor('translate')).toEqual({ tools: false, queue: 'docked' });
      expect(comboFor('typeset')).toEqual({ tools: true, queue: 'floating' });
    }
    // An unknown kind (a chapter.json with no mode) is a typeset chapter.
    expect(comboFor(undefined)).toBe(PRESETS.typeset);
  });

  it('keeps what reads and drops what does not, field by field', () => {
    const n = normalizeLayouts({
      use: { translate: 'custom', typeset: 'nonsense' },
      custom: { translate: { tools: 'yes', queue: 'floating', options: 'docked' }, typeset: { queue: 'sideways' } },
    });
    expect(n.use).toEqual({ translate: 'custom', typeset: 'typeset' });
    // A docked options pane saved by an older build is dropped: only the
    // queue docks now.
    expect(n.custom.translate).toEqual({ tools: true, queue: 'floating' });
    expect(n.custom.typeset).toEqual({ tools: true, queue: 'docked' });
  });

  it('round-trips through the stored form', () => {
    useLayout('typeset', 'translate');
    setComboField('translate', 'tools', true);
    const back = normalizeLayouts(JSON.parse(JSON.stringify(snapshotLayouts())));
    expect(back).toEqual(snapshotLayouts());
  });
});

describe('choosing', () => {
  it('uses a preset for one kind only, and saves each change', () => {
    let writes = 0;
    onLayoutsChange(() => writes++);
    expect(useLayout('translate', 'typeset')).toBe(true);
    expect(layoutIdFor('translate')).toBe('typeset');
    expect(layoutIdFor('typeset')).toBe('typeset');
    expect(useLayout('translate', 'typeset')).toBe(true);
    expect(useLayout('translate', 'nope')).toBe(false);
    expect(writes).toBe(1);
  });

  it('makes a custom layout of a mix, and goes back to the preset a mix matches', () => {
    setComboField('translate', 'tools', true);
    expect(layoutIdFor('translate')).toBe('custom');
    expect(comboFor('translate')).toEqual({ tools: true, queue: 'docked' });
    // Queue floating too: that is the Typeset preset, so the preset is used and
    // the custom layout is kept as it was.
    setComboField('translate', 'queue', 'floating');
    expect(layoutIdFor('translate')).toBe('typeset');
    expect(layouts.custom.translate).toEqual({ tools: true, queue: 'docked' });
    useLayout('translate', 'custom');
    expect(comboFor('translate').queue).toBe('docked');
  });

  it('keeps each kind\'s custom layout apart', () => {
    setComboField('typeset', 'queue', 'docked');
    expect(layoutIdFor('typeset')).toBe('custom');
    expect(layouts.custom.typeset).toEqual({ tools: true, queue: 'docked' });
    expect(layoutIdFor('translate')).toBe('translate');
    expect(layouts.custom.translate).toEqual({ tools: true, queue: 'docked' });
  });

  it('refuses a field it does not have', () => {
    expect(setComboField('translate', 'sidebar', true)).toBe(false);
    expect(layoutIdFor('translate')).toBe('translate');
  });
});
