import { describe, expect, it } from "vitest";
import type { FloorPlanData } from "@/lib/floorplan/types";
import { buildScene } from "../geometry3d/buildScene";
import type { Scene3D } from "../geometry3d/types";
import { BODY_RADIUS, buildColliders, clearance, type P2 } from "./collision";
import { roomAt, startStop } from "./navigation";
import { buildNavigation, EYE_HEIGHT, isStandable, navigationFor, safeSpawn, SPAWN_CLEARANCE, standingEyeHeight, walkStep, type NavigationModel } from "./walkable";

const T = 0.2;
const wall = (id: string, start: [number, number], end: [number, number], height = 2.7) => ({ id, start, end, height, thickness: T });
const base = { version: 1 as const, units: "meters" as const, provenance: "manual" as const, source: { floorplan_id: "c".repeat(32), width_px: 900, height_px: 600 }, scale: { meters_per_pixel: 0.01, calibrated: true } };

/** Living (5 × 4) | bedroom (3 × 4); a 0.9 m door in the partition, an exterior door, a window. */
const flat = (): FloorPlanData => ({
  ...base,
  walls: [wall("w-n", [0, 0], [8, 0]), wall("w-e", [8, 0], [8, 4]), wall("w-s", [8, 4], [0, 4]), wall("w-w", [0, 4], [0, 0]), wall("w-mid", [5, 0], [5, 4])],
  rooms: [
    { id: "living", name: "Living", polygon: [[0, 0], [5, 0], [5, 4], [0, 4]] },
    { id: "bed", name: "Bedroom", polygon: [[5, 0], [8, 0], [8, 4], [5, 4]] },
  ],
  doors: [
    { id: "d-mid", wall_id: "w-mid", offset: 1.5, width: 0.9, height: 2.1 }, // z 1.5 – 2.4
    { id: "d-front", wall_id: "w-w", offset: 1.5, width: 0.9, height: 2.1 }, // z 2.5 – 1.6
  ],
  windows: [{ id: "win", wall_id: "w-s", offset: 4, width: 1.5, height: 1.2, sill: 0.9 }],
});

/**
 * Two rooms joined by a 0.8 m wide, 3 m long corridor (walls 0.2 thick), entered through
 * 0.8 m doors; plus a closet behind a 0.3 m slot (narrower than the walker).
 */
const corridorPlan = (): FloorPlanData => ({
  ...base,
  walls: [
    // Room A: x 0–4, z 0–4. Room B: x 7–11, z 0–4. Corridor: x 4–7, z 1.6–2.4.
    wall("a-n", [0, 0], [4, 0]), wall("a-w", [0, 0], [0, 4]), wall("a-s", [0, 4], [4, 4]), wall("a-e", [4, 0], [4, 4]),
    wall("b-n", [7, 0], [11, 0]), wall("b-e", [11, 0], [11, 4]), wall("b-s", [7, 4], [11, 4]), wall("b-w", [7, 0], [7, 4]),
    wall("c-n", [4, 1.5], [7, 1.5]), wall("c-s", [4, 2.5], [7, 2.5]),
    // Closet in room A's corner: x 0–1, z 3–4, closed by a partition with a 0.3 m slot.
    wall("k-n", [0, 3], [1, 3]),
  ],
  rooms: [
    { id: "a", name: "Room A", polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] },
    { id: "b", name: "Room B", polygon: [[7, 0], [11, 0], [11, 4], [7, 4]] },
    { id: "c", name: "Corridor", polygon: [[4, 1.5], [7, 1.5], [7, 2.5], [4, 2.5]] },
  ],
  doors: [
    { id: "d-a", wall_id: "a-e", offset: 1.6, width: 0.8, height: 2.1 }, // z 1.6 – 2.4
    { id: "d-b", wall_id: "b-w", offset: 1.6, width: 0.8, height: 2.1 },
    { id: "d-k", wall_id: "k-n", offset: 0.35, width: 0.3, height: 2.1 }, // x 0.35 – 0.65
  ],
  windows: [],
});

const flatScene = buildScene(flat());
const nav = buildNavigation(flatScene);

/** Hold a direction for `seconds` at 60 fps, as both walk loops do. */
function walk(n: NavigationModel, from: P2, dir: P2, seconds: number, speed = 1.4): P2 {
  const len = Math.hypot(dir[0], dir[1]);
  let p = from;
  for (let i = 0; i < Math.round(seconds * 60); i++) p = walkStep(n, p, [(dir[0] / len) * speed / 60, (dir[1] / len) * speed / 60]);
  return p;
}

describe("shared navigation model", () => {
  it("uses exactly the VR wall colliders, plus the model's outer bounds", () => {
    expect(nav.walls).toEqual(buildColliders(flatScene));
    expect(nav.colliders.length).toBe(nav.walls.length + 4);
    expect(nav.bounds.min[0]).toBeLessThan(0);
    expect(nav.bounds.max[0]).toBeGreaterThan(8);
  });

  it("is built once per scene and shared", () => {
    expect(navigationFor(flatScene)).toBe(navigationFor(flatScene));
    expect(navigationFor(buildScene(flat()))).not.toBe(navigationFor(flatScene));
  });

  it("does not touch the engine output", () => {
    const scene = buildScene(flat());
    const before = JSON.stringify({ ...scene, objects: scene.objects.map((o) => ({ ...o, mesh: Array.from(o.mesh.positions) })) });
    buildNavigation(scene);
    safeSpawn(buildNavigation(scene));
    expect(JSON.stringify({ ...scene, objects: scene.objects.map((o) => ({ ...o, mesh: Array.from(o.mesh.positions) })) })).toBe(before);
  });
});

describe("walking (desktop and VR share walkStep)", () => {
  it("stops at a solid wall and slides along it", () => {
    const p = walk(nav, [2.5, 0.8], [1, 0], 4); // toward the partition, away from its door
    expect(p[0]).toBeLessThan(5 - T / 2 - BODY_RADIUS + 1e-3);
    expect(p[0]).toBeGreaterThan(4.4);
    const slid = walk(nav, [4.5, 0.8], [1, -1], 2); // diagonal into the corner
    expect(clearance(slid, nav.walls)).toBeGreaterThanOrEqual(BODY_RADIUS - 1e-6);
  });

  it("passes through a door opening into the next room", () => {
    const p = walk(nav, [4.0, 1.95], [1, 0], 1.5);
    expect(roomAt(p, nav.spaces)?.id).toBe("bed");
  });

  it("stops at a window", () => {
    const p = walk(nav, [3.2, 3.0], [0, 1], 3);
    expect(p[1]).toBeLessThan(4 - T / 2);
    expect(roomAt(p, nav.spaces)?.id).toBe("living");
  });

  it("cannot leave the model through an exterior door", () => {
    const p = walk(nav, [1, 2.05], [-1, 0], 6);
    expect(p[0]).toBeGreaterThanOrEqual(nav.bounds.min[0] + BODY_RADIUS - 1e-6);
    expect(p[0]).toBeLessThan(0.3); // reached the doorway…
    expect(p[0]).toBeGreaterThan(-0.2); // …but no further than the threshold
  });

  it("never tunnels, even with a huge step, and rejects invalid input", () => {
    expect(walkStep(nav, [2.5, 0.8], [100, 0])[0]).toBeLessThan(5); // solid part of the partition
    expect(walkStep(nav, [2.5, 2], [100, 0])[0]).toBeLessThan(8); // through its door, then the outer wall
    expect(walkStep(nav, [2.5, 2], [NaN, 0])).toEqual([2.5, 2]);
    expect(walkStep(nav, [2.5, 2], [Infinity, 0])).toEqual([2.5, 2]);
    expect(walkStep(nav, [NaN, 2], [0.1, 0])).toEqual([NaN, 2]);
  });

  it("gets out of a wall it starts against instead of sticking", () => {
    const p = walkStep(nav, [4.85, 0.8], [-0.05, 0]); // 0.05 m from the partition face
    expect(clearance(p, nav.walls)).toBeGreaterThanOrEqual(BODY_RADIUS - 1e-6);
  });

  it("walks a 0.8 m corridor end to end, through 0.8 m doors", () => {
    const n = buildNavigation(buildScene(corridorPlan()));
    let p: P2 = [2, 2];
    p = walk(n, p, [1, 0], 9);
    expect(roomAt(p, n.spaces)?.id).toBe("b");
    p = walk(n, p, [-1, 0], 9);
    expect(roomAt(p, n.spaces)?.id).toBe("a");
  });

  it("follows a corridor when walking slightly off-axis (slides, does not stick)", () => {
    const n = buildNavigation(buildScene(corridorPlan()));
    const p = walk(n, [3.5, 2], [1, 0.08], 6);
    expect(p[0]).toBeGreaterThan(7.2);
  });

  it("does not squeeze through a gap narrower than the body", () => {
    const n = buildNavigation(buildScene(corridorPlan()));
    const p = walk(n, [0.5, 2.5], [0, 1], 4);
    expect(p[1]).toBeLessThan(3);
  });
});

describe("validated spawn", () => {
  it("starts where VR always started when that point is safe", () => {
    const s = safeSpawn(nav)!;
    const old = startStop(flatScene.spaces, nav.walls, [4, 2]);
    expect(s.position).toEqual(old.position);
    expect(s.yaw).toBe(old.yaw);
    expect(s.roomId).toBe("living");
    expect(isStandable(nav, s.position)).toBe(true);
  });

  it("moves off a room's anchor point when it is against a wall", () => {
    // An L-shaped room whose anchor is in its corridor-like arm, with a free-standing pillar wall on it.
    const plan = flat();
    const s0 = safeSpawn(buildNavigation(buildScene(plan)))!;
    plan.walls.push(wall("pillar", [s0.position[0] - 0.4, s0.position[1]], [s0.position[0] + 0.4, s0.position[1]]));
    const n = buildNavigation(buildScene(plan));
    const s = safeSpawn(n)!;
    expect(s.roomId).toBe("living");
    expect(s.position).not.toEqual(s0.position);
    expect(clearance(s.position, n.colliders)).toBeGreaterThanOrEqual(SPAWN_CLEARANCE);
    expect(roomAt(s.position, n.spaces)?.id).toBe("living");
  });

  it("falls back to another room when the largest has no safe point", () => {
    const plan = flat();
    // Fill the living room with closely spaced walls (0.35 m apart: never 0.25 m clear).
    for (let z = 0.35; z < 4; z += 0.35) plan.walls.push(wall(`f${z.toFixed(2)}`, [0, z], [5, z]));
    const n = buildNavigation(buildScene(plan));
    const s = safeSpawn(n)!;
    expect(s.roomId).toBe("bed");
    expect(isStandable(n, s.position)).toBe(true);
  });

  it("returns null when nowhere is safe (caller shows an error)", () => {
    const plan = flat();
    for (let z = 0.35; z < 4; z += 0.35) plan.walls.push(wall(`f${z.toFixed(2)}`, [0, z], [8, z]));
    expect(safeSpawn(buildNavigation(buildScene(plan)))).toBeNull();
  });

  it("handles models with no rooms or no geometry", () => {
    const noRooms = buildScene({ ...flat(), rooms: [] });
    const s = safeSpawn(buildNavigation(noRooms));
    expect(s).not.toBeNull();
    expect(s!.roomId).toBe("");
    const empty: Scene3D = { ...noRooms, objects: [], spaces: [], bounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] } };
    const n = buildNavigation(empty);
    expect(n.colliders).toHaveLength(0);
    expect(safeSpawn(n)).toBeNull(); // no bounds: nothing is standable
    expect(isStandable(n, [NaN, 0])).toBe(false);
  });

  it("is deterministic", () => {
    expect(safeSpawn(buildNavigation(buildScene(corridorPlan())))).toEqual(safeSpawn(buildNavigation(buildScene(corridorPlan()))));
  });
});

describe("standing eye height", () => {
  it("is 1.6 m, lowered only under low ceilings, never below 1 m", () => {
    expect(standingEyeHeight(flatScene.spaces)).toBe(EYE_HEIGHT);
    const low = buildScene({ ...flat(), walls: flat().walls.map((w) => ({ ...w, height: 1.7 })) });
    expect(standingEyeHeight(low.spaces)).toBeCloseTo(1.4);
    const tiny = buildScene({ ...flat(), walls: flat().walls.map((w) => ({ ...w, height: 0.8 })) });
    expect(standingEyeHeight(tiny.spaces)).toBe(1);
    expect(standingEyeHeight([])).toBe(EYE_HEIGHT);
  });
});
