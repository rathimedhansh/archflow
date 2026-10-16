import type { Point, Wall } from "./types";

export const dist = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const wallLength = (w: Pick<Wall, "start" | "end">) => dist(w.start, w.end);

/** Absolute polygon area (shoelace). */
export function polygonArea(poly: Point[]): number {
  let sum = 0;
  poly.forEach(([x1, y1], i) => {
    const [x2, y2] = poly[(i + 1) % poly.length];
    sum += x1 * y2 - x2 * y1;
  });
  return Math.abs(sum) / 2;
}

/** Area-weighted centroid; falls back to the vertex average for degenerate polygons. */
export function polygonCentroid(poly: Point[]): Point {
  let a = 0;
  let cx = 0;
  let cy = 0;
  poly.forEach(([x1, y1], i) => {
    const [x2, y2] = poly[(i + 1) % poly.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  });
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export interface SegmentHit {
  point: Point;
  /** Distance along the segment from `a`, in the segment's units. */
  along: number;
  distance: number;
}

export function closestPointOnSegment(p: Point, a: Point, b: Point): SegmentHit {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const point: Point = [a[0] + t * dx, a[1] + t * dy];
  return { point, along: t * Math.sqrt(len2), distance: dist(p, point) };
}

const orient = (a: Point, b: Point, c: Point) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSeg = (a: Point, b: Point, p: Point) =>
  Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
  Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);

/** True if segments ab and cd intersect (touching counts). */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return (
    (o1 === 0 && onSeg(a, b, c)) ||
    (o2 === 0 && onSeg(a, b, d)) ||
    (o3 === 0 && onSeg(c, d, a)) ||
    (o4 === 0 && onSeg(c, d, b))
  );
}

export function polygonSelfIntersects(poly: Point[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if ((j + 1) % n === i || (i + 1) % n === j) continue; // adjacent edges
      if (segmentsIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

export interface SnapOptions {
  /** Points that attract the cursor (wall endpoints, room vertices). */
  targets: Point[];
  /** Snap radius, in the same units as the points. */
  radius: number;
  /** When set, snap the direction from this point to horizontal/vertical if close. */
  orthoFrom?: Point;
  /** Angular tolerance for ortho snapping, in degrees. */
  orthoToleranceDeg?: number;
}

/** Snap to a nearby target point first; otherwise snap to horizontal/vertical from `orthoFrom`. */
export function snapPoint(raw: Point, opts: SnapOptions): { point: Point; snappedTo: "point" | "ortho" | null } {
  let best: Point | null = null;
  let bestD = opts.radius;
  for (const t of opts.targets) {
    const d = dist(raw, t);
    if (d <= bestD) {
      best = t;
      bestD = d;
    }
  }
  if (best) return { point: [best[0], best[1]], snappedTo: "point" };

  if (opts.orthoFrom) {
    const [fx, fy] = opts.orthoFrom;
    const dx = raw[0] - fx;
    const dy = raw[1] - fy;
    if (dx !== 0 || dy !== 0) {
      const tol = ((opts.orthoToleranceDeg ?? 6) * Math.PI) / 180;
      const angle = Math.atan2(Math.abs(dy), Math.abs(dx)); // 0 = horizontal, π/2 = vertical
      if (angle <= tol) return { point: [raw[0], fy], snappedTo: "ortho" };
      if (Math.PI / 2 - angle <= tol) return { point: [fx, raw[1]], snappedTo: "ortho" };
    }
  }
  return { point: raw, snappedTo: null };
}
