import { defineTool, ToolError, nearest } from '../registry.js';
import { untrusted } from '../fence.js';
import { snapshot } from '../snapshot.svelte.js';
import {
  guide, DASH_RULES, ELLIPSIS_RULES, SERIES_TYPESET_KEYS,
  sanitizeGuide, sanitizeSeriesTypeset, setGuideRule, setGuideNotes,
  setSeriesTypeset, addTerm, updateTerm, removeTerm,
} from '../../guide.svelte.js';
import { sanitizeTerm } from '../../glossary.js';
import { typesetDefaults } from '../../prefs.svelte.js';

const object = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const has = (v, key) => Object.hasOwn(v, key);
const termFields = {
  source: { type: 'string' }, target: { type: 'string' },
  aliases: { type: 'array', items: { type: 'string' } },
  note: { type: 'string' }, locked: { type: 'boolean' }, character: { type: 'boolean' },
  tag: { anyOf: [{ type: 'string' }, { type: 'null' }] },
};
const typesetFields = Object.fromEntries(Object.entries(SERIES_TYPESET_KEYS).map(([key, kind]) => [key,
  kind === 'bool' ? { type: 'boolean' } : typeof kind[0] === 'string'
    ? { enum: [...kind] } : { type: 'integer', minimum: kind[0], maximum: kind[1] },
]));
const keys = ['action', 'rules', 'notes', 'typeset', 'addTerms', 'updateTerms', 'removeTerms'];

function validateKeys(value, allowed, label) {
  if (!object(value)) throw new ToolError(`${label} must be an object.`, `Allowed keys: ${allowed.join(', ')}.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ToolError(`Unknown ${label} key "${key}".`, `Close keys: ${nearest(key, allowed).join(', ')}. Allowed: ${allowed.join(', ')}.`);
  }
}

function validateTerm(fields, existing = null) {
  validateKeys(fields, existing ? ['id', ...Object.keys(termFields)] : Object.keys(termFields), 'term');
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'id') continue;
    const valid = key === 'aliases' ? Array.isArray(value) && value.every((v) => typeof v === 'string')
      : key === 'locked' || key === 'character' ? typeof value === 'boolean'
        : key === 'tag' ? value === null || typeof value === 'string' : typeof value === 'string';
    if (!valid) throw new ToolError(`Invalid term ${key}.`, key === 'aliases' ? 'Use an array of source spelling strings.' : key === 'locked' || key === 'character' ? 'Use true or false.' : `Use a string${key === 'tag' ? ' or null' : ''}.`);
  }
  const clean = sanitizeTerm({ ...(existing ?? {}), ...fields, id: existing?.id ?? 'pending' });
  if (!clean) throw new ToolError('A term needs source or target text.', 'Supply a non-empty source or target; use removeTerms to delete a term.');
  return clean;
}

const fencedTerm = (term) => ({
  ...term, source: untrusted(term.source), target: untrusted(term.target),
  aliases: term.aliases.map((alias) => untrusted(alias)), note: untrusted(term.note),
});
function readGuide() {
  const g = snapshot(guide);
  const glossary = g.glossary.map(fencedTerm);
  return { ...g, glossary, characters: g.glossary.filter((t) => t.character).map(fencedTerm), notes: untrusted(g.notes), typesetDefaults: typesetDefaults() };
}

defineTool({
  name: 'guide',
  write: true,
  description: 'Read or update the whole series guide: glossary terms, characters (terms marked character), dash/ellipsis rules, notes and series typesetting defaults. Ask the user before changing the guide unless they said to remember something. Locked terms cannot be changed or removed. get fences source/target text, aliases and notes. set accepts partial rules/typeset, notes, addTerms, updateTerms by id and removeTerms ids. Validate the entire request before one writeGuide call; unknown ids/keys/values return hints. Term text is trimmed and capped by the glossary sanitizer; notes are capped at 20000 characters. typeset is merged with existing series overrides; typesetDefaults reports the effective defaults for new boxes.',
  input: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { enum: ['get', 'set'] },
      rules: { type: 'object', additionalProperties: false, properties: { dashes: { enum: DASH_RULES }, ellipsis: { enum: ELLIPSIS_RULES } } },
      notes: { type: 'string' },
      typeset: { type: 'object', additionalProperties: false, properties: typesetFields },
      addTerms: { type: 'array', items: { type: 'object', additionalProperties: false, properties: termFields } },
      updateTerms: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1 }, ...termFields } } },
      removeTerms: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
    },
  },
  run(args, ctx) {
    validateKeys(args, keys, 'guide');
    if (!['get', 'set'].includes(args.action)) throw new ToolError('Invalid guide action.', `Use get or set. Close: ${nearest(args.action, ['get', 'set']).join(', ')}.`);
    if (args.action === 'get') {
      if (Object.keys(args).some((key) => key !== 'action')) throw new ToolError('Guide get accepts only action.', 'Use action: "set" to change guide fields.');
      return readGuide();
    }
    if (has(args, 'rules')) {
      validateKeys(args.rules, ['dashes', 'ellipsis'], 'rules');
      for (const [key, value] of Object.entries(args.rules)) {
        const allowed = key === 'dashes' ? DASH_RULES : ELLIPSIS_RULES;
        if (!allowed.includes(value)) throw new ToolError(`Invalid ${key} rule.`, `Use ${allowed.join(', ')}. Close: ${nearest(value, allowed).join(', ')}.`);
      }
    }
    if (has(args, 'notes') && typeof args.notes !== 'string') throw new ToolError('Guide notes must be a string.', 'Use notes: "text", or an empty string to clear notes.');
    let typeset;
    if (has(args, 'typeset')) {
      validateKeys(args.typeset, Object.keys(SERIES_TYPESET_KEYS), 'typeset');
      for (const [key, value] of Object.entries(args.typeset)) {
        const schema = typesetFields[key];
        if (schema.enum ? !schema.enum.includes(value) : schema.type === 'boolean' ? typeof value !== 'boolean' : !Number.isInteger(value) || value < schema.minimum || value > schema.maximum) {
          throw new ToolError(`Invalid typeset ${key}.`, schema.enum ? `Use ${schema.enum.join(', ')}. Close: ${nearest(value, schema.enum).join(', ')}.` : schema.type === 'boolean' ? 'Use true or false.' : `Use an integer from ${schema.minimum} to ${schema.maximum}.`);
        }
      }
      typeset = sanitizeSeriesTypeset(args.typeset);
    }
    for (const key of ['addTerms', 'updateTerms', 'removeTerms']) {
      if (has(args, key) && !Array.isArray(args[key])) throw new ToolError(`${key} must be an array.`, key === 'removeTerms' ? 'Use removeTerms: ["term-id"].' : `Use ${key}: [{ ${key === 'updateTerms' ? 'id: "term-id", ' : ''}target: "name" }].`);
    }
    const terms = new Map(snapshot(guide.glossary).map((term) => [term.id, term]));
    const touched = new Set();
    const existing = (id) => {
      if (typeof id !== 'string' || !terms.has(id)) throw new ToolError('Unknown glossary term id.', `Nearest ids: ${nearest(id, [...terms.keys()]).join(', ') || '(no terms)'}. Use guide get to read term ids.`);
      if (touched.has(id)) throw new ToolError('A term may be updated or removed only once per call.', 'Combine its changes in one updateTerms entry; do not also remove it.');
      touched.add(id);
      // A locked term is the user's: no AI edit changes or removes it.
      if (terms.get(id).locked) throw new ToolError(`Term ${id} is locked by the user.`, 'Leave it as it is, or ask the user to unlock it.');
      return terms.get(id);
    };
    const additions = (args.addTerms ?? []).map((fields) => validateTerm(fields));
    const updates = (args.updateTerms ?? []).map((fields) => {
      if (!object(fields)) throw new ToolError('Each term update must be an object.', 'Use updateTerms: [{ id: "term-id", target: "name" }].');
      return validateTerm(fields, existing(fields.id));
    });
    const removals = (args.removeTerms ?? []).map((id) => { existing(id); return id; });
    const notes = has(args, 'notes') ? sanitizeGuide({ notes: args.notes }).notes : undefined;
    ctx.writeGuide(() => {
      for (const [key, value] of Object.entries(args.rules ?? {})) setGuideRule(key, value);
      if (notes !== undefined) setGuideNotes(notes);
      if (typeset) setSeriesTypeset(typeset);
      for (const term of additions) addTerm(term);
      for (const term of updates) updateTerm(term.id, term);
      for (const id of removals) removeTerm(id);
    });
    return readGuide();
  },
});
