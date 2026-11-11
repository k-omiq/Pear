// ===== Which drawing tool is armed on the selected box =====
// Session state, not saved: an Inspector panel arms a tool, the selected
// TextBox draws with it. It lives out here for the same reason the Inspector's
// tab does - two components far apart in the tree both need it, and neither
// should grow a handle on the other.
//
// `target` is what the gestures write into and `kind` is the gesture. The
// Mask, Fade and Colour panels each own a model of their own; what they share
// is only the pointer work, so one tool state serves all three and the target
// says whose model a finished shape goes to. Only `mask` is wired so far.
//
// `target: null` means no tool: the box moves and resizes as ever. Arming a
// tool hands the box's pointer to the drawing overlay until it is disarmed:
// the same tool picked again, Escape, a different box selected, or its panel
// no longer in front.
export const DRAW_TARGETS = ['mask', 'fade', 'paint'];
export const DRAW_KINDS = ['brush', 'rect', 'ellipse', 'poly', 'move', 'erase'];

export const drawTool = $state({ target: null, kind: null });

// What the next shape of each target is drawn with, set in its panel: for
// the mask, its op (Hide or Keep) and the brush's width, page px. Session
// state like the tool: a setting of the hand, not of any box, so it is not
// saved and no box carries it.
export const drawSettings = $state({ mask: { op: 'hide', size: 20 } });

// The Effects sub-tab whose panel arms each target. A tool is put down when
// its panel is no longer the one in front (`inspector-tabs.svelte.js`): an
// armed tool takes the box's pointer, and a tool nobody can see would leave
// the box unable to move for no reason the letterer can find.
export const DRAW_PANELS = { mask: 'mask', fade: 'fade' };

export function setDrawTool(target, kind) {
  if (!DRAW_TARGETS.includes(target) || !DRAW_KINDS.includes(kind)) return false;
  // The same tool again disarms - a toggle, so the panel needs no "off" button.
  if (drawTool.target === target && drawTool.kind === kind) return clearDrawTool(), true;
  drawTool.target = target;
  drawTool.kind = kind;
  return true;
}

export function clearDrawTool() {
  drawTool.target = null;
  drawTool.kind = null;
}

// The kind armed for `target`, or null when the tool belongs to another
// target or none is armed.
export function drawKindFor(target) {
  return drawTool.target === target ? drawTool.kind : null;
}
