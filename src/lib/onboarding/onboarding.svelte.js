// ===== The first-run setup: is it open, and on which step =====
// Out here rather than in Onboarding.svelte because two places open it: the
// boot in App.svelte, once, for an install that was never set up, and
// Settings' "Run setup again". The screen reads this and changes it only
// through the functions below.
import { prefs, setPref } from '../prefs.svelte.js';

// The steps, in order. Detection is asked only of a comics install: general
// use hides detection, so asking about it would be asking about nothing.
const COMICS_STEPS = ['welcome', 'theme', 'scope', 'usage', 'detection', 'community'];
const GENERAL_STEPS = COMICS_STEPS.filter((s) => s !== 'detection');

// `usage` is what was picked on the usage step during this run, or null
// before a pick. It is kept apart from `prefs.usage`, which is 'comics' on a
// fresh install whether or not anyone chose it, so Continue can wait for a
// real pick.
export const onboarding = $state({ open: false, step: 'welcome', usage: null });

// The steps of the path the current pick puts the person on. Before a pick
// that is the shorter path, so the progress bar grows by one when Comics is
// picked rather than shrinking when General use is.
export function onboardingSteps() {
  return onboarding.usage === 'comics' ? COMICS_STEPS : GENERAL_STEPS;
}

// Open the setup on its first step. Without `force` it opens only for an
// install that has not been set up; Settings passes `force` to walk through it
// again. Returns whether it opened.
export function offerOnboarding({ force = false } = {}) {
  if (!force && prefs.onboarded) return false;
  onboarding.step = 'welcome';
  // A second run has a usage on record already, so that row starts picked.
  onboarding.usage = force ? prefs.usage : null;
  onboarding.open = true;
  return true;
}

// The boot's one decision. A window opened for an AI agent's chapter is not
// where a person sets the app up, so it is never offered there; the main
// window offers it the next time it opens.
export function offerOnboardingAtBoot(role) {
  if (role?.agent) return false;
  return offerOnboarding();
}

// The usage is saved the moment it is picked, as the theme is, so leaving
// early keeps what was chosen.
export function pickUsage(usage) {
  if (usage !== 'comics' && usage !== 'general') return;
  onboarding.usage = usage;
  setPref('usage', usage);
}

export function nextOnboardingStep() {
  const steps = onboardingSteps();
  const i = steps.indexOf(onboarding.step);
  if (i < 0 || i >= steps.length - 1) return finishOnboarding();
  // The usage step cannot be passed without a pick, Enter included.
  if (onboarding.step === 'usage' && !onboarding.usage) return;
  onboarding.step = steps[i + 1];
}

export function prevOnboardingStep() {
  const steps = onboardingSteps();
  const i = steps.indexOf(onboarding.step);
  if (i > 0) onboarding.step = steps[i - 1];
}

// Every way out: Finish, Skip setup and Escape. Nothing is undone, and with
// no usage picked the stored one stands, which on a fresh install is
// 'comics', so skipping never hides a tool.
export function finishOnboarding() {
  onboarding.open = false;
  if (!prefs.onboarded) setPref('onboarded', true);
}
