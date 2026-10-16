import type { SceneBounds, V3 } from "@/lib/geometry3d";
import type { ProtectedView } from "@/lib/viewer/environment";
import { viewPose } from "../framing";
import { revealPose } from "../reveal";

/** Viewport shapes the default view must stay clear for: wide desktop to a portrait phone. */
export const DESKTOP_ASPECTS = [2.2, 16 / 9, 1.35, 1];
export const PHONE_ASPECTS = [0.75, 0.46];
/** Orbit sweep around the default view, degrees between samples (desktop distance and height). */
const ORBIT_STEP_DEG = 10;

/** Points of the house that must stay visible: the box corners, the middle and the top centre. */
export function houseTargets(bounds: SceneBounds): V3[] {
  const { min, max } = bounds;
  const out: V3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
  const c: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  out.push(c, [c[0], max[1], c[2]]);
  return out;
}

/**
 * Camera positions from which the surroundings may never hide the house: the default overview
 * and the start of the opening reveal at every viewport shape, plus a full orbit around the
 * model at the desktop overview's distance and height.
 */
export function protectedViews(bounds: SceneBounds): ProtectedView[] {
  const targets = houseTargets(bounds);
  const views: ProtectedView[] = [];
  for (const aspect of [...DESKTOP_ASPECTS, ...PHONE_ASPECTS]) {
    const pose = viewPose(bounds, "overview", aspect);
    views.push({ position: pose.position, targets }, { position: revealPose(pose, 0).position, targets });
  }
  const base = viewPose(bounds, "overview", 1);
  const [tx, ty, tz] = base.target;
  const off: V3 = [base.position[0] - tx, base.position[1] - ty, base.position[2] - tz];
  const horizontal = Math.hypot(off[0], off[2]);
  for (let deg = 0; deg < 360; deg += ORBIT_STEP_DEG) {
    const a = (deg * Math.PI) / 180;
    views.push({ position: [tx + horizontal * Math.sin(a), ty + off[1], tz + horizontal * Math.cos(a)], targets });
  }
  return views;
}
