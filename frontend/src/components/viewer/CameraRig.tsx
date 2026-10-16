"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, type Ref } from "react";
import type { PerspectiveCamera } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { SceneBounds, SceneSpace, V3 } from "@/lib/geometry3d";
import { computeFraming, dollyPose, roomPose, viewPose, type CameraPose, type ViewName } from "./framing";
import { REVEAL_MS, revealEase, revealPose } from "./reveal";

/** What the UI can ask the camera to do. Called imperatively: no React state, no re-renders. */
export interface CameraApi {
  /** Back to the default overview of the whole property. */
  reset: () => void;
  view: (name: ViewName) => void;
  focusRoom: (space: SceneSpace) => void;
  /** factor < 1 zooms in, > 1 zooms out. */
  zoom: (factor: number) => void;
  /** If the opening reveal is still playing, jump to its end pose now (before VR or a presentation). */
  finishReveal: () => void;
}

const DURATION_MS = 550;
const ease = (t: number) => 1 - Math.pow(1 - t, 3);
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

interface Animation {
  from: CameraPose;
  to: CameraPose;
  start: number;
}

/** A slow first frame (shader compile) must not skip most of the reveal: cap each step, seconds. */
const REVEAL_MAX_STEP = 0.1;
/** ...but on a very slow renderer it must not drag on either: always over within this, ms. */
const REVEAL_DEADLINE_MS = REVEAL_MS * 1.5;
/** Opening reveal state, published as data-reveal on the canvas (for tests). */
type RevealState = "running" | "done" | "cancelled" | "skipped" | "off";

interface Props {
  bounds: SceneBounds;
  apiRef: Ref<CameraApi>;
  /** False while a VR headset drives the camera: no orbiting, no scripted moves. */
  enabled?: boolean;
  /** Play the short opening camera move when the model first appears (skipped for reduced motion). */
  reveal?: boolean;
}

/**
 * Orbit/zoom/pan controls plus scripted camera moves (reset, top view, focus a room, zoom
 * buttons). Moves are short eased transitions that render on demand only while they run.
 */
export default function CameraRig({ bounds, apiRef, enabled = true, reveal = false }: Props) {
  const controls = useRef<OrbitControlsImpl>(null);
  const anim = useRef<Animation | null>(null);
  // The opening reveal: plays at most once per viewer, never again (not after VR, not on reframing).
  const intro = useRef<{ elapsed: number; startedAt: number | null } | null>(null);
  const introDecided = useRef(false);
  const get = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);
  const framing = useMemo(() => computeFraming(bounds), [bounds]);

  const aspect = useCallback(() => {
    const { width, height } = get().size;
    return height > 0 ? width / height : 1;
  }, [get]);

  const currentPose = useCallback((): CameraPose => {
    const cam = get().camera;
    const t = controls.current?.target;
    return { position: [cam.position.x, cam.position.y, cam.position.z], target: t ? [t.x, t.y, t.z] : framing.center };
  }, [get, framing.center]);

  /** Exposed for tests and debugging: the live camera pose, rounded, on the canvas element. */
  const publish = useCallback(() => {
    const { position: p, target: t } = currentPose();
    get().gl.domElement.dataset.camera = [...p, ...t].map((v) => v.toFixed(3)).join(",");
  }, [currentPose, get]);

  const apply = useCallback(
    (pose: CameraPose) => {
      const cam = get().camera;
      cam.position.set(...pose.position);
      controls.current?.target.set(...pose.target);
      if (controls.current) controls.current.update();
      else cam.lookAt(...pose.target);
      publish();
      invalidate();
    },
    [get, invalidate, publish],
  );

  const overview = useCallback(() => viewPose(bounds, "overview", aspect()), [aspect, bounds]);
  const markReveal = useCallback((state: RevealState) => {
    get().gl.domElement.dataset.reveal = state;
  }, [get]);
  /** Stops the reveal if it is playing; true if it was. */
  const endReveal = useCallback((state: "done" | "cancelled") => {
    if (!intro.current) return false;
    intro.current = null;
    markReveal(state);
    return true;
  }, [markReveal]);

  const enabledRef = useRef(enabled);
  const moveTo = useCallback(
    (to: CameraPose) => {
      if (!enabledRef.current) return;
      // A button, key or room pick during the reveal takes over from wherever the camera is.
      endReveal("cancelled");
      if (prefersReducedMotion()) {
        anim.current = null;
        apply(to);
        return;
      }
      anim.current = { from: currentPose(), to, start: performance.now() };
      invalidate();
    },
    [apply, currentPose, endReveal, invalidate],
  );

  useImperativeHandle(
    apiRef,
    () => ({
      finishReveal: () => {
        if (endReveal("done")) apply(overview());
      },
      reset: () => moveTo(viewPose(bounds, "overview", aspect())),
      view: (name) => moveTo(viewPose(bounds, name, aspect())),
      focusRoom: (space) => moveTo(roomPose(space.polygon, space.ceilingHeight, aspect())),
      zoom: (factor) => {
        const base = anim.current?.to ?? currentPose();
        moveTo(dollyPose(base, factor, framing.minDistance, framing.maxDistance));
      },
    }),
    [apply, aspect, bounds, currentPose, endReveal, framing, moveTo, overview],
  );

  // Auto-frame whenever the model changes: clip planes sized to the model, overview pose.
  // The first time only (and unless reduced motion is requested), arrive with the short reveal.
  useLayoutEffect(() => {
    const cam = get().camera as PerspectiveCamera;
    cam.near = framing.near;
    cam.far = framing.far;
    cam.updateProjectionMatrix();
    anim.current = null;
    if (intro.current) {
      // Reframed while the reveal plays (or an effect re-run): keep going, towards the new overview.
      apply(revealPose(overview(), revealEase((intro.current.elapsed * 1000) / REVEAL_MS)));
      return;
    }
    if (!introDecided.current) {
      introDecided.current = true;
      if (reveal && !prefersReducedMotion()) {
        intro.current = { elapsed: 0, startedAt: null };
        markReveal("running");
        apply(revealPose(overview(), 0));
        return;
      }
      markReveal(reveal ? "skipped" : "off");
    }
    apply(overview());
  }, [apply, framing, get, markReveal, overview, reveal]);

  // Back from VR: the desktop pose was restored on the camera; re-sync the controls with it.
  useLayoutEffect(() => {
    if (enabled && !enabledRef.current) apply(currentPose());
    if (!enabled) {
      anim.current = null;
      endReveal("cancelled"); // never resumes afterwards
    }
    enabledRef.current = enabled;
  }, [apply, currentPose, enabled, endReveal]);

  useFrame((_, delta) => {
    const r = intro.current;
    if (r && enabled) {
      const now = performance.now();
      r.startedAt ??= now;
      r.elapsed += Math.min(delta, REVEAL_MAX_STEP);
      const t = now - r.startedAt >= REVEAL_DEADLINE_MS ? 1 : Math.min(1, (r.elapsed * 1000) / REVEAL_MS);
      apply(revealPose(overview(), revealEase(t)));
      if (t >= 1) endReveal("done");
      else invalidate();
      return;
    }
    const a = anim.current;
    if (!a || !enabled) return;
    const t = Math.min(1, (performance.now() - a.start) / DURATION_MS);
    const k = ease(t);
    apply({ position: lerp(a.from.position, a.to.position, k), target: lerp(a.from.target, a.to.target, k) });
    if (t >= 1) anim.current = null;
    else invalidate();
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={enabled}
      minDistance={framing.minDistance}
      maxDistance={framing.maxDistance}
      // Stay above the ground: a buyer never needs to look up from under the floor.
      maxPolarAngle={Math.PI / 2 - 0.02}
      enableDamping={false}
      zoomToCursor
      // The user takes over: stop any scripted move so the two never fight.
      onStart={() => {
        anim.current = null;
        endReveal("cancelled");
      }}
      onChange={publish}
    />
  );
}
