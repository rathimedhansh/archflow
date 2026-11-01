/**
 * Where a visitor may stand and walk, shared by the desktop walk-through and VR so both follow
 * one collision policy. Built once per scene from the engine's own output (see collision.ts):
 *
 * - `walls`: the wall/window colliders sliced from the generated meshes (door holes are open).
 * - `colliders`: the walls plus the model's outer bounds, so walking out through an exterior
 *   door ends on the threshold instead of leading off into the void.
 *
 * Pure and deterministic, no Three.js. Points are [x, z] in world metres (= FloorPlan [x, y]).
 */
import type { Scene3D, SceneSpace } from "../geometry3d/types";
import { labelAnchor } from "../viewer/labelAnchor";
import { BODY_RADIUS, buildColliders, clearance, resolveMove, type P2, type Segment } from "./collision";
import { bestViewYaw, roomAt, type RoomStop } from "./navigation";

export interface NavigationModel {
  /** Walls and windows only: used for views (start direction, room stops). */
  walls: Segment[];
  /** Walls, windows and the model's boundary: used for every movement step. */
  colliders: Segment[];
  spaces: readonly SceneSpace[];
  /** Plan-space rectangle of the whole model (walls and floors). */
  bounds: { min: P2; max: P2 };
  /** Fallback centre when the model has no rooms. */
  centre: P2;
}

/** A spawn point must keep a little more than the body radius from every collider. */
export const SPAWN_CLEARANCE = BODY_RADIUS + 0.05;
/** Standing eye height (metres above the floor), lowered under unusually low ceilings. */
export const EYE_HEIGHT = 1.6;
const MIN_EYE_HEIGHT = 1.0;
const HEAD_ROOM = 0.3;

function boundarySegments(min: P2, max: P2): Segment[] {
  const a: P2 = [min[0], min[1]];
  const b: P2 = [max[0], min[1]];
  const c: P2 = [max[0], max[1]];
  const d: P2 = [min[0], max[1]];
  return [{ a, b }, { a: b, b: c }, { a: c, b: d }, { a: d, b: a }];
}

export function buildNavigation(scene: Scene3D): NavigationModel {
  const walls = buildColliders(scene);
  const min: P2 = [scene.bounds.min[0], scene.bounds.min[2]];
  const max: P2 = [scene.bounds.max[0], scene.bounds.max[2]];
  const finite = [...min, ...max].every(Number.isFinite) && max[0] > min[0] && max[1] > min[1];
  return {
    walls,
    colliders: finite ? [...walls, ...boundarySegments(min, max)] : walls,
    spaces: scene.spaces,
    bounds: { min, max },
    centre: finite ? [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2] : [0, 0],
  };
}

const cache = new WeakMap<Scene3D, NavigationModel>();
/** One navigation model per scene object, shared by every mode that walks in it. */
export function navigationFor(scene: Scene3D): NavigationModel {
  let nav = cache.get(scene);
  if (!nav) {
    nav = buildNavigation(scene);
    cache.set(scene, nav);
  }
  return nav;
}

/**
 * One walking step: slide along walls, never through them, never out of the model. The only
 * movement rule; desktop and VR both call it. Invalid input leaves the walker where it was.
 */
export function walkStep(nav: NavigationModel, from: P2, delta: P2): P2 {
  if (!Number.isFinite(from[0]) || !Number.isFinite(from[1])) return from;
  const to = resolveMove(from, delta, nav.colliders);
  return Number.isFinite(to[0]) && Number.isFinite(to[1]) ? to : from;
}

/** Inside the model's bounds and clear of every wall by at least `SPAWN_CLEARANCE`. */
export function isStandable(nav: NavigationModel, p: P2): boolean {
  if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
  const { min, max } = nav.bounds;
  if (p[0] < min[0] + SPAWN_CLEARANCE || p[0] > max[0] - SPAWN_CLEARANCE) return false;
  if (p[1] < min[1] + SPAWN_CLEARANCE || p[1] > max[1] - SPAWN_CLEARANCE) return false;
  return clearance(p, nav.colliders) >= SPAWN_CLEARANCE;
}

const RING_STEP = 0.15;
const RING_MAX = 3;
const RING_DIRECTIONS = 16;

/** The first standable point at `origin` or on rings around it (fixed order), accepted by `inside`. */
function searchNear(nav: NavigationModel, origin: P2, inside: (p: P2) => boolean): P2 | null {
  if (inside(origin) && isStandable(nav, origin)) return origin;
  for (let r = RING_STEP; r <= RING_MAX + 1e-9; r += RING_STEP) {
    for (let i = 0; i < RING_DIRECTIONS; i++) {
      const a = (i / RING_DIRECTIONS) * Math.PI * 2;
      const p: P2 = [origin[0] + Math.cos(a) * r, origin[1] + Math.sin(a) * r];
      if (inside(p) && isStandable(nav, p)) return p;
    }
  }
  return null;
}

/**
 * A validated place to start: the largest room first (its roomiest point, as before), then the
 * other rooms by size. A candidate counts only if it lies inside that room and clear of walls;
 * otherwise nearby points in the same room are tried. Without rooms, the model centre is tried.
 * Null when nowhere is safe: callers must show an error rather than start inside a wall.
 */
export function safeSpawn(nav: NavigationModel): RoomStop | null {
  const rooms = nav.spaces
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.polygon.length >= 3 && Number.isFinite(s.area))
    .sort((a, b) => b.s.area - a.s.area || a.i - b.i)
    .map(({ s }) => s);
  for (const room of rooms) {
    const p = searchNear(nav, labelAnchor(room.polygon), (q) => roomAt(q, nav.spaces)?.id === room.id);
    if (p) return { roomId: room.id, name: room.name, position: p, yaw: bestViewYaw(p, nav.walls, nav.spaces) };
  }
  if (rooms.length === 0) {
    const p = searchNear(nav, nav.centre, () => true);
    if (p) return { roomId: "", name: "", position: p, yaw: bestViewYaw(p, nav.walls, nav.spaces) };
  }
  return null;
}

/** One consistent eye height for the whole visit: 1.6 m, lower only if a ceiling demands it. */
export function standingEyeHeight(spaces: readonly SceneSpace[]): number {
  let lowest = Infinity;
  for (const s of spaces) if (Number.isFinite(s.ceilingHeight) && s.ceilingHeight > 0) lowest = Math.min(lowest, s.ceilingHeight);
  if (!Number.isFinite(lowest)) return EYE_HEIGHT;
  return Math.max(MIN_EYE_HEIGHT, Math.min(EYE_HEIGHT, lowest - HEAD_ROOM));
}
