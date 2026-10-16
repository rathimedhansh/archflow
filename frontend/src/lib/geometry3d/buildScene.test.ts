import { describe, expect, it } from "vitest";
import type { FloorPlanData, Point } from "@/lib/floorplan/types";
import { buildScene, meshBounds, meshVolume, sceneFingerprint, summarizeScene, type Scene3D } from "./index";
import { MeshBuilder } from "./meshBuilder";

const plan = (over: Partial<FloorPlanData> = {}): FloorPlanData => ({
  version: 1, units: "meters", provenance: "manual",
  source: { floorplan_id: "a".repeat(32), width_px: 1000, height_px: 800 },
  scale: { meters_per_pixel: 0.01, calibrated: true },
  walls: [], rooms: [], doors: [], windows: [],
  ...over,
});

const wall = (id: string, start: Point, end: Point, height = 3, thickness = 0.2) => ({ id, start, end, height, thickness });
const door = (id: string, wall_id: string, offset: number, width = 1, height = 2.1) => ({ id, wall_id, offset, width, height });
const win = (id: string, wall_id: string, offset: number, width = 1.5, height = 1.2, sill = 0.9) => ({ id, wall_id, offset, width, height, sill });

const obj = (s: Scene3D, id: string) => s.objects.find((o) => o.id === id)!;
const vol = (s: Scene3D, id: string) => meshVolume(obj(s, id).mesh);

/** A closed 6 x 4 rectangle of walls plus the matching room. */
const house = (): FloorPlanData => plan({
  walls: [
    wall("wall-1", [0, 0], [6, 0]), wall("wall-2", [6, 0], [6, 4]),
    wall("wall-3", [6, 4], [0, 4]), wall("wall-4", [0, 4], [0, 0]),
  ],
  rooms: [{ id: "room-1", name: "Main", polygon: [[0, 0], [6, 0], [6, 4], [0, 4]] }],
  doors: [door("door-1", "wall-1", 1)],
  windows: [win("window-1", "wall-3", 2)],
});

const deepFreeze = <T,>(o: T): T => {
  if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
};

describe("MeshBuilder", () => {
  it("builds a closed box with outward faces and exact volume", () => {
    const b = new MeshBuilder();
    b.addBox([1, 2, 3], [2, 0, 0], [0, 3, 0], [0, 0, 4]);
    expect(meshVolume(b.build())).toBeCloseTo(24);
  });

  it("is orientation-independent: a box built from mirrored axes is still outward", () => {
    const b = new MeshBuilder();
    b.addBox([0, 0, 0], [0, 0, -2], [0, 3, 0], [4, 0, 0]); // left-handed basis
    expect(meshVolume(b.build())).toBeCloseTo(24);
  });

  it("gives every vertex a unit normal matching its triangle winding", () => {
    const b = new MeshBuilder();
    b.addBox([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    const m = b.build();
    for (let i = 0; i < m.indices.length; i += 3) {
      const [a, bb, c] = [0, 1, 2].map((k) => m.indices[i + k] * 3);
      const p = (o: number) => [m.positions[o], m.positions[o + 1], m.positions[o + 2]];
      const [pa, pb, pc] = [p(a), p(bb), p(c)];
      const u = pb.map((v, k) => v - pa[k]);
      const w = pc.map((v, k) => v - pa[k]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const stored = [m.normals[a], m.normals[a + 1], m.normals[a + 2]];
      expect(n[0] * stored[0] + n[1] * stored[1] + n[2] * stored[2]).toBeGreaterThan(0);
      expect(Math.hypot(...stored)).toBeCloseTo(1);
    }
  });

  it("prism volume is area x height for convex, concave and clockwise outlines", () => {
    const cases: [number, [number, number][]][] = [
      [12, [[0, 0], [4, 0], [4, 3], [0, 3]]],
      [12, [[0, 0], [0, 3], [4, 3], [4, 0]]],
      [12, [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]]],
    ];
    for (const [area, poly] of cases) {
      const b = new MeshBuilder();
      b.addPrism(poly, 0, 2.5);
      expect(meshVolume(b.build())).toBeCloseTo(area * 2.5);
    }
  });
});

describe("walls", () => {
  it("preserves real-world scale: a 5 m x 3 m x 0.2 m wall is exactly that size", () => {
    const s = buildScene(plan({ walls: [wall("w", [0, 0], [5, 0])] }));
    const { min, max } = s.bounds;
    expect(max[0] - min[0]).toBeCloseTo(5);
    expect(max[1] - min[1]).toBeCloseTo(3);
    expect(max[2] - min[2]).toBeCloseTo(0.2);
    expect(vol(s, "w")).toBeCloseTo(5 * 3 * 0.2);
  });

  it("maps plan (x, y) to world (x, ., z) and is direction-independent", () => {
    const a = buildScene(plan({ walls: [wall("w", [1, 2], [6, 2])] }));
    expect(a.bounds.min[0]).toBeCloseTo(1);
    expect(a.bounds.min[2]).toBeCloseTo(1.9);
    expect(a.bounds.max[2]).toBeCloseTo(2.1);
    const flipped = buildScene(plan({ walls: [wall("w", [6, 2], [1, 2])] }));
    expect(vol(flipped, "w")).toBeCloseTo(vol(a, "w"));
    const diagonal = buildScene(plan({ walls: [wall("w", [0, 0], [3, 4])] }));
    expect(vol(diagonal, "w")).toBeCloseTo(5 * 3 * 0.2); // 3-4-5 triangle: length 5
  });

  it("uses each wall's own height and thickness", () => {
    const s = buildScene(plan({ walls: [wall("w", [0, 0], [4, 0], 2.5, 0.3)] }));
    expect(vol(s, "w")).toBeCloseTo(4 * 2.5 * 0.3);
    expect(s.bounds.max[1]).toBeCloseTo(2.5);
  });

  it("cuts a door hole: volume drops by width x height x thickness, lintel stays", () => {
    const s = buildScene(plan({ walls: [wall("w", [0, 0], [6, 0])], doors: [door("d", "w", 2, 1, 2.1)] }));
    expect(vol(s, "w")).toBeCloseTo(6 * 3 * 0.2 - 1 * 2.1 * 0.2);
    expect(s.warnings).toEqual([]);
  });

  it("cuts a window hole with a sill below and a lintel above", () => {
    const s = buildScene(plan({ walls: [wall("w", [0, 0], [6, 0])], windows: [win("x", "w", 2, 1.5, 1.2, 0.9)] }));
    expect(vol(s, "w")).toBeCloseTo(6 * 3 * 0.2 - 1.5 * 1.2 * 0.2);
  });

  it("places openings at their exact offset along the wall, from `start`", () => {
    const s = buildScene(plan({ walls: [wall("w", [0, 0], [6, 0])], doors: [door("d", "w", 2, 1)] }));
    const b = meshBounds([obj(s, "d").mesh]);
    // Frame protrudes past the hole by nothing along the wall: spans exactly [2, 3].
    expect(b.min[0]).toBeCloseTo(2);
    expect(b.max[0]).toBeCloseTo(3);
    // Same offset on a wall drawn the other way round lands at the other end.
    const r = buildScene(plan({ walls: [wall("w", [6, 0], [0, 0])], doors: [door("d", "w", 2, 1)] }));
    const rb = meshBounds([obj(r, "d").mesh]);
    expect(rb.min[0]).toBeCloseTo(3);
    expect(rb.max[0]).toBeCloseTo(4);
  });

  it("fills outer corners where walls meet (and only there)", () => {
    const closed = buildScene(house());
    const corner = (s: Scene3D) => {
      const p = obj(s, "wall-1").mesh.positions;
      for (let i = 0; i < p.length; i += 3) {
        if (Math.abs(p[i] + 0.1) < 1e-6 && Math.abs(p[i + 2] + 0.1) < 1e-6) return true;
      }
      return false;
    };
    expect(corner(closed)).toBe(true); // wall-1 reaches the outer corner at (-0.1, -0.1)
    const lone = buildScene(plan({ walls: [wall("wall-1", [0, 0], [6, 0])] }));
    expect(corner(lone)).toBe(false); // a free end is not extended
    // Extended by half the neighbour's thickness at both ends (6 + 0.1 + 0.1), minus the door hole.
    expect(vol(closed, "wall-1")).toBeCloseTo((6 + 0.2) * 3 * 0.2 - 1 * 2.1 * 0.2);
  });

  it("does not extend walls that continue in a straight line", () => {
    const s = buildScene(plan({ walls: [wall("a", [0, 0], [3, 0]), wall("b", [3, 0], [6, 0])] }));
    expect(s.bounds.min[0]).toBeCloseTo(0);
    expect(s.bounds.max[0]).toBeCloseTo(6);
  });
});

describe("rooms", () => {
  it("makes one floor per room plus a separate space with area and ceiling height", () => {
    const s = buildScene(house());
    expect(s.objects.filter((o) => o.kind === "floor")).toHaveLength(1);
    const space = s.spaces[0];
    expect(space.id).toBe("room-1");
    expect(space.area).toBeCloseTo(24);
    expect(space.ceilingHeight).toBe(3);
    expect(space.floorObjectId).toBe("floor:room-1");
    expect(space.centroid[0]).toBeCloseTo(3);
    expect(space.centroid[2]).toBeCloseTo(2);
  });

  it("floor slab sits below y = 0 with area x thickness volume; space volume is area x height", () => {
    const s = buildScene(house());
    expect(vol(s, "floor:room-1")).toBeCloseTo(24 * 0.1);
    expect(meshBounds([obj(s, "floor:room-1").mesh]).max[1]).toBeCloseTo(0);
    expect(meshVolume(s.spaces[0].volume)).toBeCloseTo(24 * 3);
  });

  it("supports concave rooms", () => {
    const l: [number, number][] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
    const s = buildScene(plan({ rooms: [{ id: "r", name: "L", polygon: l }] }));
    expect(s.spaces[0].area).toBeCloseTo(12);
    expect(vol(s, "floor:r")).toBeCloseTo(12 * 0.1);
    expect(s.spaces[0].ceilingHeight).toBe(2.8); // no walls: default
  });

  it("takes the ceiling height from the walls that bound the room", () => {
    const tall = plan({
      walls: [wall("a", [0, 0], [4, 0], 3.6), wall("far", [50, 50], [60, 50], 9)],
      rooms: [{ id: "r", name: "Hall", polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] }],
    });
    expect(buildScene(tall).spaces[0].ceilingHeight).toBe(3.6);
  });
});

describe("determinism and reactivity", () => {
  it("same plan -> identical scene, twice, with an unchanged fingerprint", () => {
    const a = buildScene(house());
    const b = buildScene(house());
    expect(sceneFingerprint(a)).toBe(sceneFingerprint(b));
    expect(a.objects.map((o) => o.id)).toEqual(b.objects.map((o) => o.id));
    a.objects.forEach((o, i) => {
      expect(Array.from(o.mesh.positions)).toEqual(Array.from(b.objects[i].mesh.positions));
      expect(Array.from(o.mesh.indices)).toEqual(Array.from(b.objects[i].mesh.indices));
    });
  });

  it("never mutates its input", () => {
    const frozen = deepFreeze(house());
    expect(() => buildScene(frozen)).not.toThrow();
  });

  it("has a stable object order: walls, floors, doors, windows", () => {
    const kinds = buildScene(house()).objects.map((o) => o.kind);
    expect(kinds).toEqual(["wall", "wall", "wall", "wall", "floor", "door", "window", "window"]);
  });

  it("changing the plan changes the geometry", () => {
    const base = buildScene(house());
    const fp = sceneFingerprint(base);
    const variants: [string, FloorPlanData][] = [
      ["move a wall", { ...house(), walls: house().walls.map((w) => (w.id === "wall-2" ? { ...w, start: [7, 0], end: [7, 4] } : w)) }],
      ["taller walls", { ...house(), walls: house().walls.map((w) => ({ ...w, height: 3.5 })) }],
      ["thicker wall", { ...house(), walls: house().walls.map((w) => (w.id === "wall-1" ? { ...w, thickness: 0.4 } : w)) }],
      ["extra door", { ...house(), doors: [...house().doors, door("door-2", "wall-2", 1)] }],
      ["no window", { ...house(), windows: [] }],
      ["move door", { ...house(), doors: [door("door-1", "wall-1", 3)] }],
      ["renamed-shape room", { ...house(), rooms: [{ id: "room-1", name: "Main", polygon: [[0, 0], [6, 0], [6, 3], [0, 3]] }] }],
    ];
    for (const [name, v] of variants) expect(sceneFingerprint(buildScene(v)), name).not.toBe(fp);
  });

  it("reflects those changes in measurable ways", () => {
    const base = summarizeScene(buildScene(house()));
    expect(base).toMatchObject({ walls: 4, doors: 1, windows: 1, rooms: 1 });
    expect(base.floorArea).toBeCloseTo(24);
    expect(base.height).toBeCloseTo(3);

    const wider = summarizeScene(buildScene({ ...house(), walls: house().walls.map((w) => (w.id === "wall-2" ? { ...w, start: [8, 0], end: [8, 4] } : w)) }));
    expect(wider.footprint.width).toBeGreaterThan(base.footprint.width + 1.9);

    const more = summarizeScene(buildScene({ ...house(), doors: [...house().doors, door("door-2", "wall-2", 1)] }));
    expect(more.doors).toBe(2);
    expect(more.triangles).toBeGreaterThan(base.triangles);
  });

  it("a recalibrated plan (rescaled metres) yields a proportionally larger model", () => {
    const scaled: FloorPlanData = {
      ...house(),
      walls: house().walls.map((w) => ({ ...w, start: [w.start[0] * 2, w.start[1] * 2], end: [w.end[0] * 2, w.end[1] * 2] })),
    };
    expect(summarizeScene(buildScene(scaled)).footprint.width).toBeGreaterThan(summarizeScene(buildScene(house())).footprint.width * 1.9);
  });
});

describe("robustness", () => {
  it("handles an empty plan", () => {
    const s = buildScene(plan());
    expect(s.objects).toEqual([]);
    expect(s.bounds).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
    expect(summarizeScene(s)).toMatchObject({ walls: 0, triangles: 0, rooms: 0 });
  });

  it("skips or trims bad input with warnings instead of throwing", () => {
    const s = buildScene(plan({
      walls: [wall("w", [0, 0], [4, 0]), wall("zero", [1, 1], [1, 1])],
      doors: [door("d1", "w", 3.5, 1), door("ghost", "nope", 0)],
      windows: [win("x", "w", 3.6, 0.3)],
      rooms: [{ id: "flat", name: "Flat", polygon: [[0, 0], [1, 0], [2, 0]] }],
    }));
    expect(s.objects.some((o) => o.id === "d1")).toBe(true); // trimmed to fit
    expect(s.objects.some((o) => o.id === "zero" || o.id === "ghost")).toBe(false);
    expect(s.warnings.join("|")).toMatch(/too short/);
    expect(s.warnings.join("|")).toMatch(/unknown or skipped wall/);
    expect(s.warnings.join("|")).toMatch(/trimmed/);
    expect(s.warnings.join("|")).toMatch(/overlaps/);
    expect(s.warnings.join("|")).toMatch(/no area/);
  });

  it("produces finite geometry only", () => {
    const s = buildScene(house());
    for (const o of s.objects) {
      expect(Array.from(o.mesh.positions).every(Number.isFinite)).toBe(true);
      expect(Array.from(o.mesh.normals).every(Number.isFinite)).toBe(true);
    }
  });
});
