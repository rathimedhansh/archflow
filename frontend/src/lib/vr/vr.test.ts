import { describe, expect, it } from "vitest";
import type { FloorPlanData } from "@/lib/floorplan/types";
import { buildScene } from "../geometry3d/buildScene";
import { BODY_RADIUS, buildColliders, clearance, lineOfSight, rayDistance, resolveMove, sliceMesh, type P2 } from "./collision";
import {
  bestViewYaw, forwardOf, nextStopIndex, placeRig, rayToFloor, roomAt, roomCaption, roomStops, rotateY, snapTurn, startStop,
  stickToMove, teleportAllowed, viewDepth, WALK_SPEED, yawOf,
} from "./navigation";
import { describeVRError, detectVRSupport, initialVRStatus, supportMessage, vrReducer, type VRStatus } from "./support";

const T = 0.2; // wall thickness
const wall = (id: string, start: [number, number], end: [number, number]) => ({ id, start, end, height: 2.7, thickness: T });

/** Living room (5 × 4) and bedroom (3 × 4), a door in the partition, a window to the outside. */
const flat = (): FloorPlanData => ({
  version: 1, units: "meters", provenance: "manual",
  source: { floorplan_id: "b".repeat(32), width_px: 900, height_px: 500 },
  scale: { meters_per_pixel: 0.01, calibrated: true },
  walls: [
    wall("w-n", [0, 0], [8, 0]), wall("w-e", [8, 0], [8, 4]), wall("w-s", [8, 4], [0, 4]), wall("w-w", [0, 4], [0, 0]),
    wall("w-mid", [5, 0], [5, 4]),
  ],
  rooms: [
    { id: "living", name: "Living", polygon: [[0, 0], [5, 0], [5, 4], [0, 4]] },
    { id: "bed", name: "Bedroom", polygon: [[5, 0], [8, 0], [8, 4], [5, 4]] },
  ],
  doors: [
    { id: "d-mid", wall_id: "w-mid", offset: 1.5, width: 0.9, height: 2.1 }, // z 1.5 – 2.4
    { id: "d-front", wall_id: "w-w", offset: 1.5, width: 0.9, height: 2.1 }, // west wall runs z 4 → 0: z 2.5 – 1.6
  ],
  windows: [{ id: "win", wall_id: "w-s", offset: 4, width: 1.5, height: 1.2, sill: 0.9 }], // south wall, x 4 → 2.5
});

const scene = buildScene(flat());
const segs = buildColliders(scene);
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe("VR collision from the generated wall meshes", () => {
  it("slices a box into its outline", () => {
    const wallObj = scene.objects.find((o) => o.kind === "wall" && o.sourceId === "w-n")!;
    const s = sliceMesh(wallObj.mesh, 1);
    expect(s.length).toBeGreaterThan(0);
    for (const seg of s) for (const p of [seg.a, seg.b]) expect(Math.abs(p[1])).toBeLessThanOrEqual(T / 2 + 1e-6);
    expect(sliceMesh(wallObj.mesh, 5)).toHaveLength(0); // above the wall
  });

  it("is deterministic and only uses walls and windows", () => {
    expect(buildColliders(scene)).toEqual(segs);
    const noWalls = { ...scene, objects: scene.objects.filter((o) => o.kind === "door" || o.kind === "floor") };
    expect(buildColliders(noWalls)).toHaveLength(0);
  });

  it("keeps doorways open and walls, windows closed", () => {
    expect(lineOfSight([4.5, 1.95], [5.5, 1.95], segs)).toBe(true); // through the partition door
    expect(lineOfSight([0.5, 2.05], [-0.5, 2.05], segs)).toBe(true); // through the front door
    expect(lineOfSight([4.5, 0.8], [5.5, 0.8], segs)).toBe(false); // partition wall
    expect(lineOfSight([3.2, 3.5], [3.2, 4.5], segs)).toBe(false); // the window
  });

  it("stops at a wall and never tunnels, even with a huge step", () => {
    for (const dx of [2, 50]) {
      const p = resolveMove([4.5, 0.8], [dx, 0], segs);
      expect(p[0]).toBeLessThanOrEqual(5 - T / 2 - BODY_RADIUS + 1e-6);
      expect(lineOfSight([4.5, 0.8], p, segs)).toBe(true);
    }
  });

  it("slides along a wall instead of sticking to it", () => {
    const p = resolveMove([4.6, 3.6], [0.5, -0.5], segs); // diagonally into the partition, south of the door
    expect(p[0]).toBeLessThanOrEqual(5 - T / 2 - BODY_RADIUS + 1e-6);
    expect(p[1]).toBeLessThan(3.3); // kept moving north along the wall
    // Sliding further reaches the doorway and passes through it: open doors are not obstacles.
    expect(resolveMove([4.6, 3.0], [1, -1], segs)[0]).toBeGreaterThan(5);
  });

  it("walks through a doorway into the next room", () => {
    const p = resolveMove([4.3, 1.95], [1.4, 0], segs);
    expect(near(p[0], 5.7, 1e-3)).toBe(true);
    expect(roomAt(p, scene.spaces)?.id).toBe("bed");
  });

  it("ignores invalid moves", () => {
    expect(resolveMove([1, 1], [NaN, 0], segs)).toEqual([1, 1]);
    expect(resolveMove([1, 1], [0, 0], segs)).toEqual([1, 1]);
    const free = resolveMove([1, 1], [3, 0], []);
    expect(near(free[0], 4) && free[1] === 1).toBe(true);
  });

  it("measures clearance and ray distance", () => {
    expect(near(clearance([2.5, 1.5], segs), 1.5 - T / 2, 1e-6)).toBe(true);
    expect(clearance([0, 0], [])).toBe(Infinity);
    expect(near(rayDistance([2.5, 1], [1, 0], segs, 30), 2.5 - T / 2, 1e-6)).toBe(true);
    expect(near(rayDistance([2.5, 2], [1, 0], segs, 30), 5.5 - T / 2, 1e-6)).toBe(true); // through the doorway
    expect(rayDistance([2.5, 2], [1, 0], [], 30)).toBe(30);
  });
});

describe("VR navigation", () => {
  it("knows which room a point is in", () => {
    expect(roomAt([1, 1], scene.spaces)?.name).toBe("Living");
    expect(roomAt([6, 1], scene.spaces)?.name).toBe("Bedroom");
    expect(roomAt([-3, 1], scene.spaces)).toBeNull();
    expect(roomAt([1, 1], [])).toBeNull();
  });

  it("starts inside the largest room, looking along its longest view", () => {
    const s = startStop(scene.spaces, segs, [0, 0]);
    expect(s.roomId).toBe("living");
    expect(roomAt(s.position, scene.spaces)?.id).toBe("living");
    expect(rayDistance(s.position, forwardOf(s.yaw), segs, 30)).toBeGreaterThan(2);
    expect(startStop([], segs, [3, 3]).position).toEqual([3, 3]);
  });

  it("has one stop per room, in plan order, and steps between them with wrap-around", () => {
    const stops = roomStops(scene.spaces, segs);
    expect(stops.map((s) => s.roomId)).toEqual(["living", "bed"]);
    for (const s of stops) expect(roomAt(s.position, scene.spaces)?.id).toBe(s.roomId);
    expect(nextStopIndex(stops, "living", 1, -1)).toBe(1);
    expect(nextStopIndex(stops, "bed", 1, -1)).toBe(0);
    expect(nextStopIndex(stops, "living", -1, -1)).toBe(1);
    expect(nextStopIndex(stops, null, 1, -1)).toBe(0); // outside, never jumped yet
    expect(nextStopIndex(stops, null, 1, 0)).toBe(1); // outside, continues from the last stop
    expect(nextStopIndex([], "x", 1, 0)).toBe(-1);
  });

  it("looks down a corridor rather than at a wall", () => {
    const corridor = [
      { a: [-0.5, -10], b: [-0.5, 10] }, { a: [0.5, -10], b: [0.5, 10] },
    ] as { a: P2; b: P2 }[];
    const f = forwardOf(bestViewYaw([0, 0], corridor));
    expect(Math.abs(f[0])).toBeLessThan(1e-9);
  });

  it("does not count the view out through an exterior door", () => {
    const p: P2 = [0.6, 2.05]; // in the living room, in front of the front door (west wall)
    const west = forwardOf(Math.PI / 2);
    expect(viewDepth(p, west, segs)).toBe(30); // straight out of the open door
    expect(viewDepth(p, west, segs, scene.spaces)).toBeLessThan(0.8); // ...but that is outside the property
    const yaw = bestViewYaw(p, segs, scene.spaces);
    expect(roomAt([p[0] + forwardOf(yaw)[0] * 2, p[1] + forwardOf(yaw)[1] * 2], scene.spaces)).not.toBeNull();
    expect(viewDepth(p, forwardOf(yaw), segs, scene.spaces)).toBeGreaterThan(4);
  });

  it("places the rig so the head lands exactly on the target, facing the target yaw", () => {
    for (const [head, headYaw, target, yaw] of [
      [[0, 0], 0, [3, 2], 0], [[0.4, -0.3], 0.7, [3, 2], -1.2], [[-1, 2], -2, [-5, 0.5], 3],
    ] as [P2, number, P2, number][]) {
      const rig = placeRig(head, headYaw, target, yaw);
      const r = rotateY(head, rig.yaw);
      expect(near(rig.position[0] + r[0], target[0])).toBe(true);
      expect(near(rig.position[1] + r[1], target[1])).toBe(true);
      expect(near(rig.yaw + headYaw, yaw)).toBe(true);
    }
    expect(near(yawOf(forwardOf(1.1)), 1.1)).toBe(true);
    expect(forwardOf(0)[1]).toBe(-1); // yaw 0 looks toward -Z
  });

  it("maps the thumbstick to head-relative walking", () => {
    expect(stickToMove([0.1, -0.1], [0, -1], 1)).toEqual([0, 0]); // dead zone
    const fwd = stickToMove([0, -1], [0, -1], 1);
    expect(near(fwd[0], 0)).toBe(true);
    expect(near(fwd[1], -WALK_SPEED)).toBe(true); // full speed, straight ahead
    const right = stickToMove([1, 0], [0, -1], 0.5);
    expect(near(right[0], WALK_SPEED / 2)).toBe(true);
    const turned = stickToMove([0, -1], [1, 0], 1); // looking toward +X
    expect(near(turned[0], WALK_SPEED)).toBe(true);
    expect(stickToMove([0, -1], [0, 0], 1)).toEqual([0, 0]);
    expect(stickToMove([0, -1], [0, -1], 0)).toEqual([0, 0]);
  });

  it("snap-turns once per flick", () => {
    let s = snapTurn(0.9, true);
    expect(s.turn).toBe(1);
    s = snapTurn(0.95, s.armed);
    expect(s.turn).toBe(0); // held: no repeat
    s = snapTurn(0.1, s.armed);
    expect(s.armed).toBe(true);
    expect(snapTurn(-0.8, s.armed).turn).toBe(-1);
    expect(snapTurn(0.5, true).turn).toBe(0);
  });

  it("aims at the floor and validates teleports", () => {
    const hit = rayToFloor([1, 1, 1], [0, -1, -1]);
    expect(hit && near(hit[0], 1) && near(hit[1], 0)).toBe(true);
    expect(rayToFloor([1, 1, 1], [0, 0.2, -1])).toBeNull(); // pointing up
    expect(rayToFloor([0, 1, 0], [0, -0.05, -1])).toBeNull(); // 20 m away
    expect(teleportAllowed([4, 1.95], [6, 1.95], scene.spaces, segs)).toBe(true); // through the doorway
    expect(teleportAllowed([4, 0.8], [6, 0.8], scene.spaces, segs)).toBe(false); // through a wall
    expect(teleportAllowed([1, 1], [-2, 1], scene.spaces, segs)).toBe(false); // outside
    expect(teleportAllowed([2, 2], [4.85, 2.8], scene.spaces, segs)).toBe(false); // against a wall
  });

  it("captions rooms honestly", () => {
    expect(roomCaption({ name: "Kitchen", area: 12.44 }, true)).toBe("Kitchen · 12.4 m²");
    expect(roomCaption({ name: "Kitchen", area: 12.44 }, false)).toBe("Kitchen · ≈ 12.4 m²");
  });
});

describe("VR availability and session state", () => {
  const xr = (r: boolean | Error) => ({ isSessionSupported: () => (r instanceof Error ? Promise.reject(r) : Promise.resolve(r)) });

  it("detects support from the WebXR API only", async () => {
    expect(await detectVRSupport({ isSecureContext: true, xr: xr(true) })).toBe("supported");
    expect(await detectVRSupport({ isSecureContext: true, xr: xr(false) })).toBe("unsupported");
    expect(await detectVRSupport({ isSecureContext: true })).toBe("no-webxr");
    expect(await detectVRSupport({ isSecureContext: true, xr: null })).toBe("no-webxr");
    expect(await detectVRSupport({ isSecureContext: false, xr: xr(true) })).toBe("insecure");
    expect(await detectVRSupport({ isSecureContext: true, xr: xr(new Error("SecurityError")) })).toBe("error");
  });

  it("explains every state in plain language", () => {
    for (const s of ["checking", "supported", "unsupported", "no-webxr", "insecure", "error"] as const) {
      expect(supportMessage(s).length).toBeGreaterThan(20);
    }
  });

  it("follows the session lifecycle", () => {
    let s: VRStatus = initialVRStatus;
    s = vrReducer(s, { type: "request" });
    expect(s.phase).toBe("starting");
    expect(vrReducer(s, { type: "request" })).toBe(s); // double click ignored
    s = vrReducer(s, { type: "started" });
    expect(s).toEqual({ phase: "active", error: null });
    s = vrReducer(s, { type: "ended" });
    expect(s.phase).toBe("idle");
    s = vrReducer(vrReducer(s, { type: "request" }), { type: "failed", message: "no" });
    expect(s).toEqual({ phase: "idle", error: "no" });
    expect(vrReducer(s, { type: "dismiss" }).error).toBeNull();
  });

  it("describes start failures", () => {
    const err = (name: string) => Object.assign(new Error("x"), { name });
    expect(describeVRError(err("NotAllowedError"))).toMatch(/did not allow/);
    expect(describeVRError(err("NotSupportedError"))).toMatch(/cannot start/);
    expect(describeVRError(err("InvalidStateError"))).toMatch(/already running/);
    expect(describeVRError("weird")).toMatch(/could not be started/);
  });
});
