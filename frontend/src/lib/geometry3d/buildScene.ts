import type { FloorPlanData } from "@/lib/floorplan/types";
import { MeshBuilder } from "./meshBuilder";
import { meshBounds } from "./meshUtils";
import { buildDoor, buildWindowFrame, buildWindowGlass } from "./openings";
import { buildRoom } from "./rooms";
import type { Scene3D, SceneObject, SceneSpace } from "./types";
import { analyzeWalls, buildWallBody, resolveOpenings, type ResolvedOpening } from "./walls";

export interface SceneOptions {
  /** Thickness of the floor slab under each room, metres. */
  floorThickness?: number;
  /** Ceiling height for a room when the plan has no walls at all. */
  defaultCeilingHeight?: number;
}

export const DEFAULT_SCENE_OPTIONS: Required<SceneOptions> = {
  floorThickness: 0.1,
  defaultCeilingHeight: 2.8,
};

/**
 * FloorPlan -> 3D scene description.
 *
 * Pure and deterministic: the same plan always yields bit-identical geometry, the input is
 * never mutated, and nothing here touches React, Three.js or the DOM. Input problems never
 * throw; they are worked around and reported in `scene.warnings`.
 *
 * Object order is fixed: walls, floors, doors, windows, each in plan order.
 */
export function buildScene(plan: FloorPlanData, options: SceneOptions = {}): Scene3D {
  const opts = { ...DEFAULT_SCENE_OPTIONS, ...options };
  const warnings: string[] = [];

  const infos = analyzeWalls(plan.walls, warnings);
  const infoById = new Map(infos.map((i) => [i.wall.id, i]));

  // Group openings by host wall; report ones whose wall does not exist.
  const doorsByWall = new Map<string, typeof plan.doors>();
  const windowsByWall = new Map<string, typeof plan.windows>();
  const group = <T extends { id: string; wall_id: string }>(items: readonly T[], into: Map<string, T[]>) => {
    for (const item of items) {
      if (!infoById.has(item.wall_id)) {
        warnings.push(`${item.id} is on unknown or skipped wall ${item.wall_id} and was skipped.`);
        continue;
      }
      into.set(item.wall_id, [...(into.get(item.wall_id) ?? []), item]);
    }
  };
  group(plan.doors, doorsByWall as Map<string, (typeof plan.doors)[number][]>);
  group(plan.windows, windowsByWall as Map<string, (typeof plan.windows)[number][]>);

  const walls: SceneObject[] = [];
  const resolvedById = new Map<string, { info: (typeof infos)[number]; opening: ResolvedOpening }>();
  for (const info of infos) {
    const openings = resolveOpenings(info, doorsByWall.get(info.wall.id) ?? [], windowsByWall.get(info.wall.id) ?? [], warnings);
    for (const opening of openings) resolvedById.set(opening.id, { info, opening });
    const b = new MeshBuilder();
    buildWallBody(b, info, openings);
    walls.push({ id: info.wall.id, kind: "wall", sourceId: info.wall.id, material: "wall", mesh: b.build() });
  }

  const floors: SceneObject[] = [];
  const spaces: SceneSpace[] = [];
  for (const room of plan.rooms) {
    const built = buildRoom(room, plan.walls, opts.floorThickness, opts.defaultCeilingHeight, warnings);
    if (!built) continue;
    floors.push(built.floor);
    spaces.push(built.space);
  }

  const doors: SceneObject[] = [];
  for (const door of plan.doors) {
    const hit = resolvedById.get(door.id);
    if (!hit || hit.opening.kind !== "door") continue;
    const b = new MeshBuilder();
    buildDoor(b, hit.info.frame, hit.opening);
    doors.push({ id: door.id, kind: "door", sourceId: door.id, material: "door", mesh: b.build() });
  }

  const windows: SceneObject[] = [];
  for (const win of plan.windows) {
    const hit = resolvedById.get(win.id);
    if (!hit || hit.opening.kind !== "window") continue;
    const frame = new MeshBuilder();
    buildWindowFrame(frame, hit.info.frame, hit.opening);
    windows.push({ id: win.id, kind: "window", sourceId: win.id, material: "windowFrame", mesh: frame.build() });
    const glass = new MeshBuilder();
    buildWindowGlass(glass, hit.info.frame, hit.opening);
    if (!glass.isEmpty) {
      windows.push({ id: `${win.id}:glass`, kind: "window", sourceId: win.id, material: "glass", mesh: glass.build() });
    }
  }

  const objects = [...walls, ...floors, ...doors, ...windows];
  return {
    units: "meters",
    scale: { calibrated: plan.scale.calibrated, metersPerPixel: plan.scale.meters_per_pixel },
    bounds: meshBounds(objects.map((o) => o.mesh)),
    objects,
    spaces,
    warnings,
  };
}
