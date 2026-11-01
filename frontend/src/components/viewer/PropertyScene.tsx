"use client";

import { memo, useEffect, useMemo } from "react";
import type * as THREE from "three";
import type { ObjectKind, Scene3D, SceneObject } from "@/lib/geometry3d";
import { planCeilings } from "@/lib/viewer/ceilings";
import { floorFinishFor, type FloorFinish } from "@/lib/viewer/floorFinish";
import type { Layers } from "@/lib/viewer/layers";
import { createMaterials } from "./materials";
import { toBufferGeometry, toDisplayGeometry } from "./toBufferGeometry";

/** One engine object. Memoised: toggling layers or selecting a room never rebuilds geometry. */
const ObjectMesh = memo(function ObjectMesh({ object, material }: { object: SceneObject; material: THREE.Material }) {
  // Engine arrays are shared as-is; display-only attributes (floor UVs, wall caps) are new arrays.
  const geometry = useMemo(() => toDisplayGeometry(object), [object]);
  // Frees the GPU buffers when the object leaves the scene (plan changed or viewer closed).
  useEffect(() => () => geometry.dispose(), [geometry]);
  const solid = object.material !== "glass";
  return (
    <mesh
      geometry={geometry}
      material={material}
      castShadow={solid}
      receiveShadow={solid}
      name={object.id}
      userData={{ kind: object.kind, sourceId: object.sourceId }}
    />
  );
});

const LAYER_OF: Record<ObjectKind, keyof Layers> = { wall: "walls", floor: "floors", door: "doors", window: "windows" };
const KINDS: ObjectKind[] = ["wall", "floor", "door", "window"];

interface Props {
  scene: Scene3D;
  layers: Layers;
  selectedRoomId: string | null;
  /** In a VR headset doors are drawn see-through: the visitor walks through doorways. */
  vr?: boolean;
  /** The desktop walk-through draws doors see-through too: doorways are where one can walk. */
  openDoors?: boolean;
  /** First-person views: ceilings over the rooms whose walls support one (see lib/viewer/ceilings). */
  showCeilings?: boolean;
}

/**
 * Ceilings: display-only meshes, never part of the engine output or of the collision model.
 * Always mounted (built once per scene) and only shown in first person, so switching is instant.
 */
const Ceilings = memo(function Ceilings({ scene, material, visible }: { scene: Scene3D; material: THREE.Material; visible: boolean }) {
  const geometries = useMemo(() => planCeilings(scene).ceilings.map((c) => ({ id: c.roomId, geometry: toBufferGeometry(c.mesh) })), [scene]);
  useEffect(() => () => geometries.forEach((g) => g.geometry.dispose()), [geometries]);
  return (
    <group name="layer:ceilings" visible={visible}>
      {geometries.map((g) => (
        <mesh key={g.id} name={`ceiling:${g.id}`} geometry={g.geometry} material={material} castShadow receiveShadow />
      ))}
    </group>
  );
});

/** Renders a Scene3D. Holds no geometry logic: it draws exactly what the engine produced. */
export default function PropertyScene({ scene, layers, selectedRoomId, vr = false, openDoors = false, showCeilings = false }: Props) {
  const materials = useMemo(() => createMaterials(), []);
  useEffect(() => () => materials.dispose(), [materials]);

  const roomIndex = useMemo(() => new Map(scene.spaces.map((s, i) => [s.id, i])), [scene.spaces]);
  // Desktop floor finish per room, from its name; rooms sharing a finish cycle through tint variants.
  const roomFinish = useMemo(() => {
    const seen: Record<FloorFinish, number> = { wood: 0, tile: 0, neutral: 0 };
    return new Map(scene.spaces.map((s) => {
      const finish = floorFinishFor(s.name);
      return [s.id, { finish, variant: seen[finish]++ }] as const;
    }));
  }, [scene.spaces]);
  const byKind = useMemo(() => {
    const groups: Record<ObjectKind, SceneObject[]> = { wall: [], floor: [], door: [], window: [] };
    for (const o of scene.objects) groups[o.kind].push(o);
    return groups;
  }, [scene.objects]);

  const materialFor = (o: SceneObject): THREE.Material => {
    if ((vr || openDoors) && o.kind === "door") return materials.doorOpen;
    // One look in every mode: the showroom finishes (wall caps, floor finishes) are used in VR too.
    // First person (walk-through, VR) adds contact shading; the orbit view keeps its approved walls.
    if (o.kind === "wall") return vr || openDoors ? materials.wallFirstPerson : materials.wallCapped;
    if (o.kind !== "floor" || !o.roomId) return materials.byKey[o.material];
    if (o.roomId === selectedRoomId) return materials.floorSelectedStudio;
    const f = roomFinish.get(o.roomId);
    if (f) {
      const variants = materials.finishes[f.finish];
      return variants[f.variant % variants.length];
    }
    const i = roomIndex.get(o.roomId) ?? -1;
    return i >= 0 ? materials.floors[i % materials.floors.length] : materials.byKey.floor;
  };

  return (
    <group name="property">
      {KINDS.map((kind) => (
        // Hiding a group keeps its GPU buffers: toggling back is instant.
        <group key={kind} name={`layer:${LAYER_OF[kind]}`} visible={layers[LAYER_OF[kind]]}>
          {byKind[kind].map((o) => (
            <ObjectMesh key={o.id} object={o} material={materialFor(o)} />
          ))}
        </group>
      ))}
      <Ceilings scene={scene} material={materials.ceiling} visible={showCeilings} />
    </group>
  );
}
