<script>
  // The AI panel (Door B, docs/AI_TYPESETTING_PLAN.md section 7): a chat
  // beside the page. The user types what they want; the agent works through
  // Pear's own tools and the page changes as it goes. Stop and Revert run are
  // on the "AI is editing" bar as for any agent; Stop is here too.
  import { onMount, tick } from 'svelte';
  import { panel, MODELS, setModel, acceptPrivacy, sendPrompt, stopPrompt, clearChat, followChapter } from '../agent/panel.svelte.js';
  import { aiKey, refreshKey } from '../agent/key.svelte.js';
  import { openSettings } from '../settings-tabs.svelte.js';
  import { isTauri } from '../importer.js';
  import { app } from '../store.svelte.js';

  let draft = $state('');
  let log = $state(null);

  onMount(() => {
    if (aiKey.set == null) refreshKey();
  });

  $effect(() => {
    void app.chapterRef;
    followChapter();
  });

  // The newest words in view as they stream.
  $effect(() => {
    const last = panel.chat[panel.chat.length - 1];
    void last?.text;
    void last?.tools?.length;
    tick().then(() => log && (log.scrollTop = log.scrollHeight));
  });

  async function send() {
    const text = draft.trim();
    if (!text || panel.running) return;
    draft = '';
    await sendPrompt(text);
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  }

  const tokens = $derived(panel.usage.input + panel.usage.cacheRead + panel.usage.cacheWrite);
  const fmt = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const toolWord = (n) => `${n} step${n === 1 ? '' : 's'}`;
</script>

<div class="aip">
  {#if !isTauri()}
    <p class="aip-note">The AI panel needs the desktop app.</p>
  {:else if !panel.privacyOk}
    <div class="aip-gate">
      <p><b>Before you start</b></p>
      <p>The AI panel sends this chapter's page pictures and text to Anthropic to do what you ask.</p>
      <p>It runs on your own Claude API key. Each request costs a little on your Claude account. The token count below shows how much.</p>
      <p>Your key stays in this computer's keychain. The page never sees it.</p>
      <button class="btn btn-accent" onclick={acceptPrivacy}>OK</button>
    </div>
  {:else if aiKey.set === false}
    <div class="aip-gate">
      <p>Add your Claude API key to use the AI panel.</p>
      <button class="btn btn-accent" onclick={() => openSettings('ai')}>Open AI settings</button>
    </div>
  {:else}
    <div class="aip-log" bind:this={log}>
      {#if !panel.chat.length}
        <div class="aip-empty">
          <p>Tell the AI what to do on this chapter.</p>
          <ul>
            <li>"Typeset this page"</li>
            <li>"Narration font on pages 2-5 to Anime Ace"</li>
            <li>"Make every scream red with a white outline"</li>
            <li>"Check this chapter for text outside its balloon"</li>
          </ul>
        </div>
      {/if}
      {#each panel.chat as m, i (i)}
        {#if m.role === 'user'}
          <div class="aip-user">{m.text}</div>
        {:else}
          <div class="aip-reply">
            {#if m.tools?.length}
              <details class="aip-tools">
                <summary>
                  {toolWord(m.tools.length)}{#if m.tools.some((t) => t.ok === false)}<span class="aip-bad"> · {m.tools.filter((t) => t.ok === false).length} failed</span>{/if}
                </summary>
                <ol>
                  {#each m.tools as t (t.id)}
                    <li class:bad={t.ok === false} title={t.error ?? ''}>
                      <span class="aip-mark">{t.ok == null ? '…' : t.ok ? '✓' : '✗'}</span>{t.name}
                    </li>
                  {/each}
                </ol>
              </details>
            {/if}
            {#if m.text}<div class="aip-text">{m.text}</div>{/if}
            {#if m.stopped}<div class="aip-meta">Stopped.</div>{/if}
            {#if panel.running && i === panel.chat.length - 1 && !m.text}
              <div class="aip-meta">{MODELS[panel.using]?.label ?? ''} is working…</div>
            {/if}
          </div>
        {/if}
      {/each}
      {#if panel.error}<p class="aip-error" role="alert">{panel.error}</p>{/if}
    </div>

    <div class="aip-input">
      <textarea
        rows="2"
        bind:value={draft}
        onkeydown={onKey}
        placeholder={app.loaded ? 'What should the AI do?' : 'Open a chapter first'}
        disabled={!app.loaded}
        aria-label="Message to the AI"
      ></textarea>
      {#if panel.running}
        <button class="btn" onclick={stopPrompt} title="Stop now. What it did stays.">Stop</button>
      {:else}
        <button class="btn btn-accent" onclick={send} disabled={!draft.trim() || !app.loaded}>Send</button>
      {/if}
    </div>

    <div class="aip-foot">
      <label class="aip-model">
        <span class="sr">Model</span>
        <select value={panel.model} onchange={(e) => setModel(e.currentTarget.value)} disabled={panel.running} title="Auto picks Fast for short edits and Balanced for the rest">
          <option value="auto">Auto</option>
          {#each Object.entries(MODELS) as [k, m] (k)}
            <option value={k} title={m.note}>{m.label}</option>
          {/each}
        </select>
      </label>
      <span class="aip-tokens" title={`Sent ${panel.usage.input} new, ${panel.usage.cacheRead} from cache, ${panel.usage.cacheWrite} cached now. Received ${panel.usage.output}.`}>
        {fmt(tokens)} in · {fmt(panel.usage.output)} out
      </span>
      <button class="aip-new" onclick={clearChat} disabled={panel.running || !panel.chat.length} title="Start a new chat">New chat</button>
    </div>
  {/if}
</div>

<style>
  .aip {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-size: 13px;
  }
  .aip-note,
  .aip-gate {
    padding: 14px;
    color: var(--t2);
    line-height: 1.45;
  }
  .aip-gate p {
    margin: 0 0 10px;
  }
  .aip-log {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .aip-empty {
    color: var(--t2);
    line-height: 1.45;
  }
  .aip-empty p {
    margin: 0 0 6px;
  }
  .aip-empty ul {
    margin: 0;
    padding-left: 18px;
    color: var(--t3);
  }
  .aip-user {
    align-self: flex-end;
    max-width: 88%;
    padding: 7px 10px;
    border-radius: 7px;
    background: var(--panel2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .aip-reply {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .aip-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.45;
  }
  .aip-meta {
    color: var(--t3);
  }
  .aip-tools summary {
    cursor: pointer;
    color: var(--t3);
  }
  .aip-tools ol {
    margin: 4px 0 0;
    padding-left: 4px;
    list-style: none;
    color: var(--t2);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px;
  }
  .aip-tools li.bad,
  .aip-bad {
    color: var(--warn);
  }
  .aip-mark {
    display: inline-block;
    width: 16px;
  }
  .aip-error {
    margin: 0;
    color: var(--warn);
  }
  .aip-input {
    display: flex;
    gap: 6px;
    align-items: flex-end;
    padding: 8px 10px 6px;
    border-top: 1px solid var(--line);
  }
  .aip-input textarea {
    flex: 1;
    resize: none;
    min-height: 38px;
    max-height: 140px;
    padding: 7px 9px;
    border-radius: var(--radius);
    border: 1px solid var(--line2);
    background: var(--surface);
    color: var(--text);
    font: inherit;
  }
  .aip-input textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .aip-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 8px;
    color: var(--t3);
    font-size: 11.5px;
  }
  .aip-model select {
    font: inherit;
    color: var(--t2);
    background: var(--surface);
    border: 1px solid var(--line2);
    border-radius: var(--radius);
    padding: 2px 4px;
  }
  .aip-tokens {
    flex: 1;
    font-variant-numeric: tabular-nums;
  }
  .aip-new {
    background: none;
    border: 0;
    color: var(--t2);
    font: inherit;
    cursor: pointer;
    padding: 2px 4px;
  }
  .aip-new:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
</style>
