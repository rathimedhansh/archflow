/**
 * Where the visitor is and where they can go in VR: room lookup, start point, room-to-room
 * stops, thumbstick mapping and the maths that places the play-space rig. Pure, no Three.js.
 *
 * World/plan coordinates: P2 = [x, z] in metres. A yaw of 0 looks toward -Z (the top of the
 * plan image); positive yaw turns left (counter-clockwise seen from above), as in Three.js.
 */
import type { SceneSpace } from "../geometry3d/types";
import { labelAnchor, pointInPolygon } from "../viewer/labelAnchor";
import { BODY_RADIUS, clearance, lineOfSight, rayDistance, type P2, type Segment } from "./collision";

/** The room containing `p`; the smallest one if outlines overlap. Null outside every room. */
export function roomAt(p: P2, spaces: readonly SceneSpace[]): SceneSpace | null {
  let best: SceneSpace | null = null;
  for (const s of spaces) {
    if (s.polygon.length >= 3 && pointInPolygon(p, s.polygon) && (!best || s.area < best.area)) best = s;
  }
  return best;
}

/** Forward direction (unit, plan coordinates) for a yaw. */
export const forwardOf = (yaw: number): P2 => [-Math.sin(yaw), -Math.cos(yaw)];
/** Yaw of a horizontal direction. */
export const yawOf = (dir: P2): number => Math.atan2(-dir[0], -dir[1]);

/** Rotate a plan point about the vertical axis (same convention as Object3D.rotation.y). */
export function rotateY(p: P2, yaw: number): P2 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [p[0] * c + p[1] * s, -p[0] * s + p[1] * c];
}

export interface RigPose {
  position: P2;
  yaw: number;
}

/**
 * Rig pose that puts the headset (tracked at `headLocal` with `headLocalYaw` inside the
 * play space) at `target`, looking along `targetYaw`. Used for the start point, room jumps,
 * teleports and snap turns, so the visitor always lands exactly where intended.
 */
export function placeRig(headLocal: P2, headLocalYaw: number, target: P2, targetYaw: number): RigPose {
  const yaw = targetYaw - headLocalYaw;
  const r = rotateY(headLocal, yaw);
  return { position: [target[0] - r[0], target[1] - r[1]], yaw };
}

/**
 * How far one can see from `p` along `dir` without leaving the property: up to the first wall,
 * and (when rooms are given) no further than where the line leaves every room, e.g. through an
 * exterior door. Sampled every 0.2 m.
 */
export function viewDepth(p: P2, dir: P2, segs: readonly Segment[], spaces: readonly SceneSpace[] = [], max = 30): number {
  const d = rayDistance(p, dir, segs, max);
  if (spaces.length === 0) return d;
  for (let t = 0.2; t < d; t += 0.2) {
    if (!roomAt([p[0] + dir[0] * t, p[1] + dir[1] * t], spaces)) return t;
  }
  return d;
}

/** Direction from `p` with the deepest view inside the property (16 compass directions, ties: first). */
export function bestViewYaw(p: P2, segs: readonly Segment[], spaces: readonly SceneSpace[] = []): number {
  let bestYaw = 0;
  let bestDist = -1;
  for (let i = 0; i < 16; i++) {
    const yaw = (i / 16) * Math.PI * 2;
    const d = viewDepth(p, forwardOf(yaw), segs, spaces);
    if (d > bestDist + 1e-9) {
      bestDist = d;
      bestYaw = yaw;
    }
  }
  return bestYaw;
}

export interface RoomStop {
  roomId: string;
  name: string;
  position: P2;
  yaw: number;
}

/** One standing point per room (its roomiest interior point), facing into the room. Plan order. */
export function roomStops(spaces: readonly SceneSpace[], segs: readonly Segment[]): RoomStop[] {
  return spaces
    .filter((s) => s.polygon.length >= 3)
    .map((s) => {
      const position = labelAnchor(s.polygon);
      return { roomId: s.id, name: s.name, position, yaw: bestViewYaw(position, segs, spaces) };
    });
}

/** Where a VR visit starts: inside the largest room. Falls back to the model centre. */
export function startStop(spaces: readonly SceneSpace[], segs: readonly Segment[], fallback: P2): RoomStop {
  const stops = roomStops(spaces, segs);
  if (stops.length === 0) return { roomId: "", name: "", position: fallback, yaw: bestViewYaw(fallback, segs, spaces) };
  let best = 0;
  for (let i = 1; i < stops.length; i++) {
    const area = (id: string) => spaces.find((s) => s.id === id)?.area ?? 0;
    if (area(stops[i].roomId) > area(stops[best].roomId)) best = i;
  }
  return stops[best];
}

/** Index of the stop after/before the room the visitor is in (wraps around). */
export function nextStopIndex(stops: readonly RoomStop[], currentRoomId: string | null, step: 1 | -1, lastIndex: number): number {
  if (stops.length === 0) return -1;
  const here = currentRoomId ? stops.findIndex((s) => s.roomId === currentRoomId) : -1;
  const base = here >= 0 ? here : lastIndex;
  if (base < 0) return step === 1 ? 0 : stops.length - 1;
  return (base + step + stops.length) % stops.length;
}

export const STICK_DEADZONE = 0.18;
/** Comfortable walking speed, metres per second. */
export const WALK_SPEED = 1.4;

/**
 * Thumbstick → horizontal movement for this frame, relative to where the head is looking.
 * Radial dead zone, rescaled so movement starts smoothly from zero.
 */
export function stickToMove(stick: readonly [number, number], headForward: P2, dt: number, speed = WALK_SPEED, deadzone = STICK_DEADZONE): P2 {
  const [x, y] = stick;
  const mag = Math.hypot(x, y);
  const fl = Math.hypot(headForward[0], headForward[1]);
  if (!(mag > deadzone) || !(fl > 1e-6) || !(dt > 0)) return [0, 0];
  const k = (Math.min(1, (mag - deadzone) / (1 - deadzone)) / mag) * speed * dt;
  const f: P2 = [headForward[0] / fl, headForward[1] / fl];
  const r: P2 = [-f[1], f[0]];
  // Stick up is negative y.
  return [(r[0] * x - f[0] * y) * k, (r[1] * x - f[1] * y) * k];
}

export const SNAP_ANGLE = Math.PI / 6;
const SNAP_FIRE = 0.7;
const SNAP_REARM = 0.3;

/** Snap turning: one 30° step per flick; the stick must return to centre before the next. */
export function snapTurn(x: number, armed: boolean): { turn: -1 | 0 | 1; armed: boolean } {
  if (armed && Math.abs(x) > SNAP_FIRE) return { turn: x > 0 ? 1 : -1, armed: false };
  if (!armed && Math.abs(x) < SNAP_REARM) return { turn: 0, armed: true };
  return { turn: 0, armed };
}

export const TELEPORT_MAX = 10;

/** Where a controller ray meets the floor (y = 0), or null if it points up or too far. */
export function rayToFloor(origin: readonly [number, number, number], dir: readonly [number, number, number], max = TELEPORT_MAX): P2 | null {
  if (!(dir[1] < -0.02) || !(origin[1] > 0)) return null;
  const t = -origin[1] / dir[1];
  const p: P2 = [origin[0] + dir[0] * t, origin[2] + dir[2] * t];
  if (Math.hypot(p[0] - origin[0], p[1] - origin[2]) > max) return null;
  return p;
}

/** A teleport is allowed onto a room floor that is in sight and not hard against a wall. */
export function teleportAllowed(from: P2, to: P2, spaces: readonly SceneSpace[], segs: readonly Segment[]): boolean {
  return roomAt(to, spaces) !== null && clearance(to, segs) >= BODY_RADIUS && lineOfSight(from, to, segs);
}

/** "Kitchen · 12.4 m²" ("≈" when the scale is not calibrated). */
export function roomCaption(space: Pick<SceneSpace, "name" | "area">, calibrated: boolean): string {
  return `${space.name} · ${calibrated ? "" : "≈ "}${space.area.toFixed(1)} m²`;
}
