// ===== how a box's text sits in its bubble, in numbers =====
//
// The rules a letterer works to (docs/AI_EXPERT_TYPESETTER.md section 2), each
// measured on the box as every renderer draws it: the lines `placeBlock` lays
// out, each line's glyph ink, against the outline polygon (outline-geom.js).
//
//   overflow   px of ink past the outline, per side (R1)
//   margin     the least air between ink and outline, px and em (R2)
//   rows       each line's ink width and the outline's room across its ink
//   shape      the line-width profile: oval score, hourglass, widest line (R3-R5)
//   centre     the ink block's centre against the outline's visual centre (R9)
//   hyphens    lines ending in a hyphen the text does not have (R6)
//   orphans    lines of one word shorter than three letters (R7)
//
// The glyph ink only: a stroke the colour of the bubble is not seen on it, and
// the box holds the stroke anyway (contain.js). Null for a box with no outline,
// no text, or text on a curve, and with no metrics (the node test runner's
// stand-in widths are no measurement of a bubble). Pure over the box and its
// text.

import { placeBlock, boxCandidate } from './contain.js';
import { canMeasure } from './measure.js';
import { ovalProfile } from './typeset.js';
import { fitPolygon, intervalsAt, intervalsDown, roomOver, visualCentre, turnPolygon } from './outline-geom.js';

// The thresholds the check reads (agent/tools/check.js) and the guide states.
export const FIT_RULES = Object.freeze({
  goodMargin: 0.5, // em of air that reads as comfortable
  tightMargin: 0.25, // em below which the text crowds its outline
  hourglassDip: 0.12, // an interior line this much narrower than the widest on both sides
  ovalGood: 0.75, // oval score a round block should reach
  offCentre: 0.3, // em of centre offset a reader notices (and never under 3 px)
  minOrphan: 3,
});

const r1 = (v) => Math.round(v * 10) / 10;
const LETTERS = /\p{L}|\p{N}/gu;
const letters = (w) => (w.match(LETTERS) ?? []).length;

// Lines the breaker ended inside a word (auto-layout.js `addedHyphens`).
export function addedHyphens(lines, text) {
  const words = String(text).split(/\s+/);
  let n = 0;
  for (const line of lines) {
    const tok = line.trimEnd().split(/\s+/).pop() ?? '';
    if (tok.length > 1 && tok.endsWith('-') && !words.some((w) => w.startsWith(tok))) n++;
  }
  return n;
}

export function orphanCount(lines, min = FIT_RULES.minOrphan) {
  if (lines.length < 2) return 0;
  return lines.filter((l) => {
    const words = l.trim().split(/\s+/).filter(Boolean);
    return words.length === 1 && letters(words[0]) > 0 && letters(words[0]) < min;
  }).length;
}

// The line-width profile, judged. `ws` are ink widths, top to bottom.
export function shapeOf(ws, rules = FIT_RULES) {
  const n = ws.length;
  const max = Math.max(0, ...ws);
  if (n < 3 || !(max > 0)) return { kind: n < 3 ? 'short' : 'empty', oval: null, hourglass: false, widest: ws.indexOf(max) };
  const want = ovalProfile(n);
  const top = Math.max(...want);
  let sum = 0;
  ws.forEach((w, i) => (sum += (w / max - want[i] / top) ** 2));
  const oval = Math.max(0, 1 - 2 * Math.sqrt(sum / n));
  let hourglass = false;
  for (let i = 1; i < n - 1; i++) {
    const above = Math.max(...ws.slice(0, i));
    const below = Math.max(...ws.slice(i + 1));
    if (ws[i] < (1 - rules.hourglassDip) * Math.min(above, below)) hourglass = true;
  }
  const widest = ws.indexOf(max);
  const even = ws.every((w) => w >= 0.88 * max);
  const kind = hourglass
    ? 'hourglass'
    : even
      ? 'rect'
      : widest === 0
        ? 'funnel'
        : widest === n - 1
          ? 'pyramid'
          : oval >= rules.ovalGood
            ? 'oval'
            : 'ragged';
  return { kind, oval: Math.round(oval * 100) / 100, hourglass, widest };
}

// The outline's clearance above and below an ink rectangle, sampled across it:
// for each x, the interior run down that vertical line that holds the ink's
// middle. Negative is ink past the outline.
function verticalClear(pts, x0, x1, y0, y1) {
  let top = Infinity;
  let bottom = Infinity;
  const mid = (y0 + y1) / 2;
  for (let k = 0; k <= 8; k++) {
    const x = x0 + ((x1 - x0) * k) / 8;
    const runs = intervalsDown(pts, x);
    const run = runs.find(([a, b]) => mid >= a && mid <= b) ?? runs.reduce((best, iv) => (!best || Math.abs((iv[0] + iv[1]) / 2 - mid) < Math.abs((best[0] + best[1]) / 2 - mid) ? iv : best), null);
    if (!run) return { top: -(y1 - y0), bottom: -(y1 - y0) };
    top = Math.min(top, y0 - run[0]);
    bottom = Math.min(bottom, run[1] - y1);
  }
  return { top, bottom };
}

// Each line's ink as a page rectangle, in the box's unturned frame.
export function lineInks(b, place) {
  const out = [];
  place.lines.forEach((line, i) => {
    const k = place.inks[i];
    if (!k) return;
    const base = b.y + place.blockY + i * place.lineH + place.baseY;
    const x = b.x + place.lineX[i];
    out.push({ i, line, x0: x + k.left, x1: x + k.right, y0: base - k.ascent, y1: base + k.descent });
  });
  return out;
}

export function fitReport(b, text, rules = FIT_RULES) {
  if (!b?.style || !b.fit || !canMeasure()) return null;
  const raw = fitPolygon(b.fit);
  if (!raw) return null;
  const place = placeBlock(boxCandidate(b, text), { cache: false });
  if (!place || place.isCurve) return null;
  const s = place.s;
  const size = s.size;
  // The text turns with its box; the outline does not. Asked in the box's frame.
  const rot = Number(s.rotation) || 0;
  const pts = turnPolygon(raw, -rot, b.x + b.w / 2, b.y + b.h / 2);
  const inks = lineInks(b, place);
  if (!inks.length) return null;
  const overflow = { l: 0, t: 0, r: 0, b: 0 };
  let margin = Infinity;
  const rows = [];
  for (const k of inks) {
    const room = roomOver(pts, k.y0, k.y1, (k.x0 + k.x1) / 2);
    const w = k.x1 - k.x0;
    if (!room) {
      // No interior across this line's whole height: it is past the top or the
      // bottom of the outline, or across a gap in it.
      const v = verticalClear(pts, k.x0, k.x1, k.y0, k.y1);
      overflow.t = Math.max(overflow.t, -v.top);
      overflow.b = Math.max(overflow.b, -v.bottom);
      if (!(v.top < 0) && !(v.bottom < 0)) overflow.l = Math.max(overflow.l, w);
      margin = Math.min(margin, v.top, v.bottom, 0);
      rows.push([r1(w), 0]);
      continue;
    }
    const [l, r] = room;
    overflow.l = Math.max(overflow.l, l - k.x0);
    overflow.r = Math.max(overflow.r, k.x1 - r);
    margin = Math.min(margin, k.x0 - l, r - k.x1);
    rows.push([r1(w), r1(r - l)]);
  }
  const first = inks[0];
  const last = inks[inks.length - 1];
  const vt = verticalClear(pts, first.x0, first.x1, first.y0, first.y1);
  const vb = verticalClear(pts, last.x0, last.x1, last.y0, last.y1);
  overflow.t = Math.max(overflow.t, -vt.top);
  overflow.b = Math.max(overflow.b, -vb.bottom);
  margin = Math.min(margin, vt.top, vb.bottom);
  for (const k of Object.keys(overflow)) overflow[k] = Math.ceil(Math.max(0, overflow[k]) - 0.25);
  const x0 = Math.min(...inks.map((k) => k.x0));
  const x1 = Math.max(...inks.map((k) => k.x1));
  const y0 = first.y0;
  const y1 = last.y1;
  const [cx, cy] = visualCentre(pts);
  const ws = place.lines.map((_, i) => inks.find((k) => k.i === i)).filter(Boolean).map((k) => k.x1 - k.x0);
  const outside = Object.values(overflow).some((v) => v > 0);
  return {
    size,
    lines: place.lines.length,
    inside: !outside,
    ...(outside ? { overflow } : null),
    margin: { px: r1(margin), em: Math.round((margin / size) * 100) / 100 },
    rows,
    shape: shapeOf(ws, rules),
    centre: { dx: r1((x0 + x1) / 2 - cx), dy: r1((y0 + y1) / 2 - cy) },
    hyphens: addedHyphens(place.lines, place.text),
    orphans: orphanCount(place.lines, s.minOrphan ?? rules.minOrphan),
  };
}

// The rules a report breaks, as check issues: { kind, detail }. `round` says
// whether the outline is a balloon (an oval block is asked of it) rather than
// a caption frame.
export function fitIssues(rep, { round = true } = {}, rules = FIT_RULES) {
  if (!rep) return [];
  const out = [];
  if (!rep.inside) out.push({ kind: 'outside', detail: { overflow: rep.overflow } });
  else if (rep.margin.em < rules.tightMargin) out.push({ kind: 'tight', detail: { margin: rep.margin } });
  if (rep.shape.hourglass) out.push({ kind: 'hourglass', detail: { rows: rep.rows.map((r) => r[0]) } });
  else if (round && rep.shape.oval != null && (rep.shape.kind === 'funnel' || rep.shape.kind === 'pyramid' || rep.shape.oval < 0.5)) {
    out.push({ kind: 'shape', detail: { kind: rep.shape.kind, oval: rep.shape.oval, rows: rep.rows.map((r) => r[0]) } });
  }
  const off = Math.max(3, rules.offCentre * rep.size);
  if (Math.abs(rep.centre.dx) > off || Math.abs(rep.centre.dy) > off) out.push({ kind: 'offcentre', detail: rep.centre });
  if (rep.hyphens) out.push({ kind: 'hyphen', detail: { count: rep.hyphens } });
  if (rep.orphans) out.push({ kind: 'orphan', detail: { count: rep.orphans } });
  return out;
}
