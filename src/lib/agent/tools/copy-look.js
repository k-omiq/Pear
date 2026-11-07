// ===== copy_look: another chapter's look, by tag =====
// "Letter it like chapter 14": the look each tag's boxes have there - font,
// weight, colours, outlines, shadows, case, spacing and the size they aim
// for, the most common of each - read off that chapter's saved record, and,
// with apply, laid on this chapter's boxes of the same tags. One edit per
// page, through the store like any other, so the user can undo it.

import { defineTool, ToolError, nearest } from '../registry.js';
import { untrusted } from '../fence.js';
import { selectBoxes } from '../select.js';
import { validateStylePatch } from '../style-schema.js';
import { applyStylePatch } from '../../style-patch.js';
import { app, allFonts, cloneStyle, editBoxes, isTranslateMode } from '../../store.svelte.js';
import { projectById, chapterById, readChapterRecord } from '../../library.svelte.js';
import { lineTags, knownTags } from '../../tags.svelte.js';
import { normalizeAuto } from '../../data.js';
import { parseChapterKey, chapterKey } from '../windows.js';
import { solverOwns, reportOf } from './edit.js';

// What a look is. Not the place, the turn, the warp or the path (a box's own),
// nor SFX lettering (per sound: sfx_kinds), nor the margin and balloon fit
// (how it is laid out, not how it looks).
export const LOOK_KEYS = ['font', 'bold', 'italic', 'boldWeight', 'italicAngle', 'color', 'noFill', 'strokes', 'shadows', 'gradient', 'uppercase', 'lineHeight', 'letterSpacing', 'strokeOrder', 'strokeJoin'];

const median = (vs) => {
  const s = vs.filter((v) => v > 0).sort((a, z) => a - z);
  return s.length ? s[s.length >> 1] : null;
};
function commonest(values) {
  const n = new Map();
  for (const v of values) {
    const k = JSON.stringify(v ?? null);
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  let best = null;
  let most = 0;
  for (const [k, c] of n) if (c > most) [best, most] = [k, c];
  return best == null ? undefined : JSON.parse(best);
}

// Each tag's look across `pages` (a chapter record's): [{ tag, boxes, size,
// style, sfxKinds? }], the tag being a line's first, the one its style is
// read from. A gradient only when the look has one on.
export function looksOf(pages) {
  const by = new Map();
  for (const p of pages ?? []) {
    const lines = new Map((p.lines ?? []).map((l) => [l.n, l]));
    for (const b of p.boxes ?? []) {
      const line = b.lineN != null ? lines.get(b.lineN) : null;
      const tag = line ? lineTags(line)[0] : null;
      if (!tag || !b.style) continue;
      if (!by.has(tag)) by.set(tag, []);
      by.get(tag).push(b);
    }
  }
  return [...by].map(([tag, boxes]) => {
    const style = {};
    for (const k of LOOK_KEYS) {
      const v = commonest(boxes.map((b) => b.style[k]));
      if (v === undefined || v === null) continue;
      if (k === 'gradient' && !v?.on) continue;
      style[k] = v;
    }
    const sounds = boxes.filter((b) => b.style.sfx?.on && b.style.sfx.kind).map((b) => b.style.sfx.kind);
    return {
      tag,
      boxes: boxes.length,
      size: median(boxes.map((b) => b.auto?.refSize ?? b.style.size)),
      style,
      ...(sounds.length ? { sfxKinds: [...new Set(sounds)] } : null),
    };
  });
}

// The chapter `from` names: a key ("projectId/chapterId"), or a chapter
// number in this chapter's series ("14").
function sourceOf(from) {
  const here = app.chapterRef;
  const s = String(from ?? '').trim();
  let ref = parseChapterKey(s);
  if (!ref && /^\d+(\.\d+)?$/.test(s) && here) {
    const c = (projectById(here.projectId)?.chapters ?? []).find((ch) => Number(ch.number) === Number(s) && !ch.duplicate);
    if (c) ref = { projectId: here.projectId, chapterId: c.id };
  }
  const c = ref ? chapterById(ref.projectId, ref.chapterId) : null;
  if (!c) {
    const nums = (projectById(here?.projectId)?.chapters ?? []).map((ch) => String(ch.number));
    throw new ToolError(`no chapter "${s}"`, `a chapter key from chapters, or a chapter number of this series: ${nums.slice(0, 20).join(', ') || '(none)'}.`);
  }
  if (here && ref.projectId === here.projectId && ref.chapterId === here.chapterId) throw new ToolError('that is this chapter', 'name another chapter to copy its look from.');
  if (c.unreadable) throw new ToolError(`chapter "${s}" could not be read`);
  return { ...ref, key: chapterKey(ref.projectId, ref.chapterId) };
}

// The part of `style` that is a valid patch here: a font this machine has
// (else left out, and said), each other key only when it passes the schema.
function patchFor(style, skipped, tag) {
  const out = {};
  const names = [...new Set(allFonts().map((f) => f.name))];
  for (const [k, v] of Object.entries(style)) {
    if (k === 'font') {
      const hit = names.find((n) => n.toLowerCase() === String(v).toLowerCase());
      if (!hit) {
        skipped.push({ tag, key: 'font', value: untrusted(String(v)), why: `not on this machine; close: ${nearest(String(v), names).join(', ')}` });
        continue;
      }
      out.font = hit;
      continue;
    }
    if (validateStylePatch({ [k]: v }).length) skipped.push({ tag, key: k, why: 'not a value this app takes' });
    else out[k] = v;
  }
  return out;
}

defineTool({
  name: 'copy_look',
  description:
    'Copy another chapter\'s look, by tag ("letter it like chapter 14"). from: a chapter key (chapters lists them) or a chapter number of this series ("14"). ' +
    'Reads that chapter\'s saved boxes and returns, per tag (a line\'s first tag), the look its boxes share - the most common font, bold, italic, colour, fill, outlines (strokes), shadows, gradient, case, line height and spacing - as a style patch, the size they aim for (the median), and the sound types its SFX used (sfxKinds: apply them with edit do "sfx_kind:<id>"). ' +
    'tags limits it to these tags. apply: true also lays each look on this chapter\'s boxes of the same tag (the size as the size each aims for), laid out again by the solver; one undo step per page; a font this machine lacks is left out and named in skipped. ' +
    'It copies looks, not places, turns or SFX layouts. To make a look the default for new boxes too, save it on the tag with the tag tool. compact as edit.',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['from'],
    properties: {
      from: { type: 'string', minLength: 1 },
      tags: { type: 'array', items: { type: 'string', minLength: 1 } },
      apply: { type: 'boolean' },
      compact: { type: 'boolean' },
    },
  },
  write: true,
  async run({ from, tags, apply = false, compact = false }, ctx) {
    const src = sourceOf(from);
    let record;
    try {
      record = await readChapterRecord(src.projectId, src.chapterId);
    } catch (err) {
      throw new ToolError(`could not read chapter "${src.key}": ${err?.message ?? err}`, 'it may be open in this window, or busy; try again in a moment.');
    }
    let looks = looksOf(record?.pages);
    if (Array.isArray(tags) && tags.length) {
      const want = new Set(tags);
      looks = looks.filter((l) => want.has(l.tag));
    }
    const here = new Set(knownTags(app.pages).map((t) => t.name));
    const shown = looks.map((l) => ({ ...l, ...(here.has(l.tag) ? null : { notHere: true }) }));
    if (!apply) return { from: src.key, looks: shown };
    if (isTranslateMode()) throw new ToolError('this chapter is in translate mode and has no boxes to letter');
    if (!ctx.stillPinned()) throw new ToolError('the chapter changed in the app, so nothing was changed');

    const skipped = [];
    const plan = [];
    for (const l of looks) {
      if (!here.has(l.tag)) continue;
      const matches = selectBoxes({ pages: 'all', tag: l.tag }).matches;
      if (!matches.length) continue;
      plan.push({ ...l, patch: patchFor(l.style, skipped, l.tag), matches });
    }
    const pages = [...new Set(plan.flatMap((t) => t.matches.map((m) => m.page)))];
    const applied = [];
    const ids = new Set();
    if (pages.length) {
      ctx.write(pages, () => {
        for (const t of plan) {
          const changed = editBoxes(
            t.matches.map((m) => ({ page: m.page, box: m.box })),
            (b) => {
              const { style, errors } = applyStylePatch(cloneStyle(b.style), t.patch);
              if (errors.length) return false;
              b.style = style;
              if (t.size > 0) {
                b.style.size = t.size;
                if (!b.auto) b.auto = normalizeAuto({ refSize: t.size });
                b.auto.refSize = t.size;
              }
              solverOwns(b);
            },
            { solve: true },
          );
          for (const c of changed) ids.add(c.box.id);
          applied.push({ tag: t.tag, matched: t.matches.length, changed: changed.length });
        }
      });
    }
    return {
      from: src.key,
      looks: shown,
      applied,
      ...(skipped.length ? { skipped } : null),
      ...reportOf([...ids], { compact }),
    };
  },
});
