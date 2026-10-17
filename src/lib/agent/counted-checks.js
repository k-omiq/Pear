// Pure page checks: all geometry is in page pixels; tags are supplied by the caller.
const boxesOf = (p) => (Array.isArray(p?.boxes) ? p.boxes : []);

/** [x, y] corners in TL, TR, BR, BL order before clockwise rotation (page y down).
 * Invalid or non-positive rectangles have no corners.
 */
export function boxCorners(b) {
  if (!b || ![b.x, b.y, b.w, b.h].every(Number.isFinite) || b.w <= 0 || b.h <= 0) return [];
  const rotation = Number.isFinite(b.style?.rotation) ? b.style.rotation : 0;
  const angle = ((rotation % 360) * Math.PI) / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return [
    [-b.w / 2, -b.h / 2], [b.w / 2, -b.h / 2],
    [b.w / 2, b.h / 2], [-b.w / 2, b.h / 2],
  ].map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
}

function overlapDepth(a, b) {
  let depth = Infinity;
  // Two edge normals per rectangle cover all separating axes. Normalize them
  // so the minimum translation needed to separate the pair is measured in px.
  for (const rect of [a, b]) {
    for (let i = 0; i < 2; i++) {
      const dx = rect[i + 1][0] - rect[i][0], dy = rect[i + 1][1] - rect[i][1];
      const length = Math.hypot(dx, dy);
      const nx = -dy / length, ny = dx / length;
      const ap = a.map(([x, y]) => x * nx + y * ny);
      const bp = b.map(([x, y]) => x * nx + y * ny);
      // Use the distance to either separating edge, including when one
      // projected interval contains the other.
      const overlap = Math.min(Math.max(...ap) - Math.min(...bp), Math.max(...bp) - Math.min(...ap));
      if (overlap <= 0) return 0;
      depth = Math.min(depth, overlap);
    }
  }
  return depth;
}

/** One row per pair in page order. `overlap` is SAT penetration depth in px,
 * i.e. the shortest translation that separates the rotated rectangles.
 * Touching rectangles do not collide, even with minOverlap: 0.
 */
export function boxCollisions(p, { minOverlap = 4 } = {}) {
  const boxes = boxesOf(p).map((b) => ({ b, corners: boxCorners(b) })).filter(({ corners }) => corners.length);
  const collisions = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const overlap = overlapDepth(boxes[i].corners, boxes[j].corners);
      if (overlap > 0 && overlap > minOverlap) {
        collisions.push({ boxId: boxes[i].b.id, other: boxes[j].b.id, overlap });
      }
    }
  }
  return collisions;
}

/** Detector panels are [x0, y0, x1, y1] (detect/analyze.rs:63).
 * Report each panel containing the box centre whose edge a corner exceeds.
 */
export function panelCrossings(p, { tolerance = 3 } = {}) {
  const panels = Array.isArray(p?.detect?.panels) ? p.detect.panels : [];
  const crossings = [];
  for (const b of boxesOf(p)) {
    const corners = boxCorners(b);
    if (!corners.length) continue;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    panels.forEach((panel, index) => {
      if (!Array.isArray(panel) || panel.length !== 4 || !panel.every(Number.isFinite)) return;
      const [x0, y0, x1, y1] = panel;
      if (x1 <= x0 || y1 <= y0 || cx < x0 || cx > x1 || cy < y0 || cy > y1) return;
      if (corners.some(([x, y]) => x0 - x > tolerance || x - x1 > tolerance || y0 - y > tolerance || y - y1 > tolerance)) {
        crossings.push({ boxId: b.id, panel: index });
      }
    });
  }
  return crossings;
}

/** Group finite numeric sizes by their first caller-supplied tag; tags in `skip` are not checked. */
export function sizeOutliers(p, tagsOf = () => [], { ratio = 1.35, minGroup = 3, skip = [] } = {}) {
  const groups = new Map();
  for (const b of boxesOf(p)) {
    const size = b?.style?.size;
    if (!Number.isFinite(size)) continue;
    const tag = tagsOf(b)?.[0] ?? 'untagged';
    if (skip.includes(tag)) continue;
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push({ boxId: b.id, size });
  }
  const outliers = [];
  for (const [tag, group] of groups) {
    if (group.length < minGroup) continue;
    const sizes = group.map(({ size }) => size).sort((a, b) => a - b);
    const middle = Math.floor(sizes.length / 2);
    const median = sizes.length % 2 ? sizes[middle] : (sizes[middle - 1] + sizes[middle]) / 2;
    for (const { boxId, size } of group) {
      if (size / median > ratio || median / size > ratio) outliers.push({ boxId, size, median, tag });
    }
  }
  return outliers;
}

/** opts shares minOverlap, tolerance, ratio and minGroup across the checks. */
export function countedChecks(p, tagsOf, opts) {
  return {
    collisions: boxCollisions(p, opts),
    panels: panelCrossings(p, opts),
    sizes: sizeOutliers(p, tagsOf, opts),
  };
}
