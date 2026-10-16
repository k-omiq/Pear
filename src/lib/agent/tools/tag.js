// ===== tag: a tag's defaults, written =====
// What a line tag gives the boxes placed from it (tags.svelte.js): a style
// patch, the size aimed for and the least size. Series-wide, like the Settings
// form that edits them; boxes already placed keep their own styles.

import { defineTool, ToolError, nearest } from '../registry.js';
import { validateStylePatch } from '../style-schema.js';
import { snapshot } from '../snapshot.svelte.js';
import { app, allFonts } from '../../store.svelte.js';
import { normalizeTagName, findTag, saveTagDefaults, TAG_STYLE_KEYS, knownTags } from '../../tags.svelte.js';

const SIZE = { type: ['number', 'null'], minimum: 4, maximum: 300 };
const okSize = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 4 && v <= 300);

defineTool({
  name: 'tag',
  write: true,
  description:
    'Set a line tag\'s defaults for boxes placed from it from now on: style (a style patch of lettering keys: font, bold, colour, strokes and the like; not size, layout or geometry), ' +
    'size (the size its boxes aim for, px) and minSize (the least they shrink to). null clears one. Series-wide; boxes already placed keep their own style ' +
    '(use edit with where: { tags: [...] } for those). A new name joins the registry. Returns the tag as stored.',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: { name: { type: 'string' }, style: { type: ['object', 'null'] }, size: SIZE, minSize: SIZE },
  },
  run({ name, style, size, minSize } = {}, ctx) {
    const n = normalizeTagName(name);
    if (!n) throw new ToolError(`"${name}" is not a tag name`, 'letters, digits and dashes, up to 24.');
    if (style === undefined && size === undefined && minSize === undefined) throw new ToolError('nothing to set', 'give style, size or minSize.');
    const patch = {};
    if (style !== undefined) {
      if (style !== null) {
        if (typeof style !== 'object' || Array.isArray(style)) throw new ToolError('style must be a style patch object or null');
        const bad = Object.keys(style).find((k) => !TAG_STYLE_KEYS.includes(k));
        if (bad) throw new ToolError(`style.${bad}: not a tag key`, `a tag holds lettering only. Close: ${nearest(bad, TAG_STYLE_KEYS).join(', ')}. Size is its own field.`);
        const e = validateStylePatch(style)[0];
        if (e) throw new ToolError(`style.${e.path}: ${e.error}`, e.hint);
        if (Object.values(style).some((v) => typeof v === 'string' && /^[+\-*]\d/.test(v.trim()))) throw new ToolError('a tag takes plain values, not relative ones');
        if (typeof style.font === 'string') {
          const names = [...new Set(allFonts().map((f) => f.name))];
          const hit = names.find((f) => f === style.font) ?? names.find((f) => f.toLowerCase() === style.font.toLowerCase());
          if (!hit) throw new ToolError(`no font "${style.font}"`, `close: ${nearest(style.font, names).join(', ') || '(none)'}.`);
          style = { ...style, font: hit };
        }
      }
      patch.style = style ?? {};
    }
    for (const [k, v] of [['size', size], ['minSize', minSize]]) {
      if (v === undefined) continue;
      if (!okSize(v)) throw new ToolError(`${k} must be a size in px, 4 to 300, or null`);
      patch[k] = v;
    }
    const minOf = patch.minSize !== undefined ? patch.minSize : findTag(n)?.minSize;
    const sizeOf = patch.size !== undefined ? patch.size : findTag(n)?.size;
    if (minOf != null && sizeOf != null && minOf > sizeOf) throw new ToolError('minSize is above size', 'the least size is at most the size aimed for.');
    ctx?.guard?.();
    // Merged over what the tag holds, so a font set today keeps yesterday's colour.
    if (patch.style && Object.keys(patch.style).length) patch.style = { ...(findTag(n)?.style ?? {}), ...patch.style };
    saveTagDefaults(n, patch);
    const t = knownTags(app.pages).find((x) => x.name === n) ?? findTag(n);
    return { tag: snapshot(t) };
  },
});
