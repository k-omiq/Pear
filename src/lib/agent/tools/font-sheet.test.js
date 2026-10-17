import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// The sheet needs a canvas this lane does not have (the realfont lane draws
// it for real, colors-fonts.realfont.test.js); here the layout is pinned on
// its own, and the tool is tested around a stand-in renderer: which fonts,
// in which CSS, in what order, and what comes back.
const sheets = vi.hoisted(() => []);
vi.mock('../render.js', async (original) => {
  const real = await original();
  return {
    ...real,
    renderFontSheet: vi.fn(async (entries, opts) => {
      sheets.push({ entries, opts });
      const L = real.fontSheetLayout(entries.length);
      return {
        png: 'AAAA',
        mime: 'image/png',
        width: L.width,
        height: L.height,
        cells: entries.map((e, i) => ({ n: e.n, name: e.name, row: L.cells[i].row, col: L.cells[i].col, size: L.sample })),
      };
    }),
  };
});

const { app } = await import('../../store.svelte.js');
const { callTool, listTools } = await import('../registry.js');
const { fontSheetLayout, fitSampleSize, FONT_SHEET_MAX, MAX_SIDE } = await import('../render.js');
const { DEFAULT_SAMPLE, MAX_SAMPLE, sampleText } = await import('./font-sheet.js');
const { toMcpResult } = await import('../door.svelte.js');

const call = (args) => callTool('font_sheet', args, {});
const originalFonts = app.fonts;
const system = Array.from({ length: 50 }, (_, i) => ({ name: `System ${String(i).padStart(2, '0')}`, css: `"System ${i}", sans-serif`, system: true }));

beforeEach(() => {
  sheets.length = 0;
  app.fonts = {
    user: [{ name: 'Anime Ace', css: "'Anime Ace'" }, { name: 'CC Wild Words', css: "'CC Wild Words'" }],
    builtin: [{ name: 'Bangers', css: "'Bangers', cursive" }, { name: 'Comic Neue', css: "'Comic Neue', cursive" }, { name: 'Anime Ace', css: "'dup'" }],
    system,
  };
});
afterEach(() => {
  app.fonts = originalFonts;
});

describe('fontSheetLayout', () => {
  it('is empty for no fonts', () => {
    expect(fontSheetLayout(0)).toMatchObject({ cols: 0, rows: 0, width: 0, height: 0, cells: [] });
  });

  it('is one column up to ten fonts, two past that, filled down the first column first', () => {
    expect(fontSheetLayout(10).cols).toBe(1);
    const L = fontSheetLayout(11);
    expect(L.cols).toBe(2);
    expect(L.rows).toBe(6);
    expect(L.cells.slice(0, 7).map((c) => [c.col, c.row])).toEqual([[1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6], [2, 1]]);
  });

  it('keeps every count within the long side, cells inside the sheet and apart, samples legible', () => {
    for (let n = 1; n <= FONT_SHEET_MAX; n++) {
      const L = fontSheetLayout(n);
      expect(Math.max(L.width, L.height), String(n)).toBeLessThanOrEqual(MAX_SIDE);
      expect(L.cells).toHaveLength(n);
      expect(L.sample, String(n)).toBeGreaterThanOrEqual(30);
      expect(L.label).toBeGreaterThanOrEqual(11);
      for (const c of L.cells) {
        expect(c.x + c.w).toBeLessThanOrEqual(L.width);
        expect(c.y + c.h).toBeLessThanOrEqual(L.height);
      }
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = L.cells[i];
          const b = L.cells[j];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap, `${n}: ${i} ${j}`).toBe(false);
        }
      }
    }
  });

  it('caps the count at the sheet size', () => {
    expect(fontSheetLayout(100).cells).toHaveLength(FONT_SHEET_MAX);
  });

  it('shrinks a sample only when it is too wide, never under 8 px', () => {
    expect(fitSampleSize(40, 500, 700)).toBe(40);
    expect(fitSampleSize(40, 1400, 700)).toBe(20);
    expect(fitSampleSize(40, 100000, 700)).toBe(8);
  });
});

describe('sampleText', () => {
  it('is one trimmed line, cut to the limit, or the default', () => {
    expect(sampleText(undefined)).toBe(DEFAULT_SAMPLE);
    expect(sampleText('  \n ')).toBe(DEFAULT_SAMPLE);
    expect(sampleText('WHOOSH\n\tbang  ')).toBe('WHOOSH bang');
    expect(sampleText('x'.repeat(200))).toHaveLength(MAX_SAMPLE);
  });

  it('shows caps, lower case and punctuation by default', () => {
    expect(DEFAULT_SAMPLE).toMatch(/[A-Z]/);
    expect(DEFAULT_SAMPLE).toMatch(/[a-z]/);
    expect(DEFAULT_SAMPLE).toMatch(/[?!.]/);
  });
});

describe('font_sheet', () => {
  it('is listed as a read-only tool that says what it is for', () => {
    const t = listTools().find((x) => x.name === 'font_sheet');
    expect(t.write).toBe(false);
    expect(t.description).toMatch(/See fonts before choosing them/);
  });

  it('draws the named fonts in their own CSS, exact names, deduped, with a legend and one image', async () => {
    const r = await call({ fonts: ['bangers', 'Anime Ace', 'BANGERS'], text: 'DOKI DOKI' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(sheets[0].entries).toEqual([
      { n: 1, name: 'Bangers', css: "'Bangers', cursive", missing: false },
      { n: 2, name: 'Anime Ace', css: "'Anime Ace'", missing: false },
    ]);
    expect(sheets[0].opts.text).toBe('DOKI DOKI');
    expect(r.result.images).toEqual([{ png: 'AAAA', mime: 'image/png', width: expect.any(Number), height: expect.any(Number) }]);
    expect(r.result.legend).toEqual([{ n: 1, name: 'Bangers', row: 1, col: 1 }, { n: 2, name: 'Anime Ace', row: 2, col: 1 }]);
    expect(r.result.note).toMatch(/2 fonts asked for; 2 shown/);
  });

  it('refuses an unknown name with the nearest ones, before drawing anything', async () => {
    const r = await call({ fonts: ['Bangers', 'Anime Aec'] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no font "Anime Aec"');
    expect(r.hint).toMatch(/Anime Ace/);
    expect(sheets).toHaveLength(0);
  });

  it('filters by part of the name, case-insensitively', async () => {
    const r = await call({ match: 'COMIC' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(sheets[0].entries.map((e) => e.name)).toEqual(['Comic Neue']);
    expect(r.result.note).toMatch(/1 font match "COMIC"; 1 shown/);
    const none = await call({ match: 'zzzz' });
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/no font name contains "zzzz"/);
  });

  it('pages through every font, user fonts first, with offset and a note saying what is left', async () => {
    const all = 2 + 2 + 50; // Anime Ace once
    const first = await call({});
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(sheets[0].entries).toHaveLength(FONT_SHEET_MAX);
    expect(sheets[0].entries.slice(0, 4).map((e) => e.name)).toEqual(['Anime Ace', 'CC Wild Words', 'Bangers', 'Comic Neue']);
    expect(first.result.note).toMatch(new RegExp(`${all} fonts available; ${FONT_SHEET_MAX} shown, numbered 1-${FONT_SHEET_MAX}; ${all - FONT_SHEET_MAX} more: ask again with offset ${FONT_SHEET_MAX}`));
    const second = await call({ offset: FONT_SHEET_MAX });
    expect(sheets[1].entries[0].n).toBe(FONT_SHEET_MAX + 1);
    expect(sheets[1].entries).toHaveLength(all - FONT_SHEET_MAX);
    expect(second.result.note).not.toMatch(/more/);
    const past = await call({ offset: all });
    expect(past.ok).toBe(false);
    expect(past.error).toMatch(/past the 54 fonts/);
  });

  it('marks a family with no face on this machine', async () => {
    app.fonts.user.push({ name: 'Ghost', css: "'Ghost'" });
    const { setFontSource } = await import('../../store.svelte.js');
    setFontSource({ missing: (name) => name === 'Ghost', nameFor: () => null });
    try {
      const r = await call({ fonts: ['Ghost', 'Bangers'] });
      expect(r.result.legend[0]).toMatchObject({ name: 'Ghost', missing: true });
      expect(r.result.legend[1].missing).toBeUndefined();
    } finally {
      setFontSource(null);
    }
  });

  it.each([
    [{ fonts: ['Bangers'], match: 'b' }, /fonts or match, not both/],
    [{ fonts: [] }, /list of family names/],
    [{ fonts: 'Bangers' }, /list of family names/],
    [{ fonts: [3] }, /list of family names/],
    [{ fonts: Array.from({ length: 41 }, () => 'Bangers') }, /at most 40/],
    [{ match: 3 }, /match must be a string/],
    [{ text: 5 }, /text must be a string/],
    [{ offset: -1 }, /offset must be/],
    [{ offset: 1.5 }, /offset must be/],
  ])('refuses %j', async (args, re) => {
    const r = await call(args);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(re);
  });

  it('goes through the MCP door as an image block', async () => {
    const r = await call({ fonts: ['Bangers'] });
    const mcp = toMcpResult(r);
    expect(mcp.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    expect(JSON.parse(mcp.content[0].text).images[0].png).toBeUndefined();
  });
});
