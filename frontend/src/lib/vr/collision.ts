/**
 * Walking collision for VR, derived from the geometry the engine already produced: the wall and
 * window meshes are sliced horizontally into 2D segments (plan coordinates, metres). Door holes
 * are cut out of the walls, so doorways stay open; windows and their glass stay solid.
 *
 * Pure and deterministic. A point is [x, z] in world space (= [x, y] of the FloorPlan).
 */
import type { MeshData, Scene3D } from "../geometry3d/types";

export type P2 = [number, number];
export interface Segment {
  a: P2;
  b: P2;
}

/** Heights at which walls are sliced: below a typical sill (knee) and at chest height. */
export const SLICE_HEIGHTS = [0.35, 1.1] as const;
/** The walker is a circle of this radius (metres) around the head. */
export const BODY_RADIUS = 0.2;

const MIN_SEGMENT = 1e-4;

/** Intersection of every triangle of `mesh` with the horizontal plane y = h. */
export function sliceMesh(mesh: MeshData, h: number): Segment[] {
  const { positions: p, indices } = mesh;
  const out: Segment[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const pts: P2[] = [];
    for (let e = 0; e < 3; e++) {
      const i = indices[t + e] * 3;
      const j = indices[t + ((e + 1) % 3)] * 3;
      const di = p[i + 1] - h;
      const dj = p[j + 1] - h;
      // Strict sign change: a vertex exactly on the plane counts as "above" (no double points).
      if (di >= 0 === dj >= 0) continue;
      const k = di / (di - dj);
      pts.push([p[i] + (p[j] - p[i]) * k, p[i + 2] + (p[j + 2] - p[i + 2]) * k]);
    }
    if (pts.length === 2 && Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) > MIN_SEGMENT) {
      out.push({ a: pts[0], b: pts[1] });
    }
  }
  return out;
}

/** Everything a walker cannot pass: walls and windows (frames and glass). Doors stay open. */
export function buildColliders(scene: Scene3D, heights: readonly number[] = SLICE_HEIGHTS): Segment[] {
  const segs: Segment[] = [];
  for (const o of scene.objects) {
    if (o.kind !== "wall" && o.kind !== "window") continue;
    for (const h of heights) segs.push(...sliceMesh(o.mesh, h));
  }
  return segs;
}

export function closestOnSegment(p: P2, s: Segment): P2 {
  const dx = s.b[0] - s.a[0];
  const dz = s.b[1] - s.a[1];
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dz) / len2));
  return [s.a[0] + t * dx, s.a[1] + t * dz];
}

/** Distance from `p` to the nearest collider (Infinity when there are none). */
export function clearance(p: P2, segs: readonly Segment[]): number {
  let best = Infinity;
  for (const s of segs) {
    const c = closestOnSegment(p, s);
    best = Math.min(best, Math.hypot(p[0] - c[0], p[1] - c[1]));
  }
  return best;
}

const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Proper intersection of segment p→q with s (touching at an end point does not count). */
export function segmentsCross(p: P2, q: P2, s: Segment): boolean {
  const d1 = cross(s.a, s.b, p);
  const d2 = cross(s.a, s.b, q);
  const d3 = cross(p, q, s.a);
  const d4 = cross(p, q, s.b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True when nothing solid lies on the straight line between a and b. */
export function lineOfSight(a: P2, b: P2, segs: readonly Segment[]): boolean {
  return !segs.some((s) => segmentsCross(a, b, s));
}

/** Distance along a ray from `origin` (unit `dir`) to the first collider, capped at `max`. */
export function rayDistance(origin: P2, dir: P2, segs: readonly Segment[], max: number): number {
  let best = max;
  for (const s of segs) {
    const ex = s.b[0] - s.a[0];
    const ez = s.b[1] - s.a[1];
    const den = dir[0] * ez - dir[1] * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = s.a[0] - origin[0];
    const wz = s.a[1] - origin[1];
    const t = (wx * ez - wz * ex) / den; // along the ray
    const u = (wx * dir[1] - wz * dir[0]) / den; // along the segment
    if (t >= 0 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}

/**
 * Move a circle of `radius` from `from` by `delta`, sliding along walls instead of passing
 * through them. Sub-stepped so a fast move cannot tunnel through a thin wall, and a final
 * line-of-sight check refuses any step that would still cross a collider.
 */
export function resolveMove(from: P2, delta: P2, segs: readonly Segment[], radius = BODY_RADIUS): P2 {
  const len = Math.hypot(delta[0], delta[1]);
  if (!(len > 0) || !Number.isFinite(len)) return [from[0], from[1]];
  const steps = Math.max(1, Math.ceil(len / (radius * 0.5)));
  let p: P2 = [from[0], from[1]];
  for (let s = 0; s < steps; s++) {
    const prev: P2 = p;
    let next: P2 = [p[0] + delta[0] / steps, p[1] + delta[1] / steps];
    for (let iter = 0; iter < 4; iter++) {
      let pushed = false;
      for (const seg of segs) {
        const c = closestOnSegment(next, seg);
        const dx = next[0] - c[0];
        const dz = next[1] - c[1];
        const d = Math.hypot(dx, dz);
        if (d >= radius || d === 0) continue;
        next = [c[0] + (dx / d) * radius, c[1] + (dz / d) * radius];
        pushed = true;
      }
      if (!pushed) break;
    }
    if (!lineOfSight(prev, next, segs)) return prev;
    p = next;
  }
  return p;
}
