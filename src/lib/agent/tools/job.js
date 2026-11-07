// ===== job: the answer of a call that ran past the door's wait =====
// A call still running after a while is answered with a job id (jobs.js);
// this hands over what it came to once it is done. Read-only: the job itself
// did its writing through its own tool.

import { defineTool, ToolError } from '../registry.js';
import { jobById } from '../jobs.js';

defineTool({
  name: 'job',
  description:
    'The result of a call that ran long: a call still running after about 25 s answers { running: true, job: "j1" } and goes on in the app. Call job { id } with that id (and the same chapter): while it runs, { running: true, seconds }; once done, the call\'s own result, exactly as it would have come, with done: true. A job\'s result is kept until 20 newer ones have finished.',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', minLength: 1, description: 'the job id a long call answered with' } },
  },
  run({ id }) {
    const job = jobById(id);
    if (!job) throw new ToolError(`no job "${id}"`, 'a job lives in the window of the chapter it ran on: pass the same chapter; a finished job is kept until 20 newer ones have finished.');
    if (!job.reply) return { running: true, job: job.id, tool: job.tool, seconds: Math.round((Date.now() - job.started) / 1000) };
    if (!job.reply.ok) throw new ToolError(`${job.tool} (job ${job.id}) failed: ${job.reply.error}`, job.reply.hint ?? undefined);
    return { ...job.reply.result, job: job.id, tool: job.tool, done: true };
  },
});
