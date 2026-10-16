import { describe, expect, it } from "vitest";
import {
  closestPointOnSegment,
  polygonArea,
  polygonCentroid,
  polygonSelfIntersects,
  snapPoint,
} from "./geometry";
import { editorReducer, initialEditorState } from "./history";
import {
  addOpening, addRoom, addWall, applyScale, findJoint, moveJoint, nearestWall, removeElement,
} from "./ops";
import type { FloorPlanData, Point } from "./types";
import { validateFloorPlan } from "./validate";

const empty = (): FloorPlanData => ({
  version: 1, units: "meters", provenance: "manual",
  source: { floorplan_id: "a".repeat(32), width_px: 1000, height_px: 800 },
  scale: { meters_per_pixel: 0.01, calibrated: false },
  walls: [], rooms: [], doors: [], windows: [],
});

describe("geometry", () => {
  const square: Point[] = [[0, 0], [4, 0], [4, 3], [0, 3]];
  it("computes area and centroid", () => {
    expect(polygonArea(square)).toBe(12);
    expect(polygonCentroid(square)).toEqual([2, 1.5]);
  });
  it("detects self-intersection but allows concave shapes", () => {
    expect(polygonSelfIntersects([[0, 0], [4, 4], [4, 0], [0, 4]])).toBe(true);
    expect(polygonSelfIntersects([[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]])).toBe(false);
  });
  it("finds the closest point on a segment, clamped to its ends", () => {
    expect(closestPointOnSegment([2, 5], [0, 0], [4, 0])).toMatchObject({ point: [2, 0], along: 2, distance: 5 });
    expect(closestPointOnSegment([-3, 0], [0, 0], [4, 0]).point).toEqual([0, 0]);
  });
  it("snaps to targets first, then to orthogonal", () => {
    const targets: Point[] = [[10, 10]];
    expect(snapPoint([10.2, 9.9], { targets, radius: 0.5 })).toEqual({ point: [10, 10], snappedTo: "point" });
    const ortho = snapPoint([5, 0.1], { targets: [], radius: 0.5, orthoFrom: [0, 0] });
    expect(ortho).toEqual({ point: [5, 0], snappedTo: "ortho" });
    const vertical = snapPoint([0.1, 5], { targets: [], radius: 0.5, orthoFrom: [0, 0] });
    expect(vertical.point).toEqual([0, 5]);
    expect(snapPoint([5, 3], { targets: [], radius: 0.5, orthoFrom: [0, 0] }).snappedTo).toBeNull();
  });
});

describe("ops", () => {
  it("adds walls with unique incrementing ids", () => {
    let { plan } = addWall(empty(), [0, 0], [5, 0]);
    const r = addWall(plan, [5, 0], [5, 4]);
    plan = r.plan;
    expect(plan.walls.map((w) => w.id)).toEqual(["wall-1", "wall-2"]);
    plan = removeElement(plan, { kind: "wall", id: "wall-1" });
    expect(addWall(plan, [0, 0], [1, 1]).id).toBe("wall-3");
  });

  it("places openings centred and clamped inside the wall", () => {
    const { plan } = addWall(empty(), [0, 0], [5, 0]);
    const d = addOpening(plan, "door", "wall-1", 0.1)!; // near the start: clamped
    expect(d.plan.doors[0].offset).toBe(0);
    const w = addOpening(plan, "window", "wall-1", 2.5)!;
    expect(w.plan.windows[0].offset).toBeCloseTo(1.9);
    expect(addOpening(plan, "door", "missing", 1)).toBeNull();
  });

  it("removing a wall removes its openings", () => {
    let { plan } = addWall(empty(), [0, 0], [5, 0]);
    plan = addOpening(plan, "door", "wall-1", 2)!.plan;
    plan = addOpening(plan, "window", "wall-1", 4)!.plan;
    plan = removeElement(plan, { kind: "wall", id: "wall-1" });
    expect(plan.doors).toHaveLength(0);
    expect(plan.windows).toHaveLength(0);
  });

  it("moves a joint shared by walls and room corners together", () => {
    let { plan } = addWall(empty(), [0, 0], [5, 0]);
    plan = addWall(plan, [5, 0], [5, 4]).plan;
    plan = addRoom(plan, [[0, 0], [5, 0], [5, 4]]).plan;
    const joint = findJoint(plan, [5, 0]);
    expect(joint.wallEnds).toHaveLength(2);
    expect(joint.roomVertices).toHaveLength(1);
    const moved = moveJoint(plan, joint, [6, 1]);
    expect(moved.walls[0].end).toEqual([6, 1]);
    expect(moved.walls[1].start).toEqual([6, 1]);
    expect(moved.rooms[0].polygon[1]).toEqual([6, 1]);
    expect(moved.walls[0].start).toEqual([0, 0]);
    expect(plan.walls[0].end).toEqual([5, 0]); // original untouched
  });

  it("finds the nearest wall within range only", () => {
    const { plan } = addWall(empty(), [0, 0], [5, 0]);
    expect(nearestWall(plan, [2, 0.2], 0.5)?.along).toBeCloseTo(2);
    expect(nearestWall(plan, [2, 3], 0.5)).toBeNull();
  });

  it("rescales geometry on calibration while keeping pixel positions", () => {
    let { plan } = addWall(empty(), [1, 1], [6, 1]); // 100px..600px at 0.01 m/px
    plan = addOpening(plan, "door", "wall-1", 2)!.plan;
    const scaled = applyScale(plan, 0.02);
    expect(scaled.scale).toEqual({ meters_per_pixel: 0.02, calibrated: true });
    expect(scaled.walls[0].end).toEqual([12, 2]);
    expect(scaled.doors[0].width).toBeCloseTo(1.8);
    expect(scaled.walls[0].height).toBe(2.8);
  });
});

describe("validateFloorPlan", () => {
  it("passes a sound plan", () => {
    let { plan } = addWall(empty(), [0, 0], [5, 0]);
    plan = addOpening(plan, "door", "wall-1", 2)!.plan;
    plan = addRoom(plan, [[0, 0], [5, 0], [5, 4], [0, 4]]).plan;
    expect(validateFloorPlan(plan)).toEqual([]);
  });

  it("flags overlaps, overhangs, crossing rooms and short walls", () => {
    let { plan } = addWall(empty(), [0, 0], [5, 0]);
    plan = addWall(plan, [0, 0], [0.01, 0]).plan;
    plan = addOpening(plan, "door", "wall-1", 2)!.plan;
    plan = addOpening(plan, "window", "wall-1", 2.2)!.plan;
    plan = addRoom(plan, [[0, 0], [4, 4], [4, 0], [0, 4]]).plan;
    const messages = validateFloorPlan(plan).map((i) => i.message).join("|");
    expect(messages).toMatch(/too short/);
    expect(messages).toMatch(/overlap/);
    expect(messages).toMatch(/crosses itself/);

    const shrunk = { ...plan, walls: plan.walls.map((w) => (w.id === "wall-1" ? { ...w, end: [1, 0] as Point } : w)) };
    expect(validateFloorPlan(shrunk).map((i) => i.message).join("|")).toMatch(/extends past/);
  });
});

describe("editorReducer", () => {
  it("supports undo/redo and tracks dirtiness by reference", () => {
    const s0 = initialEditorState(empty());
    const p1 = addWall(s0.plan, [0, 0], [1, 0]).plan;
    const s1 = editorReducer(s0, { type: "apply", plan: p1, checkpoint: true });
    expect(s1.plan).not.toBe(s1.saved);
    const s2 = editorReducer(s1, { type: "undo" });
    expect(s2.plan).toBe(s0.plan);
    expect(s2.plan).toBe(s2.saved); // back to clean
    const s3 = editorReducer(s2, { type: "redo" });
    expect(s3.plan).toBe(p1);
    expect(editorReducer(s0, { type: "undo" })).toBe(s0); // nothing to undo
  });

  it("groups continuous edits into one undo step", () => {
    let s = initialEditorState(addWall(empty(), [0, 0], [5, 0]).plan);
    s = editorReducer(s, { type: "checkpoint" });
    for (const x of [6, 7, 8]) {
      s = editorReducer(s, { type: "apply", plan: { ...s.plan, walls: [{ ...s.plan.walls[0], end: [x, 0] }] }, checkpoint: false });
    }
    expect(s.plan.walls[0].end).toEqual([8, 0]);
    s = editorReducer(s, { type: "undo" });
    expect(s.plan.walls[0].end).toEqual([5, 0]);
  });

  it("a new edit clears the redo stack; saving marks clean only for the sent plan", () => {
    let s = initialEditorState(empty());
    s = editorReducer(s, { type: "apply", plan: addWall(s.plan, [0, 0], [1, 0]).plan, checkpoint: true });
    s = editorReducer(s, { type: "undo" });
    s = editorReducer(s, { type: "apply", plan: addWall(s.plan, [0, 0], [2, 0]).plan, checkpoint: true });
    expect(s.future).toHaveLength(0);
    const sent = s.plan;
    s = editorReducer(s, { type: "apply", plan: addWall(s.plan, [0, 0], [3, 0]).plan, checkpoint: true });
    s = editorReducer(s, { type: "saved", plan: sent });
    expect(s.plan).not.toBe(s.saved); // edited during the save request
  });
});
