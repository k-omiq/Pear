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
  if (!t || !rules) return t;
  if (rules.dashes === 'ascii') t = t.replace(DASHES, '-');
  if (rules.dashes === 'em') t = t.replace(DOUBLE_HYPHEN, EM).replace(SPACED_HYPHEN, `$1${EM}`);
  if (rules.ellipsis === 'dots') t = t.replace(SPACED_DOTS, '...').replace(ELLIPSIS_CHAR, (c) => (c === '‥' ? '..' : '...'));
  if (rules.ellipsis === 'char') t = t.replace(SPACED_DOTS, '…').replace(THREE_DOTS, '…');
  return t;
}
