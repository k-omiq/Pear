<script>
  // The first-run setup, and Settings' "Run setup again", as a full-window
  // screen. Ported from Manga Cleaner's FirstLaunchDialog in structure and
  // measure: a segmented progress bar, one centred 520px column, the step
  // heading, and a footer with Skip setup, Back and Continue. Six steps at
  // most (`onboardingSteps`); what a step with controls shows is its own
  // component beside this one, and where the setup is lives in
  // onboarding.svelte.js, which Settings opens it through.
  //
  // The shell follows `.settings-screen`: a dialog over whatever is mounted
  // underneath, which stays mounted, so running the setup again from the
  // editor keeps the chapter as it was. Every way out goes through
  // `finishOnboarding`: Finish, Skip setup, and Escape.
  import { tick } from 'svelte';
  import ThemePicker from '../ThemePicker.svelte';
  import { captureFocus, cycleTab } from '../focus.js';
  import { openExternal } from '../open-external.js';
  import {
    onboarding,
    onboardingSteps,
    nextOnboardingStep,
    prevOnboardingStep,
    finishOnboarding,
  } from './onboarding.svelte.js';
  import WelcomeStep from './WelcomeStep.svelte';
  import UsageStep from './UsageStep.svelte';
  import DetectionStep from './DetectionStep.svelte';
  import DiscordInvite from './DiscordInvite.svelte';

  const HEADINGS = {
    welcome: 'Welcome to Pear',
    theme: 'Pick a theme',
    scope: 'Pear changes text, not pictures',
    usage: 'What will you use Pear for?',
    detection: 'Detection and OCR',
    community: 'Join the community',
  };

  // Also listed in the opener capability (src-tauri/capabilities/default.json).
  const CLEANER_URL = 'https://cleaner.komiq.cc';

  const step = $derived(onboarding.step);
  const steps = $derived(onboardingSteps());
  // Welcome counts as the first step of the path, though the bar is not drawn
  // on it: the general path is five segments and the comics path six.
  const position = $derived(steps.indexOf(step) + 1);
  const total = $derived(steps.length);
  const last = $derived(position === total);
  // Continue waits for a pick on the usage step; everywhere else it can act.
  const canContinue = $derived(step !== 'usage' || !!onboarding.usage);

  let root = $state(null);
  let heading = $state(null);

  // Focus moves in on open and goes back to whatever had it on close.
  $effect(() => captureFocus());

  // A new step moves focus to its heading, so a screen reader starts where the
  // person now is and Enter can press the step's primary button.
  $effect(() => {
    void step;
    tick().then(() => heading?.focus());
  });

  function openCleaner(event) {
    event.preventDefault();
    openExternal(CLEANER_URL);
  }

  function onkeydown(event) {
    // A control inside that answered the key itself has already used it.
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      // Stopped here so the editor's own Escape (deselect, close a panel)
      // does not also run under the screen.
      event.preventDefault();
      event.stopPropagation();
      finishOnboarding();
      return;
    }
    // Enter presses the primary button, but only from the heading: anywhere
    // else Enter belongs to the focused control. Not while an input method is
    // composing, not with a modifier, and not a held key repeating, so one
    // press never walks through two steps.
    if (event.key === 'Enter' && event.target === heading) {
      if (event.repeat || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!canContinue) return;
      event.preventDefault();
      nextOnboardingStep();
      return;
    }
    if (root) cycleTab(event, root);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div bind:this={root} class="onboarding-screen" role="dialog" aria-modal="true" aria-label="Set up Pear" tabindex="-1" {onkeydown}>
  {#if step !== 'welcome'}
    <div
      class="progress"
      role="progressbar"
      aria-label="Setup progress"
      aria-valuetext="Step {position} of {total}"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={position}
    >
      {#each steps as name, index (name)}
        <span class:on={index < position}></span>
      {/each}
    </div>
  {/if}

  <main class="ob-stage">
    {#key step}
      <section class="step">
        <h1 class="heading" class:hero={step === 'welcome'} tabindex="-1" bind:this={heading}>{HEADINGS[step]}</h1>
        {#if step === 'welcome'}
          <WelcomeStep />
        {:else if step === 'theme'}
          <ThemePicker />
        {:else if step === 'scope'}
          <p class="lead">Pear places, fits and styles text on your images. It does not edit, clean or redraw the image itself, and no image-editing tools will be added.</p>
          <p class="note">To clean comic pages, use <a class="link" href={CLEANER_URL} onclick={openCleaner}>Manga Cleaner</a>.</p>
        {:else if step === 'usage'}
          <UsageStep />
        {:else if step === 'detection'}
          <DetectionStep />
        {:else}
          <DiscordInvite />
        {/if}
      </section>
    {/key}
  </main>

  {#if step !== 'welcome'}
    <footer class="foot">
      <div class="foot-inner">
        <button class="skip" onclick={finishOnboarding}>Skip setup</button>
        <span class="spacer"></span>
        <button class="btn" onclick={prevOnboardingStep}>Back</button>
        <button class="btn btn-accent" disabled={!canContinue} onclick={nextOnboardingStep}>{last ? 'Finish' : 'Continue'}</button>
      </div>
    </footer>
  {/if}
</div>

<style>
  /* Above Settings (100), which "Run setup again" is pressed from, and under
     the toasts (300), which a step's choice may raise. */
  .onboarding-screen {
    position: fixed;
    inset: 0;
    z-index: 110;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    animation: ob-fade 0.12s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .onboarding-screen:focus {
    outline: none;
  }

  .progress {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    gap: 4px;
    padding: 14px 20px 0;
  }
  .progress span {
    flex: 1;
    height: 3px;
    border-radius: 999px;
    background: var(--line2);
    transition: background 0.15s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .progress span.on {
    background: var(--accent);
  }

  /* Not `.stage`: that name is the editor's canvas stage, a global rule that
     sizes itself to its content and would widen this past the window. */
  .ob-stage {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    justify-content: center;
    padding: 48px 26px;
  }

  /* Auto block margins centre the step while it fits and fall to zero once it
     does not, so a tall step scrolls from its heading instead of being cut off
     above the fold, as `align-items: center` would leave it. */
  .step {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 520px;
    margin-block: auto;
    user-select: text;
    -webkit-user-select: text;
    animation: ob-in 0.15s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .heading {
    margin: 0 0 20px;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.2;
    color: var(--text);
  }
  .heading.hero {
    margin-bottom: 14px;
    font-size: clamp(28px, 4vw, 38px);
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  /* The heading takes focus only so a screen reader starts there. It is not a
     control, and a ring around it would read as one. */
  .heading:focus {
    outline: none;
  }

  /* The steps' shared type, set once so they read as one piece. */
  .step :global(.lead) {
    margin: -8px 0 20px;
    max-width: 52ch;
    font-size: 13px;
    line-height: 1.55;
    color: var(--t2);
  }
  .step :global(.note) {
    margin: 8px 0 0;
    max-width: 62ch;
    font-size: 12px;
    line-height: 1.5;
    color: var(--t2);
  }
  .link {
    color: var(--text);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 2px;
  }

  .foot {
    display: flex;
    justify-content: center;
    padding: 14px 26px;
    border-top: 1px solid var(--line);
    background: var(--bg);
  }
  .foot-inner {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    max-width: 520px;
  }
  .spacer {
    flex: 1;
  }
  .foot .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  /* The quiet way out: text only, so it never competes with Continue. */
  .skip {
    height: 30px;
    padding: 0 8px;
    margin-left: -8px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--t2);
    font-size: 12px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .skip:hover {
    background: var(--accent-soft);
    color: var(--text);
  }
  .skip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  @keyframes ob-fade {
    from {
      opacity: 0;
    }
  }
  @keyframes ob-in {
    from {
      opacity: 0;
      transform: translateY(5px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .onboarding-screen,
    .step {
      animation: none;
    }
    .progress span,
    .skip {
      transition: none;
    }
  }
</style>
