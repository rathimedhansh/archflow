"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type * as THREE from "three";
import type { Scene3D } from "@/lib/geometry3d";
import type { P2 } from "@/lib/vr/collision";
import { roomAt, roomCaption } from "@/lib/vr/navigation";
import { navigationFor, safeSpawn, standingEyeHeight, walkStep, type NavigationModel } from "@/lib/vr/walkable";
import {
  applyLook, applyTurn, approachVelocity, DRAG_SENSITIVITY, frameStep, isIdle, isWalkKey, keysToInput, LOOK_SENSITIVITY, targetVelocity,
  WALK_FAILED, WALK_FOV, WALK_NO_SPAWN, type Look,
} from "@/lib/walk/controls";

/** What the page can ask of the walk-through. */
export interface WalkApi {
  enter: () => void;
  exit: () => void;
  /** Mouse look: must be called from a click (the browser requires a user gesture). */
  lockPointer: () => void;
}

export type WalkEvent =
  | { type: "started" }
  | { type: "ended" }
  | { type: "failed"; message: string }
  | { type: "room"; caption: string }
  | { type: "pointer"; locked: boolean }
  | { type: "pointer-error" };

interface Saved {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  order: THREE.EulerOrder;
  fov: number;
  near: number;
  far: number;
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

interface Props {
  scene: Scene3D;
  apiRef: Ref<WalkApi>;
  onEvent: (e: WalkEvent) => void;
}

/**
 * Desktop first-person walk-through on the existing canvas: same scene, same materials. The
 * camera stands at a fixed eye height and moves with the shared VR walking rule (`walkStep`), so
 * walls, windows and the model's edge stop it and doorways let it through. Renders on demand:
 * frames are requested only while a key is held or the view is turned.
 */
export default function WalkSession({ scene, apiRef, onEvent }: Props) {
  const get = useThree((s) => s.get);
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const starting = useRef<number | null>(null);
  const nav = useRef<NavigationModel | null>(null);
  const pos = useRef<P2>([0, 0]);
  const look = useRef<Look>({ yaw: 0, pitch: 0 });
  const eye = useRef(1.6);
  const held = useRef(new Set<string>());
  const moving = useRef(false);
  /** Walking velocity, m/s in plan coordinates (eases in and out; zero when standing). */
  const velocity = useRef<P2>([0, 0]);
  const roomId = useRef<string | null | undefined>(undefined);
  const saved = useRef<Saved | null>(null);

  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  /** Put the camera where the walker is (and publish it for tests, like `data-camera`). */
  const place = useCallback(() => {
    const { camera, gl } = get();
    camera.position.set(pos.current[0], eye.current, pos.current[1]);
    camera.rotation.set(look.current.pitch, look.current.yaw, 0, "YXZ");
    camera.updateMatrixWorld();
    const el = gl.domElement;
    // x, z, yaw, pitch, eye height
    el.dataset.walkPose = [pos.current[0], pos.current[1], look.current.yaw, look.current.pitch, camera.position.y].map((v) => v.toFixed(3)).join(",");
    const n = nav.current;
    const room = n ? roomAt(pos.current, n.spaces) : null;
    const id = room?.id ?? null;
    el.dataset.walkRoom = id ?? "";
    if (id !== roomId.current) {
      roomId.current = id;
      onEventRef.current({ type: "room", caption: room ? roomCaption(room, scene.scale.calibrated) : "Between rooms" });
    }
  }, [get, scene.scale.calibrated]);

  const restore = useCallback(() => {
    const { camera, gl, invalidate } = get();
    const cam = camera as THREE.PerspectiveCamera;
    const s = saved.current;
    if (s) {
      cam.rotation.order = s.order;
      cam.position.copy(s.position);
      cam.quaternion.copy(s.quaternion);
      cam.fov = s.fov;
      cam.near = s.near;
      cam.far = s.far;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
    }
    saved.current = null;
    delete gl.domElement.dataset.walk;
    delete gl.domElement.dataset.walkPose;
    delete gl.domElement.dataset.walkRoom;
    invalidate();
  }, [get]);

  const enter = useCallback(() => {
    if (activeRef.current || starting.current !== null) return;
    if (get().gl.xr.isPresenting) {
      onEventRef.current({ type: "failed", message: WALK_FAILED });
      return;
    }
    // Let the page paint its "Preparing" state before the (one-off, cached) collision build.
    starting.current = window.setTimeout(() => {
      starting.current = null;
      try {
        const n = navigationFor(scene);
        const spawn = safeSpawn(n);
        if (!spawn) {
          onEventRef.current({ type: "failed", message: WALK_NO_SPAWN });
          return;
        }
        const cam = get().camera as THREE.PerspectiveCamera;
        saved.current = { position: cam.position.clone(), quaternion: cam.quaternion.clone(), order: cam.rotation.order, fov: cam.fov, near: cam.near, far: cam.far };
        nav.current = n;
        pos.current = [spawn.position[0], spawn.position[1]];
        look.current = { yaw: spawn.yaw, pitch: 0 };
        eye.current = standingEyeHeight(n.spaces);
        cam.fov = WALK_FOV;
        cam.near = 0.05; // walls right in front of the eyes must not be clipped
        cam.updateProjectionMatrix();
        held.current.clear();
        moving.current = false;
        velocity.current = [0, 0];
        roomId.current = undefined;
        activeRef.current = true;
        get().gl.domElement.dataset.walk = "active";
        place();
        setActive(true);
        onEventRef.current({ type: "started" });
        get().invalidate();
      } catch {
        restore();
        activeRef.current = false;
        onEventRef.current({ type: "failed", message: WALK_FAILED });
      }
    }, 0);
  }, [get, place, restore, scene]);

  const exit = useCallback(() => {
    if (starting.current !== null) {
      window.clearTimeout(starting.current);
      starting.current = null;
      onEventRef.current({ type: "ended" });
      return;
    }
    if (!activeRef.current) return;
    activeRef.current = false;
    held.current.clear();
    velocity.current = [0, 0];
    const canvas = get().gl.domElement;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    restore();
    setActive(false);
    onEventRef.current({ type: "ended" });
  }, [get, restore]);

  const lockPointer = useCallback(() => {
    if (!activeRef.current) return;
    const canvas = get().gl.domElement;
    try {
      const r = canvas.requestPointerLock() as unknown;
      if (r instanceof Promise) r.catch(() => onEventRef.current({ type: "pointer-error" }));
    } catch {
      onEventRef.current({ type: "pointer-error" });
    }
  }, [get]);

  useImperativeHandle(apiRef, () => ({ enter, exit, lockPointer }), [enter, exit, lockPointer]);

  // ---- input, only while walking; every listener is removed on exit or unmount ----
  useEffect(() => {
    if (!active) return;
    const { gl, invalidate } = get();
    const canvas = gl.domElement;
    const keys = held.current;
    let drag: { id: number; x: number; y: number } | null = null;

    const turnView = (dx: number, dy: number, sensitivity: number) => {
      look.current = applyLook(look.current, dx, dy, sensitivity);
      place();
      invalidate();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "Escape") {
        // With mouse look on, the browser's Esc only releases the pointer; the next Esc leaves.
        if (document.pointerLockElement !== canvas) {
          e.preventDefault();
          exit();
        }
        return;
      }
      if (!isWalkKey(e.code)) return;
      e.preventDefault();
      held.current.add(e.code);
      invalidate();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      held.current.delete(e.code);
    };
    // Keys released while the window is in the background never send keyup: stop walking.
    const stopAll = () => {
      held.current.clear();
      velocity.current = [0, 0]; // losing focus stops at once, no glide
      drag = null;
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") stopAll();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (document.pointerLockElement === canvas) turnView(e.movementX, e.movementY, LOOK_SENSITIVITY);
      else if (drag && e.pointerId === drag.id) {
        // Dragging moves the scene with the pointer (like grabbing it), so the view turns the other way.
        turnView(-(e.clientX - drag.x), -(e.clientY - drag.y), DRAG_SENSITIVITY);
        drag = { id: drag.id, x: e.clientX, y: e.clientY };
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (document.pointerLockElement === canvas || e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      canvas.setPointerCapture?.(e.pointerId);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.id) drag = null;
    };
    const onLockChange = () => onEventRef.current({ type: "pointer", locked: document.pointerLockElement === canvas });
    const onLockError = () => onEventRef.current({ type: "pointer-error" });

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", stopAll);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("pointerlockerror", onLockError);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", stopAll);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("pointerlockerror", onLockError);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      keys.clear();
    };
  }, [active, exit, get, place]);

  // Unmount (page closed, plan changed): cancel a pending start and put the camera back.
  useEffect(() => () => {
    if (starting.current !== null) window.clearTimeout(starting.current);
    if (activeRef.current) {
      activeRef.current = false;
      restore();
    }
  }, [restore]);

  // ---- per-frame movement: one loop, only while walking and only while something moves ----
  useFrame((state, rawDt) => {
    if (!activeRef.current || !nav.current) return;
    const input = keysToInput(held.current);
    const v = velocity.current;
    if (isIdle(input) && v[0] === 0 && v[1] === 0) {
      moving.current = false;
      place(); // keeps the camera authoritative if anything else touched it this frame
      return;
    }
    const dt = frameStep(rawDt, moving.current);
    moving.current = true;
    look.current = applyTurn(look.current, input.turn, dt);
    const next = approachVelocity(v, targetVelocity(input, look.current.yaw), dt);
    const from = pos.current;
    if ((next[0] !== 0 || next[1] !== 0) && dt > 0) {
      pos.current = walkStep(nav.current, from, [next[0] * dt, next[1] * dt]);
      // Keep only the motion that happened: pushing into a wall builds no momentum.
      velocity.current = [(pos.current[0] - from[0]) / dt, (pos.current[1] - from[1]) / dt];
      if (isIdle(input) && Math.hypot(...velocity.current) < 0.02) velocity.current = [0, 0];
    } else {
      velocity.current = next;
    }
    place();
    state.invalidate(); // keep drawing while a key is held or the walker is still slowing down
  });

  return null;
}
