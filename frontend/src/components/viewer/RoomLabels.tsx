"use client";

import { Html } from "@react-three/drei";
import { memo, useEffect, useMemo } from "react";
import * as THREE from "three";
import type { SceneSpace } from "@/lib/geometry3d";
import { labelAnchor } from "@/lib/viewer/labelAnchor";

/** Keep labels under the viewer's own overlays (toolbar, help), which use z-index 30+. */
const Z_RANGE = [20, 10];
/** Floor marker at the foot of each stem: radius (m), a hair above the floor surface (no z-fighting). */
const DOT_RADIUS = 0.07;
const DOT_Y = 0.006;
const DOT_SEGMENTS = 20;

/**
 * Stems (floor -> ceiling) and floor dots for all rooms as two geometries: two draw calls in
 * total, however many rooms. Real 3D, so walls hide them correctly from low angles.
 */
function pinGeometry(anchors: [number, number, number][]) {
  const stem = new Float32Array(anchors.length * 6);
  anchors.forEach(([x, h, z], i) => stem.set([x, DOT_Y, z, x, h, z], i * 6));
  const stems = new THREE.BufferGeometry();
  stems.setAttribute("position", new THREE.BufferAttribute(stem, 3));

  const dot: number[] = [];
  for (const [x, , z] of anchors) {
    for (let k = 0; k < DOT_SEGMENTS; k++) {
      const a0 = (k / DOT_SEGMENTS) * Math.PI * 2;
      const a1 = ((k + 1) / DOT_SEGMENTS) * Math.PI * 2;
      // Counter-clockwise seen from above (+Y): centre, then a1, then a0 in X/Z.
      dot.push(x, DOT_Y, z, x + Math.cos(a1) * DOT_RADIUS, DOT_Y, z + Math.sin(a1) * DOT_RADIUS, x + Math.cos(a0) * DOT_RADIUS, DOT_Y, z + Math.sin(a0) * DOT_RADIUS);
    }
  }
  const dots = new THREE.BufferGeometry();
  dots.setAttribute("position", new THREE.BufferAttribute(new Float32Array(dot), 3));
  return { stems, dots };
}

interface Props {
  spaces: SceneSpace[];
  selectedRoomId: string | null;
  calibrated: boolean;
}

/**
 * Room names as pins: a screen-space HTML card (always crisp, fixed size, whatever the zoom) on a
 * thin stem that drops to a dot on the room's floor. Cards ignore the pointer so dragging over
 * them still orbits the camera.
 */
function RoomLabels({ spaces, selectedRoomId, calibrated }: Props) {
  // The card sits at ceiling height: in the roofless "dollhouse" view it floats over the room's
  // open top; the stem shows which floor it belongs to.
  const anchors = useMemo(
    () => spaces.map((s) => {
      const [x, z] = labelAnchor(s.polygon);
      return [x, s.ceilingHeight, z] as [number, number, number];
    }),
    [spaces],
  );
  const pins = useMemo(() => pinGeometry(anchors), [anchors]);
  const materials = useMemo(() => ({
    stem: new THREE.LineBasicMaterial({ color: "#334155", transparent: true, opacity: 0.55, depthWrite: false }),
    dot: new THREE.MeshBasicMaterial({ color: "#1e293b", transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
  }), []);
  useEffect(() => () => { pins.stems.dispose(); pins.dots.dispose(); }, [pins]);
  useEffect(() => () => { materials.stem.dispose(); materials.dot.dispose(); }, [materials]);

  return (
    <group name="room-labels">
      <lineSegments name="room-label-stems" geometry={pins.stems} material={materials.stem} />
      <mesh name="room-label-dots" geometry={pins.dots} material={materials.dot} />
      {spaces.map((s, i) => {
        const selected = s.id === selectedRoomId;
        return (
          // drei applies its `pointerEvents` prop only in transform mode, so disable events via classes.
          // Not centred: the card's bottom tip sits exactly on the top of the stem.
          <Html key={s.id} position={anchors[i]} zIndexRange={Z_RANGE} wrapperClass="pointer-events-none">
            <div className="pointer-events-none flex -translate-x-1/2 -translate-y-full select-none flex-col items-center">
              <div
                data-testid="room-label"
                data-room-id={s.id}
                data-selected={selected || undefined}
                // Phones: name over area (narrow, less overlap); wider screens: one slim line.
                className={`flex flex-col items-center whitespace-nowrap rounded-lg border px-2 py-0.5 text-center leading-tight shadow-md sm:flex-row sm:items-baseline sm:rounded-md sm:px-2.5 ${
                  selected
                    ? "border-accent bg-accent-soft text-accent shadow-[#2e4a3b]/20"
                    : "border-border bg-surface/95 text-foreground shadow-[#22261f]/10"
                }`}
              >
                <span className="text-[12px] font-semibold">{s.name}</span>
                <span className={`font-mono text-[10px] sm:ml-1.5 ${selected ? "text-accent" : "text-muted"}`}>
                  {calibrated ? "" : "≈ "}
                  {s.area.toFixed(1)} m²
                </span>
              </div>
              {/* The pin's tip, pointing down the stem. */}
              <div aria-hidden className={`h-1.5 w-px ${selected ? "bg-accent" : "bg-muted/70"}`} />
            </div>
          </Html>
        );
      })}
    </group>
  );
}

export default memo(RoomLabels);
