// ===== Focus helpers for popovers =====
// A selector, a query and a restore. No third-party trap, no global state.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Every focusable descendant of `root`, in document order, skipping anything
 * hidden.
 * @param {HTMLElement} root
 * @returns {HTMLElement[]}
 */
export function focusable(root) {
  return /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll(FOCUSABLE))).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Keep Tab inside `root`, ported from Manga Cleaner's. Call it from a keydown
 * handler; it returns true when it handled the event.
 * @param {KeyboardEvent} e
 * @param {HTMLElement} root
 * @returns {boolean}
 */
export function cycleTab(e, root) {
  if (e.key !== 'Tab') return false;
  const items = focusable(root);
  if (!items.length) {
    e.preventDefault();
    return true;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = /** @type {HTMLElement | null} */ (document.activeElement);
  const outside = !root.contains(active);
  const stop = !!active && items.includes(active);
  // Focus on something inside that is not itself a stop (a heading a screen
  // moved focus to) still wraps: Shift+Tab from it would otherwise leave.
  if (e.shiftKey && (active === first || outside || (!stop && first.compareDocumentPosition(/** @type {Node} */ (active)) & Node.DOCUMENT_POSITION_PRECEDING))) {
    e.preventDefault();
    last.focus();
    return true;
  }
  // The same the other way: a non-stop after the last stop wraps forward.
  if (!e.shiftKey && (active === last || outside || (!stop && last.compareDocumentPosition(/** @type {Node} */ (active)) & Node.DOCUMENT_POSITION_FOLLOWING))) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/**
 * Remember the focused element so it can be given focus back on close. If it
 * has left the DOM meanwhile, the first focusable in `fallback` takes it, then
 * the first focusable in the old element's surviving parent.
 *
 * @param {HTMLElement | (() => HTMLElement | null | undefined) | null} [fallback]
 * @returns {() => void} restore
 */
export function captureFocus(fallback) {
  const previous = /** @type {HTMLElement | null} */ (document.activeElement);
  const parent = previous?.parentElement ?? null;
  return () => {
    if (previous && document.contains(previous)) {
      previous.focus();
      return;
    }
    const node = typeof fallback === 'function' ? fallback() : fallback;
    if (node && document.contains(node)) {
      (focusable(node)[0] ?? node).focus?.();
      return;
    }
    if (parent && document.contains(parent)) focusable(parent)[0]?.focus();
  };
}
