// ===== The series' text rules (TXT-3) =====
// Dashes and ellipses, each a choice the series makes in its guide
// (`guide.rules`, see guide.svelte.js) rather than a rule hard-coded for
// everyone: one scanlation group wants "--" gone, another wants no em dash at
// all. `keep` checks nothing. Pure, so the check list and (later) the agent's
// `apply_guide` share one reading of the rules.
//
// The fix is the same rules run forwards, so a line that `ruleBreaks` flags is
// a line `applyTextRules` changes, and a line it does not flag is left exactly
// as it was.

const EM = '—';
const DASHES = /[—–―⸺]/g; // em, en, horizontal bar, two-em
const SPACED_HYPHEN = /(\S) +[-–] +(?=\S)/g; // "wait - no" / "wait – no"
const DOUBLE_HYPHEN = /--+/g;
const ELLIPSIS_CHAR = /[…‥]/g; // … and ‥
const SPACED_DOTS = /\.(?: \.){2,}/g; // ". . ."
const THREE_DOTS = /\.{3,}/g;

// The breaks in `text`, in words a check list can show, or [] when it keeps
// every rule.
export function ruleBreaks(text, rules) {
  const t = String(text ?? '');
  const out = [];
  if (!t || !rules) return out;
  if (rules.dashes === 'ascii' && /[—–―⸺]/.test(t)) out.push('Long dash: use -');
  if (rules.dashes === 'em' && (/--/.test(t) || /\S +[-–] +\S/.test(t))) out.push(`Dash: use ${EM}`);
  if (rules.ellipsis === 'dots' && (/[…‥]/.test(t) || /\.(?: \.){2,}/.test(t))) out.push('Ellipsis: use ...');
  if (rules.ellipsis === 'char' && (/\.{3,}/.test(t) || /\.(?: \.){2,}/.test(t))) out.push('Ellipsis: use …');
  return out;
}

// `text` with every rule applied.
export function applyTextRules(text, rules) {
  let t = String(text ?? '');
  for (const e of textRuleEdits(t, rules)) t = t.slice(0, e.span[0]) + e.put + t.slice(e.span[1]);
  return t;
}

// The same rules as the edits they make, one per match, in the order to make
// them: `[{ span: [a, b], put }]`, each `span` a range of the text as the
// edits before it left it. So a caller that keeps something beside the text
// by offset - the faces of its words (runs.js) - can carry it through each
// change exactly, rather than through one guess at the whole difference,
// which loses everything between the first change and the last.
//
// Each rule is the pattern it always was, run over the text as the rules
// before it left it; its matches are made from the last to the first, so the
// offsets of the ones still to make hold. A spaced hyphen keeps the letter in
// front of it: only the spaces and the hyphen are replaced.
export function textRuleEdits(text, rules) {
  let t = String(text ?? '');
  const out = [];
  if (!t || !rules) return out;
  const step = (re, put) => {
    const found = [];
    for (const m of t.matchAll(re)) found.push(put(m));
    for (const e of found.reverse()) {
      t = t.slice(0, e.span[0]) + e.put + t.slice(e.span[1]);
      out.push(e);
    }
  };
  const whole = (to) => (m) => ({ span: [m.index, m.index + m[0].length], put: typeof to === 'function' ? to(m[0]) : to });
  if (rules.dashes === 'ascii') step(DASHES, whole('-'));
  if (rules.dashes === 'em') {
    step(DOUBLE_HYPHEN, whole(EM));
    step(SPACED_HYPHEN, (m) => ({ span: [m.index + m[1].length, m.index + m[0].length], put: EM }));
  }
  if (rules.ellipsis === 'dots') {
    step(SPACED_DOTS, whole('...'));
    step(ELLIPSIS_CHAR, whole((c) => (c === '‥' ? '..' : '...')));
  }
  if (rules.ellipsis === 'char') {
    step(SPACED_DOTS, whole('…'));
    step(THREE_DOTS, whole('…'));
  }
  return out;
}
