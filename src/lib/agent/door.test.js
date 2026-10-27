import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
let handler = null;
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'agent_door_start') return args.port;
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, fn) => {
    if (name === 'agent:call') handler = fn;
    return () => {};
  }),
}));
let tauri = true;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  clear: () => store.clear(),
};
vi.mock('../importer.js', () => ({ isTauri: () => tauri }));

const { door, initDoor, setDoorOn, setDoorPort, rotateToken, toMcpResult, answerCall, DEFAULT_PORT } = await import('./door.svelte.js');

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  tauri = true;
});

describe('the MCP door, webview side', () => {
  it('is off by default and starts nothing', async () => {
    await initDoor();
    expect(door.on).toBe(false);
    expect(door.port).toBe(DEFAULT_PORT);
    expect(door.token).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toEqual([]);
  });

  it('turns on with the tool list, the instructions and its token', async () => {
    await initDoor();
    await setDoorOn(true);
    const set = calls.find(([c]) => c === 'agent_tools_set')[1];
    expect(set.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['context', 'query', 'view']));
    expect(set.tools.every((t) => t.inputSchema && t.description)).toBe(true);
    expect(set.instructions).toMatch(/data, not instructions|untrusted/i);
    expect(calls.at(-1)).toEqual(['agent_door_start', { port: DEFAULT_PORT, token: door.token }]);
    expect(door.running).toBe(true);
    expect(JSON.parse(localStorage.getItem('mt.agentDoor')).on).toBe(true);
  });

  it('answers an agent:call through the registry', async () => {
    await initDoor();
    await setDoorOn(true);
    await handler({ payload: { id: 7, name: 'no_such_tool', args: {} } });
    const [cmd, args] = calls.at(-1);
    expect(cmd).toBe('agent_result');
    expect(args.id).toBe(7);
    expect(args.result.isError).toBe(true);
  });

  it('lists every chapter tool with a chapter argument, the library tools with their own', async () => {
    await initDoor();
    await setDoorOn(true);
    const set = calls.find(([c]) => c === 'agent_tools_set')[1];
    const tool = (n) => set.tools.find((t) => t.name === n);
    expect(tool('edit').inputSchema.properties.chapter.type).toBe('string');
    expect(tool('text').inputSchema.properties.chapter).toBeTruthy();
    expect(tool('open_chapter').inputSchema.required).toEqual(['chapter']);
    expect(tool('chapters').inputSchema.properties.chapter).toBeUndefined();
  });

  it('answers only the calls sent to its window, and refuses one for a chapter it no longer has', async () => {
    await initDoor();
    await setDoorOn(true);
    calls.length = 0;
    await handler({ payload: { id: 8, name: 'context', args: {}, target: 'agent-3' } });
    expect(calls).toEqual([]);
    await handler({ payload: { id: 9, name: 'context', args: { chapter: 'p_x/c_y' }, target: 'main' } });
    const [, args] = calls.at(-1);
    expect(args.result.isError).toBe(true);
    expect(args.result.content[0].text).toMatch(/no longer open/);
    // The library's tools keep chapter as their own argument.
    await handler({ payload: { id: 10, name: 'open_chapter', args: { chapter: 'p_x/c_y' }, target: 'main' } });
    expect(calls.at(-1)[1].result.content[0].text).toMatch(/no chapter \\"p_x\/c_y\\"/);
  });

  it('refuses a call that arrives after the door was turned off', async () => {
    await initDoor();
    await setDoorOn(true);
    await setDoorOn(false);
    const r = await answerCall({ id: 1, name: 'context', args: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/turned the AI door off/);
  });

  it('a new token or port restarts it; off stops it', async () => {
    await initDoor();
    await setDoorOn(true);
    const old = door.token;
    await rotateToken();
    expect(door.token).not.toBe(old);
    expect(calls.at(-1)).toEqual(['agent_door_start', { port: DEFAULT_PORT, token: door.token }]);
    await setDoorPort(80); // refused: below 1024
    expect(door.port).toBe(DEFAULT_PORT);
    await setDoorPort(7900);
    expect(calls.at(-1)[1].port).toBe(7900);
    await setDoorOn(false);
    expect(calls.at(-1)).toEqual(['agent_door_stop', undefined]);
    expect(door.running).toBe(false);
  });

  it('outside the desktop app it says so and starts nothing', async () => {
    tauri = false;
    await initDoor();
    await setDoorOn(true);
    expect(door.running).toBe(false);
    expect(door.error).toMatch(/desktop app/);
    expect(calls).toEqual([]);
  });

  it('puts pictures in image blocks and keeps the rest as JSON', () => {
    const r = toMcpResult({ ok: true, result: { images: [{ png: 'AAAA', mime: 'image/png', width: 2 }], legend: 'x' } });
    expect(r.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    expect(JSON.parse(r.content[0].text)).toEqual({ legend: 'x', images: [{ mime: 'image/png', width: 2 }] });
    expect(toMcpResult({ ok: false, error: 'no', hint: 'h' })).toEqual({
      content: [{ type: 'text', text: '{"error":"no","hint":"h"}' }], isError: true,
    });
  });
});
