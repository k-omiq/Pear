<script>
  import { app } from './store.svelte.js';
  import { readDrawing } from './sidecar.js';
  import { drawRead, inkCrop } from './draw-read.svelte.js';

  const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
  const SIZE = 320;
  const PEN = 10;

  let canvas = $state(null);
  // Raw: the stroke in progress grows in place and the pad is redrawn by hand.
  let strokes = $state.raw([]);
  let current = null;
  let reading = $state(false);
  let result = $state(null);
  let error = $state('');
  let copied = $state(false);

  // Each open starts on a clean pad.
  $effect(() => {
    if (!drawRead.open) return;
    strokes = [];
    result = null;
    error = '';
    queueMicrotask(redraw);
  });

  function redraw() {
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = PEN;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      ctx.beginPath();
      ctx.moveTo(s[0][0], s[0][1]);
      // A tap is a dot: a zero-length line with round caps.
      for (const [x, y] of s.length > 1 ? s.slice(1) : s) ctx.lineTo(x, y);
      ctx.stroke();
    }
  }

  function at(e) {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * SIZE) / r.width, ((e.clientY - r.top) * SIZE) / r.height];
  }
  function down(e) {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    current = [at(e)];
    strokes = [...strokes, current];
    result = null;
    redraw();
  }
  function move(e) {
    if (!current) return;
    current.push(at(e));
    redraw();
  }
  function up() {
    current = null;
  }

  function undo() {
    strokes = strokes.slice(0, -1);
    result = null;
    redraw();
  }
  function clear() {
    strokes = [];
    result = null;
    error = '';
    redraw();
  }

  async function read() {
    const ctx = canvas?.getContext('2d');
    const crop = ctx && inkCrop(ctx.getImageData(0, 0, SIZE, SIZE));
    if (!crop) return;
    const out = document.createElement('canvas');
    out.width = crop.w;
    out.height = crop.h;
    const o = out.getContext('2d');
    o.fillStyle = '#fff';
    o.fillRect(0, 0, crop.w, crop.h);
    o.drawImage(canvas, -crop.x, -crop.y);
    reading = true;
    error = '';
    try {
      const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
      const r = await readDrawing(new Uint8Array(await blob.arrayBuffer()), app.projectOcrLanguage);
      result = r.text.trim();
      if (!result) error = 'Nothing readable. Try drawing it bigger or with clearer strokes.';
    } catch (e) {
      error = String(e?.message || e);
    } finally {
      reading = false;
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(result);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      error = 'Could not copy. Select the text and copy it by hand.';
    }
  }

  function onOverlayClick(e) {
    if (e.target.classList.contains('modal-overlay')) drawRead.open = false;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-overlay" class:open={drawRead.open} onclick={onOverlayClick}>
  <div class="modal draw-read">
    <div class="modal-head">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
      <h3>Draw to read</h3>
      <button class="x" aria-label="Close" onclick={() => (drawRead.open = false)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>
    <div class="modal-body">
      <div class="dr-sub">Draw one character or a short word. The project's OCR reads it.</div>
      <canvas
        bind:this={canvas}
        width={SIZE}
        height={SIZE}
        aria-label="Drawing pad"
        onpointerdown={down}
        onpointermove={move}
        onpointerup={up}
        onpointercancel={up}
      ></canvas>
      <div class="dr-row">
        <button class="btn" onclick={undo} disabled={!strokes.length || reading}>Undo</button>
        <button class="btn" onclick={clear} disabled={!strokes.length || reading}>Clear</button>
        <button class="btn btn-accent dr-read" onclick={read} disabled={!strokes.length || reading || !isTauri}>
          {reading ? 'Reading…' : 'Read'}
        </button>
      </div>
      {#if !isTauri}<div class="dr-sub">Reading needs the desktop app.</div>{/if}
      {#if result}
        <div class="dr-result">
          <span class="dr-text">{result}</span>
          <button class="btn" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      {/if}
      {#if error}<div class="dr-sub dr-err">{error}</div>{/if}
    </div>
  </div>
</div>

<style>
  .draw-read { width: 360px; }
  canvas {
    display: block;
    width: 320px;
    height: 320px;
    margin: 10px auto;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: #fff;
    cursor: crosshair;
    touch-action: none;
  }
  .dr-sub { color: var(--t2); font-size: 12px; line-height: 1.5; }
  .dr-err { color: var(--warn); margin-top: 8px; }
  .dr-row { display: flex; gap: 8px; }
  .dr-read { margin-left: auto; }
  .dr-result { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
  .dr-text { font-size: 28px; flex: 1; user-select: text; }
</style>
