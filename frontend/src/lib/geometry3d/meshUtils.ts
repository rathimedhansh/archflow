import type { MeshData, SceneBounds, V3 } from "./types";

/** Signed volume by the divergence theorem. Positive for a closed, outward-wound solid. */
export function meshVolume(mesh: MeshData): number {
  const p = mesh.positions;
  let sum = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i] * 3;
    const b = mesh.indices[i + 1] * 3;
    const c = mesh.indices[i + 2] * 3;
    sum +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return sum / 6;
}

export const triangleCount = (mesh: MeshData): number => mesh.indices.length / 3;

export function meshBounds(meshes: readonly MeshData[]): SceneBounds {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = m.positions[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  return min[0] === Infinity ? { min: [0, 0, 0], max: [0, 0, 0] } : { min, max };
}
