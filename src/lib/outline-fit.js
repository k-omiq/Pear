// ===== outline fit: text set to the bubble outline the way a letterer sets it =====
//
// docs/AI_EXPERT_TYPESETTER.md. For a box whose style has a `margin`, the
// solver (auto-layout.js `solveLayout`) hands its balloon here. The rules, in
// the order they decide:
//
//   hard     every line's room is the outline's own interval across its em
//            band, with `margin` em of air on every side (`outlineRows`); a
//            line that does not fit its room is not a candidate.
//   size     the reference size first; smaller only as far as the outline
//            needs, and never below the floor (one size per kind of text).
//   shape    in a balloon, a diamond / oval block: widest lines in the
//            middle, short at the top and bottom; never an hourglass; no
//            funnel or pyramid. In a rectangle (a caption frame, a box as its
//            own outline: `isRectOutline`), a rectangular block: every line
//            but the last as wide as the widest.
//   words    no hyphens (the last resort, and only where the box's
//            "Hyphenate long words" is on: `style.hyphenate`), no short word
//            alone.
//   fit      the block's aspect follows the balloon's: a tall balloon takes
//            more, shorter lines.
//   centre   the block's ink centred on the outline's visual centre, on the
//            axis that gives it the most room.
//
// The lines are chosen here by an exact search over every breaking of the
// text into each line count, aimed at oval targets of several widths, and
// scored as a whole; they are kept on the box (`breaks`) because no single
// width would make the breaker choose them. Pure over its arguments and the
// metrics measure.js reads.

import { applyCase, casedRuns, lineWidth, sliceWidth, withSpans, textInset, breaksFor, brokenLines, withFamiliesHeld } from './measure.js';
import { fitPolygon, visualCentre, polyBounds, roomOver, turnPolygon, isRectOutline } from './outline-geom.js';
import { ovalProfile, neededHeight, balanceCandidates } from './typeset.js';
import { placeBlock, containBox, inkHeight, linesInkRect, REVIEW_REASONS } from './contain.js';
import { fitReport, shapeOf, orphanCount, addedHyphens } from './fit-report.js';

export const OUTLINE_FIT = Object.freeze({
  margin: 0.5, // em of air a new outline fit asks for
  tight: 0.25, // em the rooms leave: FIT_RULES.tightMargin (fit-report.js imports this module's peers)
  step: 0.5, // the size grid, as the solver's
  maxWords: 60, // past this the exact search is not run (the breaker's best is)
});

// The weights of the whole-block score, lower is better. Tuned on the
// otaku-old-age-home pages (docs/AI_EXPERT_TYPESETTER.md).
const W = {
  size: 16, // per unit of (ref - size) / ref: a px of 16 costs 1
  air: 1, // a line with only the tight margin, against one with the good margin
  single: 0.3, // each one-word line past the first, 3+ lines
  centre: 1.5, // per em the block's axis is off the visual centre
  oval: 3, // per unit of 1 - oval score (3+ lines)
  hourglass: 6,
  dip: 8, // per unit of the deepest dip, of the widest line
  flat: 3, // per unit of each end line past 0.7 of the widest
  ends: 1.2, // widest line first or last, 3+ lines
  two: 0.5, // two lines: per unit of |log(top / bottom)|
  orphan: 3,
  aspect: 0.5, // per unit of |log(block aspect / outline aspect)|
  tall: 2, // the block filling more than 85% of the outline's height
  line: 0.04,
  hyphen: 3,
  weak: 0.6, // a line ending on a word that leans on the next ("a", "the", "and")
  phrase: 0.25, // taken off for a line ending on a comma or a stop
  even: 3, // in a rectangle: per unit each line but the last falls short of the widest
};

// Words a line should not end on: they belong with what follows.
const WEAK_END = new Set(['a', 'an', 'the', 'i', 'and', 'but', 'or', 'so', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'my', 'your', 'his', 'her', 'our', 'their', 'its', 'is', 'am', 'are', 'was', 'be', 'if', 'as', 'that', 'this', 'from', 'by', 'not', "i'm", "it's", "don't", "can't", 'very', 'just', 'what']);
const lastWord = (ln) => (ln.trim().split(/\s+/).pop() ?? '').toLowerCase();

// The phrasing of a breaking: lines ending on a leaning word cost, lines
// ending on punctuation earn a little back. The last line is free.
function phrasing(lines) {
  let c = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const w = lastWord(lines[i]);
    if (/[,.!?;:\u2026]$|\.\.\.$/u.test(w)) c -= W.phrase;
    else if (WEAK_END.has(w.replace(/[^\p{L}']/gu, ''))) c += W.weak;
  }
  return c;
}

const upToGrid = (v, st) => Math.ceil(v / st - 1e-9) * st;
const downToGrid = (v, st) => Math.floor(v / st + 1e-9) * st;
const LETTERS = /\p{L}|\p{N}/gu;
const letterCount = (w) => (w.match(LETTERS) ?? []).length;

// The words of the cased text, with where each starts and ends, and which
// paragraph it is in: a line never takes words of two paragraphs.
function wordsOf(text) {
  const out = [];
  let para = 0;
  const re = /\S+|\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '\n') {
      para++;
      continue;
    }
    // A dash joins two words a line may break between, after the dash.
    let s = m.index;
    for (const piece of m[0].split(/(?<=[\u2014\u2013])(?=\S)/u)) {
      out.push({ s, e: s + piece.length, t: piece, para });
      s += piece.length;
    }
  }
  return out;
}

// The room of each of `n` lines from `top`, about `axis`, with `m` of air -
// `outlineRows` without its stand-in for a row with no room: 0 here, so the
// search can see the block does not fit there.
function roomsAt(pts, top, lineH, n, axis, m, pad) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const room = roomOver(pts, top + i * lineH + pad - m, top + (i + 1) * lineH - pad + m, axis);
    const w = room ? 2 * (Math.min(axis - room[0], room[1] - axis) - m) : 0;
    out[i] = Math.max(0, w);
  }
  return out;
}

// The axis a block of `n` lines from `top` has the most room on: the box's
// centre when its position is held, else the visual centre or one of the
// rows' own midpoints, whichever leaves the narrowest row widest.
function bestAxis(ctx, top, n) {
  if (ctx.lk.pos) return ctx.cx;
  const tries = new Set([ctx.cx]);
  for (let i = 0; i < n; i++) {
    const room = roomOver(ctx.pts, top + i * ctx.lineH + ctx.pad - ctx.m, top + (i + 1) * ctx.lineH - ctx.pad + ctx.m, ctx.cx);
    if (room) tries.add((room[0] + room[1]) / 2);
  }
  let best = ctx.cx;
  let bestMin = -1;
  for (const a of tries) {
    const rooms = roomsAt(ctx.pts, top, ctx.lineH, n, a, ctx.m, ctx.pad);
    const least = Math.min(...rooms) + 0.02 * rooms.reduce((s, v) => s + v, 0) - 0.01 * Math.abs(a - ctx.cx);
    if (least > bestMin) {
      bestMin = least;
      best = a;
    }
  }
  return best;
}

// The exact search: the breaking of `words` into `L` lines that is nearest the
// targets, every line inside its room (or, `soft`, priced for what it is not).
// Null when there is none.
//
// With a measure by offset (a text with runs: `measureIn`), the lines carry
// their offsets, as a layout's do.
function breakInto(ctx, words, L, rooms, targets, measure, soft) {
  const N = words.length;
  if (L > N) return null;
  const INF = Infinity;
  const cost = Array.from({ length: L + 1 }, () => new Float64Array(N + 1).fill(INF));
  const from = Array.from({ length: L + 1 }, () => new Int32Array(N + 1).fill(-1));
  cost[0][0] = 0;
  for (let k = 1; k <= L; k++) {
    const room = rooms[k - 1];
    const target = targets[k - 1];
    for (let i = k; i <= N - (L - k); i++) {
      for (let j = i - 1; j >= k - 1; j--) {
        if (words[j].para !== words[i - 1].para) break;
        if (cost[k - 1][j] === INF) continue;
        const w = measure.span ? measure.span(words[j].s, words[i - 1].e, false) : measure(ctx.text.slice(words[j].s, words[i - 1].e));
        let c = ((w - target) / target) ** 2;
        if (w > room + 0.5) {
          if (!soft) {
            if (i - j === 1) continue;
            break;
          }
          c += 50 * ((w - room) / ctx.size) ** 2;
        }
        if (i - j === 1 && N > 1 && letterCount(words[j].t) < ctx.minOrphan) c += W.orphan;
        const total = cost[k - 1][j] + c;
        if (total < cost[k][i]) {
          cost[k][i] = total;
          from[k][i] = j;
        }
      }
    }
  }
  if (cost[L][N] === INF) return null;
  const lines = [];
  const spans = [];
  for (let k = L, i = N; k > 0; k--) {
    const j = from[k][i];
    lines.unshift(ctx.text.slice(words[j].s, words[i - 1].e));
    spans.unshift([words[j].s, words[i - 1].e]);
    i = j;
  }
  return measure.span ? withSpans(lines, spans, ctx.text, ctx.runs) : lines;
}

// Line `i` of `lines` through `measure`: by its offsets when it has them.
function widthIn(measure, lines, i) {
  const sp = lines.spans?.[i];
  return sp ? measure.span(sp[0], sp[1], lines[i].length > sp[1] - sp[0]) : measure(lines[i]);
}

// The whole-block score of `lines` at `size` (lower is better), with each
// line's room.
function score(ctx, lines, size, rooms, measure, axisOf) {
  const ws = lines.spans ? lines.map((_, i) => widthIn(measure, lines, i)) : lines.map(measure);
  const L = lines.length;
  let s = (W.size * (ctx.ref - size)) / ctx.ref;
  const sh = shapeOf(ws);
  if (!ctx.round) {
    // A rectangle: the lines fill its width, the last may stop short.
    const max = Math.max(...ws);
    for (let i = 0; i < L - 1; i++) s += W.even * (1 - ws[i] / max);
  } else if (L >= 3) {
    s += W.oval * (1 - (sh.oval ?? 0));
    if (sh.hourglass) s += W.hourglass;
    s += W.dip * sh.dip;
    const max = Math.max(...ws);
    s += W.flat * (Math.max(0, ws[0] / max - 0.7) + Math.max(0, ws[L - 1] / max - 0.7));
    if (sh.kind === 'funnel' || sh.kind === 'pyramid') s += W.ends;
  } else if (L === 2 && ws[0] > 0 && ws[1] > 0) {
    s += W.two * Math.abs(Math.log(ws[0] / ws[1]));
  }
  s += W.orphan * orphanCount(lines, ctx.minOrphan);
  const lineH = size * ctx.lh;
  const blockW = Math.max(...ws);
  const blockH = L * lineH;
  if (blockW > 0 && ctx.aspect > 0) s += W.aspect * Math.abs(Math.log(blockW / blockH / ctx.aspect));
  const fill = blockH / ctx.height;
  if (fill > 0.85) s += W.tall * (fill - 0.85);
  // Air: the rooms leave the tight margin; the good margin is that much more.
  const want = Math.max(0, ctx.goodEm - ctx.marginEm) * size;
  if (want > 0) {
    const side = Math.min(...ws.map((w, i) => (rooms[i] - w) / 2));
    s += W.air * Math.max(0, 1 - side / want);
  }
  if (L >= 3) s += W.single * Math.max(0, lines.filter((ln) => !/\s/.test(ln.trim())).length - 1);
  s += (W.centre * Math.abs(axisOf - ctx.cx)) / size;
  s += W.line * L;
  s += W.hyphen * addedHyphens(lines, ctx.text);
  s += phrasing(lines);
  return s;
}

// Every candidate block at one size: for each line count the outline's height
// holds, its rows centred on the visual centre on the best axis, the exact
// search at oval targets of several widths (and, with `hyphens`, the
// breaker's own hyphenated best). Scored, with what placing them needs.
function candidatesAt(ctx, size, { soft = false, hyphens = false } = {}) {
  const st = { ...ctx.style, size };
  const lineH = size * ctx.lh;
  const pad = Math.max(0, (lineH - size) / 2);
  const c = { ...ctx, lineH, pad, size, m: ctx.marginEm * size };
  const measure = measureIn(ctx, st, size);
  const out = [];
  const nMax = Math.max(1, Math.min(ctx.words.length, Math.floor((ctx.height + 2 * c.m) / lineH)));
  const fixed = ctx.fixedLines;
  const seen = new Map();
  for (let L = fixed ? fixed.length : 1; L <= (fixed ? fixed.length : nMax); L++) {
    const top = ctx.cy - (L * lineH) / 2;
    for (const axis of new Set([ctx.cx, bestAxis(c, top, L)])) {
    const rooms = roomsAt(ctx.pts, top, lineH, L, axis, c.m, pad).map((w) => (ctx.lk.width ? Math.min(w, ctx.box.w - 2 * ctx.ti) : w));
    if (!soft && rooms.some((w) => !(w > 0))) continue;
    const take = (lines) => {
      if (!lines || lines.length !== L) return;
      if (!soft && lines.some((ln, i) => (lines.spans ? widthIn(measure, lines, i) : measure(ln)) > rooms[i] + 0.5)) return;
      // One entry per breaking: the axis that scores it best.
      const key = lines.join('\n');
      const cand = { size, lines, axis, top, rooms, L, score: score(c, lines, size, rooms, measure, axis) };
      const had = seen.get(key);
      if (had === undefined) {
        seen.set(key, out.length);
        out.push(cand);
      } else if (cand.score < out[had].score) out[had] = cand;
    };
    if (fixed) {
      take(fixed);
      continue;
    }
    if (ctx.words.length <= OUTLINE_FIT.maxWords) {
      const prof = L <= 2 || !ctx.round ? new Array(L).fill(1) : ovalProfile(L).map((v, _, a) => v / Math.max(...a));
      const widest = Math.max(...rooms);
      const total = ctx.runs ? measure.span(0, ctx.text.length, false) : measure(ctx.text.replace(/\s+/g, ' ').trim());
      const natural = total / prof.reduce((s, v) => s + v, 0);
      const scales = new Set([1, 0.9, 0.8, 0.7, 0.6, 0.5].map((k) => k * widest));
      for (const k of [0.85, 1, 1.15]) scales.add(Math.min(widest, natural * k));
      for (const T of scales) {
        if (!(T > 0)) continue;
        const targets = prof.map((p, i) => Math.max(1, Math.min(rooms[i] || T, T * p)));
        take(breakInto(c, ctx.words, L, rooms, targets, measure, soft));
      }
    }
    if (hyphens || ctx.words.length > OUTLINE_FIT.maxWords) {
      const fn = (n) => (n === L ? rooms.map((w) => Math.max(1, w)) : roomsAt(ctx.pts, ctx.cy - (n * lineH) / 2, lineH, n, axis, c.m, pad).map((w) => Math.max(1, w)));
      for (const cand of balanceCandidates(ctx.text, fn, measure, { hyphenate: hyphens, minOrphan: ctx.minOrphan, maxLines: nMax })) {
        take(cand.spans ? withSpans(cand.lines, cand.spans, ctx.text, ctx.runs) : cand.lines);
      }
    }
    }
  }
  return out;
}

// How `candidatesAt` measures at one size: by string, as it always has, and
// for a text with runs by offset too (`span`, into the cased text), in the
// faces.
function measureIn(ctx, st, size) {
  const fn = (str) => lineWidth(str, st, size);
  if (ctx.runs) fn.span = (a, b, hyphen) => sliceWidth(ctx.text, ctx.runs, st, size, a, b, hyphen);
  return fn;
}

// The box for a candidate: as wide as its widest line and its inset, on its
// axis; as tall as auto height makes it; its ink centred on the outline's
// visual centre. Locks keep the box's own width, height and centre.
function boxFor(ctx, cand) {
  const st = { ...ctx.style, size: cand.size };
  const ti = textInset(st);
  const widest = Math.max(...(cand.lines.spans ? cand.lines.map((_, i) => widthIn(measureIn(ctx, st, cand.size), cand.lines, i)) : cand.lines.map((l) => lineWidth(l, st, cand.size))));
  let w = ctx.lk.width ? ctx.box.w : Math.max(ctx.minW, Math.ceil(widest + 2 * ti + 1));
  let h = ctx.lk.height ? ctx.box.h : Math.max(ctx.minH, neededHeight(cand.lines.length, st, ti));
  const cy = ctx.cy;
  let x = cand.axis - w / 2;
  let y = cy - h / 2;
  const breaks = breaksFor(ctx.text, st, cand.size, cand.lines, ctx.runs);
  let c = { x, y, w, h, style: st, text: ctx.raw, runs: ctx.rawRuns, fit: ctx.fit, breaks };
  let place = placeBlock(c, { cache: false });
  if (!place || place.isCurve) return null;
  let v = containBox(c, place);
  if (!v.fits && !ctx.lk.height) {
    const grown = inkHeight(c, place);
    if (grown > h) {
      h = grown;
      c = { ...c, y: cy - h / 2, h };
      place = placeBlock(c, { cache: false });
      v = containBox(c, place);
    }
  }
  if (!v.fits && !ctx.lk.width) {
    const side = Math.max(v.overflow.l, v.overflow.r);
    if (side > 0) {
      w += 2 * Math.ceil(side);
      c = { ...c, x: cand.axis - w / 2, w };
      place = placeBlock(c, { cache: false });
    }
  }
  // Optical centring: the ink block's centre on the axis and the visual
  // centre, not its advances or its line boxes.
  if (!ctx.lk.pos) {
    const ink = linesInkRect(place);
    if (ink) {
      const dx = cand.axis - (c.x + (ink.x0 + ink.x1) / 2);
      const dy = cy - (c.y + (ink.y0 + ink.y1) / 2);
      c = { ...c, x: c.x + dx, y: c.y + dy };
    }
  } else {
    c = { ...c, x: ctx.box.x + ctx.box.w / 2 - c.w / 2, y: ctx.box.y + ctx.box.h / 2 - c.h / 2 };
  }
  return c;
}

// The report on a placed candidate, as the check will read it.
const reportOf = (ctx, c) => fitReport({ ...c, auto: { breaks: c.breaks } }, ctx.raw, undefined, ctx.rawRuns);

function result(c, status, reasons = []) {
  const place = placeBlock(c, { cache: false });
  return { size: c.style.size, x: c.x, y: c.y, w: c.w, h: c.h, lines: place.lines, status, reasons, review: null, breaks: c.breaks ?? null };
}

// The best of a list of candidates that, placed, really is inside its outline
// with at least `least` em of air - checked on the drawn ink, best score first.
function firstThatHolds(ctx, cands, least) {
  cands.sort((a, b) => a.score - b.score);
  ctx.trace?.push({ best: cands.slice(0, 10).map((c) => ({ size: c.size, score: Math.round(c.score * 100) / 100, lines: c.lines })) });
  for (const cand of cands.slice(0, 24)) {
    const c = boxFor(ctx, cand);
    if (!c) continue;
    const rep = reportOf(ctx, c);
    ctx.trace?.push({ size: cand.size, lines: cand.lines, score: Math.round(cand.score * 100) / 100, inside: rep?.inside, margin: rep?.margin?.em });
    if (rep && rep.inside && rep.margin.em >= least - 0.02) return c;
  }
  return null;
}

// `args` as `solveLayout` takes them; `region` is the box's balloon fit.
export function solveOutline(args) {
  return withFamiliesHeld(() => solve(args));
}

// `runs` are the faces of `text` (runs.js), null for none.
function solve({ text, style, refSize, region, locks, opts = {}, runs: rawRuns = null }) {
  const ref = Number(refSize) > 0 ? Number(refSize) : Number(style?.size);
  if (!style || !(ref > 0)) return null;
  const raw = String(text ?? '');
  if (!/\S/.test(raw)) return null;
  const poly = fitPolygon(region);
  if (!poly) return null;
  const box = opts.box ?? null;
  const has = box && [box.x, box.y, box.w, box.h].every(Number.isFinite);
  const l = locks ?? {};
  const lk = {
    size: !!l.size,
    width: !!(l.width && has),
    height: !!(l.height && has),
    pos: !!(l.pos && has),
    breaks: !!l.breaks,
  };
  const rot = Number(style.rotation) || 0;
  const [vx, vy] = visualCentre(poly);
  const pts = turnPolygon(poly, -rot, has && lk.pos ? box.x + box.w / 2 : vx, has && lk.pos ? box.y + box.h / 2 : vy);
  const [cx, cy] = lk.pos ? [box.x + box.w / 2, box.y + box.h / 2] : visualCentre(pts);
  const b = polyBounds(pts);
  const cased = applyCase(raw, style);
  // The faces in the case the box draws them in, or none (`casedRuns`).
  const runs = rawRuns?.length ? casedRuns(raw, rawRuns, style).runs : null;
  const marginEm = Number.isFinite(Number(style.margin)) ? Math.max(0, Number(style.margin)) : OUTLINE_FIT.margin;
  // The outline's own aspect, for the block to follow: its widest interior
  // over its height, both less the air.
  const ctx = {
    raw,
    text: cased,
    runs,
    rawRuns: runs ? rawRuns : null,
    style: { ...style },
    ref,
    fit: region,
    pts,
    cx,
    cy,
    lk,
    box,
    words: wordsOf(cased),
    lh: style.lineHeight > 0 ? style.lineHeight : 1,
    marginEm,
    height: b.h,
    minOrphan: style.minOrphan ?? 3,
    round: region.kind !== 'rect' && !isRectOutline(pts),
    hyphenate: style.hyphenate !== false,
    ti: textInset(style),
    minW: Number(opts.minW) > 0 ? Number(opts.minW) : 0,
    minH: Number(opts.minH) > 0 ? Number(opts.minH) : 0,
    fixedLines: null,
    trace: Array.isArray(opts.trace) ? opts.trace : null,
  };
  if (!ctx.words.length) return null;
  const widestRoom = Math.max(0, ...Array.from({ length: 24 }, (_, i) => {
    const y = b.y + ((i + 0.5) * b.h) / 24;
    const r = roomOver(pts, y - 0.5, y + 0.5);
    return r ? r[1] - r[0] : 0;
  }));
  ctx.aspect = (widestRoom - 2 * marginEm * ref) / Math.max(1, b.h - 2 * marginEm * ref);
  // Held lines are the ones the box draws now, at the size it stands at.
  if (lk.breaks && opts.breaks) ctx.fixedLines = brokenLines(cased, style, style.size, opts.breaks, runs);
  const step = OUTLINE_FIT.step;
  const floor = lk.size ? ref : Math.min(ref, Math.max(step, upToGrid(Number(opts.minSize) || 0, step)));
  const sizes = [];
  for (let v = ref; v >= floor - 1e-9; v = downToGrid(v - step, step)) sizes.push(Math.round(v * 2) / 2);
  if (!sizes.length) sizes.push(ref);

  // The passes, strictest first: the air asked for and no hyphens; then
  // hyphens; then the tight margin. Within a pass every size is scored and the
  // best block wins - a smaller size only when it buys more shape than it
  // costs - stopping once the size alone costs more than the best found.
  // The rooms leave the tight margin, and the score prices the air short of
  // the good one - so a size kept costs some air before it costs a size.
  const tight = Math.min(marginEm, OUTLINE_FIT.tight);
  ctx.goodEm = marginEm;
  // Hyphens only where the box allows them (its "Hyphenate long words").
  const passes = [
    { margin: tight, hyphens: false },
    ...(ctx.hyphenate ? [{ margin: tight, hyphens: true }] : []),
  ];
  for (const pass of passes) {
    ctx.marginEm = pass.margin;
    const all = [];
    let best = Infinity;
    for (const size of sizes) {
      if ((W.size * (ref - size)) / ref > best) break;
      const got = candidatesAt(ctx, size, { hyphens: pass.hyphens });
      for (const g of got) {
        all.push(g);
        best = Math.min(best, g.score);
      }
    }
    const c = firstThatHolds(ctx, all, pass.margin);
    if (c) {
      const status = c.style.size < ref ? 'shrunk' : 'ok';
      return result(c, status);
    }
  }

  // Nothing holds: the floor size, every line priced for how far past its room
  // it is, flagged.
  ctx.marginEm = tight;
  const soft = candidatesAt(ctx, sizes[sizes.length - 1], { soft: true, hyphens: ctx.hyphenate });
  soft.sort((a, z) => a.score - z.score);
  for (const cand of soft) {
    const c = boxFor(ctx, cand);
    if (c) return result(c, 'overflow', [REVIEW_REASONS.minSize]);
  }
  return null;
}
