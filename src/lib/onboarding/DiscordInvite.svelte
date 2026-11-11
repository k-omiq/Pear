<script>
  // The invite to the Discord server, ported from Manga Cleaner's: the setup's
  // last step, and `compact` at the end of Settings ▸ About, where it carries
  // its own heading because no step heading sits above it. The blurple is the
  // one hue the chrome allows (DESIGN.md), here and nowhere else.
  import { openExternal } from '../open-external.js';

  let { compact = false } = $props();

  // Also listed in the opener capability (src-tauri/capabilities/default.json).
  const INVITE_URL = 'https://discord.gg/3ueKc9PaX7';

  // The link keeps its href so it reads and copies as a link, but the click
  // goes through the opener: a webview does not open a new browser tab itself.
  function openInvite(event) {
    event.preventDefault();
    openExternal(INVITE_URL);
  }

  const MARK =
    'M104.4 8.7A102.7 102.7 0 0 0 79.1.9a71.6 71.6 0 0 0-3.2 6.6 95 95 0 0 0-28.7 0A71.6 71.6 0 0 0 44 .9 102.7 102.7 0 0 0 18.7 8.7C2.7 32.4-1.6 55.6.6 78.5a103 103 0 0 0 31 15.7 75 75 0 0 0 6.6-10.7 66.4 66.4 0 0 1-10.4-5c.9-.6 1.7-1.3 2.5-2a73.2 73.2 0 0 0 66.5 0l2.5 2a66.4 66.4 0 0 1-10.4 5 75 75 0 0 0 6.6 10.7 103 103 0 0 0 31-15.7c2.7-26.5-4.5-49.5-22.1-69.8ZM42.5 64.4c-6.3 0-11.5-5.7-11.5-12.7s5.1-12.7 11.5-12.7c6.4 0 11.6 5.7 11.5 12.7 0 7-5.1 12.7-11.5 12.7Zm42.1 0c-6.3 0-11.5-5.7-11.5-12.7s5.1-12.7 11.5-12.7c6.4 0 11.6 5.7 11.5 12.7 0 7-5.1 12.7-11.5 12.7Z';
</script>

<section class="invite" class:compact aria-label={compact ? undefined : 'Discord'}>
  <div class="intro">
    <span class="discord-mark" aria-hidden="true">
      <svg viewBox="0 0 127.14 96.36" fill="currentColor" focusable="false"><path d={MARK} /></svg>
    </span>
    <div>
      {#if compact}<h3>Join the community</h3>{/if}
      <p>Stay close to the people building Pear.</p>
    </div>
  </div>

  <ul class="reasons">
    <li><strong>Report a bug</strong><span>Share what went wrong so we can fix it.</span></li>
    <li><strong>Get updates</strong><span>See what is new and what is coming next.</span></li>
    <li><strong>Suggest improvements</strong><span>Tell us what would make your work better.</span></li>
  </ul>

  <div class="action">
    <a class="join" href={INVITE_URL} target="_blank" rel="noopener noreferrer" onclick={openInvite}>
      <svg viewBox="0 0 127.14 96.36" fill="currentColor" aria-hidden="true" focusable="false"><path d={MARK} /></svg>
      Join our Discord server
    </a>
    <span class="external">Opens in your browser</span>
  </div>
</section>

<style>
  .invite {
    padding: 26px;
    border: 1px solid var(--line2);
    border-radius: 12px;
    background: var(--card);
    box-shadow: var(--edge-soft);
  }
  .compact {
    margin-top: 34px;
  }
  .intro {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .discord-mark {
    display: grid;
    place-items: center;
    flex: none;
    width: 48px;
    height: 48px;
    border-radius: 8px;
    background: var(--discord-soft);
    color: var(--discord-blurple);
  }
  .discord-mark svg {
    width: 26px;
    height: 26px;
  }
  h3 {
    margin: 0 0 4px;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.25;
    color: var(--text);
  }
  .intro p {
    margin: 0;
    color: var(--t2);
    font-size: 13px;
    line-height: 1.5;
  }
  .reasons {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
    margin: 26px 0;
    padding: 20px 0;
    list-style: none;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }
  .reasons li {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .reasons strong {
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
  }
  .reasons span {
    color: var(--t2);
    font-size: 11px;
    line-height: 1.5;
  }
  .action {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 11px;
  }
  .join {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 38px;
    padding: 0 14px;
    border-radius: 6px;
    background: var(--discord-blurple);
    color: var(--discord-white);
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
    transition: background 0.12s cubic-bezier(0.2, 0.8, 0.2, 1), transform 0.12s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .join:hover {
    background: var(--discord-hover);
    transform: translateY(-1px);
  }
  .join:active {
    transform: none;
  }
  .join:focus-visible {
    outline: 2px solid var(--discord-blurple);
    outline-offset: 3px;
  }
  .join svg {
    width: 17px;
    height: 17px;
  }
  .external {
    color: var(--t3);
    font-size: 11px;
  }
  @media (max-width: 560px) {
    .invite {
      padding: 20px;
    }
    .reasons {
      grid-template-columns: 1fr;
      gap: 11px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .join {
      transition: none;
    }
    .join:hover {
      transform: none;
    }
  }
</style>
