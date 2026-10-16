/**
 * FloorPlan: the contract between interpretation (manual / CV / AI) and the 3D engine.
 * Mirrors backend/app/schema/floorplan.py: keep the two in sync.
 *
 * Geometry is in metres on the ground plane; x right, y DOWN (same as the source image).
 * A door/window's `offset` is the distance from its wall's `start` to the opening's near edge.
 */

export type Point = [number, number];

export interface SourceImage {
  floorplan_id: string;
  width_px: number;
  height_px: number;
}

export interface Scale {
  meters_per_pixel: number;
  calibrated: boolean;
}

export interface Wall {
  id: string;
  start: Point;
  end: Point;
  height: number;
  thickness: number;
}

export interface Room {
  id: string;
  name: string;
  polygon: Point[];
}

export interface Door {
  id: string;
  wall_id: string;
  offset: number;
  width: number;
  height: number;
}

export interface Window {
  id: string;
  wall_id: string;
  offset: number;
  width: number;
  height: number;
  sill: number;
}

export interface FloorPlanData {
  version: 1;
  units: "meters";
  provenance: "manual" | "opencv" | "ai";
  source: SourceImage;
  scale: Scale;
  walls: Wall[];
  rooms: Room[];
  doors: Door[];
  windows: Window[];
}

export type OpeningKind = "door" | "window";
export type ElementKind = "wall" | "room" | OpeningKind;
export interface Selection {
  kind: ElementKind;
  id: string;
}

export const DEFAULTS = {
  wallHeight: 2.8,
  wallThickness: 0.15,
  doorWidth: 0.9,
  doorHeight: 2.1,
  windowWidth: 1.2,
  windowHeight: 1.2,
  windowSill: 0.9,
} as const;
