/**
 * Ceilings for the first-person views (walk-through and VR). Renderer-only: built from the
 * engine's own output (room outlines, wall meshes, `ceilingHeight`), never added to the engine's
 * objects, the fingerprint or the collision model.
 *
 * Accuracy first: a room gets a ceiling only when its height is backed by the walls actually
 * drawn around it. The engine's `ceilingHeight` is the tallest wall on the room's boundary, or,
 * when no wall is on the boundary, the tallest wall anywhere (a guess). So a ceiling is placed
 * only if walls were found on the room's outline and every one of them reaches that height;
 * otherwise the ceiling would float above a lower wall or rest on nothing, and the room stays open.
 *
 * Pure and deterministic, no Three.js.
 */
import { MeshBuilder } from "../geometry3d/meshBuilder";
import { triangulate } from "../geometry3d/triangulate";
import type { MeshData, Scene3D } from "../geometry3d/types";
import { sliceMesh, type P2, type Segment } from "../vr/collision";

/** Ceilings sit this far below the wall tops, inside the walls' bodies: no seam, no z-fighting. */
export const CEILING_INSET = 0.01;

export type CeilingSkip = "no-walls" | "mixed-heights" | "bad-outline";

export interface CeilingPlan {
  ceilings: { roomId: string; height: number; mesh: MeshData }[];
  skipped: { roomId: string; reason: CeilingSkip }[];
}

/** Wall tops within this of the room height count as "the same height". */
const HEIGHT_TOLERANCE = 0.01;
/** Distance between boundary samples, metres. */
const SAMPLE_STEP = 0.25;

interface WallTop {
  top: number;
  /** Outline of the wall just below its top (lintels over openings included), as loose segments. */
  segs: Segment[];
}

/**
 * Is `p` inside the closed outline(s) formed by `segs`? Ray-crossing parity toward +x, so the
 * segments need no order or orientation. Faces shared by two boxes of one wall are crossed twice
 * and cancel out, as they should.
 */
export function insideSlice(p: P2, segs: readonly Segment[]): boolean {
  let inside = false;
  for (const { a, b } of segs) {
    if (a[1] > p[1] === b[1] > p[1]) continue;
    const x = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
    if (x > p[0]) inside = !inside;
  }
  return inside;
}

function wallTops(scene: Scene3D): WallTop[] {
  const out: WallTop[] = [];
  for (const o of scene.objects) {
    if (o.kind !== "wall") continue;
    const p = o.mesh.positions;
    let top = -Infinity;
    for (let i = 1; i < p.length; i += 3) top = Math.max(top, p[i]);
    if (!Number.isFinite(top) || top <= 0) continue;
    out.push({ top, segs: sliceMesh(o.mesh, top - 0.02) });
  }
  return out;
}

function boundarySamples(poly: readonly P2[]): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / SAMPLE_STEP));
    // Edge interiors only: corners belong to two walls and say nothing extra.
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

export function planCeilings(scene: Scene3D): CeilingPlan {
  const walls = wallTops(scene);
  const plan: CeilingPlan = { ceilings: [], skipped: [] };
  for (const space of scene.spaces) {
    const poly = space.polygon as P2[];
    if (poly.length < 3 || !(space.area > 0) || !Number.isFinite(space.ceilingHeight) || space.ceilingHeight <= 0) {
      plan.skipped.push({ roomId: space.id, reason: "bad-outline" });
      continue;
    }
    let found = 0;
    let mixed = false;
    for (const s of boundarySamples(poly)) {
      for (const w of walls) {
        if (!insideSlice(s, w.segs)) continue;
        found++;
        if (Math.abs(w.top - space.ceilingHeight) > HEIGHT_TOLERANCE) mixed = true;
      }
    }
    if (found === 0) {
      plan.skipped.push({ roomId: space.id, reason: "no-walls" });
      continue;
    }
    if (mixed) {
      plan.skipped.push({ roomId: space.id, reason: "mixed-heights" });
      continue;
    }
    const h = space.ceilingHeight - CEILING_INSET;
    const { triangles, ok } = triangulate(poly);
    const b = new MeshBuilder();
    // Faces down only: seen from inside the room, invisible from above (the orbit view stays a cutaway).
    for (const [i, j, k] of triangles) b.addTriangle([poly[i][0], h, poly[i][1]], [poly[j][0], h, poly[j][1]], [poly[k][0], h, poly[k][1]], [0, -1, 0]);
    if (!ok || b.isEmpty) {
      plan.skipped.push({ roomId: space.id, reason: "bad-outline" });
      continue;
    }
    plan.ceilings.push({ roomId: space.id, height: space.ceilingHeight, mesh: b.build() });
  }
  return plan;
}
