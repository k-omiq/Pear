// ===== The AI tool layer: the registry =====
// Every tool an AI agent can call, whichever door the call came through
// (docs/AI_TYPESETTING_PLAN.md section 1): the MCP server in the Tauri app
// (Door A) lists and calls these, and so will the in-app panel (Door B). A
// tool knows no model and no SDK. It reads and writes the document only
// through the store's own functions, never on a path of its own.
//
// A tool is `{ name, description, input, write, run(args, ctx) }`:
//   input   the JSON Schema of `args`, as the model sees it
//   write   true for a tool that may change the document; its edits go
//           through `ctx.write` so the run can be stopped, reverted and
//           pinned to the open chapter (run.svelte.js)
//   run     returns plain JSON. A bad id, value or selector throws a
//           `ToolError`, which comes back as `{ error, hint }`: the model
//           reads it and fixes its call in the same turn. Nothing else a tool
//           does may reach the caller as a throw.

export class ToolError extends Error {
  constructor(message, hint = null) {
    super(message);
    this.name = 'ToolError';
    this.hint = hint;
  }
}

const tools = new Map();

export function defineTool(tool) {
  if (!tool?.name || typeof tool.run !== 'function') throw new Error('a tool needs a name and a run');
  tools.set(tool.name, {
    description: '',
    input: { type: 'object', properties: {} },
    write: false,
    ...tool,
  });
  return tool;
}

export const toolByName = (name) => tools.get(name) ?? null;

// What a door lists: one entry per tool, in the order they were defined.
export function listTools() {
  return [...tools.values()].map((t) => ({
    name: t.name,
    description: typeof t.description === 'function' ? t.description() : t.description,
    inputSchema: t.input,
    write: !!t.write,
  }));
}

// The nearest names to `name` among `names`, for an error's hint.
export function nearest(name, names, n = 3) {
  const a = String(name ?? '').toLowerCase();
  const dist = (b) => {
    b = b.toLowerCase();
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cur = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
      }
    }
    // A name that contains what was asked for is close whatever its length.
    return b.includes(a) || a.includes(b) ? Math.min(row[b.length], 1) : row[b.length];
  };
  return [...new Set(names)]
    .map((x) => [x, dist(String(x))])
    .sort((p, q) => p[1] - q[1])
    .slice(0, n)
    .map((p) => p[0]);
}

// One call. Always resolves, never throws: `{ ok: true, result }` or
// `{ ok: false, error, hint }`.
export async function callTool(name, args, ctx) {
  const tool = tools.get(name);
  if (!tool) {
    return { ok: false, error: `no tool "${name}"`, hint: `close: ${nearest(name, [...tools.keys()]).join(', ')}` };
  }
  try {
    const result = await tool.run(args && typeof args === 'object' && !Array.isArray(args) ? args : {}, ctx);
    return { ok: true, result: result ?? {} };
  } catch (err) {
    if (err instanceof ToolError) return { ok: false, error: err.message, ...(err.hint ? { hint: err.hint } : null) };
    // A bug of ours, not a bad call: said plainly, so the model stops rather
    // than retrying what cannot work.
    return { ok: false, error: `the app failed: ${err?.message ?? err}` };
  }
}
