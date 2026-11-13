// ===== Door B: the agent loop =====
// One prompt from the panel, run to the end: send the chat, run every tool the
// model asks for through the registry, send the results back, repeat until the
// model is done, the user stops it, or a limit is reached
// (docs/AI_TYPESETTING_PLAN.md section 7).
//
// It knows no store and no Tauri: the panel hands it a client (the SDK, or a
// fake in tests), the tools, and `runTool`, which runs one call inside the
// app's AI run (run.svelte.js). So vitest drives it end to end.
//
// Caching (section 2, item 9): the tools and the system prompt never change in
// a session, so each carries a cache mark; the last block of the chat carries
// one too, so every turn reads the turns before it from the cache instead of
// paying for them again - page pictures above all.

export const LIMITS = {
  // Model turns in one prompt. A full page takes 6 to 10.
  turns: 60,
  toolCalls: 200,
  // Pictures sent back in one prompt. Past this, a `view` answers with its
  // numbers only and says why.
  images: 40,
  // Base64 bytes of pictures in one prompt. Every picture is sent again each
  // turn, and the API takes at most 32 MB a request.
  imageBytes: 16 * 1024 * 1024,
  maxTokens: 16000,
};

const CACHE = { type: 'ephemeral' };

// The SDK's tool shape, from the registry's. The last tool carries the cache
// mark: everything up to it is the stable prefix.
export function toApiTools(list) {
  return list.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    ...(i === list.length - 1 ? { cache_control: CACHE } : null),
  }));
}

export const systemBlocks = (text) => [{ type: 'text', text, cache_control: CACHE }];

// The chat as sent: the same messages, with cache marks on two blocks - the
// chat's end, where this request writes the cache, and the end of the user
// message before it, where the request before this one wrote it. The cache
// looks back at most 20 blocks from a mark for an earlier write, and a turn of
// many calls adds more than that; the second mark sits right on the last
// write, so it is read however many blocks came since. With the tools' and
// the system prompt's marks that is 4, the most the API takes. Marks are never
// stored in the chat, so an old one cannot pile up.
export function withCacheMark(messages) {
  const out = messages.map((m) => (typeof m.content === 'string' ? { ...m, content: [{ type: 'text', text: m.content }] } : m));
  const mark = (i) => {
    const m = out[i];
    if (!m?.content?.length) return;
    const content = m.content.slice();
    content[content.length - 1] = { ...content[content.length - 1], cache_control: CACHE };
    out[i] = { ...m, content };
  };
  mark(out.length - 1);
  for (let i = out.length - 2; i >= 0; i--) {
    if (out[i].role === 'user') {
      mark(i);
      break;
    }
  }
  return out;
}

// A tool's answer as a tool_result's content: its JSON as text, and each
// picture `view` made as an image block, while the prompt still has room.
export function toToolContent(r, imagesLeft = Infinity, bytesLeft = Infinity) {
  if (!r?.ok) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: r?.error ?? 'failed', ...(r?.hint ? { hint: r.hint } : null) }) }], images: 0, bytes: 0, isError: true };
  }
  const { images, ...rest } = r.result ?? {};
  const pics = Array.isArray(images) ? images : [];
  const sent = [];
  let bytes = 0;
  for (const i of pics) {
    const n = String(i.png ?? i.data ?? '').length;
    if (sent.length >= imagesLeft || bytes + n > bytesLeft) break;
    sent.push(i);
    bytes += n;
  }
  const meta = pics.length ? { ...rest, images: pics.map(({ png, data, ...m }) => m) } : rest;
  if (sent.length < pics.length) {
    meta.imagesDropped = `${pics.length - sent.length} picture(s) not sent: this request reached its picture limit. Judge by the numbers, or finish and tell the user.`;
  }
  return {
    content: [
      { type: 'text', text: JSON.stringify(meta) },
      ...sent.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime ?? 'image/png', data: i.png ?? i.data } })),
    ],
    images: sent.length,
    bytes,
    isError: false,
  };
}

// Pictures from requests before `from` (a message index) leave the chat as a
// line of text: the model has read them, and sending them again every turn of
// every later request is most of what a long chat would cost.
export function dropOldImages(messages, from = messages.length) {
  const strip = (blocks) =>
    blocks.map((b) => (b?.type === 'image' ? { type: 'text', text: '[a picture from an earlier request, no longer attached]' } : b));
  return messages.map((m, i) => {
    if (i >= from || m.role !== 'user' || !Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((b) => {
      if (b?.type === 'image') {
        changed = true;
        return strip([b])[0];
      }
      if (b?.type === 'tool_result' && Array.isArray(b.content) && b.content.some((c) => c?.type === 'image')) {
        changed = true;
        return { ...b, content: strip(b.content) };
      }
      return b;
    });
    return changed ? { ...m, content } : m;
  });
}

// The chat made safe to send, in place. The API refuses a whole request for
// one bad block, and the chat is sent again with every later prompt, so one
// bad block would break every prompt after it. Out go: text blocks that are
// only white space (a model can answer "\n\n" before a call), empty messages,
// and results for calls that are not in the message before. In go: a result
// for any call that has none. Two messages in a row from one side join.
// `dropThinking` drops thinking blocks too: allowed for turns before the
// current prompt, and they may not pass from one model to another.
export function tidyChat(messages, { dropThinking = false } = {}) {
  const blank = (b) => b?.type === 'text' && !String(b.text ?? '').trim();
  const thinking = (b) => b?.type === 'thinking' || b?.type === 'redacted_thinking';
  let list = [];
  for (const m of messages) {
    if (m?.role !== 'user' && m?.role !== 'assistant') continue;
    let content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
    content = content.filter((b) => b && !blank(b) && !(dropThinking && thinking(b)));
    if (!content.length) continue;
    const last = list[list.length - 1];
    if (last?.role === m.role) list[list.length - 1] = { ...last, content: [...last.content, ...content] };
    else list.push({ ...m, content });
  }
  // A chat starts with the user.
  while (list.length && list[0].role !== 'user') list.shift();

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.role === 'assistant') {
      out.push(m);
      const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
      if (!ids.length) continue;
      const next = list[i + 1]?.role === 'user' ? list[i + 1] : null;
      const given = new Map((next?.content ?? []).filter((b) => b.type === 'tool_result').map((b) => [b.tool_use_id, b]));
      const results = ids.map(
        (id) => given.get(id) ?? { type: 'tool_result', tool_use_id: id, is_error: true, content: [{ type: 'text', text: 'Not run: the request ended before this call.' }] },
      );
      const rest = (next?.content ?? []).filter((b) => b.type !== 'tool_result');
      out.push({ ...(next ?? { role: 'user' }), content: [...results, ...rest] });
      if (next) i++;
    } else {
      // A user message not right after the assistant's calls has no call to answer.
      const content = m.content.filter((b) => b.type !== 'tool_result');
      if (!content.length) continue;
      const last = out[out.length - 1];
      if (last?.role === 'user') out[out.length - 1] = { ...last, content: [...last.content, ...content] };
      else out.push({ ...m, content });
    }
  }
  messages.splice(0, messages.length, ...out);
  return messages;
}

export function addUsage(sum, u) {
  if (!u) return sum;
  sum.input += u.input_tokens ?? 0;
  sum.output += u.output_tokens ?? 0;
  sum.cacheRead += u.cache_read_input_tokens ?? 0;
  sum.cacheWrite += u.cache_creation_input_tokens ?? 0;
  return sum;
}

export const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const aborted = (err, signal) => signal?.aborted || err?.name === 'AbortError' || err?.constructor?.name === 'APIUserAbortError';

// Runs one prompt. `messages` is the chat so far, ending with the user's new
// message; the loop appends to it in place, so after a Stop or an error the
// chat stays valid to send again (every tool_use has its tool_result).
//
// Events (`onEvent`): text {delta}, message {message}, tool {id, name, input},
// toolDone {id, name, ok, result}, usage {usage}.
// Returns { stop, usage, turns, toolCalls, images }: stop is the model's
// stop_reason ('end_turn', 'max_tokens', 'refusal'), or 'stopped', 'turns'.
export async function agentLoop({ client, model, system, tools, messages, runTool, onEvent: tell = () => {}, signal = null, limits = {} }) {
  const lim = { ...LIMITS, ...limits };
  // A fault in what shows the chat must never stop the loop between a call
  // and its result: the chat would be left broken for every later prompt.
  const onEvent = (e) => {
    try {
      tell(e);
    } catch (err) {
      console.error('AI panel event failed', err);
    }
  };
  const usage = emptyUsage();
  let calls = 0;
  let images = 0;
  let bytes = 0;
  let turns = 0;
  const done = (stop) => ({ stop, usage, turns, toolCalls: calls, images });

  while (turns < lim.turns) {
    if (signal?.aborted) return done('stopped');
    turns++;
    tidyChat(messages);
    let msg;
    try {
      const stream = client.messages.stream(
        { model, max_tokens: lim.maxTokens, system, tools, messages: withCacheMark(messages) },
        signal ? { signal } : undefined,
      );
      stream.on?.('text', (delta) => onEvent({ type: 'text', delta }));
      msg = await stream.finalMessage();
    } catch (err) {
      if (aborted(err, signal)) return done('stopped');
      // What earlier turns cost was billed all the same.
      if (err && typeof err === 'object') err.usage = usage;
      throw err;
    }
    addUsage(usage, msg.usage);
    onEvent({ type: 'usage', usage: { ...usage } });
    // An empty answer is not kept: only the last message of a chat may be
    // empty, and the next prompt would follow it.
    if (msg.content?.length) messages.push({ role: 'assistant', content: msg.content });
    onEvent({ type: 'message', message: msg });

    // A server-side pause: send the chat back as it is and the model goes on.
    if (msg.stop_reason === 'pause_turn') continue;
    if (msg.stop_reason !== 'tool_use') {
      // An answer cut off at max_tokens can end in a call that never ran;
      // the chat needs a result for it to stay valid.
      const cut = msg.content.filter((b) => b.type === 'tool_use');
      if (cut.length) {
        messages.push({
          role: 'user',
          content: cut.map((b) => ({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: [{ type: 'text', text: 'Not run: the answer was cut off before this call.' }] })),
        });
      }
      return done(msg.stop_reason ?? 'end_turn');
    }

    const results = [];
    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue;
      let r;
      if (signal?.aborted) r = { ok: false, error: 'the user stopped this request. Do not continue.' };
      else if (++calls > lim.toolCalls) r = { ok: false, error: `this request reached its limit of ${lim.toolCalls} tool calls. Stop and tell the user what was done and what is left.` };
      else {
        onEvent({ type: 'tool', id: block.id, name: block.name, input: block.input });
        try {
          r = await runTool(block.name, block.input ?? {});
        } catch (err) {
          r = { ok: false, error: `the app failed: ${err?.message ?? err}` };
        }
      }
      const out = toToolContent(r, lim.images - images, lim.imageBytes - bytes);
      images += out.images;
      bytes += out.bytes;
      onEvent({ type: 'toolDone', id: block.id, name: block.name, ok: !!r?.ok, result: r });
      results.push({ type: 'tool_result', tool_use_id: block.id, content: out.content, ...(out.isError ? { is_error: true } : null) });
    }
    messages.push({ role: 'user', content: results });
  }
  return done('turns');
}

// A new user message onto the chat. After a Stop the chat can end on the
// user's side (tool results); the new words join that message rather than
// start a second user message in a row.
export function pushUserText(messages, text) {
  const last = messages[messages.length - 1];
  if (last?.role === 'user') {
    const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.slice();
    content.push({ type: 'text', text });
    messages[messages.length - 1] = { ...last, content };
  } else messages.push({ role: 'user', content: [{ type: 'text', text }] });
  return messages;
}
