// ===== What the data folder screens say =====
// Plain words for paths, sizes, times and errors (SHARED_DATA_FOLDER.md
// sections 5.4 and 11). No state: the dialog, Settings, the cards and the
// toasts all say things the same way.

// A path as the user should see it: never with the Windows `\\?\` (or
// `\\?\UNC\`) prefix Rust's canonical paths carry.
export function shownPath(p) {
  const s = String(p ?? '');
  if (s.startsWith('\\\\?\\UNC\\')) return `\\\\${s.slice(8)}`;
  if (s.startsWith('\\\\?\\')) return s.slice(4);
  return s;
}

// The same for every path inside a sentence (a recovery note, a reason).
export function shownText(text) {
  return String(text ?? '')
    .replace(/\\\\\?\\UNC\\/g, '\\\\')
    .replace(/\\\\\?\\/g, '');
}

// `~/Manga Library` for a path in the home folder.
export function homePath(p, home) {
  const s = shownPath(p);
  const h = shownPath(home).replace(/[\\/]+$/, '');
  if (!h || !s) return s;
  if (s === h) return '~';
  if (s.startsWith(`${h}/`) || s.startsWith(`${h}\\`)) return `~${s.slice(h.length).replace(/\\/g, '/')}`;
  return s;
}

// "9.7 GB", "120 MB": decimal units, as the drives are sold.
export function sizeText(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.ceil(b / 1e6))} MB`;
}

// A copy runs at about 20 MB/s; the time is rounded up to whole minutes.
export const COPY_RATE = 20e6;
export function minutesText(bytes) {
  const m = Math.max(1, Math.ceil((Math.max(0, Number(bytes) || 0) / COPY_RATE) / 60));
  return `about ${m} minute${m === 1 ? '' : 's'}`;
}

// The dialog's line that says what will happen (section 5.4). `plan` is
// Rust's { hasLibrary, bytes, sameVolume }; `kind` 'setup' or 'join'.
export function whatHappens(kind, plan) {
  if (!plan?.hasLibrary) return 'Nothing to move.';
  const size = sizeText(plan.bytes);
  if (kind === 'join') {
    const lead = 'Manga Cleaner already uses this folder.';
    return plan.sameVolume
      ? `${lead} Your library (${size}) moves in next to it.`
      : `${lead} Your library (${size}) is copied in next to it. It takes ${minutesText(plan.bytes)}.`;
  }
  return plan.sameVolume
    ? 'Your library moves there. It takes a moment.'
    : `Your library (${size}) is copied there. It takes ${minutesText(plan.bytes)}.`;
}

// "Copying 5.5 of 9.7 GB".
export function copyingText(done, total) {
  if (total >= 1e9) return `Copying ${(done / 1e9).toFixed(1)} of ${(total / 1e9).toFixed(1)} GB`;
  return `Copying ${Math.floor(done / 1e6)} of ${Math.max(1, Math.ceil(total / 1e6))} MB`;
}

const PLAIN = [
  [/no space left|not enough space|disk full|quota exceeded|ENOSPC|os error 112\b|os error 28\b/i, 'There is not enough free space on that drive.'],
  [/permission denied|operation not permitted|access is denied|read-only file system|EACCES|EPERM|EROFS/i, 'This app is not allowed to write there.'],
  [/device not configured|no such device|input\/output error|device is not ready|network (?:path|name) was not found|not connected|ENXIO|ENODEV|\bEIO\b|os error 21\b/i, 'The drive was disconnected.'],
  [/being used by another process|resource busy|text file busy|sharing violation|lock violation|EBUSY|ETXTBSY|os error 32\b|os error 33\b/i, 'A file is in use by another app.'],
];

// A move or setup error in plain words (section 11). The common system
// errors map to a sentence; any other system error is "The move could not
// finish." The app's own refusals ("Close Manga Cleaner first.") are plain
// already and stay. The raw text goes to the log, never to the screen.
export function plainError(e) {
  const raw = String(e?.message ?? e ?? '');
  const text = raw.replace(/^(?:CANNOT_TELL|BOTH_LIBRARIES):\s*/, '').trim();
  for (const [re, words] of PLAIN) {
    if (re.test(text)) {
      if (words !== text) console.warn('[data folder]', raw);
      return words;
    }
  }
  if (/os error -?\d+/i.test(text) || /\bat line \d+ column \d+/.test(text)) {
    console.warn('[data folder]', raw);
    return 'The move could not finish.';
  }
  return shownText(text) || 'The move could not finish.';
}
