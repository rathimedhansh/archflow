import * as THREE from "three";
import type { Slab, SlabKind, SitePlan } from "@/lib/viewer/environment";
import { valueNoise3 } from "../../../lib/viewer/random";

/** Which surface material each slab kind uses (several kinds share one, so they share a draw call). */
export type SurfaceMaterial = "asphalt" | "paint" | "concrete" | "curb" | "driveway" | "pavers" | "mulch" | "plaza" | "grate" | "planter";
export const SURFACE_OF: Record<SlabKind, SurfaceMaterial> = {
  road: "asphalt", marking: "paint", sidewalk: "concrete", curb: "curb", driveway: "driveway",
  path: "pavers", bed: "mulch", plaza: "plaza", grate: "grate", planter: "planter",
};
/** Texture scale per surface (UVs are world metres times this); larger plaza slabs, for instance. */
const UV_SCALE: Partial<Record<SurfaceMaterial, number>> = { plaza: 0.6, driveway: 0.85 };

/**
 * Boxes from the ground up to each slab's top: the top face plus the four sides (the bottom is
 * never seen). Top UVs are world metres, so a texture's real-world size is fixed everywhere.
 */
function slabBoxes(slabs: Slab[], groundY: number, uvScale: number): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const quad = (pts: number[][], n: number[], uvs: number[][]) => {
    const i0 = pos.length / 3;
    pts.forEach((p, k) => { pos.push(...p); nor.push(...n); uv.push(...uvs[k]); });
    idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  };
  for (const { rect: r, top } of slabs) {
    const y0 = groundY, y1 = groundY + top, s = uvScale;
    // Top (counter-clockwise seen from above).
    quad([[r.x0, y1, r.z1], [r.x1, y1, r.z1], [r.x1, y1, r.z0], [r.x0, y1, r.z0]], [0, 1, 0],
      [[r.x0 * s, -r.z1 * s], [r.x1 * s, -r.z1 * s], [r.x1 * s, -r.z0 * s], [r.x0 * s, -r.z0 * s]]);
    const h = top * s;
    // Sides: +z, -z, +x, -x.
    quad([[r.x0, y0, r.z1], [r.x1, y0, r.z1], [r.x1, y1, r.z1], [r.x0, y1, r.z1]], [0, 0, 1], [[r.x0 * s, 0], [r.x1 * s, 0], [r.x1 * s, h], [r.x0 * s, h]]);
    quad([[r.x1, y0, r.z0], [r.x0, y0, r.z0], [r.x0, y1, r.z0], [r.x1, y1, r.z0]], [0, 0, -1], [[r.x1 * s, 0], [r.x0 * s, 0], [r.x0 * s, h], [r.x1 * s, h]]);
    quad([[r.x1, y0, r.z1], [r.x1, y0, r.z0], [r.x1, y1, r.z0], [r.x1, y1, r.z1]], [1, 0, 0], [[r.z1 * s, 0], [r.z0 * s, 0], [r.z0 * s, h], [r.z1 * s, h]]);
    quad([[r.x0, y0, r.z0], [r.x0, y0, r.z1], [r.x0, y1, r.z1], [r.x0, y1, r.z0]], [-1, 0, 0], [[r.z0 * s, 0], [r.z1 * s, 0], [r.z1 * s, h], [r.z0 * s, h]]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** All slabs, merged into one geometry per surface material. */
export function buildSlabGeometries(plan: SitePlan, groundY: number): Map<SurfaceMaterial, THREE.BufferGeometry> {
  const groups = new Map<SurfaceMaterial, Slab[]>();
  for (const s of plan.slabs) {
    const m = SURFACE_OF[s.kind];
    groups.set(m, [...(groups.get(m) ?? []), s]);
  }
  const out = new Map<SurfaceMaterial, THREE.BufferGeometry>();
  for (const [m, slabs] of groups) out.set(m, slabBoxes(slabs, groundY, UV_SCALE[m] ?? 1));
  return out;
}

/** Cells per side of the lawn grid: enough for gentle colour patches, cheap to draw. */
const LAWN_CELLS = 72;

/**
 * The lawn: one flat square over the whole site, with very low-frequency colour variation in
 * vertex colours so the repeating grass texture never reads as a pattern from afar.
 */
export function buildLawnGeometry(plan: SitePlan, groundY: number): THREE.BufferGeometry {
  const size = plan.extent * 2;
  const g = new THREE.PlaneGeometry(size, size, LAWN_CELLS, LAWN_CELLS);
  g.rotateX(-Math.PI / 2);
  g.translate(plan.center[0], groundY, plan.center[1]);
  const pos = g.getAttribute("position");
  const uv = g.getAttribute("uv");
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    uv.setXY(i, x, -z);
    const n = valueNoise3(x * 0.07, 0.5, z * 0.07, 3) * 0.65 + valueNoise3(x * 0.21, 1.5, z * 0.21, 4) * 0.35;
    // Slightly lighter/yellower and darker patches, ±7 %.
    const k = 0.93 + n * 0.14;
    col[i * 3] = k * (0.98 + n * 0.06);
    col[i * 3 + 1] = k;
    col[i * 3 + 2] = k * 0.96;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}
