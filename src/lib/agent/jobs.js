// ===== Long calls, handed back as jobs =====
// The MCP door waits 30 s for the webview's answer (agent_mcp.rs
// `CALL_TIMEOUT`), and a call past that is an error to the agent while the
// tool keeps running here: the agent cannot tell whether a slow `place` or
// `detect` worked. So a call that has not finished a little before then is
// answered early with a job id, runs on, and keeps its answer for the `job`
// tool (tools/job.js) to hand over.

let seq = 0;
const jobs = new Map(); // id -> { id, tool, started, ended, reply }
// How long a call runs before it is answered as a job: under the door's 30 s,
// with room for the answer to travel.
export const JOB_AFTER_MS = 25000;
// The finished jobs kept for collecting; the oldest go first.
const KEEP = 20;

// `reply` is a call's promise of `{ ok, result | error, hint }`; its answer
// within `after` ms, else a job's note (as a call's own answer) while it runs on.
// `done` hears when a job it became has finished.
export async function asJob(reply, tool, { after = JOB_AFTER_MS, done = null } = {}) {
  let timer;
  const late = Symbol('late');
  const first = await Promise.race([reply, new Promise((resolve) => (timer = setTimeout(() => resolve(late), after)))]);
  clearTimeout(timer);
  if (first !== late) return first;
  const id = `j${++seq}`;
  const job = { id, tool, started: Date.now(), ended: null, reply: null };
  jobs.set(id, job);
  reply.then((r) => {
    job.reply = r;
    job.ended = Date.now();
    trim();
    done?.();
  });
  return {
    ok: true,
    result: {
      running: true,
      job: id,
      tool,
      note: `${tool} is still running after ${Math.round(after / 1000)} s and goes on in the app; call job { id: "${id}" } for its result (it says running until then). Make no other edit to the same boxes meanwhile.`,
    },
  };
}

function trim() {
  const done = [...jobs.values()].filter((j) => j.ended != null).sort((a, z) => a.ended - z.ended);
  for (const j of done.slice(0, Math.max(0, done.length - KEEP))) jobs.delete(j.id);
}

export const jobById = (id) => jobs.get(id) ?? null;

// For the tests.
export function __resetJobs() {
  jobs.clear();
  seq = 0;
}
