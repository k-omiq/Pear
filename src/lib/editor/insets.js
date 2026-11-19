// How wide the raw sidebar (left) and the docked column (right) are drawn, so
// the page between them keeps room to be read. Each keeps the width the user
// set while there is room for it; this only decides what is SHOWN, never what
// is stored, so a window made bigger again gets the user's widths back.
//
// The dock gives way first (down to DOCK_FLOOR), then the sidebar (down to
// SIDE_FLOOR). A window too small for even that shrinks both alike, and the
// page never goes below zero.

export const PAGE_MIN = 360;
export const DOCK_FLOOR = 240;
export const SIDE_FLOOR = 160;
// The page's last strip in a window too small for the floors.
const PAGE_LAST = 120;

export function fitInsets({ vw, rail = 0, side = 0, dock = 0 }) {
  side = Math.max(0, side || 0);
  dock = Math.max(0, dock || 0);
  const room = Math.max(0, vw - rail - PAGE_MIN);
  if (side + dock <= room) return { side, dock };
  const dockFloor = Math.min(dock, DOCK_FLOOR);
  const sideFloor = Math.min(side, SIDE_FLOOR);
  dock = Math.max(dockFloor, room - side);
  if (side + dock > room) side = Math.max(sideFloor, room - dock);
  const last = Math.max(0, vw - rail - PAGE_LAST);
  if (side + dock > last) {
    const k = side + dock > 0 ? last / (side + dock) : 0;
    side *= k;
    dock *= k;
  }
  return { side: Math.round(side), dock: Math.round(dock) };
}
