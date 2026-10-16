"use client";

import { useEffect, useMemo, type Ref } from "react";
import type * as THREE from "three";
import { drawTextPanel, type TextLine } from "./textTexture";

/** Always drawn on top: the HUD must stay readable when the visitor stands close to a wall. */
const ON_TOP = { depthTest: false, depthWrite: false, transparent: true } as const;

function Panel({ lines, height, position, opacity = 1, options, name }: {
  lines: readonly TextLine[]; height: number; position: [number, number, number]; opacity?: number;
  options?: Parameters<typeof drawTextPanel>[1]; name: string;
}) {
  const panel = useMemo(() => drawTextPanel(lines, options), [lines, options]);
  useEffect(() => () => panel.texture.dispose(), [panel]);
  return (
    <mesh name={name} position={position} renderOrder={1000}>
      <planeGeometry args={[height * panel.aspect, height]} />
      <meshBasicMaterial map={panel.texture} opacity={opacity} {...ON_TOP} />
    </mesh>
  );
}

export const WELCOME_LINES = (title: string): TextLine[] => [
  { text: title, size: 46, weight: 700 },
  { text: "You are standing inside the property.", size: 28, color: "#aab4c6", gap: 6 },
  { text: "Walk  ·  left thumbstick", size: 30, gap: 26 },
  { text: "Turn  ·  right thumbstick (left / right)", size: 30, gap: 8 },
  { text: "Teleport  ·  point at the floor, hold and release the trigger", size: 30, gap: 8 },
  { text: "Next / previous room  ·  A / B  (X / Y)", size: 30, gap: 8 },
  { text: "Leave VR  ·  hold both grip buttons, or remove the headset", size: 30, gap: 8 },
  { text: "Press any button to start", size: 28, color: "#2dd4bf", weight: 600, gap: 26 },
];

interface Props {
  /** Current room ("Kitchen · 12.4 m²"), or a hint when outside every room. */
  caption: string;
  /** True for a few seconds after entering a new room: the caption is emphasised. */
  fresh: boolean;
  welcome: TextLine[] | null;
  /** Black screen used for comfortable room jumps / teleports; opacity driven per frame. */
  fadeRef: Ref<THREE.Mesh>;
  /** Shown while both grips are held; scale.x driven per frame (0..1). */
  exitBarRef: Ref<THREE.Mesh>;
}

/** Head-locked overlay. Mounted as a child of the camera, so it follows the visitor's view. */
export default function VRHud({ caption, fresh, welcome, fadeRef, exitBarRef }: Props) {
  const captionLines = useMemo<TextLine[]>(() => [{ text: caption, size: 40, weight: 600 }], [caption]);
  const captionStyle = useMemo(
    () => ({ padding: 20, border: fresh ? "rgba(45,212,191,0.9)" : "rgba(255,255,255,0.14)" }),
    [fresh],
  );
  const welcomeStyle = useMemo(() => ({ padding: 40, minWidth: 900 }), []);

  return (
    <group name="vr-hud">
      {/* Low in the field of view, small: readable at a glance without blocking the room. */}
      <Panel name="vr-hud-room" lines={captionLines} height={0.075} position={[0, -0.36, -1.2]} opacity={fresh ? 1 : 0.7} options={captionStyle} />
      {welcome && <Panel name="vr-hud-welcome" lines={welcome} height={0.62} position={[0, 0.02, -1.5]} options={welcomeStyle} />}
      <mesh ref={exitBarRef} name="vr-hud-exit" position={[0, -0.27, -1.2]} scale={[0, 1, 1]} renderOrder={1001}>
        <planeGeometry args={[0.4, 0.012]} />
        <meshBasicMaterial color="#f59e0b" {...ON_TOP} />
      </mesh>
      <mesh ref={fadeRef} name="vr-fade" position={[0, 0, -0.12]} renderOrder={1002} visible={false}>
        <planeGeometry args={[2, 2]} />
        <meshBasicMaterial color="#000000" opacity={0} {...ON_TOP} />
      </mesh>
    </group>
  );
}
