// ===== The first-run setup: is it open, and on which step =====
// Out here rather than in Onboarding.svelte because two places open it: the
// boot in App.svelte, once, for an install that was never set up, and
// Settings' "Run setup again". The screen reads this and changes it only
// through the functions below.
import { prefs, setPref } from '../prefs.svelte.js';
import { dataFolder } from '../data-folder.svelte.js';

// The steps, in order. Detection is asked only of a comics install: general
// use hides detection, so asking about it would be asking about nothing.
// "Join" (SHARED_DATA_FOLDER.md section 5.5) is asked only on a first launch
// that finds Manga Cleaner's data folder (row C), before the models.
const COMICS_STEPS = ['welcome', 'theme', 'scope', 'usage', 'join', 'detection', 'community'];
const GENERAL_STEPS = COMICS_STEPS.filter((s) => s !== 'detection');

// `usage` is what was picked on the usage step during this run, or null
// before a pick. It is kept apart from `prefs.usage`, which is 'comics' on a
// fresh install whether or not anyone chose it, so Continue can wait for a
// real pick.
// `join`: this run asks the Join step (fixed when it opens, so answering it
// does not take the step out from under the person). `joined`: answered.
export const onboarding = $state({ open: false, step: 'welcome', usage: null, join: false, joined: false });

// The steps of the path the current pick puts the person on. Before a pick
// that is the shorter path, so the progress bar grows by one when Comics is
// picked rather than shrinking when General use is.
export function onboardingSteps() {
  const steps = onboarding.usage === 'comics' ? COMICS_STEPS : GENERAL_STEPS;
  return onboarding.join ? steps : steps.filter((s) => s !== 'join');
}

// Open the setup on its first step. Without `force` it opens only for an
// install that has not been set up; Settings passes `force` to walk through it
// again. Returns whether it opened.
export function offerOnboarding({ force = false } = {}) {
  if (!force && prefs.onboarded) return false;
  onboarding.step = 'welcome';
  // A second run has a usage on record already, so that row starts picked.
  // So does a first run that was quit after picking General use: 'general'
  // is never a default, so it can only be a pick, and it is already in
  // effect. Without this the row would show nothing picked while the app
  // hides the comic tools, and Skip would keep that choice unseen.
  onboarding.usage = force || prefs.usage === 'general' ? prefs.usage : null;
  onboarding.join = dataFolder.start === 'joinStep';
  onboarding.joined = false;
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
  // The usage step cannot be passed without a pick, Enter included, nor
  // the Join step without an answer.
  if (onboarding.step === 'usage' && !onboarding.usage) return;
  if (onboarding.step === 'join' && !onboarding.joined) return;
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
