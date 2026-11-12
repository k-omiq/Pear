// ===== Door B: the SDK's fetch, through Rust =====
// The in-app panel runs the official Claude SDK in the webview, but the SDK
// never sees the API key and never reaches the network itself: its `fetch` is
// this one, which hands the request to Rust (`ai_request`, src-tauri/src/
// ai_api.rs). Rust adds the key from the OS keychain, sends it to
// api.anthropic.com and streams the answer back over a channel: the status and
// headers, then the body as text, then the end. Here that becomes an ordinary
// `Response` with a streaming body, so the SDK parses events, retries and reads
// errors as it would anywhere (docs/AI_TYPESETTING_PLAN.md section 7).

export const API_ORIGIN = 'https://api.anthropic.com';

let seq = 0;

// A failure before any answer came back that is the user's to fix (no key, a
// path the proxy refuses): an API error the SDK reads and does not retry.
function refused(message) {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

function headerPairs(h) {
  if (!h) return [];
  if (typeof h.entries === 'function' && !Array.isArray(h)) return [...h.entries()];
  if (Array.isArray(h)) return h.map(([k, v]) => [String(k), String(v)]);
  return Object.entries(h)
    .filter(([, v]) => v != null)
    .map(([k, v]) => [k, String(v)]);
}

// `invoke` and `Channel` are Tauri's (`@tauri-apps/api/core`); tests pass fakes.
export function tauriFetch({ invoke, Channel }) {
  return async function fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)));
    if (url.origin !== API_ORIGIN) throw new TypeError(`the AI panel only talks to the Claude API, not ${url.origin}`);
    let body = init.body ?? null;
    if (body != null && typeof body !== 'string') body = await new Response(body).text();
    const id = ++seq;
    const signal = init.signal ?? null;
    const abortError = () => new DOMException('The request was aborted.', 'AbortError');
    if (signal?.aborted) throw abortError();

    return new Promise((resolve, reject) => {
      let ctrl = null;
      let head = false;
      let done = false;
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(c) {
          ctrl = c;
        },
        // The SDK let go of the body (it had what it needed, or gave up).
        cancel() {
          finish();
          invoke('ai_abort', { id }).catch(() => {});
        },
      });
      const finish = () => {
        done = true;
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (err) => {
        if (done) return;
        finish();
        if (!head) reject(err);
        else {
          try {
            ctrl.error(err);
          } catch {
            /* already closed */
          }
        }
      };
      const onAbort = () => {
        invoke('ai_abort', { id }).catch(() => {});
        fail(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const channel = new Channel();
      channel.onmessage = (f) => {
        if (done) return;
        if (f?.t === 'head') {
          head = true;
          resolve(new Response(stream, { status: f.status, headers: f.headers ?? [] }));
        } else if (f?.t === 'chunk') {
          ctrl.enqueue(enc.encode(f.text ?? ''));
        } else if (f?.t === 'end') {
          finish();
          ctrl.close();
        } else if (f?.t === 'fail') {
          // A network failure: the SDK retries it as one.
          fail(new TypeError(f.error || 'the connection to the Claude API failed'));
        }
      };

      invoke('ai_request', {
        id,
        method: init.method ?? 'GET',
        path: url.pathname + url.search,
        headers: headerPairs(init.headers),
        body,
        onFrame: channel,
      }).catch((err) => {
        if (done) return;
        finish();
        resolve(refused(String(err?.message ?? err)));
      });
    });
  };
}

// The SDK client the panel uses. The key it is given is a placeholder: Rust
// drops it and sends the real one.
export async function claudeClient() {
  const [{ default: Anthropic }, core] = await Promise.all([import('@anthropic-ai/sdk'), import('@tauri-apps/api/core')]);
  return new Anthropic({
    apiKey: 'kept-by-the-app',
    baseURL: API_ORIGIN,
    dangerouslyAllowBrowser: true,
    fetch: tauriFetch(core),
    maxRetries: 2,
  });
}
