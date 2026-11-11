<script module>
  // "Show in queue" (the box menu): scroll to the active row even when it has
  // not changed - the user may have scrolled the list away from it since.
  const asked = $state({ turn: 0 });
  export function showActiveRow() {
    asked.turn++;
  }
  // Put the caret in the active line's English field (or its source field):
  // what a bubble clicked on the page, and Enter pressed on the page, ask for.
  const focusAsked = $state({ turn: 0, field: 'en' });
  export function focusActiveField(field = 'en') {
    focusAsked.field = field;
    focusAsked.turn++;
  }
</script>

<script>
  import {
    app,
    page,
    placedLineNs,
    activateLine,
    moveLine,
    lineText,
    toggleTagOnLine,
    toast,
    isFreeLine,
    addTextBoxInView,
    setLineText,
    setLineSource,
    resolveOtherReading,
    setLineSpeaker,
    setPageNote,
    isTranslateMode,
    isTranslateChapter,
    stepLine,
    addQueueLine,
    placeableDetectedLines,
    placeDetectedOnPage,
    placeDetectedInChapter,
    cancelChapterPlace,
  } from './store.svelte.js';
  import { untrack, flushSync } from 'svelte';
  import {
    knownTags,
    lineTags,
    hasTag,
    createTag,
    saveTagDefaults,
    tagFormFields,
    tagFormDefaults,
    findTag,
    normalizeTagName,
    MAX_TAG_LEN,
  } from './tags.svelte.js';
  import {
    createFieldUndo,
    resyncField,
    recordFieldEdit,
    undoField,
    redoField,
    fieldFaces,
    caretAfter,
    isAtomicInput,
  } from './editor/field-undo.svelte.js';
  import { copyRuns, fieldSpans } from './runs.js';
  import { modKey } from './format.js';
  import { comboFor, defaultCombo, formatCombo, isMacKeyboard, pressed } from './shortcuts.svelte.js';
  import ReviewList from './ReviewList.svelte';
  import FontNotice from './FontNotice.svelte';
  import EngineNotice from './EngineNotice.svelte';
  import TagDefaultsForm from './TagDefaultsForm.svelte';
  import { guide } from './guide.svelte.js';
  import { glossaryHits, glossaryCharacters } from './glossary.js';

  const p = $derived(page());
  // Which lines already have a box, in one pass over the page's boxes rather
  // than one pass per row - see `placedLineNs`.
  const placedNs = $derived(placedLineNs(p));
  const imported = $derived(p.lines.filter((l) => !isFreeLine(l)));
  // How many bubbles on THIS page still want a box. Drives the top button's
  // label and its disabled state.
  const pagePlaceable = $derived(placeableDetectedLines(p).length);
  // The series' characters, for the speaker picker (TXT-6).
  const characters = $derived(glossaryCharacters(guide.glossary));
  // The page note (TXT-7): shown while the page has one, or once asked for.
  let noteAsked = $state(false);
  const noteShown = $derived(!!p.note || noteAsked);
  $effect(() => {
    p.id;
    noteAsked = false;
  });
  const speakerName = (line) => characters.find((c) => c.id === line.speaker)?.target ?? null;

  // What an sfx-tagged line's sound means (TXT-13). The dictionary is big, so
  // it loads the first time a page has an sfx line, never at boot.
  let sfxMeaning = $state(null);
  const wantsSfx = $derived(!sfxMeaning && p.lines.some((l) => lineTags(l).includes('sfx')));
  $effect(() => {
    if (!wantsSfx) return;
    import('./sfx-meanings.js').then((m) => (sfxMeaning = m.sfxMeaning)).catch(() => {});
  });
  const sfxHint = (line) => {
    const hit = sfxMeaning && line.jp ? sfxMeaning(line.jp) : null;
    return hit ? hit.meanings.join(' / ') : '';
  };

  // ---- reading order ----
  // A row is dragged to where it belongs: past a few pixels it follows the
  // pointer, a line shows where it will land, and the drop is one `moveLine`
  // (one undo step). From the keyboard, Alt+Up / Alt+Down moves the focused
  // row one place. Only imported lines have a place in the order: a free-typed
  // row neither drags nor is dropped between.
  const DRAG_START = 4;
  // The list scrolls under a drag held near its top or bottom edge.
  const EDGE = 28;
  // { n, on, to, mark: { n, after } | null }. `to` is the 1-based place the
  // line drops into, null while the drop would leave it where it is.
  let drag = $state(null);

  // Moving a keyed DOM row can drop its focused descendant even though the
  // node survives. Finish the move before restoring focus, so repeated presses
  // keep moving this content.
  function moveTo(line, position) {
    const focused = document.activeElement;
    flushSync(() => moveLine(line.n, position, p));
    focused?.focus?.({ preventScroll: true });
  }

  function rowKey(e, line, editing) {
    if (!e.target.closest('textarea, input, select') && paneKey(e, line, 'row')) return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !isFreeLine(line) && !e.target.closest('textarea, input')) {
      // Taken here, so the window's handler does not nudge the box as well.
      e.preventDefault();
      const at = imported.findIndex((l) => l.n === line.n);
      moveTo(line, e.key === 'ArrowUp' ? at : at + 2);
    } else if (!editing && e.key === 'Enter') activateLine(line.n);
  }

  // Where a drag at `y` would drop: the rows it would land between, measured
  // live because the list scrolls under it.
  function dropAt(n, y) {
    const rows = [...listEl.querySelectorAll('.qrow[data-n]')];
    const from = rows.findIndex((r) => +r.dataset.n === n);
    const others = rows.filter((_, i) => i !== from);
    let k = others.findIndex((r) => {
      const b = r.getBoundingClientRect();
      return y < b.top + b.height / 2;
    });
    if (k < 0) k = others.length;
    if (k === from) return { to: null, mark: null };
    const mark = k < others.length ? { n: +others[k].dataset.n, after: false } : { n: +others[k - 1].dataset.n, after: true };
    return { to: k + 1, mark };
  }

  function onRowDown(e, line) {
    if (e.button !== 0 || isFreeLine(line) || imported.length < 2) return;
    // The source text is for selecting and copying (a drag over it selects);
    // the rest of the row is the handle.
    if (e.target.closest('textarea, input, select, [contenteditable], .qmenu, .qtagform, .qjp, .qalt-text')) return;
    const y0 = e.clientY;
    const scroller = listEl.closest('.fpanel-body, .tpane-body');
    let y = y0;
    let raf = 0;
    drag = { n: line.n, on: false, to: null, mark: null };
    const update = () => Object.assign(drag, dropAt(line.n, y));
    const edgeScroll = () => {
      raf = 0;
      if (!drag?.on || !scroller) return;
      const r = scroller.getBoundingClientRect();
      const v = y < r.top + EDGE ? -8 : y > r.bottom - EDGE ? 8 : 0;
      if (!v) return;
      scroller.scrollTop += v;
      update();
      raf = requestAnimationFrame(edgeScroll);
    };
    const onMove = (ev) => {
      y = ev.clientY;
      if (!drag.on && Math.abs(y - y0) < DRAG_START) return;
      drag.on = true;
      update();
      if (!raf) raf = requestAnimationFrame(edgeScroll);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      cancelAnimationFrame(raf);
      const { on, to } = drag;
      drag = null;
      if (!on) return;
      // The click a drag ends in is not a click on whatever it ended over.
      const swallow = (ev) => ev.stopPropagation();
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      if (to != null) moveTo(line, to);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  // Undo/redo for each text field.
  const fieldUndo = createFieldUndo();
  const sourceUndo = createFieldUndo();
  let fieldOwner = null;
  let sourceOwner = null;

  $effect(() => {
    const activeLine = p.lines.find((l) => l.n === p.activeLineN);
    // A reorder changes the number, not the owner of this typing history.
    const key = activeLine ?? null;
    const v = activeLine?.en ?? '';
    if (key === fieldOwner && v === fieldUndo.stack[fieldUndo.i]) return;
    fieldOwner = key;
    resyncField(fieldUndo, v, copyRuns(activeLine?.runs));
  });

  $effect(() => {
    const activeLine = p.lines.find((l) => l.n === p.activeLineN);
    const key = activeLine ?? null;
    const v = activeLine?.jp ?? '';
    if (key === sourceOwner && v === sourceUndo.stack[sourceUndo.i]) return;
    sourceOwner = key;
    resyncField(sourceUndo, v);
  });

  // Both fields write through the store for the toolbar's burst undo; each
  // field's own Cmd+Z stack covers its keystrokes. Only English fits boxes.
  // The English field, its selection and input type as each edit begins:
  // what that edit replaced is read from them (`fieldSpans`) once it has
  // landed, so the faces of the words (runs.js) move with the edit.
  const enSpans = fieldSpans();

  function onTextareaInput(e, line, field = 'en') {
    const v = e.currentTarget.value;
    if (field === 'jp') setLineSource(p, line.n, v);
    else {
      const span = enSpans.span(v, line.en ?? '');
      setLineText(p, line.n, v, span ? { span } : undefined);
    }
    // The faces the write left beside the English (runs.js), for a step back.
    const faces = field === 'jp' ? null : copyRuns(line.runs);
    recordFieldEdit(field === 'jp' ? sourceUndo : fieldUndo, v, { atomic: isAtomicInput(e.inputType), faces });
  }

  function onTextareaKey(e, line, field = 'en') {
    if (paneKey(e, line, field)) return;
    if (!(e.metaKey || e.ctrlKey) || (e.key !== 'z' && e.key !== 'Z')) return;
    e.preventDefault();
    const u = field === 'jp' ? sourceUndo : fieldUndo;
    const next = e.shiftKey ? redoField(u) : undoField(u);
    if (next == null) return;
    const el = e.currentTarget;
    const caret = caretAfter(el.value, next);
    el.value = next;
    el.setSelectionRange(caret, caret);
    if (field === 'jp') setLineSource(p, line.n, next);
    else setLineText(p, line.n, next, { runs: fieldFaces(u) });
  }

  // Translate mode disables canvas box placement and status indicators.
  const translate = $derived(isTranslateMode());
  // A translate chapter's typing pane, tools shown or not: the keyboard below
  // belongs to it.
  const pane = $derived(isTranslateChapter());

  // ---------- the typing pane's keyboard ----------
  // Everything a translator does, from the English field: the next line
  // (across pages), the previous one, the tags in the order the chips number
  // them, the tag finder, the speaker, the source text, the note. Every key is
  // the registry's (group Translation), so all of them rebind; the defaults are
  // Enter or Tab on, Shift+Tab back, Alt+1-9 for the tags, Esc to let go of the
  // field. On a row, the row keys step and go back in. Shift+Enter stays the
  // field's own line break. True when the press was taken.
  const TAG_IDS = Array.from({ length: 9 }, (_, i) => `translate.tag${i + 1}`);
  const tagKey = (e) => {
    const i = TAG_IDS.findIndex((id) => pressed(e, id));
    return i < 0 ? null : i + 1;
  };

  function step(dir) {
    if (stepLine(dir) == null) toast(dir > 0 ? 'That was the last line of the chapter' : 'This is the first line of the chapter');
  }

  function paneKey(e, line, where) {
    if (!pane || e.isComposing || e.keyCode === 229) return false;
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
      return true;
    };
    if (where === 'row') {
      if (pressed(e, 'translate.lineDown') || pressed(e, 'translate.lineUp')) {
        take();
        step(pressed(e, 'translate.lineDown') ? 1 : -1);
        return true;
      }
      if (pressed(e, 'translate.edit')) {
        take();
        if (p.activeLineN !== line.n) activateLine(line.n);
        focusActiveField('en');
        return true;
      }
    } else {
      if (pressed(e, 'translate.next') || pressed(e, 'translate.nextAlt')) {
        take();
        // From the source field, the next-line key goes on to the English.
        if (where === 'jp') focusActiveField('en');
        else step(1);
        return true;
      }
      if (pressed(e, 'translate.prev')) {
        take();
        step(-1);
        return true;
      }
      if (pressed(e, 'translate.leave')) {
        take();
        e.currentTarget.blur();
        listEl?.querySelector('.qrow.active')?.focus({ preventScroll: true });
        return true;
      }
    }
    const d = tagKey(e);
    if (d != null) {
      take();
      const t = numbered[d - 1];
      if (t) toggle(line, t.name);
      else toast(`No tag ${d} yet - ${formatCombo(comboFor('translate.tagPicker'))} to add one`);
      return true;
    }
    if (pressed(e, 'translate.clearTags')) {
      take();
      for (const name of lineTags(line).slice()) toggle(line, name);
      return true;
    }
    if (pressed(e, 'translate.tagPicker')) {
      take();
      openPicker(line);
      return true;
    }
    if (pressed(e, 'translate.speaker')) {
      take();
      const sel = listEl?.querySelector(`#qspk-${line.n}`);
      if (sel) sel.focus();
      else toast('No characters yet - add them in Settings ▸ Series guide');
      return true;
    }
    if (pressed(e, 'translate.source')) {
      take();
      focusActiveField(where === 'jp' ? 'en' : 'jp');
      return true;
    }
    if (pressed(e, 'translate.note')) {
      take();
      noteAsked = true;
      queueMicrotask(() => listEl?.querySelector('.qnote')?.focus());
      return true;
    }
    return false;
  }

  // The caret follows the active line in the typing pane: a bubble clicked on
  // the page, a row clicked, Enter pressed - whichever moved it, the English
  // field of the line it landed on is where the next keystroke goes. Only on a
  // change (or a request), never on a re-render, so a field the user moved to
  // on purpose (the note, a tag name) keeps the caret.
  let lastFocusKey = null;
  let lastFocusTurn = focusAsked.turn;
  $effect(() => {
    const key = pane && p.activeLineN != null ? `${p.id}:${p.activeLineN}` : null;
    const turn = focusAsked.turn;
    const field = focusAsked.field;
    untrack(() => {
      const askedNow = turn !== lastFocusTurn;
      if (!askedNow && key === lastFocusKey) return;
      lastFocusKey = key;
      lastFocusTurn = turn;
      if (!key) return;
      if (document.querySelector('.modal-overlay.open, .settings-screen')) return;
      requestAnimationFrame(() => {
        const row = listEl?.querySelector('.qrow.active');
        const el = row?.querySelector(askedNow && field === 'jp' ? 'textarea.qjp' : 'textarea.qen');
        if (!el) return;
        el.focus({ preventScroll: true });
        const end = el.value.length;
        el.setSelectionRange(end, end);
      });
    });
  });


  const known = $derived(knownTags(app.pages));
  const recent = $derived(known.slice(0, 4));
  // The typing pane shows the first nine tags, always in the same places, each
  // with the key that toggles it (Alt+digit unless rebound). In name order, not the registry's: that
  // is recency order, and a digit that moves every time a tag is used is a
  // digit nobody can learn.
  const byName = $derived([...known].sort((a, b) => a.name.localeCompare(b.name)));
  const numbered = $derived(byName.slice(0, 9));
  // The chip shows its digit while the key is the default Alt+digit, and the
  // whole key once it has been rebound.
  const tagKeys = $derived(
    TAG_IDS.map((id, i) => {
      const c = comboFor(id);
      return { aria: c ? c.replace('Mod', isMacKeyboard() ? 'Meta' : 'Control') : undefined, full: c ? formatCombo(c) : '', chip: c === defaultCombo(id) ? String(i + 1) : c ? formatCombo(c) : '' };
    }),
  );

  // ---------- the tag finder (Alt+T) ----------
  // The All tags menu with a field on top: type to narrow, ↑/↓ to choose, Enter
  // to toggle the choice - or, when nothing matches, to make a tag of that name
  // and put it on the line. Esc goes back to the English field.
  let pickQuery = $state('');
  let pickAt = $state(0);
  const pickList = $derived.by(() => {
    const q = normalizeTagName(pickQuery) ?? '';
    return q ? byName.filter((t) => t.name.includes(q)) : byName;
  });
  function openPicker(line) {
    form = null;
    pickQuery = '';
    pickAt = 0;
    menuFor = line;
    // After the menu is in the tree; `autofocus` does not reach an element a
    // keypress inserts into a row that is already mounted.
    requestAnimationFrame(() => listEl?.querySelector('.qpick')?.focus());
  }
  function closePicker(refocus = true) {
    menuFor = null;
    if (refocus) focusActiveField('en');
  }
  function pickerKey(e, line) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = pickList.length;
      if (n) pickAt = (pickAt + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const t = pickList[pickAt];
      if (t) toggle(line, t.name);
      else {
        const name = normalizeTagName(pickQuery);
        if (!name) return;
        createTag(name, tagFormDefaults(tagFormFields(null)));
        if (!hasTag(line, name)) toggle(line, name);
        toast(`Made the tag “${name}”`);
      }
      pickQuery = '';
      pickAt = 0;
      if (!e.shiftKey) closePicker();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePicker();
    } else if (tagKey(e) != null || pressed(e, 'translate.tagPicker')) {
      e.preventDefault();
      closePicker();
    }
  }


  let menuFor = $state(null);

  let form = $state(null);

  // Reset active tag form on page navigation.
  $effect(() => {
    p.id;
    menuFor = null;
    form = null;
  });

  // Construct active and recent tag chips for a line.
  function chips(line) {
    const applied = lineTags(line);
    const rest = recent.map((t) => t.name).filter((n) => !applied.includes(n));
    return [...applied.map((name) => ({ name, on: true })), ...rest.map((name) => ({ name, on: false }))];
  }

  // Toggle tag on line and restyle attached boxes.
  function toggle(line, name) {
    const { restyled } = toggleTagOnLine(line.n, name, p);
    if (restyled) toast(`Restyled ${restyled} box${restyled > 1 ? 'es' : ''} on this line · ${modKey()}Z`);
  }

  function openCreate(line) {
    menuFor = null;
    form = { line, name: '', edit: false, tools: false, existed: false, confirmDelete: false, ...tagFormFields(null) };
  }


  function openEdit(line, name) {
    menuFor = null;
    form = { line, name, edit: true, tools: true, existed: false, confirmDelete: false, ...tagFormFields(findTag(name)) };
  }

  function submitForm(line) {
    const f = form;
    if (!f) return;
    if (f.edit) {
      saveTagDefaults(f.name, tagFormDefaults(f));
      form = null;
      return;
    }
    const name = normalizeTagName(f.name);
    if (!name) return;
    // If tag already exists, transition form to edit mode.
    if (findTag(name)) {
      if (!hasTag(line, name)) toggle(line, name);
      // The existing tag's saved style rides along, so Save keeps what this
      // form does not edit - a style saved off a box (LET-1).
      const saved = tagFormFields(findTag(name));
      form = { ...f, name, edit: true, tools: true, existed: true, confirmDelete: false, style: saved.style, extra: saved.extra };
      return;
    }
    createTag(name, tagFormDefaults(f));

    if (!hasTag(line, name)) toggle(line, name);
    form = null;
  }

  // Add text box in visible viewport.
  function addText() {
    const id = addTextBoxInView();
    if (!id) return;
    const b = page().boxes.find((x) => x.id === id);

    if (b) page().activeLineN = b.lineN;
  }

  // ---------- following the active line ----------
  // The queue is a floating panel a letterer sizes down to a handful of rows,
  // and the active line moves on its own: a placement advances it, an undo
  // rewinds it, a page turn picks a new one. Left alone, the row that says what
  // you are working on is off-screen most of the time.
  //
  // The panel's body is the scroller (see `.fpanel-body`), not this list, so the
  // scroll is computed against that element rather than handed to
  // `scrollIntoView` - which would also walk every ancestor scroller and has no
  // way to be told about the sticky bars at either end of this list.
  //
  // Nothing moves when the row is already fully visible. That is what keeps it
  // from flinching: typing in the active row's textarea re-renders it, and a
  // scroll on every render - even a smooth one - is the twitch this is trying
  // not to be. The guard on top of that is `lastFollowed`, so this answers only
  // to the active line CHANGING, never to the row's contents changing - or to
  // being asked (`showActiveRow`).
  let listEl = $state(null);
  let lastFollowed = null;
  let followRaf = 0;
  // The sticky bars at either end of the list overlap it: a row scrolled to the
  // exact edge lands underneath one. Measured rather than hard-coded, because
  // the top bar is not mounted in a translate chapter.
  const stickyPad = (sel) => listEl?.querySelector(sel)?.getBoundingClientRect().height ?? 0;

  function followActiveLine() {
    followRaf = 0;
    const scroller = listEl?.closest('.fpanel-body, .tpane-body');
    const row = listEl?.querySelector('.qrow.active');
    if (!scroller || !row) return;
    const rowR = row.getBoundingClientRect();
    const boxR = scroller.getBoundingClientRect();
    const top = boxR.top + stickyPad('.qtop') + 6;
    const bottom = boxR.bottom - stickyPad('.qadd') - 6;
    let delta = 0;
    if (rowR.top < top) delta = rowR.top - top;
    // A row taller than the visible band is aligned to its top rather than its
    // bottom: the badge and the first words are the part worth seeing.
    else if (rowR.bottom > bottom) delta = Math.min(rowR.bottom - bottom, rowR.top - top);
    if (!delta) return;
    const reduce =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: reduce ? 'auto' : 'smooth' });
  }

  let lastAsked = asked.turn;
  $effect(() => {
    const key = p.activeLineN == null ? null : `${p.id}:${p.activeLineN}`;
    const turn = asked.turn;
    untrack(() => {
      if (key === lastFollowed && turn === lastAsked) return;
      lastFollowed = key;
      lastAsked = turn;
      if (!key) return;
      // A frame later: the row that just became active grows into its expanded
      // form (the tag strip, the textarea), and a scroll measured before that
      // layout lands is measured against the height the row no longer has.
      if (followRaf) cancelAnimationFrame(followRaf);
      followRaf = requestAnimationFrame(followActiveLine);
    });
  });
  $effect(() => () => {
    if (followRaf) cancelAnimationFrame(followRaf);
  });

  // Esc stops a "Place chapter" that is still measuring - unless a modal is up,
  // whose Esc it is (the markup contract `App.svelte` relies on too).
  function cancelOnEscape(e) {
    if (e.key !== 'Escape' || !app.chapterPlace) return;
    if (document.querySelector('.modal-overlay.open')) return;
    cancelChapterPlace();
  }
</script>

<svelte:window onkeydown={cancelOnEscape} />

<div class="qlist" class:reordering={drag?.on} bind:this={listEl}>
  <!-- The batch placement, at the top of the panel rather than under the queue.
       It is the first thing a letterer does to a detected page - one press
       instead of one click per bubble - and at the foot of a list of forty lines
       it was below the fold on every page that needed it most. -->
  {#if !translate}
    <div class="qtop">
      <button
        class="qtop-btn"
        title="Put a text box on every detected bubble on this page that has none yet"
        disabled={pagePlaceable === 0}
        onclick={() => placeDetectedOnPage(p)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l7 18 2.5-7.5L20 11z" /></svg>
        Place page{pagePlaceable ? ` · ${pagePlaceable}` : ''}
      </button>
      <!-- Never counted up front, unlike the page button beside it: the count is
           a pass over every page's lines AND every page's boxes, and as a
           `$derived` it would re-run on every keystroke in the panel. The button
           says so itself when there is nothing left to do. -->
      <!-- Every balloon in the chapter is measured before anything is placed,
           which takes a moment per page; cancelling before the end places
           nothing. -->
      {#if app.chapterPlace}
        <button class="qtop-btn" disabled>
          Fitting {app.chapterPlace.done}/{app.chapterPlace.total}
        </button>
        <button class="qtop-btn" title="Stop fitting and place nothing (Esc)" onclick={cancelChapterPlace}>
          Cancel
        </button>
      {:else}
        <button
          class="qtop-btn"
          title="Put a text box on every detected bubble in the whole chapter that has none yet"
          disabled={app.pages.length === 0}
          onclick={() => placeDetectedInChapter()}
        >
          Place chapter
        </button>
      {/if}
    </div>
  {/if}
  <!-- The engine and font notices are about boxes, which a translate chapter
       with its tools hidden does not draw. -->
  {#if !translate}<EngineNotice />{/if}
  <ReviewList />
  {#if !translate}<FontNotice />{/if}
  <!-- A note about this page (TXT-7), saved with the chapter: what the art
       shows, who is speaking, what to watch for. Written on every keystroke:
       the page can change under the field (a longstrip scroll, Next to
       check) with no blur first. -->
  {#if noteShown}
    <!-- svelte-ignore a11y_autofocus -->
    <textarea
      class="qnote"
      rows="2"
      placeholder="Note about this page…"
      aria-label="Page note"
      autofocus={noteAsked && !p.note}
      value={p.note ?? ''}
      oninput={(e) => setPageNote(p, e.currentTarget.value)}
      onblur={() => { if (!p.note) noteAsked = false; }}
    ></textarea>
  {:else}
    <button class="qnote-add" onclick={() => (noteAsked = true)}>+ Page note</button>
  {/if}
  {#if p.lines.length === 0}
    <div class="qhint">
      No lines yet.<br />{translate
        ? 'Run Detect to read this page, or import a JSON of numbered text.'
        : 'Import a JSON of numbered text to populate the queue, or add a text box below.'}
    </div>
  {/if}
  <!-- The row follows its content through a renumber. Keying by n would reuse
       another line's textarea and move keyboard focus to the wrong content. -->
  {#each p.lines as line (line)}
    {@const placed = placedNs.has(line.n)}
    {@const tagged = lineTags(line)}
    {@const editing = line.n === p.activeLineN}

    {@const free = isFreeLine(line)}
    {@const badge = free ? 'T' : line.n}
    {@const badgeTitle = free ? 'Typed on the page - not from the translation' : `Line ${line.n}`}

    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
    <div
      class="qrow"
      class:editing
      class:active={editing}
      class:placed
      class:done={pane && !!lineText(line).trim()}
      class:sfx={tagged.includes('sfx')}
      class:narration={tagged.includes('narration')}
      class:lifted={drag?.on && drag.n === line.n}
      class:drop-before={drag?.mark?.n === line.n && !drag.mark.after}
      class:drop-after={drag?.mark?.n === line.n && drag.mark.after}
      data-n={free ? undefined : line.n}
      role={editing ? undefined : 'button'}
      tabindex={editing ? -1 : 0}
      aria-keyshortcuts={free ? undefined : 'Alt+ArrowUp Alt+ArrowDown'}
      onclick={editing ? undefined : () => {
        // A drag over the source to copy it ends in a click; it selects, it
        // does not open the row (which would swap the text for a field).
        if (window.getSelection?.()?.toString()) return;
        activateLine(line.n);
      }}
      onkeydown={(e) => rowKey(e, line, editing)}
      onpointerdown={(e) => onRowDown(e, line)}
    >
      {#if editing}
        {@const hits = glossaryHits(line.jp, lineText(line), guide.glossary)}
        {@const meaning = tagged.includes('sfx') ? sfxHint(line) : ''}

        <button class="badge" class:free title="Select this line's box" onclick={() => activateLine(line.n)}>{badge}</button>
        <span class="qcol">
          <span class="qtags">
            {#if pane}
              <!-- Every one of the first nine tags, in fixed places, so the
                   digit under each is the same on every line. -->
              {#each numbered as t, i (t.name)}
                {@const on = tagged.includes(t.name)}
                <button class="qtag" class:on title={`${on ? 'Remove' : 'Apply'} ${t.name}${tagKeys[i].full ? ` (${tagKeys[i].full})` : ''}`} aria-keyshortcuts={tagKeys[i].aria} aria-pressed={on} onclick={() => toggle(line, t.name)}>{#if tagKeys[i].chip}<kbd class="qtag-key">{tagKeys[i].chip}</kbd>{/if}{t.name}</button>
              {/each}
              {#each tagged.filter((n) => !numbered.some((t) => t.name === n)) as name (name)}
                <button class="qtag on" title={`Remove ${name}`} aria-pressed="true" onclick={() => toggle(line, name)}>{name}</button>
              {/each}
            {:else}
              {#each chips(line) as c (c.name)}
                <button class="qtag" class:on={c.on} title={c.on ? `Remove ${c.name}` : `Apply ${c.name}`} onclick={() => toggle(line, c.name)}>{c.name}</button>
              {/each}
            {/if}
            <button class="qtag-ic" title="Create tag" onclick={() => (form?.line === line && !form.edit ? (form = null) : openCreate(line))}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h8" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5z" /></svg>
            </button>
            <button class="qtag-ic" title={pane ? `Find or add a tag (${formatCombo(comboFor('translate.tagPicker'))})` : 'All tags'} onclick={() => (menuFor === line ? closePicker(false) : openPicker(line))}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
            </button>
          </span>

          {#if menuFor === line}

            <span class="qmenu">
              {#if pane}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="qtf-input qpick"
                  autofocus
                  placeholder="Find or add a tag…"
                  aria-label="Find or add a tag"
                  maxlength={MAX_TAG_LEN}
                  value={pickQuery}
                  oninput={(e) => { pickQuery = e.currentTarget.value; pickAt = 0; }}
                  onkeydown={(e) => pickerKey(e, line)}
                />
                {#if pickQuery && pickList.length === 0}
                  <span class="qmenu-empty">↵ makes the tag “{normalizeTagName(pickQuery) ?? pickQuery}”</span>
                {/if}
              {/if}
              {#if known.length === 0 && !pane}
                <span class="qmenu-empty">No tags yet - use the pen to make one.</span>
              {/if}
              {#each pane ? pickList : known as t, i (t.name)}
                <span class="qmenu-row" class:hot={pane && i === pickAt}>
                  <button class="qmenu-pick" class:on={hasTag(line, t.name)} onclick={() => toggle(line, t.name)}>
                    <svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M4 12l5 5L20 6" /></svg>
                    <span class="nm">{t.name}</span>
                  </button>
                  <button class="qtag-ic" title="Tag settings" onclick={() => openEdit(line, t.name)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1" /></svg>
                  </button>
                </span>
              {/each}
            </span>
          {/if}

          {#if form?.line === line}
            <span class="qtagform">
              <span class="qtf-top">
                {#if form.edit}
                  <span class="qtf-name">{form.name}</span>
                {:else}
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    class="qtf-input"
                    autofocus
                    placeholder="Tag name…"
                    maxlength={MAX_TAG_LEN}
                    value={form.name}
                    oninput={(e) => (form.name = e.currentTarget.value)}
                    onkeydown={(e) => e.key === 'Enter' && submitForm(line)}
                  />
                {/if}
                <button class="qtag-ic" class:on={form.tools} title="Default font, outline and size" onclick={() => (form.tools = !form.tools)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="16" cy="7" r="2.2" /><path d="M4 7h9.8M18.2 7H20" /><circle cx="9" cy="16" r="2.2" /><path d="M4 16h2.8M11.2 16H20" /></svg>
                </button>
                <button class="qtf-go" onclick={() => submitForm(line)}>{form.edit ? 'Save' : 'Add'}</button>
              </span>
              {#if form.existed}

                <span class="qtf-note">
                  “{form.name}” already existed and is now on this line. Its saved defaults are untouched - press Save to replace them with what you set here.
                </span>
              {/if}
              <!-- The defaults and Delete are shared with Settings ▸ Project. -->
              <TagDefaultsForm bind:form key={line.n} onforget={() => (form = null)} />
            </span>
          {/if}

          <!-- Who speaks it (TXT-6). Only offered once the series has
               characters (Settings ▸ Project). A speaker whose character
               was removed shows as unknown until it is changed. -->
          {#if characters.length || line.speaker}
            <span class="qspk">
              <label class="qtf-lbl" for="qspk-{line.n}">Speaker</label>
              <select
                id="qspk-{line.n}"
                value={line.speaker ?? ''}
                onchange={(e) => setLineSpeaker(p, line.n, e.currentTarget.value || null)}
                onkeydown={(e) => {
                  if (pane && (e.key === 'Escape' || e.key === 'Enter')) {
                    e.preventDefault();
                    e.stopPropagation();
                    focusActiveField('en');
                  }
                }}
              >
                <option value="">-</option>
                {#if line.speaker && !speakerName(line)}<option value={line.speaker}>Unknown character</option>{/if}
                {#each characters as c (c.id)}<option value={c.id}>{c.target}</option>{/each}
              </select>
            </span>
          {/if}
          {#if !free}
            <textarea
              class="qjp"
              rows="1"
              placeholder="Source…"
              aria-label="Source text"
              value={line.jp ?? ''}
              oninput={(e) => onTextareaInput(e, line, 'jp')}
              onkeydown={(e) => onTextareaKey(e, line, 'jp')}
            ></textarea>
            <!-- A second reader read this line differently (OCR-1). -->
            {#if line.jp2}
              <span class="qalt">
                <span class="qalt-text" title="What the second OCR reader saw">Other reading: {line.jp2}</span>
                <button class="qalt-btn" onclick={() => resolveOtherReading(p, line.n, true)}>Use</button>
                <button class="qalt-btn" onclick={() => resolveOtherReading(p, line.n, false)}>Keep mine</button>
              </span>
            {/if}
          {/if}
          {#if meaning}<span class="qsfx" title="What this sound usually means">≈ {meaning}</span>{/if}
          <!-- The series terms in this line's source (TXT-2): lit when the
               English has the term's target, marked when it does not. -->
          {#if hits.length}
            <span class="qgls">
              {#each hits as h (h.term.id)}
                <span class="qgl" class:miss={!h.used} title={h.used ? `${h.term.source} → ${h.term.target}` : `${h.term.source} should read “${h.term.target}”`}>{h.used ? '' : '! '}{h.term.target}</span>
              {/each}
            </span>
          {/if}
          <textarea
            class="qen"
            rows="2"
            placeholder="English…"
            aria-label="English for line {badge}"
            value={line.en ?? ''}
            onbeforeinput={enSpans.before}
            oncompositionstart={enSpans.start}
            oncompositionend={enSpans.end}
            oninput={(e) => onTextareaInput(e, line)}
            onkeydown={(e) => onTextareaKey(e, line)}
          ></textarea>
        </span>
        {#if !translate}<span class="dot {placed ? 'placed' : 'unplaced'}" title={placed ? 'Placed' : 'Unplaced'}></span>{/if}
      {:else}
        <span class="badge" class:free title={badgeTitle}>{badge}</span>
        <span class="qcol">
          {#if tagged.length}
            <span class="qtypes">
              {#each tagged as t (t)}<span class="qtype {t}">{t}</span>{/each}
            </span>
          {/if}
          <span class="preview">{#if speakerName(line)}<b class="qspk-name">{speakerName(line)}:</b> {/if}{lineText(line)}</span>
          {#if line.jp}<span class="qjp">{line.jp}</span>{/if}
          {#if tagged.includes('sfx') && sfxHint(line)}<span class="qsfx">≈ {sfxHint(line)}</span>{/if}
        </span>
        {#if !translate}<span class="dot {placed ? 'placed' : 'unplaced'}" title={placed ? 'Placed' : 'Unplaced'}></span>{/if}
      {/if}
    </div>
  {/each}


  {#if !translate}
    <div class="qadd">
      <button class="qadd-btn" disabled={!app.pages.length} onclick={addText}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
        Add text
      </button>
    </div>
  {:else}
    <div class="qadd">
      <button class="qadd-btn" disabled={!app.pages.length} onclick={addQueueLine}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
        Add line
      </button>
    </div>
  {/if}
</div>
