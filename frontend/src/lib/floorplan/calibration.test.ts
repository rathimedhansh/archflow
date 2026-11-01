/**
 * Dimensional accuracy after calibration, measured in the generated 3D model.
 *
 * Ground truth is fixed in the test, not taken from ARCHFLOW: a two-room drawing at exactly
 * 50 px per metre (0.02 m/px). Outer walls 12 px (0.24 m) and the partition 6 px (0.12 m)
 * thick, centre-lines on a 10 m × 6 m rectangle, a 0.9 m door (45 px) and a 1.5 m window (75 px).
 * The plan arrives as automatic detection delivers it: every length measured in pixels and
 * converted with a wrong, estimated scale; the user then calibrates on one known distance.
 */
import { describe, expect, it } from "vitest";
import { buildScene } from "../geometry3d/buildScene";
import type { MeshData } from "../geometry3d/types";
import { buildColliders, sliceMesh } from "../vr/collision";
import { buildNavigation, safeSpawn, walkStep } from "../vr/walkable";
import { applyScale } from "./ops";
import type { FloorPlanData } from "./types";

const TRUE_MPP = 0.02;
/** What a door-width estimate might have produced: 14 % too large, like the real-world reference plan. */
const ESTIMATED_MPP = TRUE_MPP * 1.14;

/** Pixel geometry of the drawing. */
const PX = {
  walls: [
    { id: "n", start: [100, 100], end: [600, 100], t: 12 },
    { id: "e", start: [600, 100], end: [600, 400], t: 12 },
    { id: "s", start: [600, 400], end: [100, 400], t: 12 },
    { id: "w", start: [100, 400], end: [100, 100], t: 12 },
    { id: "mid", start: [350, 100], end: [350, 400], t: 6 },
  ],
  rooms: [
    { id: "a", name: "Living", polygon: [[100, 100], [350, 100], [350, 400], [100, 400]] },
    { id: "b", name: "Bedroom", polygon: [[350, 100], [600, 100], [600, 400], [350, 400]] },
  ],
  door: { wall_id: "mid", offset: 120, width: 45 },
  window: { wall_id: "s", offset: 100, width: 75 },
} as const;

/** The plan as detection delivers it: pixels × the estimated scale, never calibrated. */
function detected(provenance: FloorPlanData["provenance"] = "opencv", mpp = ESTIMATED_MPP): FloorPlanData {
  const m = (v: number) => v * mpp;
  return {
    version: 1, units: "meters", provenance,
    source: { floorplan_id: "e".repeat(32), width_px: 700, height_px: 500 },
    scale: { meters_per_pixel: mpp, calibrated: false },
    walls: PX.walls.map((w) => ({ id: w.id, start: [m(w.start[0]), m(w.start[1])], end: [m(w.end[0]), m(w.end[1])], height: 2.8, thickness: m(w.t) })),
    rooms: PX.rooms.map((r) => ({ id: r.id, name: r.name, polygon: r.polygon.map(([x, y]) => [m(x), m(y)] as [number, number]) })),
    doors: [{ id: "d1", wall_id: PX.door.wall_id, offset: m(PX.door.offset), width: m(PX.door.width), height: 2.1 }],
    windows: [{ id: "w1", wall_id: PX.window.wall_id, offset: m(PX.window.offset), width: m(PX.window.width), height: 1.2, sill: 0.9 }],
  };
}

/** Calibrate as the editor does: two points on the north wall's centre-line, 10 m apart in reality. */
function calibrateOnNorthWall(plan: FloorPlanData): FloorPlanData {
  const pxDistance = 500;
  return applyScale(plan, 10 / pxDistance);
}

/** Extent of a mesh along x and z at one height (from its horizontal slice). */
function sliceExtent(mesh: MeshData, h: number) {
  const s = sliceMesh(mesh, h);
  const xs = s.flatMap((g) => [g.a[0], g.b[0]]);
  const zs = s.flatMap((g) => [g.a[1], g.b[1]]);
  return { x: Math.max(...xs) - Math.min(...xs), z: Math.max(...zs) - Math.min(...zs), minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

const MM = 0.001;

/** Outer faces of the building: the union of all wall bodies at 1 m (window sill boards excluded). */
function wallExtent(scene: ReturnType<typeof buildScene>) {
  const parts = scene.objects.filter((o) => o.kind === "wall").map((o) => sliceExtent(o.mesh, 1.0));
  return { x: Math.max(...parts.map((p) => p.maxX)) - Math.min(...parts.map((p) => p.minX)), z: Math.max(...parts.map((p) => p.maxZ)) - Math.min(...parts.map((p) => p.minZ)) };
}

describe("calibration keeps every image-measured length consistent", () => {
  it("rescales wall thickness of a detected plan with the rest of the drawing", () => {
    const cal = calibrateOnNorthWall(detected());
    expect(cal.scale).toEqual({ meters_per_pixel: TRUE_MPP, calibrated: true });
    const t = Object.fromEntries(cal.walls.map((w) => [w.id, w.thickness]));
    expect(t.n).toBeCloseTo(0.24, 9);
    expect(t.mid).toBeCloseTo(0.12, 9);
    // Unchanged by design: heights are not measured from a plan drawing.
    expect(cal.walls[0].height).toBe(2.8);
    expect(cal.doors[0].height).toBe(2.1);
    expect(cal.windows[0].sill).toBe(0.9);
  });

  it("leaves hand-traced plans' thicknesses alone (they are typed-in real values)", () => {
    const manual = detected("manual");
    const cal = calibrateOnNorthWall(manual);
    expect(cal.walls.map((w) => w.thickness)).toEqual(manual.walls.map((w) => w.thickness));
  });

  it("treats AI-produced plans like detected ones (thickness measured from the image)", () => {
    expect(calibrateOnNorthWall(detected("ai")).walls[0].thickness).toBeCloseTo(0.24, 9);
  });

  it("keeps thickness within the schema's limits (0 < t ≤ 2 m)", () => {
    const huge = applyScale(detected(), ESTIMATED_MPP * 100);
    expect(Math.max(...huge.walls.map((w) => w.thickness))).toBeLessThanOrEqual(2);
    const tiny = applyScale(detected(), ESTIMATED_MPP / 1e6);
    expect(Math.min(...tiny.walls.map((w) => w.thickness))).toBeGreaterThan(0);
  });

  it("is consistent when calibrated twice (scale is relative to the current one)", () => {
    const once = calibrateOnNorthWall(detected());
    const twice = applyScale(applyScale(detected(), 0.05), TRUE_MPP);
    expect(twice.walls.map((w) => w.thickness)).toEqual(once.walls.map((w) => w.thickness).map((v) => expect.closeTo(v, 9)));
  });
});

describe("the calibrated 3D model has the drawing's real dimensions", () => {
  const scene = buildScene(calibrateOnNorthWall(detected()));
  const wall = (id: string) => scene.objects.find((o) => o.kind === "wall" && o.sourceId === id)!;

  it("outer size: 10.24 m × 6.24 m (centre-lines 10 × 6 m plus a half 0.24 m wall each side)", () => {
    const outer = wallExtent(scene);
    expect(Math.abs(outer.x - 10.24)).toBeLessThan(MM);
    expect(Math.abs(outer.z - 6.24)).toBeLessThan(MM);
    expect(scene.scale.calibrated).toBe(true);
  });

  it("walls are as thick as drawn (measured in the wall meshes)", () => {
    // North wall body spans z = 2 ± 0.12; the partition x = 7 ± 0.06 (below the door head).
    const n = sliceExtent(wall("n").mesh, 1.0);
    expect(Math.abs(n.z - 0.24)).toBeLessThan(MM);
    const mid = sliceExtent(wall("mid").mesh, 2.5); // above the door: one solid lintel piece
    expect(Math.abs(mid.x - 0.12)).toBeLessThan(MM);
  });

  it("room interiors are clear widths between wall faces (centre-lines minus half walls)", () => {
    const living = scene.spaces.find((s) => s.id === "a")!;
    expect(living.area).toBeCloseTo(5 * 6, 6); // the plan's convention: area to wall centre-lines
    // Clear width inside the living room at 1 m height: from the west wall's inner face to the partition's.
    const west = sliceExtent(wall("w").mesh, 1.0);
    const mid = sliceExtent(wall("mid").mesh, 2.5);
    expect(mid.minX - west.maxX).toBeCloseTo(5 - 0.12 - 0.06, 3);
  });

  it("the door opening is 0.90 m wide and where the drawing puts it", () => {
    // Partition runs z 2 → 8; the door starts 120 px (2.4 m) along it.
    const segs = sliceMesh(wall("mid").mesh, 1.0);
    const zs = [...new Set(segs.flatMap((s) => [s.a[1], s.b[1]]).map((z) => Math.round(z * 1e4) / 1e4))].sort((a, b) => a - b);
    // Solid pieces: [2 - ext, 4.4] and [5.3, 8 + ext]: the hole is 4.4 → 5.3.
    const holeStart = zs.find((z) => Math.abs(z - 4.4) < 0.001);
    const holeEnd = zs.find((z) => Math.abs(z - 5.3) < 0.001);
    expect(holeStart).toBeDefined();
    expect(holeEnd).toBeDefined();
    expect(holeEnd! - holeStart!).toBeCloseTo(0.9, 3);
  });

  it("the window is 1.50 m wide", () => {
    const win = scene.objects.find((o) => o.kind === "window" && !o.id.endsWith(":glass"))!;
    const e = sliceExtent(win.mesh, 1.5);
    expect(e.x).toBeGreaterThan(1.5 - MM);
    expect(e.x).toBeLessThan(1.5 + 0.1); // the frame's sill board may project a few cm
  });

  it("walking uses the same metres: the 0.9 m door is passable, the partition is not", () => {
    const nav = buildNavigation(scene);
    expect(nav.walls).toEqual(buildColliders(scene));
    const spawn = safeSpawn(nav)!;
    expect(spawn).not.toBeNull();
    // Living room centre-line x 2..7; walk east 4 m at z = 4.85 (door centre) and at z = 3 (solid).
    let p: [number, number] = [5.5, 4.85];
    for (let i = 0; i < 200; i++) p = walkStep(nav, p, [0.02, 0]);
    expect(p[0]).toBeGreaterThan(7.5);
    let q: [number, number] = [5.5, 3];
    for (let i = 0; i < 200; i++) q = walkStep(nav, q, [0.02, 0]);
    expect(q[0]).toBeLessThan(7 - 0.06);
  });
});

describe("before calibration, sizes follow the estimate (labelled approximate)", () => {
  it("an uncalibrated detected plan is consistently scaled and flagged", () => {
    const scene = buildScene(detected());
    expect(scene.scale.calibrated).toBe(false);
    // Every length 14 % large together: proportions are intact.
    const { x: w, z: d } = wallExtent(scene);
    expect(w / d).toBeCloseTo(10.24 / 6.24, 3);
    expect(w).toBeCloseTo(10.24 * 1.14, 3);
  });
});
