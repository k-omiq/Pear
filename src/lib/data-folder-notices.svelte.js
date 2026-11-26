// ===== One-time data folder notices (SHARED_DATA_FOLDER.md 5.2, 7) =====
// "Your library now lives in ~/Manga Library." after a quiet setup, and what
// the recovery of a stopped move did. Not passing toasts: a notice stays
// until the user closes it (or presses Show), no toast replaces it, and it
// is drawn only once the first-run setup is closed. It counts as shown once
// it was on screen: until then it is kept in localStorage, so a quit before
// that shows it at the next start.

const KEY = 'mt.dataFolderNotices';

// [{ id, text, reveal }]: `reveal` is a folder "Show" opens, or null.
export const notices = $state({ items: [] });

function readPending() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((n) => n && typeof n.id === 'string' && typeof n.text === 'string') : [];
  } catch {
    return [];
  }
}
function writePending(list) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {
    /* a notice lost at a quit is not worth an error */
  }
}

// At start: the notices not yet seen at the last run.
export function loadNotices() {
  for (const n of readPending()) if (!notices.items.some((x) => x.id === n.id)) notices.items = [...notices.items, n];
}

export function addNotice({ id, text, reveal = null }) {
  if (!text || notices.items.some((n) => n.id === id)) return;
  const n = { id, text: String(text), reveal: reveal ? String(reveal) : null };
  notices.items = [...notices.items, n];
  writePending([...readPending().filter((x) => x.id !== id), n]);
}

// It was on screen: it is not shown again at the next start.
export function markNoticeSeen(id) {
  writePending(readPending().filter((x) => x.id !== id));
}

export function dismissNotice(id) {
  notices.items = notices.items.filter((n) => n.id !== id);
  markNoticeSeen(id);
}

export function _resetNoticesForTests() {
  notices.items = [];
  writePending([]);
}
