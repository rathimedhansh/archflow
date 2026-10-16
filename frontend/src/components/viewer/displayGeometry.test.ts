import { describe, expect, it } from "vitest";
import type { FloorPlanData, Point } from "@/lib/floorplan/types";
import { buildScene, sceneFingerprint } from "../../lib/geometry3d/index";
import { floorFinishFor } from "../../lib/viewer/floorFinish";
import { planarUVs, toDisplayGeometry, wallCapColors, type RGB } from "./toBufferGeometry";

const wall = (id: string, start: Point, end: Point, height = 3, thickness = 0.2) => ({ id, start, end, height, thickness });

/** 6 x 4 house, two rooms, a door and a window (with a sill below wall height). */
const plan = (): FloorPlanData => ({
  version: 1, units: "meters", provenance: "manual",
  source: { floorplan_id: "a".repeat(32), width_px: 1000, height_px: 800 },
  scale: { meters_per_pixel: 0.01, calibrated: true },
  walls: [
    wall("wall-1", [0, 0], [6, 0]), wall("wall-2", [6, 0], [6, 4]),
    wall("wall-3", [6, 4], [0, 4]), wall("wall-4", [0, 4], [0, 0]), wall("wall-5", [3, 0], [3, 4], 2.6),
  ],
  rooms: [
    { id: "room-1", name: "Kitchen", polygon: [[0, 0], [3, 0], [3, 4], [0, 4]] },
    { id: "room-2", name: "Living room", polygon: [[3, 0], [6, 0], [6, 4], [3, 4]] },
  ],
  doors: [{ id: "door-1", wall_id: "wall-5", offset: 1, width: 0.9, height: 2.1 }],
  windows: [{ id: "window-1", wall_id: "wall-1", offset: 1, width: 1.2, height: 1.2, sill: 0.9 }],
});

const SIDE: RGB = [0.1, 0.2, 0.3];
const CAP: RGB = [0.9, 0.8, 0.7];
const copyArrays = (s: ReturnType<typeof buildScene>) =>
  s.objects.map((o) => [Array.from(o.mesh.positions), Array.from(o.mesh.normals), Array.from(o.mesh.indices)]);

describe("renderer display attributes", () => {
  it("never changes the engine's arrays or the scene fingerprint", () => {
    const scene = buildScene(plan());
    const before = copyArrays(scene);
    const fp = sceneFingerprint(scene);
    const geometries = scene.objects.map((o) => toDisplayGeometry(o));
    expect(copyArrays(scene)).toEqual(before);
    expect(sceneFingerprint(scene)).toBe(fp);
    // Engine arrays are shared (not copied); display arrays are new.
    scene.objects.forEach((o, i) => {
      const g = geometries[i];
      expect(g.getAttribute("position").array).toBe(o.mesh.positions);
      expect(g.getAttribute("normal").array).toBe(o.mesh.normals);
      if (g.getAttribute("uv")) expect(g.getAttribute("uv").array).not.toBe(o.mesh.positions);
    });
  });

  it("adds UVs only to floors and colours only to walls", () => {
    const scene = buildScene(plan());
    for (const o of scene.objects) {
      const g = toDisplayGeometry(o);
      expect(!!g.getAttribute("uv")).toBe(o.kind === "floor");
      expect(!!g.getAttribute("color")).toBe(o.kind === "wall");
    }
  });

  it("floor UVs are world X/Z in metres", () => {
    const pos = new Float32Array([1.5, 0, -2, 4, -0.1, 3.25]);
    expect(Array.from(planarUVs(pos))).toEqual([1.5, -2, 4, 3.25]);
  });

  it("caps only the upward faces at a wall's full height, not window sills", () => {
    const scene = buildScene(plan());
    const front = scene.objects.find((o) => o.id === "wall-1")!;
    const colors = wallCapColors(front.mesh, SIDE, CAP);
    const { positions, normals } = front.mesh;
    let caps = 0, sills = 0;
    for (let v = 0; v < positions.length / 3; v++) {
      const y = positions[v * 3 + 1];
      const up = normals[v * 3 + 1] > 0.99;
      const c = Array.from(colors.slice(v * 3, v * 3 + 3));
      if (up && Math.abs(y - 3) < 1e-4) { caps++; expect(c).toEqual(CAP.map(Math.fround)); }
      else expect(c).toEqual(SIDE.map(Math.fround));
      if (up && Math.abs(y - 0.9) < 1e-4) sills++;
    }
    expect(caps).toBeGreaterThan(0);
    expect(sills).toBeGreaterThan(0); // the sill top exists and stayed SIDE (checked above)
  });

  it("caps a lower wall at its own height", () => {
    const scene = buildScene(plan());
    const inner = scene.objects.find((o) => o.id === "wall-5")!;
    const colors = wallCapColors(inner.mesh, SIDE, CAP);
    const { positions, normals } = inner.mesh;
    let caps = 0;
    for (let v = 0; v < positions.length / 3; v++) {
      if (normals[v * 3 + 1] > 0.99 && Math.abs(positions[v * 3 + 1] - 2.6) < 1e-4) {
        caps++;
        expect(colors[v * 3]).toBeCloseTo(CAP[0]);
      }
    }
    expect(caps).toBeGreaterThan(0);
  });
});

describe("floorFinishFor", () => {
  it.each([
    ["Kitchen", "tile"], ["Bathroom", "tile"], ["WC", "tile"], ["En-suite", "tile"], ["Ensuite bath", "tile"],
    ["Master bath", "tile"], ["Utility room", "tile"], ["Kitchen / Dining", "tile"],
    ["Living room", "wood"], ["Bedroom", "wood"], ["Master bedroom", "wood"], ["Bed 2", "wood"],
    ["Dining", "wood"], ["Study", "wood"], ["LOUNGE", "wood"],
    ["Hallway", "neutral"], ["Corridor", "neutral"], ["Entrance", "neutral"], ["Balcony", "neutral"],
    ["Room 1", "neutral"], ["", "neutral"], ["   ", "neutral"], ["Raum 3", "neutral"], ["客厅", "neutral"],
    // Words that merely contain a keyword are not matched mid-word.
    ["Embedded storage", "neutral"], ["Cupboard", "neutral"],
  ])("%s -> %s", (name, finish) => {
    expect(floorFinishFor(name)).toBe(finish);
  });

  it("treats missing or non-string names as neutral", () => {
    expect(floorFinishFor(undefined)).toBe("neutral");
    expect(floorFinishFor(null)).toBe("neutral");
    expect(floorFinishFor(42 as unknown as string)).toBe("neutral");
  });
});
