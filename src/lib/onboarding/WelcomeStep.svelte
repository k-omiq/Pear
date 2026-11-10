<script>
  // The setup's cover, after Manga Cleaner's: one line on what the app is,
  // the way in, and where the source lives. The heading is the frame's, as
  // every step's is. No language picker: the app has no other language.
  import { openExternal } from '../open-external.js';
  import { nextOnboardingStep } from './onboarding.svelte.js';

  // Also listed in the opener capability (src-tauri/capabilities/default.json).
  const SOURCE_URL = 'https://github.com/komiq-cc/manga-typesetter';

  function openSource(event) {
    event.preventDefault();
    openExternal(SOURCE_URL);
  }
</script>

<p class="body">Place and style text on your pages. Built for comic lettering, open to any image.</p>
<div class="actions">
  <button class="accent-btn" onclick={nextOnboardingStep}>Set up the app</button>
  <a class="source" href={SOURCE_URL} onclick={openSource}>
    <!-- The GitHub mark in the text colour, inline so it follows every theme. -->
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>
    GitHub
  </a>
</div>

<style>
  .body {
    margin: 0 0 34px;
    max-width: 44ch;
    font-size: 14px;
    line-height: 1.55;
    color: var(--t2);
  }
  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 20px;
  }
  .accent-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
  .source {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border-radius: 5px;
    color: var(--t2);
    font-size: 12px;
    text-decoration: none;
    transition: color 0.12s;
  }
  .source:hover {
    color: var(--text);
  }
  .source:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
  .source svg {
    width: 15px;
    height: 15px;
  }
</style>
