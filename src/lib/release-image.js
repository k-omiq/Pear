// Page pictures that are about to leave the document give their bytes back
// first.
//
// WebKit (the app's WKWebView) keeps the file bytes of a picture an `<img>`
// loaded when that element is taken out of the document still holding its
// `src`, and nothing gets them back: not a forced collection, not a
// memory-cache flush, not revoking a blob URL, not clearing the `src` of the
// detached element afterwards, not fifteen seconds. Measured on 2026-11-09:
// twenty 2048 x 2900 pages, each mounted in its own `<img>` and unmounted, as
// the editor's page frames are, left the web process at 362 MB; the same with
// `src` taken off while the element was still in the document, 102 MB (its
// size before any page was shown). An `<img>` whose `src` is changed in place
// lets the old picture go, so only an element that leaves needs this.
//
// It has to happen BEFORE the element leaves, which is why this is not an
// action: Svelte runs an action's `destroy` after it has taken the element
// out. A component calls it from `$effect.pre`, which runs before its DOM is
// updated, with the pictures it is about to show (`keep`); every other `src`
// under `root` that matches `selector` is the picture of an element on its
// way out, or of one about to be pointed elsewhere, and is let go now.
//
// `removeAttribute` rather than `src = ''`, which in some engines resolves to
// the document's own URL and starts a fetch (page-images.js `releaseDecoded`).
export function releaseLeavingImages(root, selector, keep) {
  if (!root) return 0;
  let n = 0;
  for (const img of root.querySelectorAll(selector)) {
    const src = img.getAttribute('src');
    if (src && !keep.has(src)) {
      img.removeAttribute('src');
      n++;
    }
  }
  return n;
}
