// ===== SFX looks: the effects a drawn sound is made with =====
// The effects every engine draws (strokes, hollow letters, shadows, rough
// edges, motion smear), put together the way a letterer puts them together
// for a kind of sound, and scaled to the box's size - so the agent says
// "heavy" or "speed" (edit `do: "sfx_look:<kind>"`) instead of building each
// band and blur by hand. The per-letter `sfx:` recipes need the Rust engine;
// these do not.
//
// A look changes how the letters are drawn, not their colour (soft is the
// one that does: white with a grey outline, rule B's soft sound). Each patch
// gives its lists whole, so a look replaces the bands and shadows the box had.
// Bands, shadows and blurs grow with the size only up to a few px (`upTo`): a
// 220 px GRAB with a 30 px band reads as a sticker, not a sound; the human's
// thickest band in RMS ch1 was 10 px, on a 200 px hollow SQUISH.
// Pure: a style in, a style patch out.

import { luminanceOf } from './palette.js';

export const SFX_LOOKS = ['heavy', 'hollow', 'sharp', 'soft', 'speed', 'shaky', 'impact', 'glow', 'plain'];
export const SFX_LOOK_NOTES = {
  heavy: 'bold with a thick outline of the other tone: a thud, a slam',
  hollow: 'no fill, a thick band in the fill colour: a big outlined sound',
  sharp: 'thin, no outline, a little letter space: a glint, a swish, a twitch',
  soft: 'white with a grey outline and soft rough edges: a cute or gentle sound',
  speed: 'a motion smear along the box\'s turn: a whoosh, a dash',
  shaky: 'rough, trembling edges: a rumble, a shiver',
  impact: 'bold, a double outline and a hard drop shadow: a crash, a blast',
  glow: 'a soft glow of the fill colour: a shine, a spark',
  plain: 'every effect off: plain letters to build on',
};

const r1 = (v) => Math.round(v * 10) / 10 || 0;
const hex = (s) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(s ?? '').trim());
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
};
// Black or white, whichever stands off `color`.
const otherTone = (color) => {
  const rgb = hex(color);
  return rgb && luminanceOf(rgb) < 0.3 ? '#ffffff' : '#000000';
};
const band = (color, width) => ({ color, width: r1(width), opacity: 1 });
// `k` of the size, at least `lo` and at most `hi` px.
const upTo = (s, k, lo, hi) => Math.max(lo, Math.min(hi, s * k));

// The patch for look `kind` on a box with `style`. Null for an unknown kind.
export function sfxLookPatch(kind, style) {
  const s = style?.size > 0 ? style.size : 40;
  const fill = hex(style?.color) ? style.color : '#000000';
  const other = otherTone(fill);
  const quiet = { motionBlur: { on: false }, roughen: { on: false }, shadows: [], noFill: false };
  switch (kind) {
    case 'heavy':
      return { ...quiet, bold: true, strokes: [band(other, upTo(s, 0.06, 2, 9))] };
    case 'hollow':
      return { ...quiet, noFill: true, strokes: [band(fill, upTo(s, 0.06, 2, 10))] };
    case 'sharp':
      return { ...quiet, bold: false, strokes: [], letterSpacing: r1(upTo(s, 0.05, 0, 6)) };
    case 'soft':
      return { ...quiet, color: '#ffffff', strokes: [band('#9ca3af', upTo(s, 0.04, 1.5, 5))], roughen: { on: true, amount: r1(upTo(s, 0.03, 1, 4)), detail: 0.05 } };
    case 'speed': {
      // Along the box's turn, trailing behind the way it reads.
      const t = ((Number(style?.rotation) || 0) * Math.PI) / 180;
      const k = upTo(s, 0.04, 1, 6);
      return { motionBlur: { on: true, x: r1(-Math.cos(t) * k), y: r1(-Math.sin(t) * k), amount: 12 } };
    }
    case 'shaky':
      return { roughen: { on: true, amount: r1(upTo(s, 0.05, 2, 6)), detail: 0.08 } };
    case 'impact':
      return {
        ...quiet,
        bold: true,
        strokes: [band(other, upTo(s, 0.04, 2, 5)), band(fill, upTo(s, 0.08, 3, 8))],
        shadows: [{ x: r1(upTo(s, 0.04, 1, 6)), y: r1(upTo(s, 0.05, 1, 8)), blur: 0, color: '#000000', opacity: 0.85 }],
      };
    case 'glow':
      return { shadows: [{ x: 0, y: 0, blur: r1(upTo(s, 0.15, 4, 24)), color: fill, opacity: 0.9 }] };
    case 'plain':
      return { ...quiet, strokes: [] };
    default:
      return null;
  }
}
