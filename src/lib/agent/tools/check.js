import { defineTool } from '../registry.js';
import { selectBoxes } from '../select.js';
import { countedChecks } from '../counted-checks.js';
import { untrusted } from '../fence.js';
import { app, lineByN, boxText, pageCheckItems, reviewOf, withStyleOrder, detectedEntryFor, boxLocked, CHECK_REASONS } from '../../store.svelte.js';
import { fitReport, fitIssues, fitQuality } from '../../fit-report.js';
import { lineTags, findTag, withKinds, tagsOfKinds } from '../../tags.svelte.js';
import { letteringIssues, emphasisIssue } from '../lettering-checks.js';
import { ART_SIZED_ROLES } from '../../lettering.js';
import { contrastInk } from '../../balloon.js';
import { peekPagePixels } from '../../page-pixels.js';
import { fitPolygon, isRectOutline } from '../../outline-geom.js';
import { applyCase, glyphsMissing } from '../../measure.js';
import { farLobe } from '../../bubble-outline.js';
import { readOriginals, sfxColourIssue, uncleanedOn } from './footprint.js';
import { boxLetters } from '../../engine-switch.svelte.js';

// The font a line's tags give its boxes, and the tag it comes from: the same
// order placement reads them in (`withStyleOrder`: the most particular first).
function wantedFont(line) {
  if (!line) return null;
  for (const t of lineTags(withStyleOrder(line))) {
    const font = findTag(t)?.style?.font;
    if (font) return { font, tag: t };
  }
  return null;
}

// The text colour a box's balloon asks for: measured when it was found, else
// read off the page's pixels when they are already in hand (a peek: a check
// walks whole chapters and must not reorder the click cache).
function balloonInk(b, page) {
  if (!b.fit) return null;
  if (b.outline?.ink) return b.outline.ink;
  const image = peekPagePixels(page);
  return image ? contrastInk(image, b.fit) : null;
}

// Check the whole page before projecting onto matches: neighbours and the
// tag-size median must still count when only one box was selected.
export function checksFor(matches) {
  const pages = new Map();
  const usual = usualSizes();
  for (const { page, pageIndex } of matches) {
    if (pages.has(page)) continue;
    const issues = new Map(page.boxes.map((b) => [b.id, []]));
    // The text against its outline, in numbers (fit-report.js), for a box with
    // an outline: what the reader sees, so it speaks for the box's overflow
    // too (an overflow past the box's own rectangle, inside its outline, is
    // no fault, and one past the outline is "outside").
    const reports = new Map(page.boxes.map((b) => [b.id, fitReport(b, boxText(b, page))]));
    for (const item of pageCheckItems(page, pageIndex ?? app.pages.indexOf(page))) {
      const list = issues.get(item.boxId);
      if (!list) continue; // Unplaced lines have no matching box.
      // A solve's record out of date is the app's bookkeeping, not a fault:
      // the fit numbers are the box as drawn.
      if (item.reason === 'stale') continue;
      if (item.reason === 'overflow' && reports.get(item.boxId)) continue;
      const issue = { kind: item.reason };
      if (item.review?.reason) issue.detail = untrusted(item.review.reason);
      if (item.terms) issue.detail = item.terms.map((term) => untrusted(term));
      if (item.breaks) issue.detail = [...item.breaks];
      if (item.font) issue.detail = item.font;
      if (item.confidence != null) issue.detail = { confidence: item.confidence };
      list.push(issue);
    }
    for (const b of page.boxes) {
      const review = reports.get(b.id) ? null : reviewOf(b, page);
      if (review && !issues.get(b.id).some((issue) => issue.kind === 'overflow')) {
        issues.get(b.id).push({ kind: 'overflow', ...(review.reason ? { detail: untrusted(review.reason) } : {}) });
      }
    }
    // The text against its outline, in numbers (fit-report.js): only for a box
    // with an outline, since a box with none has nothing to be inside.
    for (const b of page.boxes) {
      const rep = reports.get(b.id);
      if (rep) issues.get(b.id).push(...fitIssues(rep, { round: roundOutline(b) }));
      // Laid out by outline fit, but Fixed: the solver passes it over.
      if (b.style?.margin != null && (b.style.autoHeight === false || b.style.fitText) && !boxLocked(b)) issues.get(b.id).push({ kind: 'fixed' });
      const far = joinedAt(b, page);
      if (far) issues.get(b.id).push({ kind: 'joined', detail: { far } });
    }
    const counted = countedChecks(page, (b) => lineTags(lineByN(page, b.lineN)), { skip: tagsOfKinds(ART_SIZED_ROLES) });
    for (const { boxId, other, overlap } of counted.collisions) {
      issues.get(boxId).push({ kind: 'collision', with: other, detail: { overlap } });
      issues.get(other).push({ kind: 'collision', with: boxId, detail: { overlap } });
    }
    for (const { boxId, panel } of counted.panels) {
      issues.get(boxId).push({ kind: 'panel', detail: { panel: panel + 1 } });
    }
    for (const { boxId, size, median, tag } of counted.sizes) {
      issues.get(boxId).push({ kind: 'size', detail: { size, median, tag } });
    }
    // The series' lettering style: the font each box's role or voice wants,
    // and text the same tone as its balloon.
    for (const b of page.boxes) {
      const line = lineByN(page, b.lineN);
      issues.get(b.id).push(...letteringIssues(b, { want: wantedFont(line), tags: withKinds(lineTags(line)), ink: balloonInk(b, page) }));
      const stress = emphasisOf(b, page, line, usual);
      if (stress) issues.get(b.id).push(stress);
      const colour = sfxColourIssue(page, b);
      if (colour) issues.get(b.id).push(colour);
    }
    // Letters the box's font has no glyph for: drawn from another font, or as
    // an empty box, wherever they stand.
    for (const b of page.boxes) {
      const glyph = glyphIssue(b, page);
      if (glyph) issues.get(b.id).push(glyph);
    }
    pages.set(page, issues);
  }
  return matches.flatMap(({ page, pageIndex, box }) => {
    const issues = pages.get(page).get(box.id) ?? [];
    return issues.length ? [{ id: box.id, page: (pageIndex ?? app.pages.indexOf(page)) + 1, issues }] : [];
  });
}

// Letters a box's font has no glyph for: { kind: 'glyph', detail: { font,
// letters, from? } } or null. The Rust engine says what each is drawn from
// (`boxLetters`, as the app's font notice reads it: from, a family that lends
// it; none, no font on this machine has it); with no answer from it - another
// engine, or a face still on its way - the face's own coverage is asked.
const chars = (cps) => cps.map((c) => String.fromCodePoint(c));
function glyphIssue(b, page) {
  if (!b.style) return null;
  const l = boxLetters(b, page);
  const from = l.borrowed.filter((g) => g.letters.length).map((g) => ({ letters: chars(g.letters), ...(g.family ? { font: g.family } : null) }));
  const none = [...l.none, ...l.unread.flatMap((g) => g.letters)];
  if (from.length || none.length) {
    return { kind: 'glyph', detail: { font: b.style.font, letters: [...new Set([...from.flatMap((g) => g.letters), ...chars(none)])], ...(from.length ? { from } : null), ...(none.length ? { none: chars(none) } : null) } };
  }
  const lacking = glyphsMissing(b.style, applyCase(boxText(b, page), b.style));
  return lacking.length ? { kind: 'glyph', detail: { font: b.style.font, letters: chars(lacking) } } : null;
}

// The usual letter size of each tag across the chapter, the original's (each
// line's detected size) and ours (its boxes' sizes), medians. Drawn roles
// are left out: each is sized to its own original. '*' is every tag, for a
// tag with too few lines to have a usual size of its own.
function usualSizes() {
  const original = new Map();
  const ours = new Map();
  const add = (m, tag, v) => {
    if (!(v > 0)) return;
    for (const k of [tag, '*']) (m.get(k) ?? m.set(k, []).get(k)).push(v);
  };
  const kindOf = (line) => {
    const tags = lineTags(line);
    return tags.length && !withKinds(tags).some((t) => ART_SIZED_ROLES.includes(t)) ? tags[0] : null;
  };
  for (const p of app.pages) {
    for (const ln of p.lines ?? []) {
      const tag = kindOf(ln);
      if (tag) add(original, tag, Number(detectedEntryFor(p, ln.n)?.font_size));
    }
    for (const b of p.boxes ?? []) {
      const tag = b.lineN != null ? kindOf(lineByN(p, b.lineN)) : null;
      if (tag) add(ours, tag, b.style?.size);
    }
  }
  const median = (m) => new Map([...m].filter(([, v]) => v.length >= 3).map(([k, v]) => [k, v.sort((a, z) => a - z)[v.length >> 1]]));
  return { original: median(original), ours: median(ours) };
}

// A line the original letters far bigger than its kind, set at its kind's
// usual size here: the `emphasis` issue, or null.
function emphasisOf(b, page, line, usual) {
  const tags = lineTags(line);
  const tag = tags[0];
  if (!tag || withKinds(tags).some((t) => ART_SIZED_ROLES.includes(t)) || !(b.style?.size > 0)) return null;
  const detected = Number(detectedEntryFor(page, line.n)?.font_size);
  const theirs = usual.original.get(tag) ?? usual.original.get('*');
  const mine = usual.ours.get(tag) ?? usual.ours.get('*');
  if (!(detected > 0 && theirs > 0 && mine > 0)) return null;
  return emphasisIssue(detected / theirs, b.style.size / mine, tag);
}

// Whether a box's outline is two bubbles joined at a neck: the point in the
// far one, or null. Kept per outline (a new outline is a new object), as a
// check walks every box on the page after every edit.
const lobes = new WeakMap();
function joinedAt(b, page) {
  if (b.fit?.kind !== 'poly' || isRectOutline(fitPolygon(b.fit))) return null;
  if (!lobes.has(b.fit)) {
    const det = b.lineN != null ? (page.detect?.boxes ?? []).find((d) => d.n === b.lineN && Array.isArray(d.box) && d.box.length === 4) : null;
    const own = det ? det.box : [b.x, b.y, b.x + b.w, b.y + b.h];
    const far = farLobe(fitPolygon(b.fit), own);
    lobes.set(b.fit, far ? far.map(Math.round) : null);
  }
  return lobes.get(b.fit);
}

// A balloon asks for an oval block; a caption frame or a box drawn as its own
// outline - or any outline shaped as a rectangle, which the solver fills as
// one (outline-fit.js) - does not.
const roundOutline = (b) =>
  b.fit?.kind !== 'rect' && !['caption', 'box'].includes(b.outline?.source) && !isRectOutline(fitPolygon(b.fit));

// A box's sizes, named apart, as a reader mixes them up: `size` is what it
// got (after any shrink to fit), `aimedFor` what it aims for (born at, or
// given: `sizing.ref`), and `tagSize` its tag's own default - which a box is
// born at only when nothing else gives it a size (the box of its tag before
// it, a size the user set for the tag, an SFX's original), so it may differ
// from both.
export function sizesOf(b, page) {
  const tag = lineTags(lineByN(page, b.lineN))[0] ?? null;
  const tagSize = tag ? (findTag(tag)?.size ?? null) : null;
  return {
    size: b.style.size,
    ...(b.auto?.refSize > 0 ? { aimedFor: b.auto.refSize } : null),
    ...(tag ? { tag, tagSize } : null),
  };
}

// The fit report, short, for the boxes a write changed: what the agent reads
// before it looks. Boxes with no outline are left out.
export function fitsOf(matches) {
  const out = [];
  for (const { page, box: b } of matches) {
    const rep = fitReport(b, boxText(b, page));
    if (!rep) continue;
    out.push({
      id: b.id,
      quality: fitQuality(rep, { round: roundOutline(b), ref: b.auto?.refSize }),
      ...sizesOf(b, page),
      lines: rep.lines,
      inside: rep.inside,
      ...(rep.overflow ? { overflow: rep.overflow } : null),
      margin: rep.margin.em,
      // What the outline asks of the block (an oval in a balloon, a rectangle
      // in a caption), beside what the lines came out as.
      aim: roundOutline(b) ? 'oval' : 'rect',
      shape: rep.shape.kind,
      ...(rep.shape.oval != null ? { oval: rep.shape.oval } : null),
      widths: rep.rows.map((r) => r[0]),
      room: rep.rows.map((r) => r[1]),
      centre: [rep.centre.dx, rep.centre.dy],
      fill: rep.fill,
    });
  }
  return out;
}

const where = {
  type: 'object', additionalProperties: false,
  properties: {
    pages: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'integer', minimum: 1 } }] },
    ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    selection: { const: true },
    tag: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    text: { type: 'string', description: 'Case-insensitive JavaScript regex over displayed text.' },
    font: { type: 'string' },
    size: { type: 'object', additionalProperties: false, properties: { min: { type: 'number' }, max: { type: 'number' } } },
    flagged: { anyOf: [{ const: true }, { enum: ['guide', ...CHECK_REASONS] }] },
    outline: { enum: ['unapproved', 'open', 'ai', 'user'] },
    kind: { enum: ['text', 'sfx', 'ink'] },
    not: { $ref: '#/$defs/where' },
  },
};

defineTool({
  name: 'check',
  description: 'Check matching boxes for overflow, check-list reasons (including glossary and guide rules; a box with an outline is judged against its outline, so text past it is "outside", not overflow), fixed (laid out by outline fit but set to a Fixed size, so the solver passes it over: do "typeset" hands it back), collisions, panel crossings and tag-size outliers, and, for a box with a bubble outline, its text against that outline: outside (ink past the outline, px per side), tight (air under 0.25 em), hourglass, shape (funnel, pyramid or far from an oval, in a balloon), offcentre (ink centre off the bubble centre, px), hyphen and orphan; role (not in the font its role tag or speaker\'s voice gives it; SFX exempt), contrast (fill the same tone as the balloon\'s inside, with no outline to carry it), turn (an SFX, title or blocky word turned past 35 degrees: English is never stood on end, even over a Japanese column), joined (the outline may hold two bubbles - joined at a neck, or drawn overlapping as a stepped shape; far: a point in the other one - view it with source "compare": where the original\'s text sits in both, the text belongs in both, so split it with the split tool; a neighbour\'s bubble taken in: do "split_outline"), sfx_colour (an SFX or title whose fill or outline is not its original\'s: want is the original\'s colour - its fill, its shade top to bottom, its outline or "none" - got is ours; do "match_original" sets them, or set style.color, gradient and strokes to exactly want), emphasis (the original letters this line far bigger than the rest of its kind - original: times its tag\'s usual size in the chapter, ours: times ours - a dramatic line set flat: give it that weight, rule D) glyph (letters the box\'s font has no glyph for: from names the font each is drawn from instead, none the ones no font has; change the font or the letter, and tell the user) and uncleaned (in the result\'s uncleaned list, per page: a detected line whose original letters the cleaner left on the page, its jp and rect; English over them reads as a mess, so leave it and tell the user it needs cleaning). quality: the mean lettering score (0-100: air, shape, centre, hyphens, orphans, size kept against the size aimed for, fill) of the boxes with outlines and the five weakest, to work on first. Return only boxes with problems, in page/box order, with 1-based pages and panel numbers. where uses the query AND selector; pages accepts current (default), all, "2-5", "1,3" or [1,3]; ids/selection default to all pages. Neighbours on the whole page count even outside the selector. count counts all problem boxes, checked counts all selected boxes; problems is capped at 200 with truncated: true. Free text is fenced.',
  input: {
    type: 'object', additionalProperties: false,
    properties: { where: { $ref: '#/$defs/where' } },
    $defs: { where },
  },
  async run({ where = {} }) {
    const { matches, pages } = selectBoxes(where);
    // The originals the SFX among them are compared with, read off the page
    // images once.
    await readOriginals(matches);
    const problems = checksFor(matches);
    const fits = fitsOf(matches);
    const pageOf = new Map(matches.map((m) => [m.box.id, (m.pageIndex ?? app.pages.indexOf(m.page)) + 1]));
    const quality = fits.length
      ? {
          mean: Math.round(fits.reduce((s, f) => s + f.quality, 0) / fits.length),
          weakest: [...fits].sort((a, z) => a.quality - z.quality).slice(0, 5).map((f) => ({ id: f.id, page: pageOf.get(f.id), quality: f.quality })),
        }
      : null;
    // Lettering the cleaner left, on the pages asked about: no tool here can
    // fix it, so the agent tells the user.
    // A where naming pages scans them all; one naming boxes, their pages.
    const scanned = Object.hasOwn(where, 'pages') ? pages : [...new Set(matches.map((m) => m.page))];
    const uncleaned = [];
    for (const p of scanned) for (const u of await uncleanedOn(p)) uncleaned.push({ page: app.pages.indexOf(p) + 1, ...u });
    return {
      count: problems.length,
      problems: problems.slice(0, 200),
      checked: matches.length,
      ...(quality ? { quality } : {}),
      ...(uncleaned.length ? { uncleaned, uncleanedNote: 'the original letters are still on the cleaned page here: do not letter over them; tell the user these need cleaning' } : {}),
      ...(problems.length > 200 ? { truncated: true } : {}),
    };
  },
});
