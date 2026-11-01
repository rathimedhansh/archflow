"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { SKY, skyStop } from "@/lib/viewer/firstPerson";

/**
 * Daylight sky for the walk-through and VR: a large inverted dome around the property with a
 * vertex-colour gradient (no textures, no files). World-locked, so it stays put when the visitor
 * looks around (a screen-space background would not, in a headset). Drawn first, never writes depth,
 * unaffected by lights, fog and tone mapping, so its colours are exactly the ones in `SKY`.
 * Always mounted; the orbit view hides it and keeps its studio backdrop.
 */
export default function FirstPersonSky({ center, radius, visible }: { center: [number, number, number]; radius: number; visible: boolean }) {
  const mesh = useMemo(() => {
    const geometry = new THREE.SphereGeometry(1, 48, 24);
    const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const a = new THREE.Color();
    const b = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const { from, to, t } = skyStop(pos.getY(i));
      a.set(SKY[from]).lerp(b.set(SKY[to]), t);
      colors.set([a.r, a.g, a.b], i * 3);
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false });
    const m = new THREE.Mesh(geometry, material);
    m.name = "first-person-sky";
    m.renderOrder = -1000;
    m.frustumCulled = false;
    return m;
  }, []);
  useEffect(() => () => {
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }, [mesh]);
  return <primitive object={mesh} position={center} scale={radius} visible={visible} />;
}
