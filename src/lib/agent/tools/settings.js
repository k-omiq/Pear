import { defineTool, ToolError, nearest } from '../registry.js';
import { prefs, setPref } from '../../prefs.svelte.js';
import { SERIES_TYPESET_KEYS } from '../../guide.svelte.js';

// Only the five new-box defaults shown by Settings' typesetting controls.
// In particular textEngine can relayout a chapter, and is not exposed here.
const allowed = Object.fromEntries(Object.entries(SERIES_TYPESET_KEYS).map(([key, kind]) => [key,
  kind === 'bool' ? { type: 'boolean' } : typeof kind[0] === 'string'
    ? { enum: [...kind] } : { type: 'integer', minimum: kind[0], maximum: kind[1] },
]));
const object = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const read = () => ({
  values: Object.fromEntries(Object.keys(allowed).map((key) => [key, prefs[key]])),
  allowed: Object.fromEntries(Object.entries(allowed).map(([key, schema]) => [key, { ...schema, ...(schema.enum ? { enum: [...schema.enum] } : {}) }])),
});

defineTool({
  name: 'settings',
  write: true,
  description: 'Read or set the person’s app preferences for new text boxes: auto height, hyphenation, balloon fit, block shape and minimum orphan length. get returns values and allowed types/enums/ranges. set validates the entire values patch before applying it. These preferences persist locally, apply to future boxes and may be overridden by the series guide. Use guide for series defaults. This tool writes no chapter files and exposes no other app preferences.',
  input: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { enum: ['get', 'set'] },
      values: { type: 'object', additionalProperties: false, properties: allowed },
    },
  },
  run(args, ctx) {
    for (const key of Object.keys(args)) {
      if (!['action', 'values'].includes(key)) throw new ToolError(`Unknown settings argument "${key}".`, `Close keys: ${nearest(key, ['action', 'values']).join(', ')}.`);
    }
    const { action, values } = args;
    if (!['get', 'set'].includes(action)) throw new ToolError('Invalid settings action.', `Use get or set. Close: ${nearest(action, ['get', 'set']).join(', ')}.`);
    if (action === 'get') {
      if (values !== undefined) throw new ToolError('values is only accepted for settings set.', 'Use { action: "get" } or { action: "set", values: { defaultAutoHeight: true } }.');
      return read();
    }
    if (!object(values)) throw new ToolError('settings set needs a values object.', `Choose keys: ${Object.keys(allowed).join(', ')}.`);
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(allowed, key)) throw new ToolError(`Unknown typesetting setting "${key}".`, `Close keys: ${nearest(key, Object.keys(allowed)).join(', ')}. Allowed: ${Object.keys(allowed).join(', ')}.`);
      const schema = allowed[key];
      if (schema.enum ? !schema.enum.includes(value) : schema.type === 'boolean' ? typeof value !== 'boolean' : !Number.isInteger(value) || value < schema.minimum || value > schema.maximum) {
        const hint = schema.enum ? `Use ${schema.enum.join(', ')}. Close: ${nearest(value, schema.enum).join(', ')}.` : schema.type === 'boolean' ? 'Use true or false.' : `Use an integer from ${schema.minimum} to ${schema.maximum}.`;
        throw new ToolError(`Invalid value for ${key}.`, hint);
      }
    }
    ctx?.guard?.();
    for (const [key, value] of Object.entries(values)) setPref(key, value);
    return read();
  },
});
