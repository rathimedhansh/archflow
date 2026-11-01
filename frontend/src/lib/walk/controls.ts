/**
 * Desktop first-person walk-through: input mapping, look maths and the UI state machine.
 * Pure, no React or Three.js. Movement itself goes through the shared `walkStep`
 * (lib/vr/walkable.ts), exactly as in VR.
 *
 * Yaw 0 looks toward -Z; positive yaw turns left (as in Three.js and lib/vr/navigation.ts).
 */
import type { P2 } from "../vr/collision";
import { forwardOf, stickToMove, WALK_SPEED } from "../vr/navigation";

/** Holding Shift walks a little faster; still a walk, not a run. */
export const BRISK_SPEED = 2.4;
/** Arrow / Q / E keys turn smoothly at this rate, radians per second. */
export const TURN_SPEED = (100 * Math.PI) / 180;
/** Radians per pixel: mouse look (pointer locked) and dragging the view. */
export const LOOK_SENSITIVITY = 0.0022;
export const DRAG_SENSITIVITY = 0.0045;
/** Look up/down limit (radians from level). */
export const MAX_PITCH = (80 * Math.PI) / 180;
/** Frame steps are capped so a hitch never becomes a jump. */
export const MAX_STEP = 0.1;
/** The first frame after standing still: a normal frame, not the idle time before it. */
export const FIRST_STEP = 1 / 60;
/** Wider than the 45° orbit view: closer to what eyes see indoors. */
export const WALK_FOV = 70;

const BINDINGS = {
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA"],
  right: ["KeyD"],
  turnLeft: ["ArrowLeft", "KeyQ"],
  turnRight: ["ArrowRight", "KeyE"],
  brisk: ["ShiftLeft", "ShiftRight"],
} as const;
const ALL_KEYS = new Set<string>(Object.values(BINDINGS).flat());

/** Is this `KeyboardEvent.code` one the walk-through uses? (Physical keys: works on any layout.) */
export const isWalkKey = (code: string) => ALL_KEYS.has(code);

export interface WalkInput {
  /** Like a thumbstick: x right, y down (forward is negative y). */
  stick: [number, number];
  turn: -1 | 0 | 1;
  brisk: boolean;
}

export function keysToInput(held: ReadonlySet<string>): WalkInput {
  const any = (codes: readonly string[]) => codes.some((c) => held.has(c));
  const axis = (neg: boolean, pos: boolean) => (pos ? 1 : 0) - (neg ? 1 : 0);
  const x = axis(any(BINDINGS.left), any(BINDINGS.right));
  const y = axis(any(BINDINGS.forward), any(BINDINGS.back));
  const t = axis(any(BINDINGS.turnRight), any(BINDINGS.turnLeft)); // left is positive yaw
  return { stick: [x, y], turn: t as -1 | 0 | 1, brisk: any(BINDINGS.brisk) };
}

export const isIdle = (i: WalkInput) => i.stick[0] === 0 && i.stick[1] === 0 && i.turn === 0;

/** Horizontal move for this frame, relative to the view direction. Diagonals are not faster. */
export function inputToMove(input: WalkInput, yaw: number, dt: number): P2 {
  return stickToMove(input.stick, forwardOf(yaw), dt, input.brisk ? BRISK_SPEED : WALK_SPEED, 0);
}

/** Seconds for the walking speed to close ~63 % of the gap to the target: speeding up, slowing down. */
export const ACCEL_TIME = 0.09;
export const DECEL_TIME = 0.07;
/** Below this speed (m/s) with no input the walker is standing still. */
export const REST_SPEED = 0.02;

/**
 * Smooth start and stop: the velocity (m/s, plan coordinates) eases toward the target velocity
 * the keys ask for, exponentially, so it is frame-rate independent and never overshoots: its
 * speed never exceeds the faster of the two. Speeding up and slowing down take a few frames
 * (~0.2 s to 90 %), short enough not to feel like lag. Movement itself still goes through the
 * shared `walkStep` (collision, sub-steps), only with `velocity × dt` as the step.
 */
export function approachVelocity(v: P2, target: P2, dt: number): P2 {
  if (!(dt > 0) || !Number.isFinite(dt)) return v;
  const speeding = target[0] * target[0] + target[1] * target[1] >= v[0] * v[0] + v[1] * v[1];
  const a = 1 - Math.exp(-dt / (speeding ? ACCEL_TIME : DECEL_TIME));
  const next: P2 = [v[0] + (target[0] - v[0]) * a, v[1] + (target[1] - v[1]) * a];
  const idle = target[0] === 0 && target[1] === 0;
  return idle && Math.hypot(next[0], next[1]) < REST_SPEED ? [0, 0] : next;
}

/** Target velocity (m/s) for the keys held, relative to the view direction. Diagonals are not faster. */
export function targetVelocity(input: WalkInput, yaw: number): P2 {
  return inputToMove(input, yaw, 1);
}

/** Frame step: capped; the first frame of a movement uses a normal frame length. */
export function frameStep(rawDt: number, wasMoving: boolean): number {
  if (!(rawDt > 0) || !Number.isFinite(rawDt)) return wasMoving ? FIRST_STEP : 0;
  return Math.min(rawDt, wasMoving ? MAX_STEP : FIRST_STEP);
}

export interface Look {
  yaw: number;
  pitch: number;
}

const TAU = Math.PI * 2;
const wrap = (a: number) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

/** Apply a mouse/drag movement (pixels; right and down positive). Moving right looks right. */
export function applyLook(look: Look, dx: number, dy: number, sensitivity: number): Look {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return look;
  return {
    yaw: wrap(look.yaw - dx * sensitivity),
    pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, look.pitch - dy * sensitivity)),
  };
}

export function applyTurn(look: Look, turn: -1 | 0 | 1, dt: number): Look {
  return turn === 0 ? look : { ...look, yaw: wrap(look.yaw + turn * TURN_SPEED * dt) };
}

/** Walk-through needs a keyboard and a precise pointer. True when this device has both. */
export function canWalkOnDevice(matches: (query: string) => boolean): boolean {
  return matches("(any-pointer: fine)") && matches("(any-hover: hover)");
}

export const WALK_NEEDS_KEYBOARD =
  "Walk-through needs a keyboard and a mouse or trackpad, so it is not available on this device. The 3D view works as usual.";
export const WALK_NO_SPAWN =
  "There is no safe place to start walking in this model (every candidate point is inside or against a wall). Check the walls and rooms in the editor.";
export const WALK_FAILED = "The walk-through could not be started.";
export const POINTER_LOCK_FAILED = "The browser did not allow mouse look. Drag the view to look around instead.";

/** UI state of a walk-through. "starting": preparing navigation data. */
export type WalkPhase = "idle" | "starting" | "active";
export interface WalkStatus {
  phase: WalkPhase;
  error: string | null;
  /** Mouse look (pointer lock) is on. */
  locked: boolean;
  notice: string | null;
}
export type WalkAction =
  | { type: "request" }
  | { type: "started" }
  | { type: "ended" }
  | { type: "failed"; message: string }
  | { type: "pointer"; locked: boolean }
  | { type: "notice"; message: string | null }
  | { type: "dismiss" };

export const initialWalkStatus: WalkStatus = { phase: "idle", error: null, locked: false, notice: null };

export function walkReducer(s: WalkStatus, a: WalkAction): WalkStatus {
  switch (a.type) {
    case "request":
      return s.phase === "idle" ? { ...initialWalkStatus, phase: "starting" } : s;
    case "started":
      return s.phase === "starting" ? { ...s, phase: "active", error: null } : s;
    case "ended":
      return { ...initialWalkStatus, error: s.error };
    case "failed":
      return { ...initialWalkStatus, error: a.message };
    case "pointer":
      return s.phase === "active" ? { ...s, locked: a.locked } : { ...s, locked: false };
    case "notice":
      return { ...s, notice: a.message };
    case "dismiss":
      return { ...s, error: null };
  }
}
