// Takes one screenshot of a page in headless Chrome, once its title is READY.
// usage: node scripts/readme-shots/shot.mjs <url> <out.png> [w] [h] [scale]
// The README shots: scripts/readme-shots/take.sh (needs `npm run dev` on 5173).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [url, out, w = 1600, h = 1000, scale = 1] = process.argv.slice(2);
const prof = mkdtempSync(join(tmpdir(), 'readme-shot-'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--hide-scrollbars',
  `--window-size=${w},${h}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs;
for (let i = 0; i < 50; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const tab = tabs.find((t) => t.type === 'page');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.consoleAPICalled' && process.env.LOG) console.log('console:', m.params.args.map((a) => a.value ?? a.description).join(' ')); if (m.method === 'Runtime.exceptionThrown') console.log('exception:', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: +scale, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await send('Page.navigate', { url });
let state = '';
for (let i = 0; i < 120; i++) {
  await sleep(500);
  const r = await send('Runtime.evaluate', { expression: 'document.title' });
  state = r.result?.result?.value;
  if (state === 'READY' || state === 'ERR') break;
}
const log = await send('Runtime.evaluate', { expression: "document.getElementById('demo-log')?.textContent || ''" });
console.log('state:', state, log.result?.result?.value || '');
if (process.env.EVAL) { const e = await send('Runtime.evaluate', { expression: process.env.EVAL, awaitPromise: true, returnByValue: true }); console.log('eval:', JSON.stringify(e.result?.result?.value ?? e.result)); }
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('wrote', out);
ws.close(); chrome.kill(); await sleep(300); rmSync(prof, { recursive: true, force: true });
