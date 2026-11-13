// The AI panel on the real Claude SDK, over the Rust-backed fetch with a fake
// Tauri: every request the SDK sends is checked against the rules the Claude
// API holds a chat to, prompt after prompt. The first prompt alone never
// shows a broken chat; the second one sends it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { tauriFetch } from './transport.js';

vi.mock('../library.svelte.js', () => ({ chapterOpenSeq: () => 1 }));

const { app, loadProjectPages, settleEdits } = await import('../store.svelte.js');
const { initHistory, resetHistory } = await import('../editor/history.svelte.js');
const { __resetRun } = await import('./run.svelte.js');
const { panel, sendPrompt, stopPrompt, clearChat, setModel, __setClient } = await import('./panel.svelte.js');
const { defaultStyle } = await import('../data.js');

const box = (id) => ({ id, lineN: null, text: 'hi', x: 10, y: 10, w: 100, h: 40, style: { ...defaultStyle(), size: 20 } });

// What the API refuses in a request body, as its error text.
export function apiProblems(body) {
  const out = [];
  const msgs = body.messages ?? [];
  let marks = 0;
  const countMarks = (b) => {
    if (b?.cache_control) marks++;
  };
  (body.tools ?? []).forEach(countMarks);
  (Array.isArray(body.system) ? body.system : []).forEach(countMarks);
  if (msgs[0]?.role !== 'user') out.push('first message must be user');
  msgs.forEach((m, i) => {
    if (i && msgs[i - 1].role === m.role) out.push(`messages ${i - 1} and ${i} share a role`);
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (!content?.length) out.push(`message ${i} is empty`);
    for (const b of content ?? []) {
      countMarks(b);
      if (b.type === 'text' && !String(b.text ?? '').trim()) out.push(`message ${i}: text content blocks must contain non-whitespace text`);
      if (b.type === 'tool_result') {
        for (const c of b.content ?? []) {
          countMarks(c);
          if (c.type === 'text' && !String(c.text ?? '').trim()) out.push(`message ${i}: empty text in a tool_result`);
        }
      }
    }
    if (m.role === 'assistant') {
      const uses = content.filter((b) => b.type === 'tool_use').map((b) => b.id);
      if (!uses.length) return;
      const next = msgs[i + 1];
      if (!next) {
        out.push(`message ${i}: tool_use with no tool_result after it`);
        return;
      }
      const nc = Array.isArray(next.content) ? next.content : [];
      const results = nc.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
      for (const id of uses) if (!results.includes(id)) out.push(`tool_use ids were found without tool_result blocks immediately after: ${id}`);
      const firstOther = nc.findIndex((b) => b.type !== 'tool_result');
      if (firstOther >= 0 && nc.slice(firstOther).some((b) => b.type === 'tool_result')) out.push(`message ${i + 1}: tool_result after other content`);
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      const prev = msgs[i - 1];
      const uses = prev?.role === 'assistant' && Array.isArray(prev.content) ? prev.content.filter((b) => b.type === 'tool_use').map((b) => b.id) : [];
      for (const b of m.content) if (b.type === 'tool_result' && !uses.includes(b.tool_use_id)) out.push(`unexpected tool_use_id in tool_result: ${b.tool_use_id}`);
    }
  });
  if (marks > 4) out.push(`A maximum of 4 blocks with cache_control may be provided. Found ${marks}.`);
  return out;
}

// One answer as the API streams it.
function sse(msg) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let s = ev('message_start', {
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  });
  msg.content.forEach((b, index) => {
    if (b.type === 'text') {
      s += ev('content_block_start', { index, content_block: { type: 'text', text: '', citations: null } });
      if (b.text) s += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    } else if (b.type === 'tool_use') {
      s += ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      s += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    s += ev('content_block_stop', { index });
  });
  s += ev('message_delta', { delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
  s += ev('message_stop', {});
  return s;
}

// A fake API: answers from `script` in order, and refuses a body the real
// one would refuse.
function fakeApi(script) {
  const bodies = [];
  let i = 0;
  class Channel {
    onmessage = null;
  }
  const invoke = async (cmd, args) => {
    if (cmd !== 'ai_request') return;
    const body = JSON.parse(args.body);
    bodies.push(body);
    const problems = apiProblems(body);
    const send = (f) => queueMicrotask(() => args.onFrame.onmessage(f));
    if (problems.length) {
      send({ t: 'head', status: 400, headers: [['content-type', 'application/json']] });
      send({ t: 'chunk', text: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: problems.join('; ') } }) });
      send({ t: 'end' });
      return;
    }
    const step = script[i++];
    if (step?.hang) return; // never answers: a Stop ends it
    send({ t: 'head', status: 200, headers: [['content-type', 'text/event-stream']] });
    send({ t: 'chunk', text: sse(step) });
    send({ t: 'end' });
  };
  const client = new Anthropic({ apiKey: 'x', baseURL: 'https://api.anthropic.com', dangerouslyAllowBrowser: true, fetch: tauriFetch({ invoke, Channel }), maxRetries: 0 });
  return { client, bodies };
}

const italic = (id) => ({ type: 'tool_use', id, name: 'edit', input: { ops: [{ where: { pages: '1' }, set: { style: { italic: true } } }] } });

beforeEach(() => {
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('a'), box('b')] }]);
  initHistory();
  resetHistory();
  __resetRun();
  panel.privacyOk = true;
  setModel('auto');
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

describe('AI panel on the real SDK, prompt after prompt', () => {
  it('a second and third prompt send a valid chat', async () => {
    const api = fakeApi([
      { stop_reason: 'tool_use', content: [{ type: 'text', text: 'On it.' }, italic('t1')] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
      { stop_reason: 'tool_use', content: [italic('t2')] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done again.' }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Third.' }] },
    ]);
    __setClient(api.client);
    expect(await sendPrompt('make page 1 italic')).toBe(true);
    expect(panel.error).toBe(null);
    expect(await sendPrompt('and again')).toBe(true);
    expect(panel.error).toBe(null);
    setModel('best');
    expect(await sendPrompt('one more')).toBe(true);
    expect(panel.error).toBe(null);
    expect(api.bodies.length).toBe(5);
  });

  it('an answer that ends in only white space does not break the next prompt', async () => {
    const api = fakeApi([
      { stop_reason: 'tool_use', content: [{ type: 'text', text: '\n\n' }, italic('t1')] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '\n' }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
    ]);
    __setClient(api.client);
    expect(await sendPrompt('make page 1 italic')).toBe(true);
    expect(panel.error).toBe(null);
    expect(await sendPrompt('thanks')).toBe(true);
    expect(panel.error).toBe(null);
  });

  it('a Stop mid-request leaves a chat the next prompt can send', async () => {
    const api = fakeApi([{ stop_reason: 'tool_use', content: [italic('t1')] }, { hang: true }, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
    __setClient(api.client);
    const p = sendPrompt('make page 1 italic');
    await vi.waitFor(() => expect(api.bodies.length).toBe(2));
    stopPrompt();
    await p;
    expect(await sendPrompt('go on')).toBe(true);
    expect(panel.error).toBe(null);
  });

  it('a user edit between prompts does not break the next one', async () => {
    const api = fakeApi([
      { stop_reason: 'tool_use', content: [italic('t1')] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
      { stop_reason: 'tool_use', content: [italic('t2')] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
    ]);
    __setClient(api.client);
    expect(await sendPrompt('make page 1 italic')).toBe(true);
    app.pages[0].boxes[0].text = 'changed by hand';
    app.pages[0].boxes.push(box('c'));
    expect(await sendPrompt('make page 1 italic again')).toBe(true);
    expect(panel.error).toBe(null);
  });
});

// The cache reads a request's start back when it is the same, byte for byte,
// as what an earlier request marked. Marks stripped, each request must start
// with the one before it.
const unmark = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'cache_control' ? undefined : x)));
function sharedPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && JSON.stringify(a[i]) === JSON.stringify(b[i])) i++;
  return i;
}

describe('AI panel cache', () => {
  it('every request starts with the one before it, prompt after prompt', async () => {
    const view = (id) => ({ type: 'tool_use', id, name: 'view', input: { page: 1 } });
    const api = fakeApi([
      { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Looking.' }, view('v1')] },
      { stop_reason: 'tool_use', content: [italic('t1')] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
      { stop_reason: 'tool_use', content: [italic('t2')] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done again.' }] },
    ]);
    __setClient(api.client);
    setModel('balanced');
    await sendPrompt('make page 1 italic');
    await sendPrompt('and again');
    const b = api.bodies.map(unmark);
    for (let i = 1; i < b.length; i++) {
      expect(JSON.stringify(b[i].tools)).toBe(JSON.stringify(b[0].tools));
      expect(JSON.stringify(b[i].system)).toBe(JSON.stringify(b[0].system));
      const prev = b[i - 1].messages;
      const shared = sharedPrefix(prev, b[i].messages);
      // A new prompt adds to the last user message of the one before: all
      // but that message is shared. Inside a prompt the whole chat is.
      expect(shared, `request ${i}`).toBeGreaterThanOrEqual(prev.length - 1);
    }
    // Marks: the tools, the system prompt, and the chat's end. Never more than 4.
    for (const body of api.bodies) {
      const n = JSON.stringify(body).split('"cache_control"').length - 1;
      expect(n).toBeLessThanOrEqual(4);
    }
  });
});

describe('Auto and the cache', () => {
  it('Auto does not step down to a model with no cache inside a chat', async () => {
    const api = fakeApi([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Typeset.' }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'You are welcome.' }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi.' }] },
    ]);
    __setClient(api.client);
    await sendPrompt('typeset this page');
    await sendPrompt('ok thanks');
    expect(api.bodies.map((b) => b.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5']);
    // A new chat starts fresh.
    clearChat();
    await sendPrompt('hi there');
    expect(api.bodies[2].model).toBe('claude-haiku-5-5');
  });
});
