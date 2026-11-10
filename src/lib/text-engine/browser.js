// The detached measuring canvas is made only when measure.js first loads.
export function createBrowserTextEngine() {
  const _c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const _ctx = _c ? _c.getContext('2d') : null;
  if (!_ctx) return null;
  const _fontSet = document.fonts;
  const ink = (m) => ({
    width: m.width,
    left: m.actualBoundingBoxLeft,
    right: m.actualBoundingBoxRight,
    ascent: m.actualBoundingBoxAscent,
    descent: m.actualBoundingBoxDescent,
  });
  return {
    id: 'browser',
    advance(face, text) {
      _ctx.font = face.key;
      return _ctx.measureText(text).width;
    },
    // A text in several faces: each span measured alone in its face, summed,
    // so no kerning reaches across a change of face - as the Rust engine.
    advanceRuns(faces, text, spans) {
      let w = 0;
      spans.forEach((s, i) => {
        _ctx.font = faces[i].key;
        w += _ctx.measureText(text.slice(s.start, s.end)).width;
      });
      return w;
    },
    fontBox(face) {
      _ctx.font = face.key;
      const m = _ctx.measureText('Hg');
      return { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
    },
    lineInk(face, text) {
      _ctx.font = face.key;
      _ctx.textAlign = 'left';
      _ctx.textBaseline = 'alphabetic';
      return ink(_ctx.measureText(text));
    },
    glyphInk(face, text) {
      _ctx.font = face.key;
      _ctx.textAlign = 'center';
      _ctx.textBaseline = 'middle';
      const m = _ctx.measureText(text);
      // The shared context is put back because fontBox reads the current baseline.
      _ctx.textAlign = 'left';
      _ctx.textBaseline = 'alphabetic';
      return ink(m);
    },
    // A removed document used to hand wrapping back to the greedy breaker too.
    get wrapPlain() {
      return browserPlainBreaker();
    },
    loading() {
      return _fontSet?.status === 'loading';
    },
    onFontsChange(cb) {
      if (typeof _fontSet?.addEventListener !== 'function') return;
      for (const ev of ['loading', 'loadingdone', 'loadingerror']) _fontSet.addEventListener(ev, cb);
      return () => {
        for (const ev of ['loading', 'loadingdone', 'loadingerror']) _fontSet.removeEventListener?.(ev, cb);
      };
    },
    // Code points of `text` the face itself has no glyph for, each once, in
    // order (the Rust engine's `missing` at depth 0). A canvas says nothing of
    // it, so each letter is measured - its advance and its ink box - and
    // compared. A browser draws a letter the face lacks from another font: set
    // in the face with a fallback behind it, the letter is the fallback's own,
    // for two fallbacks alike. A canvas that does not fall back draws the
    // face's empty box: the letter measures as one nothing has (U+10FFFD). A
    // letter the face has is the face's, and differs from both. A face that is
    // not drawing at all (not loaded, not on this machine) lacks its own "A"
    // too, and answers for none: that is a missing font, said elsewhere.
    missing(face, text) {
      const own = `"${face.name}"`;
      const lacks = (ch) =>
        sameInk(probe(face, ch, own), probe(face, NOTHING, own)) ||
        PROBE_FALLBACKS.every((fb) => sameInk(probe(face, ch, `${own}, ${fb}`), probe(face, ch, fb)));
      // Asked afresh every time, never kept: a face still loading is not
      // drawing yet, and will be.
      if (lacks('A')) return [];
      const cut = (ch) => {
        const key = `${face.name}\n${face.bold ? 1 : 0}${face.italic ? 1 : 0}\n${ch}`;
        let v = lacking.get(key);
        if (v === undefined) {
          v = lacks(ch);
          if (lacking.size > 20000) lacking.clear();
          lacking.set(key, v);
        }
        return v;
      };
      const out = [];
      for (const ch of new Set(String(text ?? ''))) {
        if (!/\S/u.test(ch)) continue;
        if (cut(ch)) out.push(ch.codePointAt(0));
      }
      return out;
    },
    faceReady: browserFaceReady,
  };
  function probe(face, ch, family) {
    _ctx.font = `${face.italic ? 'italic ' : ''}${face.bold ? 700 : 400} ${PROBE_PX}px ${family}`;
    _ctx.textAlign = 'left';
    _ctx.textBaseline = 'alphabetic';
    return ink(_ctx.measureText(ch));
  }
}

// The glyph probe (`missing`): two generic families unlike each other, at a
// size large enough that two different glyphs measure apart.
const PROBE_FALLBACKS = ['monospace', 'serif'];
// A code point no font has a glyph for (the last private use one).
const NOTHING = String.fromCodePoint(0x10fffd);
const PROBE_PX = 64;
const lacking = new Map();
const sameInk = (a, b) => ['width', 'left', 'right', 'ascent', 'descent'].every((k) => Math.abs((a[k] || 0) - (b[k] || 0)) < 0.01);

// Read the browser's own line breaks, including its rules for long words.
function wrapPlain(face, text, opts) {
  const el = document.createElement('div');
  el.style.cssText =
    'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:pre-wrap;' +
    'word-break:break-word;overflow-wrap:break-word;box-sizing:content-box;padding:0;margin:0;border:0;' +
    `width:${Math.max(1, opts.width)}px;` +
    `font-family:${face.css};font-weight:${face.bold ? 700 : 400};` +
    `font-style:${face.italic ? 'italic' : 'normal'};font-size:${face.size}px;` +
    `line-height:${opts.lineHeight};letter-spacing:${opts.letterSpacing}px;text-transform:none;text-align:${opts.align};`;
  document.body.appendChild(el);
  const out = [];
  try {
    for (const para of text.split('\n')) {
      if (para === '') {
        out.push('');
        continue;
      }
      el.textContent = para;
      const node = el.firstChild;
      const range = document.createRange();
      let curTop = null;
      let start = 0;
      for (let i = 0; i < para.length;) {
        const cp = para.codePointAt(i);
        const charLen = cp > 0xffff ? 2 : 1;
        range.setStart(node, i);
        range.setEnd(node, i + charLen);
        const rects = range.getClientRects();
        const rect = rects[rects.length - 1];
        if (!rect) {
          i += charLen;
          continue;
        }
        const top = Math.round(rect.top);
        if (curTop === null) curTop = top;
        else if (Math.abs(top - curTop) > 1) {
          const raw = para.slice(start, i).replace(/\s+$/, '');
          out.push(start === 0 ? raw : raw.replace(/^\s+/, ''));
          start = i;
          curTop = top;
        }
        i += charLen;
      }
      const raw = para.slice(start).replace(/\s+$/, '');
      out.push(start === 0 ? raw : raw.replace(/^\s+/, ''));
    }
  } finally {
    el.remove();
  }
  return out.length ? out : [''];
}

// Readiness used to ask the live font set even when there was no measuring
// canvas at import time. Keep that answer for a browser installed later too.
export function browserFaceReady(face) {
  const set = typeof document === 'undefined' ? null : document.fonts;
  if (typeof set?.check !== 'function') return true;
  try {
    if (set.check(face.key)) return true;
    set.load?.(face.key)?.catch?.(() => {});
    return false;
  } catch {
    return true;
  }
}

// Plain wrapping always consulted the live DOM, independently of the detached
// canvas. Some callers install one after measurement has already been imported.
export function browserPlainBreaker() {
  return typeof document === 'undefined' ? undefined : wrapPlain;
}
