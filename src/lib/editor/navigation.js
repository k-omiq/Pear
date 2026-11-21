// ===== How the page is moved: the wheel, the trackpad and the drags =====
//
// Ported from manga-cleaner (src/lib/editor/navigation.js), so the two apps
// move a page the same way.
//
// A trackpad scrolls with two fingers and zooms with a pinch, and the canvas
// takes both as they come: a plain wheel event is the scroller's own (native,
// with the trackpad's momentum), and a pinch arrives as a wheel with `ctrlKey`
// (WebKit also sends gesture events, which Canvas.svelte takes when no such
// wheel comes). A mouse has one wheel axis and nothing to grab the page with,
// so the three choices below are the user's, kept in `prefs.navigation`; the
// two presets are the common mixes, named by the device they suit.
//
// Pure: what a wheel or a press MEANS is decided here from the event's fields,
// so it is tested without a canvas. Canvas.svelte does the moving.
//
// Navigation = {
//   wheel: 'scroll' | 'zoom'  what a plain wheel turn does. Cmd or Ctrl with it
//                             (and a pinch) always zooms.
//   middlePan: boolean        a middle-button drag moves the page.
//   emptyPan: boolean         a left drag on the empty canvas around the page
//                             moves it.
// }

export const WHEEL_MODES = ['scroll', 'zoom'];

// The presets, in the order Settings offers them. `trackpad` is the default:
// two fingers scroll, a pinch zooms, and the middle button (which a trackpad
// does not have, so cannot press by accident) still pans.
export const NAVIGATION_PRESETS = Object.freeze({
  trackpad: Object.freeze({ wheel: 'scroll', middlePan: true, emptyPan: false }),
  mouse: Object.freeze({ wheel: 'zoom', middlePan: true, emptyPan: true }),
});

export const defaultNavigation = () => ({ ...NAVIGATION_PRESETS.trackpad });

// Anything - a hand-edited blob, a blob from before this setting - as a
// Navigation. Each field falls back on its own.
export function normalizeNavigation(raw) {
  const base = defaultNavigation();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  return {
    wheel: WHEEL_MODES.includes(raw.wheel) ? raw.wheel : base.wheel,
    middlePan: typeof raw.middlePan === 'boolean' ? raw.middlePan : base.middlePan,
    emptyPan: typeof raw.emptyPan === 'boolean' ? raw.emptyPan : base.emptyPan,
  };
}

// The preset these settings are, or null when the user has mixed their own.
export function navigationPreset(nav) {
  for (const [id, p] of Object.entries(NAVIGATION_PRESETS)) {
    if (p.wheel === nav?.wheel && p.middlePan === nav?.middlePan && p.emptyPan === nav?.emptyPan) return id;
  }
  return null;
}

// Does this wheel event zoom?
//
// Cmd or Ctrl always zooms: a trackpad pinch arrives as a Ctrl wheel, and the
// two cannot be told apart. In `zoom` mode a plain turn zooms too, and Shift or
// Alt hands the turn back to the scroller - Shift to scroll sideways, Alt to
// scroll down - so a mouse can still scroll without grabbing the page. A
// purely sideways event (a tilt wheel, a trackpad swipe) never zooms.
export function wheelZooms(e, nav) {
  if (e.ctrlKey || e.metaKey) return true;
  if (nav?.wheel !== 'zoom' || e.shiftKey || e.altKey) return false;
  const dy = Math.abs(e.deltaY ?? 0);
  return dy > 0 && dy >= Math.abs(e.deltaX ?? 0);
}

// What a press may land on and still be that control's, never a pan.
const CONTROLS =
  'button, a[href], input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="menu"], [role="menuitem"], [role="dialog"]';
// The page itself: a press there is the tool's (place a line, add a box), so
// only the canvas around the pages is "empty".
const PAGE = '.page-frame, .strip, .tbox';

// Does this press start a pan, and how?
//   'grab'   take it outright, before anything under it sees it: the middle
//            button (with `middlePan`), or the left one with Space held.
//   'empty'  a left press on the empty canvas around the page, with
//            `emptyPan` on.
//   null     not a pan.
export function panStart(e, { nav, held }) {
  if (e.button === 1) return nav?.middlePan ? 'grab' : null;
  if (e.button !== 0) return null;
  if (held) return 'grab';
  if (!nav?.emptyPan) return null;
  const t = e.target;
  if (typeof t?.closest !== 'function') return 'empty';
  return t.closest(PAGE) || t.closest(CONTROLS) ? null : 'empty';
}
