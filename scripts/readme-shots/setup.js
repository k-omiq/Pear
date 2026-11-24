// README screenshots: loads the demo chapter into the dev server (scripts/readme-shots/take.sh).
const ent = () => performance.getEntriesByType('resource').map((e) => e.name);
const u = (f) => ent().find((n) => n.split('?')[0].endsWith('/src/lib/' + f)) || '/src/lib/' + f;

export async function mods() {
  return {
    st: await import(u('store.svelte.js')),
    rt: await import(u('route.svelte.js')),
  };
}

async function svgToDataUrl(url, w, h) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/png');
}

export const LINES = [
  { n: 1, type: 'dialogue', jp: 'ここまで来て、それを言うためだけに？', en: 'You came all this way just to tell me that?', at: [300, 140] },
  { n: 2, type: 'dialogue', jp: '来るしかなかった。他に誰もいなかったから。', en: 'I had to. Nobody else was left who could.', at: [780, 160] },
  { n: 3, type: 'dialogue', jp: 'なら、そこに立ってないで証明してみせろ。', en: 'Then stop standing there and prove it.', at: [345, 680] },
  { n: 4, type: 'sfx', jp: 'バキッ', en: 'KRAKK!!', at: [810, 668] },
  { n: 5, type: 'thought', jp: 'ありえない…', en: 'That is... not possible.', at: [700, 925] },
  { n: 6, type: 'dialogue', jp: 'もう一度、不可能をやってみせる！', en: 'Watch me do the impossible one more time!', at: [550, 1236] },
];

export function styleLine(st, n, fn) {
  const b = st.app.pages[0].boxes.find((x) => x.lineN === n);
  if (b) fn(b.style, b);
  return b;
}

export const RECTS = { 1: [130, 70, 470, 210], 2: [625, 85, 935, 235], 3: [195, 590, 495, 770], 4: [690, 590, 930, 740], 5: [590, 870, 810, 980], 6: [360, 1100, 740, 1375] };

export async function load({ mode = 'typeset', place = true, lines: shape = null } = {}) {
  const { st, rt } = await mods();
  const prefs = await import(u('prefs.svelte.js'));
  prefs.setPref('textEngine', 'browser');
  await document.fonts.load('40px Bangers');
  await document.fonts.load('26px "Comic Neue"');
  const raw = await svgToDataUrl('/scripts/readme-shots/page1.svg', 1100, 1560);
  let lines = LINES.map(({ at, ...l }) => l);
  if (shape) lines = lines.map(shape);
  st.loadProjectPages([{ id: 1, w: 1100, h: 1560, raw, cleaned: null, lines, boxes: [] }]);
  st.app.chapterMode = mode;
  st.app.chapterRef = { projectId: 'p1', chapterId: 'c1' };
  await rt.goEditor('p1', 'c1');
  await new Promise((r) => setTimeout(r, 400));
  if (place && mode !== 'translate') {
    for (const l of LINES) {
      st.activateLine(l.n);
      st.placeActiveAt(l.at[0], l.at[1]);
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  return { st, rt };
}
