const s = new URLSearchParams(location.search).get('s') || 'editor';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => {
  let pre = document.getElementById('demo-log');
  if (!pre) {
    pre = document.createElement('pre');
    pre.id = 'demo-log';
    pre.style.cssText = 'position:fixed;bottom:0;left:0;z-index:99999;background:#fff;color:#c00;font:12px monospace;max-width:100vw;white-space:pre-wrap';
    document.body.appendChild(pre);
  }
  pre.textContent += m + '\n';
};
window.__demoLog = log;
async function main() {
  for (let i = 0; i < 100 && !document.querySelector('#app > *'); i++) await wait(100);
  await wait(500);
  try {
    const scene = await import('/scripts/readme-shots/scenes.js');
    await scene[s]();
    document.getElementById('demo-log')?.remove();
    document.title = 'READY';
  } catch (e) {
    log('ERR ' + (e.stack || e));
    document.title = 'ERR';
  }
}
main();
