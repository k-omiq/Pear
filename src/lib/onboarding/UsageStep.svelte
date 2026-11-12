<script>
  // Comics or general use. Real radio buttons, so the group is one tab stop
  // and the arrow keys move the pick, as they do in ReaderChoice.
  import { onboarding, pickUsage } from './onboarding.svelte.js';

  const OPTIONS = [
    { id: 'comics', label: 'Comics', detail: 'Manga, manhwa, manhua and webtoons. Detect the text, hold the translation, letter the pages.' },
    { id: 'general', label: 'General use', detail: 'Put styled text on any image. Comic tools stay hidden.' },
  ];
</script>

<div class="usage" role="radiogroup" aria-label="What will you use Pear for?">
  {#each OPTIONS as o (o.id)}
    {@const on = onboarding.usage === o.id}
    <label class="row" class:on>
      <input type="radio" name="onboarding-usage" value={o.id} checked={on} onchange={() => pickUsage(o.id)} />
      <span class="dot" aria-hidden="true"></span>
      <span class="text">
        <span class="name">{o.label}</span>
        <span class="detail">{o.detail}</span>
      </span>
    </label>
  {/each}
</div>
<p class="note">You can change this later in Settings.</p>

<style>
  .usage {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--line);
  }
  /* Rows, not cards: a hairline under each, and the pick is a soft fill. */
  .row {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 11px;
    padding: 14px 11px;
    border-bottom: 1px solid var(--line);
    cursor: pointer;
    transition: background 0.12s;
  }
  .row:hover,
  .row.on {
    background: var(--accent-soft);
  }
  /* The input stays in the page for the keyboard and the screen reader; the
     dot beside it is what is seen. */
  .row input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
    margin: 0;
    pointer-events: none;
  }
  /* The same dot ReaderChoice draws, so the two pickers read as one kind. */
  .dot {
    flex: none;
    width: 14px;
    height: 14px;
    margin-top: 1px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--t3);
    transition: box-shadow 0.12s;
  }
  .row.on .dot {
    box-shadow: inset 0 0 0 4px var(--accent);
  }
  .row:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .name {
    font-size: 12.5px;
    color: var(--text);
  }
  .detail {
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--t2);
  }
  @media (prefers-reduced-motion: reduce) {
    .row,
    .dot {
      transition: none;
    }
  }
</style>
