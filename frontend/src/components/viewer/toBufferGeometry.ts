import * as THREE from "three";
import type { MeshData, SceneObject } from "@/lib/geometry3d";

/** Engine mesh -> Three.js geometry. The typed arrays are shared, not copied, and never mutated. */
export function toBufferGeometry(mesh: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

/** Linear RGB triple, as stored in a vertex colour attribute. */
export type RGB = readonly [number, number, number];

/**
 * Floor texture coordinates: world X/Z in metres, so a texture's repeat is a real size.
 * Reads the engine's positions and returns a new array.
 */
export function planarUVs(positions: Float32Array): Float32Array {
  const uv = new Float32Array((positions.length / 3) * 2);
  for (let v = 0; v < positions.length / 3; v++) {
    uv[v * 2] = positions[v * 3];
    uv[v * 2 + 1] = positions[v * 3 + 2];
  }
  return uv;
}

/**
 * Per-vertex colours for a wall: `cap` on upward faces at the wall's full height (its exposed
 * top, lintels included), `side` everywhere else (window sills sit lower, so they stay `side`).
 * Meshes are flat-shaded (every face owns its vertices), so per-vertex is per-face.
 * Reads the engine's arrays and returns a new array.
 */
export function wallCapColors(mesh: MeshData, side: RGB, cap: RGB): Float32Array {
  const { positions, normals } = mesh;
  const count = positions.length / 3;
  let top = -Infinity;
  for (let v = 0; v < count; v++) top = Math.max(top, positions[v * 3 + 1]);
  const colors = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const isCap = normals[v * 3 + 1] > 0.99 && positions[v * 3 + 1] >= top - 1e-4;
    const c = isCap ? cap : side;
    colors[v * 3] = c[0];
    colors[v * 3 + 1] = c[1];
    colors[v * 3 + 2] = c[2];
  }
  return colors;
}

const toRGB = (hex: string): RGB => {
  const c = new THREE.Color(hex); // sRGB hex -> linear working space
  return [c.r, c.g, c.b];
};
export const WALL_SIDE_COLOR = "#ece8e0";
export const WALL_CAP_COLOR = "#3a3d42";

/**
 * Geometry plus renderer-only display data (floor UVs, wall-top colours) for the desktop look.
 * The extra attributes are separate arrays; materials that do not use them ignore them.
 */
export function toDisplayGeometry(object: SceneObject): THREE.BufferGeometry {
  const geometry = toBufferGeometry(object.mesh);
  if (object.kind === "floor") {
    geometry.setAttribute("uv", new THREE.BufferAttribute(planarUVs(object.mesh.positions), 2));
  } else if (object.kind === "wall") {
    geometry.setAttribute("color", new THREE.BufferAttribute(wallCapColors(object.mesh, toRGB(WALL_SIDE_COLOR), toRGB(WALL_CAP_COLOR)), 3));
  }
  return geometry;
}
