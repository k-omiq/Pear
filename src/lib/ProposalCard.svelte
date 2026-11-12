<script>
  // One AI wording waiting for the user (TXT-4, TXT-8): the words it would
  // put in, why, and Use / Reject. Shown under its line in the text queue and
  // as a card in the AI panel's reply. When the words changed since it was
  // made, it says so and shows both, so it is never taken silently.
  import { pageById } from './store.svelte.js';
  import { acceptProposal, rejectProposal, targetText } from './proposals.svelte.js';

  // `id` names the proposal on page `pageId`. `was` is what the chat
  // remembers (the words before, page and line), for a card whose proposal
  // has since been used or rejected elsewhere.
  let { pageId, id, was = null, compact = false } = $props();

  let done = $state(null); // 'used' | 'rejected' | null

  const pg = $derived(pageById(pageId));
  const pr = $derived(pg?.proposals?.find((x) => x.id === id) ?? null);
  const now = $derived(pr && pg ? targetText(pg, pr.target) : null);
  const stale = $derived(!!pr && now != null && now !== pr.base);

  function use() {
    const r = acceptProposal(pageId, id, { force: stale });
    if (r === 'used') done = 'used';
  }
  function reject() {
    if (rejectProposal(pageId, id)) done = 'rejected';
  }
</script>

{#if pr}
  <div class="prop" class:compact class:stale>
    <div class="prop-head">
      <span class="prop-who">AI suggests</span>{#if was?.where}<span class="prop-where"> · {was.where}</span>{/if}{#if pr.reason}<span class="prop-why"> · {pr.reason}</span>{/if}
    </div>
    {#if !compact}<div class="prop-was">{pr.base}</div>{/if}
    <div class="prop-text">{pr.text}</div>
    {#if stale}
      <div class="prop-stale">The words changed since: {now}</div>
    {/if}
    <div class="prop-btns">
      <button class="btn btn-accent prop-btn" onclick={use}>{stale ? 'Use anyway' : 'Use'}</button>
      <button class="btn prop-btn" onclick={reject}>Reject</button>
    </div>
  </div>
{:else if !compact && was}
  <div class="prop gone">
    <div class="prop-head">
      <span class="prop-who">{done === 'used' ? 'Used' : done === 'rejected' ? 'Rejected' : 'Settled'}</span>{#if was.where}<span class="prop-where"> · {was.where}</span>{/if}
    </div>
    <div class="prop-text">{was.text}</div>
  </div>
{/if}

<style>
  .prop {
    border: 1px solid var(--line2);
    border-radius: var(--radius);
    padding: 7px 9px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: var(--surface);
    font-size: 12.5px;
  }
  .prop.compact {
    margin: 2px 8px 6px 34px;
  }
  .prop.gone {
    opacity: 0.6;
  }
  .prop-head {
    color: var(--t3);
    font-size: 11.5px;
  }
  .prop-who {
    color: var(--t2);
    font-weight: 600;
  }
  .prop-was {
    color: var(--t3);
    text-decoration: line-through;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .prop-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text);
  }
  .prop-stale {
    color: var(--warn);
    font-size: 11.5px;
  }
  .prop-btns {
    display: flex;
    gap: 6px;
    margin-top: 2px;
  }
  .prop-btn {
    height: 26px;
    padding: 0 10px;
    font-size: 12px;
  }
</style>
