import { describe, it, expect } from 'vitest';
import { agentLoop, toApiTools, withCacheMark, toToolContent, dropOldImages, pushUserText } from './loop.js';

// A fake model: each turn returns the next scripted message, and records what
// it was sent.
function fakeClient(script) {
  const sent = [];
  let i = 0;
  return {
    sent,
    messages: {
      stream(params, opts) {
        sent.push(structuredClone(params));
        const msg = script[i++];
        const handlers = {};
        return {
          on(ev, fn) {
            handlers[ev] = fn;
          },
          async finalMessage() {
            if (opts?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            if (typeof msg === 'function') return msg(params);
            for (const b of msg.content) if (b.type === 'text') handlers.text?.(b.text);
            return msg;
          },
        };
      },
    },
  };
}

const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const turn = (content, stop_reason, usage = { input_tokens: 10, output_tokens: 5 }) => ({ content, stop_reason, usage });

describe('agentLoop', () => {
  it('runs tools until the model ends its turn', async () => {
    const client = fakeClient([
      turn([{ type: 'text', text: 'Looking.' }, toolUse('t1', 'context'), toolUse('t2', 'query', { where: { pages: '1' } })], 'tool_use'),
      turn([{ type: 'text', text: 'Done: 3 boxes.' }], 'end_turn', { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 100 }),
    ]);
    const ran = [];
    const events = [];
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'narration font to X' }] }];
    const out = await agentLoop({
      client,
      model: 'm',
      system: [],
      tools: [],
      messages,
      runTool: async (name, input) => (ran.push([name, input]), { ok: true, result: { n: ran.length } }),
      onEvent: (e) => events.push(e.type),
    });
    expect(out.stop).toBe('end_turn');
    expect(out.turns).toBe(2);
    expect(out.toolCalls).toBe(2);
    expect(ran).toEqual([
      ['context', {}],
      ['query', { where: { pages: '1' } }],
    ]);
    expect(out.usage).toEqual({ input: 14, output: 8, cacheRead: 100, cacheWrite: 0 });
    // The results went back in one user message, in order.
    const results = client.sent[1].messages[2];
    expect(results.role).toBe('user');
    expect(results.content.map((r) => r.tool_use_id)).toEqual(['t1', 't2']);
    expect(events).toContain('text');
    expect(events).toContain('toolDone');
  });

  it('a failed tool is an error result, and the loop goes on', async () => {
    const client = fakeClient([turn([toolUse('t1', 'edit')], 'tool_use'), turn([{ type: 'text', text: 'Fixed.' }], 'end_turn')]);
    const messages = [{ role: 'user', content: 'x' }];
    await agentLoop({ client, model: 'm', system: [], tools: [], messages, runTool: async () => ({ ok: false, error: 'no box b9', hint: 'close: b8' }) });
    const r = client.sent[1].messages[2].content[0];
    expect(r.is_error).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual({ error: 'no box b9', hint: 'close: b8' });
  });

  it('Stop ends it between calls, and the chat stays valid', async () => {
    const ac = new AbortController();
    const client = fakeClient([turn([toolUse('t1', 'edit'), toolUse('t2', 'edit')], 'tool_use'), turn([], 'end_turn')]);
    const messages = [{ role: 'user', content: 'x' }];
    let n = 0;
    const out = await agentLoop({
      client,
      model: 'm',
      system: [],
      tools: [],
      messages,
      signal: ac.signal,
      runTool: async () => {
        n++;
        ac.abort();
        return { ok: true, result: {} };
      },
    });
    expect(out.stop).toBe('stopped');
    expect(n).toBe(1);
    // Both calls have a result; the second says it was stopped.
    const results = messages[messages.length - 1].content;
    expect(results).toHaveLength(2);
    expect(results[1].is_error).toBe(true);
  });

  it('holds to the tool call limit', async () => {
    const client = fakeClient([turn([toolUse('a', 'x'), toolUse('b', 'x'), toolUse('c', 'x')], 'tool_use'), turn([], 'end_turn')]);
    let n = 0;
    await agentLoop({ client, model: 'm', system: [], tools: [], messages: [{ role: 'user', content: 'x' }], limits: { toolCalls: 2 }, runTool: async () => (n++, { ok: true, result: {} }) });
    expect(n).toBe(2);
    expect(client.sent[1].messages[2].content[2].is_error).toBe(true);
  });

  it('a call cut off at max_tokens gets a result', async () => {
    const client = fakeClient([turn([{ type: 'text', text: 'I will' }, toolUse('t1', 'edit')], 'max_tokens')]);
    const messages = [{ role: 'user', content: 'x' }];
    const out = await agentLoop({ client, model: 'm', system: [], tools: [], messages, runTool: async () => ({ ok: true, result: {} }) });
    expect(out.stop).toBe('max_tokens');
    expect(messages[messages.length - 1].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: true });
  });

  it('caches the stable prefix and the end of the chat', async () => {
    const tools = toApiTools([{ name: 'a', description: 'A' }, { name: 'b', description: 'B', inputSchema: { type: 'object', properties: { x: {} } } }]);
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1]).toMatchObject({ name: 'b', input_schema: { properties: { x: {} } }, cache_control: { type: 'ephemeral' } });
    const msgs = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    ];
    const marked = withCacheMark(msgs);
    expect(marked[1].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(marked[0].content[0].cache_control).toBeUndefined();
    // The stored chat is untouched.
    expect(msgs[1].content[0].cache_control).toBeUndefined();
  });
});

describe('pictures', () => {
  const view = { ok: true, result: { page: 1, images: [{ png: 'AAA', mime: 'image/png', width: 10 }, { png: 'BBB', mime: 'image/jpeg' }] } };

  it('a view answers with its numbers and its pictures', () => {
    const out = toToolContent(view);
    expect(out.images).toBe(2);
    expect(JSON.parse(out.content[0].text)).toEqual({ page: 1, images: [{ mime: 'image/png', width: 10 }, { mime: 'image/jpeg' }] });
    expect(out.content[2]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } });
  });

  it('past the picture limit, says so instead', () => {
    const out = toToolContent(view, 1);
    expect(out.images).toBe(1);
    expect(out.content).toHaveLength(2);
    expect(JSON.parse(out.content[0].text).imagesDropped).toMatch(/1 picture/);
  });

  it('old requests lose their pictures, the new one keeps them', () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A' } };
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: '{}' }, img] }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u', content: [img] }] },
    ];
    const out = dropOldImages(msgs, 2);
    expect(out[0].content[0].content[1].type).toBe('text');
    expect(out[2].content[0].content[0].type).toBe('image');
  });

  it('a new message after a Stop joins the last user message', () => {
    const msgs = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] }];
    pushUserText(msgs, 'go on');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content[1]).toEqual({ type: 'text', text: 'go on' });
    msgs.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
    pushUserText(msgs, 'next');
    expect(msgs).toHaveLength(3);
  });
});

describe('review fixes', () => {
  it('an empty answer is not kept, so the next prompt stays valid', async () => {
    const client = fakeClient([{ content: [], stop_reason: 'end_turn', usage: {} }]);
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }];
    await agentLoop({ client, model: 'm', system: [], tools: [], messages, runTool: async () => ({ ok: true, result: {} }) });
    expect(messages).toHaveLength(1);
  });

  it('holds pictures to a byte budget per prompt', () => {
    const big = { ok: true, result: { images: [{ png: 'A'.repeat(10) }, { png: 'B'.repeat(10) }] } };
    const out = toToolContent(big, Infinity, 15);
    expect(out.images).toBe(1);
    expect(out.bytes).toBe(10);
    expect(JSON.parse(out.content[0].text).imagesDropped).toBeTruthy();
  });

  it('an API error carries what the earlier turns cost', async () => {
    let i = 0;
    const client = {
      messages: {
        stream() {
          const n = i++;
          return {
            on() {},
            finalMessage: async () => {
              if (n) throw Object.assign(new Error('overloaded'), { status: 529 });
              return turn([toolUse('t1', 'context')], 'tool_use', { input_tokens: 7, output_tokens: 3 });
            },
          };
        },
      },
    };
    const err = await agentLoop({ client, model: 'm', system: [], tools: [], messages: [{ role: 'user', content: 'x' }], runTool: async () => ({ ok: true, result: {} }) }).catch((e) => e);
    expect(err.usage).toMatchObject({ input: 7, output: 3 });
  });
});
