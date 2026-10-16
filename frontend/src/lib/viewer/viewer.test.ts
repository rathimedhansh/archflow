import { describe, expect, it } from "vitest";
import type { FloorPlanData } from "@/lib/floorplan/types";
import { sceneFingerprint } from "../geometry3d/fingerprint";
import { labelAnchor, pointInPolygon, distanceToOutline } from "./labelAnchor";
import { DEFAULT_LAYERS, LAYER_INFO } from "./layers";
import { parseFloorPlan, prepareModel } from "./prepareModel";

const wall = (id: string, start: [number, number], end: [number, number]) => ({ id, start, end, height: 2.8, thickness: 0.15 });

const house = (): FloorPlanData => ({
  version: 1, units: "meters", provenance: "manual",
  source: { floorplan_id: "a".repeat(32), width_px: 1000, height_px: 800 },
  scale: { meters_per_pixel: 0.01, calibrated: true },
  walls: [wall("wall-1", [0, 0], [6, 0]), wall("wall-2", [6, 0], [6, 4]), wall("wall-3", [6, 4], [0, 4]), wall("wall-4", [0, 4], [0, 0])],
  rooms: [{ id: "room-1", name: "Living", polygon: [[0, 0], [6, 0], [6, 4], [0, 4]] }],
  doors: [{ id: "door-1", wall_id: "wall-1", offset: 1, width: 0.9, height: 2.1 }],
  windows: [{ id: "window-1", wall_id: "wall-3", offset: 2, width: 1.2, height: 1.2, sill: 0.9 }],
});

describe("prepareModel: never crashes, always explains", () => {
  it.each([
    ["null", null],
    ["a string", "hello"],
    ["a number", 42],
    ["an array", [1, 2, 3]],
    ["an empty object (no version)", {}],
    ["a future version", { ...house(), version: 2 }],
  ])("rejects %s as invalid", (_, raw) => {
    const m = prepareModel(raw);
    expect(m.kind).toBe("invalid");
    if (m.kind === "invalid") expect(m.message.length).toBeGreaterThan(10);
  });

  it("builds a ready model from a valid plan", () => {
    const m = prepareModel(house());
    expect(m.kind).toBe("ready");
    if (m.kind !== "ready") return;
    expect(m.stats).toMatchObject({ walls: 4, rooms: 1, doors: 1, windows: 1, calibrated: true });
    expect(m.stats.floorArea).toBeCloseTo(24, 6);
    expect(m.notes).toEqual([]);
  });

  it("reports an empty plan as empty, not as an error", () => {
    const m = prepareModel({ ...house(), walls: [], rooms: [], doors: [], windows: [] });
    expect(m.kind).toBe("empty");
  });

  it("tolerates missing element lists", () => {
    const { walls, ...rest } = house();
    void walls;
    const m = prepareModel({ ...rest, doors: undefined, windows: undefined });
    expect(m.kind).toBe("ready");
    if (m.kind === "ready") expect(m.stats).toMatchObject({ walls: 0, rooms: 1 });
  });

  it("drops malformed elements and says so", () => {
    const raw = {
      ...house(),
      walls: [
        ...house().walls,
        { id: "w-nan", start: [0, 0], end: [NaN, 1], height: 2.8, thickness: 0.15 },
        { id: "w-str", start: ["0", "0"], end: [1, 1], height: 2.8, thickness: 0.15 },
        { id: "w-neg", start: [0, 0], end: [1, 1], height: -1, thickness: 0.15 },
        { id: "w-huge", start: [0, 0], end: [1e12, 1], height: 2.8, thickness: 0.15 },
        null,
        "wall",
      ],
      rooms: [...house().rooms, { id: "r-2pt", name: "Line", polygon: [[0, 0], [1, 1]] }, { id: "r-noname", polygon: [[0, 0], [1, 0], [1, 1]] }],
      doors: [...house().doors, { id: "d-bad", wall_id: "wall-1", offset: "1", width: 0.9, height: 2.1 }],
    };
    const m = prepareModel(raw);
    expect(m.kind).toBe("ready");
    if (m.kind !== "ready") return;
    expect(m.stats.walls).toBe(4);
    expect(m.stats.doors).toBe(1);
    expect(m.scene.spaces.map((s) => s.name)).toEqual(["Living", "Unnamed room"]);
    expect(m.notes.join(" ")).toMatch(/6 walls with missing or invalid data were skipped/);
    expect(m.notes.join(" ")).toMatch(/1 room with missing or invalid data was skipped/);
    expect(m.notes.join(" ")).toMatch(/1 door with missing or invalid data was skipped/);
  });

  it("drops duplicate ids (React keys and wall lookups need unique ids)", () => {
    const raw = { ...house(), walls: [...house().walls, wall("wall-1", [0, 0], [1, 0])] };
    const m = prepareModel(raw);
    expect(m.kind === "ready" && m.stats.walls).toBe(4);
    expect(m.kind === "ready" && m.notes.some((n) => /duplicate id/.test(n))).toBe(true);
  });

  it("treats a non-array element list as malformed but keeps the rest", () => {
    const m = prepareModel({ ...house(), windows: { oops: true } });
    expect(m.kind).toBe("ready");
    if (m.kind === "ready") expect(m.notes).toContain("The plan's windows list is malformed and was ignored.");
  });

  it("reports a plan whose every element is malformed as no-geometry, with reasons", () => {
    const m = prepareModel({ ...house(), walls: [{ id: "w" }], rooms: "oops", doors: [], windows: [] });
    expect(m.kind).toBe("no-geometry");
    if (m.kind === "no-geometry") expect(m.notes).toHaveLength(2);
  });

  it("reports a plan whose elements produce no geometry", () => {
    const m = prepareModel({ ...house(), walls: [wall("w", [1, 1], [1, 1])], rooms: [], doors: [], windows: [] });
    expect(m.kind).toBe("no-geometry");
    if (m.kind === "no-geometry") expect(m.notes.length).toBeGreaterThan(0);
  });

  it("never claims calibration it does not have", () => {
    expect(parseFloorPlan({ ...house(), scale: { meters_per_pixel: 0.01, calibrated: "yes" } })).toMatchObject({ ok: true, plan: { scale: { calibrated: false } } });
    const noScale = parseFloorPlan({ ...house(), scale: undefined });
    expect(noScale).toMatchObject({ ok: true, plan: { scale: { calibrated: false } } });
    expect(noScale.ok && noScale.notes.some((n) => /no scale/.test(n))).toBe(true);
  });

  it("is deterministic and does not mutate its input", () => {
    const raw = house();
    const before = JSON.stringify(raw);
    const a = prepareModel(raw);
    const b = prepareModel(JSON.parse(before));
    expect(JSON.stringify(raw)).toBe(before);
    expect(a.kind === "ready" && b.kind === "ready" && sceneFingerprint(a.scene) === sceneFingerprint(b.scene)).toBe(true);
  });

  it("survives a deterministic fuzz of corrupted plans", () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const junk = [null, undefined, NaN, Infinity, -1, 0, "x", [], {}, [1], [NaN, 1], 1e9, true];
    const corrupt = (v: unknown, depth = 0): unknown => {
      if (rand() < 0.08) return junk[Math.floor(rand() * junk.length)];
      if (Array.isArray(v)) return v.map((x) => corrupt(x, depth + 1));
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, corrupt(x, depth + 1)]));
      if (typeof v === "number" && rand() < 0.1) return v * (rand() * 4 - 2);
      return v;
    };
    for (let i = 0; i < 300; i++) {
      const m = prepareModel(corrupt(house()));
      expect(["invalid", "empty", "no-geometry", "ready"]).toContain(m.kind);
      if (m.kind === "ready") expect([...m.scene.bounds.min, ...m.scene.bounds.max].every(Number.isFinite)).toBe(true);
    }
  });
});

describe("labelAnchor", () => {
  it("uses the centre of a rectangular room", () => {
    const [x, y] = labelAnchor([[0, 0], [6, 0], [6, 4], [0, 4]]);
    expect(x).toBeCloseTo(3, 9);
    expect(y).toBeCloseTo(2, 9);
  });

  it("keeps the label inside an L-shaped room", () => {
    const L: [number, number][] = [[0, 0], [8, 0], [8, 1], [1, 1], [1, 8], [0, 8]];
    const p = labelAnchor(L);
    expect(pointInPolygon(p, L)).toBe(true);
    expect(distanceToOutline(p, L)).toBeGreaterThan(0.3);
  });

  it("keeps the label inside a U-shaped room whose centroid is outside", () => {
    const U: [number, number][] = [[0, 0], [9, 0], [9, 9], [7, 9], [7, 2], [2, 2], [2, 9], [0, 9]];
    const p = labelAnchor(U);
    expect(pointInPolygon(p, U)).toBe(true);
    expect(distanceToOutline(p, U)).toBeGreaterThan(0.8);
  });

  it("is deterministic and handles degenerate input", () => {
    const U: [number, number][] = [[0, 0], [9, 0], [9, 9], [7, 9], [7, 2], [2, 2], [2, 9], [0, 9]];
    expect(labelAnchor(U)).toEqual(labelAnchor(U));
    expect(labelAnchor([])).toEqual([0, 0]);
    expect(labelAnchor([[1, 1], [1, 1], [1, 1]]).every(Number.isFinite)).toBe(true);
  });
});

describe("layers", () => {
  it("shows everything by default and describes every layer", () => {
    expect(Object.values(DEFAULT_LAYERS).every(Boolean)).toBe(true);
    expect(LAYER_INFO.map((l) => l.key).sort()).toEqual(Object.keys(DEFAULT_LAYERS).sort());
  });
});
