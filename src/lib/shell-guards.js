// ===== Shell-level guards for webview desktop app =====
// UX-1: Prevents accidental reload and native reload context menu.
// DET-4: Watches late-loading web fonts and triggers relayout.

// The one selector that decides where the webview's own context menu may still
// appear: text fields and the in-place editor, where Cut/Copy/Paste/Spelling
// are wanted. `<select>` is deliberately absent - it has no useful native menu
// and would otherwise offer Reload. `closest` covers the target itself and
// every ancestor, so a span inside a contenteditable counts. Only text-like
// inputs: a slider, checkbox or colour well gets the webview's non-editable
// menu, which is the one with Reload in it.
const NOT_TEXT = ['range', 'checkbox', 'radio', 'color', 'button', 'submit', 'reset', 'file', 'image']
  .map((t) => `:not([type=${t}])`)
  .join('');
const EDITABLE = `input${NOT_TEXT}, textarea, [contenteditable]:not([contenteditable="false"])`;

/**
 * @param {any} el event target (an Element, or a Text node inside one)
 * @returns {boolean}
 */
export function isEditableTarget(el) {
  const node = el?.nodeType === 3 ? el.parentElement : el;
  return !!node?.closest?.(EDITABLE);
}

/**
 * A slider or a radio uses the arrow keys itself. The nudge and the page turn
 * must leave them alone, or the box moves while the slider stays put.
 * @param {any} el event target
 * @returns {boolean}
 */
export function ownsArrowKeys(el) {
  const node = el?.nodeType === 3 ? el.parentElement : el;
  return !!node?.matches?.('input[type=range], input[type=radio]');
}

/**
 * Context menu handler that prevents the browser/webview native menu unless
 * the target is an editable element.
 *
 * @param {Event} e
 */
export function onContextMenu(e) {
  if (!isEditableTarget(e?.target)) {
    e?.preventDefault?.();
  }
}

/**
 * Installs the contextmenu guard on the document in the capture phase.
 * Capture phase ensures reload menu prevention runs before target bubbling.
 *
 * @param {Document|any} [doc]
 * @returns {() => void} Disposer
 */
export function installContextMenuGuard(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || typeof doc.addEventListener !== 'function') return () => {};
  doc.addEventListener('contextmenu', onContextMenu, true);
  return () => {
    if (typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('contextmenu', onContextMenu, true);
    }
  };
}

/**
 * Determines whether a keyboard event is a page-reload shortcut:
 * Mod+R, Mod+Shift+R, or F5.
 *
 * @param {KeyboardEvent|any} e
 * @returns {boolean}
 */
export function isReloadKey(e) {
  if (!e) return false;
  if (e.key === 'F5') return true;
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  // The typed letter, not the physical key: on Dvorak the key where QWERTY has
  // R types P, and Cmd+P must stay Cmd+P. `code` is only the fallback for
  // layouts whose letters are not Latin at all (Cyrillic, Greek...), where
  // the system still maps the R position to reload.
  const key = typeof e.key === 'string' ? e.key : '';
  return /^[a-z]$/i.test(key) ? key.toLowerCase() === 'r' : e.code === 'KeyR';
}

/**
 * Watches a FontFaceSet for late font loads ('loadingdone' events) and calls
 * onChange debounced by delayMs, with the families that loaded in the burst.
 *
 * The set is empty when an event did not say which faces it was for: the
 * caller cannot narrow anything down then, and must treat it as "any".
 *
 * @param {FontFaceSet|any} fontFaceSet
 * @param {(families: Set<string>) => void} onChange
 * @param {number} [delayMs=150]
 * @returns {() => void} Disposer
 */
export function watchFontLoads(fontFaceSet, onChange, delayMs = 150) {
  if (!fontFaceSet || typeof fontFaceSet.addEventListener !== 'function') {
    return () => {};
  }

  let timer = null;
  let families = new Set();
  let unknown = false;

  const onLoadingDone = (event) => {
    const faces = event?.fontfaces;
    if (faces?.length) {
      // WebKit hands the family back quoted ('"Comic Neue"').
      for (const f of faces) families.add(String(f.family).replace(/^(["'])(.*)\1$/, '$2'));
    } else {
      unknown = true;
    }
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const done = unknown ? new Set() : families;
      families = new Set();
      unknown = false;
      onChange(done);
    }, delayMs);
  };

  fontFaceSet.addEventListener('loadingdone', onLoadingDone);

  return () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if (typeof fontFaceSet.removeEventListener === 'function') {
      fontFaceSet.removeEventListener('loadingdone', onLoadingDone);
    }
  };
}
