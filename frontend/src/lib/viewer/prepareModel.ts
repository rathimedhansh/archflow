/**
 * Untrusted plan JSON -> something the 3D viewer can always render (or explain).
 *
 * The backend validates plans on save, but the viewer must never crash on whatever it is
 * handed: an old file on disk, a hand-edited plan, a future schema version, a truncated
 * response. This module is the one gate between raw data and the geometry engine. It never
 * throws; every outcome is a value the UI can show.
 *
 * Malformed *elements* are dropped (and reported in `notes`); a malformed *plan* (not an
 * object, unknown version) is rejected. The FloorPlan schema itself is unchanged.
 */
import type { Door, FloorPlanData, Point, Room, Wall, Window } from "../floorplan/types";
import { buildScene } from "../geometry3d/buildScene";
import { summarizeScene, type SceneStats } from "../geometry3d/stats";
import type { Scene3D } from "../geometry3d/types";

export type PreparedModel =
  /** The data is not a floor plan at all. Nothing can be shown. */
  | { kind: "invalid"; message: string }
  /** A valid plan with nothing drawn in it yet. */
  | { kind: "empty"; plan: FloorPlanData; notes: string[] }
  /** The plan has elements, but none of them produced any geometry. */
  | { kind: "no-geometry"; plan: FloorPlanData; notes: string[] }
  | { kind: "ready"; plan: FloorPlanData; scene: Scene3D; stats: SceneStats; notes: string[] };

/** Coordinates beyond this (metres) are treated as corrupt, not as a 1000 km building. */
const MAX_COORD = 100_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
const pos = (v: unknown): v is number => num(v) && v > 0;
const nonNeg = (v: unknown): v is number => num(v) && v >= 0;
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
const point = (v: unknown): v is Point => Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]);

function parseWall(v: unknown): Wall | null {
  if (!isObj(v) || !str(v.id) || !point(v.start) || !point(v.end) || !pos(v.height) || !pos(v.thickness)) return null;
  return { id: v.id, start: [v.start[0], v.start[1]], end: [v.end[0], v.end[1]], height: v.height, thickness: v.thickness };
}

function parseRoom(v: unknown): Room | null {
  if (!isObj(v) || !str(v.id) || !Array.isArray(v.polygon) || v.polygon.length < 3 || !v.polygon.every(point)) return null;
  const name = typeof v.name === "string" && v.name.trim() ? v.name.trim().slice(0, 80) : "Unnamed room";
  return { id: v.id, name, polygon: (v.polygon as Point[]).map(([x, y]) => [x, y]) };
}

function parseDoor(v: unknown): Door | null {
  if (!isObj(v) || !str(v.id) || !str(v.wall_id) || !nonNeg(v.offset) || !pos(v.width) || !pos(v.height)) return null;
  return { id: v.id, wall_id: v.wall_id, offset: v.offset, width: v.width, height: v.height };
}

function parseWindow(v: unknown): Window | null {
  if (!isObj(v) || !str(v.id) || !str(v.wall_id) || !nonNeg(v.offset) || !pos(v.width) || !pos(v.height) || !nonNeg(v.sill)) {
    return null;
  }
  return { id: v.id, wall_id: v.wall_id, offset: v.offset, width: v.width, height: v.height, sill: v.sill };
}

/** Parse one element list. Drops malformed items and duplicate ids (ids must be unique plan-wide). */
function parseList<T extends { id: string }>(
  raw: unknown, label: string, parse: (v: unknown) => T | null, seen: Set<string>, notes: string[],
): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    notes.push(`The plan's ${label}s list is malformed and was ignored.`);
    return [];
  }
  const out: T[] = [];
  let bad = 0;
  let dup = 0;
  for (const item of raw) {
    const parsed = parse(item);
    if (!parsed) bad++;
    else if (seen.has(parsed.id)) dup++;
    else {
      seen.add(parsed.id);
      out.push(parsed);
    }
  }
  const n = (count: number) => `${count} ${count > 1 ? `${label}s` : label}`;
  if (bad) notes.push(`${n(bad)} with missing or invalid data ${bad > 1 ? "were" : "was"} skipped.`);
  if (dup) notes.push(`${n(dup)} with a duplicate id ${dup > 1 ? "were" : "was"} skipped.`);
  return out;
}

/** Turn unknown JSON into a well-formed FloorPlanData, or explain why that is impossible. */
export function parseFloorPlan(raw: unknown): { ok: true; plan: FloorPlanData; notes: string[] } | { ok: false; message: string } {
  if (!isObj(raw)) return { ok: false, message: "The saved floor plan is not in a format ARCHFLOW can read." };
  if (raw.version !== 1) {
    return { ok: false, message: `This floor plan uses an unsupported format version (${String(raw.version ?? "missing")}).` };
  }

  const notes: string[] = [];
  const scale = isObj(raw.scale) ? raw.scale : null;
  const metersPerPixel = scale && pos(scale.meters_per_pixel) ? scale.meters_per_pixel : 0.01;
  // Anything short of an explicit `true` is uncalibrated: never claim a measurement we do not have.
  const calibrated = scale?.calibrated === true;
  if (!scale) notes.push("The plan has no scale information; sizes are assumed.");

  const src = isObj(raw.source) ? raw.source : {};
  const seen = new Set<string>();
  const walls = parseList(raw.walls, "wall", parseWall, seen, notes);
  const rooms = parseList(raw.rooms, "room", parseRoom, seen, notes);
  const doors = parseList(raw.doors, "door", parseDoor, seen, notes);
  const windows = parseList(raw.windows, "window", parseWindow, seen, notes);

  const provenance = raw.provenance === "opencv" || raw.provenance === "ai" ? raw.provenance : "manual";
  return {
    ok: true,
    notes,
    plan: {
      version: 1,
      units: "meters",
      provenance,
      source: {
        floorplan_id: typeof src.floorplan_id === "string" ? src.floorplan_id : "",
        width_px: pos(src.width_px) ? src.width_px : 0,
        height_px: pos(src.height_px) ? src.height_px : 0,
      },
      scale: { meters_per_pixel: metersPerPixel, calibrated },
      walls,
      rooms,
      doors,
      windows,
    },
  };
}

const boundsFinite = (s: Scene3D) => [...s.bounds.min, ...s.bounds.max].every(Number.isFinite);

/** The whole viewer pipeline in one call: raw JSON -> parsed plan -> Scene3D -> stats. Never throws. */
export function prepareModel(raw: unknown): PreparedModel {
  const parsed = parseFloorPlan(raw);
  if (!parsed.ok) return { kind: "invalid", message: parsed.message };
  const { plan, notes } = parsed;

  const elementCount = plan.walls.length + plan.rooms.length + plan.doors.length + plan.windows.length;
  // Nothing usable: "empty" if nothing was drawn, "no-geometry" if everything drawn was malformed.
  if (elementCount === 0) return { kind: notes.length ? "no-geometry" : "empty", plan, notes };

  let scene: Scene3D;
  try {
    scene = buildScene(plan);
  } catch {
    return { kind: "invalid", message: "ARCHFLOW could not build a 3D model from this floor plan." };
  }
  const allNotes = [...notes, ...scene.warnings];
  if (scene.objects.length === 0) return { kind: "no-geometry", plan, notes: allNotes };
  if (!boundsFinite(scene)) return { kind: "invalid", message: "The floor plan's measurements are out of range." };
  return { kind: "ready", plan, scene, stats: summarizeScene(scene), notes: allNotes };
}
