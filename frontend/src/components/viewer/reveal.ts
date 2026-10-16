import type { V3 } from "@/lib/geometry3d";
import type { CameraPose } from "./framing";

/** Length of the opening camera move, ms (at normal frame rates). */
export const REVEAL_MS = 2000;
/** Start of the move: swung this far round the model (radians, about 30 degrees)... */
const SWING = -0.52;
/** ...this much lower (radians from vertical, about 16 degrees; the camera then rises)... */
const RISE = 0.28;
/** ...and this much farther away, so the whole model stays in view on the lower, wider path. */
const PULL = 0.12;

/** Gentle start and finish. */
export function revealEase(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Camera pose `k` (0..1, already eased) of the way along the opening move that ends exactly at
 * `end`: an arc around the target that swings sideways while rising to the end elevation.
 * The target never moves, so the model stays centred the whole time.
 */
export function revealPose(end: CameraPose, k: number): CameraPose {
  if (k >= 1) return end;
  const [tx, ty, tz] = end.target;
  const off: V3 = [end.position[0] - tx, end.position[1] - ty, end.position[2] - tz];
  const dist = Math.hypot(off[0], off[1], off[2]) || 1;
  const polar = Math.acos(Math.min(1, Math.max(-1, off[1] / dist)));
  const azimuth = Math.atan2(off[0], off[2]);
  const rest = 1 - Math.max(0, k);
  const p = polar + RISE * rest;
  const a = azimuth + SWING * rest;
  const d = dist * (1 + PULL * rest);
  return {
    position: [tx + d * Math.sin(p) * Math.sin(a), ty + d * Math.cos(p), tz + d * Math.sin(p) * Math.cos(a)],
    target: end.target,
  };
}
