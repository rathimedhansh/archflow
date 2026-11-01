import { describe, expect, it } from "vitest";
import { forwardOf, WALK_SPEED } from "../vr/navigation";
import {
  applyLook, applyTurn, BRISK_SPEED, canWalkOnDevice, FIRST_STEP, frameStep, initialWalkStatus, inputToMove, isIdle, isWalkKey,
  keysToInput, MAX_PITCH, MAX_STEP, TURN_SPEED, walkReducer, WALK_NEEDS_KEYBOARD, type WalkStatus,
  approachVelocity, targetVelocity,
} from "./controls";
import type { FloorPlanData } from "@/lib/floorplan/types";
import { buildScene } from "../geometry3d/buildScene";
import { BODY_RADIUS, clearance } from "../vr/collision";
import { buildNavigation, walkStep } from "../vr/walkable";

const keys = (...codes: string[]) => keysToInput(new Set(codes));
const len = (p: readonly number[]) => Math.hypot(p[0], p[1]);

describe("walk-through keyboard input", () => {
  it("maps WASD and arrows by physical key", () => {
    expect(keys("KeyW").stick).toEqual([0, -1]);
    expect(keys("ArrowUp").stick).toEqual([0, -1]);
    expect(keys("KeyS").stick).toEqual([0, 1]);
    expect(keys("KeyA").stick).toEqual([-1, 0]);
    expect(keys("KeyD").stick).toEqual([1, 0]);
    expect(keys("KeyW", "KeyS").stick).toEqual([0, 0]); // opposite keys cancel
    expect(keys("ArrowLeft").turn).toBe(1); // positive yaw = left
    expect(keys("KeyE").turn).toBe(-1);
    expect(keys("ShiftLeft", "KeyW").brisk).toBe(true);
    expect(isIdle(keys())).toBe(true);
    expect(isIdle(keys("ShiftLeft"))).toBe(true);
    expect(isWalkKey("KeyW") && isWalkKey("ArrowRight")).toBe(true);
    expect(isWalkKey("KeyR") || isWalkKey("Escape") || isWalkKey("KeyF")).toBe(false);
  });

  it("walks where the view looks, at walking speed, diagonals no faster", () => {
    const dt = 0.1;
    const yaw = 0.7;
    const fwd = inputToMove(keys("KeyW"), yaw, dt);
    const f = forwardOf(yaw);
    expect(fwd[0]).toBeCloseTo(f[0] * WALK_SPEED * dt);
    expect(fwd[1]).toBeCloseTo(f[1] * WALK_SPEED * dt);
    expect(len(inputToMove(keys("KeyW", "KeyD"), yaw, dt))).toBeCloseTo(WALK_SPEED * dt);
    expect(len(inputToMove(keys("KeyW", "ShiftLeft"), yaw, dt))).toBeCloseTo(BRISK_SPEED * dt);
    // Strafe right is perpendicular to forward.
    const r = inputToMove(keys("KeyD"), yaw, dt);
    expect(r[0] * f[0] + r[1] * f[1]).toBeCloseTo(0);
    expect(inputToMove(keys(), yaw, dt)).toEqual([0, 0]);
  });

  it("is frame-rate independent and never jumps after a pause or hitch", () => {
    // One second of walking at 30 and at 144 fps covers the same distance.
    const at = (fps: number) => {
      let d = 0;
      let moving = false;
      for (let i = 0; i < fps; i++) {
        const dt = frameStep(1 / fps, moving);
        moving = true;
        d += len(inputToMove(keys("KeyW"), 0, dt));
      }
      return d;
    };
    expect(Math.abs(at(30) - at(144))).toBeLessThan(WALK_SPEED * (1 / 30)); // only the first frame differs
    expect(frameStep(5, false)).toBe(FIRST_STEP); // idle time before the first frame is not walked
    expect(frameStep(5, true)).toBe(MAX_STEP);
    expect(frameStep(NaN, false)).toBe(0);
  });
});

describe("walk-through look", () => {
  it("turns right when the mouse moves right, looks down when it moves down", () => {
    const l = applyLook({ yaw: 0, pitch: 0 }, 100, 50, 0.002);
    expect(l.yaw).toBeCloseTo(-0.2);
    expect(l.pitch).toBeCloseTo(-0.1);
  });

  it("clamps pitch, wraps yaw and ignores invalid movement", () => {
    expect(applyLook({ yaw: 0, pitch: 0 }, 0, -1e6, 0.002).pitch).toBe(MAX_PITCH);
    expect(applyLook({ yaw: 0, pitch: 0 }, 0, 1e6, 0.002).pitch).toBe(-MAX_PITCH);
    const y = applyLook({ yaw: 3, pitch: 0 }, -1000, 0, 0.002).yaw;
    expect(y).toBeGreaterThanOrEqual(-Math.PI);
    expect(y).toBeLessThan(Math.PI);
    expect(applyLook({ yaw: 1, pitch: 0.2 }, NaN, 4, 0.002)).toEqual({ yaw: 1, pitch: 0.2 });
    const turned = applyTurn({ yaw: 0, pitch: 0.1 }, 1, 0.5);
    expect(turned.yaw).toBeCloseTo(TURN_SPEED * 0.5, 12);
    expect(turned.pitch).toBe(0.1);
    expect(applyTurn({ yaw: 0.3, pitch: 0 }, 0, 0.5)).toEqual({ yaw: 0.3, pitch: 0 });
  });
});

describe("walk-through availability and mode switching", () => {
  it("needs a fine pointer with hover (mouse or trackpad)", () => {
    const media = (fine: boolean, hover: boolean) => (q: string) => (q.includes("pointer") ? fine : hover);
    expect(canWalkOnDevice(media(true, true))).toBe(true);
    expect(canWalkOnDevice(media(false, false))).toBe(false); // phone
    expect(canWalkOnDevice(media(true, false))).toBe(false); // stylus-only tablet
  });

  it("follows start, failure, pointer lock and exit", () => {
    let s: WalkStatus = initialWalkStatus;
    s = walkReducer(s, { type: "request" });
    expect(s.phase).toBe("starting");
    expect(walkReducer(s, { type: "request" })).toBe(s); // a double click does not restart
    s = walkReducer(s, { type: "started" });
    expect(s.phase).toBe("active");
    s = walkReducer(s, { type: "pointer", locked: true });
    expect(s.locked).toBe(true);
    s = walkReducer(s, { type: "notice", message: "x" });
    s = walkReducer(s, { type: "ended" });
    expect(s).toEqual(initialWalkStatus); // back to the orbit viewer, nothing left over

    // A failure (no safe start, unsupported device) returns to idle with a message.
    s = walkReducer(walkReducer(initialWalkStatus, { type: "request" }), { type: "failed", message: WALK_NEEDS_KEYBOARD });
    expect(s).toEqual({ ...initialWalkStatus, error: WALK_NEEDS_KEYBOARD });
    // Trying again clears the old message.
    expect(walkReducer(s, { type: "request" })).toEqual({ ...initialWalkStatus, phase: "starting" });
    expect(walkReducer(s, { type: "dismiss" }).error).toBeNull();
    // A late "started" after cancelling, or pointer lock while idle, changes nothing.
    expect(walkReducer(initialWalkStatus, { type: "started" })).toBe(initialWalkStatus);
    expect(walkReducer(initialWalkStatus, { type: "pointer", locked: true }).locked).toBe(false);
  });
});

describe("smooth start and stop", () => {
  const hold = (fps: number, seconds: number, keys: string[], start: [number, number] = [0, 0]) => {
    let v = start;
    const target = targetVelocity(keysToInput(new Set(keys)), 0);
    for (let i = 0; i < Math.round(fps * seconds); i++) v = approachVelocity(v, target, 1 / fps);
    return v;
  };

  it("reaches walking speed within a quarter of a second, never faster", () => {
    expect(len(hold(60, 0.1, ["KeyW"]))).toBeGreaterThan(WALK_SPEED * 0.6);
    expect(len(hold(60, 0.25, ["KeyW"]))).toBeGreaterThan(WALK_SPEED * 0.9);
    let v: [number, number] = [0, 0];
    const t = targetVelocity(keysToInput(new Set(["KeyW", "KeyD", "ShiftLeft"])), 1.1);
    for (let i = 0; i < 600; i++) {
      v = approachVelocity(v, t, 1 / 144);
      expect(len(v)).toBeLessThanOrEqual(BRISK_SPEED + 1e-9); // diagonals included: no overshoot
    }
  });

  it("is frame-rate independent", () => {
    const a = hold(30, 0.2, ["KeyW"]);
    const b = hold(144, 0.2, ["KeyW"]);
    expect(Math.abs(len(a) - len(b))).toBeLessThan(0.01);
  });

  it("stops within ~0.2 s and ~0.12 m after the key is released, then rests exactly", () => {
    let v: [number, number] = [0, -WALK_SPEED];
    let travelled = 0;
    let frames = 0;
    while ((v[0] !== 0 || v[1] !== 0) && frames < 600) {
      v = approachVelocity(v, [0, 0], 1 / 60);
      travelled += len(v) / 60;
      frames++;
    }
    expect(frames / 60).toBeLessThan(0.35);
    expect(travelled).toBeLessThan(0.12);
    expect(v).toEqual([0, 0]);
  });

  it("ignores invalid time steps", () => {
    expect(approachVelocity([1, 0], [0, 0], NaN)).toEqual([1, 0]);
    expect(approachVelocity([1, 0], [0, 0], 0)).toEqual([1, 0]);
  });

  it("smoothed steps through the shared walkStep never cross a wall", () => {
    const wall = (id: string, s0: [number, number], e: [number, number]) => ({ id, start: s0, end: e, height: 2.7, thickness: 0.2 });
    const plan: FloorPlanData = {
      version: 1, units: "meters", provenance: "manual",
      source: { floorplan_id: "f".repeat(32), width_px: 500, height_px: 500 }, scale: { meters_per_pixel: 0.01, calibrated: true },
      walls: [wall("n", [0, 0], [4, 0]), wall("e", [4, 0], [4, 4]), wall("s", [4, 4], [0, 4]), wall("w", [0, 4], [0, 0])],
      rooms: [{ id: "r", name: "Room", polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] }], doors: [], windows: [],
    };
    const nav = buildNavigation(buildScene(plan));
    let p: [number, number] = [2, 2];
    let v: [number, number] = [0, 0];
    for (let i = 0; i < 400; i++) {
      const dt = i % 7 === 0 ? MAX_STEP : 1 / 60; // with hitches
      v = approachVelocity(v, targetVelocity(keysToInput(new Set(["KeyW", "ShiftLeft"])), 0.3), dt);
      const from = p;
      p = walkStep(nav, from, [v[0] * dt, v[1] * dt]);
      v = [(p[0] - from[0]) / dt, (p[1] - from[1]) / dt];
      expect(p[0]).toBeGreaterThan(0.1);
      expect(p[1]).toBeGreaterThan(0.1);
    }
    expect(clearance(p, nav.walls)).toBeGreaterThanOrEqual(BODY_RADIUS - 1e-6);
    expect(len(v)).toBeLessThan(BRISK_SPEED); // against the wall: sliding, not stored momentum
  });
});
