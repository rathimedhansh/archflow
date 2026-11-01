import { describe, expect, it } from "vitest";
import type { FloorPlanData } from "@/lib/floorplan/types";
import { buildScene } from "../geometry3d/buildScene";
import { sceneFingerprint } from "../geometry3d/fingerprint";
import { buildColliders } from "../vr/collision";
import { CEILING_INSET, insideSlice, planCeilings } from "./ceilings";

const wall = (id: string, start: [number, number], end: [number, number], height = 2.7, thickness = 0.2) => ({ id, start, end, height, thickness });
const base = { version: 1 as const, units: "meters" as const, provenance: "manual" as const, source: { floorplan_id: "d".repeat(32), width_px: 900, height_px: 500 }, scale: { meters_per_pixel: 0.01, calibrated: true } };

/** Living (5 × 4) and bedroom (3 × 4), a door in the partition, a window to the outside. */
const flat = (): FloorPlanData => ({
  ...base,
  walls: [wall("w-n", [0, 0], [8, 0]), wall("w-e", [8, 0], [8, 4]), wall("w-s", [8, 4], [0, 4]), wall("w-w", [0, 4], [0, 0]), wall("w-mid", [5, 0], [5, 4])],
  rooms: [
    { id: "living", name: "Living", polygon: [[0, 0], [5, 0], [5, 4], [0, 4]] },
    { id: "bed", name: "Bedroom", polygon: [[5, 0], [8, 0], [8, 4], [5, 4]] },
  ],
  doors: [{ id: "d-mid", wall_id: "w-mid", offset: 1.5, width: 0.9, height: 2.1 }, { id: "d-front", wall_id: "w-w", offset: 1.5, width: 0.9, height: 2.1 }],
  windows: [{ id: "win", wall_id: "w-s", offset: 4, width: 1.5, height: 1.2, sill: 0.9 }],
});

/** Signed area of the downward faces' projection (positive = all faces point down). */
function downArea(mesh: { positions: Float32Array; normals: Float32Array; indices: Uint32Array }) {
  let area = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [i, j, k] = [mesh.indices[t] * 3, mesh.indices[t + 1] * 3, mesh.indices[t + 2] * 3];
    const p = mesh.positions;
    const ux = p[j] - p[i], uz = p[j + 2] - p[i + 2], vx = p[k] - p[i], vz = p[k + 2] - p[i + 2];
    // y component of (u × v): negative for a face whose normal points down (-Y).
    area += -(uz * vx - ux * vz) / 2;
    expect(mesh.normals[i + 1]).toBe(-1);
  }
  return area;
}

describe("ceilings (first-person views, renderer-only)", () => {
  it("covers each walled room exactly, at the height of its walls, facing down", () => {
    const scene = buildScene(flat());
    const plan = planCeilings(scene);
    expect(plan.skipped).toEqual([]);
    expect(plan.ceilings.map((c) => c.roomId)).toEqual(["living", "bed"]);
    for (const c of plan.ceilings) {
      const space = scene.spaces.find((s) => s.id === c.roomId)!;
      expect(c.height).toBe(2.7);
      expect(downArea(c.mesh)).toBeCloseTo(space.area, 6);
      for (let i = 1; i < c.mesh.positions.length; i += 3) expect(c.mesh.positions[i]).toBeCloseTo(2.7 - CEILING_INSET, 6);
    }
  });

  it("follows taller walls exactly", () => {
    const plan = flat();
    plan.walls = plan.walls.map((w) => ({ ...w, height: 3.1 }));
    expect(planCeilings(buildScene(plan)).ceilings.every((c) => Math.abs(c.height - 3.1) < 1e-9)).toBe(true);
  });

  it("leaves a room open when one of its walls is lower (no floating ceiling)", () => {
    const plan = flat();
    plan.walls = plan.walls.map((w) => (w.id === "w-e" ? { ...w, height: 2.4 } : w)); // bedroom's east wall
    const p = planCeilings(buildScene(plan));
    expect(p.ceilings.map((c) => c.roomId)).toEqual(["living"]);
    expect(p.skipped).toEqual([{ roomId: "bed", reason: "mixed-heights" }]);
  });

  it("leaves a room open when no wall stands on its outline (height would be a guess)", () => {
    const plan = flat();
    plan.rooms.push({ id: "yard", name: "Yard", polygon: [[10, 0], [13, 0], [13, 3], [10, 3]] });
    const p = planCeilings(buildScene(plan));
    expect(p.skipped).toEqual([{ roomId: "yard", reason: "no-walls" }]);
    expect(p.ceilings).toHaveLength(2);
  });

  it("an open-plan edge (no wall between two rooms) does not block the ceiling", () => {
    const plan = flat();
    plan.walls = plan.walls.filter((w) => w.id !== "w-mid");
    plan.doors = plan.doors.filter((d) => d.wall_id !== "w-mid");
    expect(planCeilings(buildScene(plan)).ceilings.map((c) => c.roomId)).toEqual(["living", "bed"]);
  });

  it("concave rooms are covered exactly", () => {
    const plan: FloorPlanData = {
      ...base,
      walls: [
        wall("a", [0, 0], [6, 0]), wall("b", [6, 0], [6, 3]), wall("c", [6, 3], [3, 3]),
        wall("d", [3, 3], [3, 6]), wall("e", [3, 6], [0, 6]), wall("f", [0, 6], [0, 0]),
      ],
      rooms: [{ id: "L", name: "L-shaped", polygon: [[0, 0], [6, 0], [6, 3], [3, 3], [3, 6], [0, 6]] }],
      doors: [], windows: [],
    };
    const p = planCeilings(buildScene(plan));
    expect(p.ceilings).toHaveLength(1);
    expect(downArea(p.ceilings[0].mesh)).toBeCloseTo(27, 6);
  });

  it("changes nothing the engine produced: objects, fingerprint, colliders", () => {
    const scene = buildScene(flat());
    const fp = sceneFingerprint(scene);
    const colliders = buildColliders(scene);
    const objects = scene.objects.length;
    planCeilings(scene);
    expect(sceneFingerprint(scene)).toBe(fp);
    expect(buildColliders(scene)).toEqual(colliders);
    expect(scene.objects).toHaveLength(objects);
  });

  it("is deterministic and copes with an empty scene", () => {
    const a = planCeilings(buildScene(flat()));
    const b = planCeilings(buildScene(flat()));
    expect(a.ceilings.map((c) => Array.from(c.mesh.positions))).toEqual(b.ceilings.map((c) => Array.from(c.mesh.positions)));
    expect(planCeilings(buildScene({ ...base, walls: [], rooms: [], doors: [], windows: [] }))).toEqual({ ceilings: [], skipped: [] });
  });

  it("tests points against a wall outline by crossing parity", () => {
    const sq = [
      { a: [0, 0], b: [1, 0] }, { a: [1, 1], b: [1, 0] }, { a: [1, 1], b: [0, 1] }, { a: [0, 0], b: [0, 1] },
    ] as { a: [number, number]; b: [number, number] }[];
    expect(insideSlice([0.5, 0.5], sq)).toBe(true);
    expect(insideSlice([1.5, 0.5], sq)).toBe(false);
    // Two boxes sharing a face: the shared face is crossed twice and cancels out.
    const two = [...sq, ...sq.map((s) => ({ a: [s.a[0] + 1, s.a[1]] as [number, number], b: [s.b[0] + 1, s.b[1]] as [number, number] }))];
    expect(insideSlice([0.5, 0.5], two)).toBe(true);
    expect(insideSlice([1.5, 0.5], two)).toBe(true);
    expect(insideSlice([2.5, 0.5], two)).toBe(false);
  });
});
