// Lines held by a lock (`locks.breaks`) outlive a change of size, face,
// spacing or weight made in the Inspector - which writes the style and says
// so (`boxEdited`) - as they do one made by the agent. New words drop them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app, loadProjectPages, pageById, boxEdited, boxText } from './store.svelte.js';
import { applyCase, brokenLines, breaksFor } from './measure.js';
import { defaultStyle } from './data.js';

const text = 'WE CAN STILL CATCH THE LAST TRAIN';
const held = ['WE CAN STILL', 'CATCH THE', 'LAST TRAIN'];
const b = () => pageById(1).boxes[0];
const lines = () => {
  const x = b();
  return brokenLines(applyCase(boxText(x, pageById(1)), x.style), x.style, x.style.size, x.auto.breaks);
};

beforeEach(() => {
  const style = { ...defaultStyle(), size: 20, margin: 0.5 };
  loadProjectPages([
    {
      id: 1, w: 800, h: 1200,
      lines: [{ n: 1, en: text, tags: [] }],
      boxes: [{
        id: 'a', lineN: 1, text: null, x: 10, y: 10, w: 200, h: 90, style,
        auto: {
          on: true, refSize: 20, locks: { size: false, width: false, height: false, pos: false, breaks: true },
          status: null, reason: null, stamp: null, breaks: breaksFor(text, style, 20, held),
        },
      }],
    },
  ]);
});
afterEach(() => {
  app.chapterRef = null;
  loadProjectPages([]);
});

describe('held lines through an Inspector edit', () => {
  it('keep their lines when the size, face, spacing or weight changes', () => {
    expect(lines()).toEqual(held);
    for (const change of [{ size: 26 }, { font: 'Bangers' }, { letterSpacing: 2 }, { bold: true }, { italic: true }]) {
      Object.assign(b().style, change);
      boxEdited(b(), pageById(1));
      expect(b().auto.locks.breaks).toBe(true);
      expect(lines(), JSON.stringify(change)).toEqual(held);
    }
  });

  it('keep them when uppercase is turned on', () => {
    pageById(1).lines[0].en = 'We can still catch the last train';
    const x = b();
    x.auto.breaks = breaksFor('We can still catch the last train', x.style, 20, ['We can still', 'catch the', 'last train']);
    x.style.uppercase = true;
    boxEdited(x, pageById(1));
    expect(lines()).toEqual(held);
  });

  it('drop them when the words change', () => {
    pageById(1).lines[0].en = text + ' TONIGHT';
    boxEdited(b(), pageById(1));
    expect(lines()).toBeNull();
  });
});
