import { load, styleLine } from '/scripts/readme-shots/setup.js';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function dress(st) {
  // SFX: Bangers, orange gradient, black then white strokes, tilted.
  styleLine(st, 4, (s, b) => {
    s.font = 'Bangers';
    s.size = 46;
    s.rotation = -8;
    b.w = 230; b.h = 90; b.x = 810 - 115; b.y = 668 - 45;
    s.gradient.on = true;
    s.gradient.stops = [
      { color: '#ffe066', pos: 0, opacity: 1 },
      { color: '#ff5a1f', pos: 0.55, opacity: 1 },
      { color: '#c4122f', pos: 1, opacity: 1 },
    ];
    const st0 = JSON.parse(JSON.stringify(s.strokeEffects[0]));
    s.strokeEffects = [
      { ...st0, size: 4, color: '#111111', pattern: { ...st0.pattern, on: false } },
      { ...st0, size: 9, color: '#ffffff', pattern: { ...st0.pattern, on: false } },
    ];
  });
  // The shout: Bangers, big, upper case.
  styleLine(st, 6, (s) => {
    s.font = 'Bangers';
    s.size = 50;
    s.lineHeight = 1.0;
  });
}

export async function editor() {
  const { st } = await load();
  await wait(300);
  dress(st);
  await wait(300);
  const b = styleLine(st, 4, () => {});
  st.selectBox(b.id);
  await wait(4500);
}

export async function fonts() {
  // The Font Library window, on the marketplace page.
  await wait(800);
  const tab = [...document.querySelectorAll('button')].find((b) => /Marketplace/.test(b.textContent));
  tab?.click();
  await wait(600);
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Refresh')?.click();
  await wait(3000);
}

export async function translate() {
  const { RECTS } = await import('/scripts/readme-shots/setup.js');
  const { st } = await load({
    mode: 'translate',
    lines: (l) => ({ ...l, rect: RECTS[l.n], en: l.n <= 4 ? l.en : '' }),
  });
  await wait(600);
  st.activateLine(5);
  await wait(2500);
}

export async function effects() {
  const { st } = await load();
  await wait(300);
  dress(st);
  await wait(300);
  const b = styleLine(st, 4, () => {});
  st.selectBox(b.id);
  const tabs = await import('/src/lib/inspector-tabs.svelte.js');
  const panels = await import('/src/lib/editor/panels.svelte.js');
  panels.setHidden('queue', true);
  panels.resizePanel('options', 340, 880);
  tabs.setInspectorTab(new URLSearchParams(location.search).get('tab') || 'fill');
  await wait(4500);
}
