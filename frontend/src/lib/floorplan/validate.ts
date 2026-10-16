import { polygonArea, polygonSelfIntersects, wallLength } from "./geometry";
import type { FloorPlanData, Selection } from "./types";

/** Mirrors the backend rules (backend/app/schema/floorplan.py) for instant editor feedback. */
export const MIN_WALL_LENGTH_M = 0.05;
export const MIN_ROOM_AREA_M2 = 0.5;
const EPS = 1e-6;

export interface Issue {
  message: string;
  /** Element to highlight when the issue is clicked. */
  ref?: Selection;
}

export function validateFloorPlan(plan: FloorPlanData): Issue[] {
  const issues: Issue[] = [];
  const walls = new Map(plan.walls.map((w) => [w.id, w]));

  for (const w of plan.walls) {
    if (wallLength(w) < MIN_WALL_LENGTH_M) {
      issues.push({ message: `Wall ${w.id} is too short.`, ref: { kind: "wall", id: w.id } });
    }
  }

  for (const r of plan.rooms) {
    const ref = { kind: "room", id: r.id } as const;
    if (r.polygon.length < 3) issues.push({ message: `Room '${r.name}' needs at least 3 corners.`, ref });
    else if (polygonSelfIntersects(r.polygon))
      issues.push({ message: `Room '${r.name}' crosses itself.`, ref });
    else if (polygonArea(r.polygon) < MIN_ROOM_AREA_M2)
      issues.push({ message: `Room '${r.name}' is too small.`, ref });
    if (!r.name.trim()) issues.push({ message: "A room has no name.", ref });
  }

  const spans = new Map<string, { start: number; end: number; id: string }[]>();
  const openings = [
    ...plan.doors.map((o) => ({ kind: "door" as const, o, top: o.height })),
    ...plan.windows.map((o) => ({ kind: "window" as const, o, top: o.sill + o.height })),
  ];
  for (const { kind, o, top } of openings) {
    const ref = { kind, id: o.id };
    const wall = walls.get(o.wall_id);
    if (!wall) {
      issues.push({ message: `${o.id} is not on a wall.`, ref });
      continue;
    }
    if (o.offset + o.width > wallLength(wall) + EPS)
      issues.push({ message: `${o.id} extends past the end of ${wall.id}.`, ref });
    if (top > wall.height + EPS) issues.push({ message: `${o.id} is taller than ${wall.id}.`, ref });
    const list = spans.get(wall.id) ?? [];
    list.push({ start: o.offset, end: o.offset + o.width, id: o.id });
    spans.set(wall.id, list);
  }
  for (const [wallId, list] of spans) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      if (list[i].start < list[i - 1].end - EPS) {
        issues.push({ message: `${list[i - 1].id} and ${list[i].id} overlap on ${wallId}.` });
      }
    }
  }
  return issues;
}
