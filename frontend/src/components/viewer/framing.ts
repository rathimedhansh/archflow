import type { SceneBounds, V3 } from "@/lib/geometry3d";

/** Vertical field of view, degrees. */
export const FOV_DEG = 45;

export interface Framing {
  center: V3;
  /** Radius of a sphere enclosing the model. */
  radius: number;
  near: number;
  far: number;
  minDistance: number;
  maxDistance: number;
}

export interface CameraPose {
  position: V3;
  target: V3;
}

export type ViewName = "overview" | "top";

/**
 * The default "dollhouse" angle: from the front-right, about 50 degrees above the ground.
 * Steep enough to see into the rooms over the front walls, low enough to read the walls as 3D.
 */
const OVERVIEW_DIR: V3 = (() => {
  const d: V3 = [0.55, 1.1, 0.75];
  const len = Math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2);
  return [d[0] / len, d[1] / len, d[2] / len];
})();

const rad = (deg: number) => (deg * Math.PI) / 180;
const safeAspect = (aspect: number) => (Number.isFinite(aspect) && aspect > 0.05 ? aspect : 1);

/** tan of half the horizontal and vertical FOV for a given aspect ratio. */
function halfTans(aspect: number): { h: number; v: number } {
  const v = Math.tan(rad(FOV_DEG) / 2);
  return { v, h: v * safeAspect(aspect) };
}

/** Distance at which a sphere of `radius` fits the view both vertically and horizontally. */
export function fitDistance(radius: number, aspect: number): number {
  const { h, v } = halfTans(aspect);
  const halfFov = Math.atan(Math.min(h, v));
  return radius / Math.sin(halfFov);
}

/** Camera limits and anchor points that scale with the model, in metres. Independent of the view size. */
export function computeFraming(bounds: SceneBounds): Framing {
  const { min, max } = bounds;
  const center: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const size: V3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const radius = Math.max(0.5 * Math.sqrt(size[0] ** 2 + size[1] ** 2 + size[2] ** 2), 1);
  return {
    center,
    radius,
    near: Math.max(0.05, radius / 200),
    far: radius * 60,
    minDistance: Math.max(0.5, radius * 0.15),
    maxDistance: radius * 12,
  };
}

/** Camera pose that shows the whole property, for a viewport of the given aspect ratio (width / height). */
export function viewPose(bounds: SceneBounds, view: ViewName, aspect: number): CameraPose {
  const f = computeFraming(bounds);
  const [cx, cy, cz] = f.center;
  if (view === "top") {
    // Straight down (a hair off vertical so "up" on screen is well defined: -Z, the top of the plan image).
    const { h, v } = halfTans(aspect);
    const width = bounds.max[0] - bounds.min[0];
    const depth = bounds.max[2] - bounds.min[2];
    const dist = Math.max(width / 2 / h, depth / 2 / v, 1) * 1.12 + bounds.max[1];
    return { position: [cx, dist, cz + dist * 1e-3], target: [cx, 0, cz] };
  }
  const d = fitDistance(f.radius, aspect);
  return {
    position: [cx + OVERVIEW_DIR[0] * d, cy + OVERVIEW_DIR[1] * d, cz + OVERVIEW_DIR[2] * d],
    target: [cx, cy, cz],
  };
}

/** Pose that frames one room (plan polygon in metres, ceiling height) from the overview angle. */
export function roomPose(polygon: readonly (readonly [number, number])[], height: number, aspect: number): CameraPose {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of polygon) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  if (!Number.isFinite(minX)) return { position: [5, 5, 5], target: [0, 0, 0] };
  const target: V3 = [(minX + maxX) / 2, height * 0.3, (minZ + maxZ) / 2];
  // Sphere around the target that still contains the room's top corners (target sits low, at 0.3 h).
  const radius = Math.max(Math.sqrt(((maxX - minX) / 2) ** 2 + ((maxZ - minZ) / 2) ** 2 + (height * 0.7) ** 2), 1);
  // Steeper than the overview (about 62 degrees) so the room's own walls hide little of its floor.
  const dir: V3 = [OVERVIEW_DIR[0] * 0.8, OVERVIEW_DIR[1] * 1.25, OVERVIEW_DIR[2] * 0.8];
  const len = Math.sqrt(dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2);
  const d = fitDistance(radius, aspect) * 1.05;
  return { position: [target[0] + (dir[0] / len) * d, target[1] + (dir[1] / len) * d, target[2] + (dir[2] / len) * d], target };
}

/** Move the camera along its line of sight; `factor` < 1 zooms in. Clamped to the orbit limits. */
export function dollyPose(pose: CameraPose, factor: number, minDistance: number, maxDistance: number): CameraPose {
  const off: V3 = [pose.position[0] - pose.target[0], pose.position[1] - pose.target[1], pose.position[2] - pose.target[2]];
  const dist = Math.sqrt(off[0] ** 2 + off[1] ** 2 + off[2] ** 2) || 1;
  const next = Math.min(maxDistance, Math.max(minDistance, dist * factor));
  const k = next / dist;
  return { target: pose.target, position: [pose.target[0] + off[0] * k, pose.target[1] + off[1] * k, pose.target[2] + off[2] * k] };
}
