import { triangleCount } from "./meshUtils";
import type { Scene3D } from "./types";

export interface SceneStats {
  walls: number;
  doors: number;
  windows: number;
  rooms: number;
  triangles: number;
  /** Bounding box footprint on the ground plane, metres. */
  footprint: { width: number; depth: number };
  /** Tallest point of the model, metres. */
  height: number;
  /** Sum of room floor areas, m². */
  floorArea: number;
  calibrated: boolean;
}

export function summarizeScene(scene: Scene3D): SceneStats {
  const count = (kind: string) => scene.objects.filter((o) => o.kind === kind).length;
  const { min, max } = scene.bounds;
  return {
    walls: count("wall"),
    // A window has a frame object and a glass object; count each window once.
    doors: count("door"),
    windows: new Set(scene.objects.filter((o) => o.kind === "window").map((o) => o.sourceId)).size,
    rooms: scene.spaces.length,
    triangles: scene.objects.reduce((n, o) => n + triangleCount(o.mesh), 0),
    footprint: { width: max[0] - min[0], depth: max[2] - min[2] },
    height: max[1],
    floorArea: scene.spaces.reduce((a, s) => a + s.area, 0),
    calibrated: scene.scale.calibrated,
  };
}
