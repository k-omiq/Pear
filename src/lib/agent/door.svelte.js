// ===== The MCP door, from the webview's side =====
// Settings turns it on (off by default); then the Tauri app listens on
// 127.0.0.1 (src-tauri/src/agent_mcp.rs) and every `tools/call` arrives here
// as an `agent:call` event. The tool runs through the registry, inside an AI
// run (run.svelte.js), and the answer goes back with `agent_result`.
//
// The token is made here, 32 random bytes, and kept with this machine's
// settings; Rust refuses any request without it. A new token cuts every
// client off until the user pastes the new line.
//
// Every window answers the calls for its own chapter (agent_mcp.rs routes
// them by the `chapter` they name): the main window starts the door and
// lists the tools; a chapter window opened for an agent only listens.
import { isTauri } from '../importer.js';
import { listTools, callTool } from './registry.js';
import { callContext, noteCall, stopRun, followWritesOnScreen } from './run.svelte.js';
import { INSTRUCTIONS } from './instructions.js';
import { app } from '../store.svelte.js';
import { chapterKey } from './windows.js';
import './tools/index.js';

// What every chapter tool takes besides its own arguments: the chapter it is
// for. The library's tools name their chapter themselves.
const LIBRARY_TOOLS = ['chapters', 'open_chapter', 'close_chapter'];
const CHAPTER_ARG = {
  type: 'string',
  description: 'The chapter this call is for, as chapters lists it ("projectId/chapterId"), after open_chapter. Leave it out only to work on the chapter open in the user\'s main window.',
};
export function withChapterArg(tool) {
  if (LIBRARY_TOOLS.includes(tool.name)) return tool;
  const schema = tool.inputSchema ?? { type: 'object', properties: {} };
  return { ...tool, inputSchema: { ...schema, properties: { ...(schema.properties ?? {}), chapter: CHAPTER_ARG } } };
}

const KEY = 'mt.agentDoor';
export const DEFAULT_PORT = 7811;

export const door = $state({
  on: false,
  port: DEFAULT_PORT,
  token: '',
  // What the app is doing now, for Settings.
  running: false,
  error: null,
});

export function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const validPort = (p) => Number.isInteger(p) && p >= 1024 && p <= 65535;

function load() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    /* a missing or broken blob is a fresh start: off */
  }
  door.on = saved?.on === true;
  door.port = validPort(saved?.port) ? saved.port : DEFAULT_PORT;
  door.token = typeof saved?.token === 'string' && /^[0-9a-f]{64}$/.test(saved.token) ? saved.token : newToken();
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ on: door.on, port: door.port, token: door.token }));
  } catch {
    /* the door still works this session */
  }
}

// A tool's answer in MCP's shape: the JSON as text, and each picture a `view`
// made as an image block of its own.
export function toMcpResult(r) {
  if (!r?.ok) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: r?.error ?? 'failed', ...(r?.hint ? { hint: r.hint } : null) }) }], isError: true };
  }
  const { images, ...rest } = r.result ?? {};
  const pics = Array.isArray(images) ? images : [];
  const meta = pics.length ? { ...rest, images: pics.map(({ png, data, ...m }) => m) } : rest;
  return {
    content: [
      { type: 'text', text: JSON.stringify(meta) },
      ...pics.map((i) => ({ type: 'image', data: i.png ?? i.data, mimeType: i.mime ?? 'image/png' })),
    ],
  };
}

// One call from the door. Never throws: a failure is an error result.
export async function answerCall(payload) {
  const { name, args: given } = payload ?? {};
  if (!door.on) return toMcpResult({ ok: false, error: 'the user turned the AI door off' });
  const all = given && typeof given === 'object' && !Array.isArray(given) ? given : {};
  // The library's tools take `chapter` as their own argument; every other
  // tool's `chapter` only routed the call here.
  const library = LIBRARY_TOOLS.includes(name);
  const { chapter, ...rest } = all;
  const args = library ? all : rest;
  // The door sent the call here for the chapter it names; if this window has
  // since moved to another, the call is refused rather than run on that one.
  const here = app.chapterRef ? chapterKey(app.chapterRef.projectId, app.chapterRef.chapterId) : null;
  if (chapter != null && !library && chapter !== here) {
    return toMcpResult({ ok: false, error: `chapter "${chapter}" is no longer open in its window`, hint: 'call open_chapter for it again' });
  }
  noteCall();
  let r;
  try {
    r = await callTool(name, args, callContext('mcp'));
  } catch (err) {
    r = { ok: false, error: `the app failed: ${err?.message ?? err}` };
  } finally {
    // The quiet time that ends a run counts from the end of a call, so a
    // long one (place, detect) is not taken for silence.
    noteCall();
  }
  return toMcpResult(r);
}

let core = null;
let unlisten = null;
async function tauri() {
  if (!core) {
    const [c, e] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
    core = { invoke: c.invoke, listen: e.listen };
  }
  return core;
}

// This window answers the calls the door sends it: those for its chapter.
export async function listenForCalls(label = 'main') {
  if (!isTauri()) return;
  const { invoke, listen } = await tauri();
  unlisten ??= await listen('agent:call', async (e) => {
    if (e.payload?.target != null && e.payload.target !== label) return;
    const result = await answerCall(e.payload);
    try {
      await invoke('agent_result', { id: e.payload?.id, result });
    } catch {
      /* the call timed out on the Rust side already */
    }
  });
}

async function start() {
  const { invoke } = await tauri();
  await invoke('agent_tools_set', {
    tools: listTools().map(({ name, description, inputSchema }) => withChapterArg({ name, description, inputSchema })),
    instructions: INSTRUCTIONS,
  });
  await listenForCalls('main');
  await invoke('agent_door_start', { port: door.port, token: door.token });
  door.running = true;
  door.error = null;
}

async function stop() {
  door.running = false;
  if (!isTauri()) return;
  const { invoke } = await tauri();
  await invoke('agent_door_stop');
}

async function apply() {
  if (!isTauri()) {
    door.running = false;
    door.error = door.on ? 'The AI door needs the desktop app.' : null;
    return;
  }
  try {
    if (door.on) await start();
    else await stop();
  } catch (err) {
    door.running = false;
    door.error = String(err?.message ?? err);
  }
}

export async function setDoorOn(on) {
  door.on = !!on;
  // Off stops a run going on: a call already in the app writes nothing more.
  if (!door.on) stopRun();
  persist();
  await apply();
}

export async function setDoorPort(port) {
  const p = Math.round(+port);
  if (!validPort(p) || p === door.port) return;
  door.port = p;
  persist();
  if (door.on) await apply();
}

export async function rotateToken() {
  door.token = newToken();
  persist();
  if (door.on) await apply();
}

// Boot: read the setting and open the door when it was left on.
export async function initDoor() {
  load();
  persist();
  if (door.on) await apply();
}

// Quitting: the door shuts for good this session (the setting stays on for the
// next launch), and a run going on stops, so nothing edits while the app saves.
export async function closeDoorForQuit() {
  if (!door.running) return;
  stopRun();
  await stop().catch(() => {});
}

// Boot, in a chapter window opened for an agent: the door is the main
// window's; this one reads whether it is on and answers its own calls.
export async function initChapterWindowDoor(label) {
  followWritesOnScreen(true);
  load();
  await listenForCalls(label);
}
