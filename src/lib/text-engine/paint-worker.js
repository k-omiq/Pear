// ===== The box paint, off the main thread =====
//
// A second instance of the Rust engine, in a Web Worker, that paints a box job
// the main thread has already encoded (`encodeBox`, text-engine/js/paint.mjs).
// It holds the same fonts, chains and rules as the main instance because every
// call that changes them there is replayed here, in the same order
// (paint-mirror.js). The engine gives out ids by the first free slot, so the
// same calls in the same order give the same ids, and a job encoded with the
// main instance's ids means the same faces here. Each replayed call carries
// the answer the main instance got; an answer that differs is a mirror that
// has gone wrong, and from then on this worker paints nothing (`dead`).
//
// Imports only the engine's own loader files, which touch no document and no
// Svelte: nothing here may.
//
// The handler is a plain function (`createPaintHandler`), so a test can drive
// a second instance through exactly this code without a Worker. The worker
// entry at the bottom only queues its messages through it, one at a time.
import { createEngine } from '../../../text-engine/js/engine.mjs';
import { addInstance } from '../../../text-engine/js/instance.mjs';
import { paintsBoxes, WIRE_VERSION } from '../../../text-engine/js/paint.mjs';

/**
 * Paints one encoded box job on `low` (an engine from `createEngine`): the
 * same calls `paintBox` in paint.mjs makes after it has encoded the job.
 * Returns `{ x, y, width, height, data }` with `data` a copy of the pixels
 * (straight RGBA8), or null when the job draws nothing; throws as `paintBox` does.
 */
export function paintBoxBytes(low, bytes) {
  const ex = low.exports;
  if (!paintsBoxes(low)) throw new Error('mt-text: this wasm does not paint box jobs of this version');
  if (ex.mt_paint_wire_version() !== WIRE_VERSION) {
    throw new Error(`mt-text: wasm reads paint jobs v${ex.mt_paint_wire_version()}, loader writes v${WIRE_VERSION}`);
  }
  const ptr = ex.mt_paint_job_reserve(bytes.length);
  if (!ptr) throw new Error(`mt-text: paintBox: the engine refused a job of ${bytes.length} bytes`);
  new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
  const code = ex.mt_paint_box(bytes.length);
  if (code < 0) throw new Error(`mt-text: paintBox: error ${code}`);
  if (code === 0) return null;
  const [x, y, width, height] = new Float64Array(ex.memory.buffer, ex.mt_paint_job_result(), 4);
  const pixels = ex.mt_paint_job_pixels();
  const data = new Uint8ClampedArray(ex.memory.buffer.slice(pixels, pixels + width * height * 4));
  // The engine's copy is not needed again; the next job would replace it.
  ex.mt_paint_job_release?.();
  return { x, y, width, height, data };
}

// What one replayed call came to: the id or answer it returned, or that it threw.
function outcome(fn) {
  try {
    const v = fn();
    return { v: v === undefined ? null : v };
  } catch {
    return { error: true };
  }
}
const same = (a, b) => (a?.error ? b?.error === true : !b?.error && a?.v === b?.v);

/**
 * The worker's state and its one entry point. `handle(msg)` returns the reply
 * to post (or null) and is awaited message by message, in order.
 *
 * Messages: `{ op: 'init', module | url }` first, then the replayed calls
 * (`addFont`, `addSiblingFace`, `removeFont`, `addInstance`, `setRule`,
 * `chainNew`, `chainPush`, `chainFree`, each with `expect`, the main
 * instance's outcome), and `{ op: 'paint', id, bytes }`.
 *
 * Replies: `{ type: 'painted', id, raster, ms }`, `{ type: 'failed', id,
 * message }`, and `{ type: 'dead', reason, id? }` - once, when the mirror
 * goes wrong, and again for each paint asked of a dead worker.
 */
export function createPaintHandler({ fetchBytes = (url) => fetch(url).then((r) => r.arrayBuffer()), now = () => performance.now() } = {}) {
  let low = null;
  let dead = null;
  let told = false;

  function die(reason) {
    dead = reason;
    low = null;
    if (told) return null;
    told = true;
    return { type: 'dead', reason };
  }

  function replay(msg) {
    switch (msg.op) {
      case 'addFont':
        return outcome(() => low.addFont(msg.bytes, msg.index));
      case 'addSiblingFace':
        return outcome(() => low.addSiblingFace(msg.font, msg.index));
      case 'removeFont':
        return outcome(() => low.removeFont(msg.font));
      case 'addInstance':
        return outcome(() => addInstance(low, msg.font, msg.settings));
      case 'setRule':
        return outcome(() => low.setRule(msg.name, msg.value));
      case 'chainNew':
        return outcome(() => low.chainNew());
      case 'chainPush':
        return outcome(() => low.chainPush(msg.chain, msg.font, msg.synth));
      case 'chainFree':
        return outcome(() => low.chainFree(msg.chain));
      default:
        return null;
    }
  }

  async function handle(msg) {
    if (msg.op === 'paint') {
      if (dead) return { type: 'dead', reason: dead, id: msg.id };
      const t0 = now();
      try {
        const raster = paintBoxBytes(low, msg.bytes);
        return { type: 'painted', id: msg.id, raster, ms: now() - t0 };
      } catch (error) {
        return { type: 'failed', id: msg.id, message: String(error?.message ?? error) };
      }
    }
    if (dead) return null;
    if (msg.op === 'init') {
      try {
        low = await createEngine(msg.module ?? (await fetchBytes(msg.url)));
        if (!paintsBoxes(low)) return die('the wasm does not paint box jobs of this version');
      } catch (error) {
        return die(`the engine could not start: ${error?.message ?? error}`);
      }
      return null;
    }
    if (!low) return die(`'${msg.op}' before the engine started`);
    const got = replay(msg);
    if (!got) return die(`unknown message '${msg.op}'`);
    if (!same(got, msg.expect)) return die(`'${msg.op}' gave ${JSON.stringify(got)} here and ${JSON.stringify(msg.expect)} on the main thread`);
    return null;
  }

  return { handle, engine: () => low, dead: () => dead };
}

// The worker itself: every message through the handler, strictly one after
// another (the init awaits the instance; nothing may overtake it).
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  const handler = createPaintHandler();
  let queue = Promise.resolve();
  self.onmessage = (e) => {
    const msg = e.data;
    queue = queue.then(async () => {
      const reply = await handler.handle(msg);
      if (!reply) return;
      const data = reply.raster?.data;
      self.postMessage(reply, data ? [data.buffer] : []);
    });
  };
}
