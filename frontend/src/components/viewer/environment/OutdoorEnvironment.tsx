"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { Scene3D } from "@/lib/geometry3d";
import { doorCenters, PLANT_SPECS, planSite, type PlantKind, type Rect, type SiteStyle } from "@/lib/viewer/environment";
import { createSiteFade } from "./siteFade";
import { buildLawnGeometry, buildSlabGeometries, type SurfaceMaterial } from "./siteGeometry";
import { createBlobTexture, createSiteTexture, type SiteTextureKey } from "./siteTextures";
import { protectedViews } from "./sightLines";
import { buildPlantGeometries } from "./vegetation";

/** Materials, textures and plant shapes: built once per viewer, shared by every style. */
function createKit() {
  const fade = createSiteFade();
  const textures = new Map<SiteTextureKey, THREE.Texture>();
  const tex = (key: SiteTextureKey) => {
    if (!textures.has(key)) {
      const t = createSiteTexture(key);
      if (t) textures.set(key, t);
    }
    return textures.get(key) ?? null;
  };
  const std = (params: THREE.MeshStandardMaterialParameters) => {
    const m = new THREE.MeshStandardMaterial({ metalness: 0, ...params });
    fade.apply(m);
    return m;
  };
  // Raised and overlaid surfaces are pulled toward the camera so far-away layers never flicker.
  const offset = (units: number) => ({ polygonOffset: true, polygonOffsetFactor: -units, polygonOffsetUnits: -units });
  const surfaces: Record<SurfaceMaterial, THREE.MeshStandardMaterial> = {
    asphalt: std({ map: tex("asphalt"), color: "#ffffff", roughness: 0.92, ...offset(1) }),
    paint: std({ color: "#e6e3da", roughness: 0.75, ...offset(3) }),
    concrete: std({ map: tex("concrete"), color: "#ffffff", roughness: 0.88 }),
    curb: std({ map: tex("concrete"), color: "#f2f0ec", roughness: 0.85 }),
    driveway: std({ map: tex("concrete"), color: "#e9e6e0", roughness: 0.88 }),
    pavers: std({ map: tex("pavers"), color: "#ffffff", roughness: 0.85 }),
    mulch: std({ map: tex("mulch"), color: "#ffffff", roughness: 1, ...offset(1) }),
    plaza: std({ map: tex("concrete"), color: "#f1ece4", roughness: 0.82 }),
    grate: std({ color: "#3d3c39", roughness: 0.6, metalness: 0.3, ...offset(2) }),
    planter: std({ map: tex("concrete"), color: "#c9c6c0", roughness: 0.8 }),
  };
  const lawn = std({ map: tex("grass"), color: "#ffffff", roughness: 0.95, vertexColors: true });
  const foliage = std({ vertexColors: true, roughness: 0.88 });
  const blobMap = createBlobTexture();
  const blob = new THREE.MeshBasicMaterial({ color: "#1d2418", transparent: true, opacity: 0.32, alphaMap: blobMap, depthWrite: false, ...offset(4) });
  fade.apply(blob);
  const plants = buildPlantGeometries();
  const blobGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  return {
    fade, surfaces, lawn, foliage, blob, plants, blobGeometry,
    dispose: () => {
      [...Object.values(surfaces), lawn, foliage, blob].forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
      blobMap?.dispose();
      plants.forEach((g) => g.dispose());
      blobGeometry.dispose();
    },
  };
}

interface Props {
  scene: Scene3D;
  style: SiteStyle;
  /** The house plinth's footprint and the ground it stands on (from the studio base). */
  footprint: Rect;
  groundY: number;
  /** False in VR: the headset view keeps its own ground and is never drawn with the surroundings. */
  visible?: boolean;
}

/**
 * Illustrative outdoor surroundings around the model (desktop viewer only; hidden in VR).
 * Separate from the house: it reads the engine's output but never changes it, casts no shadows
 * (plants get soft contact shadows instead), and is static, so it costs nothing while idle.
 */
export default function OutdoorEnvironment({ scene, style, footprint, groundY, visible = true }: Props) {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const kit = useMemo(() => createKit(), []);
  useEffect(() => () => kit.dispose(), [kit]);

  const doors = useMemo(() => doorCenters(scene), [scene]);
  const views = useMemo(() => protectedViews(scene.bounds), [scene.bounds]);
  const plan = useMemo(() => planSite({ style, footprint, groundY, doors, views }), [style, footprint, groundY, doors, views]);

  const slabs = useMemo(() => buildSlabGeometries(plan, groundY), [plan, groundY]);
  useEffect(() => () => slabs.forEach((g) => g.dispose()), [slabs]);
  const lawn = useMemo(() => buildLawnGeometry(plan, groundY), [plan, groundY]);
  useEffect(() => () => lawn.dispose(), [lawn]);

  // One instanced mesh per plant variant, plus one for every plant's contact shadow.
  const instanced = useMemo(() => {
    const meshes: THREE.InstancedMesh[] = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const tint = new THREE.Color();
    for (const [key, geometry] of kit.plants) {
      const [kind, v] = key.split(":");
      const list = plan.plants.filter((pl) => pl.kind === kind && pl.variant === Number(v));
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(geometry, kit.foliage, list.length);
      mesh.name = `site-plants:${key}`;
      list.forEach((pl, i) => {
        q.setFromAxisAngle(up, pl.rotation);
        m.compose(p.set(pl.x, groundY + pl.base, pl.z), q, s.setScalar(pl.scale));
        mesh.setMatrixAt(i, m);
        // A slight per-plant shade so neighbours of the same variant are not identical.
        const k = 0.9 + (((pl.x * 12.9898 + pl.z * 78.233) % 1) + 1) % 1 * 0.18;
        mesh.setColorAt(i, tint.setRGB(k, k, k * 0.97));
      });
      mesh.computeBoundingSphere();
      meshes.push(mesh);
    }
    const blobs = new THREE.InstancedMesh(kit.blobGeometry, kit.blob, Math.max(1, plan.plants.length));
    blobs.name = "site-contact-shadows";
    blobs.count = plan.plants.length;
    plan.plants.forEach((pl, i) => {
      const spec = PLANT_SPECS[pl.kind as PlantKind][pl.variant];
      const r = Math.max(...spec.envelope.map((e) => e.r)) * pl.scale * (pl.kind === "bush" ? 1.25 : 1.05);
      m.compose(p.set(pl.x + r * 0.12, groundY + pl.base + 0.004, pl.z + r * 0.08), q.identity(), s.set(r * 2, 1, r * 2));
      blobs.setMatrixAt(i, m);
    });
    blobs.computeBoundingSphere();
    meshes.push(blobs);
    return meshes;
  }, [kit, plan, groundY]);
  useEffect(() => () => instanced.forEach((mesh) => mesh.dispose()), [instanced]);

  useEffect(() => {
    kit.fade.uniforms.siteCenter.value.set(plan.center[0], plan.center[1]);
    kit.fade.uniforms.siteFade.value.set(plan.fade[0], plan.fade[1]);
    invalidate();
  }, [kit, plan, invalidate]);
  // The fade samples the backdrop gradient by screen row: keep it in step with the canvas size.
  const size = useMemo(() => new THREE.Vector2(), []);
  useFrame(() => {
    gl.getDrawingBufferSize(size);
    kit.fade.uniforms.siteViewport.value.copy(size);
  });

  return (
    <group name="site" visible={visible} userData={{ illustrative: true, style }}>
      <mesh name="site-lawn" geometry={lawn} material={kit.lawn} receiveShadow />
      {[...slabs].map(([m, g]) => (
        <mesh key={m} name={`site-${m}`} geometry={g} material={kit.surfaces[m]} receiveShadow />
      ))}
      {instanced.map((mesh) => (
        <primitive key={mesh.name} object={mesh} />
      ))}
    </group>
  );
}
