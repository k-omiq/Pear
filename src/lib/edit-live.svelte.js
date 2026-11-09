// ===== Whether a control of a style panel is held down =====
//
// A slider of the Inspector dragged, or the colour picker's square, writes
// the selected box's style on every frame, and every write is a repaint of
// the box's picture. With a stack of layer effects one full repaint is tens
// to hundreds of milliseconds, so the control lags behind the hand. While a
// pointer that went down in the panel is still down, the box is painted
// within the drag budget instead (`pictureDragPx`), as a resize is, and once
// in full when the pointer comes up (TextBox.svelte's `sfxDragging` effect).
// The panel's own pictures (the pattern cards) wait for the release too.
//
// `sfxLive` (sfx-live.svelte.js) is the same idea for the SFX window; it
// stays its own flag because its panel paints by it.
export const editLive = $state({ on: false });

/** Call from a pointerdown in the panel: live until that pointer is let go. */
export function holdEditLive() {
  if (editLive.on || typeof window === 'undefined') return;
  editLive.on = true;
  const ac = new AbortController();
  const end = (e) => {
    // A capture listener on the window also hears each element's own blur
    // (focus moving inside the page); only the window's ends the press.
    if (e?.type === 'blur' && e.target !== window) return;
    ac.abort();
    editLive.on = false;
  };
  // Every way a press ends: up, cancelled, or the window losing the focus (a
  // pointer let go over another window is never heard of).
  for (const t of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(t, end, { capture: true, signal: ac.signal });
}
