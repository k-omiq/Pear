// ===== Lettering checks: the series' style, per box =====
// Two faults the agent's `check` reports beside the fit numbers, both ones a
// human letterer makes and a reader notices at once:
//
//   role      the box is not in the font its role or its speaker's voice gives
//             it (lettering.js): a narration box in the dialogue face, a
//             character who drifts into another font halfway down the page.
//             Sound effects are left out - each one is drawn to its own sound
//             and may take any face - and so is a box with no font to want.
//   contrast  the text's fill is the same tone as the inside of its balloon:
//             black on a black balloon, white on white, with no outline of the
//             other tone to carry it.
//   turn      a drawn sound, title or blocky word turned past MAX_TURN: English
//             stood on end to follow a Japanese column, which the reader has to
//             turn their head to read (footprint.js).
//   emphasis  the original letters the line far bigger than the rest of its
//             kind - a dramatic one-liner, a cry in big heavy strokes - and ours
//             sits at its kind's usual size, so the moment reads flat.
//
// Pure: the caller hands in what the box's tags want and what its balloon's
// inside is, so the rules can be tested without a store.

import { ART_SIZED_ROLES } from '../lettering.js';
import { MAX_TURN } from './footprint.js';

// Tags whose boxes are drawn sounds, never held to a font.
export const FREE_FONT_TAGS = ['sfx', 'sfx-sharp', 'sfx-soft'];

// A turn in degrees, kept to (-180, 180].
const turnOf = (deg) => {
  const a = (((Number(deg) || 0) % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
};

// WCAG relative luminance of a #rgb / #rrggbb colour (alpha ignored), or null.
export function luminance(hex) {
  const m = /^#([0-9a-f]{3,8})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const ch = (i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}

// The tone the reader sees as the text's body: its fill, or the gradient's
// stops averaged, or - for hollow letters - the innermost outline.
function bodyLuminance(style) {
  if (style.noFill) return luminance(style.strokes?.[0]?.color);
  if (style.gradient?.on && style.gradient.stops?.length) {
    const ls = style.gradient.stops.map((s) => luminance(s.color)).filter((l) => l != null);
    return ls.length ? ls.reduce((a, b) => a + b, 0) / ls.length : null;
  }
  if (style.pattern?.on) return null;
  return luminance(style.color);
}

// The original stresses a line when its letters are this many times its
// kind's usual size; ours answers when it is a third of the way there.
export const EMPHASIS = 1.6;
const tenth = (v) => Math.round(v * 10) / 10;

// `original` the line's detected letter size over its tag's usual one in the
// chapter, `ours` the box's size over its tag's usual one. An issue or null.
export function emphasisIssue(original, ours, tag) {
  if (!(original >= EMPHASIS) || !(ours > 0) || ours >= 1 + (original - 1) / 3) return null;
  return { kind: 'emphasis', detail: { original: tenth(original), ours: tenth(ours), tag } };
}

// `box` the box, `want` { font, tag } its tags resolve to (or null), `tags`
// its line's tags, `ink` '#000000' | '#ffffff' the text colour its balloon
// asks for (or null when unknown). Returns check issues.
export function letteringIssues(box, { want = null, tags = [], ink = null } = {}) {
  const out = [];
  const s = box?.style;
  if (!s) return out;
  if (want?.font && s.font && want.font !== s.font && !tags.some((t) => FREE_FONT_TAGS.includes(t))) {
    out.push({ kind: 'role', detail: { want: want.font, have: s.font, tag: want.tag } });
  }
  if (ink && box.fit && s.balloon !== false) {
    const body = bodyLuminance(s);
    const inside = ink === '#ffffff' ? 0 : 1; // white ink means a dark inside
    if (body != null && Math.abs(body - inside) < 0.35) {
      // An outline of the other tone, wide enough to read, carries the text.
      const carried = (s.strokes ?? []).some((k) => k.width >= 2 && (k.opacity ?? 1) > 0.5 && Math.abs((luminance(k.color) ?? inside) - inside) >= 0.5);
      if (!carried) out.push({ kind: 'contrast', detail: { fill: s.noFill ? s.strokes?.[0]?.color : s.color, balloon: ink === '#ffffff' ? 'dark' : 'light' } });
    }
  }
  const turn = turnOf(s.rotation);
  if (Math.abs(turn) > MAX_TURN && tags.some((t) => ART_SIZED_ROLES.includes(t))) {
    out.push({ kind: 'turn', detail: { rotation: Math.round(turn), max: MAX_TURN } });
  }
  return out;
}
