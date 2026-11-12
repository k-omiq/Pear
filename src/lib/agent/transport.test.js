import { describe, it, expect } from 'vitest';
import { tauriFetch } from './transport.js';

// A fake Tauri: `ai_request` replays `frames` on the channel it is given.
function fakeTauri(frames, { fail } = {}) {
  const calls = [];
  class Channel {
    onmessage = null;
  }
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd !== 'ai_request') return;
    if (fail) throw fail;
    queueMicrotask(() => frames.forEach((f) => args.onFrame.onmessage(f)));
  };
  return { invoke, Channel, calls };
}

describe('tauriFetch', () => {
  it('turns channel frames into a streaming Response', async () => {
    const t = fakeTauri([
      { t: 'head', status: 200, headers: [['content-type', 'text/event-stream']] },
      { t: 'chunk', text: 'event: a\n' },
      { t: 'chunk', text: 'data: {}\n\n' },
      { t: 'end' },
    ]);
    const res = await tauriFetch(t)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'placeholder', 'anthropic-version': '2023-06-01' },
      body: '{"a":1}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('event: a\ndata: {}\n\n');
    const [, args] = t.calls[0];
    expect(args.path).toBe('/v1/messages');
    expect(args.method).toBe('POST');
    expect(args.body).toBe('{"a":1}');
  });

  it('refuses any other host', async () => {
    const t = fakeTauri([]);
    await expect(tauriFetch(t)('https://evil.example/v1/messages')).rejects.toThrow(/only talks to the Claude API/);
    expect(t.calls).toHaveLength(0);
  });

  it('a refusal from Rust is a 400 the SDK will not retry', async () => {
    const t = fakeTauri([], { fail: 'no Claude API key is set' });
    const res = await tauriFetch(t)('https://api.anthropic.com/v1/models');
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/no Claude API key/);
  });

  it('abort tells Rust to drop the request', async () => {
    const calls = [];
    class Channel {}
    const invoke = async (cmd, args) => calls.push([cmd, args]);
    const ac = new AbortController();
    const p = tauriFetch({ invoke, Channel })('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.map((c) => c[0])).toContain('ai_abort');
  });

  it('a network failure before the head rejects like fetch does', async () => {
    const t = fakeTauri([{ t: 'fail', error: 'dns error' }]);
    await expect(tauriFetch(t)('https://api.anthropic.com/v1/messages')).rejects.toThrow(TypeError);
  });
});
