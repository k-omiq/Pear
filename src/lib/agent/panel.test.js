// The AI panel end to end, on a fake model: the prompt runs real tools inside
// an AI run, so Revert takes it back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../library.svelte.js', () => ({ chapterOpenSeq: () => 1 }));

const { app, loadProjectPages, settleEdits } = await import('../store.svelte.js');
const { initHistory, resetHistory } = await import('../editor/history.svelte.js');
const { aiRun, revertRun, __resetRun } = await import('./run.svelte.js');
const { panel, sendPrompt, clearChat, autoModel, panelTools, __setClient, MODELS } = await import('./panel.svelte.js');
const { defaultStyle } = await import('../data.js');

const box = (id) => ({ id, lineN: null, text: 'hi', x: 10, y: 10, w: 100, h: 40, style: { ...defaultStyle(), size: 20 } });

function fakeClient(script) {
  const sent = [];
  let i = 0;
  return {
    sent,
    messages: {
      stream(params) {
        sent.push(params);
        const msg = script[i++];
        return { on() {}, finalMessage: async () => msg };
      },
    },
  };
}

beforeEach(() => {
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('a'), box('b')] }]);
  initHistory();
  resetHistory();
  __resetRun();
  panel.privacyOk = true;
  clearChat();
});
afterEach(() => {
  settleEdits();
  resetHistory();
  __resetRun();
  app.chapterRef = null;
  loadProjectPages([]);
  __setClient(null);
});

describe('AI panel', () => {
  it('runs a prompt through the real tools, as one run Revert takes back', async () => {
    const client = fakeClient([
      {
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [{ type: 'tool_use', id: 't1', name: 'edit', input: { ops: [{ where: { pages: '1' }, set: { style: { italic: true } } }] } }],
      },
      { stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 8, cache_read_input_tokens: 100 }, content: [{ type: 'text', text: 'Made 2 boxes italic.' }] },
    ]);
    __setClient(client);
    expect(await sendPrompt('make page 1 italic')).toBe(true);

    expect(app.pages[0].boxes.every((b) => b.style.italic)).toBe(true);
    expect(panel.chat.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(panel.chat[1].text).toBe('Made 2 boxes italic.');
    expect(panel.chat[1].tools).toEqual([{ id: 't1', name: 'edit', ok: true, error: null }]);
    expect(panel.usage).toEqual({ input: 105, output: 28, cacheRead: 100, cacheWrite: 0 });
    // A short command goes to the fast model.
    expect(client.sent[0].model).toBe(MODELS.fast.id);
    // The panel's tools: the chapter's, not the door's chapter list.
    expect(client.sent[0].tools.some((t) => t.name === 'open_chapter')).toBe(false);
    expect(client.sent[0].system[0].text).toMatch(/AI panel inside Pear/);

    expect(aiRun.active).toBe(false);
    expect(aiRun.canRevert).toBe(true);
    revertRun();
    expect(app.pages[0].boxes.some((b) => b.style.italic)).toBe(false);
  });

  it('an API failure shows in words, and the chat can go on', async () => {
    __setClient({
      messages: {
        stream() {
          return { on() {}, finalMessage: async () => Promise.reject(Object.assign(new Error('x'), { status: 401 })) };
        },
      },
    });
    expect(await sendPrompt('hello')).toBe(false);
    expect(panel.error).toMatch(/key was refused/);
    expect(panel.running).toBe(false);
  });
});

describe('model choice', () => {
  it('short edits go fast, real work goes balanced, best only when pinned', () => {
    expect(autoModel('narration font on pages 2-5 to Anime Ace')).toBe('fast');
    expect(autoModel('make every scream red')).toBe('balanced');
    expect(autoModel('typeset this page')).toBe('balanced');
    expect(autoModel('check page 4')).toBe('balanced');
  });

  it('offers every chapter tool and none of the door\'s', () => {
    const names = panelTools().map((t) => t.name);
    expect(names).toContain('edit');
    expect(names).toContain('view');
    for (const n of ['chapters', 'open_chapter', 'close_chapter', 'job']) expect(names).not.toContain(n);
  });
});
