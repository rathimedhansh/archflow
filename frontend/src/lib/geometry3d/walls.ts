import type { Door, Wall, Window } from "@/lib/floorplan/types";
import type { MeshBuilder } from "./meshBuilder";
import type { V3 } from "./types";
import { add, scale } from "./vec";

/** Two wall endpoints closer than this (metres) count as one joint. */
const JOINT_EPS = 1e-3;
/** Walls meeting at less than ~6° are treated as a straight continuation: no corner fill needed. */
const MIN_JOINT_SINE = 0.1;
const MIN_WALL_LENGTH = 1e-3;
const MIN_SPAN = 0.01;
const EPS = 1e-6;

/** Local coordinate frame of a wall: u along the centreline from `start`, v up, w across. */
export interface WallFrame {
  origin: V3;
  along: V3;
  perp: V3;
  length: number;
  thickness: number;
  height: number;
}

export interface WallInfo {
  wall: Wall;
  frame: WallFrame;
  /** How far the wall body is extended past each end to fill a corner. */
  extStart: number;
  extEnd: number;
}

/** An opening after clamping to its wall. Doors and windows share this shape. */
export interface ResolvedOpening {
  id: string;
  kind: "door" | "window";
  /** Span along the wall centreline, metres from `start`. */
  a: number;
  b: number;
  /** Vertical span of the hole. */
  bottom: number;
  top: number;
}

const sqrt = Math.sqrt;

/** Box in wall-local coordinates. `depth` defaults to the wall thickness (centred on the centreline). */
export function boxInWall(
  b: MeshBuilder, f: WallFrame, u0: number, u1: number, v0: number, v1: number, depth = f.thickness,
): void {
  if (u1 - u0 <= 0 || v1 - v0 <= 0) return;
  const origin = add(add(f.origin, scale(f.along, u0)), add([0, v0, 0], scale(f.perp, -depth / 2)));
  b.addBox(origin, scale(f.along, u1 - u0), [0, v1 - v0, 0], scale(f.perp, depth));
}

/** Frames for every usable wall, with corner extensions computed from shared endpoints. */
export function analyzeWalls(walls: readonly Wall[], warnings: string[]): WallInfo[] {
  const infos: WallInfo[] = [];
  for (const wall of walls) {
    const dx = wall.end[0] - wall.start[0];
    const dy = wall.end[1] - wall.start[1];
    const length = sqrt(dx * dx + dy * dy);
    if (!(length >= MIN_WALL_LENGTH)) {
      warnings.push(`Wall ${wall.id} is too short and was skipped.`);
      continue;
    }
    infos.push({
      wall,
      frame: {
        origin: [wall.start[0], 0, wall.start[1]],
        along: [dx / length, 0, dy / length],
        perp: [-dy / length, 0, dx / length],
        length,
        thickness: wall.thickness,
        height: wall.height,
      },
      extStart: 0,
      extEnd: 0,
    });
  }

  // Where walls meet, each body is extended by half the other's thickness so the outer
  // corner is solid. Exact for right angles; approximate (a small notch/overlap) otherwise.
  for (const a of infos) {
    for (const end of ["start", "end"] as const) {
      const p = a.wall[end];
      const awayA = end === "start" ? a.frame.along : scale(a.frame.along, -1);
      let ext = 0;
      for (const b of infos) {
        if (b === a) continue;
        for (const bEnd of ["start", "end"] as const) {
          const q = b.wall[bEnd];
          const d0 = p[0] - q[0];
          const d1 = p[1] - q[1];
          if (sqrt(d0 * d0 + d1 * d1) > JOINT_EPS) continue;
          const awayB = bEnd === "start" ? b.frame.along : scale(b.frame.along, -1);
          const sine = awayA[0] * awayB[2] - awayA[2] * awayB[0];
          if (Math.abs(sine) < MIN_JOINT_SINE) continue;
          ext = Math.max(ext, b.frame.thickness / 2);
        }
      }
      if (end === "start") a.extStart = ext;
      else a.extEnd = ext;
    }
  }
  return infos;
}

/**
 * Clamp a wall's doors/windows into it. Anything that cannot be represented (off the wall,
 * zero-sized, overlapping an earlier opening) is skipped with a warning rather than throwing,
 * so a slightly-off plan still renders.
 */
export function resolveOpenings(
  info: WallInfo, doors: readonly Door[], windows: readonly Window[], warnings: string[],
): ResolvedOpening[] {
  const { length, height } = info.frame;
  const candidates: ResolvedOpening[] = [
    ...doors.map((d) => ({ id: d.id, kind: "door" as const, a: d.offset, b: d.offset + d.width, bottom: 0, top: d.height })),
    ...windows.map((w) => ({ id: w.id, kind: "window" as const, a: w.offset, b: w.offset + w.width, bottom: w.sill, top: w.sill + w.height })),
  ];
  const resolved: ResolvedOpening[] = [];
  for (const c of candidates) {
    const o = { ...c, a: Math.max(0, c.a), b: Math.min(length, c.b), bottom: Math.max(0, c.bottom), top: Math.min(height, c.top) };
    if (o.b - o.a < MIN_SPAN || o.top - o.bottom < MIN_SPAN) {
      warnings.push(`${o.id} does not fit on wall ${info.wall.id} and was skipped.`);
      continue;
    }
    if (o.a !== c.a || o.b !== c.b || o.top !== c.top) warnings.push(`${o.id} was trimmed to fit wall ${info.wall.id}.`);
    resolved.push(o);
  }
  resolved.sort((x, y) => x.a - y.a || (x.id < y.id ? -1 : 1));
  const kept: ResolvedOpening[] = [];
  for (const o of resolved) {
    const prev = kept[kept.length - 1];
    if (prev && o.a < prev.b - EPS) {
      warnings.push(`${o.id} overlaps ${prev.id} on wall ${info.wall.id} and was skipped.`);
      continue;
    }
    kept.push(o);
  }
  return kept;
}

/** The wall body: full-height blocks between openings, plus the sill/lintel around each hole. */
export function buildWallBody(b: MeshBuilder, info: WallInfo, openings: readonly ResolvedOpening[]): void {
  const f = info.frame;
  let cursor = -info.extStart;
  for (const o of openings) {
    boxInWall(b, f, cursor, o.a, 0, f.height);
    boxInWall(b, f, o.a, o.b, 0, o.bottom); // below a window
    boxInWall(b, f, o.a, o.b, o.top, f.height); // lintel above a door/window
    cursor = o.b;
  }
  boxInWall(b, f, cursor, f.length + info.extEnd, 0, f.height);
}
