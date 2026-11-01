"use client";

import { Grid, RoundedBox } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type Ref } from "react";
import { PMREMGenerator, type DirectionalLight } from "three";
import { createBackdropTexture } from "./proceduralTextures";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { Scene3D, SceneBounds, V3 } from "@/lib/geometry3d";
import type { EnvironmentSetting, Rect } from "@/lib/viewer/environment";
import type { Layers } from "@/lib/viewer/layers";
import { HAZE } from "@/lib/viewer/firstPerson";
import CameraRig, { type CameraApi } from "./CameraRig";
import FirstPersonSky from "./FirstPersonSky";
import OutdoorEnvironment from "./environment/OutdoorEnvironment";
import { computeFraming, FOV_DEG, viewPose } from "./framing";
import PropertyScene from "./PropertyScene";
import RoomLabels from "./RoomLabels";
import VRSession, { type VRApi, type VREvent } from "./vr/VRSession";
import WalkSession, { type WalkApi, type WalkEvent } from "./walk/WalkSession";

/** Daylight sky inside the headset: a walk-through should feel like a visit, not a night scene. */
const VR_SKY = "#c7d6e6";
/**
 * First person under ceilings: a soft interior fill, split between an even warm ambient and a
 * sky/floor hemisphere (upward faces a little cooler from the windows' sky, downward faces such as
 * the ceiling warmer, as if lit by light bounced off the floor), so rooms keep some depth.
 */
const FIRST_PERSON_FILL = { ambient: 0.3, hemisphere: 0.4 };

/** The canvas renders on demand: draw one frame whenever what is visible changes. */
function Redraw({ layers, selectedRoomId, environment, ceilings }: { layers: Layers; selectedRoomId: string | null; environment: EnvironmentSetting; ceilings: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => invalidate(), [invalidate, layers, selectedRoomId, environment, ceilings]);
  return null;
}

/** Desktop showroom base: a low plinth under the model, plus the ground plane it sits on. */
const BASE_HEIGHT = 0.14;
/** Base top sits a few mm under the lowest geometry (the floor slabs' underside): no z-fighting. */
const BASE_GAP = 0.004;
function baseGeometry(bounds: SceneBounds) {
  const w = bounds.max[0] - bounds.min[0];
  const d = bounds.max[2] - bounds.min[2];
  const margin = Math.max(0.35, 0.05 * Math.max(w, d));
  const top = bounds.min[1] - BASE_GAP;
  return {
    center: [(bounds.min[0] + bounds.max[0]) / 2, top - BASE_HEIGHT / 2, (bounds.min[2] + bounds.max[2]) / 2] as V3,
    size: [w + 2 * margin, BASE_HEIGHT, d + 2 * margin] as V3,
    groundY: top - BASE_HEIGHT,
  };
}

/**
 * Desktop-only light studio: soft gradient backdrop, image-based fill light generated locally
 * from three.js's built-in RoomEnvironment (no files, no network), a plinth and a shadow-catching
 * ground. Unmounted in VR, which keeps its own sky, lights and ground. With outdoor surroundings
 * the lawn catches the house shadow instead of the plain shadow plane.
 */
function Studio({ bounds, outdoor }: { bounds: SceneBounds; outdoor: boolean }) {
  const backdrop = useMemo(() => createBackdropTexture(), []);
  useEffect(() => () => backdrop?.dispose(), [backdrop]);
  const base = useMemo(() => baseGeometry(bounds), [bounds]);
  const groundSize = Math.max(base.size[0], base.size[2]) * 8;

  return (
    <>
      {backdrop && <primitive attach="background" object={backdrop} />}
      <RoundedBox name="studio-base" args={base.size} radius={0.06} smoothness={3} position={base.center} receiveShadow castShadow>
        <meshStandardMaterial color="#d9d4cc" roughness={0.85} metalness={0} />
      </RoundedBox>
      {!outdoor && (
        <mesh name="studio-ground" rotation={[-Math.PI / 2, 0, 0]} position={[base.center[0], base.groundY, base.center[2]]} receiveShadow>
          <planeGeometry args={[groundSize, groundSize]} />
          {/* No depth write: the 1 m grid lies 2 mm above and must never lose the depth test to it. */}
          <shadowMaterial transparent opacity={0.16} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}

/**
 * Light shared by every mode, so orbit, walk-through and VR read as the same building: image-based
 * fill generated locally from three.js's RoomEnvironment (no files, no network) and a soft sky/ground
 * hemisphere. In first person (walk-through and VR, under ceilings) a warm interior fill is added.
 * Always mounted; only intensities change, so switching modes never recompiles shaders.
 */
function SceneLighting({ firstPerson }: { firstPerson: boolean }) {
  const gl = useThree((s) => s.gl);
  const get = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);
  const environment = useMemo(() => {
    const pmrem = new PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const texture = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    return texture;
  }, [gl]);
  useEffect(() => () => environment.dispose(), [environment]);
  useEffect(() => {
    const { scene } = get();
    scene.environmentIntensity = 0.35;
    invalidate();
    return () => {
      scene.environmentIntensity = 1;
    };
  }, [get, invalidate]);
  return (
    <>
      <primitive attach="environment" object={environment} />
      <hemisphereLight args={["#ffffff", "#cfc7ba", 0.45]} />
      <ambientLight intensity={firstPerson ? FIRST_PERSON_FILL.ambient : 0} color="#fff6ea" />
      <hemisphereLight args={["#e3ecf6", "#d9cdb9", firstPerson ? FIRST_PERSON_FILL.hemisphere : 0]} />
    </>
  );
}

/**
 * VR draws its shadow map once per session. The desktop studio (and its base) unmounts only
 * after the session has started, so ask for that one redraw again once it is gone.
 */
function VRShadowRefresh({ vr }: { vr: boolean }) {
  const get = useThree((s) => s.get);
  useEffect(() => {
    if (vr) get().gl.shadowMap.needsUpdate = true;
  }, [vr, get]);
  return null;
}

/** Key light with a shadow frustum sized to the model, aimed at its centre. */
/**
 * Shadow depth bias. The orbit view keeps its tuned value. Under ceilings (first person) that value,
 * about 2 cm in this shadow camera's depth range, lets light leak onto the top of sunlit walls where
 * they meet the ceiling, so a much smaller one is used there (normalBias still prevents acne).
 */
const SHADOW_BIAS = { orbit: -0.0004, firstPerson: -0.00005 };

function Sun({ center, radius, intensity = 2.2, color = "#ffffff", bias = SHADOW_BIAS.orbit }: { center: V3; radius: number; intensity?: number; color?: string; bias?: number }) {
  const ref = useRef<DirectionalLight>(null);
  useEffect(() => {
    const light = ref.current;
    if (!light) return;
    light.target.position.set(...center);
    light.target.updateMatrixWorld();
  }, [center]);
  const r = radius * 1.4;
  return (
    <directionalLight
      ref={ref}
      position={[center[0] + radius * 1.2, center[1] + radius * 2.2, center[2] + radius * 0.8]}
      intensity={intensity}
      color={color}
      castShadow
      shadow-mapSize={[2048, 2048]}
      shadow-camera-left={-r}
      shadow-camera-right={r}
      shadow-camera-top={r}
      shadow-camera-bottom={-r}
      shadow-camera-near={0.1}
      shadow-camera-far={radius * 8}
      shadow-bias={bias}
      shadow-normalBias={0.03}
    />
  );
}

interface Props {
  scene: Scene3D;
  /** sceneFingerprint(scene); exposed on the element so tests can prove "same plan, same model". */
  fingerprint: string;
  layers: Layers;
  selectedRoomId: string | null;
  cameraRef: Ref<CameraApi>;
  /** Optional VR (WebXR) presentation of this same scene. */
  vrRef?: Ref<VRApi>;
  onVREvent?: (e: VREvent) => void;
  /** Optional desktop first-person walk-through of this same scene. */
  walkRef?: Ref<WalkApi>;
  onWalkEvent?: (e: WalkEvent) => void;
  /** Ceilings in the walk-through (VR always shows them; the orbit view never does: it is a cutaway). */
  ceilings?: boolean;
  /** Shown on the VR welcome panel. */
  title?: string;
  /** Play the short opening camera move once when the model first appears. */
  reveal?: boolean;
  /** Illustrative outdoor surroundings (desktop view only; VR keeps its own ground). */
  environment?: EnvironmentSetting;
}

/**
 * The WebGL canvas. Renders on demand only (nothing is drawn while the view is still), so an
 * idle viewer costs no GPU time. Memoised: UI state outside the canvas never re-renders it.
 */
function Viewer3D({ scene, fingerprint, layers, selectedRoomId, cameraRef, vrRef, onVREvent, walkRef, onWalkEvent, ceilings = true, title, reveal = false, environment = "off" }: Props) {
  const [ready, setReady] = useState(false);
  const [vr, setVr] = useState(false);
  const handleVREvent = useCallback((e: VREvent) => {
    if (e.type === "started") setVr(true);
    if (e.type === "ended") setVr(false);
    onVREvent?.(e);
  }, [onVREvent]);
  const [walking, setWalking] = useState(false);
  const handleWalkEvent = useCallback((e: WalkEvent) => {
    if (e.type === "started") setWalking(true);
    if (e.type === "ended" || e.type === "failed") setWalking(false);
    onWalkEvent?.(e);
  }, [onWalkEvent]);
  const [contextLost, setContextLost] = useState(false);
  const framing = useMemo(() => computeFraming(scene.bounds), [scene.bounds]);
  // Only the first frame uses this; CameraRig owns the camera afterwards.
  const [initialCamera] = useState(() => ({ position: viewPose(scene.bounds, "overview", 16 / 9).position, fov: FOV_DEG }));
  const base = useMemo(() => baseGeometry(scene.bounds), [scene.bounds]);
  const footprint = useMemo((): Rect => ({
    x0: base.center[0] - base.size[0] / 2, z0: base.center[2] - base.size[2] / 2,
    x1: base.center[0] + base.size[0] / 2, z1: base.center[2] + base.size[2] / 2,
  }), [base]);
  const outdoor = environment !== "off";
  const showCeilings = vr || (walking && ceilings);

  return (
    <div
      data-testid="viewer3d"
      data-ready={ready}
      data-fingerprint={fingerprint}
      data-environment={environment}
      data-vr={vr ? "active" : undefined}
      data-walk={walking ? "active" : undefined}
      data-ceilings={showCeilings ? "on" : "off"}
      className="relative h-full w-full"
    >
      <Canvas
        shadows="percentage"
        frameloop="demand"
        dpr={[1, 2]}
        camera={initialCamera}
        gl={{ antialias: true }}
        aria-label="Interactive 3D model of the property"
        onCreated={({ gl }) => {
          const canvas = gl.domElement;
          canvas.addEventListener("webglcontextlost", (e) => {
            e.preventDefault(); // allows the browser to restore it
            setContextLost(true);
          });
          canvas.addEventListener("webglcontextrestored", () => setContextLost(false));
          setReady(true);
        }}
      >
        {vr ? <color attach="background" args={[VR_SKY]} /> : <Studio bounds={scene.bounds} outdoor={outdoor} />}
        <SceneLighting firstPerson={walking || vr} />
        {/* Hidden (not unmounted) in VR, which keeps its own ground: nothing to rebuild on the way back. */}
        {outdoor && <OutdoorEnvironment scene={scene} style={environment} footprint={footprint} groundY={base.groundY} visible={!vr} haze={walking ? HAZE : null} />}
        {/* First person only: a daylight sky in place of the studio backdrop (also in VR). */}
        <FirstPersonSky center={framing.center} radius={framing.far * 0.8} visible={walking || vr} />
        {/* One light for both looks (VR draws its static shadow map from it once per session). */}
        <Sun center={framing.center} radius={framing.radius} intensity={vr ? 2.2 : 2.1} color={vr ? "#ffffff" : "#fff5e8"} bias={walking || vr ? SHADOW_BIAS.firstPerson : SHADOW_BIAS.orbit} />
        <VRShadowRefresh vr={vr} />

        <PropertyScene scene={scene} layers={layers} selectedRoomId={selectedRoomId} vr={vr} openDoors={walking} showCeilings={showCeilings} />
        {/* Screen-space HTML labels do not exist in a headset; VRSession draws in-scene ones instead.
            At eye level they would float through walls, so the walk-through shows the current room instead. */}
        {layers.labels && !vr && !walking && (
          <RoomLabels spaces={scene.spaces} selectedRoomId={selectedRoomId} calibrated={scene.scale.calibrated} />
        )}

        {/* 1 m cells, 5 m sections: the real-world scale is visible on the ground. */}
        {/* On the studio ground, under the base (just above the shadow plane). Not over the surroundings. */}
        <Grid
          visible={layers.grid && !vr && !outdoor}
          position={[framing.center[0], base.groundY + 0.002, framing.center[2]]}
          args={[10, 10]}
          cellSize={1}
          cellThickness={0.6}
          cellColor="#a9b2bd"
          sectionSize={5}
          sectionThickness={1}
          sectionColor="#7f8b99"
          fadeDistance={framing.radius * 6}
          fadeStrength={1.5}
          infiniteGrid
        />

        <CameraRig bounds={scene.bounds} apiRef={cameraRef} enabled={!vr && !walking} reveal={reveal} />
        {vrRef && <VRSession scene={scene} apiRef={vrRef} showLabels={layers.labels} title={title} onEvent={handleVREvent} />}
        {/* After CameraRig: its frame callback runs first, so the walker always has the last word on the camera. */}
        {walkRef && <WalkSession scene={scene} apiRef={walkRef} onEvent={handleWalkEvent} />}
        <Redraw layers={layers} selectedRoomId={selectedRoomId} environment={environment} ceilings={showCeilings} />
      </Canvas>

      {contextLost && (
        <div role="alert" className="absolute inset-0 z-40 flex items-center justify-center bg-background/85 p-6 text-center text-sm">
          The graphics device was reset. The 3D view will resume automatically; if it does not, reload the page.
        </div>
      )}
    </div>
  );
}

export default memo(Viewer3D);
