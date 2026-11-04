<script>
  // ===== Which text reader (OCR model) one source language uses =====
  //
  // One control, used wherever a reader is chosen: Settings ▸ Detection lists
  // every language with one of these each, and the Detect menu shows the one
  // for the open series. Real radio buttons under the rows, so the arrow keys
  // move between models and a screen reader hears a choice, not a list of
  // buttons. The choice is a preference of this computer (prefs.ocrModels); the
  // series only stores its language.
  import { prefs, setPref } from './prefs.svelte.js';
  import { OCR_MODEL_OPTIONS, ocrModelForLanguage } from './ocr-models.js';
  import { toast } from './store.svelte.js';

  let { language, label = null, compact = false } = $props();

  const NAMES = { ja: 'Japanese', zh: 'Chinese', ko: 'Korean' };
  const options = $derived(OCR_MODEL_OPTIONS[language] ?? []);
  const current = $derived(ocrModelForLanguage(language, prefs.ocrModels));
  const name = `reader-${language}-${Math.random().toString(36).slice(2, 8)}`;

  function pick(id) {
    if (id === current) return;
    setPref('ocrModels', { ...prefs.ocrModels, [language]: id });
    const m = options.find((o) => o.id === id);
    toast(`${NAMES[language] ?? language} reader: ${m?.label ?? id}. It downloads on the next Detect.`);
  }
</script>

<div class="reader" class:compact role="radiogroup" aria-label={label ?? `${NAMES[language] ?? language} text reader`}>
  {#each options as m (m.id)}
    {@const on = m.id === current}
    <label class="reader-opt" class:on class:only={options.length === 1}>
      <input type="radio" {name} value={m.id} checked={on} disabled={options.length === 1} onchange={() => pick(m.id)} />
      <span class="reader-dot" aria-hidden="true"></span>
      <span class="reader-text">
        <span class="reader-name">{m.label}</span>
        <span class="reader-detail">{m.detail}</span>
      </span>
    </label>
  {/each}
</div>

<style>
  .reader {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .reader-opt {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px 11px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--surface);
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .compact .reader-opt {
    padding: 7px 9px;
    border-radius: 6px;
    background: transparent;
    border-color: transparent;
  }
  .reader-opt:hover {
    border-color: var(--t3);
  }
  .compact .reader-opt:hover {
    background: var(--panel2);
    border-color: transparent;
  }
  .reader-opt.on {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .reader-opt.only {
    cursor: default;
  }
  .reader-opt input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .reader-opt:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .reader-dot {
    flex: none;
    width: 14px;
    height: 14px;
    margin-top: 1px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--t3);
  }
  .on .reader-dot {
    box-shadow: inset 0 0 0 4px var(--accent);
  }
  .reader-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .reader-name {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
  }
  .reader-detail {
    font-size: 11.5px;
    color: var(--t2);
    white-space: normal;
  }
</style>
