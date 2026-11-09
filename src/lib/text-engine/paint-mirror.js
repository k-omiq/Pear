// ===== The main engine's state, mirrored into the paint worker =====
//
// The paint worker (paint-worker.js) is a second instance of the engine. A
// box job names fonts and fallback chains by the ids the MAIN instance gave
// them, so the worker has to hold the same fonts under the same ids. It does
// by being told every call that changes them, in order, as it is made:
// `attach` wraps those calls on the main instance's loader object (`low`,
// text-engine/js/engine.mjs) so each one also goes to the worker, with what
// it returned on the main thread. The engine gives out ids by the first free
// slot, so the same calls in the same order give the same ids; the worker
// checks each one and stops painting at the first that differs.
//
// The mirror is attached when the instance is made, before any rule is set
// or font is added (`createRustTextEngine`'s `mirror`): font bytes the main
// instance was given before the mirror existed would be gone, and a worker
// without them would paint other letters. That is why there is no way to
// attach it later.
//
// ANY DOUBT IS THE SYNCHRONOUS PATH. A worker that cannot start, errors, or
// answers an id other than the main thread's is dead for the session: one
// warning, every paint it was asked for answered `{ dead: true }` (the caller
// paints those on the main thread, as before there was a worker), and it is
// never started again.

// The preference (`paintWorker`, prefs.svelte.js), mirrored here so this file
// does not import the prefs (which import the engine switch, which imports this).
let allowed = true;
export function setPaintWorkerAllowed(v) {
  allowed = !!v;
}
export function paintWorkerAllowed() {
  return allowed;
}

/**
 * A mirror over `transport`: `{ send(msg, transfer), onMessage(cb), close() }`.
 * The worker's transport is `workerTransport`; a test hands one that calls the
 * handler in-process.
 */
export function createPaintMirror(transport, { warn = (m) => console.warn(m) } = {}) {
  let dead = null;
  let nextId = 0;
  // paint id -> { resolve, reject }
  const pending = new Map();
  // While true the calls are part of one call already being sent (an
  // instance's own clean-up of what it made on the way), and not sent again.
  let inner = 0;

  function die(reason, quiet = false) {
    if (dead) return;
    dead = reason;
    if (!quiet) warn(`the paint worker is off for this session (${reason}); boxes are painted on the main thread`);
    for (const p of pending.values()) p.resolve({ dead: true });
    pending.clear();
    try {
      transport.close();
    } catch {
      /* already gone */
    }
  }

  transport.onMessage((reply) => {
    if (reply?.type === 'dead') {
      die(reply.reason || 'the worker stopped');
      return;
    }
    const p = pending.get(reply?.id);
    if (!p) return;
    pending.delete(reply.id);
    if (reply.type === 'painted') p.resolve({ raster: reply.raster, ms: reply.ms });
    else p.reject(new Error(reply.message || 'the paint worker failed'));
  });

  function send(msg, transfer = []) {
    if (dead) return;
    try {
      transport.send(msg, transfer);
    } catch (error) {
      die(`it could not be sent '${msg.op}': ${error?.message ?? error}`);
    }
  }

  // `fn` on the main instance, then the same call to the worker with what it
  // came to. Throws as `fn` threw: the main thread's behaviour is unchanged.
  function mirrored(msg, fn, transfer) {
    let v;
    let threw = null;
    try {
      v = fn();
    } catch (error) {
      threw = error;
    }
    if (!inner) send({ ...msg, expect: threw ? { error: true } : { v: v === undefined ? null : v } }, transfer);
    if (threw) throw threw;
    return v;
  }

  return {
    /** Wraps the state-changing calls of `low`, the main instance. Once, before anything is added. */
    attach(low) {
      const o = {
        addFont: low.addFont,
        addSiblingFace: low.addSiblingFace,
        removeFont: low.removeFont,
        setRule: low.setRule,
        chainNew: low.chainNew,
        chainPush: low.chainPush,
        chainFree: low.chainFree,
      };
      low.addFont = (data, faceIndex = 0) => {
        // A copy of the bytes as the main instance gets them, sent and given
        // up: the worker's instance takes its own copy of them in turn.
        const copy = data instanceof Uint8Array ? data.slice() : new Uint8Array(data).slice();
        return mirrored({ op: 'addFont', bytes: copy, index: faceIndex }, () => o.addFont(data, faceIndex), [copy.buffer]);
      };
      low.addSiblingFace = (font, faceIndex) => mirrored({ op: 'addSiblingFace', font, index: faceIndex }, () => o.addSiblingFace(font, faceIndex));
      low.removeFont = (font) => mirrored({ op: 'removeFont', font }, () => o.removeFont(font));
      low.setRule = (name, value) => mirrored({ op: 'setRule', name, value }, () => o.setRule(name, value));
      low.chainNew = () => mirrored({ op: 'chainNew' }, () => o.chainNew());
      low.chainPush = (chain, font, synth = {}) =>
        mirrored({ op: 'chainPush', chain, font, synth: { bold: !!synth.bold, italic: !!synth.italic } }, () => o.chainPush(chain, font, synth));
      low.chainFree = (chain) => mirrored({ op: 'chainFree', chain }, () => o.chainFree(chain));
    },
    /**
     * `addInstance` (text-engine/js/instance.mjs) on the main instance, sent as
     * one call: the worker runs the same function, which makes and lets go of
     * the same fonts on the way.
     */
    addInstance(addInstance, low, font, settings) {
      return mirrored({ op: 'addInstance', font, settings: { ...settings } }, () => {
        inner++;
        try {
          return addInstance(low, font, settings);
        } finally {
          inner--;
        }
      });
    },
    /** Whether paints may be sent: false once dead. */
    alive: () => !dead,
    dead: () => dead,
    /**
     * Paints encoded box job bytes in the worker. Resolves `{ raster, ms }`
     * (`raster` null when the job draws nothing; `ms` the engine's time in
     * the worker), or `{ dead: true }` when the worker cannot; rejects when the
     * engine refused the job, as the synchronous paint would have thrown. The
     * bytes are given up (transferred).
     */
    paint(bytes) {
      if (dead) return Promise.resolve({ dead: true });
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ op: 'paint', id, bytes }, [bytes.buffer]);
      });
    },
    /** Stops the worker (the engine switch going off). */
    close() {
      die('closed', true);
    },
    /** Marks it dead from outside (the worker's own error events). */
    _fail: (reason) => die(reason),
  };
}

/**
 * A mirror over a real Web Worker, started now and handed the compiled
 * `module` (or, where a module cannot be posted, `url` to fetch it from).
 * Null where there are no workers (node, jsdom) or the preference is off.
 */
export function startPaintMirror(module, url = null) {
  if (!allowed || typeof Worker !== 'function' || !(typeof WebAssembly === 'object' && module instanceof WebAssembly.Module)) return null;
  let worker;
  try {
    worker = new Worker(new URL('./paint-worker.js', import.meta.url), { type: 'module', name: 'paint' });
  } catch (error) {
    console.warn(`the paint worker could not start (${error?.message ?? error}); boxes are painted on the main thread`);
    return null;
  }
  let listener = null;
  let mirror = null;
  const transport = {
    send: (msg, transfer) => worker.postMessage(msg, transfer),
    onMessage: (cb) => (listener = cb),
    close: () => worker.terminate(),
  };
  worker.onmessage = (e) => listener?.(e.data);
  worker.onerror = (e) => {
    e?.preventDefault?.();
    mirror?._fail(`it errored: ${e?.message ?? 'unknown'}`);
  };
  worker.onmessageerror = () => mirror?._fail('a message could not be read');
  mirror = createPaintMirror(transport);
  try {
    worker.postMessage({ op: 'init', module });
  } catch {
    // A module that cannot be posted: the worker fetches the wasm itself.
    const abs = url ? new URL(url, globalThis.location?.href).href : null;
    if (!abs) {
      mirror._fail('the engine could not be handed to it');
      return null;
    }
    worker.postMessage({ op: 'init', url: abs });
  }
  return mirror;
}
