/**
 * Output contract of the geometry engine. Plain data only: no Three.js, no React, no colours.
 *
 * World space: metres; X right, Y up, Z toward the viewer. A FloorPlan point (x, y) maps to
 * world (x, ·, y), and heights map to Y, so viewed from above the model matches the plan image.
 */

export type V3 = [number, number, number];

export interface MeshData {
  /** xyz per vertex. Flat-shaded: every face owns its vertices. */
  positions: Float32Array;
  normals: Float32Array;
  /** Counter-clockwise triangles seen from outside (outward-facing). */
  indices: Uint32Array;
}

/** Semantic material slot. The renderer decides what each one looks like. */
export type MaterialKey = "wall" | "floor" | "door" | "windowFrame" | "glass";
export type ObjectKind = "wall" | "floor" | "door" | "window";

export interface SceneObject {
  /** Unique within the scene. Openings that have two materials use a `:glass` suffix. */
  id: string;
  kind: ObjectKind;
  /** Id of the FloorPlan element this was generated from. */
  sourceId: string;
  material: MaterialKey;
  /** Set on floors: the room this floor belongs to. */
  roomId?: string;
  mesh: MeshData;
}

/** A room as a 3D space: its floor, its volume, and the numbers viewers need. */
export interface SceneSpace {
  id: string;
  name: string;
  /** Room outline in plan coordinates (metres). */
  polygon: [number, number][];
  area: number;
  ceilingHeight: number;
  floorObjectId: string;
  /** World-space point at the middle of the room, on the floor surface. For labels. */
  centroid: V3;
  /** Closed prism from floor to ceiling. Not rendered by default; for highlighting/picking. */
  volume: MeshData;
}

export interface SceneBounds {
  min: V3;
  max: V3;
}

export interface Scene3D {
  units: "meters";
  scale: { calibrated: boolean; metersPerPixel: number };
  bounds: SceneBounds;
  objects: SceneObject[];
  spaces: SceneSpace[];
  /** Input problems the engine worked around (skipped, clamped). Empty for a valid plan. */
  warnings: string[];
}
