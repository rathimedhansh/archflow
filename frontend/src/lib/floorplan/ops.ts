/** Pure, immutable edit operations on a FloorPlanData. Each returns a new plan. */
import { closestPointOnSegment, dist, wallLength } from "./geometry";
import {
  DEFAULTS,
  type Door,
  type ElementKind,
  type FloorPlanData,
  type OpeningKind,
  type Point,
  type Room,
  type Selection,
  type Wall,
  type Window,
} from "./types";

function nextId(prefix: string, plan: FloorPlanData): string {
  const all = [...plan.walls, ...plan.rooms, ...plan.doors, ...plan.windows];
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  const max = all.reduce((m, e) => Math.max(m, Number(re.exec(e.id)?.[1] ?? 0)), 0);
  return `${prefix}-${max + 1}`;
}

export function addWall(plan: FloorPlanData, start: Point, end: Point): { plan: FloorPlanData; id: string } {
  const id = nextId("wall", plan);
  const wall: Wall = {
    id, start, end, height: DEFAULTS.wallHeight, thickness: DEFAULTS.wallThickness,
  };
  return { plan: { ...plan, walls: [...plan.walls, wall] }, id };
}

export function addRoom(plan: FloorPlanData, polygon: Point[]): { plan: FloorPlanData; id: string } {
  const id = nextId("room", plan);
  const room: Room = { id, name: `Room ${plan.rooms.length + 1}`, polygon };
  return { plan: { ...plan, rooms: [...plan.rooms, room] }, id };
}

/** Place an opening centred on `alongWall` metres from the wall start, clamped to fit. */
export function addOpening(
  plan: FloorPlanData,
  kind: OpeningKind,
  wallId: string,
  alongWall: number,
): { plan: FloorPlanData; id: string } | null {
  const wall = plan.walls.find((w) => w.id === wallId);
  if (!wall) return null;
  const length = wallLength(wall);
  const id = nextId(kind, plan);
  if (kind === "door") {
    const width = Math.min(DEFAULTS.doorWidth, length);
    const offset = clamp(alongWall - width / 2, 0, length - width);
    const door: Door = { id, wall_id: wallId, offset, width, height: Math.min(DEFAULTS.doorHeight, wall.height) };
    return { plan: { ...plan, doors: [...plan.doors, door] }, id };
  }
  const width = Math.min(DEFAULTS.windowWidth, length);
  const offset = clamp(alongWall - width / 2, 0, length - width);
  const height = Math.min(DEFAULTS.windowHeight, wall.height);
  const sill = Math.min(DEFAULTS.windowSill, wall.height - height);
  const win: Window = { id, wall_id: wallId, offset, width, height, sill };
  return { plan: { ...plan, windows: [...plan.windows, win] }, id };
}

export const updateWall = (plan: FloorPlanData, id: string, patch: Partial<Omit<Wall, "id">>): FloorPlanData => ({
  ...plan,
  walls: plan.walls.map((w) => (w.id === id ? { ...w, ...patch } : w)),
});

export const updateRoom = (plan: FloorPlanData, id: string, patch: Partial<Omit<Room, "id">>): FloorPlanData => ({
  ...plan,
  rooms: plan.rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)),
});

export function updateOpening(
  plan: FloorPlanData,
  kind: OpeningKind,
  id: string,
  patch: Partial<Omit<Door & Window, "id" | "wall_id">>,
): FloorPlanData {
  return kind === "door"
    ? { ...plan, doors: plan.doors.map((d) => (d.id === id ? { ...d, ...patch } : d)) }
    : { ...plan, windows: plan.windows.map((w) => (w.id === id ? { ...w, ...patch } : w)) };
}

/** Delete an element. Deleting a wall also deletes the doors/windows hosted on it. */
export function removeElement(plan: FloorPlanData, sel: Selection): FloorPlanData {
  const keep = <T extends { id: string }>(list: T[], kind: ElementKind) =>
    sel.kind === kind ? list.filter((e) => e.id !== sel.id) : list;
  const next = {
    ...plan,
    walls: keep(plan.walls, "wall"),
    rooms: keep(plan.rooms, "room"),
    doors: keep(plan.doors, "door"),
    windows: keep(plan.windows, "window"),
  };
  if (sel.kind !== "wall") return next;
  return {
    ...next,
    doors: next.doors.filter((d) => d.wall_id !== sel.id),
    windows: next.windows.filter((w) => w.wall_id !== sel.id),
  };
}

/** Every wall endpoint / room vertex sitting at `p`; dragging one drags the whole joint. */
export interface Joint {
  wallEnds: { wallId: string; end: "start" | "end" }[];
  roomVertices: { roomId: string; index: number }[];
}

export function findJoint(plan: FloorPlanData, p: Point, tol = 1e-6): Joint {
  const wallEnds: Joint["wallEnds"] = [];
  for (const w of plan.walls) {
    if (dist(w.start, p) <= tol) wallEnds.push({ wallId: w.id, end: "start" });
    if (dist(w.end, p) <= tol) wallEnds.push({ wallId: w.id, end: "end" });
  }
  const roomVertices: Joint["roomVertices"] = [];
  for (const r of plan.rooms) {
    r.polygon.forEach((v, index) => {
      if (dist(v, p) <= tol) roomVertices.push({ roomId: r.id, index });
    });
  }
  return { wallEnds, roomVertices };
}

export function moveJoint(plan: FloorPlanData, joint: Joint, to: Point): FloorPlanData {
  return {
    ...plan,
    walls: plan.walls.map((w) => {
      let next = w;
      for (const e of joint.wallEnds) if (e.wallId === w.id) next = { ...next, [e.end]: to };
      return next;
    }),
    rooms: plan.rooms.map((r) => {
      const hits = joint.roomVertices.filter((v) => v.roomId === r.id);
      if (!hits.length) return r;
      return { ...r, polygon: r.polygon.map((v, i) => (hits.some((h) => h.index === i) ? to : v)) };
    }),
  };
}

/** Nearest wall to `p` within `maxDistance`, with the position along it. */
export function nearestWall(plan: FloorPlanData, p: Point, maxDistance: number) {
  let best: { wall: Wall; along: number; distance: number } | null = null;
  for (const wall of plan.walls) {
    const hit = closestPointOnSegment(p, wall.start, wall.end);
    if (hit.distance <= maxDistance && (!best || hit.distance < best.distance)) {
      best = { wall, along: hit.along, distance: hit.distance };
    }
  }
  return best;
}

/**
 * Set the real-world scale. Geometry is re-scaled so everything stays exactly where it
 * sits on the image; only its metric meaning changes. Wall/door heights and thicknesses
 * are real-world values the user chose, so they are left alone.
 */
export function applyScale(plan: FloorPlanData, metersPerPixel: number): FloorPlanData {
  const k = metersPerPixel / plan.scale.meters_per_pixel;
  const s = (p: Point): Point => [p[0] * k, p[1] * k];
  return {
    ...plan,
    scale: { meters_per_pixel: metersPerPixel, calibrated: true },
    walls: plan.walls.map((w) => ({ ...w, start: s(w.start), end: s(w.end) })),
    rooms: plan.rooms.map((r) => ({ ...r, polygon: r.polygon.map(s) })),
    doors: plan.doors.map((d) => ({ ...d, offset: d.offset * k, width: d.width * k })),
    windows: plan.windows.map((w) => ({ ...w, offset: w.offset * k, width: w.width * k })),
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
