// Generates the app icon from one definition: an SVG for the repo and a
// 1024x1024 PNG for `tauri icon` to fan out into every platform size.
//
//   node scripts/make-icon.mjs /tmp/pear-1024.png src-tauri/icons/pear.svg
//   npx tauri icon /tmp/pear-1024.png
//   rm -rf src-tauri/icons/android src-tauri/icons/ios   (no mobile build)
//   cp src-tauri/icons/pear.svg public/favicon.svg
//   cp src-tauri/icons/pear.svg site/favicon.svg
//
// The Dock / taskbar icon follows the app theme: one 512 PNG per theme, which
// src-tauri/src/app_icon.rs embeds and swaps in at runtime.
//
//   node scripts/make-icon.mjs --themes src-tauri/icons/themes
//
// Hand-rolled rasterizer rather than a dependency: the art is a rounded square
// and a pear made of cubic curves. Each curve is sampled into a fine polygon and
// a scanline fill with 4x4 supersampling draws it within a small fraction of a
// pixel of the SVG's true curves, and adding a native SVG renderer to a desktop
// app's build chain for one file is a poor trade.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZE = 1024;
const SS = 4; // supersampling factor per axis

// macOS rounds its app icons with a superellipse; a plain rounded rect at this
// radius is within a pixel or two of it at icon sizes and needs no curve
// rasterizer. The 1024 canvas is 100% of the tile, so the art is inset the way
// Apple's own template insets it (~10%) rather than filling the corners.
const MARGIN = 100;
const RADIUS = 200;

// A dark tile with a light pear, which is the way round that survives macOS.
//
// The first icon was black-on-white, and on macOS 26 in Dark appearance it read
// as nothing at all: the system applies an automatic dark treatment to a legacy
// .icns app icon, darkening the light tile, and black art on a tile that has
// just been darkened has no contrast left. An app opts out of that by shipping
// an Icon Composer .icon asset carrying explicit light and dark artwork, which
// Tauri's bundler does not emit - it writes .icns and nothing else - so the
// artwork has to survive the treatment unaided.
//
// Light-on-dark does. A dark tile is already where the treatment is trying to
// take it, so the art keeps its contrast in Dark appearance, and in Light
// appearance the same icon reads as a crisp black tile rather than as a washed
// one.
const TILE = 0x111111; // near-black, not pure black: a pure-black tile loses
// its rounded silhouette against a dark Dock, and this is dark enough that the
// system's treatment has nothing left to darken.
const INK = 0xffffff;

// The runtime icons: the tile is the theme's surface and the pear its accent,
// from the [data-theme] blocks in src/styles.css. Dark is the bundled icon.
// These are set as NSApplication's icon image, not shipped in the .icns, so the
// system's dark treatment described above does not reach them and a light tile
// is safe here.
const THEME_ICONS = {
  light: [0xf6f5f2, 0x2c2b28],
  dark: [TILE, INK],
  sakura: [0xf9f3f3, 0xa63b5f],
  jade: [0x151d1a, 0x6fcfa2],
  ocean: [0x22364b, 0x9bccfb],
};
const THEME_ICON_SIZE = 512;

// Shapes are a start point and cubic segments [c1x, c1y, c2x, c2y, x, y], in
// the pear's own space: x centred on 50, the body from y 6 to 97.
//
// The body's right side, top to bottom: the small upper bulb, an S-curve out
// to the widest point of the lower bulb, then round to the bottom. Each joint's
// controls sit on one line, so the outline has no corners. The left side is
// the mirror.
const BODY_TOP = [50, 6];
const BODY_RIGHT = [
  [58.5, 6, 64.5, 14, 65.5, 27],
  [66.3, 40, 81, 52, 81, 69],
  [81, 84.4, 67, 97, 50, 97],
];

function mirrored(start, segs) {
  const m = (x) => 100 - x;
  const back = [];
  let at = start;
  const ends = segs.map((s) => {
    const prev = at;
    at = [s[4], s[5]];
    return prev;
  });
  for (let i = segs.length - 1; i >= 0; i--) {
    const [c1x, c1y, c2x, c2y] = segs[i];
    const [x, y] = ends[i];
    back.push([m(c2x), c2y, m(c1x), c1y, m(x), y]);
  }
  return back;
}

const BODY = { start: BODY_TOP, segs: [...BODY_RIGHT, ...mirrored(BODY_TOP, BODY_RIGHT)] };

// Leans right as it rises; its foot is hidden inside the body.
const STEM = {
  start: [47.6, 10],
  segs: [
    [47.4, 2, 50, -4.5, 52.8, -8.2],
    [53.8, -9.8, 56.4, -8.8, 56.6, -6.8],
    [54.2, -3.6, 52.6, 2, 52.6, 10],
    [51, 10, 49.2, 10, 47.6, 10],
  ],
};

// Pointed at both ends, so two explicit curves rather than a smooth loop.
const LEAF = {
  start: [53.5, -1],
  segs: [
    [57, -11.5, 68, -16, 79, -13],
    [72, -4, 62, 1.5, 53.5, -1],
  ],
};

const SHAPES = [BODY, STEM, LEAF];

function cubicPoint(a, s, t) {
  const u = 1 - t;
  const [c1x, c1y, c2x, c2y, x, y] = s;
  return [
    u * u * u * a[0] + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
    u * u * u * a[1] + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
  ];
}

function sample(shape, steps = 96) {
  const pts = [];
  let at = shape.start;
  for (const s of shape.segs) {
    for (let k = 0; k < steps; k++) pts.push(cubicPoint(at, s, k / steps));
    at = [s[4], s[5]];
  }
  return pts;
}

// Scale the art to sit inside the tile, centred by its own bounding box, then
// lifted a little: the pear's weight is all in its lower bulb, and a pear
// centred by its box looks like it is sinking.
function fit(shapes) {
  const all = shapes.flatMap((s) => sample(s, 16));
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const field = SIZE - MARGIN * 2;
  const scale = (field * 0.66) / Math.max(maxX - minX, maxY - minY);
  const ox = (SIZE - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (SIZE - (maxY - minY) * scale) / 2 - minY * scale - field * 0.015;
  const tf = ([x, y]) => [x * scale + ox, y * scale + oy];
  return shapes.map((s) => ({
    start: tf(s.start),
    segs: s.segs.map((c) => [...tf([c[0], c[1]]), ...tf([c[2], c[3]]), ...tf([c[4], c[5]])]),
  }));
}

const art = fit(SHAPES);
const polys = art.map((s) => sample(s));

// Where each polygon crosses the horizontal line y, sorted: inside is between
// the 1st and 2nd crossing, the 3rd and 4th, and so on.
function crossings(py, pts) {
  const xs = [];
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py) xs.push(((xj - xi) * (py - yi)) / (yj - yi) + xi);
  }
  return xs.sort((a, b) => a - b);
}

function insideSpans(px, xs) {
  let inside = false;
  for (const x of xs) {
    if (x > px) break;
    inside = !inside;
  }
  return inside;
}

function insideRoundRect(px, py) {
  const x0 = MARGIN, y0 = MARGIN, x1 = SIZE - MARGIN, y1 = SIZE - MARGIN;
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + RADIUS), x1 - RADIUS);
  const cy = Math.min(Math.max(py, y0 + RADIUS), y1 - RADIUS);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

// One pass, 16 samples per pixel: coverage of the tile becomes alpha, coverage
// of the pear shades within it. The pear's parts overlap (stem into body, leaf
// onto stem), so a sample is ink when any part holds it. Compositing at sample
// level rather than layer level keeps the art's edge clean against the tile
// instead of blending twice. The art is laid out on the SIZE canvas; `out` is
// the PNG's own size, and each output pixel samples its share of that canvas.
function render(out, tile, ink) {
  const k = SIZE / out;
  const channels = (c) => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
  const t = channels(tile);
  const p = channels(ink);
  const rgba = Buffer.alloc(out * out * 4);
  for (let y = 0; y < out; y++) {
    const rows = [];
    for (let sy = 0; sy < SS; sy++) {
      const py = (y + (sy + 0.5) / SS) * k;
      rows.push({ py, spans: polys.map((poly) => crossings(py, poly)) });
    }
    for (let x = 0; x < out; x++) {
      let field = 0, inked = 0;
      for (const { py, spans } of rows) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) * k;
          if (!insideRoundRect(px, py)) continue;
          field++;
          if (spans.some((xs) => insideSpans(px, xs))) inked++;
        }
      }
      const i = (y * out + x) * 4;
      // Ink is expressed as a colour, not as a second alpha: the pixel is the
      // opaque tile colour where the field is covered and shades toward the
      // pear's colour as the pear takes it, so a partially-covered edge pixel
      // carries one honest colour.
      const share = field ? inked / field : 0;
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(t[c] + (p[c] - t[c]) * share);
      rgba[i + 3] = Math.round((field / (SS * SS)) * 255);
    }
  }
  return encodePng(out, rgba);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (v) => '#' + v.toString(16).padStart(6, '0');
const f = (v) => v.toFixed(1);
const pathD = (s) =>
  `M${f(s.start[0])} ${f(s.start[1])}` + s.segs.map((c) => `C${c.map(f).join(' ')}`).join('') + 'Z';

const args = process.argv.slice(2);
if (args[0] === '--themes') {
  const dir = args[1];
  mkdirSync(dir, { recursive: true });
  for (const [name, [tile, ink]] of Object.entries(THEME_ICONS)) {
    writeFileSync(join(dir, `${name}.png`), render(THEME_ICON_SIZE, tile, ink));
    console.log('wrote', join(dir, `${name}.png`));
  }
  process.exit(0);
}

const [outPng, outSvg] = args;
writeFileSync(outPng, render(SIZE, TILE, INK));
writeFileSync(
  outSvg,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <title>Pear</title>
  <rect x="${MARGIN}" y="${MARGIN}" width="${SIZE - MARGIN * 2}" height="${SIZE - MARGIN * 2}" rx="${RADIUS}" ry="${RADIUS}" fill="${hex(TILE)}"/>
${art.map((s) => `  <path d="${pathD(s)}" fill="${hex(INK)}"/>`).join('\n')}
</svg>
`,
);
console.log('wrote', outPng, outSvg);
