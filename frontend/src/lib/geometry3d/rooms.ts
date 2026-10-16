import type { Room, Wall } from "@/lib/floorplan/types";
import { MeshBuilder } from "./meshBuilder";
import { signedArea } from "./triangulate";
import type { SceneObject, SceneSpace } from "./types";

const MIN_AREA = 1e-6;
/** A wall belongs to a room's boundary if its midpoint is this close to the outline (metres). */
const BOUNDARY_TOLERANCE = 0.3;

function distanceToOutline(p: readonly [number, number], poly: readonly (readonly [number, number])[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const ex = p[0] - (a[0] + t * dx);
    const ey = p[1] - (a[1] + t * dy);
    best = Math.min(best, Math.sqrt(ex * ex + ey * ey));
  }
  return best;
}

/** Ceiling height: the tallest wall along the room's boundary, else the tallest wall anywhere. */
export function ceilingHeightFor(room: Room, walls: readonly Wall[], fallback: number): number {
  const mid = (w: Wall): [number, number] => [(w.start[0] + w.end[0]) / 2, (w.start[1] + w.end[1]) / 2];
  const onBoundary = walls.filter((w) => distanceToOutline(mid(w), room.polygon) <= Math.max(BOUNDARY_TOLERANCE, w.thickness));
  const pool = onBoundary.length ? onBoundary : walls;
  return pool.length ? Math.max(...pool.map((w) => w.height)) : fallback;
}

/** Floor slab (top surface at y = 0) and the space (volume, area, label anchor) for one room. */
export function buildRoom(
  room: Room, walls: readonly Wall[], floorThickness: number, defaultHeight: number, warnings: string[],
): { floor: SceneObject; space: SceneSpace } | null {
  const area = Math.abs(signedArea(room.polygon));
  if (room.polygon.length < 3 || !(area > MIN_AREA)) {
    warnings.push(`Room '${room.name}' has no area and was skipped.`);
    return null;
  }

  const floorBuilder = new MeshBuilder();
  const complete = floorBuilder.addPrism(room.polygon, -floorThickness, 0);
  if (!complete) warnings.push(`Room '${room.name}' has an irregular outline; its floor may be incomplete.`);

  const ceilingHeight = ceilingHeightFor(room, walls, defaultHeight);
  const volumeBuilder = new MeshBuilder();
  volumeBuilder.addPrism(room.polygon, 0, ceilingHeight);

  // Area-weighted centroid; a point inside a concave room is not guaranteed, fine for a label anchor.
  let cx = 0;
  let cy = 0;
  const signed = signedArea(room.polygon);
  for (let i = 0; i < room.polygon.length; i++) {
    const [x1, y1] = room.polygon[i];
    const [x2, y2] = room.polygon[(i + 1) % room.polygon.length];
    const cr = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * cr;
    cy += (y1 + y2) * cr;
  }
  const centroid: SceneSpace["centroid"] = [cx / (6 * signed), 0, cy / (6 * signed)];

  const floorId = `floor:${room.id}`;
  return {
    floor: { id: floorId, kind: "floor", sourceId: room.id, material: "floor", roomId: room.id, mesh: floorBuilder.build() },
    space: {
      id: room.id,
      name: room.name,
      polygon: room.polygon.map(([x, y]) => [x, y]),
      area,
      ceilingHeight,
      floorObjectId: floorId,
      centroid,
      volume: volumeBuilder.build(),
    },
  };
}
