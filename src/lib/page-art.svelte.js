// ===== The page art a box is shown over =====
//
// One answer to "which picture is the page" for the editor's `<img>` and for
// what a box that blends with the page blends with (`backdrop.js`): the box
// must blend with the art the user sees, or the editor would show a blend of
// one picture over another.
//
// The export draws `p.cleaned ?? p.raw` (`renderPageCanvas`); the editor shows
// that too, except where a chapter's view says otherwise: a held raw peek
// (`peekRaw`) or the peek view's Raw switch (`viewRaw`), and a translate
// chapter, which is read on its raw and shows the cleaned page only when its
// typesetting tools are out and the pane's Cleaned switch asks for it.

import { comboFor as layoutFor } from './layouts.svelte.js';

/**
 * The page art shown for `pg` under the view `view` (the app state: its
 * `peekRaw`, `viewRaw`, `chapterMode`, `viewCleaned`, and `tools` - whether
 * the typesetting tools are out, which is the open layout's when not given), or
 * null.
 */
export function pageArtSrc(pg, view = {}) {
  if (!pg) return null;
  // A page with no raw (a cleaned-only import) shows its cleaned page rather
  // than nothing while the raw is asked for.
  if (view.peekRaw || view.viewRaw) return pg.raw ?? pg.cleaned ?? null;
  const tools = view.tools ?? layoutFor(view.chapterMode).tools;
  if (view.chapterMode === 'translate') return tools && view.viewCleaned ? (pg.cleaned ?? pg.raw ?? null) : (pg.raw ?? null);
  return pg.cleaned ?? pg.raw ?? null;
}

// The art as an image the painter can draw from synchronously (a repaint
// cannot wait for a decode). A src not seen before starts loading and answers
// null; when it has loaded `art.version` moves, so a picture keyed on the art
// being there (TextBox.svelte's `underKey`) is painted again with it.
export const art = $state({ version: 0 });

// src -> { img, ready }. Small: the pages a box can stand on at once are the
// few the editor holds, and the browser keeps the decoded bitmap the `<img>`
// already has.
const MAX_HELD = 6;
const held = new Map();

/** The decoded art for `src`, or null while it loads (or where it cannot). */
export function artImage(src) {
  if (!src) return null;
  const hit = held.get(src);
  if (hit) {
    held.delete(src);
    held.set(src, hit);
    return hit.ready ? hit.img : null;
  }
  if (typeof Image !== 'function') return null;
  const entry = { img: new Image(), ready: false };
  entry.img.crossOrigin = 'anonymous';
  entry.img.decoding = 'async';
  entry.img.onload = () => {
    entry.ready = entry.img.naturalWidth > 0;
    // Always moved, even if the entry was evicted meanwhile: a box waiting on
    // this art asks again and gets it (or loads it afresh).
    art.version++;
  };
  entry.img.onerror = () => {
    if (held.get(src) === entry) held.delete(src);
  };
  held.set(src, entry);
  // Entries still loading are not evicted: a box waiting on one would never
  // get its page. Oldest ready entry goes first.
  for (const [k, e] of held) {
    if (held.size <= MAX_HELD) break;
    if (e.ready && k !== src) held.delete(k);
  }
  entry.img.src = src;
  return null;
}

/** Whether the art for `src` has loaded (reads `art.version`, so a derived re-runs). */
export function artReady(src) {
  void art.version;
  return !!src && held.get(src)?.ready === true;
}

/** Forget every held image: a chapter closed. */
export function forgetArt() {
  held.clear();
}
