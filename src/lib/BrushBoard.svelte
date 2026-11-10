<script>
  // The board's canvas: a square of `BOARD_SIZE` page px, drawn with the page's
  // own painter so what is on it is what a placed box will show. The pointer
  // gesture lives here - draw, erase, width or liquify, per the armed mode -
  // and every change goes through `brush-board.svelte.js`, which owns the
  // strokes and their undo stack. This component owns pixels and pointers,
  // nothing else.
  import { untrack } from 'svelte';
  import {
    board,
    BOARD_SIZE,
    addBoardStroke,
    beginBoardGesture,
    inBoardGesture,
    endBoardGesture,
    eraseBoardAt,
    widthBoardAt,
    liquifyBoard,
    undoBoard,
    redoBoard,
  } from './brush-board.svelte.js';
  import { brushTool } from './brush-tool.svelte.js';
  import { liquifySettings, liquifyTool } from './liquify-tool.svelte.js';
  import { buildStroke, strokeBounds } from './brush.js';
  import { drawInk } from './text-paint.js';
  import { inkTipIds, settleTips } from './brush-tips.js';

  // How many times the board is drawn over the frame's width. 1 fits.
  let { zoom = 1 } = $props();

  let frameEl = $state(null);
  let canvasEl = $state(null);
  let frameW = $state(0);
  // CSS px per board px.
  const k = $derived(frameW > 0 ? (frameW * zoom) / BOARD_SIZE : 0);
  const cssSize = $derived(Math.max(1, Math.round(BOARD_SIZE * k)));

  // The frame's width follows the panel's; the canvas follows the frame.
  $effect(() => {
    const el = frameEl;
    if (!el) return;
    const ro = new ResizeObserver(() => (frameW = el.clientWidth));
    ro.observe(el);
    frameW = el.clientWidth;
    return () => ro.disconnect();
  });

  // ---- painting -----------------------------------------------------------
  //
  // Committed strokes go into a cache canvas once per change; the visible
  // canvas is that cache plus the stroke under the pointer, which is the only
  // thing re-stamped per frame while drawing.
  const MAX_DEVICE = 4096;
  let cache = null;
  let cacheKey = '';
  let tips = null;
  // Two counters, deliberately: `tipReq` names the settle in flight so a stale
  // answer is dropped, and `tipVer` only moves when the tips in hand actually
  // changed - it is what the cache key reads, so asking the library again
  // (which happens on every repaint) does not by itself throw the cache away.
  let tipReq = 0;
  let tipVer = 0;
  let draft = $state(null);
  let raf = 0;

  function devicePx() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    return Math.min(MAX_DEVICE, Math.max(1, Math.round(cssSize * dpr)));
  }

  // The finish drawn around the committed strokes: the layer's own while one
  // is being edited, else the tool's - what a placed layer will get. Around
  // the cache only, never the stroke under the pointer: the outline is a
  // reading of the finished ink, and it moves out to take a stroke in when
  // the stroke is down.
  const finish = $derived(board.editing?.finish ?? brushTool.finish);
  const finishKey = $derived(JSON.stringify(finish));

  // EACH STROKE'S OWN PICTURE, kept by the stroke object. The board's edits
  // keep an untouched stroke the object it was (`applyLiquify`'s identity
  // contract, and the eraser's and width tool's), so a liquify or width drag
  // repaints only the strokes the tool reached and lays the rest down from
  // here. Painting all of them every frame was the board's whole cost: 85 ms
  // a frame for 40 strokes in WKWebView (2026-11-10), each stroke stamped
  // into a layer the size of the board.
  //
  // Only for the frames of a drag (`inBoardGesture`), and only where the
  // strokes are independent of each other: no finish (an outline around the
  // whole of the ink is a reading of all of it) and no Compare density stroke
  // (compared against the ink under it). Each picture is the stroke drawn by
  // `drawInk` alone onto clear pixels, on the board's own pixel grid, laid
  // down in order with source-over, as one `drawInk` of the list lays each
  // stroke's layer. Not to the byte, though: WebKit antialiases a dab's edge a
  // little differently in a canvas moved by whole pixels (up to 43 of 255 on
  // a few edge pixels, measured), so when the pointer comes up the board is
  // painted whole again and rests on exactly the picture it always had.
  const strokePics = new Map();
  let strokePicsKey = '';
  function releaseStrokePics() {
    for (const pic of strokePics.values()) {
      if (!pic.canvas) continue;
      pic.canvas.width = 0;
      pic.canvas.height = 0;
    }
    strokePics.clear();
  }
  function strokePic(k, W, s) {
    let pic = strokePics.get(k);
    if (pic) return pic;
    pic = { canvas: null, x: 0, y: 0 };
    const b = strokeBounds(k);
    if (b) {
      // Past the stroke's own reach by a margin wider than any pass inside
      // `drawInk` reads (the water edge's band and blur, two px of slack),
      // so nothing it draws is cut. Cut only where the board ends, as there.
      const rim = k.waterEdge === true ? Math.max(0, +k.waterEdgeWidth || 0) + Math.max(0, +k.waterEdgeBlur || 0) : 0;
      const pad = rim * s + 4;
      const x0 = Math.max(0, Math.floor(b.minX * s - pad));
      const y0 = Math.max(0, Math.floor(b.minY * s - pad));
      const x1 = Math.min(W, Math.ceil(b.maxX * s + pad));
      const y1 = Math.min(W, Math.ceil(b.maxY * s + pad));
      if (x1 > x0 && y1 > y0) {
        const c = document.createElement('canvas');
        c.width = x1 - x0;
        c.height = y1 - y0;
        const g = c.getContext('2d');
        g.setTransform(s, 0, 0, s, -x0, -y0);
        drawInk(g, { on: true, strokes: [k] }, undefined, tips);
        pic = { canvas: c, x: x0, y: y0 };
      }
    }
    strokePics.set(k, pic);
    return pic;
  }

  function paintCache(W, live) {
    if (!cache) cache = document.createElement('canvas');
    if (cache.width !== W) cache.width = W;
    if (cache.height !== W) cache.height = W;
    const ctx = cache.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    const s = W / BOARD_SIZE;
    const fx = $state.snapshot(finish);
    const strokes = board.strokes;
    const together = !live || fx?.strokes?.length || fx?.shadows?.length || strokes.some((k) => k?.blend === 'density');
    if (together) {
      releaseStrokePics();
      ctx.scale(s, s);
      drawInk(ctx, { on: true, strokes }, undefined, tips, fx);
      return;
    }
    // A new size or new tips: every picture is out of date.
    const key = `${W}|${tipVer}`;
    if (key !== strokePicsKey) {
      strokePicsKey = key;
      releaseStrokePics();
    }
    const kept = new Set(strokes);
    for (const [k, pic] of strokePics) {
      if (kept.has(k)) continue;
      if (pic.canvas) {
        pic.canvas.width = 0;
        pic.canvas.height = 0;
      }
      strokePics.delete(k);
    }
    for (const k of strokes) {
      const pic = strokePic(k, W, s);
      if (pic.canvas) ctx.drawImage(pic.canvas, pic.x, pic.y);
    }
  }

  function paint() {
    raf = 0;
    const el = canvasEl;
    if (!el || !(cssSize > 1)) return;
    const W = devicePx();
    // Whether a drag is in flight is part of what the cache is: its frames
    // are laid from the strokes' own pictures, the board at rest is not.
    const live = inBoardGesture();
    const key = `${board.rev}|${W}|${tipVer}|${finishKey}|${live ? 'live' : ''}`;
    if (key !== cacheKey) {
      cacheKey = key;
      paintCache(W, live);
    }
    if (el.width !== W) el.width = W;
    if (el.height !== W) el.height = W;
    const ctx = el.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    if (cache) ctx.drawImage(cache, 0, 0);
    const d = draft;
    if (d?.length) {
      const s = W / BOARD_SIZE;
      ctx.scale(s, s);
      const live = buildStroke($state.snapshot(d), $state.snapshot(brushTool.settings));
      if (live) drawInk(ctx, { on: true, strokes: [live] }, undefined, tips);
    }
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(paint);
  }

  // Repaint on anything visible changing, and re-ask for the tips - the
  // library may have dropped one between frames (its lifetime contract).
  // Not the draft: a live stroke repaints through `schedule()` from the
  // pointer, and it can only ever use the armed brush, which is tracked here.
  $effect(() => {
    void board.rev;
    void cssSize;
    void brushTool.settings.brush;
    void brushTool.mode;
    void finishKey;
    if (!canvasEl) return;
    untrack(() => {
      schedule();
      const ids = inkTipIds({ strokes: board.strokes });
      if (brushTool.mode === 'draw') inkTipIds({ strokes: [brushTool.settings] }, ids);
      if (!ids.size) {
        tipReq++;
        if (tips) {
          tips = null;
          tipVer++;
          schedule();
        }
        return;
      }
      const seq = ++tipReq;
      settleTips(ids).then(
        (map) => {
          if (seq !== tipReq || !canvasEl) return;
          let same = !!tips && tips.size === map.size;
          if (same) for (const [id, t] of map) if (tips.get(id) !== t) same = false;
          if (same) return;
          tips = map;
          tipVer++;
          schedule();
        },
        () => {},
      );
    });
  });

  // The pixels go back with the component, cache included: a board that is
  // not on screen must not be the last thing holding a decoded tip alive.
  $effect(() => () => {
    if (raf) cancelAnimationFrame(raf);
    if (cache) {
      cache.width = 0;
      cache.height = 0;
      cache = null;
    }
    releaseStrokePics();
    strokePicsKey = '';
    tips = null;
    tipReq++;
  });

  // ---- the pointer ----------------------------------------------------------

  const live = new Set();
  // Unmounted mid-drag - the tab switched, the tool disarmed - the gesture is
  // ended as a cancel, not merely unlistened: a bracket left open in the board
  // module would swallow the next undo.
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
    draft = null;
    endBoardGesture(false);
  });

  // A pointer event in board px.
  function at(ev) {
    const r = canvasEl.getBoundingClientRect();
    return [(ev.clientX - r.left) / k, (ev.clientY - r.top) / k];
  }

  let ring = $state(null);
  const mode = $derived(brushTool.mode ?? 'draw');
  // The circle the editing modes show: the brush's own size for erase and
  // width, the liquify tool's radius for liquify, nothing while drawing.
  const ringR = $derived(
    mode === 'erase' || mode === 'width'
      ? (brushTool.settings.size / 2) * k
      : mode === 'liquify' ? liquifyTool.radius * k : 0,
  );

  function onMove(e) {
    if (ringR > 0) ring = at(e);
  }
  function onLeave() {
    if (!live.size) ring = null;
  }

  function onDown(e) {
    // One pointer at a time. A second finger or a pen tapped mid-drag would
    // otherwise start a gesture on top of the one still running.
    if (e.button !== 0 || !(k > 0) || live.size) return;
    e.preventDefault();
    frameEl?.focus({ preventScroll: true });
    if (mode === 'erase') return eraseGesture(e);
    if (mode === 'width') return widthGesture(e);
    if (mode === 'liquify') return liquifyGesture(e);
    drawGesture(e);
  }

  function drawGesture(e) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const t0 = e.timeStamp;
    const sample = (ev) => {
      const [x, y] = at(ev);
      const pressure = ev.pressure ?? 0.5;
      brushTool.pen = { type: ev.pointerType || 'unknown', pressure };
      return { x, y, pressure, t: ev.timeStamp - t0 };
    };
    draft = [sample(e)];
    const ac = new AbortController();
    const move = (ev) => {
      if (ev.pointerId !== pid || !draft) return;
      const coalesced = ev.getCoalescedEvents?.();
      for (const one of coalesced?.length ? coalesced : [ev]) {
        const p = sample(one);
        const last = draft[draft.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) > 0.5) draft.push(p);
      }
      schedule();
    };
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      const raw = draft;
      draft = null;
      if (!raw) return;
      // The gesture itself is kept for the panel's preview, so the next
      // change to a setting is shown on this hand's own stroke.
      brushTool.lastGesture = $state.snapshot(raw);
      const stroke = buildStroke($state.snapshot(raw), $state.snapshot(brushTool.settings));
      if (stroke) addBoardStroke(stroke);
      else schedule();
    };
    const cancel = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      draft = null;
      schedule();
    };
    const key = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      cancel({ pointerId: pid });
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', cancel, { signal: ac.signal });
    document.addEventListener('keydown', key, { signal: ac.signal, capture: true });
  }

  // Erase: one gesture is one board step, however many strokes it touched,
  // and a cancelled one puts the board back as the pointer found it.
  function editGesture(e, step) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const ac = new AbortController();
    beginBoardGesture();
    let last = at(e);
    let lastT = e.timeStamp;
    ring = last;
    step(last, last, 1);
    const finish = (keep) => {
      live.delete(ac);
      ac.abort();
      endBoardGesture(keep);
      // The last frames were laid from the strokes' own pictures; the board
      // at rest is painted whole again (`paintCache`).
      schedule();
    };
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const p = at(ev);
      const dt = ev.timeStamp - lastT;
      lastT = ev.timeStamp;
      ring = p;
      step(p, last, Number.isFinite(dt) ? (dt > 0 ? dt / 16.7 : 0) : 1);
      last = p;
    };
    const up = (ev) => {
      if (ev.pointerId === pid) finish(true);
    };
    const cancel = (ev) => {
      if (ev.pointerId === pid) finish(false);
    };
    const key = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', up, { signal: ac.signal });
    document.addEventListener('pointercancel', cancel, { signal: ac.signal });
    document.addEventListener('keydown', key, { signal: ac.signal, capture: true });
  }

  function eraseGesture(e) {
    const r = brushTool.settings.size / 2;
    const how = brushTool.eraseMode;
    editGesture(e, ([x, y]) => eraseBoardAt(x, y, r, how));
  }

  // Width: every pass over a point scales its width by the tool's amount,
  // eased to nothing at the circle's rim. A pass is one pointer move, so a
  // slow drag thickens more than a flick, the way CSP's tool does.
  function widthGesture(e) {
    const r = brushTool.settings.size / 2;
    const { dir, amount } = brushTool.width;
    const a = Math.min(100, Math.max(0, Number(amount) || 0)) / 100;
    const factor = dir === 'narrow' ? 1 / (1 + a) : 1 + a;
    editGesture(e, ([x, y]) => widthBoardAt(x, y, r, factor));
  }

  // Liquify on the board moves the strokes' points, not a mesh: the field is
  // the same one the box-level tool uses (`applyLiquify`), driven by the
  // pointer's delta for push and by the frame's share of time for the rest.
  function liquifyGesture(e) {
    const tool = liquifySettings();
    editGesture(e, ([x, y], [lx, ly], scale) =>
      liquifyBoard({ ...tool, cx: x, cy: y, dx: x - lx, dy: y - ly, scale }),
    );
  }

  // Undo and redo for the BOARD, not the document: while the board has focus
  // the shortcut is its own, and the press is stopped here so the app's window
  // handler cannot also rewind the page.
  function onKey(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.key.toLowerCase() !== 'z') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) redoBoard();
    else undoBoard();
  }

  // Ended from outside: the mode changed under a drag, or the panel closed.
  $effect(() => {
    void mode;
    untrack(() => {
      for (const ac of live) ac.abort();
      live.clear();
      if (draft) {
        draft = null;
        schedule();
      }
      endBoardGesture(false);
      schedule();
      ring = null;
    });
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="frame"
  class:draw={mode === 'draw'}
  class:tool={mode !== 'draw'}
  bind:this={frameEl}
  tabindex="0"
  role="img"
  aria-label="Brush board, {board.strokes.length} strokes"
  onkeydown={onKey}
>
  <div class="sheet" style="width:{cssSize}px;height:{cssSize}px">
    <canvas
      bind:this={canvasEl}
      style="width:{cssSize}px;height:{cssSize}px"
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerenter={onMove}
      onpointerleave={onLeave}
    ></canvas>
    {#if ring && ringR > 0}
      <div class="ring" style="left:{ring[0] * k}px;top:{ring[1] * k}px;width:{ringR * 2}px;height:{ringR * 2}px" aria-hidden="true"></div>
    {/if}
  </div>
</div>

<style>
  /* Square, the panel's width, scrolling once zoomed past it. Paper in both
     themes: the board is ink on paper, exactly like a tip cell. */
  .frame {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
    overflow: auto;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: var(--paper);
    touch-action: none;
    outline: none;
  }
  .frame:focus-visible {
    box-shadow: 0 0 0 2px var(--accent);
  }
  .sheet {
    position: relative;
  }
  canvas {
    display: block;
    cursor: crosshair;
  }
  .frame.tool canvas {
    cursor: none;
  }
  .ring {
    position: absolute;
    transform: translate(-50%, -50%);
    border: 1px solid var(--tintline);
    border-radius: 50%;
    pointer-events: none;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.6);
  }
</style>
