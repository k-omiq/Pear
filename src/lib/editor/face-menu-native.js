// ===== The menu on selected words, as the system's popup =====
// In the desktop app a right-click on selected words gets the system's own
// menu, as a right-click on any text does: Cut, Copy and Paste, then the face
// commands with their keys (face-menu-items.js). Built from the Tauri menu API
// the app already uses for its application menu (App.svelte); no plugin.
//
// Cut, Copy and Paste are the system's predefined items where they work. Tauri
// draws menus with muda, built without its `libxdo` feature, so on Linux a
// predefined Cut/Copy/Paste does nothing when chosen (muda's GTK items send
// the key through libxdo, and only on X11). There Cut and Copy are items of
// ours that run the browser's own command on the selection - which reaches
// the box's `oncopy`/`oncut`, as the keys do - and there is no Paste: a page
// cannot read the clipboard on its own.
//
// The words stay selected however the menu closes: the focus and the
// selection go back to the box when they have gone (focus.js).

import { captureFocus } from '../focus.js';
import { endEditIfAway } from '../typing-selection.svelte.js';
import { faceMenuTarget, faceMenuItems, comboAccelerator } from './face-menu-items.js';

export const isDesktopApp = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
const platform = () => (/Mac/i.test(navigator.userAgent) ? 'mac' : /Windows/i.test(navigator.userAgent) ? 'windows' : 'linux');

// The last menu made, kept until the next one: a chosen item's action arrives
// after the popup has returned, and a menu closed by then drops it.
let last = null;

export async function popFaceMenu() {
  const t = faceMenuTarget();
  if (!t) return false;
  const restore = captureFocus();
  // The words come back unless the focus went on to a control that keeps the
  // edit (the Inspector's family list, opened by Typeface…). Back in the box
  // with the focus is not enough: the system may have let the selection go.
  const back = () => {
    const at = document.activeElement;
    if (!at?.closest?.('[data-keeps-edit]')) restore();
  };
  const { Menu, MenuItem, CheckMenuItem, PredefinedMenuItem } = await import('@tauri-apps/api/menu');
  const own = async (id, text, kind) =>
    MenuItem.new({
      id,
      text,
      accelerator: kind === 'cut' ? 'CmdOrCtrl+X' : 'CmdOrCtrl+C',
      action: () => {
        back();
        document.execCommand(kind);
      },
    });
  const edit =
    platform() === 'linux'
      ? [await own('mt-face-cut', 'Cut', 'cut'), await own('mt-face-copy', 'Copy', 'copy')]
      : [await PredefinedMenuItem.new({ item: 'Cut' }), await PredefinedMenuItem.new({ item: 'Copy' }), await PredefinedMenuItem.new({ item: 'Paste' })];
  const faces = [];
  for (const it of faceMenuItems(t)) {
    const text = it.checked === 'mixed' ? `${it.label} (mixed)` : it.note ? `${it.label} (${it.note})` : it.label;
    const opts = { id: `mt-face-${it.id}`, text, enabled: it.ok, action: () => it.run() };
    const accelerator = comboAccelerator(it.combo);
    const make = (o) => (it.checked != null ? CheckMenuItem.new({ ...o, checked: it.checked === true }) : MenuItem.new(o));
    // A key the system will not take is left off rather than losing the item.
    faces.push(await make(accelerator ? { ...opts, accelerator } : opts).catch(() => make(opts)));
  }
  const menu = await Menu.new({ items: [...edit, await PredefinedMenuItem.new({ item: 'Separator' }), ...faces] });
  const old = last;
  last = menu;
  old?.close?.().catch?.(() => {});
  try {
    await menu.popup();
  } finally {
    back();
    endEditIfAway();
  }
  return true;
}
