// ===== The AI panel's state (Door B) =====
// The chat beside the page: the user types, the agent loop (loop.js) runs the
// prompt on the Claude API through Rust (transport.js), and every tool call
// runs inside the app's AI run (run.svelte.js), so the "AI is editing" bar,
// Stop, Revert run and one undo per page work as they do for the MCP door.
//
// One chat per open chapter: another chapter starts a new chat.
import { app } from '../store.svelte.js';
import { listTools, callTool } from './registry.js';
import { callContext, beginPromptRun, endRun, stopRun } from './run.svelte.js';
import { PANEL_INSTRUCTIONS } from './instructions.js';
import { agentLoop, toApiTools, systemBlocks, dropOldImages, pushUserText, emptyUsage, addUsage } from './loop.js';
import { aiKey, refreshKey, keyError } from './key.svelte.js';
import { chapterKey } from './windows.js';
import './tools/index.js';

export const MODELS = {
  fast: { id: 'claude-haiku-5-5', label: 'Fast', note: 'Haiku 5.5 - quick edits' },
  balanced: { id: 'claude-sonnet-5-5', label: 'Balanced', note: 'Sonnet 5.5 - typesetting and checks' },
  best: { id: 'claude-opus-5-5', label: 'Best', note: 'Opus 5.5 - hard SFX and style matching' },
};

// Tools the panel does not offer: the chapter list and windows are the MCP
// door's (several agents, several chapters), and `job` is how the door hands
// back a call that ran past its wait - the panel just waits.
const DOOR_ONLY = new Set(['chapters', 'open_chapter', 'close_chapter', 'job']);

// Words that mean the job is more than a quick edit: Balanced, not Fast.
const BIG = /\b(typeset|letter|place|check|look|review|proof|fix|sfx|sound|match|whole|chapter|all pages|every|why|how)\b/i;

// The model for a prompt when the user has not pinned one. Best only when
// pinned: it is the slowest and dearest.
export function autoModel(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
  return words <= 16 && !BIG.test(text) ? 'fast' : 'balanced';
}

const KEY = 'mt.aiPanel';

export const panel = $state({
  // 'auto' | 'fast' | 'balanced' | 'best'
  model: 'auto',
  privacyOk: false,
  // What the user sees: { role: 'user' | 'assistant' | 'note', text, tools?: [{ id, name, ok, error }], model? }
  chat: [],
  running: false,
  // The model the running prompt uses.
  using: null,
  error: null,
  usage: emptyUsage(),
  // The chapter the chat belongs to.
  chapter: null,
});

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s && (s.model === 'auto' || Object.hasOwn(MODELS, s.model))) panel.model = s.model;
    panel.privacyOk = s?.privacyOk === true;
  } catch {
    /* a fresh start */
  }
}
load();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ model: panel.model, privacyOk: panel.privacyOk }));
  } catch {
    /* kept for this session */
  }
}

export function setModel(m) {
  if (m !== 'auto' && !Object.hasOwn(MODELS, m)) return;
  panel.model = m;
  persist();
}

export function acceptPrivacy() {
  panel.privacyOk = true;
  persist();
}

// The chat as the API sees it. Not reactive: it holds every tool result and
// picture, which the UI never shows.
let messages = [];
let controller = null;
let client = null;

export function clearChat() {
  if (panel.running) return;
  messages = [];
  panel.chat = [];
  panel.error = null;
  panel.usage = emptyUsage();
}

const hereKey = () => (app.chapterRef ? chapterKey(app.chapterRef.projectId, app.chapterRef.chapterId) : null);

// Another chapter: the chat was about the old one.
export function followChapter() {
  const k = hereKey();
  if (k === panel.chapter) return;
  if (panel.running) stopPrompt();
  panel.chapter = k;
  messages = [];
  panel.chat = [];
  panel.error = null;
}

export function panelTools() {
  return toApiTools(listTools().filter((t) => !DOOR_ONLY.has(t.name)));
}

// For tests: a fake client instead of the SDK.
export function __setClient(c) {
  client = c;
}

async function getClient() {
  if (!client) {
    const { claudeClient } = await import('./transport.js');
    client = await claudeClient();
  }
  return client;
}

// The proposals a `text` call made, as the chat's Use / Reject cards (TXT-8).
const plain = (v) => (v && typeof v === 'object' ? (v.untrusted ?? '') : String(v ?? ''));
export function cardsOf(result) {
  return (result?.proposed ?? [])
    .filter((r) => r.proposal && r.pageId != null)
    .map((r) => ({
      pageId: r.pageId,
      id: r.proposal,
      was: { text: plain(r.proposed), before: plain(r.before), where: `page ${r.page}, ${r.id ? `box ${r.id}` : `line ${r.line}`}` },
    }));
}

const joinText = (a, b) => (a && b ? `${a.trimEnd()}\n\n${b.trimStart()}` : a || b);

// A short line for a tool call in the log.
function toolLine(e) {
  return { id: e.id, name: e.name, ok: null, error: null };
}

export async function sendPrompt(text) {
  const words = String(text ?? '').trim();
  if (!words || panel.running) return false;
  if (!app.chapterRef) {
    panel.error = 'Open a chapter first.';
    return false;
  }
  if (aiKey.set == null) await refreshKey();
  if (!aiKey.set && !client) {
    panel.error = 'Add your Claude API key in Settings > AI agents.';
    return false;
  }
  followChapter();
  const which = panel.model === 'auto' ? autoModel(words) : panel.model;
  panel.error = null;
  panel.running = true;
  panel.using = which;
  panel.chat.push({ role: 'user', text: words });
  panel.chat.push({ role: 'assistant', text: '', tools: [], cards: [], model: which });
  const reply = panel.chat[panel.chat.length - 1];

  // Pictures from earlier prompts leave the chat; this prompt's stay.
  messages = dropOldImages(messages);
  pushUserText(messages, words);

  controller = new AbortController();
  beginPromptRun();
  const pinned = hereKey();
  let said = '';
  let live = '';
  try {
    const out = await agentLoop({
      client: await getClient(),
      model: MODELS[which].id,
      system: systemBlocks(PANEL_INSTRUCTIONS),
      tools: panelTools(),
      messages,
      signal: controller.signal,
      runTool: (name, input) => {
        // The chapter moved under the prompt: nothing more runs.
        if (hereKey() !== pinned) return Promise.resolve({ ok: false, error: 'the user opened another chapter. Stop.' });
        return callTool(name, input, callContext('panel'));
      },
      onEvent: (e) => {
        // The words stream in live; each finished turn's own text replaces
        // what streamed, so a dropped delta never costs the reply.
        if (e.type === 'text') reply.text = joinText(said, (live += e.delta));
        else if (e.type === 'message') {
          const words = (e.message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
          said = joinText(said, words);
          live = '';
          reply.text = said;
        } else if (e.type === 'tool') reply.tools.push(toolLine(e));
        else if (e.type === 'toolDone') {
          const t = reply.tools.find((x) => x.id === e.id);
          if (t) {
            t.ok = e.ok;
            t.error = e.ok ? null : (e.result?.error ?? 'failed');
          }
          if (e.ok && e.name === 'text') for (const c of cardsOf(e.result?.result)) reply.cards.push(c);
        }
      },
    });
    addUsage(panel.usage, { input_tokens: out.usage.input, output_tokens: out.usage.output, cache_read_input_tokens: out.usage.cacheRead, cache_creation_input_tokens: out.usage.cacheWrite });
    reply.text = reply.text.trim();
    if (out.stop === 'stopped') reply.stopped = true;
    else if (out.stop === 'max_tokens') panel.error = 'The answer ran past its length limit. Ask again, or for less at once.';
    else if (out.stop === 'turns') panel.error = 'The request reached its step limit. Ask it to go on, or for less at once.';
    else if (out.stop === 'refusal') panel.error = 'Claude declined this request.';
    return true;
  } catch (err) {
    panel.error = keyError(err);
    reply.text = reply.text.trim();
    return false;
  } finally {
    controller = null;
    panel.running = false;
    panel.using = null;
    endRun();
  }
}

// Stop: the request in flight is dropped, and the run's writes end. What it
// did stays; Revert run on the bar takes it back.
export function stopPrompt() {
  controller?.abort();
  stopRun();
}
