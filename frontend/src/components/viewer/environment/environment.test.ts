import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { FloorPlanData, Point } from "@/lib/floorplan/types";
import type { SceneBounds } from "@/lib/geometry3d";
import { buildScene, sceneFingerprint } from "../../../lib/geometry3d/index";
import {
  blocksView, chooseFront, doorCenters, PLANT_SPECS, planSite, SITE_BUDGET,
  type PlantKind, type Rect, type SiteStyle,
} from "../../../lib/viewer/environment";
import { roomPose, viewPose } from "../framing";
import { buildSlabGeometries } from "./siteGeometry";
import { protectedViews, houseTargets } from "./sightLines";
import { buildPlantGeometries } from "./vegetation";

const STYLES: SiteStyle[] = ["minimal", "suburban", "urban"];

/** Same plinth as the viewer's studio base (Viewer3D baseGeometry). */
function site(bounds: SceneBounds) {
  const w = bounds.max[0] - bounds.min[0], d = bounds.max[2] - bounds.min[2];
  const m = Math.max(0.35, 0.05 * Math.max(w, d));
  const footprint: Rect = { x0: bounds.min[0] - m, z0: bounds.min[2] - m, x1: bounds.max[0] + m, z1: bounds.max[2] + m };
  return { footprint, groundY: bounds.min[1] - 0.144 };
}

/** Footprints: the QA apartment's size, a small cottage, a long narrow house, a large square plan. */
const SHAPES: SceneBounds[] = [
  { min: [0, -0.1, 0], max: [11.26, 2.8, 7.49] },
  { min: [2, -0.1, 3], max: [8, 2.6, 8] },
  { min: [0, -0.1, 0], max: [22, 3, 7] },
  { min: [-9, -0.1, -9], max: [9, 3, 9] },
];

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

describe("site layout", () => {
  it("is deterministic", () => {
    for (const style of STYLES) {
      const input = { style, ...site(SHAPES[0]), views: protectedViews(SHAPES[0]) };
      expect(planSite(input)).toEqual(planSite(input));
    }
  });

  for (const bounds of SHAPES) {
    const { footprint, groundY } = site(bounds);
    const views = protectedViews(bounds);
    for (const style of STYLES) {
      const label = `${style}, ${(bounds.max[0] - bounds.min[0]).toFixed(1)} x ${(bounds.max[2] - bounds.min[2]).toFixed(1)} m`;

      it(`keeps the house clear and in view (${label})`, () => {
        const plan = planSite({ style, footprint, groundY, views });
        for (const p of plan.plants) {
          // Nothing grows on the house (bushes may sit close to it, trees keep 2 m off).
          const pad = p.kind === "bush" ? 0.15 : 2;
          expect(p.x > footprint.x0 - pad && p.x < footprint.x1 + pad && p.z > footprint.z0 - pad && p.z < footprint.z1 + pad).toBe(false);
          expect(blocksView(p, groundY, views)).toBe(false);
        }
        // Hard surfaces never cross the house (the urban forecourt lies under the plinth, below its top).
        for (const s of plan.slabs) {
          if (s.kind === "plaza") expect(s.top).toBeLessThan(0.14);
          else expect(overlaps(s.rect, footprint)).toBe(false);
        }
      });

      it(`stays within its performance budget (${label})`, () => {
        const plan = planSite({ style, footprint, groundY, views });
        const trees = plan.plants.filter((p) => p.kind !== "bush").length;
        expect(trees).toBeLessThanOrEqual(SITE_BUDGET.trees);
        expect(plan.plants.length - trees).toBeLessThanOrEqual(SITE_BUDGET.bushes);
        expect(plan.slabs.length).toBeLessThanOrEqual(SITE_BUDGET.slabs);
        for (const p of plan.plants) expect(Math.hypot(p.x - plan.center[0], p.z - plan.center[1])).toBeLessThan(plan.fade[1]);
      });
    }
  }

  it("gives each style its own character", () => {
    const { footprint, groundY } = site(SHAPES[0]);
    const views = protectedViews(SHAPES[0]);
    const kinds = (style: SiteStyle) => new Set(planSite({ style, footprint, groundY, views }).slabs.map((s) => s.kind));
    const trees = (style: SiteStyle) => planSite({ style, footprint, groundY, views }).plants.filter((p) => p.kind !== "bush").length;
    expect([...kinds("minimal")].sort()).toEqual(["bed", "path"]);
    expect(kinds("suburban")).toEqual(new Set(["road", "marking", "curb", "sidewalk", "driveway", "path", "bed"]));
    expect(kinds("urban").has("plaza") && kinds("urban").has("grate") && kinds("urban").has("planter")).toBe(true);
    // Urban street trees stand in their grates and shrubs in their planters, raised to the slab top.
    const urban = planSite({ style: "urban", footprint, groundY, views });
    const holders = urban.slabs.filter((s) => s.kind === "grate" || s.kind === "planter");
    const held = urban.plants.filter((p) => holders.some((s) => p.x > s.rect.x0 && p.x < s.rect.x1 && p.z > s.rect.z0 && p.z < s.rect.z1));
    expect(held.filter((p) => p.base === 0.5).length).toBeGreaterThanOrEqual(4);
    expect(held.filter((p) => p.base === 0.105).length).toBeGreaterThanOrEqual(3);
    expect(trees("suburban")).toBeGreaterThanOrEqual(8);
    expect(trees("urban")).toBeGreaterThanOrEqual(6);
    expect(trees("minimal")).toBeGreaterThanOrEqual(2);
  });

  it("keeps rooms in view when the camera flies to them", () => {
    const bounds = SHAPES[0];
    const { footprint, groundY } = site(bounds);
    const plan = planSite({ style: "suburban", footprint, groundY, views: protectedViews(bounds) });
    // Two rooms of the plan, at the desktop and phone aspect.
    for (const poly of [[[0, 0], [5, 0], [5, 4], [0, 4]], [[6, 3], [11.26, 3], [11.26, 7.49], [6, 7.49]]] as [number, number][][]) {
      for (const aspect of [16 / 9, 0.75]) {
        const pose = roomPose(poly, 2.8, aspect);
        const room = { position: pose.position, targets: [pose.target, ...houseTargets(bounds).slice(0, 8).filter((t) => t[1] > 2)] };
        for (const p of plan.plants) expect(blocksView(p, groundY, [{ position: room.position, targets: [room.targets[0]] }])).toBe(false);
      }
    }
    // And the top view.
    const top = viewPose(bounds, "top", 16 / 9);
    for (const p of plan.plants) expect(blocksView(p, groundY, [{ position: top.position, targets: houseTargets(bounds) }])).toBe(false);
  });

  it("faces the street toward an exterior door, or +z without one", () => {
    const fp: Rect = { x0: 0, z0: 0, x1: 10, z1: 8 };
    expect(chooseFront(fp, [])).toEqual({ facing: "+z", doorU: null });
    expect(chooseFront(fp, [[0.1, 3]]).facing).toBe("-x");
    expect(chooseFront(fp, [[4, 7.9]])).toEqual({ facing: "+z", doorU: -1 });
    // Interior doors are ignored.
    expect(chooseFront(fp, [[5, 4]]).facing).toBe("+z");
    // A door on the front wins over one on the back.
    expect(chooseFront(fp, [[5, 0.1], [7, 7.95]]).facing).toBe("+z");
  });
});

const wall = (id: string, start: Point, end: Point, height = 3, thickness = 0.2) => ({ id, start, end, height, thickness });
const plan = (): FloorPlanData => ({
  version: 1, units: "meters", provenance: "manual",
  source: { floorplan_id: "a".repeat(32), width_px: 1000, height_px: 800 },
  scale: { meters_per_pixel: 0.01, calibrated: true },
  walls: [wall("wall-1", [0, 0], [6, 0]), wall("wall-2", [6, 0], [6, 4]), wall("wall-3", [6, 4], [0, 4]), wall("wall-4", [0, 4], [0, 0]), wall("wall-5", [3, 0], [3, 4])],
  rooms: [
    { id: "room-1", name: "Kitchen", polygon: [[0, 0], [3, 0], [3, 4], [0, 4]] },
    { id: "room-2", name: "Living room", polygon: [[3, 0], [6, 0], [6, 4], [3, 4]] },
  ],
  doors: [
    { id: "door-in", wall_id: "wall-5", offset: 1, width: 0.9, height: 2.1 },
    { id: "door-front", wall_id: "wall-3", offset: 2, width: 0.9, height: 2.1 },
  ],
  windows: [{ id: "window-1", wall_id: "wall-1", offset: 1, width: 1.2, height: 1.2, sill: 0.9 }],
});

describe("surroundings and the house model", () => {
  it("reads the generated model without changing it, and finds the front door", () => {
    const scene = buildScene(plan());
    const before = sceneFingerprint(scene);
    const arrays = JSON.stringify(scene.objects.map((o) => [Array.from(o.mesh.positions), Array.from(o.mesh.indices)]));
    const { footprint, groundY } = site(scene.bounds);
    const doors = doorCenters(scene);
    const site1 = planSite({ style: "suburban", footprint, groundY, doors, views: protectedViews(scene.bounds) });
    buildSlabGeometries(site1, groundY).forEach((g) => g.dispose());
    expect(sceneFingerprint(scene)).toBe(before);
    expect(JSON.stringify(scene.objects.map((o) => [Array.from(o.mesh.positions), Array.from(o.mesh.indices)]))).toBe(arrays);
    expect(doors).toHaveLength(2);
    // wall-3 runs along z = 4 (the +z facade): the street and the entrance path face it.
    expect(site1.front).toBe("+z");
    const path = site1.slabs.find((s) => s.kind === "path")!;
    const doorX = 6 - 2 - 0.45; // wall-3 runs from x = 6 to x = 0; door centre 2 + 0.45 m along it
    expect((path.rect.x0 + path.rect.x1) / 2).toBeCloseTo(doorX, 0);
  });
});

describe("plant geometry", () => {
  const geometries = buildPlantGeometries();

  it("builds every variant with colours and within a triangle budget", () => {
    let total = 0;
    for (const kind of Object.keys(PLANT_SPECS) as PlantKind[]) {
      PLANT_SPECS[kind].forEach((_, v) => {
        const g = geometries.get(`${kind}:${v}`)!;
        expect(g).toBeDefined();
        expect(g.getAttribute("color").count).toBe(g.getAttribute("position").count);
        const tris = (g.index?.count ?? g.getAttribute("position").count) / 3;
        expect(tris).toBeLessThanOrEqual(kind === "bush" ? 1400 : 4500);
        total += tris;
      });
    }
    expect(total).toBeLessThan(20000);
  });

  it("keeps foliage inside the envelope the layout checks sight lines with", () => {
    for (const kind of Object.keys(PLANT_SPECS) as PlantKind[]) {
      PLANT_SPECS[kind].forEach((spec, v) => {
        const pos = geometries.get(`${kind}:${v}`)!.getAttribute("position");
        const p = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          p.fromBufferAttribute(pos, i);
          const inFoliage = spec.envelope.some((e) => Math.hypot(p.x, p.y - e.y, p.z) <= e.r * 1.001);
          const inTrunk = Math.hypot(p.x, p.z) <= spec.trunkRadius + 0.08;
          expect(inFoliage || inTrunk, `${kind}:${v} vertex ${i} at ${p.toArray().map((n) => n.toFixed(2))}`).toBe(true);
          expect(p.y).toBeGreaterThanOrEqual(-1e-6);
          expect(p.y).toBeLessThanOrEqual(spec.height + 1e-6);
        }
      });
    }
  });

  it("is identical on every build", () => {
    const again = buildPlantGeometries();
    for (const [k, g] of geometries) expect(Array.from(again.get(k)!.getAttribute("position").array)).toEqual(Array.from(g.getAttribute("position").array));
  });
});
