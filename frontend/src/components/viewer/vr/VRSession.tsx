"use client";

import { createPortal, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import * as THREE from "three";
import type { Scene3D } from "@/lib/geometry3d";
import { buildColliders, resolveMove, type P2 } from "@/lib/vr/collision";
import {
  forwardOf, nextStopIndex, placeRig, rayToFloor, roomAt, roomCaption, roomStops, rotateY, SNAP_ANGLE, snapTurn, startStop,
  stickToMove, teleportAllowed, yawOf, type RigPose, type RoomStop,
} from "@/lib/vr/navigation";
import { describeVRError } from "@/lib/vr/support";
import VRHud, { WELCOME_LINES } from "./VRHud";
import VRRoomLabels from "./VRRoomLabels";

/** What the page can ask of the VR session. `enter` must be called from a click (user activation). */
export interface VRApi {
  enter: () => void;
  exit: () => void;
}

export type VREvent = { type: "started" } | { type: "ended" } | { type: "failed"; message: string };

/** Eye height used when the headset cannot report the floor (a "local" reference space). */
const EYE_HEIGHT = 1.6;
const FADE_S = 0.16;
const FRESH_ROOM_S = 4;
const WELCOME_MAX_S = 25;
const EXIT_HOLD_S = 1;

interface Fade {
  t: number;
  /** Runs once the screen is black; returns the new rig pose. */
  action: (() => void) | null;
}

interface Hand {
  buttons: boolean[];
}

const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();

/** Horizontal yaw of an XR orientation (rotation of the -Z axis). */
function yawOfOrientation(o: DOMPointReadOnly): number {
  tmpQ.set(o.x, o.y, o.z, o.w);
  tmpV.set(0, 0, -1).applyQuaternion(tmpQ);
  return yawOf([tmpV.x, tmpV.z]);
}

interface Props {
  scene: Scene3D;
  apiRef: Ref<VRApi>;
  showLabels: boolean;
  title?: string;
  onEvent: (e: VREvent) => void;
}

/**
 * Immersive VR on the existing canvas: the same scene graph, materials and model, viewed
 * through a WebXR headset. Adds a play-space rig (start point, walking with wall collision,
 * snap turns, teleport, room-to-room jumps), in-scene room labels and a small HUD.
 * Nothing here runs or renders until a session starts.
 */
export default function VRSession({ scene, apiRef, showLabels, title, onEvent }: Props) {
  const get = useThree((s) => s.get);
  const camera = useThree((s) => s.camera);
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);

  const segs = useMemo(() => buildColliders(scene), [scene]);
  const stops = useMemo(() => roomStops(scene.spaces, segs), [scene.spaces, segs]);
  const start = useMemo<RoomStop>(() => {
    const { min, max } = scene.bounds;
    return startStop(scene.spaces, segs, [(min[0] + max[0]) / 2, (min[2] + max[2]) / 2]);
  }, [scene, segs]);

  const rigGroup = useRef<THREE.Group>(null);
  const rig = useRef<RigPose>({ position: [0, 0], yaw: 0 });
  const eyeOffset = useRef(0);
  const pendingStart = useRef(false);
  const saved = useRef<{ position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number; zoom: number; near: number; far: number } | null>(null);
  const session = useRef<XRSession | null>(null);

  // Per-frame state (refs: no React renders while walking).
  const hands = useRef<Record<"left" | "right", Hand>>({ left: { buttons: [] }, right: { buttons: [] } });
  const turnArmed = useRef(true);
  const aim = useRef<{ hand: "left" | "right"; target: P2 | null } | null>(null);
  const fade = useRef<Fade | null>(null);
  const exitHeld = useRef(0);
  const lastStop = useRef(-1);
  const roomId = useRef<string | null>(null);
  const roomSince = useRef(0);
  const elapsed = useRef(0);

  // Rare UI state (changes on room change / welcome dismissal only).
  const [caption, setCaption] = useState("");
  const [fresh, setFresh] = useState(false);
  const [welcome, setWelcome] = useState(true);

  const fadeMesh = useRef<THREE.Mesh>(null);
  const exitBar = useRef<THREE.Mesh>(null);
  const aimLine = useRef<THREE.Line>(null);
  const aimRing = useRef<THREE.Mesh>(null);
  const grips = useRef<Record<"left" | "right", THREE.Mesh | null>>({ left: null, right: null });

  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const publish = useCallback((head: P2 | null) => {
    const el = get().gl.domElement;
    if (!head) {
      delete el.dataset.vrHead;
      delete el.dataset.vrRoom;
      delete el.dataset.vrAim;
      return;
    }
    // Exposed for tests and debugging (like `data-camera`): head x, z and rig yaw; room; aim state.
    el.dataset.vrHead = `${head[0].toFixed(3)},${head[1].toFixed(3)},${rig.current.yaw.toFixed(4)}`;
    el.dataset.vrRoom = roomId.current ?? "";
    el.dataset.vrAim = aim.current ? (aim.current.target ? "valid" : "invalid") : "";
  }, [get]);

  useEffect(() => {
    const el = get().gl.domElement;
    if (active) el.dataset.vrWelcome = String(welcome);
    else delete el.dataset.vrWelcome;
  }, [active, welcome, get]);

  // ---- session lifecycle -------------------------------------------------------------------
  useEffect(() => {
    const { gl } = get();
    const onStart = () => {
      const cam = get().camera as THREE.PerspectiveCamera;
      saved.current = { position: cam.position.clone(), quaternion: cam.quaternion.clone(), fov: cam.fov, zoom: cam.zoom, near: cam.near, far: cam.far };
      // Close walls must not be clipped by the desktop near plane.
      cam.near = 0.05;
      cam.far = Math.max(cam.far, 200);
      cam.updateProjectionMatrix();
      rigGroup.current?.add(cam);
      // The model is static: draw the shadow map once, not twice per frame per eye.
      gl.shadowMap.autoUpdate = false;
      gl.shadowMap.needsUpdate = true;
      pendingStart.current = true;
      roomId.current = null;
      lastStop.current = -1;
      elapsed.current = 0;
      exitHeld.current = 0;
      aim.current = null;
      fade.current = null;
      hands.current = { left: { buttons: [] }, right: { buttons: [] } };
      setWelcome(true);
      setCaption("");
      activeRef.current = true;
      setActive(true);
      gl.domElement.dataset.vr = "active";
      onEventRef.current({ type: "started" });
    };
    const onEnd = () => {
      const cam = get().camera as THREE.PerspectiveCamera;
      cam.removeFromParent();
      const s = saved.current;
      if (s) {
        cam.position.copy(s.position);
        cam.quaternion.copy(s.quaternion);
        cam.fov = s.fov;
        cam.zoom = s.zoom;
        cam.near = s.near;
        cam.far = s.far;
      }
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      gl.shadowMap.autoUpdate = true;
      session.current = null;
      activeRef.current = false;
      setActive(false);
      delete gl.domElement.dataset.vr;
      publish(null);
      onEventRef.current({ type: "ended" });
      get().invalidate();
    };
    gl.xr.addEventListener("sessionstart", onStart);
    gl.xr.addEventListener("sessionend", onEnd);
    return () => {
      gl.xr.removeEventListener("sessionstart", onStart);
      gl.xr.removeEventListener("sessionend", onEnd);
      // Leaving the page (or the plan changing) ends the visit cleanly.
      void session.current?.end().catch(() => {});
    };
  }, [get, publish]);

  const enter = useCallback(() => {
    const xr = typeof navigator !== "undefined" ? navigator.xr : undefined;
    if (!xr) {
      onEventRef.current({ type: "failed", message: "This browser does not support WebXR." });
      return;
    }
    if (session.current) return;
    // Called synchronously from the click, so the browser sees the user's gesture.
    xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "bounded-floor"] }).then(
      async (s) => {
        session.current = s;
        try {
          let floor = true;
          try {
            await s.requestReferenceSpace("local-floor");
          } catch {
            floor = false;
          }
          eyeOffset.current = floor ? 0 : EYE_HEIGHT;
          const { gl } = get();
          gl.xr.setReferenceSpaceType(floor ? "local-floor" : "local");
          gl.xr.enabled = true;
          await gl.xr.setSession(s);
        } catch (e) {
          session.current = null;
          void s.end().catch(() => {});
          onEventRef.current({ type: "failed", message: describeVRError(e) });
        }
      },
      (e) => onEventRef.current({ type: "failed", message: describeVRError(e) }),
    );
  }, [get]);

  const exit = useCallback(() => {
    void session.current?.end().catch(() => {});
  }, []);

  useImperativeHandle(apiRef, () => ({ enter, exit }), [enter, exit]);

  // ---- per-frame locomotion -------------------------------------------------------------------
  useFrame((state, rawDt, frame?: XRFrame) => {
    if (!activeRef.current || !frame) return;
    const ref = state.gl.xr.getReferenceSpace();
    const pose = ref && frame.getViewerPose(ref);
    if (!ref || !pose) return;
    // Movement uses a capped step (a hitch never becomes a jump); timers (hold-to-exit, fades,
    // welcome timeout) use real time so they behave the same at any frame rate.
    const dt = Math.min(rawDt, 0.1);
    const realDt = Math.min(rawDt, 1);
    elapsed.current += realDt;

    const hp = pose.transform.position;
    const headLocal: P2 = [hp.x, hp.z];
    const headLocalYaw = yawOfOrientation(pose.transform.orientation);
    const headWorld = (): P2 => {
      const r = rotateY(headLocal, rig.current.yaw);
      return [rig.current.position[0] + r[0], rig.current.position[1] + r[1]];
    };
    const headYaw = () => rig.current.yaw + headLocalYaw;

    if (pendingStart.current) {
      rig.current = placeRig(headLocal, headLocalYaw, start.position, start.yaw);
      pendingStart.current = false;
    }

    const startFade = (action: () => void) => {
      if (!fade.current) fade.current = { t: 0, action };
    };
    const jumpTo = (i: number) => {
      if (i < 0) return;
      lastStop.current = i;
      const stop = stops[i];
      startFade(() => {
        rig.current = placeRig(headLocal, headLocalYaw, stop.position, stop.yaw);
      });
    };

    // ---- controllers ----
    let anyPress = false;
    let gripsHeld = 0;
    const seen = new Set<"left" | "right">();
    for (const src of frame.session.inputSources) {
      const gp = src.gamepad;
      const hand: "left" | "right" = src.handedness === "right" ? "right" : "left";
      seen.add(hand);

      const grip = grips.current[hand];
      const gripPose = src.gripSpace ? frame.getPose(src.gripSpace, ref) : null;
      if (grip) {
        grip.visible = !!gripPose;
        if (gripPose) {
          const p = gripPose.transform.position;
          const o = gripPose.transform.orientation;
          grip.position.set(p.x, p.y, p.z);
          grip.quaternion.set(o.x, o.y, o.z, o.w);
        }
      }
      if (!gp) continue;

      const prev = hands.current[hand].buttons;
      const now = gp.buttons.map((b) => b.pressed);
      const down = (i: number) => !!now[i] && !prev[i];
      const up = (i: number) => !now[i] && !!prev[i];
      hands.current[hand].buttons = now;
      if (now.some((b, i) => b && !prev[i])) anyPress = true;
      if (now[1]) gripsHeld++;

      const stick: [number, number] = gp.axes.length >= 4 ? [gp.axes[2], gp.axes[3]] : [gp.axes[0] ?? 0, gp.axes[1] ?? 0];
      if (Math.hypot(stick[0], stick[1]) > 0.5) anyPress = true;

      if (hand === "left") {
        // Walk where you look, sliding along walls; doorways are open.
        const delta = stickToMove(stick, forwardOf(headYaw()), dt);
        if ((delta[0] !== 0 || delta[1] !== 0) && !fade.current) {
          const from = headWorld();
          const to = resolveMove(from, delta, segs);
          rig.current = { ...rig.current, position: [rig.current.position[0] + to[0] - from[0], rig.current.position[1] + to[1] - from[1]] };
        }
      } else {
        // Snap turn around the head (not the play-space centre), 30° per flick.
        const s = snapTurn(stick[0], turnArmed.current);
        turnArmed.current = s.armed;
        if (s.turn !== 0) rig.current = placeRig(headLocal, headLocalYaw, headWorld(), headYaw() - s.turn * SNAP_ANGLE);
      }

      // Teleport: hold the trigger to aim at the floor, release to go.
      if (now[0] && src.targetRaySpace && (!aim.current || aim.current.hand === hand)) {
        const rayPose = frame.getPose(src.targetRaySpace, ref);
        let target: P2 | null = null;
        if (rayPose) {
          const p = rayPose.transform.position;
          const q = rayPose.transform.orientation;
          tmpV.set(0, 0, -1).applyQuaternion(tmpQ.set(q.x, q.y, q.z, q.w));
          const o = rotateY([p.x, p.z], rig.current.yaw);
          const d = rotateY([tmpV.x, tmpV.z], rig.current.yaw);
          const hit = rayToFloor(
            [rig.current.position[0] + o[0], p.y + eyeOffset.current, rig.current.position[1] + o[1]],
            [d[0], tmpV.y, d[1]],
          );
          if (hit && teleportAllowed(headWorld(), hit, scene.spaces, segs)) target = hit;
          const line = aimLine.current;
          if (line) {
            // Drawn in play-space coordinates (child of the rig).
            const end: P2 = target ? rotateY([target[0] - rig.current.position[0], target[1] - rig.current.position[1]], -rig.current.yaw) : [p.x + tmpV.x * 2, p.z + tmpV.z * 2];
            const endY = target ? -eyeOffset.current : p.y + tmpV.y * 2;
            const attr = line.geometry.getAttribute("position") as THREE.BufferAttribute;
            attr.setXYZ(0, p.x, p.y, p.z);
            attr.setXYZ(1, end[0], endY, end[1]);
            attr.needsUpdate = true;
            line.geometry.computeBoundingSphere();
            (line.material as THREE.LineBasicMaterial).color.set(target ? "#2dd4bf" : "#f87171");
          }
        }
        aim.current = { hand, target };
      } else if (up(0) && aim.current?.hand === hand) {
        const target = aim.current.target;
        aim.current = null;
        if (target) {
          startFade(() => {
            const from = headWorld();
            rig.current = { ...rig.current, position: [rig.current.position[0] + target[0] - from[0], rig.current.position[1] + target[1] - from[1]] };
          });
        }
      }

      // Room to room: A/X next, B/Y previous.
      if (down(4) || down(5)) {
        const here = roomAt(headWorld(), scene.spaces);
        jumpTo(nextStopIndex(stops, here?.id ?? null, down(4) ? 1 : -1, lastStop.current));
      }
    }
    for (const hand of ["left", "right"] as const) {
      if (!seen.has(hand) && grips.current[hand]) grips.current[hand]!.visible = false;
    }
    if (aim.current && !seen.has(aim.current.hand)) aim.current = null;

    // Leave VR: both grips held for a second.
    exitHeld.current = gripsHeld >= 2 ? exitHeld.current + realDt : 0;
    if (exitBar.current) {
      exitBar.current.visible = exitHeld.current > 0;
      exitBar.current.scale.x = Math.max(0.001, Math.min(1, exitHeld.current / EXIT_HOLD_S));
    }
    if (exitHeld.current >= EXIT_HOLD_S) {
      exitHeld.current = 0;
      void frame.session.end().catch(() => {});
    }

    if (welcome && (anyPress || elapsed.current > WELCOME_MAX_S)) setWelcome(false);

    // ---- comfort fade for jumps ----
    const f = fade.current;
    if (f) {
      f.t += realDt;
      if (f.action && f.t >= FADE_S) {
        f.action();
        f.action = null;
      }
      const k = f.t < FADE_S ? f.t / FADE_S : Math.max(0, 1 - (f.t - FADE_S) / FADE_S);
      if (fadeMesh.current) {
        fadeMesh.current.visible = k > 0;
        (fadeMesh.current.material as THREE.MeshBasicMaterial).opacity = k;
      }
      if (f.t >= FADE_S * 2) fade.current = null;
    } else if (fadeMesh.current) {
      fadeMesh.current.visible = false;
    }

    // ---- aim visuals ----
    const showAim = !!aim.current;
    if (aimLine.current) aimLine.current.visible = showAim;
    if (aimRing.current) {
      const t = aim.current?.target;
      aimRing.current.visible = !!t;
      if (t) aimRing.current.position.set(t[0], 0.012, t[1]);
    }

    // ---- apply the rig and report where the visitor is ----
    const g = rigGroup.current;
    if (g) {
      g.position.set(rig.current.position[0], eyeOffset.current, rig.current.position[1]);
      g.rotation.set(0, rig.current.yaw, 0);
    }
    const head = headWorld();
    const room = roomAt(head, scene.spaces);
    const id = room?.id ?? null;
    if (id !== roomId.current) {
      roomId.current = id;
      roomSince.current = elapsed.current;
      setCaption(room ? roomCaption(room, scene.scale.calibrated) : "Outside the rooms · press A for the next room");
      setFresh(true);
    } else if (fresh && elapsed.current - roomSince.current > FRESH_ROOM_S) {
      setFresh(false);
    }
    publish(head);
  });

  const aimObject = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: "#2dd4bf" }));
    line.name = "vr-aim";
    line.visible = false;
    line.frustumCulled = false;
    return line;
  }, []);
  useEffect(() => () => {
    aimObject.geometry.dispose();
    (aimObject.material as THREE.Material).dispose();
  }, [aimObject]);
  const welcomeLines = useMemo(() => WELCOME_LINES(title || "Welcome to the property"), [title]);

  return (
    <>
      {/* The play space: everything tracked by the headset moves with it. Always mounted so the
          camera can be attached the moment a session starts; empty and invisible otherwise. */}
      <group ref={rigGroup} name="vr-rig">
        {(["left", "right"] as const).map((hand) => (
          <mesh key={hand} ref={(m) => { grips.current[hand] = m; }} name={`vr-controller:${hand}`} visible={false}>
            <boxGeometry args={[0.045, 0.035, 0.12]} />
            <meshStandardMaterial color="#1f2937" roughness={0.5} />
          </mesh>
        ))}
        <primitive object={aimObject} ref={aimLine} />
      </group>

      {active && (
        <>
          {showLabels && <VRRoomLabels spaces={scene.spaces} calibrated={scene.scale.calibrated} />}

          {/* Ground around the house, so windows look out onto something rather than the void. */}
          <mesh
            name="vr-ground"
            rotation={[-Math.PI / 2, 0, 0]}
            position={[(scene.bounds.min[0] + scene.bounds.max[0]) / 2, -0.11, (scene.bounds.min[2] + scene.bounds.max[2]) / 2]}
            receiveShadow
          >
            <circleGeometry args={[60, 48]} />
            <meshStandardMaterial color="#8f9a86" roughness={1} />
          </mesh>

          <mesh ref={aimRing} name="vr-teleport-target" rotation={[-Math.PI / 2, 0, 0]} visible={false}>
            <ringGeometry args={[0.16, 0.22, 40]} />
            <meshBasicMaterial color="#2dd4bf" transparent opacity={0.9} depthWrite={false} />
          </mesh>

          {createPortal(
            <VRHud caption={caption} fresh={fresh} welcome={welcome ? welcomeLines : null} fadeRef={fadeMesh} exitBarRef={exitBar} />,
            camera,
          )}
        </>
      )}
    </>
  );
}