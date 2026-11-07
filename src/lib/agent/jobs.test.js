// A call past the door's wait: answered early as a job, collected with `job`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asJob, jobById, __resetJobs, JOB_AFTER_MS } from './jobs.js';
import { callTool } from './registry.js';
import './tools/job.js';

beforeEach(() => {
  vi.useFakeTimers();
  __resetJobs();
});
afterEach(() => vi.useRealTimers());

const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe('asJob', () => {
  it('passes a quick answer through as it is', async () => {
    const answer = asJob(later(100, { ok: true, result: { a: 1 } }), 'edit');
    await vi.advanceTimersByTimeAsync(100);
    expect(await answer).toEqual({ ok: true, result: { a: 1 } });
  });

  it('answers a slow call with a job id, and job hands over its result once done', async () => {
    const done = vi.fn();
    const answer = asJob(later(JOB_AFTER_MS + 5000, { ok: true, result: { placed: 3 } }), 'place', { done });
    await vi.advanceTimersByTimeAsync(JOB_AFTER_MS);
    const first = await answer;
    expect(first.result).toMatchObject({ running: true, job: 'j1', tool: 'place' });
    let r = await callTool('job', { id: 'j1' });
    expect(r.result).toMatchObject({ running: true, job: 'j1', tool: 'place' });
    expect(r.result.seconds).toBeTypeOf('number');
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).toHaveBeenCalledOnce();
    r = await callTool('job', { id: 'j1' });
    expect(r).toEqual({ ok: true, result: { placed: 3, job: 'j1', tool: 'place', done: true } });
  });

  it('passes a failed job on as an error, and names an unknown id', async () => {
    const answer = asJob(later(JOB_AFTER_MS + 10, { ok: false, error: 'no pages', hint: 'try again' }), 'detect');
    await vi.advanceTimersByTimeAsync(JOB_AFTER_MS + 10);
    expect((await answer).result.job).toBe('j1');
    expect(jobById('j1').reply.ok).toBe(false);
    expect(await callTool('job', { id: 'j1' })).toEqual({ ok: false, error: 'detect (job j1) failed: no pages', hint: 'try again' });
    expect((await callTool('job', { id: 'j9' })).ok).toBe(false);
  });
});
